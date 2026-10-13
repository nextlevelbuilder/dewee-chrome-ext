import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleAskSelection, isFromExtensionPage, isFromWebPage, syncAskScript } from '../../../src/background/ask-selection';
import { ASK_DRAFT_KEY } from '../../../src/protocol/ask-selection';
import { saveSettings, defaultSettings } from '../../../src/shared/settings';

const registered = new Set<string>();
const setAccessLevel = vi.fn(async () => {});
const chromeStub = {
  storage: { local: { setAccessLevel } },
  sidePanel: { open: vi.fn(async () => {}) },
  scripting: {
    getRegisteredContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => ids.filter((id) => registered.has(id)).map((id) => ({ id }))),
    registerContentScripts: vi.fn(async (scripts: { id: string }[]) => scripts.forEach((s) => registered.add(s.id))),
    unregisterContentScripts: vi.fn(async ({ ids }: { ids: string[] }) => ids.forEach((id) => registered.delete(id))),
  },
};

async function setAsk(on: boolean) {
  const settings = defaultSettings();
  await saveSettings({ ...settings, prefs: { ...settings.prefs, askOnSelection: on } });
}

const tab = { id: 7, windowId: 3, url: 'https://example.com/page?token=abc' } as chrome.tabs.Tab;
const pageSender = (patch: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({ id: fakeBrowser.runtime.id, tab, frameId: 0, url: tab.url, ...patch });
const message = { type: 'ask.selection', text: 'Selected words', url: 'https://example.com/page', title: 'Example' };

beforeEach(() => {
  registered.clear();
  vi.clearAllMocks();
  vi.stubGlobal('chrome', chromeStub);
});
afterEach(() => vi.unstubAllGlobals());

describe('isFromWebPage', () => {
  it('accepts only this extension’s content script in a top-level web page', () => {
    expect(isFromWebPage(pageSender())).toBe(true);
    expect(isFromWebPage(pageSender({ id: 'other-extension' }))).toBe(false);
    expect(isFromWebPage(pageSender({ frameId: 2 }))).toBe(false);
    expect(isFromWebPage(pageSender({ tab: undefined }))).toBe(false);
    expect(isFromWebPage(pageSender({ url: fakeBrowser.runtime.getURL('/options.html') }))).toBe(false);
    // Chrome's frame type wins over the id, which stays non-zero for an activated prerendered page.
    expect(isFromWebPage(pageSender({ frameId: 5, frameType: 'outermost_frame' } as Partial<chrome.runtime.MessageSender>))).toBe(true);
    expect(isFromWebPage(pageSender({ frameId: 0, frameType: 'sub_frame' } as Partial<chrome.runtime.MessageSender>))).toBe(false);
  });
});

describe('isFromExtensionPage', () => {
  it('accepts only this extension’s own pages, never a content script in a web page or frame', () => {
    expect(isFromExtensionPage({ id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL('/sidepanel.html') })).toBe(true);
    expect(isFromExtensionPage(pageSender())).toBe(false);
    expect(isFromExtensionPage(pageSender({ frameId: 3, url: 'https://ads.example.net/frame' }))).toBe(false);
    expect(isFromExtensionPage({ id: 'other-extension', url: fakeBrowser.runtime.getURL('/sidepanel.html') })).toBe(false);
  });
});

describe('handleAskSelection', () => {
  it('opens the side panel before awaiting anything, then stores the draft for that window', async () => {
    await setAsk(true);
    expect(handleAskSelection(message, pageSender())).toBe(true);
    expect(chromeStub.sidePanel.open).toHaveBeenCalledWith({ windowId: 3 });

    await vi.waitFor(async () => expect((await fakeBrowser.storage.session.get(ASK_DRAFT_KEY))[ASK_DRAFT_KEY]).toBeDefined());
    const draft = (await fakeBrowser.storage.session.get(ASK_DRAFT_KEY))[ASK_DRAFT_KEY] as { text: string; windowId: number };
    expect(draft.windowId).toBe(3);
    expect(draft.text).toBe('> Selected words\n\nSource: Example — https://example.com/page\n\n');
  });

  it('opens nothing and stores nothing for an invalid message or an extension page', async () => {
    await setAsk(true);
    expect(handleAskSelection({ ...message, type: 'auth.signOut' }, pageSender())).toBe(false);
    expect(handleAskSelection(message, pageSender({ url: fakeBrowser.runtime.getURL('/sidepanel.html') }))).toBe(false);
    expect(chromeStub.sidePanel.open).not.toHaveBeenCalled();
  });

  it('stores no draft once the feature is turned off, even from a page that still has the script', async () => {
    await setAsk(false);
    handleAskSelection(message, pageSender());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await fakeBrowser.storage.session.get(ASK_DRAFT_KEY)).toEqual({});
  });
});

describe('syncAskScript', () => {
  // Runs first: once storage.local is locked, the module remembers it.
  it('keeps the page script off while storage.local cannot be limited to extension pages', async () => {
    vi.spyOn(fakeBrowser.permissions, 'contains').mockResolvedValue(true as never);
    await setAsk(true);
    setAccessLevel.mockRejectedValueOnce(new Error('unsupported'));
    expect(await syncAskScript()).toBe(false);
    expect(registered.size).toBe(0);
    expect(await syncAskScript()).toBe(true);
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
  });

  it('registers the page script only when the preference is on and site access is granted', async () => {
    const contains = vi.spyOn(fakeBrowser.permissions, 'contains');
    await setAsk(true);
    contains.mockResolvedValue(false as never);
    expect(await syncAskScript()).toBe(false);
    expect(registered.size).toBe(0);

    contains.mockResolvedValue(true as never);
    expect(await syncAskScript()).toBe(true);
    expect(chromeStub.scripting.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({ id: 'ask-dewee', matches: ['https://*/*'], allFrames: false, persistAcrossSessions: false })]);

    await setAsk(false);
    expect(await syncAskScript()).toBe(false);
    expect(registered.size).toBe(0);
  });
});

describe('a page script left over after the feature is turned off', () => {
  it('opens no panel once the worker knows the script is off', async () => {
    vi.spyOn(fakeBrowser.permissions, 'contains').mockResolvedValue(true as never);
    await setAsk(false);
    expect(await syncAskScript()).toBe(false);
    expect(handleAskSelection(message, pageSender())).toBe(false);
    expect(chromeStub.sidePanel.open).not.toHaveBeenCalled();
  });
});