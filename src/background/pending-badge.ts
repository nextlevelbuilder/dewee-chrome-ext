/**
 * Toolbar badge with the number of open cards in the selected workspace. Cards stay stored on
 * the Gateway while the panel is closed; the badge only hints that something waits. It never
 * opens the panel (that needs a user gesture).
 */
import { browser } from 'wxt/browser';
import { createClient } from '@/api/client-factory';
import { isUiActionOpen } from '@/protocol/ui-action';
import { activeProfile, loadSettings } from '@/shared/settings';
import { authorizationFor, renewFor } from './token-manager';

export const BADGE_ALARM = 'pending-actions';

export async function setBadgeCount(count: number): Promise<void> {
  await browser.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : '' });
  if (count > 0) await browser.action.setBadgeBackgroundColor({ color: '#1f2bff' });
}

export async function refreshPendingBadge(fetchImpl: typeof fetch = fetch): Promise<number> {
  const settings = await loadSettings();
  const profile = activeProfile(settings);
  const workspaceId = profile ? settings.selections[profile.id]?.workspaceId : undefined;
  if (!profile || !workspaceId) {
    await setBadgeCount(0);
    return 0;
  }
  const client = createClient(
    profile,
    {
      authorization: () => authorizationFor(profile.id, fetchImpl),
      renew: async () => {
        try {
          await renewFor(profile.id, fetchImpl);
          return true;
        } catch {
          return false;
        }
      },
    },
    fetchImpl,
  );
  try {
    const actions = await client.actions(workspaceId, { status: 'pending' });
    const count = actions.filter((action) => isUiActionOpen(action)).length;
    await setBadgeCount(count);
    return count;
  } catch {
    await setBadgeCount(0);
    return 0;
  }
}
