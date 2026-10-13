import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  activeProfile,
  defaultSettings,
  loadSettings,
  newProfileId,
  saveSettings,
  SETTINGS_KEY,
  updateSettings,
  withoutProfile,
  withSelectedWorkspace,
  withWorkspaceSelection,
  workspaceSelectionOf,
  type Profile,
  type Settings,
} from '../../../src/shared/settings';

const cloud: Profile = { id: 'p_cloud', name: 'Cloud', kind: 'cloud', origin: 'https://app.example.test', remember: false };
const gateway: Profile = { id: 'p_gw', name: 'Gateway', kind: 'gateway', origin: 'https://gw.example.test', remember: true };

function withProfiles(profiles: Profile[], activeProfileId?: string): Settings {
  return { ...defaultSettings(), profiles, activeProfileId };
}

describe('updateSettings', () => {
  it('applies concurrent updates in order without losing either', async () => {
    await saveSettings(withProfiles([cloud]));
    await Promise.all([
      updateSettings((s) => ({ ...s, profiles: [...s.profiles, gateway] })),
      updateSettings((s) => ({ ...s, activeProfileId: gateway.id })),
    ]);
    expect(await loadSettings()).toMatchObject({ profiles: [cloud, gateway], activeProfileId: gateway.id });
  });
});

describe('loadSettings and saveSettings', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await loadSettings()).toEqual(defaultSettings());
    expect(defaultSettings()).toMatchObject({ version: 1, profiles: [], selections: {}, prefs: { theme: 'system', locale: 'auto', showReasoning: false, showToolDetails: false } });
  });

  it('falls back to the defaults when the stored value is corrupt', async () => {
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { profiles: 'not-a-list', prefs: { theme: 'neon' } } });
    expect(await loadSettings()).toEqual(defaultSettings());
  });

  it('round-trips a saved value', async () => {
    const settings: Settings = {
      ...withProfiles([cloud, gateway], 'p_gw'),
      prefs: { theme: 'dark', locale: 'vi', showReasoning: true, showToolDetails: false },
    };
    await saveSettings(settings);
    expect(await loadSettings()).toEqual(settings);
  });

  it('keeps stored theme and language and turns the display options off when an older value lacks them', async () => {
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { prefs: { theme: 'dark', locale: 'vi' } } });
    expect((await loadSettings()).prefs).toEqual({ theme: 'dark', locale: 'vi', showReasoning: false, showToolDetails: false });
  });

  it('defaults a profile without the remember flag to false', async () => {
    const { remember: _remember, ...withoutFlag } = cloud;
    await fakeBrowser.storage.local.set({ [SETTINGS_KEY]: { profiles: [withoutFlag] } });
    expect((await loadSettings()).profiles[0]?.remember).toBe(false);
  });

  it('never persists secret-looking fields on a profile', async () => {
    const leaky = { ...cloud, apiKey: 'test-api-key', accessToken: 'test-access-token' } as Profile;
    await saveSettings(withProfiles([leaky], 'p_cloud'));
    const stored = JSON.stringify(await fakeBrowser.storage.local.get(SETTINGS_KEY));
    expect(stored).not.toContain('test-api-key');
    expect(stored).not.toContain('test-access-token');
    expect(stored).not.toContain('apiKey');
  });

  it('updateSettings applies the change and returns the saved value', async () => {
    await saveSettings(withProfiles([cloud]));
    const next = await updateSettings((current) => ({ ...current, activeProfileId: 'p_cloud' }));
    expect(next.activeProfileId).toBe('p_cloud');
    expect((await loadSettings()).activeProfileId).toBe('p_cloud');
  });
});

describe('active profile and selections', () => {
  it('activeProfile falls back to the first profile when the id is unknown', () => {
    expect(activeProfile(withProfiles([cloud, gateway], 'p_gw'))?.id).toBe('p_gw');
    expect(activeProfile(withProfiles([cloud, gateway], 'missing'))?.id).toBe('p_cloud');
    expect(activeProfile(withProfiles([]))).toBeUndefined();
  });

  it('workspaceSelectionOf returns an empty selection for unknown scopes', () => {
    expect(workspaceSelectionOf(defaultSettings(), 'p_cloud', 'ws_1')).toEqual({ sessions: {} });
  });

  it('withWorkspaceSelection stores the patch under the profile and workspace only', () => {
    const base = withProfiles([cloud, gateway]);
    const next = withWorkspaceSelection(base, 'p_cloud', 'ws_1', (current) => ({
      ...current,
      agentKey: 'super-agent',
      sessions: { 'super-agent': 'agent:super-agent:app:direct:u1-1' },
    }));
    expect(workspaceSelectionOf(next, 'p_cloud', 'ws_1')).toEqual({
      agentKey: 'super-agent',
      sessions: { 'super-agent': 'agent:super-agent:app:direct:u1-1' },
    });
    expect(workspaceSelectionOf(next, 'p_cloud', 'ws_2')).toEqual({ sessions: {} });
    expect(workspaceSelectionOf(next, 'p_gw', 'ws_1')).toEqual({ sessions: {} });
    expect(base.selections).toEqual({});
  });

  it('withSelectedWorkspace records the workspace per profile', () => {
    const next = withSelectedWorkspace(withProfiles([cloud]), 'p_cloud', 'ws_9');
    expect(next.selections.p_cloud?.workspaceId).toBe('ws_9');
    expect(withSelectedWorkspace(next, 'p_cloud', undefined).selections.p_cloud?.workspaceId).toBeUndefined();
  });
});

describe('withoutProfile', () => {
  const seeded = (): Settings => {
    let settings = withProfiles([cloud, gateway], 'p_cloud');
    settings = withSelectedWorkspace(settings, 'p_cloud', 'ws_1');
    settings = withWorkspaceSelection(settings, 'p_cloud', 'ws_1', (c) => ({ ...c, agentKey: 'a1' }));
    settings = withSelectedWorkspace(settings, 'p_gw', 'ws_2');
    return settings;
  };

  it('drops the profile and every remembered selection under it', () => {
    const next = withoutProfile(seeded(), 'p_cloud');
    expect(next.profiles.map((p) => p.id)).toEqual(['p_gw']);
    expect(Object.keys(next.selections)).toEqual(['p_gw']);
    expect(next.selections.p_cloud).toBeUndefined();
  });

  it('moves the active profile to the first remaining one when the active one is removed', () => {
    expect(withoutProfile(seeded(), 'p_cloud').activeProfileId).toBe('p_gw');
  });

  it('keeps the active profile when a different profile is removed', () => {
    expect(withoutProfile(seeded(), 'p_gw').activeProfileId).toBe('p_cloud');
  });

  it('clears the active profile when the last profile is removed', () => {
    expect(withoutProfile(withProfiles([cloud], 'p_cloud'), 'p_cloud').activeProfileId).toBeUndefined();
  });
});

describe('newProfileId', () => {
  it('returns a prefixed, unique identifier', () => {
    const a = newProfileId();
    expect(a).toMatch(/^p_[0-9a-f-]{36}$/);
    expect(newProfileId()).not.toBe(a);
  });
});
