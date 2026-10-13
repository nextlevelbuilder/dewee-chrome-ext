import { readSseFrames, SseParser } from '../../../src/protocol/sse-reader';

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
});
