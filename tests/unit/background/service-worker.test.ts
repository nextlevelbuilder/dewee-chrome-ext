import { fakeBrowser } from 'wxt/testing/fake-browser';
import { onRuntimeMessage } from '@/background/service-worker';
import { BrowserSession } from '@/browser/session';

const tab = { id: 7, windowId: 3, url: 'https://shop.example.test/cart' } as chrome.tabs.Tab;
const pageSender = (patch: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({ id: fakeBrowser.runtime.id, tab, frameId: 0, url: tab.url, ...patch });
const panelSender = (): chrome.runtime.MessageSender => ({ id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL('/sidepanel.html') });

beforeEach(() => {
  vi.stubGlobal('chrome', { sidePanel: { open: vi.fn(async () => undefined) } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runtime message routing', () => {
  it('never lets a web page reach the browser control handlers', async () => {
    const handled = vi.spyOn(BrowserSession.prototype, 'handleRequest').mockResolvedValue({ ok: true });
    const sendResponse = vi.fn();
    for (const message of [
      { type: 'browser.control', state: 'active' },
      { type: 'browser.approval', id: '11111111-1111-4111-8111-111111111111', approve: true },
      { type: 'browser.grant.create', agentIds: [], origins: ['https://shop.example.test'], capabilities: ['browser.control'], ttlSeconds: 3600 },
    ]) {
      expect(onRuntimeMessage(message, pageSender(), sendResponse)).toBe(false);
    }
    expect(handled).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('answers forbidden to a web subframe', async () => {
    const handled = vi.spyOn(BrowserSession.prototype, 'handleRequest').mockResolvedValue({ ok: true });
    const sendResponse = vi.fn();
    expect(onRuntimeMessage({ type: 'browser.control', state: 'active' }, pageSender({ frameId: 4, url: 'https://ads.example.net/frame' }), sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: false, code: 'forbidden' }));
    expect(handled).not.toHaveBeenCalled();
  });

  it('passes the input notice from an owned tab to the session only', () => {
    const input = vi.spyOn(BrowserSession.prototype, 'onUserInput').mockImplementation(() => undefined);
    const handled = vi.spyOn(BrowserSession.prototype, 'handleRequest');
    expect(onRuntimeMessage({ type: 'browser.userInput' }, pageSender(), vi.fn())).toBe(false);
    expect(input).toHaveBeenCalledWith(7);
    expect(handled).not.toHaveBeenCalled();
  });

  it('routes browser requests from the side panel', async () => {
    const handled = vi.spyOn(BrowserSession.prototype, 'handleRequest').mockResolvedValue({ ok: true });
    const sendResponse = vi.fn();
    expect(onRuntimeMessage({ type: 'browser.control', state: 'paused' }, panelSender(), sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    expect(handled).toHaveBeenCalledWith({ type: 'browser.control', state: 'paused' });
  });
});
