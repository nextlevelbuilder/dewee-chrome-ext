/**
 * The Chrome calls the executor makes, behind one small interface so the executor can be tested
 * without a browser. Only `chrome.tabs`, `chrome.scripting` (with the bundled `pageRun`) and
 * `permissions.contains` are used: no `tabs` permission (URL and title are visible for origins
 * the person granted), no `debugger`, no code strings.
 */
import { browser } from 'wxt/browser';
import { originPermissionPattern } from '@/shared/origin';
import { pageRun, type PageRequest, type PageResponse } from './snapshot';

export interface TabInfo {
  url?: string;
  title?: string;
  status?: string;
  active: boolean;
}

export interface BrowserApi {
  createTab(url: string): Promise<number>;
  updateTab(tabId: number, url: string): Promise<void>;
  removeTab(tabId: number): Promise<void>;
  /** null when the tab no longer exists. */
  getTab(tabId: number): Promise<TabInfo | null>;
  run(tabId: number, request: PageRequest): Promise<PageResponse>;
  hasHostPermission(origin: string): Promise<boolean>;
}

export const chromeBrowserApi: BrowserApi = {
  async createTab(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) throw new Error('tab without id');
    return tab.id;
  },
  async updateTab(tabId, url) {
    await chrome.tabs.update(tabId, { url });
  },
  async removeTab(tabId) {
    await chrome.tabs.remove(tabId);
  },
  async getTab(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url, title: tab.title, status: tab.status, active: tab.active };
    } catch {
      return null;
    }
  },
  async run(tabId, request) {
    try {
      const [frame] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: pageRun, args: [request] });
      return (frame?.result as PageResponse | undefined) ?? { ok: false, code: 'internal' };
    } catch {
      // Chrome refuses injection into pages without host access (or restricted pages), or the tab went away.
      return { ok: false, code: 'origin_not_granted' };
    }
  },
  async hasHostPermission(origin) {
    try {
      return await browser.permissions.contains({ origins: [originPermissionPattern(origin)] });
    } catch {
      return false;
    }
  },
};
