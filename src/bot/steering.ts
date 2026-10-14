import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
import type { RunHandle } from './active-runs';

/** Whether the profile wants mid-turn messages injected into the running turn. */
export function steerInFlightEnabled(cfg: AppConfig): boolean {
  return cfg.preferences?.steerInFlightMessages === true;
}

export type SteerOutcome =
  | 'steered'
  | 'not-enabled'
  | 'no-active-run'
  | 'unsupported'
  | 'not-plain-text'
  | 'failed';

export interface SteerAttempt {
  cfg: AppConfig;
  handle: RunHandle | undefined;
  content: string;
  /** Attachments on the incoming message; those can't be injected mid-turn. */
  resourceCount: number;
}

/**
 * Hand a message that arrived mid-run to the turn that is already running
 * (`turn/steer` on the codex app-server transport) instead of queueing it for
 * the next one — the same thing the interactive Codex client does when you type
 * while it works.
 *
 * Only `'steered'` means the message was consumed; every other outcome leaves
 * the caller's queueing behaviour untouched, so this is a no-op for profiles
 * that don't opt in (`preferences.steerInFlightMessages`) and for agents whose
 * runs are one-shot processes with no input channel (codex `exec`, claude -p).
 */
export async function trySteerActiveRun(attempt: SteerAttempt): Promise<SteerOutcome> {
  if (!steerInFlightEnabled(attempt.cfg)) return 'not-enabled';
  const handle = attempt.handle;
  if (!handle || handle.interrupted) return 'no-active-run';
  const steer = handle.run.steer;
  if (typeof steer !== 'function') return 'unsupported';
  const text = attempt.content.trim();
  if (!text || attempt.resourceCount > 0) return 'not-plain-text';
  try {
    return (await steer.call(handle.run, text)) ? 'steered' : 'failed';
  } catch (err) {
    log.warn('intake', 'steer-error', {
      message: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}
