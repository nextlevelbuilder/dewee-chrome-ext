import type { RawSseFrame } from '../../../src/protocol/chat-events';
import { MAX_SSE_PENDING, readSseFrames, SseParser, SseProtocolError } from '../../../src/protocol/sse-reader';

describe('SseParser', () => {
  it('parses frames split across chunks with mixed line endings', () => {
    const parser = new SseParser();
    expect(parser.push('event: message.delta\r\nda')).toEqual([]);
    expect(parser.push('ta: {"delta":"a"}\r\n\r\n: keepalive\n\nevent: chat.stopped\ndata: {}\n')).toEqual([
      { event: 'message.delta', data: '{"delta":"a"}' },
    ]);
    expect(parser.push('\n')).toEqual([{ event: 'chat.stopped', data: '{}' }]);
  });

  it('joins multi-line data', () => {
    expect(new SseParser().push('data: a\ndata: b\n\n')).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('caps the default at 1 Mi characters', () => {
    expect(MAX_SSE_PENDING).toBe(1024 * 1024);
  });

  it('stops an endless line fed in chunks at the cap, holding no more than the cap', () => {
    const parser = new SseParser();
    const chunk = 'x'.repeat(64 * 1024);
    let pushed = 0;
    let failure: unknown;
    for (let i = 0; i < 64; i++) {
      try {
        parser.push(i === 0 ? `data: ${chunk}` : chunk);
      } catch (error) {
        failure = error;
        break;
      }
      pushed += i === 0 ? chunk.length + 6 : chunk.length;
      expect(parser.pending).toBe(pushed);
      expect(parser.pending).toBeLessThanOrEqual(MAX_SSE_PENDING);
    }
    expect(failure).toBeInstanceOf(SseProtocolError);
    // The push that would pass the cap fails; nothing before it was refused.
    expect(pushed + chunk.length).toBeGreaterThan(MAX_SSE_PENDING);
    expect(pushed).toBeLessThanOrEqual(MAX_SSE_PENDING);
    // The oversized data is dropped, and the parser stays failed.
    expect(parser.pending).toBe(0);
    expect(() => parser.push('\n\n')).toThrow(SseProtocolError);
  });

  it('stops one chunk that alone holds an oversized line', () => {
    const parser = new SseParser(100);
    expect(() => parser.push(`data: ${'x'.repeat(200)}`)).toThrow(SseProtocolError);
    expect(parser.pending).toBe(0);
  });

  it('stops an event whose data lines together pass the cap, though each line is small', () => {
    const parser = new SseParser(1000);
    const line = `data: ${'y'.repeat(90)}\n`;
    let lines = 0;
    expect(() => {
      for (; lines < 20; lines++) {
        parser.push(line);
        expect(parser.pending).toBeLessThanOrEqual(1000);
      }
    }).toThrow(SseProtocolError);
    // The first line holds 90, each later one 91 with its joining newline: the 11th line (96) on top
    // of 909 passes 1000.
    expect(lines).toBe(10);
    expect(parser.pending).toBe(0);
  });

  it('stops an oversized multi-line event at the default cap', () => {
    const parser = new SseParser();
    const line = `data: ${'z'.repeat(32 * 1024)}\n`;
    expect(() => {
      for (let i = 0; i < 64; i++) parser.push(line);
    }).toThrow(SseProtocolError);
    expect(parser.pending).toBe(0);
  });

  it('parses many small events whose total passes the cap, since each is released when it ends', () => {
    const parser = new SseParser(1000);
    const frame = `event: message.delta\ndata: ${'d'.repeat(500)}\n\n`;
    for (let i = 0; i < 10; i++) expect(parser.push(frame)).toEqual([{ event: 'message.delta', data: 'd'.repeat(500) }]);
  });

  it('parses an event just below the cap split across chunks', () => {
    const max = 1000;
    const parser = new SseParser(max);
    // While the data line is read, the held event name (13) plus the whole line ("data: " + value)
    // must fit; afterwards the name plus the value.
    const value = 'v'.repeat(max - 13 - 6);
    const text = `event: message.delta\r\ndata: ${value}\r\n\r\n`;
    const frames = [];
    for (let i = 0; i < text.length; i += 97) frames.push(...parser.push(text.slice(i, i + 97)));
    expect(frames).toEqual([{ event: 'message.delta', data: value }]);
    expect(parser.pending).toBe(0);
  });

  it('refuses the same event one character over the cap', () => {
    const max = 1000;
    const parser = new SseParser(max);
    const value = 'v'.repeat(max - 13 - 5);
    expect(() => parser.push(`event: message.delta\ndata: ${value}\n\n`)).toThrow(SseProtocolError);
  });

  it('counts joined data without an extra newline', () => {
    const parser = new SseParser();
    parser.push('data: ab\ndata: cd\n');
    // "ab\ncd" is 5 code units.
    expect(parser.pending).toBe(5);
  });

  it('keeps the frames a chunk completed before an oversized line', () => {
    const parser = new SseParser(100);
    let failure: unknown;
    try {
      parser.push(`event: chat.started\ndata: {"session_key":"s1"}\n\ndata: ${'x'.repeat(200)}\n`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SseProtocolError);
    expect((failure as SseProtocolError).frames).toEqual([{ event: 'chat.started', data: '{"session_key":"s1"}' }]);
    expect(parser.pending).toBe(0);
  });

  it('stops an oversized id line', () => {
    const parser = new SseParser(100);
    expect(() => parser.push(`id: ${'i'.repeat(200)}\n`)).toThrow(SseProtocolError);
    expect(parser.pending).toBe(0);
  });

  it('counts a held id toward the cap', () => {
    const parser = new SseParser(100);
    parser.push(`id: ${'i'.repeat(90)}\n`);
    expect(parser.pending).toBe(90);
    expect(() => parser.push(`data: ${'d'.repeat(20)}`)).toThrow(SseProtocolError);
  });

  it('stops an oversized comment line', () => {
    const parser = new SseParser(100);
    expect(() => parser.push(`: ${'c'.repeat(200)}\n`)).toThrow(SseProtocolError);
    expect(parser.pending).toBe(0);
  });
});

describe('readSseFrames', () => {
  it('reads a byte stream including a trailing frame without blank line', async () => {
    const bytes = new TextEncoder().encode('event: chat.started\ndata: {"run_id":"r"}\n\nevent: chat.stopped\ndata: {}');
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 10));
        c.enqueue(bytes.slice(10));
        c.close();
      },
    });
    const frames = [];
    for await (const f of readSseFrames(body)) frames.push(f);
    expect(frames.map((f) => f.event)).toEqual(['chat.started', 'chat.stopped']);
  });

  it('stops an endless line and cancels the body', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let pulls = 0;
    let cancelled: unknown;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(chunk);
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const frames: RawSseFrame[] = [];
    const error = await (async () => {
      for await (const f of readSseFrames(body)) frames.push(f);
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SseProtocolError);
    expect(cancelled).toBe(error);
    expect(frames).toEqual([]);
    // 16 chunks fill the cap exactly; the 17th passes it. A few extra pulls are read-ahead.
    expect(pulls).toBeLessThan(20);
  });

  it('yields the frames before an oversized line in the same chunk, then fails', async () => {
    const text = `event: chat.started\ndata: {"session_key":"s1"}\n\nevent: message.completed\ndata: {}\n\ndata: ${'x'.repeat(200)}\n`;
    let cancelled: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const frames: RawSseFrame[] = [];
    const error = await (async () => {
      for await (const f of readSseFrames(body, 100)) frames.push(f);
    })().catch((e: unknown) => e);
    expect(frames.map((f) => f.event)).toEqual(['chat.started', 'message.completed']);
    expect(error).toBeInstanceOf(SseProtocolError);
    expect(cancelled).toBe(error);
  });

  it('still throws the protocol error when cancelling the body rejects', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${'x'.repeat(200)}`));
      },
      cancel() {
        throw new Error('cancel failed');
      },
    });
    const frames: RawSseFrame[] = [];
    const error = await (async () => {
      for await (const f of readSseFrames(body, 100)) frames.push(f);
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SseProtocolError);
    expect(frames).toEqual([]);
  });
});
