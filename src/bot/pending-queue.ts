import type { NormalizedMessage } from '@larksuite/channel';
import { log } from '../core/logger';

interface QueuedMessage {
  /** Arrival slot — see {@link PendingQueue.allocateOrder}. */
  order: number;
  msg: NormalizedMessage;
}

interface PendingEntry {
  messages: QueuedMessage[];
  timer?: NodeJS.Timeout;
}

export type FlushHandler = (scope: string, batch: NormalizedMessage[]) => void;

/**
 * Per-scope debounce queue. `scope` is the session scope string (typically
 * `chatId` for p2p / regular group, `chatId:threadId` for topic groups).
 * Accumulates messages within the same scope inside a quiet window, then
 * flushes as a single batch.
 *
 * `block(scope)` pauses the debounce timer while an agent run is active on
 * that scope — pushed messages still accumulate but no flush fires until
 * `unblock(scope)`, which arms a fresh quiet window.
 *
 * Commands should bypass this queue — they're cheap and should be responsive.
 */
export class PendingQueue {
  private readonly map = new Map<string, PendingEntry>();
  private readonly blocked = new Set<string>();
  private seq = 0;
  private readonly delayMs: number;
  private readonly onFlush: FlushHandler;

  constructor(delayMs: number, onFlush: FlushHandler) {
    this.delayMs = delayMs;
    this.onFlush = onFlush;
  }

  /**
   * Reserve an arrival slot. Messages flush in slot order, so a message that is
   * only queued later — a mid-turn steer whose run ended before the model saw
   * it, put back by `bot/steering.ts` — can be re-inserted at the position its
   * arrival earned instead of at the tail of the batch.
   */
  allocateOrder(): number {
    return this.seq++;
  }

  push(scope: string, msg: NormalizedMessage, order = this.allocateOrder()): number {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      const at = existing.messages.findIndex((queued) => queued.order > order);
      const entry = { order, msg };
      if (at === -1) existing.messages.push(entry);
      else existing.messages.splice(at, 0, entry);
      existing.timer = this.blocked.has(scope) ? undefined : this.armTimer(scope);
      return existing.messages.length;
    }
    this.map.set(scope, {
      messages: [{ order, msg }],
      timer: this.blocked.has(scope) ? undefined : this.armTimer(scope),
    });
    return 1;
  }

  cancel(scope: string): NormalizedMessage[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages.map((queued) => queued.msg);
  }

  cancelAll(): void {
    for (const entry of this.map.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
  }

  /** Pause the debounce timer; pushed messages keep accumulating. */
  block(scope: string): void {
    if (this.blocked.has(scope)) return;
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    log.info('queue', 'blocked', { scope, queued: entry?.messages.length ?? 0 });
  }

  /** Resume the debounce timer; arms a fresh quiet window if anything queued. */
  unblock(scope: string): void {
    if (!this.blocked.has(scope)) return;
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    log.info('queue', 'unblocked', { scope, queued: entry?.messages.length ?? 0 });
    if (!entry || entry.messages.length === 0) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = this.armTimer(scope);
  }

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string): void {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    try {
      this.onFlush(
        scope,
        entry.messages.map((queued) => queued.msg),
      );
    } catch (err) {
      log.fail('queue', err, { scope, batchSize: entry.messages.length });
    }
  }
}
