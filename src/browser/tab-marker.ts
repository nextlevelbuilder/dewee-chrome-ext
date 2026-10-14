/**
 * Marks the tabs an agent controls: the toolbar icon shows a badge on those tabs only, and its
 * tooltip says who controls the tab. Per-tab values are cleared when the agent lets go, so the
 * icon falls back to its normal state (and to the pending-requests badge, which is global).
 *
 * Only the action API is used: nothing is injected into the page for this.
 */
import type { LocalePref } from '@/shared/settings';

export interface ActionApi {
  setBadgeText(details: { tabId: number; text: string | null }): Promise<void>;
  setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void>;
  setTitle(details: { tabId: number; title: string }): Promise<void>;
}

export const MARKER_TEXT = 'AI';
export const MARKER_COLOR = '#7c3aed';

/** Vietnamese when chosen in Settings, or when "auto" and the browser language is Vietnamese. */
export function prefersVietnamese(pref: LocalePref, browserLanguage = typeof navigator === 'undefined' ? 'en' : navigator.language): boolean {
  return pref === 'vi' || (pref === 'auto' && browserLanguage.toLowerCase().startsWith('vi'));
}

/** The tooltip (vi or en). The side panel's i18n module is React-bound, so it is not loaded in the worker. */
export function markerTitle(agentName: string, vi: boolean): string {
  const who = agentName.trim() || (vi ? 'Một agent' : 'An agent');
  return vi ? `Dewee: ${who} đang điều khiển tab này` : `Dewee: ${who} is controlling this tab`;
}

export class TabMarker {
  private readonly marked = new Map<number, string>();

  constructor(
    private readonly action: ActionApi,
    private readonly defaultTitle: string,
    private readonly vietnamese: () => boolean,
  ) {}

  /** Makes the marked set exactly `tabs` (tab id → agent name). Errors (a tab that just closed) are ignored. */
  sync(tabs: Map<number, string>): void {
    for (const [tabId] of this.marked) if (!tabs.has(tabId)) this.clear(tabId);
    for (const [tabId, agent] of tabs) {
      if (this.marked.get(tabId) === agent) continue;
      this.marked.set(tabId, agent);
      void this.action.setBadgeText({ tabId, text: MARKER_TEXT }).catch(() => undefined);
      void this.action.setBadgeBackgroundColor({ tabId, color: MARKER_COLOR }).catch(() => undefined);
      void this.action.setTitle({ tabId, title: markerTitle(agent, this.vietnamese()) }).catch(() => undefined);
    }
  }

  private clear(tabId: number): void {
    this.marked.delete(tabId);
    // null resets the tab to the global badge text.
    void this.action.setBadgeText({ tabId, text: null }).catch(() => undefined);
    void this.action.setTitle({ tabId, title: this.defaultTitle }).catch(() => undefined);
  }
}
