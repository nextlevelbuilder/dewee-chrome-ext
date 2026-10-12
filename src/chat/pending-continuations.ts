/**
 * Card continuations not yet delivered, kept in `storage.session` so a session or agent switch, or
 * a closed panel, never loses one. Each item holds IDs only (profile, workspace, session, agent,
 * setup action), a `held` flag and the time its in-progress retries started, never a secret. Every
 * item has its own storage key, so adding or removing one is a single write that never touches
 * another item: panels in two windows cannot drop each other's items. The Gateway delivers a continuation at most once, so sending a stored one again is safe.
 */
import { browser } from 'wxt/browser';
import { z } from 'zod';
import { continuation } from '@/api/schemas';

const KEY_PREFIX = 'chat.pendingContinuation:';

/**
 * `held`: not proven delivered; it waits for "Continue" instead of being sent automatically.
 * `in_progress_since`: when (ms since epoch) the first 409 `continuation_in_progress` arrived, so a
 * reopened panel keeps the same retry window instead of starting a new one.
 */
const pendingContinuation = continuation.extend({
  profile_id: z.string().min(1),
  workspace_id: z.string().min(1),
  held: z.boolean().optional(),
  in_progress_since: z.number().int().nonnegative().optional(),
});
export type PendingContinuation = z.infer<typeof pendingContinuation>;

/** The item's identity and storage key: profile, workspace and setup action. */
export const pendingKey = (item: Pick<PendingContinuation, 'profile_id' | 'workspace_id' | 'setup_action_id'>) =>
  KEY_PREFIX + [item.profile_id, item.workspace_id, item.setup_action_id].map(encodeURIComponent).join(':');

const parse = (value: unknown): PendingContinuation | null => {
  const parsed = pendingContinuation.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export async function loadPendingContinuations(): Promise<PendingContinuation[]> {
  const all = await browser.storage.session.get(null);
  return Object.entries(all).flatMap(([key, value]) => {
    const item = key.startsWith(KEY_PREFIX) ? parse(value) : null;
    return item && pendingKey(item) === key ? [item] : [];
  });
}

export async function addPendingContinuation(item: PendingContinuation): Promise<void> {
  await browser.storage.session.set({ [pendingKey(item)]: item });
}

export async function removePendingContinuation(item: PendingContinuation): Promise<void> {
  await browser.storage.session.remove(pendingKey(item));
}

/**
 * Reports items another panel (or this one) added or removed. Returns the unsubscribe function.
 */
export function watchPendingContinuations(handlers: { added(item: PendingContinuation): void; removed(key: string): void }): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'session') return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      const item = change.newValue == null ? null : parse(change.newValue);
      if (item && pendingKey(item) === key) handlers.added(item);
      else if (change.newValue == null) handlers.removed(key);
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
