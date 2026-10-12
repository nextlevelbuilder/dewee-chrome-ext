/**
 * Session history is a follow log: `cursor` is a message position (oldest first) and `next_cursor`
 * is the position after the last returned message. A cursor past the end answers `reset: true`
 * with `next_cursor` = the log length, so the panel asks for the length first and then follows
 * only the newest messages to the end. "Show earlier" reveals them a page at a time without
 * another request.
 */
import type { DeweeClient } from '@/api/dewee-client';
import { DeweeApiError } from '@/api/errors';
import type { HistoryMessage } from '@/api/schemas';

const PAGE_LIMIT = 200;
/** Newest messages kept in memory for one session. */
export const MAX_KEPT_MESSAGES = 1_000;
/** Bounds the follow when messages keep arriving while it reads. */
const MAX_PAGES = MAX_KEPT_MESSAGES / PAGE_LIMIT + 2;
/** Larger than any real log and within the 9-digit cursor both backends accept. */
const PROBE_CURSOR = '999999999';

async function logLength(client: DeweeClient, workspaceId: string, sessionKey: string): Promise<number> {
  const probe = await client.history(workspaceId, { session_key: sessionKey, cursor: PROBE_CURSOR, limit: 1 });
  const total = Number(probe.next_cursor);
  // A server that does not report the length is read from the start.
  return probe.reset && Number.isInteger(total) && total >= 0 ? total : 0;
}

export async function fetchSessionHistory(client: DeweeClient, workspaceId: string, sessionKey: string): Promise<HistoryMessage[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let cursor = Math.max(0, (await logLength(client, workspaceId, sessionKey)) - MAX_KEPT_MESSAGES);
    const messages: HistoryMessage[] = [];
    let shrank = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.history(workspaceId, { session_key: sessionKey, cursor: String(cursor), limit: PAGE_LIMIT });
      if (result.reset) {
        // The log shrank under us (compaction); measure it again.
        shrank = true;
        break;
      }
      messages.push(...result.messages);
      const next = Number(result.next_cursor);
      if (!Number.isInteger(next) || next - cursor < PAGE_LIMIT) break;
      cursor = next;
    }
    if (!shrank) return messages.slice(-MAX_KEPT_MESSAGES);
  }
  // Never an empty history: callers would take an unread log for an empty one.
  throw new DeweeApiError(0, 'history_changed', 'The history kept changing while it was read');
}
