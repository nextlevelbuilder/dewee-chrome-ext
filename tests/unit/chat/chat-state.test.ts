import type { HistoryMessage } from '../../../src/api/schemas';
import type { ChatEvent } from '../../../src/protocol/chat-events';
import type { UiActionCard } from '../../../src/protocol/ui-action';
import { chatReducer, initialChatState, looseCards, VISIBLE_PAGE, type ChatState } from '../../../src/chat/chat-state';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const secretCard = JSON.parse(
  readFileSync(join(__dirname, '../../contract-fixtures/ui-action-v1/examples/secret_request.json'), 'utf8'),
) as UiActionCard;

const card = (id: string, title = 'Connect OpenAI'): UiActionCard => ({ ...secretCard, id, title });

const hist = (id: string, role: HistoryMessage['role'], content: string): HistoryMessage => ({
  id,
  role,
  content,
  created_at: '2026-10-11T10:00:00Z',
});

/** Starts a send so there is a streaming assistant message to fold events into. */
function streaming(state: ChatState = initialChatState('s1'), text = 'Hello'): ChatState {
  return chatReducer(state, { type: 'send', text, localId: 'u1' });
}

const event = (e: ChatEvent) => ({ type: 'event' as const, event: e });

describe('initialChatState', () => {
  it('starts loading when there is a session to open and idle otherwise', () => {
    expect(initialChatState('s1')).toMatchObject({ sessionKey: 's1', phase: 'loading', messages: [], cards: [] });
    expect(initialChatState()).toMatchObject({ sessionKey: undefined, phase: 'idle' });
  });
});

describe('send and streaming', () => {
  it('adds the user message and a streaming assistant placeholder', () => {
    const state = streaming();
    expect(state.phase).toBe('streaming');
    expect(state.messages).toEqual([
      { id: 'u1', role: 'user', content: 'Hello' },
      { id: 'u1-reply', role: 'assistant', content: '', streaming: true },
    ]);
  });

  it('appends deltas to the streaming assistant message only', () => {
    const state = [event({ type: 'message.delta', delta: 'Hel' }), event({ type: 'message.delta', delta: 'lo' })].reduce(
      (s, a) => chatReducer(s, a),
      streaming(),
    );
    expect(state.messages.at(-1)?.content).toBe('Hello');
  });

  it('ignores a delta when no assistant message is streaming', () => {
    const state = initialChatState('s1');
    expect(chatReducer(state, event({ type: 'message.delta', delta: 'x' }))).toBe(state);
  });

  it('records the run and adopts the session key from chat.started', () => {
    const next = chatReducer(streaming(initialChatState()), event({ type: 'chat.started', runId: 'r1', sessionKey: 's9' }));
    expect(next).toMatchObject({ runId: 'r1', sessionKey: 's9' });
  });

  it('accumulates thinking text separately from the answer', () => {
    let state = streaming();
    state = chatReducer(state, event({ type: 'thinking.delta', delta: 'plan' }));
    expect(state.messages.at(-1)).toMatchObject({ content: '', thinking: 'plan' });
  });
});

describe('tool events', () => {
  it('upserts one tool entry per call id through start and completion', () => {
    let state = streaming();
    state = chatReducer(state, event({ type: 'tool.call.started', toolCall: { id: 't1', name: 'search' } }));
    expect(state.messages.at(-1)?.tools).toEqual([{ id: 't1', name: 'search', state: 'running', viaAgent: undefined }]);

    state = chatReducer(state, event({ type: 'tool.call.completed', toolCall: { id: 't1', name: 'search', resultSummary: 'ok' } }));
    expect(state.messages.at(-1)?.tools).toEqual([{ id: 't1', name: 'search', state: 'done', viaAgent: undefined, output: 'ok' }]);
  });

  it('keeps the call input from the start and adds the output or error from the end', () => {
    let state = streaming();
    state = chatReducer(state, event({ type: 'tool.call.started', toolCall: { id: 't1', name: 'exec', arguments: { command: 'dewee agents list' } } }));
    state = chatReducer(state, event({ type: 'tool.call.error', toolCall: { id: 't1', name: 'exec', error: '  exit status 1  ' } }));
    expect(state.messages.at(-1)?.tools?.[0]).toMatchObject({ state: 'error', input: '{\n  "command": "dewee agents list"\n}', error: 'exit status 1' });
    expect(state.messages.at(-1)?.tools?.[0]?.output).toBeUndefined();
  });

  it('never keeps credential-looking values from tool input', () => {
    let state = streaming();
    state = chatReducer(state, event({ type: 'tool.call.started', toolCall: { id: 't1', name: 'exec', arguments: { api_key: 'test-key-value', command: 'x --api-key test-key-value' } } }));
    expect(state.messages.at(-1)?.tools?.[0]?.input).not.toContain('test-key-value');
  });

  it('marks a failed tool call as error', () => {
    let state = streaming();
    state = chatReducer(state, event({ type: 'tool.call.started', toolCall: { id: 't2', name: 'fetch' } }));
    state = chatReducer(state, event({ type: 'tool.call.error', toolCall: { id: 't2', name: 'fetch', error: 'boom' } }));
    expect(state.messages.at(-1)?.tools?.[0]?.state).toBe('error');
  });

  it('attaches a card to the message and the card list once, replacing it on a repeat', () => {
    let state = streaming();
    const first = card('c1', 'First');
    state = chatReducer(state, event({ type: 'tool.call.completed', toolCall: { id: 't3', name: 'ui_action', uiAction: first } }));
    state = chatReducer(state, event({ type: 'tool.call.completed', toolCall: { id: 't3', name: 'ui_action', uiAction: card('c1', 'Second') } }));
    expect(state.messages.at(-1)?.cardIds).toEqual(['c1']);
    expect(state.cards).toHaveLength(1);
    expect(state.cards[0]?.title).toBe('Second');
  });
});

describe('completion and failure', () => {
  it('completes the reply with the server content and returns to idle', () => {
    let state = streaming();
    state = chatReducer(state, event({ type: 'message.delta', delta: 'partial' }));
    state = chatReducer(state, event({ type: 'message.completed', content: 'final text', createdAt: '2026-10-11T10:01:00Z', media: [] }));
    expect(state.phase).toBe('idle');
    expect(state.runId).toBeUndefined();
    expect(state.messages.at(-1)).toMatchObject({ content: 'final text', streaming: false, createdAt: '2026-10-11T10:01:00Z' });
  });

  it('keeps the streamed text when the completion carries no content', () => {
    let state = streaming();
    state = chatReducer(state, event({ type: 'message.delta', delta: 'kept' }));
    state = chatReducer(state, event({ type: 'message.completed', content: '', media: [] }));
    expect(state.messages.at(-1)?.content).toBe('kept');
  });

  it('records a chat.error with its recovery action and stops streaming', () => {
    const state = chatReducer(streaming(), event({ type: 'chat.error', code: 'context_limit', action: 'start_new_chat' }));
    expect(state.phase).toBe('idle');
    expect(state.messages.at(-1)).toMatchObject({ streaming: false, error: { code: 'context_limit', action: 'start_new_chat' } });
  });

  it('marks a stopped reply as stopped', () => {
    const state = chatReducer(streaming(), event({ type: 'chat.stopped' }));
    expect(state.phase).toBe('idle');
    expect(state.messages.at(-1)).toMatchObject({ streaming: false, stopped: true });
  });

  it('moves to reconciling when a broken stream may still be running on the server', () => {
    const state = chatReducer(streaming(), { type: 'streamFailed', code: 'network_error', message: 'x', reconcile: true, retryText: 'Hello' });
    expect(state.phase).toBe('reconciling');
    expect(state.messages.at(-1)).toMatchObject({ error: { code: 'network_error' } });
    expect(state.messages.at(-1)?.retryText).toBeUndefined();
  });

  it('goes idle and offers a retry when the send is known to have failed', () => {
    const state = chatReducer(streaming(), { type: 'streamFailed', code: 'provider_overloaded', message: 'x', reconcile: false, retryText: 'Hello' });
    expect(state.phase).toBe('idle');
    expect(state.messages.at(-1)?.retryText).toBe('Hello');
  });

  it('stops the typing indicator when the engine goes idle without a terminal frame', () => {
    const state = chatReducer(chatReducer(streaming(), { type: 'reconciling' }), { type: 'idle' });
    expect(state.phase).toBe('idle');
    expect(state.messages.some((m) => m.streaming)).toBe(false);
  });

  it('clears an old retry offer when a new send starts', () => {
    const failed = chatReducer(streaming(), { type: 'streamFailed', code: 'x', message: 'x', reconcile: false, retryText: 'Hello' });
    const next = chatReducer(failed, { type: 'send', text: 'Again', localId: 'u2' });
    expect(next.messages[0]?.retryText).toBeUndefined();
  });
});

describe('history loading', () => {
  it('replaces the messages, keeps only user and assistant turns and leaves loading', () => {
    const state = chatReducer(initialChatState('s1'), {
      type: 'history',
      sessionKey: 's1',
      messages: [hist('m1', 'user', 'Hi'), hist('m2', 'tool', 'ran a tool'), hist('m3', 'assistant', 'Hello')],
    });
    expect(state.phase).toBe('idle');
    expect(state.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ['m1', 'user', 'Hi'],
      ['m3', 'assistant', 'Hello'],
    ]);
    expect(state.hiddenBefore).toBe(0);
  });

  it('shows an injected assistant turn as a stopped reply, never its marker text', () => {
    const state = chatReducer(initialChatState('s1'), {
      type: 'history',
      messages: [hist('m1', 'user', 'Hi'), { ...hist('m2', 'assistant', '[Stopped before replying]'), injected: true }],
    });
    expect(state.messages.at(-1)).toMatchObject({ id: 'm2', role: 'assistant', content: '', stopped: true });
    expect(state.messages.some((m) => m.content.includes('Stopped before replying'))).toBe(false);
  });

  it('drops any other injected message instead of rendering it as text', () => {
    const state = chatReducer(initialChatState('s1'), {
      type: 'history',
      messages: [hist('m1', 'user', 'Hi'), { ...hist('m2', 'user', '[server note]'), injected: true }, hist('m3', 'assistant', 'Hello')],
    });
    expect(state.messages.map((m) => [m.id, m.content, m.stopped])).toEqual([
      ['m1', 'Hi', undefined],
      ['m3', 'Hello', undefined],
    ]);
  });

  it('keeps a streaming phase when history arrives during a send', () => {
    const state = chatReducer(streaming(), { type: 'history', messages: [] });
    expect(state.phase).toBe('streaming');
  });

  it('shows the newest page first and reveals earlier messages a page at a time', () => {
    const many = Array.from({ length: VISIBLE_PAGE * 2 + 5 }, (_, i) => hist(`m${i}`, i % 2 ? 'assistant' : 'user', `text ${i}`));
    const shown = chatReducer(initialChatState('s1'), { type: 'history', messages: many });
    expect(shown.hiddenBefore).toBe(VISIBLE_PAGE + 5);
    const once = chatReducer(shown, { type: 'older' });
    expect(once.hiddenBefore).toBe(5);
    expect(chatReducer(once, { type: 'older' }).hiddenBefore).toBe(0);
  });
  it('records a load failure without leaving the loading phase stuck', () => {
    const state = chatReducer(initialChatState('s1'), { type: 'loadFailed', message: 'not_found' });
    expect(state).toMatchObject({ phase: 'idle', loadError: 'not_found' });
  });

  it('resets to the initial state for a new conversation', () => {
    const dirty = streaming();
    expect(chatReducer(dirty, { type: 'reset', sessionKey: 's2' })).toEqual(initialChatState('s2'));
  });
});

describe('cards', () => {
  it('upserts cards by id, keeping their order', () => {
    let state = initialChatState('s1');
    state = chatReducer(state, { type: 'cards', cards: [card('a'), card('b')] });
    state = chatReducer(state, { type: 'card', card: card('a', 'Updated') });
    expect(state.cards.map((c) => [c.id, c.title])).toEqual([
      ['a', 'Updated'],
      ['b', 'Connect OpenAI'],
    ]);
  });

  it('lists only cards that no visible message references', () => {
    let state = streaming();
    state = chatReducer(state, event({ type: 'tool.call.completed', toolCall: { id: 't', name: 'ui_action', uiAction: card('attached') } }));
    state = chatReducer(state, { type: 'cards', cards: [card('loose')] });
    expect(looseCards(state).map((c) => c.id)).toEqual(['loose']);
  });
});

describe('local turns', () => {
  const base = { localId: 'u1', code: 'delivery_unconfirmed', message: 'Delivery could not be confirmed' };

  it('keeps a turn marked local across a history reload, after the server messages', () => {
    const failed = chatReducer(streaming(), { type: 'streamFailed', code: 'network_error', message: 'x', reconcile: true, local: true });
    expect(failed.messages.every((m) => m.local)).toBe(true);
    const reloaded = chatReducer(failed, { type: 'history', messages: [hist('m0', 'user', 'Earlier')] });
    expect(reloaded.messages.map((m) => m.id)).toEqual(['m0', 'u1', 'u1-reply']);
  });

  it('lets a history reload replace a turn that is not local', () => {
    const failed = chatReducer(streaming(), { type: 'streamFailed', code: 'connection_lost', message: 'x', reconcile: true });
    const reloaded = chatReducer(failed, { type: 'history', messages: [hist('m0', 'user', 'Hello')] });
    expect(reloaded.messages.map((m) => m.id)).toEqual(['m0']);
  });

  it('marks an unconfirmed message in place with a reload action and never a retry', () => {
    const next = chatReducer(streaming(), { type: 'restoreTurn', ...base, text: 'Hello' });
    expect(next.messages.map((m) => m.id)).toEqual(['u1', 'u1-reply']);
    expect(next.messages.at(-1)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'reload', streaming: false, local: true });
    expect(next.messages.some((m) => m.retryText)).toBe(false);
  });

  it('appends the turn once when a reload dropped it, and updates it in place after that', () => {
    const once = chatReducer(initialChatState('s1'), { type: 'restoreTurn', ...base, text: 'Hello' });
    const twice = chatReducer(once, { type: 'restoreTurn', ...base, text: 'Hello' });
    expect(twice.messages.map((m) => [m.role, m.content])).toEqual([['user', 'Hello'], ['assistant', '']]);
  });

  it('restores a continuation as a reply only, with "Continue"', () => {
    const continuation = { session_key: 's1', agent_key: 'a', setup_action_id: 'act_1' };
    const next = chatReducer(initialChatState('s1'), { type: 'restoreTurn', ...base, code: 'network_error', continuation });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]).toMatchObject({ id: 'u1-reply', role: 'assistant', retryContinuation: continuation });
    expect(next.messages[0]?.recover).toBeUndefined();
  });

  it('drops a settled turn with its reply', () => {
    const next = chatReducer(chatReducer(streaming(), { type: 'restoreTurn', ...base, text: 'Hello' }), { type: 'dropTurn', localId: 'u1' });
    expect(next.messages).toEqual([]);
  });

  it('keeps the reload action of an earlier unconfirmed turn when a new send starts', () => {
    const failed = chatReducer(streaming(), { type: 'restoreTurn', ...base, text: 'Hello' });
    const next = chatReducer(failed, { type: 'send', text: 'Next', localId: 'u2' });
    expect(next.messages.find((m) => m.id === 'u1-reply')).toMatchObject({ recover: 'reload', local: true });
  });
});