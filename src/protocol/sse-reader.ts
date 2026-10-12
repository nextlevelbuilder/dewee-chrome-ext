import type { RawSseFrame } from './chat-events';

/**
 * Upper bound, in UTF-16 code units (JavaScript string length), for what the parser holds at once:
 * the unterminated line plus the fields of the event being built. 1 Mi code units is at most
 * 2 MiB of string memory and at least 1 MiB of UTF-8 on the wire, far above any legitimate frame
 * (respond bodies are capped at 160 KiB). Counting code units needs no re-encoding.
 */
export const MAX_SSE_PENDING = 1024 * 1024;

/** The stream broke the event-stream contract (a line or event over the cap). It is never retried. */
export class SseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseProtocolError';
  }
}

const NEWLINE = /\r\n|\r|\n/g;

/**
 * Incremental Server-Sent Events parser (WHATWG event-stream format). Feed decoded text chunks;
 * complete frames are returned as soon as their blank-line terminator arrives. Once more than
 * `MAX_SSE_PENDING` code units would be held, `push` drops what it holds and throws
 * `SseProtocolError`, and every later `push` throws too.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private dataSize = 0;
  private id: string | undefined;
  private failed = false;

  constructor(private readonly maxPending = MAX_SSE_PENDING) {}

  /** Code units currently held between pushes: the partial line and the event being built. */
  get pending(): number {
    return this.buffer.length + this.held();
  }

  push(chunk: string): RawSseFrame[] {
    if (this.failed) throw new SseProtocolError('The stream already failed');
    const frames: RawSseFrame[] = [];
    let start = 0;
    NEWLINE.lastIndex = 0;
    for (let match = NEWLINE.exec(chunk); match; match = NEWLINE.exec(chunk)) {
      const line = this.buffer + chunk.slice(start, match.index);
      this.buffer = '';
      start = match.index + match[0].length;
      this.limit(line.length);
      const frame = this.line(line);
      if (frame) frames.push(frame);
      this.limit(0);
    }
    const rest = chunk.length - start;
    this.limit(this.buffer.length + rest);
    this.buffer += chunk.slice(start);
    return frames;
  }

  private held(): number {
    return this.event.length + this.dataSize + (this.id?.length ?? 0);
  }

  /** Throws, dropping everything held, when `extra` more code units would pass the cap. */
  private limit(extra: number): void {
    if (extra + this.held() <= this.maxPending) return;
    this.failed = true;
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.dataSize = 0;
    this.id = undefined;
    throw new SseProtocolError(`An event-stream line or event exceeded ${this.maxPending} characters`);
  }

  private line(line: string): RawSseFrame | null {
    if (line === '') {
      if (this.data.length === 0 && !this.event) return null;
      const frame: RawSseFrame = { event: this.event || 'message', data: this.data.join('\n'), ...(this.id ? { id: this.id } : {}) };
      this.event = '';
      this.data = [];
      this.dataSize = 0;
      return frame;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') {
      this.data.push(value);
      // The joining newline counts too, so `dataSize` matches the joined `data` length plus one.
      this.dataSize += value.length + 1;
    } else if (field === 'id') this.id = value;
    return null;
  }
}

/**
 * Reads a fetch Response body as SSE frames until the stream ends or the signal aborts. Throws
 * `SseProtocolError` when a line or event passes the cap; the body is cancelled then.
 */
export async function* readSseFrames(body: ReadableStream<Uint8Array>, maxPending = MAX_SSE_PENDING): AsyncGenerator<RawSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(maxPending);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode() + '\n\n');
  } catch (error) {
    if (error instanceof SseProtocolError) await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
