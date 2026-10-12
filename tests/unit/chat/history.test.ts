import { describe, expect, it, vi } from 'vitest';
import type { DeweeClient } from '../../../src/api/dewee-client';
import type { History, HistoryMessage } from '../../../src/api/schemas';
import { fetchSessionHistory, MAX_KEPT_MESSAGES } from '../../../src/chat/history';

const msg = (i: number): HistoryMessage => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `text ${i}`, created_at: undefined });

/**
 * A server log served the way the Gateway pages it: a position cursor, and a cursor past the end
 * answers `reset` with the log length. `shrinkTo` compacts the log after the first length probe.
 */
function serverLog(total: number, opts: { shrinkTo?: number; noLength?: boolean } = {}) {
  let length = total;
  let probes = 0;
  return vi.fn(async (_ws: string, body: { cursor?: string; limit?: number }): Promise<History> => {
    const cursor = Number(body.cursor ?? 0);
    const limit = body.limit ?? 50;
    if (cursor > length) {
      probes += 1;
      if (opts.noLength) return { session_key: 's', cursor: String(cursor), next_cursor: String(cursor), reset: false, messages: [] };
      return { session_key: 's', cursor: String(cursor), next_cursor: String(length), reset: true, messages: [] };
    }
    if (probes === 1 && opts.shrinkTo !== undefined) {
      // Compaction lands between the probe and the follow.
      probes += 1;
      length = opts.shrinkTo;
      if (cursor > length) return { session_key: 's', cursor: String(cursor), next_cursor: String(length), reset: true, messages: [] };
    }
    const end = Math.min(cursor + limit, length);
    return { session_key: 's', cursor: String(cursor), next_cursor: String(end), reset: false, messages: Array.from({ length: end - cursor }, (_, i) => msg(cursor + i)) };
  });
}

const clientWith = (history: ReturnType<typeof serverLog>) => ({ history }) as unknown as DeweeClient;
const cursors = (history: ReturnType<typeof serverLog>) => history.mock.calls.map((c) => c[1].cursor);

describe('fetchSessionHistory', () => {
  it('measures the log, then follows it to the end, oldest first', async () => {
    const history = serverLog(450);
    const messages = await fetchSessionHistory(clientWith(history), 'ws', 's');
    expect(messages).toHaveLength(450);
    expect(messages[0]?.id).toBe('m0');
    expect(messages.at(-1)?.id).toBe('m449');
    expect(cursors(history)).toEqual(['999999999', '0', '200', '400']);
  });

  it('needs one page after the probe for a short session', async () => {
    const history = serverLog(3);
    expect(await fetchSessionHistory(clientWith(history), 'ws', 's')).toHaveLength(3);
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('reads only the newest messages of a very long session', async () => {
    const total = MAX_KEPT_MESSAGES * 6 + 37;
    const history = serverLog(total);
    const messages = await fetchSessionHistory(clientWith(history), 'ws', 's');
    expect(messages).toHaveLength(MAX_KEPT_MESSAGES);
    expect(messages[0]?.id).toBe(`m${total - MAX_KEPT_MESSAGES}`);
    expect(messages.at(-1)?.id).toBe(`m${total - 1}`);
    expect(history).toHaveBeenCalledTimes(1 + MAX_KEPT_MESSAGES / 200 + 1);
  });

  it('measures again when the log shrinks during the follow', async () => {
    const history = serverLog(MAX_KEPT_MESSAGES + 500, { shrinkTo: 120 });
    const messages = await fetchSessionHistory(clientWith(history), 'ws', 's');
    expect(messages).toHaveLength(120);
    expect(new Set(messages.map((m) => m.id)).size).toBe(120);
  });

  it('fails instead of answering an empty history when the log keeps shrinking', async () => {
    // Every follow lands past the end, as if compaction ran again after each length probe.
    const history = vi.fn(async (_ws: string, body: { cursor?: string }): Promise<History> => ({
      session_key: 's',
      cursor: body.cursor,
      next_cursor: '0',
      reset: true,
      messages: [],
    }));
    const probing = vi.fn(async (ws: string, body: { cursor?: string }) =>
      body.cursor === '999999999' ? { session_key: 's', cursor: body.cursor, next_cursor: String(MAX_KEPT_MESSAGES + 10), reset: true, messages: [] } : history(ws, body),
    );
    await expect(fetchSessionHistory({ history: probing } as unknown as DeweeClient, 'ws', 's')).rejects.toMatchObject({ code: 'history_changed' });
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('reads from the start when the server does not report the length', async () => {
    const history = serverLog(250, { noLength: true });
    const messages = await fetchSessionHistory(clientWith(history), 'ws', 's');
    expect(messages).toHaveLength(250);
    expect(cursors(history).slice(1)).toEqual(['0', '200']);
  });
});
