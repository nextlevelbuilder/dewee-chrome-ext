/** In-memory WebSocket stand-in for transport and session tests. */
import type { SocketLike } from '@/browser/transport';

export interface Frame {
  type: string;
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Frame[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(JSON.parse(data) as Frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  // ---- test helpers ----
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** The server dropped the connection. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }

  reply(frame: Frame, payload: unknown = {}): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload }) });
  }

  refuse(frame: Frame, code: string, message = 'refused'): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'res', id: frame.id, ok: false, error: { code, message } }) });
  }

  event(event: string, payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'event', event, payload }) });
  }

  methods(): string[] {
    return this.sent.map((f) => f.method);
  }

  last(method: string): Frame {
    const frame = [...this.sent].reverse().find((f) => f.method === method);
    if (!frame) throw new Error(`no ${method} frame; sent: ${this.methods().join(', ')}`);
    return frame;
  }
}

/** Lets pending promise callbacks run (fake timers do not advance microtasks by themselves). */
export async function flush(times = 50): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
