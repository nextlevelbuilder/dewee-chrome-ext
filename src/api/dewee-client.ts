/**
 * Typed transport for Extension API v1 (docs/api-contract.md). One client serves both modes; the
 * only difference is the base URL and the `AuthAdapter` (a static API key for self-hosted, an
 * OAuth access token with renewal for Cloud). The client holds no app state and never logs.
 */
import { z } from 'zod';
import { mapRuntimeFrame, type ChatEvent, type RawSseFrame } from '@/protocol/chat-events';
import { readSseFrames, SseProtocolError } from '@/protocol/sse-reader';
import { DeweeApiError, errorFromResponse } from './errors';
import {
  abortResponse,
  actionsResponse,
  agentsResponse,
  historyResponse,
  meResponse,
  respondResponse,
  sessionsResponse,
  statusResponse,
  workspacesResponse,
  type History,
  type RespondResult,
  type RunStatus,
} from './schemas';
import type { UiActionCard } from '@/protocol/ui-action';

export interface AuthAdapter {
  /** Value of the `Authorization` header. */
  authorization(): Promise<string>;
  /** Called once after a 401; resolves true when new credentials are ready to retry with. */
  renew?(): Promise<boolean>;
}

export interface ClientOptions {
  baseUrl: string;
  auth: AuthAdapter;
  fetch?: typeof fetch;
  /** Timeout for JSON requests. */
  timeoutMs?: number;
  /** A stream with no bytes for this long is aborted as stalled. */
  streamIdleMs?: number;
}

export interface StreamRequest {
  agent_key: string;
  message?: string;
  session_key?: string;
  setup_action_id?: string;
}

export interface RespondBody {
  response?: Record<string, unknown>;
  secret?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_STREAM_IDLE = 120_000;

export class DeweeClient {
  private readonly baseUrl: string;
  private readonly auth: AuthAdapter;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly streamIdleMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.streamIdleMs = options.streamIdleMs ?? DEFAULT_STREAM_IDLE;
  }

  me() {
    return this.json('GET', '/me', meResponse);
  }

  async workspaces() {
    return (await this.json('GET', '/workspaces', workspacesResponse)).workspaces;
  }

  agents(workspaceId: string) {
    return this.json('GET', `${ws(workspaceId)}/agents`, agentsResponse);
  }

  sessions(workspaceId: string, query: { agentKey?: string; limit?: number; offset?: number } = {}) {
    const params = new URLSearchParams();
    if (query.agentKey) params.set('agent_key', query.agentKey);
    params.set('limit', String(query.limit ?? 20));
    params.set('offset', String(query.offset ?? 0));
    return this.json('GET', `${ws(workspaceId)}/sessions?${params.toString()}`, sessionsResponse);
  }

  history(workspaceId: string, body: { session_key: string; cursor?: string; limit?: number }): Promise<History> {
    return this.json('POST', `${ws(workspaceId)}/chat/history`, historyResponse, body);
  }

  async abort(workspaceId: string, body: { session_key: string; run_id?: string; agent_key?: string }): Promise<boolean> {
    return (await this.json('POST', `${ws(workspaceId)}/chat/abort`, abortResponse, body)).aborted;
  }

  status(workspaceId: string, sessionKey: string): Promise<RunStatus> {
    return this.json('GET', `${ws(workspaceId)}/sessions/${encodeURIComponent(sessionKey)}/status`, statusResponse);
  }

  async actions(workspaceId: string, query: { sessionKey?: string; status?: string } = {}): Promise<UiActionCard[]> {
    const params = new URLSearchParams();
    if (query.sessionKey) params.set('session_key', query.sessionKey);
    if (query.status) params.set('status', query.status);
    const suffix = params.size ? `?${params.toString()}` : '';
    return (await this.json('GET', `${ws(workspaceId)}/actions${suffix}`, actionsResponse)).actions;
  }

  /**
   * Answers a card. `body.secret` is sent only here, only over this request, and is never kept
   * by the client; callers clear their own copy before awaiting.
   */
  respond(workspaceId: string, actionId: string, body: RespondBody): Promise<RespondResult> {
    return this.json('POST', `${ws(workspaceId)}/actions/${encodeURIComponent(actionId)}/respond`, respondResponse, body);
  }

  /** Streams one chat turn. Ends after a terminal event, a stall, or when `signal` aborts. */
  async *streamChat(workspaceId: string, body: StreamRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    let stalled = false;
    // Set once the server answered 200: from then on the turn is accepted and must never be resent.
    let responded = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let frames: AsyncGenerator<RawSseFrame> | undefined;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, this.streamIdleMs);
    };
    try {
      arm();
      const response = await this.send('POST', `${ws(workspaceId)}/chat/stream`, body, controller.signal, 'text/event-stream');
      responded = true;
      if (!response.body) throw new DeweeApiError(0, 'invalid_response', 'Empty stream', undefined, true);
      frames = readSseFrames(response.body);
      for (;;) {
        let next: IteratorResult<RawSseFrame>;
        try {
          next = await frames.next();
        } catch (error) {
          // Only a broken body is a lost connection (the run may still be going on the server), so
          // callers reconcile, never resend.
          if (!stalled && !signal?.aborted && isNetworkFailure(error)) {
            throw new DeweeApiError(0, 'connection_lost', 'The connection was lost', undefined, true);
          }
          throw error;
        }
        if (next.done) break;
        arm();
        const event = mapRuntimeFrame(next.value);
        if (event) yield event;
      }
    } catch (error) {
      // An oversized line or event comes only from a body the server already answered, and it stays
      // a protocol error even when the caller aborts while the body is being cancelled.
      if (error instanceof SseProtocolError) {
        throw new DeweeApiError(0, 'protocol_error', 'The reply broke the stream format', undefined, true, error);
      }
      if (stalled) throw new DeweeApiError(0, 'stream_stalled', 'The stream stopped responding', undefined, responded);
      // Any other fault after the 200 (a decoder or mapping bug) still means the server took the
      // turn: mark it so callers reconcile instead of offering a resend. The original is the cause.
      if (responded && !signal?.aborted && !(error instanceof DeweeApiError)) {
        throw new DeweeApiError(0, 'runtime_request_failed', 'The reply could not be read', undefined, true, error);
      }
      throw error;
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      controller.abort();
      // Releases the body reader when the caller stops iterating early.
      void frames?.return(undefined).catch(() => {});
    }
  }

  private async json<T extends z.ZodType>(method: string, path: string, schema: T, body?: unknown): Promise<z.output<T>> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.send(method, path, body, signal, 'application/json');
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DeweeApiError(response.status, 'invalid_response', 'The server returned an unreadable response');
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new DeweeApiError(response.status, 'invalid_response', 'The server returned an unexpected response');
    return parsed.data;
  }

  private async send(method: string, path: string, body: unknown, signal: AbortSignal, accept: string): Promise<Response> {
    let response = await this.attempt(method, path, body, signal, accept);
    if (response.status === 401 && this.auth.renew && (await this.auth.renew())) {
      response = await this.attempt(method, path, body, signal, accept);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  private async attempt(method: string, path: string, body: unknown, signal: AbortSignal, accept: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept, Authorization: await this.auth.authorization() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (error) {
      if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
        throw new DeweeApiError(0, 'timeout', 'The server did not respond in time');
      }
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new DeweeApiError(0, 'network_error', 'Could not reach the server');
    }
  }
}

/** A fetch body read fails with a TypeError (or a NetworkError DOMException) when the transport drops. */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === 'NetworkError');
}

function ws(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function gatewayBaseUrl(origin: string): string {
  return `${origin}/v1/extension`;
}

export function cloudBaseUrl(origin: string): string {
  return `${origin}/api/extension/v1`;
}
