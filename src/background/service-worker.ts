/**
 * MV3 service worker. It may be suspended at any time, so it keeps no state that matters beyond
 * a single message: credentials live in `chrome.storage`, runs and cards live on the server.
 */
import { browser } from 'wxt/browser';
import { isApiError } from '@/api/errors';
import { requestSchema, type BackgroundResponse } from '@/protocol/messages';
import { BADGE_ALARM, refreshPendingBadge } from './pending-badge';
import { authorizationFor, renewFor, signIn, signOut } from './token-manager';

async function handle(message: unknown, senderId: string | undefined): Promise<BackgroundResponse> {
  // Only this extension's own pages may talk to the worker.
  if (senderId !== browser.runtime.id) return { ok: false, code: 'forbidden' };
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
  // Open the side panel when the toolbar icon is clicked (a user gesture); never inject into pages.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handle(message, sender.id).then(sendResponse);
    return true;
  });

  void browser.alarms.create(BADGE_ALARM, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BADGE_ALARM) void refreshPendingBadge();
  });
  browser.runtime.onStartup.addListener(() => void refreshPendingBadge());
  browser.runtime.onInstalled.addListener(() => void refreshPendingBadge());
}
