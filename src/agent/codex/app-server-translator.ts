import { log } from '../../core/logger';
import type { AgentEvent } from '../types';
import type { CodexAppServerNotification } from './app-server';

export type CodexAppServerFinishReason = 'normal' | 'interrupted' | 'timeout';

export interface ProtocolDriftState {
  unknownEvents: number;
  anomalies: number;
}

/**
 * Item types that the bridge renders as tool calls. The exec transport reports
 * `command_execution`; the app-server protocol uses camelCase ids, so the name
 * is normalised back to what the card renderer already knows.
 */
const TOOL_ITEM_NAMES: Record<string, string> = {
  commandExecution: 'command_execution',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool_call',
};

const IGNORED_NOTIFICATIONS = new Set([
  'account/rateLimits/updated',
  'account/updated',
  'account/login/completed',
  'account/gatewayOAuth/changed',
  'app/list/updated',
  'configWarning',
  'deprecationNotice',
  'fs/changed',
  'guardianWarning',
  'item/autoApprovalReview/completed',
  'item/autoApprovalReview/started',
  'item/mcpToolCall/progress',
  'mcpServer/oauthLogin/completed',
  'mcpServer/startupStatus/updated',
  'model/rerouted',
  'model/verification',
  'process/exited',
  'project/changed',
  'remoteControl/status/changed',
  'serverRequest/resolved',
  'skills/changed',
  'thread/attachment/updated',
  'thread/closed',
  'thread/compacted',
  'thread/environment/connected',
  'thread/environment/disconnected',
  'thread/goal/cleared',
  'thread/goal/updated',
  'thread/name/updated',
  'thread/prediction/updated',
  'thread/project/updated',
  'thread/queue/changed',
  'thread/settings/updated',
  'thread/status/changed',
  'turn/diff/updated',
  'turn/moderationMetadata',
  'turn/plan/updated',
  'warning',
]);

/**
 * Families of notifications the bridge has no use for. Matched by prefix so a
 * new member of an existing family (e.g. another `thread/realtime/*` event)
 * does not spam `unknown_notification` — that warning is reserved for genuinely
 * unclassified protocol drift.
 */
const IGNORED_NOTIFICATION_PREFIXES = [
  'externalAgentConfig/',
  'fuzzyFileSearch/',
  'hook/',
  'mcpServer/event/',
  'thread/realtime/',
  'windows/',
  'windowsSandbox/',
];

/**
 * Translates `codex app-server` notifications into the bridge's AgentEvent
 * vocabulary, mirroring the semantics of the `codex exec --json` translator
 * (`./jsonl.ts`): interim assistant messages stream as `text`, the last
 * completed assistant message becomes `final_text`, tool items become
 * `tool_use` / `tool_result`, and `turn/completed` closes the run.
 */
export class CodexAppServerTranslator {
  private threadId: string | undefined;
  private turnId: string | undefined;
  private systemEmitted = false;
  private terminal = false;
  private lastCompletedMessage: string | undefined;
  private lastNonTerminalError: string | undefined;
  private usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        reasoningOutputTokens?: number;
      }
    | undefined;
  private readonly itemNames = new Map<string, string>();
  private readonly itemOutput = new Map<string, string>();
  private readonly agentText = new Map<string, string>();
  private drift: ProtocolDriftState = { unknownEvents: 0, anomalies: 0 };

  get currentThreadId(): string | undefined {
    return this.threadId;
  }

  get currentTurnId(): string | undefined {
    return this.turnId;
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  protocolDrift(): ProtocolDriftState {
    return { ...this.drift };
  }

  /**
   * Adapter-supplied thread id, used on the resume path where the adapter knows
   * the id before (or without) a `thread/started` notification. Emits the
   * `system` event the session catalog needs exactly once.
   */
  observeThread(threadId: string): AgentEvent[] {
    this.threadId ??= threadId;
    return this.emitSystemOnce();
  }

  translate(notification: CodexAppServerNotification): AgentEvent[] {
    if (this.terminal) return [];
    const { method, params } = notification;
    switch (method) {
      case 'thread/started':
        return this.translateThreadStarted(params);
      case 'turn/started':
        return this.translateTurnStarted(params);
      case 'item/started':
        return this.translateItemStarted(params);
      case 'item/completed':
        return this.translateItemCompleted(params);
      case 'item/agentMessage/delta':
        return this.translateAgentMessageDelta(params);
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        return this.translateReasoningDelta(params);
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'process/outputDelta':
        this.accumulateOutput(params);
        return [];
      case 'thread/tokenUsage/updated':
        this.captureUsage(params);
        return [];
      case 'turn/completed':
        return this.translateTurnCompleted(params);
      case 'error':
        return this.translateNonTerminalError(params);
      default:
        if (
          !IGNORED_NOTIFICATIONS.has(method) &&
          !IGNORED_NOTIFICATION_PREFIXES.some((prefix) => method.startsWith(prefix))
        ) {
          this.drift.unknownEvents++;
          log.warn('appserver', 'unknown_notification', { method });
        }
        return [];
    }
  }

  /** Close the run when the stream ends without a `turn/completed`. */
  finish(reason: CodexAppServerFinishReason = 'normal'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    if (reason === 'normal') {
      return this.terminalEvents('normal');
    }
    return this.terminalEvents(reason);
  }

  fail(message: string, reason: 'failed' | 'interrupted' | 'timeout' = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [
      { type: 'error', message: truncate(message, 4096), terminationReason: reason },
    ];
  }

  private translateThreadStarted(params: Record<string, unknown>): AgentEvent[] {
    const thread = recordValue(params.thread);
    const threadId = stringValue(thread?.id) ?? stringValue(params.threadId);
    if (!threadId) {
      this.drift.anomalies++;
      return [];
    }
    this.threadId = threadId;
    return this.emitSystemOnce();
  }

  /** Same shape as the exec translator: threadId only. */
  private emitSystemOnce(): AgentEvent[] {
    if (this.systemEmitted || !this.threadId) return [];
    this.systemEmitted = true;
    return [{ type: 'system', threadId: this.threadId }];
  }

  private translateTurnStarted(params: Record<string, unknown>): AgentEvent[] {
    const turn = recordValue(params.turn);
    const turnId = stringValue(turn?.id) ?? stringValue(params.turnId);
    if (!turnId) {
      this.drift.anomalies++;
      return [];
    }
    this.turnId = turnId;
    return [];
  }

  private translateItemStarted(params: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(params.item);
    const id = stringValue(item?.id);
    const type = stringValue(item?.type);
    if (!item || !id || !type) {
      this.drift.anomalies++;
      return [];
    }
    const name = TOOL_ITEM_NAMES[type];
    if (!name) return [];
    this.itemNames.set(id, type);
    return [{ type: 'tool_use', id, name, input: toolInput(type, item) }];
  }

  private translateItemCompleted(params: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(params.item);
    const id = stringValue(item?.id);
    const type = stringValue(item?.type);
    if (!item || !id || !type) {
      this.drift.anomalies++;
      return [];
    }
    if (type === 'agentMessage') {
      const text = stringValue(item.text) ?? this.agentText.get(id) ?? '';
      this.agentText.delete(id);
      if (text) this.lastCompletedMessage = text;
      return [];
    }
    const name = TOOL_ITEM_NAMES[type];
    if (!name) return [];
    const output =
      stringValue(item.aggregatedOutput) ??
      stringValue(item.output) ??
      this.itemOutput.get(id) ??
      '';
    this.itemNames.delete(id);
    this.itemOutput.delete(id);
    const exitCode = numberValue(item.exitCode);
    return [
      {
        type: 'tool_result',
        id,
        output,
        isError: (exitCode !== undefined && exitCode !== 0) || item.status === 'failed',
      },
    ];
  }

  private translateAgentMessageDelta(params: Record<string, unknown>): AgentEvent[] {
    const delta = stringValue(params.delta);
    if (!delta) return [];
    const itemId = stringValue(params.itemId);
    if (itemId) this.agentText.set(itemId, (this.agentText.get(itemId) ?? '') + delta);
    return [{ type: 'text', delta }];
  }

  private translateReasoningDelta(params: Record<string, unknown>): AgentEvent[] {
    const delta = stringValue(params.delta);
    return delta ? [{ type: 'thinking', delta }] : [];
  }

  private translateTurnCompleted(params: Record<string, unknown>): AgentEvent[] {
    this.terminal = true;
    const turn = recordValue(params.turn);
    const status = stringValue(turn?.status);
    if (status === 'failed') {
      const error = recordValue(turn?.error);
      const message =
        stringValue(error?.message) ??
        stringValue(turn?.error) ??
        this.lastNonTerminalError ??
        'codex turn failed';
      return [
        { type: 'error', message: truncate(message, 4096), terminationReason: 'failed' },
      ];
    }
    if (status === 'interrupted') return this.terminalEvents('interrupted');
    return this.terminalEvents('normal');
  }

  private terminalEvents(reason: CodexAppServerFinishReason): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (this.lastCompletedMessage) {
      events.push({ type: 'final_text', content: this.lastCompletedMessage });
      this.lastCompletedMessage = undefined;
    }
    if (this.usage) {
      events.push({ type: 'usage', ...this.usage });
      this.usage = undefined;
    }
    events.push({
      type: 'done',
      ...(this.threadId ? { threadId: this.threadId } : {}),
      terminationReason: reason,
    });
    return events;
  }

  private accumulateOutput(params: Record<string, unknown>): void {
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (!itemId || !delta) return;
    this.itemOutput.set(itemId, (this.itemOutput.get(itemId) ?? '') + delta);
  }

  private captureUsage(params: Record<string, unknown>): void {
    const usage = recordValue(params.tokenUsage) ?? recordValue(params.usage) ?? params;
    const inputTokens = numberValue(usage.input_tokens ?? usage.inputTokens);
    const outputTokens = numberValue(usage.output_tokens ?? usage.outputTokens);
    const cachedInputTokens = numberValue(
      usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cached_tokens,
    );
    const reasoningOutputTokens = numberValue(
      usage.reasoning_output_tokens ?? usage.reasoningOutputTokens,
    );
    if (
      inputTokens === undefined &&
      outputTokens === undefined &&
      cachedInputTokens === undefined &&
      reasoningOutputTokens === undefined
    ) {
      return;
    }
    this.usage = { inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens };
  }

  private translateNonTerminalError(params: Record<string, unknown>): AgentEvent[] {
    const message =
      stringValue(params.message) ??
      stringValue(recordValue(params.error)?.message) ??
      'codex error';
    this.lastNonTerminalError = message;
    log.warn('appserver', 'error_notification', { message: truncate(message, 500) });
    return [];
  }
}

function toolInput(type: string, item: Record<string, unknown>): unknown {
  switch (type) {
    case 'commandExecution':
      return { command: stringValue(item.command) ?? '' };
    case 'fileChange':
      return { changes: item.changes ?? [] };
    case 'mcpToolCall':
      return {
        server: stringValue(item.server) ?? stringValue(item.serverName) ?? '',
        tool: stringValue(item.tool) ?? stringValue(item.toolName) ?? stringValue(item.name) ?? '',
        arguments: item.arguments ?? item.argumentsJson ?? {},
      };
    default:
      return {};
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
