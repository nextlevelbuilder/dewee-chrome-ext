/**
 * Shows, outside the side panel, which tabs an agent controls:
 * - tabs an agent opened are gathered in one purple "Dewee AI" tab group per window;
 * - every controlled tab (opened or shared) gets a glowing frame with a "… is controlling this tab ·
 *   Stop" label inside the page, drawn in a closed shadow root from the extension's isolated world.
 *
 * A tab the person shared stays where they put it (it is their tab), so it only gets the frame. The
 * frame is redrawn after each page load and removed when the agent lets go. Only tabs with a live
 * grant are passed in, and the frame is injected only where the person granted site access; a
 * refused injection (no access, restricted page, closed tab) is ignored.
 */
import { pageGlow } from './page-glow';

export interface PresenceTab {
  agentName: string;
  /** The person shared this tab; the agent did not open it. */
  shared: boolean;
}

export interface PresenceApi {
  windowOf(tabId: number): Promise<number | null>;
  /** Adds tabs to groupId, or to a new group when groupId is undefined; returns the group id. */
  group(tabIds: number[], groupId?: number): Promise<number>;
  styleGroup(groupId: number, title: string): Promise<void>;
  ungroup(tabIds: number[]): Promise<void>;
  /** Runs pageGlow in the tab's isolated world. */
  glow(tabId: number, label: string | null, stopLabel: string): Promise<void>;
}

export const GROUP_TITLE = 'Dewee AI';

export function glowLabel(agentName: string, vi: boolean): string {
  const who = agentName.trim() || (vi ? 'Agent' : 'An agent');
  return vi ? `${who} đang điều khiển tab này` : `${who} is controlling this tab`;
}

export class TabPresence {
  private readonly tabs = new Map<number, PresenceTab>();
  /** Tabs this class put in a group, so only those are ungrouped later. */
  private readonly grouped = new Set<number>();
  private readonly groups = new Map<number, number>();

  constructor(
    private readonly api: PresenceApi,
    private readonly vietnamese: () => boolean,
  ) {}

  /** Makes the controlled set exactly `next`. */
  sync(next: Map<number, PresenceTab>): void {
    for (const tabId of [...this.tabs.keys()]) if (!next.has(tabId)) this.release(tabId);
    for (const [tabId, tab] of next) {
      const before = this.tabs.get(tabId);
      if (before && before.agentName === tab.agentName && before.shared === tab.shared) continue;
      this.tabs.set(tabId, tab);
      this.drawGlow(tabId);
      if (!tab.shared && !this.grouped.has(tabId)) void this.addToGroup(tabId).catch(() => undefined);
    }
  }

  /** A controlled tab finished loading a page: the old frame went with the old document. */
  onPageLoaded(tabId: number): void {
    if (this.tabs.has(tabId)) this.drawGlow(tabId);
  }

  private drawGlow(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const vi = this.vietnamese();
    void this.api.glow(tabId, glowLabel(tab.agentName, vi), vi ? 'Dừng' : 'Stop').catch(() => undefined);
  }

  private release(tabId: number): void {
    this.tabs.delete(tabId);
    void this.api.glow(tabId, null, '').catch(() => undefined);
    if (this.grouped.delete(tabId)) void this.api.ungroup([tabId]).catch(() => undefined);
  }

  private async addToGroup(tabId: number): Promise<void> {
    const windowId = await this.api.windowOf(tabId);
    if (windowId === null || !this.tabs.has(tabId)) return;
    const existing = this.groups.get(windowId);
    let groupId: number;
    try {
      groupId = await this.api.group([tabId], existing);
    } catch {
      // The group was closed or emptied by the person: start a new one.
      if (existing === undefined) throw new Error('group failed');
      groupId = await this.api.group([tabId]);
    }
    this.grouped.add(tabId);
    if (groupId !== existing) {
      this.groups.set(windowId, groupId);
      await this.api.styleGroup(groupId, GROUP_TITLE);
    }
    // Released while the group call was in flight.
    if (!this.tabs.has(tabId) && this.grouped.delete(tabId)) await this.api.ungroup([tabId]);
  }
}

/** The Chrome side of TabPresence; null outside Chrome (unit tests pass their own). */
export function chromePresenceApi(): PresenceApi | null {
  if (typeof chrome === 'undefined' || !chrome.tabs?.group || !chrome.tabGroups?.update || !chrome.scripting?.executeScript) return null;
  return {
    async windowOf(tabId) {
      try {
        return (await chrome.tabs.get(tabId)).windowId;
      } catch {
        return null;
      }
    },
    group: (tabIds, groupId) => {
      const ids = tabIds as [number, ...number[]];
      return chrome.tabs.group(groupId === undefined ? { tabIds: ids } : { tabIds: ids, groupId });
    },
    async styleGroup(groupId, title) {
      await chrome.tabGroups.update(groupId, { title, color: 'purple' });
    },
    ungroup: (tabIds) => chrome.tabs.ungroup(tabIds as [number, ...number[]]),
    async glow(tabId, label, stopLabel) {
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: pageGlow, args: [label, stopLabel] });
    },
  };
}
