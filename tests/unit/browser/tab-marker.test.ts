import { markerTitle, prefersVietnamese, TabMarker, type ActionApi } from '@/browser/tab-marker';

function fakeAction() {
  const calls: string[] = [];
  const action: ActionApi = {
    setBadgeText: async ({ tabId, text }) => void calls.push(`text:${tabId}:${text ?? 'null'}`),
    setBadgeBackgroundColor: async ({ tabId, color }) => void calls.push(`color:${tabId}:${color}`),
    setTitle: async ({ tabId, title }) => void calls.push(`title:${tabId}:${title}`),
  };
  return { action, calls };
}

describe('TabMarker', () => {
  it('marks agent tabs and resets them when the agent lets go', () => {
    const f = fakeAction();
    const marker = new TabMarker(f.action, 'Open Dewee', () => false);
    marker.sync(new Map([[3, 'Researcher']]));
    expect(f.calls).toEqual(['text:3:AI', 'color:3:#7c3aed', 'title:3:Dewee: Researcher is controlling this tab']);
    f.calls.length = 0;
    // Nothing changed: nothing is sent again.
    marker.sync(new Map([[3, 'Researcher']]));
    expect(f.calls).toEqual([]);
    marker.sync(new Map());
    expect(f.calls).toEqual(['text:3:null', 'title:3:Open Dewee']);
  });

  it('ignores a tab that closed before the badge was set', async () => {
    const action: ActionApi = {
      setBadgeText: () => Promise.reject(new Error('No tab with id: 3')),
      setBadgeBackgroundColor: () => Promise.reject(new Error('No tab with id: 3')),
      setTitle: () => Promise.reject(new Error('No tab with id: 3')),
    };
    expect(() => new TabMarker(action, 'Open Dewee', () => false).sync(new Map([[3, '']]))).not.toThrow();
  });

  it('speaks Vietnamese when chosen, or when the browser is Vietnamese on auto', () => {
    expect(prefersVietnamese('vi', 'en-US')).toBe(true);
    expect(prefersVietnamese('auto', 'vi-VN')).toBe(true);
    expect(prefersVietnamese('auto', 'en-US')).toBe(false);
    expect(prefersVietnamese('en', 'vi-VN')).toBe(false);
    expect(markerTitle('', true)).toBe('Dewee: Một agent đang điều khiển tab này');
    expect(markerTitle('Researcher', false)).toBe('Dewee: Researcher is controlling this tab');
  });
});
