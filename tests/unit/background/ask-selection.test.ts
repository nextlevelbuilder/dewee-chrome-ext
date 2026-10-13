import { fakeBrowser } from 'wxt/testing/fake-browser';
import { handleAskSelection, isFromWebPage, syncAskScript } from '../../../src/background/ask-selection';
import { ASK_DRAFT_KEY } from '../../../src/protocol/ask-selection';
import { saveSettings, defaultSettings } from '../../../src/shared/settings';

const registered = new Set<string>();
const chromeStub = {
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
  it('registers the page script only when the preference is on and site access is granted', async () => {
    const contains = vi.spyOn(fakeBrowser.permissions, 'contains');
    await setAsk(true);
    contains.mockResolvedValue(false as never);
    expect(await syncAskScript()).toBe(false);
    expect(registered.size).toBe(0);

    contains.mockResolvedValue(true as never);
    expect(await syncAskScript()).toBe(true);
    expect(chromeStub.scripting.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({ id: 'ask-dewee', matches: ['https://*/*'], allFrames: false })]);

    await setAsk(false);
    expect(await syncAskScript()).toBe(false);
    expect(registered.size).toBe(0);
  });
});