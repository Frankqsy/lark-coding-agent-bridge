import { describe, expect, it, vi } from 'vitest';
import type { AgentRun } from '../../../src/agent/types.js';
import type { RunHandle } from '../../../src/bot/active-runs.js';
import { steerInFlightEnabled, trySteerActiveRun } from '../../../src/bot/steering.js';
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
