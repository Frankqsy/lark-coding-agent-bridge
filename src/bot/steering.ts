import type { NormalizedMessage } from '@larksuite/channel';
import type { AgentEvent } from '../agent/types';
import type { AppConfig } from '../config/schema';
import { log } from '../core/logger';
import type { RunHandle, SteerRecord } from './active-runs';

/**
 * Shown when a mid-run message was handed to the running turn. The user asked
 * for "steering must always answer me": without this line the message is
 * consumed silently and the next visible signal is the agent's own output,
 * which may be minutes away.
 */
export const STEER_ACK_TEXT = '➡️ 已把这条插进正在跑的任务，接下来按你最新这句走。';

/**
 * Shown when a steered message turned out to be unreachable: the run it was
 * handed to ended before the model ever touched it, so the message goes back on
 * the queue as a run of its own. Without this line the recovery is invisible —
 * the chat looks like it ignored both the steer and the `/stop`.
 */
export const STEER_REQUEUE_TEXT = '↩️ 刚才那条插话上一轮没跑到（任务被中断或提前结束），我重新排一轮专门处理它。';

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

export interface SteerableMessage {
  content: string;
  messageId: string;
  threadId?: string;
  resources: readonly unknown[];
}

export interface SteerIntakeDeps {
  cfg: AppConfig;
  handle: RunHandle | undefined;
  message: SteerableMessage;
  /** Minimal channel surface so tests can fake it. */
  send: (
    chatId: string,
    content: { text: string } | { markdown: string },
    opts?: { replyTo?: string; replyInThread?: boolean },
  ) => Promise<unknown>;
  chatId: string;
  /**
   * Where to put this message back if the model never consumes it: the message
   * as it arrived, plus the arrival slot the pending queue reserved for it.
   * Omitted when there is no queue to fall back to.
   */
  requeue?: { message: NormalizedMessage; order: number };
}

/**
 * Intake-side steering: try to inject the message into the running turn and, on
 * success, acknowledge it in the chat. Returns the decision so the caller can
 * fall back to its normal queue path.
 */
export async function handleSteerableMessage(deps: SteerIntakeDeps): Promise<SteerOutcome> {
  const outcome = await trySteerActiveRun({
    cfg: deps.cfg,
    handle: deps.handle,
    content: deps.message.content,
    resourceCount: deps.message.resources.length,
  });
  if (outcome !== 'steered') return outcome;
  // Accepted, not yet answered: remember it so the run's end can tell whether
  // the model ever got to it (see `takeUnconsumedSteers`).
  if (deps.handle && deps.requeue) {
    trackSteer(deps.handle, deps.requeue.message, deps.requeue.order);
  }
  await deps
    .send(
      deps.chatId,
      { markdown: STEER_ACK_TEXT },
      {
        replyTo: deps.message.messageId,
        ...(deps.message.threadId ? { replyInThread: true } : {}),
      },
    )
    .catch((err) =>
      log.warn('intake', 'steer-ack-failed', {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  return outcome;
}

/** Remember an accepted steer until the model shows it saw it. */
export function trackSteer(
  handle: RunHandle,
  message: NormalizedMessage,
  order: number,
): void {
  (handle.steers ??= []).push({ message, order, consumed: false });
}

/**
 * Mark the run's outstanding steers as consumed once the model does something.
 *
 * There is no "the steer reached the model" notification to wait for, so the
 * first model output after the hand-over is the evidence we have. Deliberately
 * excludes `final_text`: the codex translator flushes the *last completed*
 * assistant message when a turn ends, and that message may well predate the
 * steer — "the turn finished right after we steered" is exactly the case that
 * has to keep the message on the queue.
 *
 * Residual gap: a steer handed over while a sampling is already streaming looks
 * consumed to us (its deltas keep arriving), even though codex only picks the
 * message up at its next sampling. Erring that way costs a possible unanswered
 * steer; erring the other way would re-run messages the model did answer.
 */
export function observeSteerActivity(handle: RunHandle, event: AgentEvent): void {
  const steers = handle.steers;
  if (!steers || steers.length === 0) return;
  if (event.type !== 'text' && event.type !== 'thinking' && event.type !== 'tool_use') return;
  for (const steer of steers) steer.consumed = true;
}

/**
 * Steers the model never showed a sign of consuming, in arrival order. Called
 * once the run they were handed to has ended: nothing can have answered them,
 * so they have to go back on the queue. Clears the ledger — the caller owns
 * them from here.
 */
export function takeUnconsumedSteers(handle: RunHandle): SteerRecord[] {
  const steers = handle.steers;
  handle.steers = undefined;
  if (!steers || steers.length === 0) return [];
  return steers.filter((steer) => !steer.consumed).sort((a, b) => a.order - b.order);
}
