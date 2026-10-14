/**
 * MV3 service worker. It may be suspended at any time, so it keeps no state that matters beyond
 * a single message: credentials live in `chrome.storage`, runs and cards live on the server. The
 * connected-browser relay (off by default) reconnects and re-attaches when the worker starts again.
 */
import { browser } from 'wxt/browser';
import { z } from 'zod';
import { isApiError } from '@/api/errors';
import { BROWSER_PORT } from '@/browser/panel-state';
import { BROWSER_ALARM, BrowserSession } from '@/browser/session';
import { requestSchema, type BackgroundRequest, type BackgroundResponse, type BrowserRequest } from '@/protocol/messages';
import { SETTINGS_KEY } from '@/shared/settings';
import { handleAskSelection, isFromExtensionPage, isFromWebPage, lockLocalStorage, syncAskScript } from './ask-selection';
import { BADGE_ALARM, refreshPendingBadge } from './pending-badge';
import { authorizationFor, renewFor, signIn, signOut } from './token-manager';

const browserSession = new BrowserSession();
/** Sent by the bundled watcher in an owned tab when the person clicks or types there. */
const userInputSchema = z.object({ type: z.literal('browser.userInput') }).strict();

function isBrowserRequest(request: BackgroundRequest): request is BrowserRequest {
  return request.type.startsWith('browser.');
}

async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<BackgroundResponse> {
  // Only this extension's own pages may talk to the worker; a content script carries the same id but a web URL.
  if (!isFromExtensionPage(sender)) return { ok: false, code: 'forbidden' };
  const parsed = requestSchema.safeParse(message);
  if (!parsed.success) return { ok: false, code: 'invalid_request' };
  const request = parsed.data;
  if (isBrowserRequest(request)) return browserSession.handleRequest(request);
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

/**
 * Routes one `runtime.onMessage` message. A web page's content script may only send `ask.selection`
 * or the owned-tab input notice; it never reaches the auth or `browser.*` handlers. Returns true
 * when `sendResponse` will be called later.
 */
export function onRuntimeMessage(message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: BackgroundResponse) => void): boolean {
  if (isFromWebPage(sender)) {
    if (userInputSchema.safeParse(message).success) {
      if (sender.tab.id !== undefined) browserSession.onUserInput(sender.tab.id);
    } else {
      handleAskSelection(message, sender);
    }
    return false;
  }
  void handle(message, sender).then(sendResponse);
  return true;
}

export function startServiceWorker(): void {
  // Open the side panel when the toolbar icon is clicked (a user gesture). Nothing runs in web pages unless
  // the person turns on "Ask Dewee" for selected text, or grants an agent a site under "Connected browser".
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  // Remembered credentials live in `storage.local`; keep it out of reach of the opt-in page scripts.
  void lockLocalStorage();

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => onRuntimeMessage(message, sender, sendResponse));

  // The side panel follows browser control state over a port; only this extension's pages may connect.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== BROWSER_PORT || !port.sender || !isFromExtensionPage(port.sender)) {
      port.disconnect();
      return;
    }
    browserSession.connectPanel(port);
  });

  // The page script follows the preference and the granted site access.
  const syncAsk = () => void syncAskScript().catch(() => undefined);
  const syncBrowser = (credentialChanged = false) => void browserSession.sync({ credentialChanged }).catch(() => undefined);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SETTINGS_KEY in changes) {
      syncAsk();
      syncBrowser();
    }
    // Sign-in, sign-out or a new key: reconnect (or disconnect) with the profile's current credential.
    if ((area === 'local' || area === 'session') && Object.keys(changes).some((key) => key.startsWith('credential:'))) syncBrowser(true);
  });
  browser.permissions.onAdded.addListener(syncAsk);
  browser.permissions.onRemoved.addListener(syncAsk);
  browser.tabs.onRemoved.addListener((tabId) => browserSession.onTabRemoved(tabId));
  browser.tabs.onUpdated.addListener((tabId, change) => browserSession.onTabUpdated(tabId, change));
  // Learn the current state in a freshly started worker, so a stale page script is ignored and the relay re-attaches.
  syncAsk();
  syncBrowser();

  void browser.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  // Revives a suspended worker so the relay reconnects; the 20 s heartbeat keeps it alive while connected.
  void browser.alarms.create(BROWSER_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BADGE_ALARM) void refreshPendingBadge();
    if (alarm.name === BROWSER_ALARM) syncBrowser();
  });
  browser.runtime.onStartup.addListener(() => {
    void refreshPendingBadge();
    syncAsk();
    syncBrowser();
  });
  browser.runtime.onInstalled.addListener(() => {
    void refreshPendingBadge();
    syncAsk();
    syncBrowser();
  });
}
