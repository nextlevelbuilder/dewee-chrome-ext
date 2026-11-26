import { GROUP_TITLE, glowLabel, TabPresence, type PresenceApi, type PresenceTab } from '../../../src/browser/tab-presence';

function fakeApi() {
  let nextGroup = 100;
  const calls: string[] = [];
  const api: PresenceApi = {
    windowOf: vi.fn(async (tabId: number) => (tabId >= 50 ? 2 : 1)),
    group: vi.fn(async (tabIds: number[], groupId?: number) => {
      calls.push(`group ${tabIds.join(',')} ${groupId ?? 'new'}`);
      return groupId ?? nextGroup++;
    }),
    styleGroup: vi.fn(async (groupId: number, title: string) => void calls.push(`style ${groupId} ${title}`)),
    ungroup: vi.fn(async (tabIds: number[]) => void calls.push(`ungroup ${tabIds.join(',')}`)),
    glow: vi.fn(async (tabId: number, label: string | null) => void calls.push(`glow ${tabId} ${label ?? 'off'}`)),
  };
  return { api, calls };
}

const tabs = (entries: [number, PresenceTab][]) => new Map(entries);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TabPresence', () => {
  it('groups agent-opened tabs per window, frames every controlled tab, and leaves a shared tab in place', async () => {
    const { api, calls } = fakeApi();
    const presence = new TabPresence(api, () => false);
    presence.sync(tabs([[1, { agentName: 'Super Agent', shared: false }], [2, { agentName: 'Super Agent', shared: true }]]));
    await flush();
    expect(calls).toContain('glow 1 Super Agent is controlling this tab');
    expect(calls).toContain('glow 2 Super Agent is controlling this tab');
    expect(calls).toContain('group 1 new');
    expect(calls).toContain(`style 100 ${GROUP_TITLE}`);
    expect(calls.some((c) => c.startsWith('group 2'))).toBe(false);

    presence.sync(tabs([[1, { agentName: 'Super Agent', shared: false }], [2, { agentName: 'Super Agent', shared: true }], [3, { agentName: 'Super Agent', shared: false }]]));
    await flush();
    expect(calls).toContain('group 3 100');
  });

  it('removes the frame and ungroups only tabs it grouped when the agent lets go', async () => {
    const { api, calls } = fakeApi();
    const presence = new TabPresence(api, () => false);
    presence.sync(tabs([[1, { agentName: 'A', shared: false }], [2, { agentName: 'A', shared: true }]]));
    await flush();
    presence.sync(new Map());
    await flush();
    expect(calls).toContain('glow 1 off');
    expect(calls).toContain('glow 2 off');
    expect(calls).toContain('ungroup 1');
    expect(calls).not.toContain('ungroup 2');
  });

  it('redraws the frame after a page load in a controlled tab only', async () => {
    const { api, calls } = fakeApi();
    const presence = new TabPresence(api, () => true);
    presence.sync(tabs([[1, { agentName: 'Trợ lý', shared: false }]]));
    await flush();
    calls.length = 0;
    presence.onPageLoaded(1);
    presence.onPageLoaded(9);
    expect(calls).toEqual(['glow 1 Trợ lý đang điều khiển tab này']);
  });

  it('starts a new group when the person closed the old one', async () => {
    const { api, calls } = fakeApi();
    const presence = new TabPresence(api, () => false);
    presence.sync(tabs([[1, { agentName: 'A', shared: false }]]));
    await flush();
    vi.mocked(api.group).mockRejectedValueOnce(new Error('No group with id'));
    presence.sync(tabs([[1, { agentName: 'A', shared: false }], [4, { agentName: 'A', shared: false }]]));
    await flush();
    await flush();
    expect(calls).toContain('group 4 new');
    expect(calls).toContain(`style 101 ${GROUP_TITLE}`);
  });

  it('names an unnamed agent', () => {
    expect(glowLabel('', false)).toBe('An agent is controlling this tab');
  });
});
