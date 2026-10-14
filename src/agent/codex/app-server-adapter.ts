import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';
import { CodexAppServerClient, CodexAppServerError, type CodexAppServerNotification } from './app-server';
import { CodexAppServerTranslator } from './app-server-translator';

export interface CodexAppServerAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  /** Injected in tests to replace the real app-server transport. */
  clientFactory?: (options: {
    binary: string;
    profileStateDir: string;
    codexHome?: string;
    inheritCodexHome?: boolean;
  }) => CodexAppServerClient;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | undefined;
}

/**
 * Codex adapter backed by `codex app-server` instead of one-shot `codex exec`.
 *
 * Why a second adapter: `codex exec` writes the prompt to stdin and closes it,
 * so a turn has no input channel at all — the only way to "interrupt" is to
 * SIGTERM the process, and a message sent while it runs can only be queued for
 * the next turn. The app server keeps the thread alive, which gives us:
 *   - `turn/interrupt` — a real interrupt instead of killing the process;
 *   - `turn/steer` — inject a follow-up user message into the running turn,
 *     the way the interactive Codex client does.
 * Everything downstream (prompt prefix, sandbox, session catalog, card
 * rendering) is unchanged: the adapter emits the same AgentEvent vocabulary.
 */
export class CodexAppServerAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex CLI (app-server)';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly clientFactory: CodexAppServerAdapterOptions['clientFactory'];
  private botIdentity: AgentBotIdentity | undefined;
  private client: CodexAppServerClient | undefined;
  private clientPromise: Promise<CodexAppServerClient> | undefined;

  constructor(opts: CodexAppServerAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.clientFactory = opts.clientFactory;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex CLI',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  /** Shut the shared app-server connection down (service stop / reconnect). */
  async dispose(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.clientPromise = undefined;
    if (client) await client.close();
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for CodexAppServerAdapter.run');
    if (this.ignoreUserConfig) {
      log.warn('appserver', 'ignore-user-config-unsupported', { cwd: opts.cwd });
    }

    const cwd = opts.cwd;
    const sandbox = opts.sandbox ?? this.sandbox;
    const model = opts.model;
    const images = opts.images ?? [];
    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    const translator = new CodexAppServerTranslator();

    const state: {
      threadId: string | undefined;
      turn: ActiveTurn | undefined;
      stopRequested: boolean;
      finished: boolean;
    } = {
      threadId: opts.threadId,
      turn: undefined,
      stopRequested: false,
      finished: false,
    };

    const queue: CodexAppServerNotification[] = [];
    let wake: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let resolveExited: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExited = resolve;
    });

    const notify = (): void => {
      const pending = wake;
      wake = undefined;
      pending?.();
    };

    // Resolved by the notification handler (not by the event consumer) so a
    // `stop()` issued from outside the run loop cannot deadlock on a consumer
    // that is waiting for its next event.
    let signalTurnEnded: (() => void) | undefined;
    const turnEnded = new Promise<void>((resolve) => {
      signalTurnEnded = resolve;
    });

    const finish = (): void => {
      if (state.finished) return;
      state.finished = true;
      unsubscribe?.();
      unsubscribe = undefined;
      signalTurnEnded?.();
      resolveExited?.();
      notify();
    };

    const self = this;
    const events = (async function* events(): AsyncGenerator<AgentEvent> {
      try {
        const client = await self.ensureClient();
        unsubscribe = client.onNotification((notification) => {
          queue.push(notification);
          if (notification.method === 'turn/completed') signalTurnEnded?.();
          notify();
        });

        const threadId = await self.openThread(client, { cwd, sandbox, model, threadId: state.threadId });
        state.threadId = threadId;
        for (const event of translator.observeThread(threadId)) yield event;

        if (!state.stopRequested) {
          const turn = await self.startTurn(client, {
            threadId,
            prompt,
            images,
            model,
            sandbox,
          });
          state.turn = turn;
        }

        while (!state.finished) {
          while (queue.length > 0) {
            const notification = queue.shift()!;
            for (const event of translator.translate(notification)) {
              yield event;
              if (event.type === 'done' || event.type === 'error') {
                finish();
                return;
              }
            }
            if (state.turn && !state.turn.turnId && translator.currentTurnId) {
              state.turn = { ...state.turn, turnId: translator.currentTurnId };
            }
          }
          if (state.stopRequested && !state.turn) {
            for (const event of translator.finish('interrupted')) yield event;
            finish();
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const event of translator.fail(`codex app-server run failed: ${message}`)) yield event;
      } finally {
        finish();
      }
    })();

    return {
      runId: opts.runId,
      events,
      async steer(text: string): Promise<boolean> {
        const client = self.client;
        const threadId = state.threadId;
        const turnId = state.turn?.turnId;
        if (!client || state.finished || state.stopRequested || !threadId || !turnId) return false;
        try {
          await client.request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: buildUserInput(text, []),
          });
          log.info('appserver', 'steered', { threadId, turnId, chars: text.length });
          return true;
        } catch (err) {
          log.warn('appserver', 'steer-failed', {
            threadId,
            turnId,
            message: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
      },
      async stop(): Promise<void> {
        state.stopRequested = true;
        const client = self.client;
        const threadId = state.threadId;
        const turnId = state.turn?.turnId;
        if (!client || !threadId) {
          notify();
          return;
        }
        log.info('appserver', 'interrupt', { threadId, turnId: turnId ?? null, graceMs: stopGraceMs });
        if (turnId) {
          await client
            .request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5000 })
            .catch((err) =>
              log.warn('appserver', 'interrupt-failed', {
                message: err instanceof Error ? err.message : String(err),
              }),
            );
        }
        const stopped = await withTimeout(turnEnded, stopGraceMs);
        if (!stopped) {
          log.warn('appserver', 'interrupt-timeout', { threadId, graceMs: stopGraceMs });
          client.kill();
          finish();
        }
      },
      async waitForExit(timeoutMs: number): Promise<boolean> {
        if (state.finished) return true;
        return withTimeout(exited, timeoutMs);
      },
    };
  }

  private async ensureClient(): Promise<CodexAppServerClient> {
    if (this.client && this.client.running) return this.client;
    if (!this.clientPromise) {
      const factory =
        this.clientFactory ??
        ((options: {
          binary: string;
          profileStateDir: string;
          codexHome?: string;
          inheritCodexHome?: boolean;
        }) =>
          new CodexAppServerClient({
            ...options,
            env: mergeProcessEnvWithLarkChannel(process.env, this.larkChannel),
          }));
      const client = factory({
        binary: this.binary,
        profileStateDir: this.profileStateDir,
        ...(this.codexHome ? { codexHome: this.codexHome } : {}),
        inheritCodexHome: this.inheritCodexHome,
      });
      this.client = client;
      this.clientPromise = client
        .start()
        .then(() => client)
        .catch((err) => {
          this.clientPromise = undefined;
          this.client = undefined;
          throw err instanceof CodexAppServerError
            ? err
            : new CodexAppServerError('spawn-failed', `failed to start codex app-server: ${String(err)}`);
        });
    }
    return this.clientPromise;
  }

  private async openThread(
    client: CodexAppServerClient,
    input: { cwd: string; sandbox: SandboxMode; model?: string; threadId?: string },
  ): Promise<string> {
    const base = {
      cwd: input.cwd,
      sandbox: input.sandbox,
      approvalPolicy: 'never',
      ...(input.model ? { model: input.model } : {}),
    };
    if (input.threadId) {
      const result = await client.request('thread/resume', {
        threadId: input.threadId,
        ...base,
      });
      log.info('appserver', 'thread-resumed', { threadId: input.threadId, cwd: input.cwd });
      return extractThreadId(result) ?? input.threadId;
    }
    const result = await client.request('thread/start', base);
    const threadId = extractThreadId(result);
    if (!threadId) {
      throw new CodexAppServerError('server-error', 'codex app-server returned no thread id');
    }
    log.info('appserver', 'thread-started', { threadId, cwd: input.cwd });
    return threadId;
  }

  private async startTurn(
    client: CodexAppServerClient,
    input: {
      threadId: string;
      prompt: string;
      images: readonly string[];
      model?: string;
      sandbox: SandboxMode;
    },
  ): Promise<ActiveTurn> {
    const result = await client.request('turn/start', {
      threadId: input.threadId,
      input: buildUserInput(input.prompt, input.images),
      ...(input.model ? { model: input.model } : {}),
      sandboxPolicy: sandboxPolicyFor(input.sandbox),
    });
    const turnId = extractTurnId(result);
    log.info('appserver', 'turn-started', {
      threadId: input.threadId,
      turnId: turnId ?? null,
      promptChars: input.prompt.length,
      images: input.images.length,
    });
    return { threadId: input.threadId, turnId };
  }
}

function buildUserInput(prompt: string, images: readonly string[]): unknown[] {
  return [
    { type: 'text', text: prompt },
    ...images.map((path) => ({ type: 'localImage', path })),
  ];
}

function sandboxPolicyFor(sandbox: SandboxMode): Record<string, unknown> {
  switch (sandbox) {
    case 'read-only':
      return { type: 'readOnly' };
    case 'workspace-write':
      return { type: 'workspaceWrite' };
    default:
      return { type: 'dangerFullAccess' };
  }
}

function extractThreadId(result: unknown): string | undefined {
  const record = asRecord(result);
  const thread = asRecord(record?.thread);
  const id = thread?.id ?? record?.threadId;
  return typeof id === 'string' ? id : undefined;
}

function extractTurnId(result: unknown): string | undefined {
  const record = asRecord(result);
  const turn = asRecord(record?.turn);
  const id = turn?.id ?? record?.turnId;
  return typeof id === 'string' ? id : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function mergeProcessEnvWithLarkChannel(
  base: NodeJS.ProcessEnv,
  larkChannel: LarkChannelEnvContext | undefined,
): NodeJS.ProcessEnv {
  return { ...base, ...buildLarkChannelEnv(larkChannel) };
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
