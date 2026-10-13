/**
 * Pure chat state for one conversation (profile + workspace + agent + session). The reducer folds
 * history pages and stream events into messages and cards; it never holds secrets (cards carry
 * metadata only, and form values stay inside the credential form component).
 */
import type { Continuation, HistoryMessage } from '@/api/schemas';
import type { ChatEvent, RecoveryAction, RecoveryCode } from '@/protocol/chat-events';
import type { UiActionCard } from '@/protocol/ui-action';
import { formatToolInput, formatToolText } from './tool-detail';

export interface ToolActivity {
  id: string;
  name: string;
  state: 'running' | 'done' | 'error';
  viaAgent?: string;
  /** Redacted, clipped plain text for the optional details view; kept in memory only. */
  input?: string;
  output?: string;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  createdAt?: string;
  /** Assistant message still receiving deltas. */
  streaming?: boolean;
  thinking?: string;
  tools?: ToolActivity[];
  cardIds?: string[];
  error?: { code: RecoveryCode | string; action?: RecoveryAction; retryAfterSeconds?: number; message?: string };
  stopped?: boolean;
  /** User text that can be re-sent from the error state. */
  retryText?: string;
  /** A card continuation not proven delivered; the Gateway sends each at most once, so "Continue" is safe. */
  retryContinuation?: Continuation;
  /**
   * Offered instead of "Send again" when delivery could not be proven either way: reload the
   * conversation (a known session) or refresh the conversation list (a new chat).
   */
  recover?: 'reload' | 'sessions';
  /** A local turn the server history may not hold: kept across history reloads until settled. */
  local?: boolean;
}

export type ChatPhase = 'idle' | 'loading' | 'streaming' | 'reconciling';

export interface ChatState {
  sessionKey?: string;
  runId?: string;
  phase: ChatPhase;
  messages: ChatMessage[];
  cards: UiActionCard[];
  /** Messages at the start of `messages` not shown yet; "show earlier" reveals them a page at a time. */
  hiddenBefore: number;
  loadError?: string;
  /** Reconciling is paused until the browser is back online. */
  offline?: boolean;
}

export const initialChatState = (sessionKey?: string): ChatState => ({
  sessionKey,
  phase: sessionKey ? 'loading' : 'idle',
  messages: [],
  cards: [],
  hiddenBefore: 0,
});

/** Messages shown at first and revealed per "show earlier" step. */
export const VISIBLE_PAGE = 50;

export type ChatAction =
  | { type: 'reset'; sessionKey?: string }
  | { type: 'history'; messages: HistoryMessage[]; sessionKey?: string }
  | { type: 'older' }
  | { type: 'loadFailed'; message: string }
  | { type: 'send'; text?: string; localId: string }
  | { type: 'event'; event: ChatEvent }
  | {
      type: 'streamFailed';
      code: string;
      message: string;
      reconcile: boolean;
      retryText?: string;
      retryContinuation?: Continuation;
      recover?: 'reload' | 'sessions';
      retryAfterSeconds?: number;
      /** Keep the turn across history reloads until a reconcile settles it. */
      local?: boolean;
    }
  | { type: 'reconciling'; offline?: boolean }
  /**
   * After a reconcile, for a turn the history does not prove delivered: a continuation gets
   * "Continue", a user message gets `delivery_unconfirmed` with a reload action, never a retry.
   */
  | { type: 'restoreTurn'; localId: string; text?: string; continuation?: Continuation; code: string; message: string }
  /**
   * A continuation whose run ended without delivering it (`chat.error`, `chat.stopped`): its reply
   * keeps the error the stream reported (or gets `code`) and offers "Continue".
   */
  | { type: 'offerContinue'; localId: string; continuation: Continuation; code: string; message: string }
  /** Removes a local turn: the server history holds it, or it is being sent again. */
  | { type: 'dropTurn'; localId: string }
  /** Removes the "Continue" turns of a card continuation that is no longer held here (delivered, or sent automatically again). */
  | { type: 'dropContinue'; setupActionId: string }
  | { type: 'idle' }
  | { type: 'cards'; cards: UiActionCard[] }
  | { type: 'card'; card: UiActionCard };

let seq = 0;
export const localId = (prefix = 'local') => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Server-written (`injected`) messages never render as model text: an injected assistant turn is
 * the marker of a run stopped before replying, shown like a live Stop (an empty "Stopped" reply);
 * any other injected message is dropped.
 */
function fromHistory(messages: HistoryMessage[]): ChatMessage[] {
  return messages.flatMap((m, index): ChatMessage[] => {
    if (m.role !== 'user' && m.role !== 'assistant') return [];
    if (m.injected && m.role !== 'assistant') return [];
    const message: ChatMessage = { id: m.id ?? `h-${index}-${m.created_at ?? ''}`, role: m.role, content: m.content, createdAt: m.created_at };
    return [m.injected ? { ...message, content: '', stopped: true } : message];
  });
}

function upsertCard(cards: UiActionCard[], card: UiActionCard): UiActionCard[] {
  const index = cards.findIndex((c) => c.id === card.id);
  if (index < 0) return [...cards, card];
  const next = cards.slice();
  next[index] = card;
  return next;
}

/** Applies a change to the assistant message currently streaming (the last one). */
function patchStreaming(state: ChatState, patch: (message: ChatMessage) => ChatMessage): ChatState {
  const index = state.messages.findLastIndex((m) => m.role === 'assistant' && m.streaming);
  if (index < 0) return state;
  const messages = state.messages.slice();
  messages[index] = patch(messages[index]!);
  return { ...state, messages };
}

function upsertTool(tools: ToolActivity[] | undefined, change: Omit<ToolActivity, 'name'> & { name?: string }): ToolActivity[] {
  // Fields an event does not carry (a completion has no arguments) keep their earlier value.
  const tool = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) as typeof change;
  const list = tools ?? [];
  const index = list.findIndex((t) => t.id === tool.id);
  if (index < 0) return [...list, { ...tool, name: tool.name ?? 'tool' }];
  const next = list.slice();
  next[index] = { ...next[index]!, ...tool };
  return next;
}

function applyEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case 'chat.started':
      return { ...state, sessionKey: event.sessionKey ?? state.sessionKey, runId: event.runId };
    case 'message.delta':
      return patchStreaming(state, (m) => ({ ...m, content: m.content + event.delta }));
    case 'thinking.delta':
      return patchStreaming(state, (m) => ({ ...m, thinking: (m.thinking ?? '') + event.delta }));
    case 'tool.call.started':
      return patchStreaming(state, (m) => ({
        ...m,
        tools: upsertTool(m.tools, { id: event.toolCall.id ?? localId('tool'), name: event.toolCall.name, state: 'running', viaAgent: event.toolCall.viaAgent, input: formatToolInput(event.toolCall.arguments) }),
      }));
    case 'tool.call.completed':
    case 'tool.call.error': {
      const call = event.toolCall;
      const card = call.uiAction;
      const next = patchStreaming(state, (m) => ({
        ...m,
        tools: upsertTool(m.tools, {
          id: call.id ?? localId('tool'),
          name: call.name,
          state: event.type === 'tool.call.error' ? 'error' : 'done',
          viaAgent: call.viaAgent,
          output: formatToolText(call.resultSummary),
          error: formatToolText(call.error),
        }),
        cardIds: card && !(m.cardIds ?? []).includes(card.id) ? [...(m.cardIds ?? []), card.id] : m.cardIds,
      }));
      return card ? { ...next, cards: upsertCard(next.cards, card) } : next;
    }
    case 'reasoning.activity':
      return state;
    case 'message.completed': {
      const next = patchStreaming(state, (m) => ({
        ...m,
        content: event.content || m.content,
        createdAt: event.createdAt ?? m.createdAt,
        streaming: false,
      }));
      return { ...next, phase: 'idle', runId: undefined };
    }
    case 'chat.error': {
      const next = patchStreaming(state, (m) => ({
        ...m,
        streaming: false,
        error: { code: event.code, action: event.action, retryAfterSeconds: event.retryAfterSeconds },
      }));
      return { ...next, phase: 'idle', runId: undefined };
    }
    case 'chat.stopped': {
      const next = patchStreaming(state, (m) => ({ ...m, streaming: false, stopped: true }));
      return { ...next, phase: 'idle', runId: undefined };
    }
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return initialChatState(action.sessionKey);
    case 'history': {
      // Local turns not proven delivered stay after the server's messages until settled.
      const messages = [...fromHistory(action.messages), ...state.messages.filter((m) => m.local)];
      return {
        ...state,
        sessionKey: action.sessionKey ?? state.sessionKey,
        messages,
        hiddenBefore: Math.max(0, messages.length - VISIBLE_PAGE),
        phase: state.phase === 'loading' ? 'idle' : state.phase,
        loadError: undefined,
      };
    }
    case 'older':
      return { ...state, hiddenBefore: Math.max(0, state.hiddenBefore - VISIBLE_PAGE) };
    case 'loadFailed':
      return { ...state, phase: 'idle', loadError: action.message };
    case 'send': {
      // A new send supersedes an earlier "Send again"; reload and "Continue" actions stay.
      const messages = state.messages.map((m) => (m.retryText ? { ...m, retryText: undefined } : m));
      if (action.text !== undefined) messages.push({ id: action.localId, role: 'user', content: action.text });
      messages.push({ id: `${action.localId}-reply`, role: 'assistant', content: '', streaming: true });
      return { ...state, messages, phase: 'streaming', loadError: undefined };
    }
    case 'event':
      return applyEvent(state, action.event);
    case 'streamFailed': {
      const index = state.messages.findLastIndex((m) => m.role === 'assistant' && m.streaming);
      const phase: ChatPhase = action.reconcile ? 'reconciling' : 'idle';
      if (index < 0) return { ...state, phase };
      const turnId = state.messages[index]!.id.replace(/-reply$/, '');
      const fix: Partial<ChatMessage> = {
        streaming: false,
        error: { code: action.code, message: action.message, retryAfterSeconds: action.retryAfterSeconds },
        retryText: action.reconcile ? undefined : action.retryText,
        retryContinuation: action.reconcile ? undefined : action.retryContinuation,
        recover: action.reconcile ? undefined : action.recover,
        local: action.local || undefined,
      };
      const messages = state.messages.map((m, i) => (i === index ? { ...m, ...fix } : action.local && m.id === turnId ? { ...m, local: true } : m));
      return { ...state, messages, phase };
    }
    case 'reconciling':
      return { ...state, phase: 'reconciling', offline: action.offline || undefined };
    case 'restoreTurn': {
      // Keeps the turn shown once (in place, or appended if a reload dropped it): a continuation
      // with "Continue", a user message as `delivery_unconfirmed` with a reload action.
      const replyId = `${action.localId}-reply`;
      const fix: Partial<ChatMessage> = {
        streaming: false,
        local: true,
        error: { code: action.code, message: action.message },
        retryText: undefined,
        retryContinuation: action.continuation,
        recover: action.continuation ? undefined : 'reload',
      };
      if (state.messages.some((m) => m.id === replyId)) {
        return { ...state, messages: state.messages.map((m) => (m.id === replyId ? { ...m, ...fix } : m.id === action.localId ? { ...m, local: true } : m)) };
      }
      const turn: ChatMessage[] = action.text !== undefined ? [{ id: action.localId, role: 'user', content: action.text, local: true }] : [];
      return { ...state, messages: [...state.messages, ...turn, { id: replyId, role: 'assistant', content: '', ...fix }] };
    }
    case 'offerContinue': {
      const replyId = `${action.localId}-reply`;
      const messages = state.messages.map((m) =>
        m.id === replyId ? { ...m, streaming: false, local: true, error: m.error ?? { code: action.code, message: action.message }, retryContinuation: action.continuation } : m,
      );
      return { ...state, messages };
    }
    case 'dropTurn': {
      const replyId = `${action.localId}-reply`;
      return { ...state, messages: state.messages.filter((m) => m.id !== action.localId && m.id !== replyId) };
    }
    case 'dropContinue': {
      const turns = new Set(state.messages.filter((m) => m.retryContinuation?.setup_action_id === action.setupActionId).map((m) => m.id.replace(/-reply$/, '')));
      if (!turns.size) return state;
      return { ...state, messages: state.messages.filter((m) => !turns.has(m.id.replace(/-reply$/, ''))) };
    }
    case 'idle':
      // Nothing is running any more, so no reply can still be typing.
      return {
        ...state,
        phase: 'idle',
        offline: undefined,
        runId: undefined,
        messages: state.messages.some((m) => m.streaming) ? state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m)) : state.messages,
      };
    case 'cards':
      return { ...state, cards: action.cards.reduce(upsertCard, state.cards) };
    case 'card':
      return { ...state, cards: upsertCard(state.cards, action.card) };
  }
}

/** Cards not attached to any visible message (e.g. reloaded after the panel reopened). */
export function looseCards(state: ChatState): UiActionCard[] {
  const attached = new Set(state.messages.flatMap((m) => m.cardIds ?? []));
  return state.cards.filter((c) => !attached.has(c.id));
}
