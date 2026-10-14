import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '../../src/agent/codex/app-server-adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

interface FakeAppServer {
  path: string;
  dir: string;
  recordPath: string;
}

interface RecordedEntry {
  kind: 'request' | 'notification-response' | 'spawn';
  method?: string;
  id?: number;
  params?: unknown;
  payload?: unknown;
}

describe('CodexAppServerAdapter process contract', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  it('runs a turn over stdio:// app-server and translates streaming events', async () => {
    const fake = await createFakeAppServer({
      threadId: 'thread-1',
      turnId: 'turn-1',
      steps: [
        { notify: 'turn/started', params: { turn: { id: 'turn-1' } } },
        {
          notify: 'item/started',
          params: {
            item: {
              type: 'commandExecution',
              id: 'call-1',
              command: '/bin/bash -lc "ls"',
            },
          },
        },
        { notify: 'item/commandExecution/outputDelta', params: { itemId: 'call-1', delta: 'a.txt' } },
        {
          notify: 'item/completed',
          params: {
            item: {
              type: 'commandExecution',
              id: 'call-1',
              command: '/bin/bash -lc "ls"',
              aggregatedOutput: 'a.txt',
              exitCode: 0,
            },
          },
        },
        { notify: 'item/reasoning/textDelta', params: { itemId: 'r-1', delta: 'thinking' } },
        { notify: 'item/agentMessage/delta', params: { itemId: 'm-1', delta: 'hello ' } },
        { notify: 'item/agentMessage/delta', params: { itemId: 'm-1', delta: 'world' } },
        {
          notify: 'item/completed',
          params: { item: { type: 'agentMessage', id: 'm-1', text: 'hello world' } },
        },
        { notify: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'danger-full-access',
    }).run({ runId: 'run-1', prompt: 'hello from lark', cwd: fake.dir });

    expect(await collect(run.events)).toEqual<AgentEvent[]>([
      { type: 'system', threadId: 'thread-1' },
      { type: 'tool_use', id: 'call-1', name: 'command_execution', input: { command: '/bin/bash -lc "ls"' } },
      { type: 'tool_result', id: 'call-1', output: 'a.txt', isError: false },
      { type: 'thinking', delta: 'thinking' },
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'world' },
      { type: 'final_text', content: 'hello world' },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);

    const record = await readRecord(fake.recordPath);
    const methods = record.filter((entry) => entry.kind === 'request').map((entry) => entry.method);

    expect(methods).toEqual(['initialize', 'thread/start', 'turn/start']);
    const spawn = record.find((entry) => entry.kind === 'spawn');
    expect((spawn?.params as { argv?: string[] } | undefined)?.argv).toEqual([
      'app-server',
      '--listen',
      'stdio://',
    ]);
    const threadStart = record.find((entry) => entry.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      cwd: fake.dir,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
    });
    const turnStart = record.find((entry) => entry.method === 'turn/start');
    const input = (turnStart?.params as { input?: Array<Record<string, unknown>> }).input ?? [];
    expect(input[0]?.type).toBe('text');
    expect(String(input[0]?.text)).toContain('hello from lark');
    expect(String(input[0]?.text)).toContain('lark-channel-bridge 运行约定');
  });

  it('resumes an existing thread and steers a message into the running turn', async () => {
    const fake = await createFakeAppServer({
      threadId: 'thread-1',
      turnId: 'turn-2',
      waitForSteer: true,
      preSteerSteps: [
        { notify: 'turn/started', params: { turn: { id: 'turn-2' } } },
        { notify: 'item/agentMessage/delta', params: { itemId: 'm-1', delta: 'working' } },
      ],
      steps: [
        {
          notify: 'item/completed',
          params: { item: { type: 'agentMessage', id: 'm-1', text: 'working, now steering' } },
        },
        { notify: 'turn/completed', params: { turn: { id: 'turn-2', status: 'completed' } } },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'workspace-write',
    }).run({
      runId: 'run-2',
      prompt: 'long task',
      cwd: fake.dir,
      threadId: 'thread-existing',
    });

    const collected: AgentEvent[] = [];
    const deadline = Date.now() + 10_000;
    let steered = false;
    for await (const event of run.events) {
      collected.push(event);
      if (!steered && event.type === 'text') {
        steered = await run.steer!('actually do this instead');
      }
      if (Date.now() > deadline) throw new Error('run did not finish in time');
    }

    expect(steered).toBe(true);
    expect(collected.at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-existing',
      terminationReason: 'normal',
    });

    const record = await readRecord(fake.recordPath);
    const methods = record.filter((entry) => entry.kind === 'request').map((entry) => entry.method);
    expect(methods).toEqual(['initialize', 'thread/resume', 'turn/start', 'turn/steer']);
    const resume = record.find((entry) => entry.method === 'thread/resume');
    expect(resume?.params).toMatchObject({ threadId: 'thread-existing' });
    const steer = record.find((entry) => entry.method === 'turn/steer');
    expect(steer?.params).toMatchObject({
      threadId: 'thread-existing',
      expectedTurnId: 'turn-2',
    });
  });

  it('interrupts the active turn through turn/interrupt instead of killing the process', async () => {
    const fake = await createFakeAppServer({
      threadId: 'thread-1',
      turnId: 'turn-3',
      interruptOnRequest: true,
      steps: [
        { notify: 'turn/started', params: { turn: { id: 'turn-3' } } },
        { notify: 'item/agentMessage/delta', params: { itemId: 'm-1', delta: 'working' } },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({ runId: 'run-3', prompt: 'takes forever', cwd: fake.dir });

    // Mirror the production path: `/stop` arrives from the intake handler while
    // the run loop is being consumed somewhere else, so stop() must never be
    // awaited from inside the consumer.
    const events: AgentEvent[] = [];
    let stopRequested = false;
    const watcher = setInterval(() => {
      if (!stopRequested && events.some((event) => event.type === 'text')) {
        stopRequested = true;
        void run.stop();
      }
    }, 10);
    for await (const event of run.events) events.push(event);
    clearInterval(watcher);

    expect(stopRequested).toBe(true);
    expect(events.at(-1)).toEqual({
      type: 'done',
      threadId: 'thread-1',
      terminationReason: 'interrupted',
    });
    const record = await readRecord(fake.recordPath);
    expect(record.some((entry) => entry.method === 'turn/interrupt')).toBe(true);
  });

  it('answers server-initiated approval requests so a turn cannot stall', async () => {
    const fake = await createFakeAppServer({
      threadId: 'thread-1',
      turnId: 'turn-4',
      approvalRequest: { id: 77, method: 'item/commandExecution/requestApproval' },
      steps: [
        { notify: 'turn/started', params: { turn: { id: 'turn-4' } } },
        {
          notify: 'item/completed',
          params: { item: { type: 'agentMessage', id: 'm-1', text: 'done' } },
        },
        { notify: 'turn/completed', params: { turn: { id: 'turn-4', status: 'completed' } } },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({ runId: 'run-4', prompt: 'needs approval', cwd: fake.dir });

    await collect(run.events);

    const record = await readRecord(fake.recordPath);
    const answer = record.find((entry) => entry.kind === 'notification-response');
    expect(answer?.payload).toEqual({ id: 77, result: { decision: 'accept' } });
  });

  it('surfaces a failed turn as an error event', async () => {
    const fake = await createFakeAppServer({
      threadId: 'thread-1',
      turnId: 'turn-5',
      steps: [
        { notify: 'turn/started', params: { turn: { id: 'turn-5' } } },
        {
          notify: 'turn/completed',
          params: {
            turn: { id: 'turn-5', status: 'failed', error: { message: 'model exploded' } },
          },
        },
      ],
    });
    cleanup.push(fake.dir);

    const run = new CodexAppServerAdapter({
      binary: fake.path,
      profileStateDir: fake.dir,
      sandbox: 'read-only',
    }).run({ runId: 'run-5', prompt: 'boom', cwd: fake.dir });

    const events = await collect(run.events);

    expect(events).toEqual<AgentEvent[]>([
      { type: 'system', threadId: 'thread-1' },
      { type: 'error', message: 'model exploded', terminationReason: 'failed' },
    ]);
  });
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function readRecord(path: string): Promise<RecordedEntry[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RecordedEntry);
}

interface FakeStep {
  notify: string;
  params: Record<string, unknown>;
}

interface FakeAppServerOptions {
  threadId: string;
  turnId: string;
  steps: FakeStep[];
  /** Emitted right after turn/start, before any waitForSteer hold. */
  preSteerSteps?: FakeStep[];
  /** Hold the turn open until a turn/steer arrives (or 5s). */
  waitForSteer?: boolean;
  /** Reply to turn/interrupt with an interrupted turn/completed. */
  interruptOnRequest?: boolean;
  /** Send a server->client request before the steps and record the answer. */
  approvalRequest?: { id: number; method: string };
}

async function createFakeAppServer(options: FakeAppServerOptions): Promise<FakeAppServer> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-app-server-fake-'));
  const recordPath = join(dir, 'record.jsonl');
  const scriptPath = join(dir, 'fake-codex');
  await writeFile(
    join(dir, 'options.json'),
    JSON.stringify({ ...options, recordPath }),
    'utf8',
  );
  const script = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const readline = require('node:readline');",
    'const options = JSON.parse(fs.readFileSync(path.join(__dirname, "options.json"), "utf8"));',
    'const record = (entry) => fs.appendFileSync(options.recordPath, JSON.stringify(entry) + "\\n");',
    'record({ kind: "spawn", params: { argv: process.argv.slice(2) } });',
    'const send = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");',
    'const notify = (method, params) => send({ method, params });',
    'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    'async function runSteps() {',
    '  for (const step of options.steps) {',
    '    notify(step.notify, step.params);',
    '    await sleep(5);',
    '  }',
    '}',
    'let steered = false;',
    'const rl = readline.createInterface({ input: process.stdin });',
    'rl.on("line", async (line) => {',
    '  const trimmed = line.trim();',
    '  if (!trimmed) return;',
    '  const msg = JSON.parse(trimmed);',
    '  if (typeof msg.method === "string" && typeof msg.id === "number") {',
    '    record({ kind: "request", method: msg.method, id: msg.id, params: msg.params });',
    '    switch (msg.method) {',
    '      case "initialize":',
    '        send({ id: msg.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });',
    '        if (options.approvalRequest) {',
    '          send({ method: options.approvalRequest.method, id: options.approvalRequest.id, params: {} });',
    '        }',
    '        break;',
    '      case "thread/start":',
    '        notify("thread/started", { thread: { id: options.threadId, cwd: msg.params && msg.params.cwd } });',
    '        send({ id: msg.id, result: { thread: { id: options.threadId } } });',
    '        break;',
    '      case "thread/resume":',
    '        notify("thread/started", { thread: { id: msg.params.threadId, cwd: msg.params && msg.params.cwd } });',
    '        send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });',
    '        break;',
    '      case "turn/start":',
    '        send({ id: msg.id, result: { turn: { id: options.turnId, status: "inProgress" } } });',
    '        void (async () => {',
    '          for (const step of options.preSteerSteps || []) {',
    '            notify(step.notify, step.params);',
    '            await sleep(5);',
    '          }',
    '          if (options.waitForSteer) {',
    '            const started = Date.now();',
    '            while (!steered && Date.now() - started < 5000) await sleep(10);',
    '          }',
    '          await runSteps();',
    '        })();',
    '        break;',
    '      case "turn/steer":',
    '        steered = true;',
    '        send({ id: msg.id, result: { turn: { id: options.turnId, status: "inProgress" } } });',
    '        break;',
    '      case "turn/interrupt":',
    '        send({ id: msg.id, result: {} });',
    '        if (options.interruptOnRequest) {',
    '          notify("turn/completed", { turn: { id: msg.params.turnId, status: "interrupted" } });',
    '        }',
    '        break;',
    '      default:',
    '        send({ id: msg.id, result: {} });',
    '        break;',
    '    }',
    '    return;',
    '  }',
    '  if (typeof msg.id === "number") {',
    '    record({ kind: "notification-response", payload: msg });',
    '  }',
    '});',
  ].join('\n');
  await writeFile(scriptPath, `${script}\n`, 'utf8');
  await chmod(scriptPath, 0o755);
  return { path: scriptPath, dir, recordPath };
}
