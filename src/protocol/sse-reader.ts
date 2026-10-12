import type { RawSseFrame } from './chat-events';

/**
 * Incremental Server-Sent Events parser (WHATWG event-stream format). Feed decoded text chunks;
 * complete frames are returned as soon as their blank-line terminator arrives.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;

  push(chunk: string): RawSseFrame[] {
    this.buffer += chunk;
    const frames: RawSseFrame[] = [];
    let newline: number;
    while ((newline = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buffer.slice(0, newline);
      const width = this.buffer.startsWith('\r\n', newline) ? 2 : 1;
      this.buffer = this.buffer.slice(newline + width);
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private line(line: string): RawSseFrame | null {
    if (line === '') {
      if (this.data.length === 0 && !this.event) return null;
      const frame: RawSseFrame = { event: this.event || 'message', data: this.data.join('\n'), ...(this.id ? { id: this.id } : {}) };
      this.event = '';
      this.data = [];
      return frame;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
    return null;
  }
}

/** Reads a fetch Response body as SSE frames until the stream ends or the signal aborts. */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<RawSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* parser.push(decoder.decode(value, { stream: true }));
    }
    yield* parser.push(decoder.decode() + '\n\n');
  } finally {
    reader.releaseLock();
  }
}
