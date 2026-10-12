import type { RawSseFrame } from './chat-events';

/**
 * Upper bound, in UTF-16 code units (JavaScript string length), for what the parser holds at once:
 * the unterminated line plus the fields of the event being built. 1 Mi code units is at most
 * 2 MiB of string memory and at least 1 MiB of UTF-8 on the wire, far above any legitimate frame
 * (respond bodies are capped at 160 KiB). Counting code units needs no re-encoding.
 */
export const MAX_SSE_PENDING = 1024 * 1024;

/**
 * The stream broke the event-stream contract (a line or event over the cap). It is never retried.
 * `frames` holds the frames completed earlier in the same chunk, which callers still deliver.
 */
export class SseProtocolError extends Error {
  constructor(
    message: string,
    readonly frames: readonly RawSseFrame[] = [],
  ) {
    super(message);
    this.name = 'SseProtocolError';
  }
}

const NEWLINE = /\r\n|\r|\n/g;

/**
 * Incremental Server-Sent Events parser (WHATWG event-stream format). Feed decoded text chunks;
 * complete frames are returned as soon as their blank-line terminator arrives. Once more than
 * `MAX_SSE_PENDING` code units would be held, `push` drops what it holds and throws
 * `SseProtocolError` carrying the frames that chunk completed before the overflow; every later
 * `push` throws too.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private dataSize = 0;
  private id: string | undefined;
  private failed = false;
  /** The last chunk ended with a `\r` line ending; a `\n` opening the next chunk completes that CRLF. */
  private endedWithCr = false;

  constructor(private readonly maxPending = MAX_SSE_PENDING) {}

  /** Code units currently held between pushes: the partial line and the event being built. */
  get pending(): number {
    return this.buffer.length + this.held();
  }

  push(chunk: string): RawSseFrame[] {
    if (this.failed) throw new SseProtocolError('The stream already failed');
    // Must return before `endedWithCr` is updated: an empty chunk between the `\r` and `\n` of a
    // split CRLF would otherwise clear the flag and the `\n` would end a second, empty line.
    if (chunk === '') return [];
    const frames: RawSseFrame[] = [];
    // A CRLF split across chunks is one line ending: its `\r` already ended the line.
    let start = this.endedWithCr && chunk.startsWith('\n') ? 1 : 0;
    this.endedWithCr = chunk.endsWith('\r');
    NEWLINE.lastIndex = start;
    for (let match = NEWLINE.exec(chunk); match; match = NEWLINE.exec(chunk)) {
      const line = this.buffer + chunk.slice(start, match.index);
      this.buffer = '';
      start = match.index + match[0].length;
      // A parsed line never holds more than its own length, so checking before it is enough.
      this.limit(line.length, frames);
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    const rest = chunk.length - start;
    this.limit(this.buffer.length + rest, frames);
    this.buffer += chunk.slice(start);
    return frames;
  }

  private held(): number {
    return this.event.length + this.dataSize + (this.id?.length ?? 0);
  }

  /** Throws, dropping everything held, when `extra` more code units would pass the cap. */
  private limit(extra: number, frames: RawSseFrame[]): void {
    if (extra + this.held() <= this.maxPending) return;
    this.failed = true;
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.dataSize = 0;
    this.id = undefined;
    throw new SseProtocolError(`An event-stream line or event exceeded ${this.maxPending} characters`, frames);
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
      // `dataSize` matches the joined `data` length: every line after the first adds a newline.
      this.dataSize += value.length + (this.data.length > 0 ? 1 : 0);
      this.data.push(value);
    } else if (field === 'id') this.id = value;
    return null;
  }
}

/**
 * Reads a fetch Response body as SSE frames until the stream ends or the signal aborts. When a
 * line or event passes the cap it cancels the body, yields the frames completed before the
 * overflow, then throws `SseProtocolError`.
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
    if (error instanceof SseProtocolError) {
      await reader.cancel(error).catch(() => {});
      yield* error.frames;
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}