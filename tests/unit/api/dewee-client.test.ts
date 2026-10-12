import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeweeClient, type AuthAdapter } from '../../../src/api/dewee-client';
import { DeweeApiError } from '../../../src/api/errors';
import type { ChatEvent } from '../../../src/protocol/chat-events';

const BASE = 'https://gw.example.test/v1/extension';
const card = JSON.parse(
  readFileSync(join(__dirname, '../../contract-fixtures/ui-action-v1/examples/secret_request.json'), 'utf8'),
) as Record<string, unknown>;

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const errorBody = (code: string, message = code) => ({ error: { code, message } });

/**
 * A response body that errors when the request signal aborts, as a real fetch body does. It stays
 * open after the frames unless `end` is set, so a stall or a caller abort is the only way out.
 */
function abortableBody(signal: AbortSignal | null | undefined, frames: string[], end = false): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (end) controller.close();
      signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  });
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function auth(overrides: Partial<AuthAdapter> = {}): AuthAdapter {
  return { authorization: vi.fn(async () => 'Bearer test-api-key'), ...overrides };
}

function client(fetch: typeof globalThis.fetch, options: { auth?: AuthAdapter; timeoutMs?: number; streamIdleMs?: number } = {}) {
  return new DeweeClient({ baseUrl: `${BASE}/`, auth: options.auth ?? auth(), fetch, timeoutMs: options.timeoutMs, streamIdleMs: options.streamIdleMs });
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('request construction', () => {
  it('strips trailing slashes from the base URL and sends the adapter header', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ user: { id: 'u_1' }, auth: { mode: 'api_key', scopes: [] } }));
    await client(fetch).me();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/me`);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-api-key');
    expect(new Headers(init?.headers).get('Content-Type')).toBeNull();
  });

  it('sends JSON bodies with a content type and encodes path segments', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ session_key: 's', cursor: null, next_cursor: null, reset: false, messages: [] }));
    await client(fetch).history('ws 1/x', { session_key: 'agent:super-agent:app:direct:u1-1', limit: 50 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/workspaces/ws%201%2Fx/chat/history`);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ session_key: 'agent:super-agent:app:direct:u1-1', limit: 50 });
  });

  it('encodes the session key in the status path and builds the sessions query', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).includes('/status')
        ? jsonResponse({ running: false, run_id: null })
        : jsonResponse({ sessions: [], total: 0 }),
    );
    const api = client(fetch);
    await api.status('ws_1', 'agent:super-agent:app:direct:u1-1');
    await api.sessions('ws_1', { agentKey: 'super-agent' });
    expect(fetch.mock.calls[0]![0]).toBe(`${BASE}/workspaces/ws_1/sessions/agent%3Asuper-agent%3Aapp%3Adirect%3Au1-1/status`);
    expect(fetch.mock.calls[1]![0]).toBe(`${BASE}/workspaces/ws_1/sessions?agent_key=super-agent&limit=20&offset=0`);
  });

  it('omits the query string when no action filter is given', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ actions: [] }));
    await client(fetch).actions('ws_1');
    expect(fetch.mock.calls[0]![0]).toBe(`${BASE}/workspaces/ws_1/actions`);
  });
});

describe('401 handling', () => {
  it('renews once and retries with the new authorization', async () => {
    let token = 'Bearer old';
    const renew = vi.fn(async () => {
      token = 'Bearer new';
      return true;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse(errorBody('token_expired'), 401))
      .mockResolvedValueOnce(jsonResponse({ workspaces: [{ id: 'ws_1', name: 'Acme', role: 'owner', status: 'active' }] }));
    const api = client(fetch, { auth: auth({ authorization: async () => token, renew }) });

    const workspaces = await api.workspaces();

    expect(workspaces).toEqual([{ id: 'ws_1', name: 'Acme', role: 'owner', status: 'active' }]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('Authorization')).toBe('Bearer new');
  });

  it('surfaces a second 401 without renewing again', async () => {
    const renew = vi.fn(async () => true);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(errorBody('token_revoked'), 401));
    const error = await client(fetch, { auth: auth({ renew }) }).workspaces().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, code: 'token_revoked', kind: 'auth' });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry when renewal reports failure, or when there is no renew hook', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(errorBody('unauthenticated'), 401));
    await expect(client(fetch, { auth: auth({ renew: async () => false }) }).workspaces()).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);

    fetch.mockClear();
    await expect(client(fetch).workspaces()).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('transport failures', () => {
  it('maps a timed-out request to code timeout with status 0', async () => {
    // Browsers give AbortSignal.timeout a TimeoutError DOMException of the page's own realm. The
    // jsdom test realm does not share its DOMException with Node's timer, so the shim builds the
    // reason from the global DOMException the client checks against.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
      return controller.signal;
    });
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    });
    const error = await client(fetch, { timeoutMs: 20 }).me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeweeApiError);
    expect(error).toMatchObject({ status: 0, code: 'timeout', kind: 'network' });
  });

  it('maps a rejected fetch to network_error without leaking the cause', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('fetch failed for https://gw.example.test/secret-path');
    });
    const error = await client(fetch).me().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'network_error', message: 'Could not reach the server' });
  });

  it('reports an unreadable or off-contract body as invalid_response', async () => {
    const notJson = vi.fn<typeof globalThis.fetch>(async () => new Response('<html>', { status: 200 }));
    await expect(client(notJson).me()).rejects.toMatchObject({ code: 'invalid_response' });

    const wrongShape = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ unexpected: true }));
    await expect(client(wrongShape).me()).rejects.toMatchObject({ code: 'invalid_response', status: 200 });
  });

  it('maps error envelopes with status codes to typed errors', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(errorBody('run_in_progress'), 409));
    await expect(client(fetch).abort('ws_1', { session_key: 's' })).rejects.toMatchObject({ status: 409, code: 'run_in_progress', kind: 'conflict' });
  });
});

describe('respond', () => {
  it('posts the body, including a secret, only to the respond endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ action: card, replayed: false, result: { target_type: 'provider', name: 'openai', connected: true } }),
    );
    const result = await client(fetch).respond('ws_1', 'act/1', { secret: { api_key: 'test-api-key' } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/workspaces/ws_1/actions/act%2F1/respond`);
    expect(JSON.parse(String(init?.body))).toEqual({ secret: { api_key: 'test-api-key' } });
    expect(result.result).toMatchObject({ connected: true, name: 'openai' });
    expect(result.action.kind).toBe('secret_request');
  });
});

describe('actions', () => {
  it('drops invalid cards, strips view-only keys and keeps the result object', async () => {
    const stored = { ...card, session_key: 'agent:super-agent:s1', step_id: 'st1', agent_id: 'a1', attempt_count: 2, resolved_at: null, result: { credential_ref: 'cred:v1:provider:x', error_code: null } };
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({
        actions: [
          stored,
          { ...card, id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a12', kind: 'html' },
          { ...card, id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a13', title: '' },
          'not-an-object',
          null,
        ],
      }),
    );
    const cards = await client(fetch).actions('ws_1', { sessionKey: 'agent:super-agent:s1', status: 'pending' });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toEqual({ ...card, result: { credential_ref: 'cred:v1:provider:x', error_code: null } });
    expect(fetch.mock.calls[0]![0]).toBe(`${BASE}/workspaces/ws_1/actions?session_key=agent%3Asuper-agent%3As1&status=pending`);
  });

  it('ignores a non-object result but keeps the card', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ actions: [{ ...card, result: 'oops' }] }));
    const [only] = await client(fetch).actions('ws_1');
    expect(only).toEqual(card);
  });
});

describe('streamChat', () => {
  it('posts the request with an event-stream accept header and maps frames to chat events', async () => {
    const frames = [
      sse('chat.started', { run_id: 'r1', session_key: 'agent:super-agent:s1', agent_key: 'super-agent' }),
      sse('message.delta', { delta: 'Hel' }),
      sse('block.reply', { ignored: true }),
      sse('message.delta', { delta: 'lo' }),
      sse('message.completed', { message: { role: 'assistant', content: 'Hello', created_at: '2026-10-11T10:00:00Z' } }),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => new Response(abortableBody(init?.signal, frames, true), { status: 200 }));

    const events = await collect(client(fetch).streamChat('ws_1', { agent_key: 'super-agent', message: 'Hi' }));

    expect(events.map((e) => e.type)).toEqual(['chat.started', 'message.delta', 'message.delta', 'message.completed']);
    expect(events[1]).toEqual({ type: 'message.delta', delta: 'Hel' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/workspaces/ws_1/chat/stream`);
    expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream');
    expect(JSON.parse(String(init?.body))).toEqual({ agent_key: 'super-agent', message: 'Hi' });
  });

  it('throws the server error when the stream request is rejected', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(errorBody('run_in_progress'), 409));
    await expect(collect(client(fetch).streamChat('ws_1', { agent_key: 'a', message: 'Hi' }))).rejects.toMatchObject({
      status: 409,
      code: 'run_in_progress',
    });
  });

  it('rejects a response without a body as invalid_response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
    await expect(collect(client(fetch).streamChat('ws_1', { agent_key: 'a', message: 'Hi' }))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('reports a stream that goes quiet mid-reply as stream_stalled', async () => {
    const frames = [sse('message.delta', { delta: 'partial' })];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => new Response(abortableBody(init?.signal, frames), { status: 200 }));
    const received: ChatEvent[] = [];
    const run = async () => {
      for await (const event of client(fetch, { streamIdleMs: 30 }).streamChat('ws_1', { agent_key: 'a', message: 'Hi' })) received.push(event);
    };
    await expect(run()).rejects.toMatchObject({ code: 'stream_stalled', status: 0 });
    expect(received).toEqual([{ type: 'message.delta', delta: 'partial' }]);
  });

  it('reports a response that never arrives as stream_stalled', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    await expect(collect(client(fetch, { streamIdleMs: 20 }).streamChat('ws_1', { agent_key: 'a', message: 'Hi' }))).rejects.toMatchObject({
      code: 'stream_stalled',
    });
  });

  it('stops when the caller aborts and aborts the underlying request', async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response(abortableBody(init?.signal, [sse('message.delta', { delta: 'a' })]), { status: 200 });
    });
    const received: ChatEvent[] = [];
    const run = async () => {
      for await (const event of client(fetch).streamChat('ws_1', { agent_key: 'a', message: 'Hi' }, caller.signal)) {
        received.push(event);
        caller.abort(new DOMException('user stopped', 'AbortError'));
      }
    };
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(received).toHaveLength(1);
    expect(requestSignal?.aborted).toBe(true);
  });

  it('reports a failed connection as network_error rather than a stall', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('network down');
    });
    await expect(collect(client(fetch, { streamIdleMs: 1000 }).streamChat('ws_1', { agent_key: 'a', message: 'Hi' }))).rejects.toMatchObject({
      code: 'network_error',
    });
  });

  it('reports a body that breaks mid-reply as a lost connection (status 0), not a failed request', async () => {
    const encoder = new TextEncoder();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sse('chat.started', { run_id: 'r1', session_key: 's1', agent_key: 'a' })));
          controller.enqueue(encoder.encode(sse('message.delta', { delta: 'partial' })));
          setTimeout(() => controller.error(new TypeError('network error')), 10);
        },
      });
      return new Response(body, { status: 200 });
    });
    const received: ChatEvent[] = [];
    const run = async () => {
      for await (const event of client(fetch, { streamIdleMs: 1000 }).streamChat('ws_1', { agent_key: 'a', message: 'Hi' })) received.push(event);
    };
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeweeApiError);
    expect(error).toMatchObject({ status: 0, code: 'connection_lost', afterResponse: true });
    expect(received.map((e) => e.type)).toEqual(['chat.started', 'message.delta']);
  });

  it('marks a failure before any response as not after the response, so it can be sent again', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('network down');
    });
    const error = await collect(client(fetch).streamChat('ws_1', { agent_key: 'a', message: 'Hi' })).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'network_error', afterResponse: false });
  });

  it('marks a body that breaks before the first frame as after the response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => controller.error(new TypeError('network error')), 5);
        },
      });
      return new Response(body, { status: 200 });
    });
    const error = await collect(client(fetch, { streamIdleMs: 1000 }).streamChat('ws_1', { agent_key: 'a', message: 'Hi' })).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: 'connection_lost', afterResponse: true });
  });

  it('marks a non-network error after the response as accepted, keeping the original as the cause', async () => {
    const bug = new RangeError('decoder bug');
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => controller.error(bug), 5);
        },
      });
      return new Response(body, { status: 200 });
    });
    const error = await collect(client(fetch, { streamIdleMs: 1000 }).streamChat('ws_1', { agent_key: 'a', message: 'Hi' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeweeApiError);
    expect(error).toMatchObject({ status: 0, code: 'runtime_request_failed', afterResponse: true, cause: bug });
  });

  it('surfaces an auth adapter bug unchanged', async () => {
    const bug = new Error('adapter bug');
    const fetch = vi.fn<typeof globalThis.fetch>();
    const broken = auth({ authorization: vi.fn(async () => Promise.reject(bug)) });
    await expect(collect(client(fetch, { auth: broken }).streamChat('ws_1', { agent_key: 'a', message: 'Hi' }))).rejects.toBe(bug);
    expect(fetch).not.toHaveBeenCalled();
  });
});