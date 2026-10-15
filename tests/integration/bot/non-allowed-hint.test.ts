import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  sent: Array<{ chatId: string; content: unknown; options: unknown }>;
  streams: Array<{ chatId: string; options: unknown }>;
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    im: {
      v1: {
        message: { list: ReturnType<typeof vi.fn> };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  getAppInfo: ReturnType<typeof vi.fn>;
  listChats: ReturnType<typeof vi.fn>;
  fetchRawMessage: ReturnType<typeof vi.fn>;
  recallMessage: ReturnType<typeof vi.fn>;
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'p2p' | 'group' | 'topic'>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<{ messageId: string }>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

/**
 * The bridge refuses to forward what it cannot authorize — that part is
 * deliberate. What it must not do is refuse *silently*: a dropped message with
 * no reply is indistinguishable from a hung bot, which is how the "codex-test
 * 又不响应我了" reports read from the user's side.
 */
describe('refused messages are answered', () => {
  it('answers a refused DM, naming the open_id that failed the check', async () => {
    const h = await createHarness({ ownerLookupFails: true });
    await startBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_dm', content: '在吗？' }),
    );
    await waitFor(() => h.channel.sent.length > 0);

    const hint = textsSent(h).join('\n');
    expect(hint).toContain('ou_user');
    expect(hint).toContain('access.allowedUsers');
    // The owner lookup is the reason even the owner can land here — say so.
    expect(hint).toContain('owner');
    // Nothing was forwarded: the refusal stands, it is just no longer silent.
    expect(h.agent.runOptions).toHaveLength(0);
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_dm' });
  });

  it('re-fetches the owner before refusing, so a transient lookup failure does not eat the message', async () => {
    // Startup lookup fails (state 'failed', owner unknown). With an empty
    // allowlist that used to deny the owner's own DM; the inline retry turns it
    // into a normal run.
    const h = await createHarness({
      ownerLookupFails: true,
      refreshOwner: (controls) => {
        controls.botOwnerId = 'ou_user';
        controls.ownerRefreshState = 'ok';
      },
    });
    await startBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_dm', content: '在吗？' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.agent.runOptions[0]?.prompt).toContain('在吗？');
    expect(textsSent(h)).toHaveLength(0);
  });

  it('stays quiet for another bot, so two bridges cannot ack each other forever', async () => {
    const h = await createHarness({ ownerLookupFails: true });
    await startBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_bot', content: '你好', senderType: 'app' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(h.channel.sent).toHaveLength(0);
    expect(h.agent.runOptions).toHaveLength(0);
  });
});

function textsSent(h: { channel: FakeLarkChannel }): string[] {
  return h.channel.sent
    .flatMap((entry) => {
      const content = entry.content as { markdown?: string; text?: string };
      return [content.markdown, content.text];
    })
    .filter((text): text is string => typeof text === 'string');
}

async function createHarness(
  options: {
    ownerLookupFails?: boolean;
    refreshOwner?: (controls: FakeControls) => void;
  } = {},
): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: FakeControls;
}> {
  const tmp = await createTmpProfile('non-allowed-hint-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'codex',
    codex: { binaryPath: 'codex' },
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
  });
  // Empty allowlist + personal mode: the runtime owner is the only accepted
  // DM sender, which is exactly the path a failed owner lookup breaks.
  const profileConfig = {
    ...base,
    access: { ...base.access, allowedUsers: [], allowedChats: [], admins: [] },
    workspaces: { ...base.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter();
  const channel = createFakeLarkChannel({ appInfoFails: options.ownerLookupFails === true });
  sdkMock.channel = channel;
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls: createControls(profileConfig, options.refreshOwner),
  };
}

interface FakeControls {
  profile: string;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  botOwnerId?: string;
  ownerRefreshState: 'ok' | 'failed' | 'unknown';
  refreshOwner(): Promise<void>;
  restart(): Promise<void>;
  exit(): Promise<void>;
  configPath: string;
  cfg: ReturnType<typeof createDefaultProfileConfig>;
  processId: string;
}

function createControls(
  profileConfig: ReturnType<typeof createDefaultProfileConfig>,
  refreshOwner?: (controls: FakeControls) => void,
): FakeControls {
  const controls: FakeControls = {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {
      refreshOwner?.(controls);
    },
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
  return controls;
}

async function startBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: FakeControls;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls as never,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(input: {
  appInfoFails: boolean;
}): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  const sent: Array<{ chatId: string; content: unknown; options: unknown }> = [];
  const streams: Array<{ chatId: string; options: unknown }> = [];
  return {
    handlers,
    sent,
    streams,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      im: {
        v1: {
          message: { list: vi.fn(async () => ({ data: { items: [], has_more: false } })) },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    getAppInfo: input.appInfoFails
      ? vi.fn(async () => {
          throw new Error('app-info unavailable');
        })
      : vi.fn(async () => ({ ownerId: 'ou_owner' })),
    listChats: vi.fn(async () => []),
    fetchRawMessage: vi.fn(async () => []),
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'p2p';
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      return { messageId: `om_sent_${sent.length}` };
    },
    async stream(chatId, _input, options) {
      streams.push({ chatId, options });
      return { messageId: `om_stream_${streams.length}` };
    },
    recallMessage: vi.fn(async () => {}),
  };
}

function message(input: {
  messageId: string;
  content: string;
  senderType?: 'user' | 'app';
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_p2p_chat',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    raw: { sender: { sender_type: input.senderType ?? 'user' } },
  } as unknown as NormalizedMessage;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
