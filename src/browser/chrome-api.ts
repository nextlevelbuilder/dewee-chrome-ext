/**
 * The Chrome calls the executor makes, behind one small interface so the executor can be tested
 * without a browser. The Standard page adapter lives here: `chrome.tabs`, `chrome.scripting` (with
 * the bundled `pageRun`) and `permissions.getAll`. No `tabs` permission (URL and title are visible
 * for origins the person granted), no code strings. The Advanced adapter (`adapters/cdp/`) is
 * routed in front of `run` by `engine-router.ts` when the person turned the debugger on.
 */
import { browser } from 'wxt/browser';
import { lockLocalStorage } from '@/background/ask-selection';
import { patternCoversExactHost } from '@/shared/origin';
import type { DriverRequest, DriverResponse, PageDriver } from './adapters/page-driver';
import { pageRun, type PageResponse } from './snapshot';

export interface TabInfo {
  url?: string;
  title?: string;
  status?: string;
  active: boolean;
}

export interface BrowserApi extends PageDriver {
  createTab(url: string): Promise<number>;
  updateTab(tabId: number, url: string): Promise<void>;
  removeTab(tabId: number): Promise<void>;
  /** null when the tab no longer exists. */
  getTab(tabId: number): Promise<TabInfo | null>;
  run(tabId: number, request: DriverRequest): Promise<DriverResponse>;
  hasHostPermission(origin: string): Promise<boolean>;
}

/** Runs one request through the bundled page script (the Standard adapter). */
export async function runPageScript(tabId: number, request: DriverRequest): Promise<DriverResponse> {
  // Screenshots need the debugger (Advanced adapter); the page script cannot take one.
  if (request.op === 'screenshot') return { ok: false, code: 'unsupported_capability' };
  // The page function runs in a content-script world: `storage.local` must be closed to it first.
  if (!(await lockLocalStorage())) return { ok: false, code: 'internal' };
  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: pageRun, args: [request] });
    return (frame?.result as PageResponse | undefined) ?? { ok: false, code: 'internal' };
  } catch {
    // Chrome refuses injection into pages without host access (or restricted pages), or the tab went away.
    return { ok: false, code: 'origin_not_granted' };
  }
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
  run: runPageScript,
  async hasHostPermission(origin) {
    try {
      // Not `permissions.contains`: a broad grant held for another feature (Ask Dewee's `https://*/*`)
      // would satisfy it. Connected browser needs site access granted for this exact host.
      const { origins = [] } = await browser.permissions.getAll();
      return origins.some((pattern) => patternCoversExactHost(pattern, origin));
    } catch {
      return false;
    }
  },
};
