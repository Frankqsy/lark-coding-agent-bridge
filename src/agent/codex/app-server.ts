import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { join } from 'node:path';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const STDERR_TAIL_LINES = 40;
const CLIENT_INFO = {
  name: 'lark-channel-bridge',
  title: 'Lark Channel Bridge',
  version: '0.7.1',
} as const;

export type CodexAppServerErrorCode =
  | 'spawn-failed'
  | 'timeout'
  | 'closed'
  | 'server-error';

export class CodexAppServerError extends Error {
  readonly code: CodexAppServerErrorCode;

  constructor(code: CodexAppServerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexAppServerError';
    this.code = code;
  }
}

export interface CodexAppServerClientOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  /** Working directory for the app-server process itself. */
  cwd?: string;
  /** Base env; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  closeGraceMs?: number;
}

export interface CodexAppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

type NotificationListener = (notification: CodexAppServerNotification) => void;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Minimal JSON-RPC-ish client for `codex app-server --listen stdio://`.
 *
 * The bridge already talks to the app server this way to list `/resume`
 * history (see `src/session/codex-history.ts`), but only for one-shot queries.
 * This client keeps the connection alive so a chat can run several turns on
 * the same thread and — unlike one-shot `codex exec` — still accept input while
 * a turn is in flight (`turn/steer`) or interrupt one cleanly
 * (`turn/interrupt`).
 *
 * Wire format (newline-delimited JSON):
 *   request   { method, id, params }
 *   response  { id, result } | { id, error: { code, message } }
 *   notify    { method, params }
 *   server->client request { method, id, params } — answered in `handleServerRequest`.
 */
export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly closeGraceMs: number;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly stderrTail: string[] = [];
  private child: CodexAppServerChild | undefined;
  private reader: Interface | undefined;
  private startPromise: Promise<void> | undefined;
  private nextRequestId = 1;
  private closed = false;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  }

  get running(): boolean {
    const child = this.child;
    return (
      !this.closed &&
      Boolean(child) &&
      child!.exitCode === null &&
      child!.signalCode === null
    );
  }

  /** Spawn the app server and complete the `initialize` handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const starting = this.startInternal();
    this.startPromise = starting;
    try {
      await starting;
    } catch (err) {
      this.startPromise = undefined;
      throw err;
    }
  }

  request(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    const child = this.child;
    if (this.closed || !child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new CodexAppServerError('closed', 'codex app-server is not running'));
    }
    const id = this.nextRequestId++;
    const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexAppServerError(
            'timeout',
            `codex app-server ${method} timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, 'utf8', (err?: Error | null) => {
          if (!err) return;
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(
            new CodexAppServerError('closed', `failed to send ${method}: ${err.message}`, {
              cause: err,
            }),
          );
        });
      } catch (err) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
        }
        reject(
          new CodexAppServerError('closed', `failed to send ${method}`, { cause: err as Error }),
        );
      }
    });
  }

  /** Subscribe to app-server notifications. Returns an unsubscribe function. */
  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Last few stderr lines, for error messages. */
  stderrSummary(limit = 3): string {
    const tail = this.stderrTail.slice(-limit).join(' | ');
    return tail ? `: ${tail.slice(0, 500)}` : '';
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.reader?.close();
    this.reader = undefined;
    this.child = undefined;
    this.failAll(new CodexAppServerError('closed', 'codex app-server client closed'));
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const exited = await waitForExit(child, this.closeGraceMs);
    if (!exited) child.kill('SIGKILL');
  }

  /** Hard-kill the app server. Used only when a graceful interrupt fails. */
  kill(): void {
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    log.warn('appserver', 'kill', { pid: child.pid ?? null });
    child.kill('SIGTERM');
  }

  private async startInternal(): Promise<void> {
    if (this.closed) {
      throw new CodexAppServerError('closed', 'codex app-server client is closed');
    }
    const envOverrides: NodeJS.ProcessEnv = {};
    if (this.options.codexHome) {
      envOverrides.CODEX_HOME = this.options.codexHome;
    } else if (this.options.inheritCodexHome === false) {
      envOverrides.CODEX_HOME = join(this.options.profileStateDir, 'codex-home');
    }
    const child = spawnProcess(this.options.binary, ['app-server', '--listen', 'stdio://'], {
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      env: mergeProcessEnv(this.options.env ?? process.env, envOverrides),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as CodexAppServerChild;
    this.child = child;
    log.info('appserver', 'spawn', { pid: child.pid ?? null, cwd: this.options.cwd ?? null });

    child.on('error', (err: Error) => {
      this.failAll(
        new CodexAppServerError('spawn-failed', `codex app-server error: ${err.message}`, {
          cause: err,
        }),
      );
    });
    child.on('exit', (code, signal) => {
      log.info('appserver', 'exit', { pid: child.pid ?? null, code, signal });
      this.failAll(
        new CodexAppServerError(
          'closed',
          `codex app-server exited (${code ?? signal ?? 'signal'})${this.stderrSummary()}`,
        ),
      );
    });
    child.stdin.on('error', (err: Error) => {
      log.warn('appserver', 'stdin-error', { message: err.message });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
        log.warn('appserver', 'stderr', { line: line.slice(0, 500) });
      }
    });

    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader = reader;
    reader.on('line', (line) => this.handleLine(line));

    await this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null });
    log.info('appserver', 'ready', { pid: child.pid ?? null });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      log.warn('appserver', 'unparsable-line', { line: trimmed.slice(0, 200) });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const message = parsed as Record<string, unknown>;
    const id = typeof message.id === 'number' ? message.id : undefined;
    const method = typeof message.method === 'string' ? message.method : undefined;

    if (method && id !== undefined) {
      this.handleServerRequest(id, method);
      return;
    }
    if (id !== undefined) {
      const entry = this.pending.get(id);
      if (!entry) {
        log.warn('appserver', 'orphan-response', { id });
        return;
      }
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(
          new CodexAppServerError(
            'server-error',
            `codex app-server rejected ${entry.method}: ${describeError(message.error)}`,
          ),
        );
        return;
      }
      entry.resolve(message.result);
      return;
    }
    if (!method) return;
    const params =
      typeof message.params === 'object' && message.params !== null
        ? (message.params as Record<string, unknown>)
        : {};
    for (const listener of [...this.listeners]) {
      try {
        listener({ method, params });
      } catch (err) {
        log.warn('appserver', 'listener-error', {
          method,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Codex asks the client to approve commands / file changes — or to answer a
   * mid-turn question — through server-initiated requests. Every bridge thread
   * runs with `approvalPolicy: 'never'`, so these should not fire; answering
   * `accept` keeps parity with the exec transport (which passes
   * `-c approval_policy="never"` and never prompts). Unknown requests are
   * answered with a JSON-RPC error instead of being ignored, so a turn fails
   * loudly rather than hanging forever.
   */
  private handleServerRequest(id: number, method: string): void {
    const result = serverRequestResult(method);
    if (!result) {
      log.warn('appserver', 'unsupported-server-request', { method });
      this.respond(id, undefined, {
        code: -32601,
        message: `lark-channel-bridge does not handle ${method}`,
      });
      return;
    }
    log.info('appserver', 'server-request', { method });
    this.respond(id, result);
  }

  private respond(id: number, result: unknown, error?: { code: number; message: string }): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const payload = error ? { id, error } : { id, result };
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
    } catch (err) {
      log.warn('appserver', 'respond-failed', {
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private failAll(err: Error): void {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }
}

function serverRequestResult(method: string): Record<string, unknown> | undefined {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'accept' };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    default:
      return undefined;
  }
}

function describeError(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw !== 'object' || raw === null) return 'unknown error';
  const message = (raw as Record<string, unknown>).message;
  return typeof message === 'string' ? message : JSON.stringify(raw).slice(0, 300);
}

function waitForExit(child: CodexAppServerChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
