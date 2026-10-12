/**
 * Chat stream events as the extension consumes them. The wire format is the Dewee runtime SSE
 * contract (snake_case payloads, event names below) emitted by the Gateway's workspace chat
 * stream and forwarded verbatim by the Cloud extension BFF. `mapRuntimeFrame` turns one raw frame
 * into a typed, camelCase `ChatEvent`; unknown events and malformed JSON are dropped so a single
 * bad frame never breaks the stream.
 */
import { z } from 'zod';
import { parseUiAction, type UiActionEnvelope } from './ui-action';

export const chatEventTypes = [
  'chat.started',
  'message.delta',
  'thinking.delta',
  'tool.call.started',
  'tool.call.completed',
  'tool.call.error',
  'reasoning.activity',
  'message.completed',
  'chat.error',
  'chat.stopped',
] as const;
export type ChatEventType = (typeof chatEventTypes)[number];

export const recoveryActionsByCode = {
  provider_unavailable: 'review_provider_settings',
  provider_auth: 'review_provider_settings',
  provider_billing: 'review_provider_settings',
  provider_rate_limited: 'wait_and_retry',
  provider_overloaded: 'retry',
  provider_timeout: 'retry',
  provider_model_unavailable: 'review_provider_settings',
  provider_request_invalid: 'contact_workspace_admin',
  provider_content_policy: 'contact_workspace_admin',
  context_limit: 'start_new_chat',
  runtime_unavailable: 'retry',
  runtime_request_failed: 'retry',
  setup_result_delivered: 'continue_in_chat',
} as const;
export type RecoveryCode = keyof typeof recoveryActionsByCode;
export type RecoveryAction = (typeof recoveryActionsByCode)[RecoveryCode];

export interface ToolCall {
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  resultSummary?: string;
  error?: string;
  viaAgent?: string;
  uiAction?: UiActionEnvelope;
}

export interface MediaItem {
  path: string;
  contentType?: string;
  size?: number;
}

export type ChatEvent =
  | { type: 'chat.started'; runId?: string; sessionKey?: string; agentKey?: string }
  | { type: 'message.delta' | 'thinking.delta'; delta: string }
  | { type: 'tool.call.started' | 'tool.call.completed' | 'tool.call.error'; toolCall: ToolCall }
  | { type: 'reasoning.activity'; phase?: string }
  | { type: 'message.completed'; content: string; createdAt?: string; media: MediaItem[] }
  | { type: 'chat.error'; code: RecoveryCode; action: RecoveryAction; retryAfterSeconds?: number }
  | { type: 'chat.stopped' };

export interface RawSseFrame {
  event: string;
  data: string;
  id?: string;
}

const str = z.string().optional().catch(undefined);
const record = z.record(z.string(), z.unknown());

const toolCallPayload = z
  .object({ id: str, name: str, arguments: record.optional().catch(undefined), via_agent: str })
  .catch({});

const toolResultPayload = z.object({
  tool_call: toolCallPayload.optional(),
  id: str,
  name: str,
  result_summary: str,
  result: str,
  error: str,
  via_agent: str,
  ui_action: z.unknown().optional(),
});

const mediaPayload = z
  .array(z.object({ path: z.string(), content_type: str, size: z.number().optional().catch(undefined) }))
  .catch([]);

function isKnown(event: string): event is ChatEventType {
  return (chatEventTypes as readonly string[]).includes(event);
}

function toolResult(payload: unknown): ToolCall {
  const parsed = toolResultPayload.safeParse(payload);
  if (!parsed.success) return {};
  const p = parsed.data;
  const call = p.tool_call ?? {};
  const uiAction = p.ui_action === undefined ? null : parseUiAction(p.ui_action);
  return {
    id: call.id ?? p.id,
    name: call.name ?? p.name,
    resultSummary: p.result_summary ?? p.result,
    error: p.error,
    viaAgent: call.via_agent ?? p.via_agent,
    ...(uiAction ? { uiAction } : {}),
  };
}

function recovery(payload: Record<string, unknown>): Extract<ChatEvent, { type: 'chat.error' }> {
  const code = payload.code as RecoveryCode | undefined;
  const action = payload.recovery_action;
  if (!code || !(code in recoveryActionsByCode) || recoveryActionsByCode[code] !== action) {
    return { type: 'chat.error', code: 'runtime_request_failed', action: 'retry' };
  }
  const retry = payload.retry_after_seconds;
  const retryAfterSeconds = typeof retry === 'number' && Number.isInteger(retry) && retry > 0 && retry <= 900 ? retry : undefined;
  return { type: 'chat.error', code, action: recoveryActionsByCode[code], ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
}

export function mapRuntimeFrame(frame: RawSseFrame): ChatEvent | null {
  if (!isKnown(frame.event)) return null;
  let payload: Record<string, unknown>;
  try {
    const decoded: unknown = frame.data ? JSON.parse(frame.data) : {};
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) return null;
    payload = decoded as Record<string, unknown>;
  } catch {
    return null;
  }
  const s = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : undefined);
  switch (frame.event) {
    case 'chat.started':
      return { type: 'chat.started', runId: s('run_id'), sessionKey: s('session_key'), agentKey: s('agent_key') };
    case 'message.delta':
    case 'thinking.delta':
      return { type: frame.event, delta: s('delta') ?? '' };
    case 'tool.call.started': {
      const call = toolCallPayload.parse(payload.tool_call ?? {});
      return {
        type: 'tool.call.started',
        toolCall: { id: call.id, name: call.name, arguments: call.arguments, viaAgent: call.via_agent },
      };
    }
    case 'tool.call.completed':
    case 'tool.call.error':
      return { type: frame.event, toolCall: toolResult(payload) };
    case 'reasoning.activity':
      return { type: 'reasoning.activity', phase: s('phase') };
    case 'message.completed': {
      const message = (payload.message ?? {}) as Record<string, unknown>;
      return {
        type: 'message.completed',
        content: typeof message.content === 'string' ? message.content : '',
        createdAt: typeof message.created_at === 'string' ? message.created_at : undefined,
        media: mediaPayload.parse(payload.media ?? []).map((m) => ({ path: m.path, contentType: m.content_type, size: m.size })),
      };
    }
    case 'chat.error':
      return recovery(payload);
    case 'chat.stopped':
      return { type: 'chat.stopped' };
  }
}

export function isTerminal(event: ChatEvent): boolean {
  return event.type === 'message.completed' || event.type === 'chat.error' || event.type === 'chat.stopped';
}
