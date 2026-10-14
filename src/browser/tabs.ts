/**
 * Tabs the agent opened under a grant ("owned tabs"). Agents see only opaque handles (`t1`, `t2`,
 * ...); raw `chrome.tabs` ids never leave the extension. Each tab has a single-writer lease, a
 * snapshot generation that moves on every navigation, and a short hold after the person uses it.
 */
import { z } from 'zod';

/** How long an owned tab stays off-limits to the agent after the person clicked or typed in it. */
export const USER_INPUT_HOLD_MS = 5_000;
const MAX_CLOSED_KEPT = 100;

export interface OwnedTab {
  handle: string;
  tabId: number;
  grantId: string;
  agentId: string;
  /** Bound to the tab's current document; bumped on navigation, reload and large DOM changes. */
  generation: number;
  closed: boolean;
}

const storedSchema = z.object({
  next: z.number().int().positive(),
  tabs: z.array(
    z.object({ handle: z.string(), tabId: z.number().int(), grantId: z.string(), agentId: z.string(), generation: z.number().int().nonnegative(), closed: z.boolean() }),
  ),
});
export type StoredTabs = z.infer<typeof storedSchema>;

export class TabRegistry {
  private next = 1;
  private readonly tabs = new Map<string, OwnedTab>();
  private readonly leases = new Set<string>();
  private readonly heldUntil = new Map<number, number>();

  add(tabId: number, grantId: string, agentId: string): OwnedTab {
    const existing = this.byTabId(tabId);
    if (existing) this.tabs.delete(existing.handle);
    const tab: OwnedTab = { handle: `t${this.next++}`, tabId, grantId, agentId, generation: 1, closed: false };
    this.tabs.set(tab.handle, tab);
    return tab;
  }

  get(handle: string): OwnedTab | undefined {
    return this.tabs.get(handle);
  }

  byTabId(tabId: number): OwnedTab | undefined {
    for (const tab of this.tabs.values()) if (tab.tabId === tabId && !tab.closed) return tab;
    return undefined;
  }

  /** Open tabs owned under one grant, in the order they were opened. */
  ownedBy(grantId: string): OwnedTab[] {
    return [...this.tabs.values()].filter((tab) => tab.grantId === grantId && !tab.closed);
  }

  all(): OwnedTab[] {
    return [...this.tabs.values()].filter((tab) => !tab.closed);
  }

  /** Keeps the handle so later commands get `tab_closed` instead of `tab_not_owned`. */
  markClosed(tabId: number): OwnedTab | undefined {
    const tab = this.byTabId(tabId);
    if (!tab) return undefined;
    tab.closed = true;
    this.leases.delete(tab.handle);
    this.heldUntil.delete(tabId);
    const closed = [...this.tabs.values()].filter((t) => t.closed);
    for (const old of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_KEPT))) this.tabs.delete(old.handle);
    return tab;
  }

  /** A navigation or reload started (or the page changed a lot): refs from older snapshots become stale. */
  bump(tabId: number): void {
    const tab = this.byTabId(tabId);
    if (tab) tab.generation += 1;
  }

  /** Drops tabs owned under a grant (revoked or expired). The tabs stay open for the person. */
  releaseGrant(grantId: string): OwnedTab[] {
    const released = [...this.tabs.values()].filter((tab) => tab.grantId === grantId);
    for (const tab of released) {
      this.tabs.delete(tab.handle);
      this.leases.delete(tab.handle);
    }
    return released;
  }

  /** Forgets every owned tab. Handles are never reused, so an old handle cannot point at a new tab. */
  clear(): void {
    this.tabs.clear();
    this.leases.clear();
    this.heldUntil.clear();
  }

  /** Single writer per tab: false when another command holds the tab. */
  lease(handle: string): boolean {
    if (this.leases.has(handle)) return false;
    this.leases.add(handle);
    return true;
  }

  release(handle: string): void {
    this.leases.delete(handle);
  }

  noteUserInput(tabId: number, now: number): OwnedTab | undefined {
    const tab = this.byTabId(tabId);
    if (tab) this.heldUntil.set(tabId, now + USER_INPUT_HOLD_MS);
    return tab;
  }

  /** True while the person recently used the tab; the agent waits (`busy`). */
  isHeldByUser(tabId: number, now: number): boolean {
    return (this.heldUntil.get(tabId) ?? 0) > now;
  }

  serialize(): StoredTabs {
    return { next: this.next, tabs: [...this.tabs.values()].map((tab) => ({ ...tab })) };
  }

  restore(value: unknown): void {
    const parsed = storedSchema.safeParse(value);
    if (!parsed.success) return;
    this.clear();
    this.next = parsed.data.next;
    for (const tab of parsed.data.tabs) this.tabs.set(tab.handle, { ...tab });
  }
}
