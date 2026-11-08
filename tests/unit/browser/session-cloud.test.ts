import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DeweeApiError } from '@/api/errors';
import type { RelayTicket } from '@/api/schemas';
import { writeCredential } from '@/auth/credential-store';
import type { BrowserApi, TabInfo } from '@/browser/chrome-api';
import type { CloudRelayApi } from '@/browser/cloud-relay';
import { BrowserSession, policyKey } from '@/browser/session';
import { defaultSettings, saveSettings, type Profile, type Settings } from '@/shared/settings';
import { AGENT_ID, DEVICE_ID, grant, GRANT_ID, NOW, ORIGIN } from './fixtures';
import { FakeSocket, flush } from './fake-socket';

const cloud: Profile = { id: 'p_cloud', name: 'Cloud', kind: 'cloud', origin: 'https://app.example.test', remember: false };
const TAB = 7;
const KEY = 'relay-key-secret-value';

function settings(connectedBrowser = true): Settings {
  const base = defaultSettings();
  return { ...base, profiles: [cloud], activeProfileId: cloud.id, selections: { [cloud.id]: { workspaceId: 'w1', workspaces: {} } }, prefs: { ...base.prefs, connectedBrowser } };
}

function setup() {
  let clock = NOW;
  let serial = 0;
  const tabs = new Map<number, TabInfo>([[TAB, { url: `${ORIGIN}/cart`, title: 'Cart', status: 'complete', active: true }]]);
  const api: BrowserApi = {
    createTab: async () => 99,
    updateTab: async () => undefined,
    removeTab: async () => undefined,
    getTab: async (id) => tabs.get(id) ?? null,
    run: async () => ({ ok: false, code: 'internal' }),
    hasHostPermission: async () => true,
  };
  const ticket = vi.fn(async (): Promise<RelayTicket> => {
    serial += 1;
    return { key: `${KEY}-${serial}`, expires_at: new Date(clock + 10 * 60_000).toISOString(), ws_url: 'wss://relay.example.test/ws' };
  });
  const cloudApi: CloudRelayApi = { ticket, status: vi.fn(async () => ({ connected: false, can_enable: true })), enable: vi.fn(async () => true) };
  const sockets: FakeSocket[] = [];
  const session = new BrowserSession({
    api,
    action: null,
    cloud: cloudApi,
    random: () => 0.5,
    now: () => clock,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const socket = (): FakeSocket => {
    const current = sockets.at(-1);
    if (!current) throw new Error('no socket was created');
    return current;
  };
  const connect = async () => {
    await flush();
    socket().open();
    await flush();
    socket().reply(socket().last('connect'));
    await flush();
  };
  /** Shares the tab: auto-enroll, attach, then a shared-tab grant for it. */
  const share = async () => {
    const pending = session.handleRequest({ type: 'browser.share.start', tabId: TAB, agentId: AGENT_ID, agentName: 'Researcher' });
    await flush();
    socket().reply(socket().last('browser.device.enroll'), { device_id: DEVICE_ID });
    await flush();
    socket().reply(socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    const create = socket().last('browser.grant.create');
    socket().reply(create, { grant: grant({ tab: create.params.tab as string, expires_at: new Date(clock + 3_600_000).toISOString() }) });
    await expect(pending).resolves.toEqual({ ok: true });
    return create;
  };
  return { session, sockets, socket, connect, share, tabs, ticket, cloudApi, setClock: (at: number) => (clock = at) };
}

async function signedIn(scope = 'chat workspaces actions browser') {
  await writeCredential(cloud.id, { kind: 'oauth', accessToken: 'a', accessExpiresAt: NOW + 3_600_000, refreshToken: 'r', scope }, false);
}

beforeEach(async () => {
  fakeBrowser.runtime.getManifest = (() => ({ manifest_version: 3, name: 'Dewee', version: '0.1.0' })) as typeof fakeBrowser.runtime.getManifest;
  await signedIn();
  await saveSettings(settings());
});

describe('BrowserSession on Dewee Cloud', () => {
  it('asks for the policy first and connects with a relay ticket once it is accepted', async () => {
    const t = setup();
    await t.session.sync();
    expect(t.session.state()).toMatchObject({ mode: 'policy', kind: 'cloud' });
    expect(t.ticket).not.toHaveBeenCalled();

    await expect(t.session.handleRequest({ type: 'browser.policy.accept' })).resolves.toEqual({ ok: true });
    expect((await fakeBrowser.storage.local.get(policyKey(cloud.id)))[policyKey(cloud.id)]).toEqual({ accepted_at: NOW });
    await t.connect();
    expect(t.socket().url).toBe('wss://relay.example.test/ws');
    expect(t.socket().last('connect').params).toMatchObject({ token: `${KEY}-1` });
    expect(t.session.state()).toMatchObject({ mode: 'ready', connection: 'connected' });
  });

  it('never keeps the relay key in storage or panel state', async () => {
    await fakeBrowser.storage.local.set({ [policyKey(cloud.id)]: { accepted_at: NOW } });
    const t = setup();
    await t.session.sync();
    await t.connect();
    const stored = JSON.stringify([await fakeBrowser.storage.local.get(null), await fakeBrowser.storage.session.get(null), t.session.state()]);
    expect(stored).not.toContain(KEY);
  });

  it('reconnects with a fresh ticket a minute before the key expires', async () => {
    vi.useFakeTimers();
    try {
      await fakeBrowser.storage.local.set({ [policyKey(cloud.id)]: { accepted_at: NOW } });
      const t = setup();
      await t.session.sync();
      await t.connect();
      expect(t.ticket).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(9 * 60_000 - 1);
      expect(t.sockets).toHaveLength(1);
      vi.advanceTimersByTime(1);
      await flush();
      expect(t.ticket).toHaveBeenCalledTimes(2);
      expect(t.sockets).toHaveLength(2);
      await t.connect();
      expect(t.socket().last('connect').params).toMatchObject({ token: `${KEY}-2` });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the workspace switch while browser use is off, and connects once it is turned on', async () => {
    await fakeBrowser.storage.local.set({ [policyKey(cloud.id)]: { accepted_at: NOW } });
    const t = setup();
    t.ticket.mockRejectedValueOnce(new DeweeApiError(409, 'browser_disabled', 'off'));
    await t.session.sync();
    await flush();
    expect(t.sockets).toHaveLength(0);
    expect(t.session.state()).toMatchObject({ mode: 'ready', error: 'browser_disabled', connection: 'offline' });
    await expect(t.session.handleRequest({ type: 'browser.workspace.status' })).resolves.toEqual({ ok: true, workspace: { connected: false, canEnable: true } });

    await expect(t.session.handleRequest({ type: 'browser.workspace.enable' })).resolves.toMatchObject({ ok: true });
    await t.connect();
    expect(t.session.state()).toMatchObject({ connection: 'connected', error: undefined });
  });

  it('asks to sign in again when the session lacks the browser scope', async () => {
    await fakeBrowser.storage.local.set({ [policyKey(cloud.id)]: { accepted_at: NOW } });
    const t = setup();
    t.ticket.mockRejectedValueOnce(new DeweeApiError(403, 'browser_scope_required', 'scope'));
    await t.session.sync();
    await flush();
    expect(t.session.state().error).toBe('browser_scope_required');
    expect(t.sockets).toHaveLength(0);
  });

  describe('shared tab', () => {
    async function shared() {
      await fakeBrowser.storage.local.set({ [policyKey(cloud.id)]: { accepted_at: NOW } });
      const t = setup();
      await t.session.sync();
      await t.connect();
      const create = await t.share();
      return { t, create };
    }

    it('registers the browser and creates a one-tab, one-origin grant for at most an hour', async () => {
      const { t, create } = await shared();
      expect(t.socket().last('browser.device.enroll').params).toMatchObject({ name: expect.stringMatching(/^Chrome on /) });
      expect(create.params).toEqual({ device_id: DEVICE_ID, agent_ids: [AGENT_ID], origins: [ORIGIN], capabilities: ['browser.read', 'browser.control'], ttl_seconds: 3600, tab: 't1' });
      expect(t.session.state().shares).toEqual([{ grantId: GRANT_ID, tabId: TAB, agentName: 'Researcher', domain: 'shop.example.test', expiresAt: expect.any(String) }]);
      expect(t.session.state().tabs).toEqual([]);
    });

    it('ends when the tab closes, and revokes the grant on the Gateway', async () => {
      const { t } = await shared();
      t.session.onTabRemoved(TAB);
      await flush();
      expect(t.socket().last('browser.grant.revoke').params).toEqual({ grant_id: GRANT_ID });
      expect(t.session.state()).toMatchObject({ shares: [], grants: [] });
    });

    it('ends when the tab goes to another site', async () => {
      const { t } = await shared();
      t.session.onTabUpdated(TAB, { status: 'loading', url: `${ORIGIN}/checkout` });
      await flush();
      expect(t.session.state().shares).toHaveLength(1);
      // Chrome hides the URL of a site without access: that counts as leaving too.
      t.tabs.set(TAB, { url: undefined, status: 'loading', active: true });
      t.session.onTabUpdated(TAB, { status: 'loading' });
      await flush();
      expect(t.socket().methods()).toContain('browser.grant.revoke');
      expect(t.session.state().shares).toEqual([]);
    });

    it('ends when the grant expires', async () => {
      vi.useFakeTimers();
      try {
        const { t } = await shared();
        t.setClock(NOW + 3_600_000);
        vi.advanceTimersByTime(3_600_000 + 100);
        await flush();
        expect(t.session.state()).toMatchObject({ shares: [], grants: [] });
      } finally {
        vi.useRealTimers();
      }
    });

    it('ends on Stop', async () => {
      const { t } = await shared();
      const stopped = t.session.handleRequest({ type: 'browser.share.stop', grantId: GRANT_ID });
      await flush();
      expect(t.session.state().shares).toEqual([]);
      expect(t.socket().last('browser.grant.revoke').params).toEqual({ grant_id: GRANT_ID });
      t.socket().reply(t.socket().last('browser.grant.revoke'));
      await expect(stopped).resolves.toEqual({ ok: true });
      expect(t.session.state().shares).toEqual([]);
    });

    it('is revoked on sign-out before the socket closes', async () => {
      const { t } = await shared();
      await fakeBrowser.storage.session.remove(`credential:${cloud.id}`);
      await fakeBrowser.storage.local.remove(`credential:${cloud.id}`);
      const stopping = t.session.sync({ credentialChanged: true });
      await flush();
      const revoke = t.sockets[0]!.last('browser.grant.revoke');
      t.sockets[0]!.reply(revoke);
      await stopping;
      expect(t.sockets[0]!.closed).toBe(true);
      expect(t.session.state()).toMatchObject({ mode: 'signed_out', shares: [] });
    });

    it('refuses a tab that left its origin while the grant was created', async () => {
      await fakeBrowser.storage.local.set({ [policyKey(cloud.id)]: { accepted_at: NOW } });
      const t = setup();
      await t.session.sync();
      await t.connect();
      const pending = t.session.handleRequest({ type: 'browser.share.start', tabId: TAB, agentId: AGENT_ID, agentName: 'Researcher' });
      await flush();
      t.socket().reply(t.socket().last('browser.device.enroll'), { device_id: DEVICE_ID });
      await flush();
      t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
      await flush();
      t.tabs.set(TAB, { url: 'https://elsewhere.example.test/', status: 'complete', active: true });
      t.socket().reply(t.socket().last('browser.grant.create'), { grant: grant({ tab: 't1' }) });
      await expect(pending).resolves.toEqual({ ok: false, code: 'tab_changed' });
      expect(t.socket().methods()).toContain('browser.grant.revoke');
      expect(t.session.state().shares).toEqual([]);
    });
  });
});
