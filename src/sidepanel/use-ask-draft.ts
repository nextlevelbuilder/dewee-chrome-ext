/**
 * Takes an "Ask Dewee" draft from `storage.session` for this window's side panel: the one waiting
 * when the panel opens, and any that arrive while it is open. Each draft is used once, and a stale
 * one is dropped.
 */
import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { ASK_DRAFT_KEY, ASK_DRAFT_TTL_MS, askDraftSchema, type AskDraft } from '@/protocol/ask-selection';

/** The waiting draft, and `taken(id)` to drop it once the composer holds it. */
export function useAskDraft(): { draft: AskDraft | null; taken(id: string): void } {
  const [draft, setDraft] = useState<AskDraft | null>(null);

  useEffect(() => {
    let live = true;
    // Unknown window: no draft matches, so another window's draft is never taken here.
    const windowId = browser.windows.getCurrent().then((w) => w?.id, () => undefined);
    const take = async () => {
      const raw: unknown = (await browser.storage.session.get(ASK_DRAFT_KEY))[ASK_DRAFT_KEY];
      if (raw === undefined) return;
      const parsed = askDraftSchema.safeParse(raw);
      if (parsed.success && parsed.data.windowId !== (await windowId)) return;
      await browser.storage.session.remove(ASK_DRAFT_KEY);
      if (live && parsed.success && Date.now() - parsed.data.createdAt <= ASK_DRAFT_TTL_MS) setDraft(parsed.data);
    };
    const run = () => void take().catch(() => undefined);
    run();
    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && changes[ASK_DRAFT_KEY]?.newValue !== undefined) run();
    };
    browser.storage.onChanged.addListener(listener);
    return () => {
      live = false;
      browser.storage.onChanged.removeListener(listener);
    };
  }, []);

  const taken = useCallback((id: string) => setDraft((current) => (current?.id === id ? null : current)), []);
  return { draft, taken };
}