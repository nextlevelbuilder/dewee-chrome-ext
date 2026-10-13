/**
 * MV3 service worker. It may be suspended at any time, so it keeps no state that matters beyond
 * a single message: credentials live in `chrome.storage`, runs and cards live on the server.
 */
import { browser } from 'wxt/browser';
import { isApiError } from '@/api/errors';
import { requestSchema, type BackgroundResponse } from '@/protocol/messages';
import { SETTINGS_KEY } from '@/shared/settings';
import { handleAskSelection, isFromExtensionPage, isFromWebPage, lockLocalStorage, syncAskScript } from './ask-selection';
import { BADGE_ALARM, refreshPendingBadge } from './pending-badge';
import { authorizationFor, renewFor, signIn, signOut } from './token-manager';

async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<BackgroundResponse> {
  // Only this extension's own pages may talk to the worker; a content script carries the same id but a web URL.
  if (!isFromExtensionPage(sender)) return { ok: false, code: 'forbidden' };
  const parsed = requestSchema.safeParse(message);
  if (!parsed.success) return { ok: false, code: 'invalid_request' };
  const request = parsed.data;
  try {
    switch (request.type) {
      case 'auth.authorization':
        return { ok: true, authorization: await authorizationFor(request.profileId) };
      case 'auth.renew':
        await renewFor(request.profileId);
        return { ok: true };
      case 'auth.signIn':
        await signIn(request.profileId);
        void refreshPendingBadge();
        return { ok: true };
      case 'auth.signOut':
        await signOut(request.profileId);
        void refreshPendingBadge();
        return { ok: true };
      case 'badge.refresh':
        await refreshPendingBadge();
        return { ok: true };
    }
  } catch (error) {
    return isApiError(error) ? { ok: false, code: error.code, message: error.message, status: error.status } : { ok: false, code: 'internal_error', status: 500 };
  }
}

export function startServiceWorker(): void {
  // Open the side panel when the toolbar icon is clicked (a user gesture). Nothing runs in web pages unless
  // the person turns on "Ask Dewee" for selected text and grants site access.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // Remembered credentials live in `storage.local`; keep it out of reach of the opt-in page script.
  void lockLocalStorage();

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // A web page's content script may only send `ask.selection`; it never reaches the auth handlers.
    if (isFromWebPage(sender)) {
      handleAskSelection(message, sender);
      return false;
    }
    void handle(message, sender).then(sendResponse);
    return true;
  });

  // The page script follows the preference and the granted site access.
  const syncAsk = () => void syncAskScript().catch(() => undefined);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SETTINGS_KEY in changes) syncAsk();
  });
  browser.permissions.onAdded.addListener(syncAsk);
  browser.permissions.onRemoved.addListener(syncAsk);
  // Learn the current state in a freshly started worker, so a stale page script is ignored.
  syncAsk();

  void browser.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BADGE_ALARM) void refreshPendingBadge();
  });
  browser.runtime.onStartup.addListener(() => {
    void refreshPendingBadge();
    syncAsk();
  });
  browser.runtime.onInstalled.addListener(() => {
    void refreshPendingBadge();
    syncAsk();
  });
}
