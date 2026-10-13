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
/** Last known state of the page script; undefined until the first sync in this worker. */
let active: boolean | undefined;
let localLocked = false;

/**
 * Limits storage.local, where remembered credentials live, to extension pages. The page script is
 * registered only once this has succeeded.
 */
export async function lockLocalStorage(): Promise<boolean> {
  if (localLocked) return true;
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    localLocked = true;
  } catch {
    // Not supported or refused: the page script stays off, and the next sync tries again.
  }
  return localLocked;
}

/** Registers or removes the content script to match the preference and the granted access. Runs one at a time. */
export function syncAskScript(): Promise<boolean> {
  const run = syncing.then(async () => {
    const [settings, allowed, locked] = await Promise.all([loadSettings(), browser.permissions.contains({ origins: ASK_ORIGINS }), lockLocalStorage()]);
    const wanted = settings.prefs.askOnSelection && allowed && locked;
    const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [ASK_SCRIPT_ID] })).length > 0;
    if (wanted && !registered) {
      await chrome.scripting.registerContentScripts([{ id: ASK_SCRIPT_ID, js: [ASK_SCRIPT_FILE], matches: ASK_ORIGINS, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true }]);
    } else if (!wanted && registered) {
      await chrome.scripting.unregisterContentScripts({ ids: [ASK_SCRIPT_ID] });
    }
    active = wanted;
    return wanted;
  });
  syncing = run.catch(() => undefined);
  return run;
}

/** A message from one of this extension's own pages (side panel, options). Only these reach the auth handlers. */
export function isFromExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === browser.runtime.id && Boolean(sender.url?.startsWith(browser.runtime.getURL('/')));
}

/** A message sent by the content script in a tab's top-level web page. */
export function isFromWebPage(sender: chrome.runtime.MessageSender): sender is chrome.runtime.MessageSender & { tab: chrome.tabs.Tab } {
  if (sender.id !== browser.runtime.id || !sender.tab || !sender.url || isFromExtensionPage(sender)) return false;
  // A prerendered page keeps a non-zero frame id after activation, so prefer the frame type when Chrome reports it.
  const { frameType } = sender as { frameType?: string };
  return frameType ? frameType === 'outermost_frame' : sender.frameId === 0;
}

/**
 * Handles the button click from a web page. The panel must open while the click still counts as a
 * user gesture, so `sidePanel.open` runs before anything is awaited; the draft is saved after.
 * Returns false for anything that is not a valid `ask.selection` from a top-level web page.
 */
export function handleAskSelection(message: unknown, sender: chrome.runtime.MessageSender): boolean {
  if (!isFromWebPage(sender)) return false;
  const parsed = askSelectionSchema.safeParse(message);
  // A page loaded while the feature was on keeps its script after it is turned off; ignore it then.
  if (!parsed.success || active === false) return false;
  const windowId = sender.tab.windowId;
  void chrome.sidePanel.open({ windowId }).catch(() => undefined);
  void (async () => {
    // The worker may have just started and not synced yet: check the preference before keeping the draft.
    if (!(await loadSettings()).prefs.askOnSelection) return;
    const draft: AskDraft = { id: crypto.randomUUID(), text: formatAskDraft({ ...parsed.data, url: sender.tab.url ?? parsed.data.url }), createdAt: Date.now(), windowId };
    await browser.storage.session.set({ [ASK_DRAFT_KEY]: draft });
  })().catch(() => undefined);
  return true;
}
