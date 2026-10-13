/**
 * Opt-in "Ask Dewee" on selected page text. The content script is registered only while the
 * preference is on and the person has granted site access; otherwise it is unregistered and the
 * extension runs nothing in web pages.
 */
import { browser } from 'wxt/browser';
import { ASK_DRAFT_KEY, ASK_ORIGINS, askSelectionSchema, formatAskDraft, type AskDraft } from '@/protocol/ask-selection';
import { loadSettings } from '@/shared/settings';

export const ASK_SCRIPT_ID = 'ask-dewee';
const ASK_SCRIPT_FILE = 'content-scripts/ask-dewee.js';

let syncing: Promise<unknown> = Promise.resolve();

/** Registers or removes the content script to match the preference and the granted access. Runs one at a time. */
export function syncAskScript(): Promise<boolean> {
  const run = syncing.then(async () => {
    const [settings, allowed] = await Promise.all([loadSettings(), browser.permissions.contains({ origins: ASK_ORIGINS })]);
    const wanted = settings.prefs.askOnSelection && allowed;
    const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [ASK_SCRIPT_ID] })).length > 0;
    if (wanted && !registered) {
      await chrome.scripting.registerContentScripts([{ id: ASK_SCRIPT_ID, js: [ASK_SCRIPT_FILE], matches: ASK_ORIGINS, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true }]);
    } else if (!wanted && registered) {
      await chrome.scripting.unregisterContentScripts({ ids: [ASK_SCRIPT_ID] });
    }
    return wanted;
  });
  syncing = run.catch(() => undefined);
  return run;
}

/** A message sent by a content script in a web page (not by one of this extension's own pages). */
export function isFromWebPage(sender: chrome.runtime.MessageSender): sender is chrome.runtime.MessageSender & { tab: chrome.tabs.Tab } {
  if (sender.id !== browser.runtime.id || !sender.tab || sender.frameId !== 0 || !sender.url) return false;
  return !sender.url.startsWith(browser.runtime.getURL('/'));
}

/**
 * Handles the button click from a web page. The panel must open while the click still counts as a
 * user gesture, so `sidePanel.open` runs before anything is awaited; the draft is saved after.
 * Returns false for anything that is not a valid `ask.selection` from a top-level web page.
 */
export function handleAskSelection(message: unknown, sender: chrome.runtime.MessageSender): boolean {
  if (!isFromWebPage(sender)) return false;
  const parsed = askSelectionSchema.safeParse(message);
  if (!parsed.success) return false;
  const windowId = sender.tab.windowId;
  void chrome.sidePanel.open({ windowId }).catch(() => undefined);
  void (async () => {
    // A page loaded while the feature was on keeps its script after it is turned off; ignore it then.
    if (!(await loadSettings()).prefs.askOnSelection) return;
    const draft: AskDraft = { id: crypto.randomUUID(), text: formatAskDraft({ ...parsed.data, url: sender.tab.url ?? parsed.data.url }), createdAt: Date.now(), windowId };
    await browser.storage.session.set({ [ASK_DRAFT_KEY]: draft });
  })();
  return true;
}
