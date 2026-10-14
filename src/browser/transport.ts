/**
 * WebSocket to the Gateway's `/ws`, owned by the service worker. It sends the `connect` frame with
 * the personal API key (read from the token manager, never handed to a page or content script),
 * correlates request/response frames, sends a heartbeat every 20 s and reconnects with
 * exponential backoff (1 s → 30 s, jittered). It never replays a request after a reconnect: a
 * request in flight when the socket drops fails with `device_offline`.
 */
import { inboundFrameSchema, methodParamsSchemas, methodResultSchemas, type EventFrame, type MethodParams, type MethodResult, type RelayMethod } from './protocol';

export const HEARTBEAT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 15_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/** The parts of `WebSocket` the transport uses, so tests can provide a fake. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export type TransportState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/** A refusal from the Gateway (`ok: false`) or a local transport failure. */
export class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

/** Gateway refusals that a reconnect cannot fix; the transport stops instead of retrying. */
const FATAL_CONNECT_CODES = new Set(['PERMISSION_DENIED', 'UNAUTHORIZED', 'UNAUTHENTICATED', 'permission_denied', 'unauthorized', 'unauthenticated']);

export interface TransportOptions {
  /** `ws://` or `wss://` URL of the gateway's `/ws`. */
  url: string;
  /** The personal API key for `connect`; read at each (re)connect, never stored by the transport. */
  token(): Promise<string>;
  version: string;
  /** Called once `connect` succeeded on a new socket (attach the device here). Throwing closes the socket. */
  onReady(): Promise<void>;
  /** Heartbeat body (needs the device id); skipped when it returns undefined. */
  heartbeat(): Promise<void> | undefined;
  onEvent(frame: EventFrame): void;
  onState(state: TransportState, detail?: { code?: string }): void;
  createSocket?: SocketFactory;
  random?: () => number;
}

interface Pending {
  resolve(payload: unknown): void;
  reject(error: RelayError): void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

export function relayUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** Delay before reconnect attempt `attempt` (0-based): base doubles from 1 s up to 30 s, then a random 50–100 %. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + (random() * base) / 2);
}

export class RelayTransport {
  private socket: SocketLike | null = null;
  private state: TransportState = 'idle';
  private nextId = 1;
  private attempt = 0;
  private readonly pending = new Map<string, Pending>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private ready = false;
  private readonly createSocket: SocketFactory;
  private readonly random: () => number;

  constructor(private readonly options: TransportOptions) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.random = options.random ?? Math.random;
  }

  get currentState(): TransportState {
    return this.state;
  }

  /** True once `connect` succeeded on the current socket. */
  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    if (this.state === 'connecting' || this.state === 'connected' || this.state === 'reconnecting') return;
    this.attempt = 0;
    this.open();
  }

  /** Closes the socket for good; pending requests fail and nothing reconnects. */
  stop(detail?: { code?: string }): void {
    clearTimeout(this.reconnectTimer);
    this.teardown('device_offline');
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.options.onState('stopped', detail);
  }

  async request<M extends RelayMethod>(method: M, params: MethodParams<M>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<MethodResult<M>> {
    const body = methodParamsSchemas[method].parse(params);
    const payload = await this.send(method, body, timeoutMs, method !== 'connect');
    const parsed = methodResultSchemas[method].safeParse(payload ?? {});
    if (!parsed.success) throw new RelayError('invalid_response', `Unexpected ${method} result`);
    return parsed.data as MethodResult<M>;
  }

  private send(method: string, params: unknown, timeoutMs: number, needReady: boolean): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || (needReady && !this.ready)) return Promise.reject(new RelayError('device_offline', 'Not connected'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError('timeout', `${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ type: 'req', id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new RelayError('device_offline', 'Send failed'));
      }
    });
  }

  private open(): void {
    clearTimeout(this.reconnectTimer);
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let socket: SocketLike;
    try {
      socket = this.createSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => void this.handshake(socket);
    socket.onmessage = (event) => this.receive(socket, event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.teardown('device_offline');
      if (this.state !== 'stopped') this.scheduleReconnect();
    };
  }

  private async handshake(socket: SocketLike): Promise<void> {
    try {
      const token = await this.options.token();
      if (this.socket !== socket) return;
      await this.send('connect', methodParamsSchemas.connect.parse({ token, client: 'dewee-chrome-ext', version: this.options.version }), REQUEST_TIMEOUT_MS, false);
      if (this.socket !== socket) return;
      this.ready = true;
      await this.options.onReady();
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setState('connected');
      this.startHeartbeat(socket);
    } catch (error) {
      if (this.socket !== socket) return;
      const code = error instanceof RelayError ? error.code : 'internal';
      if (FATAL_CONNECT_CODES.has(code)) {
        this.stop({ code: 'permission_denied' });
        return;
      }
      socket.close();
    }
  }

  private startHeartbeat(socket: SocketLike): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket) return;
      // A heartbeat that is refused or times out means the link is gone: reconnect and attach again.
      this.options.heartbeat()?.catch(() => {
        if (this.socket === socket) socket.close();
      });
    }, HEARTBEAT_MS);
  }

  private receive(socket: SocketLike, data: unknown): void {
    if (this.socket !== socket || typeof data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const frame = inboundFrameSchema.safeParse(json);
    if (!frame.success) return;
    if (frame.data.type === 'res') {
      const waiting = this.pending.get(frame.data.id);
      if (!waiting) return;
      this.pending.delete(frame.data.id);
      clearTimeout(waiting.timer);
      if (frame.data.ok) waiting.resolve(frame.data.payload);
      else waiting.reject(new RelayError(frame.data.error?.code ?? 'internal', frame.data.error?.message ?? 'Refused'));
      return;
    }
    if (this.ready) this.options.onEvent(frame.data);
  }

  private teardown(code: string): void {
    clearInterval(this.heartbeatTimer);
    this.ready = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000);
      } catch {
        // Already closed.
      }
    }
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new RelayError(code, 'Connection closed'));
      this.pending.delete(id);
    }
  }

  private scheduleReconnect(): void {
    if (this.state === 'stopped') return;
    const delay = backoffDelay(this.attempt, this.random);
    this.attempt += 1;
    this.setState('reconnecting');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private setState(state: TransportState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState(state);
  }
}
