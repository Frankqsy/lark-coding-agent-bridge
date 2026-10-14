import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '../../src/agent/codex/app-server-adapter.js';
import type { AgentEvent } from '../../src/agent/types.js';

/**
 * Exercises the app-server adapter against a real `codex` binary and a real
 * model. Not run by default: it needs a logged-in Codex home (or an API-key
 * provider) and burns tokens.
 *
 *   LARK_CODEX_LIVE=1 \
 *   LARK_CODEX_BIN=$(command -v codex) \
 *   LARK_CODEX_HOME=$HOME/.codex \
 *   pnpm vitest run tests/process/codex-app-server-live.test.ts
 *
 * LARK_CODEX_HOME must be writable — the app server keeps thread state there.
 */
const live = process.env.LARK_CODEX_LIVE === '1';
const binary = process.env.LARK_CODEX_BIN ?? 'codex';
const codexHome = process.env.LARK_CODEX_HOME;

describe.skipIf(!live)('CodexAppServerAdapter (live codex)', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
      ),
    );
  });

  function makeAdapter(stateDir: string): CodexAppServerAdapter {
    return new CodexAppServerAdapter({
      binary,
      profileStateDir: stateDir,
      ...(codexHome ? { codexHome } : {}),
      inheritCodexHome: false,
      sandbox: 'danger-full-access',
    });
  }

  it(
    'runs a turn, streams the answer, and reports the codex thread id',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'codex-live-'));
      cleanup.push(dir);
      const run = makeAdapter(dir).run({
        runId: 'live-1',
        prompt: 'Reply with exactly: pong',
        cwd: dir,
      });

      const events = await collect(run.events);
      const system = events.find((event) => event.type === 'system');
      const final = events.find((event) => event.type === 'final_text');

      expect(system?.type === 'system' ? system.threadId : '').toMatch(/^[0-9a-f-]{36}$/);
      expect(final?.type === 'final_text' ? final.content.toLowerCase() : '').toContain('pong');
      expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    },
    180_000,
  );

  it(
    'accepts a steer mid-turn and interrupts the turn through turn/interrupt',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'codex-live-'));
      cleanup.push(dir);
      const run = makeAdapter(dir).run({
        runId: 'live-2',
        prompt: 'Run this shell command and then report its output: sleep 45 && echo finished',
        cwd: dir,
      });

      const events: AgentEvent[] = [];
      // The bridge issues /stop from the intake handler while the run loop is
      // consumed elsewhere, so the test stops from outside the consumer too.
      let steered = false;
      let stopRequested = false;
      const watcher = setInterval(() => {
        if (!steered && events.some((event) => event.type === 'tool_use')) {
          steered = true;
          void run.steer?.('Never mind the command — just reply with the word steered.').then(
            (ok) => expect(ok).toBe(true),
          );
        }
        if (!stopRequested && steered) {
          stopRequested = true;
          void run.stop();
        }
      }, 25);
      try {
        for await (const event of run.events) events.push(event);
      } finally {
        clearInterval(watcher);
      }

      expect(steered).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
    },
    180_000,
  );
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
