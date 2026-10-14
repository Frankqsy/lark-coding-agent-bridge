import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types.js';
import type { RunHandle } from '../../../src/bot/active-runs.js';
import {
  STEER_ACK_TEXT,
  handleSteerableMessage,
  steerInFlightEnabled,
  trySteerActiveRun,
  type SteerIntakeDeps,
  type SteerableMessage,
} from '../../../src/bot/steering.js';
import type { AppConfig } from '../../../src/config/schema.js';

function cfgWith(steerInFlightMessages: boolean | undefined): AppConfig {
  return {
    accounts: {
      app: { id: 'cli_test', tenant: 'feishu', secret: '${APP_SECRET}' },
    },
    ...(steerInFlightMessages === undefined
      ? {}
      : { preferences: { steerInFlightMessages } }),
  };
}

function handleWith(run: Partial<AgentRun>): RunHandle {
  return { run: run as AgentRun, interrupted: false };
}

describe('steerInFlightEnabled', () => {
  it('defaults to off', () => {
    expect(steerInFlightEnabled(cfgWith(undefined))).toBe(false);
    expect(steerInFlightEnabled(cfgWith(false))).toBe(false);
  });

  it('is on only when explicitly enabled', () => {
    expect(steerInFlightEnabled(cfgWith(true))).toBe(true);
  });
});

describe('trySteerActiveRun', () => {
  it('does nothing when the profile has not opted in', async () => {
    const steer = vi.fn().mockResolvedValue(true);
    const outcome = await trySteerActiveRun({
      cfg: cfgWith(false),
      handle: handleWith({ steer }),
      content: 'hello',
      resourceCount: 0,
    });

    expect(outcome).toBe('not-enabled');
    expect(steer).not.toHaveBeenCalled();
  });

  it('queues when no run is active for the scope', async () => {
    expect(
      await trySteerActiveRun({
        cfg: cfgWith(true),
        handle: undefined,
        content: 'hello',
        resourceCount: 0,
      }),
    ).toBe('no-active-run');
  });

  it('falls back when the agent cannot accept mid-turn input', async () => {
    expect(
      await trySteerActiveRun({
        cfg: cfgWith(true),
        handle: handleWith({}),
        content: 'hello',
        resourceCount: 0,
      }),
    ).toBe('unsupported');
  });

  it('keeps messages with attachments or blank text on the queue path', async () => {
    const steer = vi.fn().mockResolvedValue(true);
    const base = { cfg: cfgWith(true), handle: handleWith({ steer }) };

    expect(await trySteerActiveRun({ ...base, content: 'see file', resourceCount: 1 })).toBe(
      'not-plain-text',
    );
    expect(await trySteerActiveRun({ ...base, content: '   ', resourceCount: 0 })).toBe(
      'not-plain-text',
    );
    expect(steer).not.toHaveBeenCalled();
  });

  it('injects a plain message into the running turn', async () => {
    const steer = vi.fn().mockResolvedValue(true);
    const outcome = await trySteerActiveRun({
      cfg: cfgWith(true),
      handle: handleWith({ steer }),
      content: '  actually do this  ',
      resourceCount: 0,
    });

    expect(outcome).toBe('steered');
    expect(steer).toHaveBeenCalledWith('actually do this');
  });

  it('queues when the agent rejects the steer', async () => {
    const outcome = await trySteerActiveRun({
      cfg: cfgWith(true),
      handle: handleWith({ steer: vi.fn().mockResolvedValue(false) }),
      content: 'hello',
      resourceCount: 0,
    });

    expect(outcome).toBe('failed');
  });

  it('queues instead of throwing when the steer call errors', async () => {
    const outcome = await trySteerActiveRun({
      cfg: cfgWith(true),
      handle: handleWith({ steer: vi.fn().mockRejectedValue(new Error('app-server gone')) }),
      content: 'hello',
      resourceCount: 0,
    });

    expect(outcome).toBe('failed');
  });

  it('ignores a run that is already being interrupted', async () => {
    const steer = vi.fn().mockResolvedValue(true);
    const outcome = await trySteerActiveRun({
      cfg: cfgWith(true),
      handle: { run: { steer } as unknown as AgentRun, interrupted: true },
      content: 'hello',
      resourceCount: 0,
    });

    expect(outcome).toBe('no-active-run');
    expect(steer).not.toHaveBeenCalled();
  });
});

describe('handleSteerableMessage', () => {
  function attempt(overrides: Record<string, unknown> = {}) {
    const send = vi.fn().mockResolvedValue(undefined);
    const steer = vi.fn().mockResolvedValue(true);
    const message: SteerableMessage = {
      content: '先停下来，改成 xxx',
      messageId: 'om_1',
      resources: [],
    };
    const deps = {
      cfg: cfgWith(true),
      handle: handleWith({ steer }),
      message,
      send,
      chatId: 'oc_1',
      ...overrides,
    } as SteerIntakeDeps;
    return { send, steer, deps, message };
  }

  it('acknowledges a steered message so the user always gets an answer', async () => {
    const { deps, send } = attempt();

    await expect(handleSteerableMessage(deps)).resolves.toBe('steered');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'oc_1',
      { markdown: STEER_ACK_TEXT },
      { replyTo: 'om_1' },
    );
  });

  it('replies inside the topic when the message came from one', async () => {
    const { deps, send, message } = attempt();
    message.threadId = 'th_1';

    await handleSteerableMessage(deps);

    expect(send).toHaveBeenCalledWith(
      'oc_1',
      { markdown: STEER_ACK_TEXT },
      { replyTo: 'om_1', replyInThread: true },
    );
  });

  it('stays silent when the message was not steered', async () => {
    for (const [outcome, overrides] of [
      ['not-enabled', { cfg: cfgWith(false) }],
      ['no-active-run', { handle: undefined }],
      ['unsupported', { handle: handleWith({}) }],
      ['not-plain-text', { message: { content: '看这个', messageId: 'om_2', resources: [{}] } }],
      ['failed', { handle: handleWith({ steer: vi.fn().mockResolvedValue(false) }) }],
    ] as const) {
      const { deps, send } = attempt(overrides as never);

      await expect(handleSteerableMessage(deps)).resolves.toBe(outcome);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('does not fail the intake when the acknowledgement cannot be sent', async () => {
    const { deps } = attempt();
    deps.send = vi.fn().mockRejectedValue(new Error('feishu down'));

    await expect(handleSteerableMessage(deps)).resolves.toBe('steered');
  });
});
