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
import { STEER_ACK_TEXT, STEER_REQUEUE_TEXT } from '../../../src/bot/steering.js';

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
  vi.useRealTimers();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('mid-turn steer recovery', () => {
  it('re-queues a steer whose run ended before the model could consume it', async () => {
    // The reported failure: the user steers a question into a run stuck on a
    // long tool call, then `/stop`s it. The app-server accepted the steer (the
    // ack went out) but never fed it to the model, and the message used to
    // disappear — ack, stop, silence.
    const h = await createHarness({ agentEvents: [[], []] });

    await startBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_first', content: '帮我跑个长任务' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1, 4000);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_steer', content: '先停一下，回答我的问题' }),
    );
    await waitFor(() => h.agent.runs[0]?.steeredTexts.length === 1, 4000);
    expect(h.agent.runs[0]?.steeredTexts).toEqual(['先停一下，回答我的问题']);
    expect(textsSent(h)).toContain(STEER_ACK_TEXT);

    await h.channel.handlers.message?.(message({ messageId: 'om_stop', content: '/stop' }));

    // Answering is the point: the message comes back as a run of its own.
    await waitFor(() => h.agent.runOptions.length === 2, 5000);
    expect(h.agent.runOptions[1]?.prompt).toContain('先停一下，回答我的问题');
    expect(h.agent.runOptions[1]?.prompt).not.toContain('帮我跑个长任务');
    const notice = h.channel.sent.find(
      (entry) => (entry.content as { markdown?: string }).markdown === STEER_REQUEUE_TEXT,
    );
    // The recovery note answers the question where it was asked.
    expect(notice?.options).toMatchObject({ replyTo: 'om_steer' });
  });

  it('leaves a steer alone once the model has answered it', async () => {
    const h = await createHarness({
      agentEvents: [[], []],
      steerReplies: [{ type: 'text', delta: '好的，回答你' }],
    });

    await startBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_first', content: '帮我跑个长任务' }),
    );
    await waitFor(() => h.agent.runOptions.length === 1, 4000);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_steer', content: '先停一下，回答我的问题' }),
    );
    // Model output after the steer is the bridge's evidence that it landed.
    await waitFor(() => h.agent.runs[0]?.steeredTexts.length === 1, 4000);
    await new Promise((resolve) => setTimeout(resolve, 120));

    await h.channel.handlers.message?.(message({ messageId: 'om_stop', content: '/stop' }));

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.agent.runOptions).toHaveLength(1);
    expect(textsSent(h)).not.toContain(STEER_REQUEUE_TEXT);
  });
});

function textsSent(h: { channel: FakeLarkChannel }): string[] {
  return h.channel.sent
    .map((entry) => (entry.content as { markdown?: string }).markdown)
    .filter((text): text is string => typeof text === 'string');
}

async function createHarness(
  options: {
    agentEvents?: (readonly import('../../../src/agent/types.js').AgentEvent[])[];
    steerReplies?: readonly import('../../../src/agent/types.js').AgentEvent[];
  } = {},
): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('steer-requeue-');
  const workspace = await realpath(tmp.workspace);
  const base = createDefaultProfileConfig({
    agentKind: 'codex',
    codex: { binaryPath: 'codex' },
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'] },
  });
  const profileConfig = {
    ...base,
    preferences: { ...base.preferences, steerInFlightMessages: true },
    workspaces: { ...base.workspaces, default: workspace },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: options.agentEvents ?? [[], []],
    steerable: true,
    holdOpenRuns: 1,
    ...(options.steerReplies ? { steerReplies: options.steerReplies } : {}),
  });
  const channel = createFakeLarkChannel();
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
    controls: createControls(profileConfig),
  };
}

async function startBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(): FakeLarkChannel & { handlers: MessageHandlerMap } {
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
    getAppInfo: vi.fn(async () => ({ ownerId: 'ou_owner' })),
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
    async stream(chatId, input, options) {
      streams.push({ chatId, options });
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      } else if (isCardStreamInput(input)) {
        await input.card.producer({ update: async () => {} });
      }
      return { messageId: `om_stream_${streams.length}` };
    },
    recallMessage: vi.fn(async () => {}),
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: { messageId: string; content: string }): NormalizedMessage {
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
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}

interface CardStreamInput {
  card: { producer(ctrl: { update(next: object): Promise<void> }): Promise<void> | void };
}

function isCardStreamInput(input: unknown): input is CardStreamInput {
  return Boolean(input && typeof input === 'object' && 'card' in input);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
