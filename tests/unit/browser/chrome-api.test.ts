import { fakeBrowser } from 'wxt/testing/fake-browser';
import { chromeBrowserApi } from '@/browser/chrome-api';

const setAccessLevel = vi.fn(async () => undefined);
const executeScript = vi.fn(async () => [{ result: { ok: true, op: 'scroll' } }]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('chrome', { storage: { local: { setAccessLevel } }, scripting: { executeScript } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('chromeBrowserApi.hasHostPermission', () => {
  it('needs site access for that exact host, not a broad pattern held for another feature', async () => {
    const getAll = vi.spyOn(fakeBrowser.permissions, 'getAll');
    // The fake browser types `getAll` as returning nothing; Chrome returns the granted patterns.
    const granted = (origins: string[]) => ({ origins, permissions: [] }) as never;
    getAll.mockResolvedValue(granted(['https://*/*']));
    expect(await chromeBrowserApi.hasHostPermission('https://shop.example.test')).toBe(false);
    getAll.mockResolvedValue(granted(['https://*/*', 'https://shop.example.test/*']));
    expect(await chromeBrowserApi.hasHostPermission('https://shop.example.test')).toBe(true);
    expect(await chromeBrowserApi.hasHostPermission('https://bank.example.test')).toBe(false);
    getAll.mockRejectedValue(new Error('unavailable'));
    expect(await chromeBrowserApi.hasHostPermission('https://shop.example.test')).toBe(false);
  });
});

describe('chromeBrowserApi.run', () => {
  // Runs first: once storage.local is locked, the module remembers it.
  it('injects nothing until storage.local is closed to page scripts', async () => {
    setAccessLevel.mockRejectedValueOnce(new Error('unsupported'));
    expect(await chromeBrowserApi.run(7, { op: 'scroll', origins: ['https://shop.example.test'], direction: 'down', amount: 'page' })).toEqual({ ok: false, code: 'internal' });
    expect(executeScript).not.toHaveBeenCalled();

    expect(await chromeBrowserApi.run(7, { op: 'scroll', origins: ['https://shop.example.test'], direction: 'down', amount: 'page' })).toEqual({ ok: true, op: 'scroll' });
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] } }));
  });

  it('reports a refused injection as origin_not_granted', async () => {
    executeScript.mockRejectedValueOnce(new Error('Cannot access contents of the page'));
    expect(await chromeBrowserApi.run(7, { op: 'watch', origins: ['https://shop.example.test'] })).toEqual({ ok: false, code: 'origin_not_granted' });
  });
});
