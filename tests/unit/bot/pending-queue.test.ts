import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingQueue } from '../../../src/bot/pending-queue.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingQueue arrival order', () => {
  it('flushes a re-queued message at the slot it was reserved, not at the tail', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const queue = new PendingQueue(600, (_scope, batch) => {
      flushed.push(batch.map((msg) => msg.messageId));
    });

    queue.block('scope-1');
    // A steer reserves its slot, then two more messages queue up behind it.
    const steerOrder = queue.allocateOrder();
    queue.push('scope-1', msg('om_after_1'));
    queue.push('scope-1', msg('om_after_2'));
    // The run ends without the model consuming the steer → replay it.
    queue.push('scope-1', msg('om_steer'), steerOrder);

    queue.unblock('scope-1');
    vi.advanceTimersByTime(600);

    expect(flushed).toEqual([['om_steer', 'om_after_1', 'om_after_2']]);
  });

  it('keeps plain pushes in call order', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const queue = new PendingQueue(600, (_scope, batch) => {
      flushed.push(batch.map((msg) => msg.messageId));
    });

    queue.push('scope-1', msg('om_1'));
    queue.push('scope-1', msg('om_2'));
    vi.advanceTimersByTime(600);

    expect(flushed).toEqual([['om_1', 'om_2']]);
  });

  it('drops a re-queued message together with the batch it joined', () => {
    const queue = new PendingQueue(60_000, () => {});
    const order = queue.allocateOrder();
    queue.push('scope-1', msg('om_1'));
    queue.push('scope-1', msg('om_steer'), order);

    expect(queue.cancel('scope-1').map((msg) => msg.messageId)).toEqual(['om_steer', 'om_1']);
  });
});

function msg(messageId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'scope-1',
    chatType: 'group',
    senderId: 'ou_user',
    content: messageId,
    resources: [],
    mentionedBot: true,
  } as unknown as NormalizedMessage;
}
