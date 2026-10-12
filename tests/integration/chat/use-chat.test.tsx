import { act, renderHook, waitFor } from '@testing-library/react';
import { DeweeClient } from '../../../src/api/dewee-client';
import { DeweeApiError } from '../../../src/api/errors';
import type { HistoryMessage } from '../../../src/api/schemas';
import type { ChatMessage } from '../../../src/chat/chat-state';
import { addPendingContinuation, loadPendingContinuations, removePendingContinuation } from '../../../src/chat/pending-continuations';
import { useChat, type ChatContext } from '../../../src/chat/use-chat';
import type { ChatEvent } from '../../../src/protocol/chat-events';
import { MAX_SSE_PENDING, SseProtocolError } from '../../../src/protocol/sse-reader';
import { parseUiAction } from '../../../src/protocol/ui-action';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SESSION = 'agent:super-agent:app:direct:u_1-1a2b3c4d';
const WORKSPACE = 'ws_1';
const PROFILE = 'p_1';

const storedCard = parseUiAction(
  JSON.parse(readFileSync(join(__dirname, '../../contract-fixtures/ui-action-v1/examples/secret_request.json'), 'utf8')),
);

const history = (messages: HistoryMessage[]) => ({
  session_key: SESSION,
  cursor: undefined,
  next_cursor: undefined,
  reset: false,
  messages,
});

const SERVER_HISTORY: HistoryMessage[] = [
  { id: 'm1', role: 'user', content: 'Hello', created_at: '2026-10-11T10:00:00Z' },
  { id: 'm2', role: 'assistant', content: 'Hi there', created_at: '2026-10-11T10:00:02Z' },
];

/** A fake transport: each method is a spy so tests can assert exactly which calls were made. */
function fakeClient(stream: (signal?: AbortSignal) => AsyncGenerator<ChatEvent>, overrides: { history?: () => Promise<unknown>; actions?: () => Promise<unknown[]> } = {}) {
  const methods = {
    streamChat: vi.fn((_workspace: string, _body: unknown, signal?: AbortSignal) => stream(signal)),
    history: vi.fn<(workspaceId: string, body: { session_key: string; cursor?: string; limit?: number }) => Promise<unknown>>(overrides.history ?? (async () => history(SERVER_HISTORY))),
    status: vi.fn(async (_workspaceId: string, _sessionKey: string): Promise<{ running: boolean; run_id?: string }> => ({ running: false, run_id: undefined })),
    actions: vi.fn(overrides.actions ?? (async () => [])),
    abort: vi.fn(async () => true),
  };
  return { client: methods as unknown as DeweeClient, methods };
}

function context(client: DeweeClient, sessionKey?: string): ChatContext {
  return { client, profileId: PROFILE, workspaceId: WORKSPACE, agentKey: 'super-agent', sessionKey };
}

const hooks = () => ({ onSessionKey: vi.fn<(key: string) => void>(), onAuthError: vi.fn<(error: DeweeApiError) => void>() });

// Sends are not wrapped in act(): act holds React commits until its callback returns, which would
// keep the hook's commit-time state ref at the pre-send phase for the whole stream.
describe('useChat transport loss', () => {
  it('reconciles after a broken stream and never calls streamChat a second time', async () => {
    const { client, methods } = fakeClient(async function* () {
      yield { type: 'chat.started', runId: 'r1', sessionKey: SESSION, agentKey: 'super-agent' };
      throw new DeweeApiError(0, 'network_error', 'Could not reach the server');
    });
    const h = hooks();
    const { result } = renderHook(() => useChat(context(client), h));

    void result.current.send('Hello');

    await waitFor(() => expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there']));
    expect(result.current.state.phase).toBe('idle');
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(methods.streamChat.mock.calls[0]?.[1]).toEqual({ agent_key: 'super-agent', message: 'Hello' });
    expect(h.onSessionKey).toHaveBeenCalledWith(SESSION);
    expect(methods.status).toHaveBeenCalledWith(WORKSPACE, SESSION);
    expect(methods.history).toHaveBeenCalledWith(WORKSPACE, { session_key: SESSION, cursor: '0', limit: 200 });
    expect(h.onAuthError).not.toHaveBeenCalled();
  });

  // The stream can close before the send commits; the end-of-stream check must not depend on React state.
  it('reconciles a stream that closes without a terminal frame, without re-sending', async () => {
    const { client, methods } = fakeClient(async function* () {
      yield { type: 'chat.started', runId: 'r2', sessionKey: SESSION, agentKey: 'super-agent' };
    });
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');

    await waitFor(() => expect(methods.history).toHaveBeenCalledWith(WORKSPACE, { session_key: SESSION, cursor: '0', limit: 200 }));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(methods.status).toHaveBeenCalledWith(WORKSPACE, SESSION);
  });

  it('does not reconcile or resend when the request was refused before the server accepted it', async () => {
    // eslint-disable-next-line require-yield -- the stream is refused before it yields anything
    const { client, methods } = fakeClient(async function* () {
      throw new DeweeApiError(400, 'invalid_request', 'Check the message');
    });
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');

    await waitFor(() => expect(result.current.state.messages.at(-1)?.error).toBeDefined());
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.messages.at(-1)).toMatchObject({ error: { code: 'invalid_request' }, retryText: 'Hello' });
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(methods.status).not.toHaveBeenCalled();
  });
});

/** Renders the hook on an existing session and waits for its first history load. */
async function openSession(stream: () => AsyncGenerator<ChatEvent>, overrides: Parameters<typeof fakeClient>[1] = {}) {
  const fake = fakeClient(stream, overrides);
  const view = renderHook(() => useChat(context(fake.client, SESSION), hooks()));
  await waitFor(() => expect(view.result.current.state.phase).toBe('idle'));
  expect(loads(fake.methods.history)).toBe(1);
  return { ...fake, ...view };
}

const lastMessage = (messages: ChatMessage[]) => messages.at(-1);

/** History loads made so far (each load probes the log length, then reads from a cursor). */
const loads = (history: { mock: { calls: unknown[][] } }) => history.mock.calls.filter((call) => (call[1] as { cursor?: string }).cursor === '0').length;

describe('useChat pre-send and post-response failures', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps "Send again" when the request never left the panel, without reconciling', async () => {
    // eslint-disable-next-line require-yield -- the request fails before the server answers
    const { result, methods } = await openSession(async function* () {
      throw new DeweeApiError(0, 'background_unavailable', 'Could not get credentials');
    });

    void result.current.send('Second question');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error).toBeDefined());
    expect(result.current.state.phase).toBe('idle');
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'background_unavailable' }, retryText: 'Second question' });
    expect(result.current.state.messages.at(-2)).toMatchObject({ role: 'user', content: 'Second question' });
    expect(methods.status).toHaveBeenCalledTimes(1);
    expect(loads(methods.history)).toBe(1);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('keeps "Send again" after a fetch rejected while the browser is offline, in a new chat', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    // eslint-disable-next-line require-yield -- the request fails before the server answers
    const { client, methods } = fakeClient(async function* () {
      throw new DeweeApiError(0, 'network_error', 'Could not reach the server');
    });
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error).toBeDefined());
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'network_error' }, retryText: 'Hello' });
    expect(methods.status).not.toHaveBeenCalled();
  });

  it.each([
    ['a fetch rejected while online', new DeweeApiError(0, 'network_error', 'Could not reach the server')],
    ['a stall before any response', new DeweeApiError(0, 'stream_stalled', 'The stream stopped responding')],
  ])('never offers "Send again" in a new chat after %s, and points to the conversation list', async (_name, failure) => {
    // eslint-disable-next-line require-yield -- the request fails before the server answers
    const { client, methods } = fakeClient(async function* () {
      throw failure;
    });
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error).toBeDefined());
    expect(result.current.state.phase).toBe('idle');
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'sessions' });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
    expect(methods.status).not.toHaveBeenCalled();
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('reconciles a drop after the server answered, with no retry', async () => {
    // eslint-disable-next-line require-yield -- the body breaks before the first frame
    const { result, methods } = await openSession(async function* () {
      throw new DeweeApiError(0, 'connection_lost', 'The connection was lost', undefined, true);
    });

    void result.current.send('Hello');

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.some((m) => m.retryText || m.retryContinuation)).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('does not offer "Send again" when a new chat drops after the server answered, before chat.started', async () => {
    // eslint-disable-next-line require-yield -- the body breaks before the first frame
    const { client, methods } = fakeClient(async function* () {
      throw new DeweeApiError(0, 'connection_lost', 'The connection was lost', undefined, true);
    });
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error).toBeDefined());
    expect(result.current.state.phase).toBe('idle');
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' } });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(methods.status).not.toHaveBeenCalled();
  });

  it.each([
    ['a fetch rejected while online', new DeweeApiError(0, 'network_error', 'Could not reach the server')],
    ['a stall before any response', new DeweeApiError(0, 'stream_stalled', 'The stream stopped responding')],
    ['a 500', new DeweeApiError(500, 'runtime_unavailable', 'HTTP 500')],
    ['a 502 from a proxy', new DeweeApiError(502, 'runtime_unavailable', 'HTTP 502')],
    ['a 503', new DeweeApiError(503, 'runtime_unavailable', 'HTTP 503')],
    ['a 504', new DeweeApiError(504, 'runtime_unavailable', 'HTTP 504')],
  ])('keeps a turn the history lacks once as unconfirmed, never with "Send again", after %s', async (_name, failure) => {
    // eslint-disable-next-line require-yield -- the request fails before the server answers
    const { result, methods } = await openSession(async function* () {
      throw failure;
    });

    void result.current.send('Second question');

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    const contents = result.current.state.messages.map((m) => m.content);
    expect(contents).toEqual(['Hello', 'Hi there', 'Second question', '']);
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'reload' });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('points a new chat to the conversation list after a 5xx, never "Send again"', async () => {
    // eslint-disable-next-line require-yield -- the request fails before the server answers
    const { client, methods } = fakeClient(async function* () {
      throw new DeweeApiError(503, 'runtime_unavailable', 'HTTP 503');
    });
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error).toBeDefined());
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'sessions' });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a run already in progress', new DeweeApiError(409, 'run_in_progress', 'Busy')],
    ['a validation error', new DeweeApiError(422, 'invalid_request', 'Invalid')],
    ['a forbidden send', new DeweeApiError(403, 'forbidden', 'Forbidden')],
  ])('offers "Send again" right away in a known session after %s, without reconciling', async (_name, failure) => {
    // eslint-disable-next-line require-yield -- the request is refused before the server accepts it
    const { result, methods } = await openSession(async function* () {
      throw failure;
    });

    void result.current.send('Second question');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error).toBeDefined());
    expect(result.current.state.phase).toBe('idle');
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: failure.code }, retryText: 'Second question' });
    expect(methods.status).toHaveBeenCalledTimes(1);
    expect(loads(methods.history)).toBe(1);
  });

  it('does not restore a turn the server history already holds', async () => {
    let delivered = false;
    // eslint-disable-next-line require-yield -- the request stalls before the server answers
    const { result, methods } = await openSession(async function* () {
      delivered = true;
      throw new DeweeApiError(0, 'stream_stalled', 'The stream stopped responding');
    }, {
      history: async () => history(delivered ? [...SERVER_HISTORY, { id: 'm3', role: 'user', content: 'Second question', created_at: undefined }, { id: 'm4', role: 'assistant', content: 'Answer', created_at: undefined }] : SERVER_HISTORY),
    });

    void result.current.send('Second question');

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there', 'Second question', 'Answer']);
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
  });

  it('offers "Send again" for a fetch rejected while offline in an existing chat, without polling', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    // eslint-disable-next-line require-yield -- the fetch is rejected before the server answers
    const { result, methods } = await openSession(async function* () {
      throw new DeweeApiError(0, 'network_error', 'Could not reach the server');
    });

    void result.current.send('Second question');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryText).toBe('Second question'));
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there', 'Second question', '']);
    expect(methods.status).toHaveBeenCalledTimes(1);
    expect(loads(methods.history)).toBe(1);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('pauses reconnect polling while offline and resumes on the online event', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const { result, methods } = await openSession(async function* () {
      yield { type: 'chat.started', runId: 'r1', sessionKey: SESSION, agentKey: 'super-agent' };
      throw new DeweeApiError(0, 'connection_lost', 'The connection was lost', undefined, true);
    });

    void result.current.send('Hello');

    await waitFor(() => expect(result.current.state.offline).toBe(true));
    expect(result.current.state.phase).toBe('reconciling');
    // Only the initial load asked for the run status: nothing polls while offline.
    expect(methods.status).toHaveBeenCalledTimes(1);

    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.offline).toBeUndefined();
    expect(methods.status.mock.calls.length).toBeGreaterThan(1);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });
});

/** A stream that waits for `release()` between frames, so tests can act while it is open. */
function gatedStream(frames: ChatEvent[]) {
  const gates: (() => void)[] = [];
  const opened: Promise<void>[] = frames.map(() => new Promise<void>((resolve) => gates.push(resolve)));
  let step = 0;
  return {
    release: () => gates[step++]?.(),
    // Like the real client, an aborted request ends the stream with an AbortError.
    stream: async function* (signal?: AbortSignal): AsyncGenerator<ChatEvent> {
      const aborted = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      aborted.catch(() => {});
      for (const [index, frame] of frames.entries()) {
        await Promise.race([opened[index], aborted]);
        yield frame;
      }
    },
  };
}

describe('useChat rate limiting', () => {
  it('shows how long to wait and offers a manual retry, without re-sending', async () => {
    // eslint-disable-next-line require-yield -- the stream is refused before it yields anything
    const { client, methods } = fakeClient(async function* () {
      throw new DeweeApiError(429, 'rate_limited', 'Too many requests', 3);
    });
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');

    await waitFor(() => expect(result.current.state.messages.at(-1)?.error).toBeDefined());
    expect(result.current.state.messages.at(-1)).toMatchObject({ error: { code: 'rate_limited', retryAfterSeconds: 3 }, retryText: 'Hello' });
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });
});

describe('useChat continuation retry', () => {
  it('offers "Continue" for a continuation the server refused before accepting it, and resends it once', async () => {
    let call = 0;
    const { result, methods } = await openSession(async function* () {
      if (call++ === 0) throw new DeweeApiError(429, 'rate_limited', 'Too many requests', 2);
      yield { type: 'chat.started', runId: 'r3', sessionKey: SESSION, agentKey: 'super-agent' };
      yield { type: 'message.completed', content: 'Continued', media: [] };
    });
    const continuation = { session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_9' };

    void result.current.continueWith(continuation);
    await waitFor(() => expect(result.current.state.messages.at(-1)?.retryContinuation).toEqual(continuation));
    expect(result.current.state.messages.at(-1)?.retryText).toBeUndefined();

    void result.current.retry(result.current.state.messages.at(-1)!);
    await waitFor(() => expect(result.current.state.messages.at(-1)?.content).toBe('Continued'));
    expect(methods.streamChat).toHaveBeenCalledTimes(2);
    expect(methods.streamChat.mock.calls[1]?.[1]).toEqual({ agent_key: 'super-agent', setup_action_id: 'act_9', session_key: SESSION });
    expect(result.current.state.messages.some((m) => m.retryContinuation)).toBe(false);
    expect(await storedContinuations()).toEqual([]);
  });

  it('counts a 409 continuation_sent as delivered: the item leaves the queue and the history is reloaded', async () => {
    // eslint-disable-next-line require-yield -- the Gateway refuses the repeat before streaming
    const { result, methods } = await openSession(async function* () {
      throw new DeweeApiError(409, 'continuation_sent', 'Already continued');
    });

    void result.current.continueWith({ session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_5' });

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.some((m) => m.retryContinuation || m.retryText)).toBe(false);
    expect(await storedContinuations()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });
});

/** Continuations the panel persisted for later (IDs only). */
const storedContinuations = () => loadPendingContinuations();

describe('useChat stop and continuation', () => {
  it('stops the run on the server once chat.started names it, when Stop came first', async () => {
    const gate = gatedStream([
      { type: 'chat.started', runId: 'r9', sessionKey: SESSION, agentKey: 'super-agent' },
      { type: 'message.completed', content: 'too late', media: [] },
    ]);
    const { client, methods } = fakeClient(gate.stream);
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));
    await result.current.stop();
    expect(methods.abort).not.toHaveBeenCalled();

    gate.release();
    await waitFor(() => expect(methods.abort).toHaveBeenCalledWith(WORKSPACE, { session_key: SESSION, run_id: 'r9', agent_key: 'super-agent' }));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.at(-1)).toMatchObject({ stopped: true, streaming: false });
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  // The parent stores the new session key (a settings write) while the server abort is in flight.
  it('keeps a new conversation when its session key is adopted during a pending Stop', async () => {
    const gate = gatedStream([
      { type: 'chat.started', runId: 'r7', sessionKey: SESSION, agentKey: 'super-agent' },
      { type: 'message.completed', content: 'late', media: [] },
    ]);
    const { client, methods } = fakeClient(gate.stream);
    let sessionKey: string | undefined;
    const h = { onSessionKey: vi.fn((key: string) => { sessionKey = key; rerender(); }), onAuthError: vi.fn() };
    const { result, rerender } = renderHook(() => useChat(context(client, sessionKey), h));

    void result.current.send('Hello');
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));
    await result.current.stop();
    gate.release();

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(methods.abort).toHaveBeenCalledWith(WORKSPACE, { session_key: SESSION, run_id: 'r7', agent_key: 'super-agent' });
    expect(result.current.state.sessionKey).toBe(SESSION);
    expect(result.current.state.runId).toBeUndefined();
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', '']);
    expect(methods.history).not.toHaveBeenCalled();
  });

  it('stops on the server right away when chat.started carried no run id', async () => {
    const gate = gatedStream([
      { type: 'chat.started', sessionKey: SESSION, agentKey: 'super-agent' } as ChatEvent,
      { type: 'message.completed', content: 'late', media: [] },
    ]);
    const { client, methods } = fakeClient(gate.stream);
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');
    gate.release();
    await waitFor(() => expect(result.current.state.sessionKey).toBe(SESSION));
    await result.current.stop();

    expect(methods.abort).toHaveBeenCalledWith(WORKSPACE, { session_key: SESSION, agent_key: 'super-agent' });
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
  });

  it('holds a card continuation until the running reply ends, then sends it once', async () => {
    const first = gatedStream([
      { type: 'chat.started', runId: 'r1', sessionKey: SESSION, agentKey: 'super-agent' },
      { type: 'message.completed', content: 'Saved', media: [] },
    ]);
    const streams = [first.stream, async function* (): AsyncGenerator<ChatEvent> {
      yield { type: 'chat.started', runId: 'r2', sessionKey: SESSION, agentKey: 'super-agent' };
      yield { type: 'message.completed', content: 'Continued', media: [] };
    }];
    let call = 0;
    const { client, methods } = fakeClient((signal) => streams[call++]!(signal));
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');
    first.release();
    await waitFor(() => expect(result.current.state.runId).toBe('r1'));

    await result.current.continueWith({ session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_1' });
    expect(methods.streamChat).toHaveBeenCalledTimes(1);

    first.release();
    await waitFor(() => expect(methods.streamChat).toHaveBeenCalledTimes(2));
    expect(methods.streamChat.mock.calls[1]?.[1]).toEqual({ agent_key: 'super-agent', setup_action_id: 'act_1', session_key: SESSION });
    await waitFor(() => expect(result.current.state.messages.at(-1)?.content).toBe('Continued'));
    expect(methods.streamChat).toHaveBeenCalledTimes(2);
  });
});

/** A stream that starts a run and completes it with `content`. */
const replyWith = (content: string) =>
  async function* (): AsyncGenerator<ChatEvent> {
    yield started();
    yield { type: 'message.completed', content, media: [] };
  };
const setupIds = (streamChat: { mock: { calls: unknown[][] } }) => streamChat.mock.calls.map((call) => (call[1] as { setup_action_id?: string }).setup_action_id);

describe('useChat continuation queue', () => {
  it('queues two cards answered during a stream and sends both, one after the other, once the reply ends', async () => {
    const first = gatedStream([started(), { type: 'message.completed', content: 'Saved', media: [] }]);
    const streams = [first.stream, replyWith('After card 1'), replyWith('After card 2')];
    let call = 0;
    const { client, methods } = fakeClient((signal) => streams[call++]!(signal));
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');
    first.release();
    await waitFor(() => expect(result.current.state.runId).toBe('r1'));
    await result.current.continueWith({ session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_1' });
    await result.current.continueWith({ session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_2' });
    await waitFor(async () => expect(await storedContinuations()).toHaveLength(2));
    expect(methods.streamChat).toHaveBeenCalledTimes(1);

    first.release();

    await waitFor(() => expect(methods.streamChat).toHaveBeenCalledTimes(3));
    expect(setupIds(methods.streamChat)).toEqual([undefined, 'act_1', 'act_2']);
    await waitFor(() => expect(result.current.state.messages.at(-1)?.content).toBe('After card 2'));
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
    expect(methods.streamChat).toHaveBeenCalledTimes(3);
  });

  it('persists a continuation across a session switch and sends it only once its own session is shown again', async () => {
    const gate = gatedStream([started(), { type: 'message.completed', content: 'late', media: [] }]);
    const streams = [gate.stream, replyWith('After card 3'), replyWith('After card 4')];
    let call = 0;
    const { client, methods } = fakeClient((signal) => streams[call++]!(signal));
    methods.history.mockImplementation(async (_ws, body) =>
      body.session_key === OTHER_SESSION ? { ...history([{ id: 'm0', role: 'user', content: 'Other', created_at: undefined }]), session_key: OTHER_SESSION } : history(SERVER_HISTORY),
    );
    const { result, rerender } = renderHook(({ key }) => useChat(context(client, key), hooks()), { initialProps: { key: SESSION } });
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    void result.current.send('Hello');
    gate.release();
    await waitFor(() => expect(result.current.state.runId).toBe('r1'));
    await result.current.continueWith({ session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_3' });

    rerender({ key: OTHER_SESSION });
    await waitFor(() => expect(result.current.state.messages.map((m) => m.content)).toEqual(['Other']));
    await waitFor(async () =>
      expect(await storedContinuations()).toEqual([{ profile_id: PROFILE, workspace_id: WORKSPACE, session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_3' }]),
    );
    // A card of the first session resolved while another one is shown waits for its session too.
    await result.current.continueWith({ session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_4' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Other']);

    rerender({ key: SESSION });

    await waitFor(() => expect(methods.streamChat).toHaveBeenCalledTimes(3));
    expect(setupIds(methods.streamChat)).toEqual([undefined, 'act_3', 'act_4']);
    expect(methods.streamChat.mock.calls.slice(1).every((c) => (c[1] as { session_key?: string }).session_key === SESSION)).toBe(true);
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
  });

  it('resumes a continuation that was still pending when the panel closed', async () => {
    const gate = gatedStream([started(), { type: 'message.completed', content: 'late', media: [] }]);
    const closing = fakeClient(gate.stream);
    const first = renderHook(() => useChat(context(closing.client, SESSION), hooks()));
    await waitFor(() => expect(first.result.current.state.phase).toBe('idle'));
    void first.result.current.send('Hello');
    gate.release();
    await waitFor(() => expect(first.result.current.state.runId).toBe('r1'));
    await first.result.current.continueWith({ session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_6' });
    await waitFor(async () => expect(await storedContinuations()).toHaveLength(1));

    first.unmount();
    expect(await storedContinuations()).toHaveLength(1);

    const reopened = fakeClient(replyWith('Continued'));
    const second = renderHook(() => useChat(context(reopened.client, SESSION), hooks()));

    await waitFor(() => expect(second.result.current.state.messages.at(-1)?.content).toBe('Continued'));
    expect(setupIds(reopened.methods.streamChat)).toEqual(['act_6']);
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
  });
});

describe('useChat reopen', () => {
  it('loads history, run status and open cards for a known session without sending', async () => {
    const { client, methods } = fakeClient(async function* () {
      yield { type: 'chat.stopped' } as ChatEvent;
    });
    methods.actions.mockResolvedValueOnce([storedCard]);
    const { result } = renderHook(() => useChat(context(client, SESSION), hooks()));

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));

    expect(methods.streamChat).not.toHaveBeenCalled();
    expect(methods.history).toHaveBeenCalledWith(WORKSPACE, { session_key: SESSION, cursor: '0', limit: 200 });
    expect(methods.status).toHaveBeenCalledWith(WORKSPACE, SESSION);
    expect(methods.actions).toHaveBeenCalledWith(WORKSPACE, { sessionKey: SESSION, status: 'pending' });
    expect(result.current.state.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.current.state.cards.map((c) => c.id)).toEqual([storedCard?.id]);
  });

  it('shows a load failure for the conversation instead of sending', async () => {
    const { client, methods } = fakeClient(async function* () {
      yield { type: 'chat.stopped' } as ChatEvent;
    }, {
      history: async () => {
        throw new DeweeApiError(404, 'not_found', 'Not found');
      },
    });
    const { result } = renderHook(() => useChat(context(client, SESSION), hooks()));

    await waitFor(() => expect(result.current.state.loadError).toBe('not_found'));
    expect(result.current.state.phase).toBe('idle');
    expect(methods.streamChat).not.toHaveBeenCalled();
  });
});

const OTHER_SESSION = 'agent:super-agent:app:direct:u_1-9f8e7d6c';
const started = (sessionKey = SESSION): ChatEvent => ({ type: 'chat.started', runId: 'r1', sessionKey, agentKey: 'super-agent' });
const lost = () => new DeweeApiError(0, 'connection_lost', 'The connection was lost', undefined, true);
const statusCalls = (status: { mock: { calls: unknown[][] } }, sessionKey: string) => status.mock.calls.filter((call) => call[1] === sessionKey).length;
/** Advances fake time in steps, letting React commit between them. */
async function advance(ms: number, step = 2_000) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(step);
    });
  }
}

describe('useChat reconcile ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the conversation busy while a run outlasts the fast polls, and starts no second loop', async () => {
    vi.useFakeTimers();
    let running = true;
    const { client, methods } = fakeClient(async function* () {
      yield started();
    });
    methods.status.mockImplementation(async () => ({ running, run_id: undefined }));
    const { result } = renderHook(() => useChat(context(client, SESSION), hooks()));

    await advance(10, 10);
    expect(result.current.state.phase).toBe('reconciling');

    // 100 fast-interval steps: past the 90 fast polls, the run is still going.
    await advance(200_000);
    expect(result.current.state.phase).toBe('reconciling');
    expect(statusCalls(methods.status, SESSION)).toBeGreaterThan(91);
    expect(loads(methods.history)).toBe(1);

    running = false;
    await advance(16_000);
    expect(result.current.state.phase).toBe('idle');
    expect(loads(methods.history)).toBe(2);
    expect(methods.streamChat).not.toHaveBeenCalled();
  });

  it('retires a reconcile loop when the session switches, so it never writes state or polls again', async () => {
    vi.useFakeTimers();
    const { client, methods } = fakeClient(async function* () {
      yield started();
    });
    methods.status.mockImplementation(async (_ws: string, key: string) => ({ running: key === SESSION }));
    methods.history.mockImplementation(async (_ws, body) =>
      body.session_key === OTHER_SESSION ? { ...history([{ id: 'm0', role: 'user', content: 'Other', created_at: undefined }]), session_key: OTHER_SESSION } : history(SERVER_HISTORY),
    );
    const { result, rerender } = renderHook(({ key }) => useChat(context(client, key), hooks()), { initialProps: { key: SESSION } });
    await advance(10, 10);
    expect(result.current.state.phase).toBe('reconciling');
    const before = statusCalls(methods.status, SESSION);

    rerender({ key: OTHER_SESSION });
    await advance(10_000);

    expect(statusCalls(methods.status, SESSION)).toBe(before);
    expect(result.current.state.sessionKey).toBe(OTHER_SESSION);
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Other']);
  });
});

describe('useChat offline wait', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function waitingOffline() {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const view = await openSession(async function* () {
      yield started();
      throw lost();
    });
    void view.result.current.send('Hello');
    await waitFor(() => expect(view.result.current.state.offline).toBe(true));
    return { ...view, online };
  }

  it('removes the online listener when the panel unmounts during the offline wait', async () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount, methods } = await waitingOffline();
    const polls = methods.status.mock.calls.length;

    unmount();

    await waitFor(() => expect(remove).toHaveBeenCalledWith('online', expect.any(Function)), { timeout: 4_000 });
    expect(methods.status.mock.calls.length).toBe(polls);
  });

  it('drops the offline wait of a conversation that was switched away', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const { client, methods } = fakeClient(async function* () {
      yield started();
      throw lost();
    });
    const { result, rerender } = renderHook(({ key }) => useChat(context(client, key), hooks()), { initialProps: { key: SESSION as string | undefined } });
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    void result.current.send('Hello');
    await waitFor(() => expect(result.current.state.offline).toBe(true));
    const polls = statusCalls(methods.status, SESSION);

    rerender({ key: undefined });
    online.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));

    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(statusCalls(methods.status, SESSION)).toBe(polls);
    expect(result.current.state.messages).toEqual([]);
    expect(result.current.state.offline).toBeUndefined();
  });

  it('resumes when the connection is back even if the online event was missed', async () => {
    const { result, methods, online } = await waitingOffline();

    online.mockReturnValue(true);

    await waitFor(() => expect(result.current.state.phase).toBe('idle'), { timeout: 4_000 });
    expect(loads(methods.history)).toBe(2);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });
});

describe('useChat delivery proof', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a repeated message the server lacks as unconfirmed, although an earlier turn has the same text', async () => {
    const earlier: HistoryMessage[] = [
      { id: 'm0', role: 'user', content: 'continue', created_at: undefined },
      { id: 'm1', role: 'assistant', content: 'Step 1', created_at: undefined },
    ];
    // eslint-disable-next-line require-yield -- the request fails before the server answers
    const { result, methods } = await openSession(async function* () {
      throw new DeweeApiError(0, 'network_error', 'Could not reach the server');
    }, { history: async () => history(earlier) });

    void result.current.send('continue');

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['continue', 'Step 1', 'continue', '']);
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'reload' });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
  });

  it('counts turns the server confirmed since the last history load', async () => {
    let call = 0;
    const streams = [
      async function* (): AsyncGenerator<ChatEvent> {
        yield started();
        yield { type: 'message.completed', content: 'Step 1', media: [] };
      },
      // eslint-disable-next-line require-yield -- the request fails before the server answers
      async function* (): AsyncGenerator<ChatEvent> {
        throw new DeweeApiError(0, 'network_error', 'Could not reach the server');
      },
    ];
    let delivered: HistoryMessage[] = SERVER_HISTORY;
    const { result, methods } = await openSession(() => streams[call++]!(), { history: async () => history(delivered) });

    void result.current.send('continue');
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.content).toBe('Step 1'));
    delivered = [...SERVER_HISTORY, { id: 'm3', role: 'user', content: 'continue', created_at: undefined }, { id: 'm4', role: 'assistant', content: 'Step 1', created_at: undefined }];

    void result.current.send('continue');

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there', 'continue', 'Step 1', 'continue', '']);
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'reload' });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
  });

  it.each([
    [
      'compaction renumbered the ids below the baseline',
      [
        { id: 'm0', role: 'user', content: 'Second question', created_at: undefined },
        { id: 'm1', role: 'assistant', content: 'Answer', created_at: undefined },
      ],
    ],
    [
      'compaction replaced the anchor message',
      [
        { id: 'm0', role: 'assistant', content: 'Summary of earlier turns', created_at: undefined },
        { id: 'm1', role: 'user', content: 'Second question', created_at: undefined },
        { id: 'm2', role: 'assistant', content: 'Answer', created_at: undefined },
      ],
    ],
    [
      'compaction rewrote the anchor although a matching turn follows its position',
      [
        { id: 'm0', role: 'assistant', content: 'Summary of earlier turns', created_at: undefined },
        { id: 'm1', role: 'user', content: 'Hello', created_at: undefined },
        { id: 'm2', role: 'assistant', content: 'Shortened reply', created_at: undefined },
        { id: 'm3', role: 'user', content: 'Second question', created_at: undefined },
        { id: 'm4', role: 'assistant', content: 'Answer', created_at: undefined },
      ],
    ],
  ] satisfies [string, HistoryMessage[]][])('keeps the turn once as unconfirmed, with no retry, when %s', async (_name, compacted) => {
    let sent = false;
    // eslint-disable-next-line require-yield -- the request stalls before the server answers
    const { result, methods } = await openSession(async function* () {
      sent = true;
      throw new DeweeApiError(0, 'stream_stalled', 'The stream stopped responding');
    }, { history: async () => history(sent ? compacted : SERVER_HISTORY) });

    void result.current.send('Second question');

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    const localCopies = () => result.current.state.messages.filter((m) => m.local && m.role === 'user');
    expect(localCopies().map((m) => m.content)).toEqual(['Second question']);
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'reload' });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);

    // Checking again keeps a single local copy and never sends.
    void result.current.reload();
    await waitFor(() => expect(loads(methods.history)).toBe(3));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(localCopies()).toHaveLength(1);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('keeps an earlier unconfirmed turn and its reload action when the next message is sent', async () => {
    let call = 0;
    const streams = [
      // eslint-disable-next-line require-yield -- the request stalls before the server answers
      async function* (): AsyncGenerator<ChatEvent> {
        throw new DeweeApiError(0, 'stream_stalled', 'The stream stopped responding');
      },
      async function* (): AsyncGenerator<ChatEvent> {
        yield started();
        throw lost();
      },
    ];
    let server: HistoryMessage[] = SERVER_HISTORY;
    const { result, methods } = await openSession(() => streams[call++]!(), { history: async () => history(server) });

    void result.current.send('Lost question');
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.recover).toBe('reload'));
    server = [...SERVER_HISTORY, { id: 'm3', role: 'user', content: 'Next question', created_at: undefined }, { id: 'm4', role: 'assistant', content: 'Next answer', created_at: undefined }];

    void result.current.send('Next question');

    await waitFor(() => expect(loads(methods.history)).toBe(3));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there', 'Next question', 'Next answer', 'Lost question', '']);
    expect(result.current.state.messages.find((m) => m.content === 'Lost question')).toMatchObject({ local: true });
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'reload' });
  });

  it('does not restore a delivered turn when another device posted a later one', async () => {
    let sent = false;
    // eslint-disable-next-line require-yield -- the request stalls before the server answers
    const { result, methods } = await openSession(async function* () {
      sent = true;
      throw new DeweeApiError(0, 'stream_stalled', 'The stream stopped responding');
    }, {
      history: async () =>
        history(
          sent
            ? [
                ...SERVER_HISTORY,
                { id: 'm3', role: 'user', content: 'Second question', created_at: undefined },
                { id: 'm4', role: 'assistant', content: 'Answer', created_at: undefined },
                { id: 'm5', role: 'user', content: 'From my phone', created_at: undefined },
              ]
            : SERVER_HISTORY,
        ),
    });

    void result.current.send('Second question');

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there', 'Second question', 'Answer', 'From my phone']);
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
  });

  it('shows delivery_unconfirmed with a reload action when the history cannot be read, then settles it on reload', async () => {
    let failing = false;
    let delivered = false;
    // eslint-disable-next-line require-yield -- the request fails before the server answers
    const { result, methods } = await openSession(async function* () {
      failing = true;
      throw new DeweeApiError(0, 'network_error', 'Could not reach the server');
    }, {
      history: async () => {
        if (failing) throw new DeweeApiError(0, 'network_error', 'Could not reach the server');
        return history(delivered ? [...SERVER_HISTORY, { id: 'm3', role: 'user', content: 'Second question', created_at: undefined }, { id: 'm4', role: 'assistant', content: 'Answer', created_at: undefined }] : SERVER_HISTORY);
      },
    });

    void result.current.send('Second question');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.recover).toBe('reload'));
    expect(result.current.state.phase).toBe('idle');
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' } });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);

    // The transcript was not cleared by the failed read.
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there', 'Second question', '']);

    failing = false;
    delivered = true;
    void result.current.reload();

    // The server holds the turn after the anchor: its copy shows and the local one is dropped.
    await waitFor(() => expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there', 'Second question', 'Answer']));
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.messages.some((m) => m.local || m.retryText || m.recover)).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('treats a history that keeps shrinking as unread: the turn stays unconfirmed and the transcript is kept', async () => {
    let shrinking = false;
    // eslint-disable-next-line require-yield -- the request stalls before the server answers
    const { result } = await openSession(async function* () {
      shrinking = true;
      throw new DeweeApiError(0, 'stream_stalled', 'The stream stopped responding');
    }, {
      history: async () => (shrinking ? { ...history([]), next_cursor: '0', reset: true } : history(SERVER_HISTORY)),
    });

    void result.current.send('Second question');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.recover).toBe('reload'));
    expect(result.current.state.loadError).toBe('history_changed');
    expect(result.current.state.messages.map((m) => m.content)).toEqual(['Hello', 'Hi there', 'Second question', '']);
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
  });

  it('reconciles with no retry when a client fault follows the response', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bug = new RangeError('decoder bug');
    const { result, methods } = await openSession(async function* () {
      yield { type: 'message.delta', delta: 'partial' } as ChatEvent;
      throw bug;
    });

    void result.current.send('Hello again');

    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
    expect(logged).toHaveBeenCalledWith('Chat stream failed', bug);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('does not offer "Send again" in a new chat when the client marks a fault as after the response', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bug = new RangeError('decoder bug');
    // eslint-disable-next-line require-yield -- the body fails before the first frame
    const { client } = fakeClient(async function* () {
      throw new DeweeApiError(0, 'runtime_request_failed', 'The reply could not be read', undefined, true, bug);
    });
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error).toBeDefined());
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'sessions' });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
    expect(logged).toHaveBeenCalledWith('Chat stream failed', bug);
  });

  it('treats an oversized stream (protocol_error) as uncertain: no "Send again" and no automatic resend', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // eslint-disable-next-line require-yield -- the body fails before the first frame
    const { client, methods } = fakeClient(async function* () {
      throw new DeweeApiError(0, 'protocol_error', 'The reply broke the stream format', undefined, true, new SseProtocolError('too large'));
    });
    const { result } = renderHook(() => useChat(context(client), hooks()));

    void result.current.send('Hello');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error).toBeDefined());
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'delivery_unconfirmed' }, recover: 'sessions' });
    expect(result.current.state.messages.some((m) => m.retryText)).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('shows protocol_error in a known session and reconciles, with no "Send again"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let failed = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { result, methods } = await openSession(
      async function* () {
        yield started();
        yield { type: 'message.delta', delta: 'partial' } as ChatEvent;
        failed = true;
        throw new DeweeApiError(0, 'protocol_error', 'The reply broke the stream format', undefined, true, new SseProtocolError('too large'));
      },
      {
        history: async () => {
          if (failed) await gate;
          return history(SERVER_HISTORY);
        },
      },
    );

    void result.current.send('Hello again');

    // While the reconcile reads the history, the failed turn shows the protocol error.
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error?.code).toBe('protocol_error'));
    expect(result.current.state.phase).toBe('reconciling');
    expect(result.current.state.messages.some((m) => m.retryText || m.retryContinuation)).toBe(false);

    release();
    await waitFor(() => expect(loads(methods.history)).toBe(2));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    expect(result.current.state.messages.some((m) => m.retryText || m.retryContinuation)).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('keeps a manual retry for a continuation lost before delivery in a known session, and resends it once', async () => {
    let call = 0;
    const { result, methods } = await openSession(async function* () {
      if (call++ === 0) throw new DeweeApiError(0, 'network_error', 'Could not reach the server');
      yield started();
      yield { type: 'message.completed', content: 'Continued', media: [] };
    });
    const continuation = { session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_7' };

    void result.current.continueWith(continuation);

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(continuation));
    expect(result.current.state.phase).toBe('idle');
    expect(loads(methods.history)).toBe(2);
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'network_error' } });

    void result.current.retry(lastMessage(result.current.state.messages)!);
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.content).toBe('Continued'));
    expect(methods.streamChat).toHaveBeenCalledTimes(2);
    expect(result.current.state.messages.some((m) => m.retryContinuation)).toBe(false);
  });
});

const CONTINUATION = { session_key: SESSION, agent_key: 'super-agent', setup_action_id: 'act_p' };
const inProgress = () => new DeweeApiError(409, 'continuation_in_progress', 'Another request is sending it');

describe('useChat continuation in progress elsewhere', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Opens SESSION under fake timers and queues CONTINUATION. */
  async function queueUnderFakeTimers(stream: (signal?: AbortSignal) => AsyncGenerator<ChatEvent>) {
    vi.useFakeTimers();
    const fake = fakeClient(stream);
    const view = renderHook(({ key }) => useChat(context(fake.client, key), hooks()), { initialProps: { key: SESSION } });
    await advance(10, 10);
    await act(async () => {
      await view.result.current.continueWith(CONTINUATION);
    });
    await advance(10, 10);
    return { ...fake, ...view };
  }

  it('keeps the item and sends it again after a backoff until it is delivered', async () => {
    let call = 0;
    const { result, methods } = await queueUnderFakeTimers(async function* () {
      if (call++ < 2) throw inProgress();
      yield started();
      yield { type: 'message.completed', content: 'Continued', media: [] };
    });

    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.messages.some((m) => m.error || m.retryContinuation)).toBe(false);
    expect(await storedContinuations()).toHaveLength(1);

    await advance(4_000, 1_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    await advance(2_000, 1_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(2);
    await advance(13_000, 1_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(2);
    await advance(3_000, 1_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(3);
    expect(setupIds(methods.streamChat)).toEqual(['act_p', 'act_p', 'act_p']);
    expect(lastMessage(result.current.state.messages)?.content).toBe('Continued');
    expect(await storedContinuations()).toEqual([]);
  });

  it("waits the server's Retry-After hint before the first re-send, then follows the backoff", async () => {
    let call = 0;
    // eslint-disable-next-line require-yield -- every attempt is answered 409 before streaming
    const { methods } = await queueUnderFakeTimers(async function* () {
      call++;
      throw new DeweeApiError(409, 'continuation_in_progress', 'Another request is sending it', 8);
    });

    await advance(7_000, 1_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    await advance(2_000, 1_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(2);
    // The hint sets only the first wait; the next one is the backoff's second step (15 s), not 8 s.
    await advance(12_000, 1_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(2);
    await advance(4_000, 1_000);
    expect(call).toBe(3);
  });

  it('stops retrying after about 11 minutes and offers "Continue", keeping the item', async () => {
    // eslint-disable-next-line require-yield -- every attempt is answered 409 before streaming
    const { result, methods } = await queueUnderFakeTimers(async function* () {
      throw inProgress();
    });

    await advance(12 * 60_000, 1_000);
    const attempts = methods.streamChat.mock.calls.length;
    expect(attempts).toBeGreaterThanOrEqual(12);
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'continuation_in_progress' }, retryContinuation: CONTINUATION });
    expect(await storedContinuations()).toHaveLength(1);

    await advance(5 * 60_000, 5_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(attempts);
    expect(await storedContinuations()).toHaveLength(1);
  });

  it('waits while its session is not shown and retries once it is shown again', async () => {
    let call = 0;
    const { rerender, methods } = await queueUnderFakeTimers(async function* () {
      if (call++ === 0) throw inProgress();
      yield started();
      yield { type: 'message.completed', content: 'Continued', media: [] };
    });
    expect(methods.streamChat).toHaveBeenCalledTimes(1);

    rerender({ key: OTHER_SESSION });
    await advance(30_000, 1_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);

    rerender({ key: SESSION });
    await advance(100, 10);
    expect(methods.streamChat).toHaveBeenCalledTimes(2);
    expect(await storedContinuations()).toEqual([]);
  });

  it.each(['conflict', 'failed_precondition'])('keeps a continuation answered 409 %s and offers "Continue", never dropping it', async (code) => {
    // eslint-disable-next-line require-yield -- refused before streaming
    const { result, methods } = await openSession(async function* () {
      throw new DeweeApiError(409, code, 'Conflict');
    });

    void result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(CONTINUATION));
    expect(await storedContinuations()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });
});

describe('useChat stopping a continuation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function streamingContinuation() {
    vi.useFakeTimers();
    const gate = gatedStream([started(), { type: 'message.completed', content: 'late', media: [] }]);
    const fake = fakeClient(gate.stream);
    const view = renderHook(() => useChat(context(fake.client, SESSION), hooks()));
    await advance(10, 10);
    await act(async () => {
      await view.result.current.continueWith(CONTINUATION);
    });
    await advance(10, 10);
    expect(view.result.current.state.phase).toBe('streaming');
    return { ...fake, ...view, gate };
  }

  it('keeps a continuation stopped before the server answered, with "Continue"', async () => {
    const { result, methods } = await streamingContinuation();

    await act(async () => {
      await result.current.stop();
    });
    await advance(6_000, 1_000);

    expect(result.current.state.phase).toBe('idle');
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'continuation_stopped' }, retryContinuation: CONTINUATION });
    expect(await storedContinuations()).toHaveLength(1);
    expect(methods.abort).not.toHaveBeenCalled();
  });

  it('keeps a continuation stopped after chat.started, held with "Continue": the run may have ended before saving it', async () => {
    const { result, methods, gate } = await streamingContinuation();

    gate.release();
    await advance(10, 10);
    await act(async () => {
      await result.current.stop();
    });
    await advance(10, 10);

    expect(methods.abort).toHaveBeenCalled();
    expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code: 'continuation_stopped' }, retryContinuation: CONTINUATION });
    expect(await storedContinuations()).toEqual([{ ...CONTINUATION, profile_id: PROFILE, workspace_id: WORKSPACE, held: true }]);
    await advance(30_000, 1_000);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });
});

describe('useChat continuation scope', () => {
  it('tags a continuation with the profile and workspace the card was answered in', async () => {
    const { result, methods } = await openSession(replyWith('Continued'));

    await result.current.continueWith(CONTINUATION, { profileId: PROFILE, workspaceId: 'ws_old' });

    await waitFor(async () => expect(await storedContinuations()).toEqual([{ ...CONTINUATION, profile_id: PROFILE, workspace_id: 'ws_old' }]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods.streamChat).not.toHaveBeenCalled();
  });

  it('does not send a stored continuation of another profile', async () => {
    await addPendingContinuation({ ...CONTINUATION, profile_id: 'p_other', workspace_id: WORKSPACE });

    const { methods } = await openSession(replyWith('Continued'));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods.streamChat).not.toHaveBeenCalled();
    expect(await storedContinuations()).toHaveLength(1);
  });

  it('shares the queue between two panels: one adds an item, the other sends it, and neither sends it twice', async () => {
    const a = fakeClient(replyWith('unused'));
    const panelA = renderHook(({ key }) => useChat(context(a.client, key), hooks()), { initialProps: { key: OTHER_SESSION } });
    const b = fakeClient(replyWith('Continued'));
    const panelB = renderHook(() => useChat(context(b.client, SESSION), hooks()));
    await waitFor(() => expect(panelA.result.current.state.phase).toBe('idle'));
    await waitFor(() => expect(panelB.result.current.state.phase).toBe('idle'));

    await panelA.result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(panelB.result.current.state.messages.at(-1)?.content).toBe('Continued'));
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
    expect(setupIds(b.methods.streamChat)).toEqual(['act_p']);

    panelA.rerender({ key: SESSION });
    await waitFor(() => expect(panelA.result.current.state.sessionKey).toBe(SESSION));
    await waitFor(() => expect(panelA.result.current.state.phase).toBe('idle'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(a.methods.streamChat).not.toHaveBeenCalled();
  });
});

describe('useChat injected turns and refused sends', () => {
  it('does not count an injected user turn as the delivered message', async () => {
    let sent = false;
    // eslint-disable-next-line require-yield -- the request stalls before the server answers
    const { result } = await openSession(async function* () {
      sent = true;
      throw new DeweeApiError(0, 'stream_stalled', 'The stream stopped responding');
    }, {
      history: async () => history(sent ? [...SERVER_HISTORY, { id: 'm3', role: 'user', content: 'Second question', created_at: undefined, injected: true }] : SERVER_HISTORY),
    });

    void result.current.send('Second question');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.recover).toBe('reload'));
    expect(result.current.state.messages.filter((m) => m.local && m.role === 'user').map((m) => m.content)).toEqual(['Second question']);
  });

  it('reports a send refused because another stream started in the same moment', async () => {
    const gate = gatedStream([started(), { type: 'message.completed', content: 'Saved', media: [] }]);
    const { result, methods } = await openSession(gate.stream);

    expect(result.current.send('First')).toBe(true);
    expect(result.current.send('Second')).toBe(false);
    expect(result.current.send('   ')).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });
});

const HELD = { ...CONTINUATION, profile_id: PROFILE, workspace_id: WORKSPACE, held: true };
const idle = async () => new Promise((resolve) => setTimeout(resolve, 20));

describe('useChat continuation delivery proof', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps a continuation whose run failed after chat.started (rate limited): stored, held, with "Continue"', async () => {
    let call = 0;
    const { result, methods } = await openSession(async function* () {
      yield started();
      if (call++ === 0) {
        yield { type: 'chat.error', code: 'provider_rate_limited', action: 'wait_and_retry', retryAfterSeconds: 20 };
        return;
      }
      yield { type: 'message.completed', content: 'Continued', media: [] };
    });

    void result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(CONTINUATION));
    expect(lastMessage(result.current.state.messages)?.error).toMatchObject({ code: 'provider_rate_limited', action: 'wait_and_retry' });
    await waitFor(async () => expect(await storedContinuations()).toEqual([HELD]));
    await idle();
    expect(methods.streamChat).toHaveBeenCalledTimes(1);

    void result.current.retry(lastMessage(result.current.state.messages)!);
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.content).toBe('Continued'));
    expect(setupIds(methods.streamChat)).toEqual(['act_p', 'act_p']);
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
  });

  it('drops a continuation on chat.error setup_result_delivered and shows its message, with no "Continue"', async () => {
    const { result, methods } = await openSession(async function* () {
      yield started();
      yield { type: 'chat.error', code: 'setup_result_delivered', action: 'continue_in_chat' };
    });

    void result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error).toMatchObject({ code: 'setup_result_delivered', action: 'continue_in_chat' }));
    expect(lastMessage(result.current.state.messages)?.retryContinuation).toBeUndefined();
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
    await idle();
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('keeps a continuation whose stream closed early, and offers "Continue" once the run ends', async () => {
    const { result, methods } = await openSession(async function* () {
      yield started();
    });

    void result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(CONTINUATION));
    expect(lastMessage(result.current.state.messages)?.error?.code).toBe('continuation_unconfirmed');
    expect(methods.status).toHaveBeenCalledWith(WORKSPACE, SESSION);
    await waitFor(async () => expect(await storedContinuations()).toEqual([HELD]));
    await idle();
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('keeps a continuation dropped after the response, and offers "Continue" once the run ends', async () => {
    const { result, methods } = await openSession(async function* () {
      yield started();
      throw lost();
    });

    void result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(CONTINUATION));
    // The failed turn itself offers "Continue" with the drop's error, not a later placeholder.
    expect(lastMessage(result.current.state.messages)?.error?.code).toBe('connection_lost');
    expect(result.current.state.messages.filter((m) => m.retryContinuation)).toHaveLength(1);
    await waitFor(async () => expect(await storedContinuations()).toEqual([HELD]));
    await idle();
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it('keeps a continuation whose stream broke the format after the response (protocol_error): held, with "Continue"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, methods } = await openSession(async function* () {
      yield started();
      throw new DeweeApiError(0, 'protocol_error', 'The reply broke the stream format', undefined, true, new SseProtocolError('too large'));
    });

    void result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(CONTINUATION));
    expect(lastMessage(result.current.state.messages)?.error?.code).toBe('protocol_error');
    expect(result.current.state.messages.filter((m) => m.retryContinuation)).toHaveLength(1);
    await waitFor(async () => expect(await storedContinuations()).toEqual([HELD]));
    await idle();
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  /**
   * The real client over one body chunk holding chat.started, message.completed and then a line
   * past the parser cap, so the turn ends normally before the stream fails with protocol_error.
   */
  const completedThenOverflow = (signal?: AbortSignal) => {
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const text =
      frame('chat.started', { run_id: 'r1', session_key: SESSION, agent_key: 'super-agent' }) +
      frame('message.completed', { message: { role: 'assistant', content: 'Done', created_at: '2026-10-12T09:00:00Z' } }) +
      `data: ${'x'.repeat(MAX_SSE_PENDING)}\n`;
    const fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
          },
        }),
        { status: 200 },
      );
    const real = new DeweeClient({ baseUrl: 'https://gw.example.test/v1/extension', auth: { authorization: async () => 'Bearer test-api-key' }, fetch, streamIdleMs: 1000 });
    return real.streamChat(WORKSPACE, { agent_key: 'super-agent', message: 'Hi', session_key: SESSION }, signal);
  };

  it('keeps a reply completed in the chunk that overflows: no error bubble and no "Send again"', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, methods } = await openSession(completedThenOverflow);

    void result.current.send('Hello again');

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.content).toBe('Done'));
    await idle();
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.messages.some((m) => m.error || m.retryText || m.retryContinuation || m.recover)).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(logged).not.toHaveBeenCalledWith('Chat stream failed', expect.anything());
  });

  it('acknowledges a continuation whose message.completed came in the chunk that overflows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, methods } = await openSession(completedThenOverflow);

    void result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.content).toBe('Done'));
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
    await idle();
    expect(result.current.state.phase).toBe('idle');
    expect(result.current.state.messages.some((m) => m.error || m.retryContinuation)).toBe(false);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, 'invalid_request'],
    [403, 'unauthorized'],
    [404, 'not_found'],
    [410, 'gone'],
  ])('drops a continuation refused %i %s (it can never succeed), says so once with no "Continue" and logs only the status and code', async (status, code) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // eslint-disable-next-line require-yield -- refused before streaming
    const { result, methods } = await openSession(async function* () {
      throw new DeweeApiError(status, code, 'Refused');
    });

    void result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.error?.code).toBe('continuation_refused'));
    expect(result.current.state.messages.filter((m) => m.error)).toHaveLength(1);
    expect(lastMessage(result.current.state.messages)?.retryContinuation).toBeUndefined();
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
    await idle();
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Card continuation refused', { status, code });
  });

  it.each(['scope_required', 'owner_binding_required'])('keeps a continuation refused 403 %s (the person can fix the key): held, with "Continue" and the key error', async (code) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let call = 0;
    const { result, methods } = await openSession(async function* () {
      if (call++ === 0) throw new DeweeApiError(403, code, 'Refused');
      yield started();
      yield { type: 'message.completed', content: 'Continued', media: [] };
    });

    void result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(lastMessage(result.current.state.messages)).toMatchObject({ error: { code }, retryContinuation: CONTINUATION }));
    await waitFor(async () => expect(await storedContinuations()).toEqual([HELD]));
    await idle();
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();

    void result.current.retry(lastMessage(result.current.state.messages)!);
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.content).toBe('Continued'));
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
  });

  it('treats 409 continuation_sent as a silent success: no error bubble at any point', async () => {
    // eslint-disable-next-line require-yield -- the Gateway refuses the repeat before streaming
    const fake = fakeClient(async function* () {
      throw new DeweeApiError(409, 'continuation_sent', 'Already continued');
    });
    const errors: string[] = [];
    const view = renderHook(() => {
      const chat = useChat(context(fake.client, SESSION), hooks());
      for (const m of chat.state.messages) if (m.error) errors.push(m.error.code);
      return chat;
    });
    await waitFor(() => expect(view.result.current.state.phase).toBe('idle'));

    void view.result.current.continueWith(CONTINUATION);

    await waitFor(() => expect(loads(fake.methods.history)).toBe(2));
    await waitFor(() => expect(view.result.current.state.phase).toBe('idle'));
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
    expect(errors).toEqual([]);
  });

  it('does not send a held item again after a conversation switch: its session shows "Continue" instead', async () => {
    let call = 0;
    const { result, rerender, methods } = await (async () => {
      const fake = fakeClient(async function* () {
        call++;
        yield started();
        yield { type: 'chat.error', code: 'provider_overloaded', action: 'retry' };
      });
      const view = renderHook(({ key }) => useChat(context(fake.client, key), hooks()), { initialProps: { key: SESSION } });
      await waitFor(() => expect(view.result.current.state.phase).toBe('idle'));
      return { ...fake, ...view };
    })();
    void result.current.continueWith(CONTINUATION);
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(CONTINUATION));

    rerender({ key: OTHER_SESSION });
    await waitFor(() => expect(result.current.state.sessionKey).toBe(OTHER_SESSION));
    await waitFor(() => expect(result.current.state.phase).toBe('idle'));
    rerender({ key: SESSION });
    await waitFor(() => expect(result.current.state.sessionKey).toBe(SESSION));

    await waitFor(() => expect(lastMessage(result.current.state.messages)).toMatchObject({ retryContinuation: CONTINUATION, error: { code: 'continuation_unconfirmed' } }));
    await idle();
    expect(call).toBe(1);
    expect(methods.streamChat).toHaveBeenCalledTimes(1);
    expect(result.current.state.messages.filter((m) => m.retryContinuation)).toHaveLength(1);
  });

  it('does not auto-send an item stored as held when a panel opens: it waits for "Continue"', async () => {
    await addPendingContinuation(HELD);

    const { result, methods } = await openSession(replyWith('Continued'));

    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(CONTINUATION));
    await idle();
    expect(methods.streamChat).not.toHaveBeenCalled();

    void result.current.retry(lastMessage(result.current.state.messages)!);
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.content).toBe('Continued'));
    expect(setupIds(methods.streamChat)).toEqual(['act_p']);
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
  });
});

describe('useChat timers on unmount', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the reconcile sleep when the panel unmounts', async () => {
    vi.useFakeTimers();
    const fake = fakeClient(replyWith('unused'));
    fake.methods.status.mockImplementation(async () => ({ running: true, run_id: 'r1' }));
    const view = renderHook(() => useChat(context(fake.client, SESSION), hooks()));
    await advance(10, 10);
    expect(view.result.current.state.phase).toBe('reconciling');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    view.unmount();
    await advance(10, 10);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the Stop grace timer when the panel unmounts', async () => {
    vi.useFakeTimers();
    const gate = gatedStream([started(), { type: 'message.completed', content: 'late', media: [] }]);
    const fake = fakeClient(gate.stream);
    const view = renderHook(() => useChat(context(fake.client), hooks()));
    view.result.current.send('Hello');
    await advance(10, 10);
    await act(async () => {
      await view.result.current.stop();
    });
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

const UNHELD = { ...CONTINUATION, profile_id: PROFILE, workspace_id: WORKSPACE };

describe('useChat continuation across panels, unmount and reopen', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('stops retrying an in-progress continuation once another panel stores it as held, and offers "Continue"', async () => {
    vi.useFakeTimers();
    // eslint-disable-next-line require-yield -- every attempt is answered 409 before streaming
    const panelB = fakeClient(async function* () {
      throw inProgress();
    });
    const view = renderHook(() => useChat(context(panelB.client, SESSION), hooks()));
    await advance(10, 10);
    await act(async () => {
      await view.result.current.continueWith(CONTINUATION);
    });
    await advance(10, 10);
    expect(panelB.methods.streamChat).toHaveBeenCalledTimes(1);

    // Panel A's own send of the item failed, so it stores the item as held while B waits to retry.
    await act(async () => {
      await addPendingContinuation(HELD);
    });
    await advance(120_000, 1_000);

    expect(panelB.methods.streamChat).toHaveBeenCalledTimes(1);
    expect(lastMessage(view.result.current.state.messages)).toMatchObject({ retryContinuation: CONTINUATION, error: { code: 'continuation_unconfirmed' } });
    expect(await storedContinuations()).toEqual([HELD]);
  });

  it('does not hold a continuation whose stream the unmount cut: like a switch, a reopened panel sends it again', async () => {
    const gate = gatedStream([started(), { type: 'message.completed', content: 'late', media: [] }]);
    const closing = fakeClient(gate.stream);
    const first = renderHook(() => useChat(context(closing.client, SESSION), hooks()));
    await waitFor(() => expect(first.result.current.state.phase).toBe('idle'));
    void first.result.current.continueWith(CONTINUATION);
    await waitFor(() => expect(first.result.current.state.phase).toBe('streaming'));
    gate.release();
    await waitFor(() => expect(first.result.current.state.runId).toBe('r1'));

    first.unmount();
    await idle();
    expect(await storedContinuations()).toEqual([UNHELD]);

    const reopened = fakeClient(replyWith('Continued'));
    const second = renderHook(() => useChat(context(reopened.client, SESSION), hooks()));

    await waitFor(() => expect(second.result.current.state.messages.at(-1)?.content).toBe('Continued'));
    expect(setupIds(reopened.methods.streamChat)).toEqual(['act_p']);
    expect(second.result.current.state.messages.some((m) => m.retryContinuation)).toBe(false);
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
  });

  it('releases a held item when another panel stores it unheld: the stale "Continue" goes and the item is sent', async () => {
    await addPendingContinuation(HELD);
    const gate = gatedStream([started(), { type: 'message.completed', content: 'Continued', media: [] }]);
    const { result, methods } = await openSession(gate.stream);
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(CONTINUATION));
    await idle();
    expect(methods.streamChat).not.toHaveBeenCalled();

    // Another panel pressed "Continue".
    await addPendingContinuation(UNHELD);

    // The stale "Continue" is gone as soon as the item is released, not only once it is delivered.
    await waitFor(() => expect(result.current.state.phase).toBe('streaming'));
    expect(result.current.state.messages.some((m) => m.retryContinuation)).toBe(false);
    gate.release();
    gate.release();
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.content).toBe('Continued'));
    expect(setupIds(methods.streamChat)).toEqual(['act_p']);
    await waitFor(async () => expect(await storedContinuations()).toEqual([]));
  });

  it('removes a stale "Continue" when another panel delivers the item, and a click on it then does nothing', async () => {
    await addPendingContinuation(HELD);
    const { result, methods } = await openSession(replyWith('Continued'));
    await waitFor(() => expect(lastMessage(result.current.state.messages)?.retryContinuation).toEqual(CONTINUATION));
    const stale = lastMessage(result.current.state.messages)!;

    await removePendingContinuation(HELD);

    await waitFor(() => expect(result.current.state.messages.some((m) => m.retryContinuation)).toBe(false));
    await act(async () => {
      await result.current.retry(stale);
    });
    await idle();
    expect(methods.streamChat).not.toHaveBeenCalled();
    expect(result.current.state.messages.some((m) => m.error)).toBe(false);
    expect(await storedContinuations()).toEqual([]);
  });

  it('stores when the in-progress retries started, so a reopened panel keeps the same 11-minute window', async () => {
    vi.useFakeTimers();
    // eslint-disable-next-line require-yield -- every attempt is answered 409 before streaming
    const busy = async function* (): AsyncGenerator<ChatEvent> {
      throw inProgress();
    };
    const closing = fakeClient(busy);
    const first = renderHook(() => useChat(context(closing.client, SESSION), hooks()));
    await advance(10, 10);
    const start = Date.now();
    await act(async () => {
      await first.result.current.continueWith(CONTINUATION);
    });
    await advance(10, 10);
    const [stored] = await storedContinuations();
    expect(stored).toEqual({ ...UNHELD, in_progress_since: expect.any(Number) });
    expect(stored!.in_progress_since).toBeGreaterThanOrEqual(start);

    await advance(10 * 60_000, 1_000);
    first.unmount();
    const reopened = fakeClient(busy);
    const second = renderHook(() => useChat(context(reopened.client, SESSION), hooks()));
    await advance(2 * 60_000, 1_000);

    // The window ends 11 minutes after the first in-progress answer, not 11 minutes after the reopen.
    expect(lastMessage(second.result.current.state.messages)).toMatchObject({ error: { code: 'continuation_in_progress' }, retryContinuation: CONTINUATION });
    const attempts = reopened.methods.streamChat.mock.calls.length;
    await advance(5 * 60_000, 5_000);
    expect(reopened.methods.streamChat).toHaveBeenCalledTimes(attempts);
    expect(await storedContinuations()).toEqual([{ ...UNHELD, in_progress_since: stored!.in_progress_since, held: true }]);
  });
});