import { describe, expect, it } from 'vitest';
import * as channelModule from '../../../src/bot/channel.js';

describe('Lark SDK logger noise filtering', () => {
  it('suppresses optional wiki-node permission failures that fall back to the original file token', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        [
          {
            message: 'Request failed with status code 400',
            config: {
              method: 'get',
              url: 'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
            },
            response: {
              data: {
                code: 99991672,
                msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
              },
            },
          },
          {
            code: 99991672,
            msg: 'Access denied. One of the following scopes is required: [wiki:node:read].',
          },
        ],
      ]),
    ).toBe(true);
  });

  it('keeps unrelated permission failures visible', () => {
    const shouldSuppress = (
      channelModule as {
        shouldSuppressSdkErrorLog?: (args: unknown[]) => boolean;
      }
    ).shouldSuppressSdkErrorLog;

    expect(
      shouldSuppress?.([
        {
          message: 'Request failed with status code 400',
          config: {
            method: 'post',
            url: 'https://open.feishu.cn/open-apis/im/v1/messages',
          },
          response: {
            data: {
              code: 99991672,
              msg: 'Access denied.',
            },
          },
        },
      ]),
    ).toBe(false);
  });
});

describe('SDK drop diagnostics', () => {
  const mod = channelModule as {
    classifySdkDropLine?: (args: unknown[]) => 'warn' | 'info' | undefined;
    STALE_MESSAGE_WINDOW_MS?: number;
  };

  it('surfaces the drops the SDK reports only at debug level', () => {
    // These four all used to vanish: the SDK logs them via `logger.debug`, and
    // the bridge's quiet logger dropped every debug line.
    expect(mod.classifySdkDropLine?.([`safety: drop stale message om_x`])).toBe('warn');
    expect(mod.classifySdkDropLine?.([`safety: drop bot-loop message om_x`])).toBe('warn');
    expect(mod.classifySdkDropLine?.([`safety: drop duplicate message om_x`])).toBe('info');
    expect(mod.classifySdkDropLine?.([`safety: drop in-flight message om_x`])).toBe('info');
  });

  it('leaves unrelated debug chatter alone', () => {
    expect(mod.classifySdkDropLine?.([`channel: keepalive wake-up`])).toBeUndefined();
    expect(mod.classifySdkDropLine?.([`safety: something else`])).toBeUndefined();
  });

  it('widens the stale window past the SDK default so an outage does not eat messages', () => {
    // The SDK default (30 min) is shorter than a WebSocket outage or a restart,
    // and everything past the window is discarded without a run.
    expect(mod.STALE_MESSAGE_WINDOW_MS ?? 0).toBeGreaterThan(30 * 60 * 1000);
  });
});
