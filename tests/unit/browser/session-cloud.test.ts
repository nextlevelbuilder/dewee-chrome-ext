import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DeweeApiError } from '@/api/errors';
import type { RelayTicket } from '@/api/schemas';
import { writeCredential } from '@/auth/credential-store';
import type { BrowserApi, TabInfo } from '@/browser/chrome-api';
import type { CloudRelayApi } from '@/browser/cloud-relay';
import type { AdvancedEngine } from '@/browser/engine-router';
import type { DriverRequest, DriverResponse } from '@/browser/adapters/page-driver';
import { BrowserSession, deviceKey, grantsKey, policyKey } from '@/browser/session';
import { defaultSettings, saveSettings, type Profile, type Settings } from '@/shared/settings';
import { AGENT_ID, DEVICE_ID, grant, GRANT_ID, NOW, ORIGIN, payload } from './fixtures';
import { FakeSocket, flush } from './fake-socket';

const cloud: Profile = { id: 'p_cloud', name: 'Cloud', kind: 'cloud', origin: 'https://app.example.test', remember: false };
const TAB = 7;
const KEY = 'relay-key-secret-value';
const LEGACY_ATTACH_REJECTION = 'params must be an object with only the documented fields: json: unknown field "shared_tab_contract"';
const STANDARD_GRANT_ID = '66666666-6666-4666-8666-666666666666';
const ORPHAN_HANDLE = 's_AAAAAAAAAAAAAAAAAAAAAA';

function settings(connectedBrowser = true, workspaceId = 'w1'): Settings {
  const base = defaultSettings();
  return { ...base, profiles: [cloud], activeProfileId: cloud.id, selections: { [cloud.id]: { workspaceId, workspaces: {} } }, prefs: { ...base.prefs, connectedBrowser } };
}

function fakeAdvancedEngine(): AdvancedEngine {
  return {
    attachedTabs: [],
    prepare: async () => null,
    policy: async () => null,
    release: async () => undefined,
    forget: () => undefined,
    forceDetach: async () => undefined,
    detachAll: async () => undefined,
    isDispatching: () => false,
    run: async (_tabId: number, request: DriverRequest) => ({ ok: true, op: request.op }) as DriverResponse,
  };
}

function setup(options: { advanced?: boolean } = {}) {
  let clock = NOW;
  let serial = 0;
  const tabs = new Map<number, TabInfo>([[TAB, { url: `${ORIGIN}/cart`, title: 'Cart', status: 'complete', active: true }]]);
  const api: BrowserApi = {
    createTab: async () => 99,
    updateTab: async () => undefined,
    removeTab: async () => undefined,
    getTab: vi.fn(async (id: number) => tabs.get(id) ?? null),
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
    cdp: options.advanced ? () => fakeAdvancedEngine() : undefined,
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
  return { session, sockets, socket, connect, share, tabs, ticket, cloudApi, getTab: api.getTab as ReturnType<typeof vi.fn>, setClock: (at: number) => (clock = at) };
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

  it('does not use the self-hosted legacy attach fallback on Cloud', async () => {
    await fakeBrowser.storage.local.set({
      [policyKey(cloud.id)]: { accepted_at: NOW },
      [deviceKey(cloud.id)]: { device_id: DEVICE_ID, name: 'Chrome on Windows' },
    });
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().refuse(t.socket().last('browser.device.attach'), 'INVALID_REQUEST', LEGACY_ATTACH_REJECTION);
    await flush();
    expect(t.socket().sent.filter((frame) => frame.method === 'browser.device.attach')).toHaveLength(1);
    expect(t.socket().closed).toBe(true);
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
      t.setClock(NOW + 9 * 60_000);
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

  it('waits at least 30 s before renewing a ticket that looks expired (clock skew) and keeps the socket on a stale answer', async () => {
    vi.useFakeTimers();
    try {
      await fakeBrowser.storage.local.set({ [policyKey(cloud.id)]: { accepted_at: NOW } });
      const t = setup();
      // The local clock runs ahead of the server: the ticket already looks expired.
      t.ticket.mockImplementation(async () => ({ key: KEY, expires_at: new Date(NOW - 5_000).toISOString(), ws_url: 'wss://relay.example.test/ws' }));
      await t.session.sync();
      await t.connect();
      vi.advanceTimersByTime(29_999);
      await flush();
      expect(t.ticket).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      await flush();
      // The answer does not expire later: no reconnect, try again later.
      expect(t.ticket).toHaveBeenCalledTimes(2);
      expect(t.sockets).toHaveLength(1);
      expect(t.session.state().connection).toBe('connected');
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

  it('serializes overlapping capability reattaches and admits only after the final desired state', async () => {
    await fakeBrowser.storage.local.set({
      [policyKey(cloud.id)]: { accepted_at: NOW },
      [deviceKey(cloud.id)]: { device_id: DEVICE_ID, name: 'Chrome on Windows' },
      [grantsKey(cloud.id)]: [GRANT_ID],
    });
    const t = setup({ advanced: true });
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
    await flush();

    const enabled = t.session.handleRequest({ type: 'browser.advanced', enabled: true, fallback: false });
    await flush();
    const first = t.socket().last('browser.device.attach');
    expect(first.params.capabilities).toEqual(['standard', 'advanced']);

    const disabled = t.session.handleRequest({ type: 'browser.advanced', enabled: false, fallback: false });
    await flush();
    expect(t.socket().sent.filter((frame) => frame.method === 'browser.device.attach')).toHaveLength(2);
    t.socket().event('browser.command', payload('tabs', {}));
    await flush();
    expect(t.socket().methods()).not.toContain('browser.command.ack');

    // The stale first completion cannot admit; only then is the final desired request sent.
    t.socket().reply(first, { device_id: DEVICE_ID, grants: [grant()] });
    await flush();
    const attaches = t.socket().sent.filter((frame) => frame.method === 'browser.device.attach');
    expect(attaches).toHaveLength(3);
    const final = attaches.at(-1)!;
    expect(final.params.capabilities).toEqual(['standard']);
    t.socket().event('browser.command', payload('tabs', {}));
    await flush();
    expect(t.socket().methods()).not.toContain('browser.command.ack');

    t.socket().reply(final, { device_id: DEVICE_ID, grants: [grant()] });
    await Promise.all([enabled, disabled]);
    t.socket().event('browser.command', payload('tabs', {}));
    await flush();
    expect(t.socket().methods()).toContain('browser.command.ack');
    t.socket().reply(t.socket().last('browser.command.ack'));
    await flush();
    t.socket().reply(t.socket().last('browser.command.result'));
  });

  it('reconnects with the latest capabilities when a toggle races the initial attach', async () => {
    await fakeBrowser.storage.local.set({
      [policyKey(cloud.id)]: { accepted_at: NOW },
      [deviceKey(cloud.id)]: { device_id: DEVICE_ID, name: 'Chrome on Windows' },
      [grantsKey(cloud.id)]: [GRANT_ID],
    });
    const t = setup({ advanced: true });
    await t.session.sync();
    await t.connect();
    const stale = t.socket();

    await expect(t.session.handleRequest({ type: 'browser.advanced', enabled: true, fallback: false })).resolves.toEqual({ ok: true });
    await flush();
    expect(stale.closed).toBe(true);
    expect(t.sockets).toHaveLength(2);

    await t.connect();
    const latest = t.socket().last('browser.device.attach');
    expect(latest.params.capabilities).toEqual(['standard', 'advanced']);
    t.socket().reply(latest, { device_id: DEVICE_ID, grants: [grant()] });
    await flush();
    t.socket().event('browser.command', payload('tabs', {}));
    await flush();
    expect(t.socket().methods()).toContain('browser.command.ack');
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
      expect(create.params).toEqual({ device_id: DEVICE_ID, agent_ids: [AGENT_ID], origins: [ORIGIN], capabilities: ['browser.read', 'browser.control'], ttl_seconds: 3600, tab: expect.stringMatching(/^s_[A-Za-z0-9_-]{22}$/) });
      expect(t.session.state().shares).toEqual([{ grantId: GRANT_ID, tabId: TAB, agentName: 'Researcher', domain: 'shop.example.test', expiresAt: expect.any(String) }]);
      expect(t.session.state().tabs).toEqual([]);
    });

    it('keeps the share for the same agent and refuses another agent on the same tab', async () => {
      const { t } = await shared();
      await expect(t.session.handleRequest({ type: 'browser.share.start', tabId: TAB, agentId: AGENT_ID, agentName: 'Researcher' })).resolves.toEqual({ ok: true });
      await expect(t.session.handleRequest({ type: 'browser.share.start', tabId: TAB, agentId: '44444444-4444-4444-8444-444444444444', agentName: 'Other' })).resolves.toEqual({ ok: false, code: 'tab_in_use' });
      expect(t.session.state().shares).toHaveLength(1);
    });

    it('revokes a share that ended while the socket was down after the next attach', async () => {
      vi.useFakeTimers();
      try {
        const { t } = await shared();
        t.socket().drop();
        await t.session.handleRequest({ type: 'browser.share.stop', grantId: GRANT_ID });
        expect(t.session.state().shares).toEqual([]);
        vi.advanceTimersByTime(1_000);
        await t.connect();
        t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant({ tab: 's_offline' })] });
        await flush();
        expect(t.socket().last('browser.grant.revoke').params).toEqual({ grant_id: GRANT_ID });
      } finally {
        vi.useRealTimers();
      }
    });

    it('reconnects after a failed live revoke and reconstructs cleanup from the next attach', async () => {
      const { t, create } = await shared();
      const stopped = t.session.handleRequest({ type: 'browser.share.stop', grantId: GRANT_ID });
      await flush();
      t.socket().refuse(t.socket().last('browser.grant.revoke'), 'INTERNAL');
      await expect(stopped).resolves.toEqual({ ok: true });
      expect(t.sockets).toHaveLength(2);

      await t.connect();
      t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant({ tab: create.params.tab as string })] });
      await flush();
      const retry = t.socket().last('browser.grant.revoke');
      t.socket().reply(retry);
      await flush();
      expect(t.session.state()).toMatchObject({ connection: 'connected', shares: [] });
    });

    it('keeps a genuinely live shared grant after reconnecting', async () => {
      vi.useFakeTimers();
      try {
        const { t, create } = await shared();
        t.socket().drop();
        vi.advanceTimersByTime(1_000);
        await t.connect();
        t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant({ tab: create.params.tab as string })] });
        await flush();
        expect(t.socket().methods()).not.toContain('browser.grant.revoke');
        expect(t.session.state()).toMatchObject({ connection: 'connected', shares: [{ grantId: GRANT_ID, tabId: TAB }] });
      } finally {
        vi.useRealTimers();
      }
    });

    it('revokes a formerly live share when attach observes another current origin', async () => {
      vi.useFakeTimers();
      try {
        const { t, create } = await shared();
        t.socket().drop();
        t.tabs.set(TAB, { url: 'https://elsewhere.example.test/', status: 'complete', active: true });
        vi.advanceTimersByTime(1_000);
        await t.connect();
        t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant({ tab: create.params.tab as string })] });
        await flush();
        const revoke = t.socket().last('browser.grant.revoke');
        t.socket().reply(revoke);
        await flush();
        expect(t.session.state()).toMatchObject({ connection: 'connected', shares: [] });
      } finally {
        vi.useRealTimers();
      }
    });

    it('retains standard grants but revokes remote shared orphans before admitting commands', async () => {
      await fakeBrowser.storage.local.set({
        [policyKey(cloud.id)]: { accepted_at: NOW },
        [deviceKey(cloud.id)]: { device_id: DEVICE_ID, name: 'Chrome on Windows' },
        [grantsKey(cloud.id)]: [STANDARD_GRANT_ID, GRANT_ID],
      });
      const t = setup();
      await t.session.sync();
      await t.connect();
      t.socket().reply(t.socket().last('browser.device.attach'), {
        device_id: DEVICE_ID,
        grants: [grant({ grant_id: STANDARD_GRANT_ID, capabilities: ['browser.read'] }), grant({ tab: ORPHAN_HANDLE })],
      });
      await flush();

      t.socket().event('browser.command', payload('tabs', { tab: ORPHAN_HANDLE }, { grant_tab: ORPHAN_HANDLE, grant_origin: ORIGIN }));
      await flush();
      expect(t.socket().methods()).not.toContain('browser.command.ack');
      const revoke = t.socket().last('browser.grant.revoke');
      t.socket().reply(revoke);
      await flush();
      expect(t.session.state().grants).toEqual([expect.objectContaining({ grant_id: STANDARD_GRANT_ID })]);
      expect(t.session.state().connection).toBe('connected');
    });

    it('keeps admission closed and reconnects when orphan cleanup is refused', async () => {
      vi.useFakeTimers();
      try {
        await fakeBrowser.storage.local.set({
          [policyKey(cloud.id)]: { accepted_at: NOW },
          [deviceKey(cloud.id)]: { device_id: DEVICE_ID, name: 'Chrome on Windows' },
          [grantsKey(cloud.id)]: [GRANT_ID],
        });
        const t = setup();
        await t.session.sync();
        await t.connect();
        t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant({ tab: ORPHAN_HANDLE })] });
        await flush();
        t.socket().event('browser.command', payload('tabs', { tab: ORPHAN_HANDLE }, { grant_tab: ORPHAN_HANDLE, grant_origin: ORIGIN }));
        await flush();
        expect(t.socket().methods()).not.toContain('browser.command.ack');
        t.socket().refuse(t.socket().last('browser.grant.revoke'), 'INTERNAL');
        await flush();
        expect(t.socket().closed).toBe(true);
        vi.advanceTimersByTime(1_000);
        await flush();
        expect(t.sockets).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('bounds a workspace switch with no revoke answer and cleans the orphan when that workspace returns', async () => {
      vi.useFakeTimers();
      try {
        const { t, create } = await shared();
        await saveSettings(settings(true, 'w2'));
        const switching = t.session.sync();
        await flush();
        expect(t.socket().methods()).toContain('browser.grant.revoke');
        t.socket().event('browser.command', payload('tabs', { tab: create.params.tab }, { grant_tab: create.params.tab, grant_origin: ORIGIN }));
        await flush();
        expect(t.socket().methods()).not.toContain('browser.command.ack');
        vi.advanceTimersByTime(2_000);
        await flush();
        await switching;
        expect(t.session.state().shares).toEqual([]);

        await saveSettings(settings(true, 'w1'));
        await t.session.sync();
        await t.connect();
        t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant({ tab: create.params.tab as string })] });
        await flush();
        const cleanup = t.socket().last('browser.grant.revoke');
        t.socket().reply(cleanup);
        await flush();
        expect(t.session.state()).toMatchObject({ connection: 'connected', shares: [] });
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses a fresh random handle for every share', async () => {
      const { t, create } = await shared();
      t.tabs.set(8, { url: `${ORIGIN}/other`, status: 'complete', active: false });
      const pending = t.session.handleRequest({ type: 'browser.share.start', tabId: 8, agentId: AGENT_ID, agentName: 'Researcher' });
      await flush();
      const second = t.socket().last('browser.grant.create');
      expect(second.params.tab).not.toBe(create.params.tab);
      expect(second.params.tab).toMatch(/^s_[A-Za-z0-9_-]{22}$/);
      t.socket().refuse(second, 'INVALID_REQUEST');
      await pending;
    });

    it('does not survive a worker restart: the share is dropped and its grant revoked', async () => {
      await shared();
      // A new worker reads the same storage.
      const restarted = setup();
      await restarted.session.sync();
      await restarted.connect();
      restarted.socket().reply(restarted.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant({ tab: 's_AAAAAAAAAAAAAAAAAAAAAA' })] });
      await flush();
      restarted.socket().event('browser.command', payload('tabs', { tab: 's_AAAAAAAAAAAAAAAAAAAAAA' }, { grant_tab: 's_AAAAAAAAAAAAAAAAAAAAAA', grant_origin: ORIGIN }));
      await flush();
      expect(restarted.socket().methods()).not.toContain('browser.command.ack');
      expect(restarted.session.state().shares).toEqual([]);
      const revoke = restarted.socket().last('browser.grant.revoke');
      expect(revoke.params).toEqual({ grant_id: GRANT_ID });
      restarted.socket().reply(revoke);
      await flush();
      expect(restarted.session.state().connection).toBe('connected');
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

    it('ends a share whose tab moved to another site just as it was registered', async () => {
      await fakeBrowser.storage.local.set({ [policyKey(cloud.id)]: { accepted_at: NOW } });
      const t = setup();
      await t.session.sync();
      await t.connect();
      const page = { url: `${ORIGIN}/cart`, status: 'complete', active: true };
      t.getTab.mockResolvedValueOnce(page).mockResolvedValueOnce(page).mockResolvedValueOnce({ url: 'https://elsewhere.example.test/', status: 'loading', active: true });
      const pending = t.session.handleRequest({ type: 'browser.share.start', tabId: TAB, agentId: AGENT_ID, agentName: 'Researcher' });
      await flush();
      t.socket().reply(t.socket().last('browser.device.enroll'), { device_id: DEVICE_ID });
      await flush();
      t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
      await flush();
      const create = t.socket().last('browser.grant.create');
      t.socket().reply(create, { grant: grant({ tab: create.params.tab as string }) });
      await flush();
      t.socket().reply(t.socket().last('browser.grant.revoke'));
      await expect(pending).resolves.toEqual({ ok: false, code: 'tab_changed' });
      expect(t.session.state().shares).toEqual([]);
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
      const create = t.socket().last('browser.grant.create');
      t.socket().reply(create, { grant: grant({ tab: create.params.tab as string }) });
      await flush();
      const revoke = t.socket().last('browser.grant.revoke');
      t.socket().reply(revoke);
      await expect(pending).resolves.toEqual({ ok: false, code: 'tab_changed' });
      expect(t.session.state().shares).toEqual([]);
    });
  });
});
