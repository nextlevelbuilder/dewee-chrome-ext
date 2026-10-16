import { fakeBrowser } from 'wxt/testing/fake-browser';
import { writeCredential } from '@/auth/credential-store';
import type { BrowserApi } from '@/browser/chrome-api';
import type { Grant } from '@/browser/protocol';
import { BrowserSession, controlKey, deviceKey, grantsKey } from '@/browser/session';
import type { BrowserRequest } from '@/protocol/messages';
import { defaultSettings, saveSettings, type Profile, type Settings } from '@/shared/settings';
import { AGENT_ID, DEVICE_ID, grant, GRANT_ID, NOW, ORIGIN, OTHER_AGENT_ID, payload } from './fixtures';
import { FakeSocket, flush } from './fake-socket';

const gw: Profile = { id: 'p_gw', name: 'Gateway', kind: 'gateway', origin: 'https://gw.example.test', remember: false };
const gw2: Profile = { id: 'p_gw2', name: 'Other', kind: 'gateway', origin: 'https://other-gw.example.test', remember: false };
const cloud: Profile = { id: 'p_cloud', name: 'Cloud', kind: 'cloud', origin: 'https://app.example.test', remember: false };

function settings(activeProfileId: string, connectedBrowser = true): Settings {
  const base = defaultSettings();
  return { ...base, profiles: [gw, gw2, cloud], activeProfileId, prefs: { ...base.prefs, connectedBrowser } };
}

const api: BrowserApi = {
  createTab: async () => 1,
  updateTab: async () => undefined,
  removeTab: async () => undefined,
  getTab: async () => null,
  run: async () => ({ ok: false, code: 'internal' }),
  hasHostPermission: async () => true,
};

/** A device enrolled earlier in this browser, with the grant ids it created. */
async function enrolledHere(grantIds: string[] = [GRANT_ID]): Promise<void> {
  await fakeBrowser.storage.local.set({ [deviceKey(gw.id)]: { device_id: DEVICE_ID, name: 'Chrome on Windows' }, [grantsKey(gw.id)]: grantIds });
}

function setup() {
  const sockets: FakeSocket[] = [];
  const token = vi.fn(async (profileId: string) => `key-for-${profileId}`);
  const session = new BrowserSession({
    api,
    action: null,
    token,
    random: () => 0.5,
    now: () => NOW,
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
    socket().open();
    await flush();
    socket().reply(socket().last('connect'));
    await flush();
  };
  return { session, sockets, socket, token, connect };
}

beforeEach(async () => {
  fakeBrowser.runtime.getManifest = (() => ({ manifest_version: 3, name: 'Dewee', version: '0.1.0' })) as typeof fakeBrowser.runtime.getManifest;
  await writeCredential(gw.id, { kind: 'api_key', apiKey: 'k1' }, false);
  await writeCredential(gw2.id, { kind: 'api_key', apiKey: 'k2' }, false);
});

describe('BrowserSession', () => {
  it('opens no socket while the preference is off', async () => {
    await saveSettings(settings(gw.id, false));
    const t = setup();
    await t.session.sync();
    expect(t.sockets).toHaveLength(0);
    expect(t.session.state()).toMatchObject({ mode: 'off', connection: 'offline' });
  });

  it('does not fake the feature for Dewee Cloud', async () => {
    await saveSettings(settings(cloud.id));
    const t = setup();
    await t.session.sync();
    expect(t.sockets).toHaveLength(0);
    expect(t.session.state().mode).toBe('cloud');
  });

  it('needs an API key credential', async () => {
    await saveSettings(settings(gw.id));
    await fakeBrowser.storage.session.clear();
    await fakeBrowser.storage.local.remove(`credential:${gw.id}`);
    const t = setup();
    await t.session.sync();
    expect(t.sockets).toHaveLength(0);
    expect(t.session.state().mode).toBe('signed_out');
  });

  it('connects with the profile key, enrolls and remembers the server device id', async () => {
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    expect(t.socket().url).toBe('wss://gw.example.test/ws');
    await t.connect();
    expect(t.token).toHaveBeenCalledWith(gw.id);
    expect(t.session.state()).toMatchObject({ mode: 'ready', connection: 'connected', device: null });

    const enrolled = t.session.handleRequest({ type: 'browser.enroll', name: 'Work laptop' });
    await flush();
    expect(t.socket().last('browser.device.enroll').params).toEqual({ name: 'Work laptop', platform: expect.any(String), capabilities: ['standard'] });
    t.socket().reply(t.socket().last('browser.device.enroll'), { device_id: DEVICE_ID });
    await flush();
    // A grant this browser never created is not used, whatever the Gateway says.
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
    await expect(enrolled).resolves.toEqual({ ok: true });
    expect((await fakeBrowser.storage.local.get(deviceKey(gw.id)))[deviceKey(gw.id)]).toEqual({ device_id: DEVICE_ID, name: 'Work laptop' });
    expect(t.session.state()).toMatchObject({ device: { device_id: DEVICE_ID }, grants: [] });
  });

  it('re-attaches the stored device after a reconnect and never replays requests', async () => {
    vi.useFakeTimers();
    try {
      await fakeBrowser.storage.local.set({ [deviceKey(gw.id)]: { device_id: DEVICE_ID, name: 'Chrome on Windows' } });
      await saveSettings(settings(gw.id));
      const t = setup();
      await t.session.sync();
      await t.connect();
      t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
      await flush();
      expect(t.session.state().connection).toBe('connected');

      t.socket().drop();
      expect(t.session.state().connection).toBe('reconnecting');
      vi.advanceTimersByTime(750);
      expect(t.sockets).toHaveLength(2);
      await t.connect();
      expect(t.socket().methods()).toEqual(['connect', 'browser.device.attach']);
      expect(t.socket().last('browser.device.attach').params).toEqual({ device_id: DEVICE_ID, capabilities: ['standard'] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('says when the workspace has connected browsing off and attaches once it is turned on', async () => {
    vi.useFakeTimers();
    try {
      await enrolledHere();
      await saveSettings(settings(gw.id));
      const t = setup();
      await t.session.sync();
      await t.connect();
      t.socket().refuse(t.socket().last('browser.device.attach'), 'FAILED_PRECONDITION', 'connected browsing is not enabled');
      await flush();
      expect(t.session.state()).toMatchObject({ connection: 'reconnecting', error: 'failed_precondition', device: { device_id: DEVICE_ID } });

      // The backoff retries by itself; the device is kept and attaches when the feature is on.
      vi.advanceTimersByTime(750);
      expect(t.sockets).toHaveLength(2);
      await t.connect();
      t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
      await flush();
      expect(t.session.state()).toMatchObject({ connection: 'connected', error: undefined, device: { device_id: DEVICE_ID }, grants: [{ grant_id: GRANT_ID }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes the socket and forgets grants on a profile switch', async () => {
    await enrolledHere();
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
    await flush();
    expect(t.session.state().grants).toHaveLength(1);

    await saveSettings(settings(gw2.id));
    await t.session.sync();
    expect(t.sockets[0]?.closed).toBe(true);
    expect(t.sockets).toHaveLength(2);
    expect(t.socket().url).toBe('wss://other-gw.example.test/ws');
    expect(t.session.state()).toMatchObject({ device: null, grants: [] });
    await t.connect();
    expect(t.token).toHaveBeenLastCalledWith(gw2.id);
  });

  it('closes the socket when the preference is turned off', async () => {
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    await saveSettings(settings(gw.id, false));
    await t.session.sync();
    expect(t.sockets[0]?.closed).toBe(true);
    expect(t.session.state()).toMatchObject({ mode: 'off', connection: 'offline' });
  });

  it('drops a grant the gateway revoked', async () => {
    await enrolledHere();
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
    await flush();
    expect(t.session.state().grants).toHaveLength(1);
    t.socket().event('browser.grant.revoked', { grant_id: GRANT_ID });
    expect(t.session.state().grants).toEqual([]);
    await flush();
    expect((await fakeBrowser.storage.local.get(grantsKey(gw.id)))[grantsKey(gw.id)]).toEqual([]);
  });

  it('uses only grants created in this browser, for this device, over exact origins', async () => {
    const other = '66666666-6666-4666-8666-666666666666';
    const wildcard = '77777777-7777-4777-8777-777777777777';
    const foreign = '88888888-8888-4888-8888-888888888888';
    await enrolledHere([GRANT_ID, other, wildcard]);
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), {
      device_id: DEVICE_ID,
      grants: [
        grant(),
        grant({ grant_id: other, device_id: '99999999-9999-4999-8999-999999999999' }),
        grant({ grant_id: wildcard, origins: ['https://*.example.test'] }),
        grant({ grant_id: foreign }),
      ],
    });
    await flush();
    expect(t.session.state().grants.map((g) => g.grant_id)).toEqual([GRANT_ID]);

    // A refresh from the Gateway cannot add a grant either.
    void t.session.handleRequest({ type: 'browser.grant.refresh' });
    await flush();
    t.socket().reply(t.socket().last('browser.grant.list'), { grants: [grant({ grant_id: foreign }), grant({ grant_id: other, device_id: null })] });
    await flush();
    expect(t.session.state().grants).toEqual([]);
  });

  it('remembers a grant it created and keeps it across a reconnect', async () => {
    await enrolledHere([]);
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    const created = t.session.handleRequest({ type: 'browser.grant.create', agentIds: [AGENT_ID], origins: [ORIGIN], capabilities: ['browser.read', 'browser.control'], ttlSeconds: 3600 });
    await flush();
    t.socket().reply(t.socket().last('browser.grant.create'), { grant: grant() });
    await expect(created).resolves.toEqual({ ok: true });
    expect((await fakeBrowser.storage.local.get(grantsKey(gw.id)))[grantsKey(gw.id)]).toEqual([GRANT_ID]);

    // A fresh session (worker restart) honours it on attach.
    const restarted = setup();
    await restarted.session.sync();
    await restarted.connect();
    restarted.socket().reply(restarted.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
    await flush();
    expect(restarted.session.state().grants.map((g) => g.grant_id)).toEqual([GRANT_ID]);
  });

  it.each<[string, Partial<Grant>]>([
    ['more sites', { origins: [ORIGIN, 'https://bank.example.test'] }],
    ['another agent', { agent_ids: [OTHER_AGENT_ID] }],
    ['an extra agent', { agent_ids: [AGENT_ID, OTHER_AGENT_ID] }],
    ['control where only reading was approved', { capabilities: ['browser.read', 'browser.control'] }],
  ])('refuses and withdraws a created grant with %s than the person approved', async (_label, change) => {
    await enrolledHere([]);
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    const created = t.session.handleRequest({ type: 'browser.grant.create', agentIds: [AGENT_ID], origins: [ORIGIN], capabilities: ['browser.read'], ttlSeconds: 3600 });
    await flush();
    t.socket().reply(t.socket().last('browser.grant.create'), { grant: grant({ capabilities: ['browser.read'], ...change }) });
    await expect(created).resolves.toEqual({ ok: false, code: 'invalid_response' });
    expect(t.session.state().grants).toEqual([]);
    expect((await fakeBrowser.storage.local.get(grantsKey(gw.id)))[grantsKey(gw.id)]).toEqual([]);
    expect(t.socket().last('browser.grant.revoke').params).toEqual({ grant_id: GRANT_ID });
  });

  it('accepts a created grant that is exactly what the person approved, in any order', async () => {
    await enrolledHere([]);
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    const other = 'https://docs.example.test';
    const created = t.session.handleRequest({ type: 'browser.grant.create', agentIds: [AGENT_ID, OTHER_AGENT_ID], origins: [ORIGIN, other], capabilities: ['browser.read'], ttlSeconds: 3600 });
    await flush();
    t.socket().reply(t.socket().last('browser.grant.create'), { grant: grant({ agent_ids: [OTHER_AGENT_ID, AGENT_ID], origins: [other, ORIGIN], capabilities: ['browser.read'] }) });
    await expect(created).resolves.toEqual({ ok: true });
    expect(t.session.state().grants.map((g) => g.grant_id)).toEqual([GRANT_ID]);
    expect(t.socket().methods()).not.toContain('browser.grant.revoke');
  });

  it('sends no grant request before the socket finished attaching', async () => {
    await enrolledHere([]);
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    // The attach is still unanswered.
    const response = await t.session.handleRequest({ type: 'browser.grant.create', agentIds: [AGENT_ID], origins: [ORIGIN], capabilities: ['browser.read'], ttlSeconds: 3600 });
    expect(response).toEqual({ ok: false, code: 'device_offline' });
    expect(t.socket().methods()).not.toContain('browser.grant.create');
    expect(t.session.state().device).toMatchObject({ device_id: DEVICE_ID });
  });

  it('stops a running command when a refresh no longer lists its grant', async () => {
    await enrolledHere();
    await saveSettings(settings(gw.id));
    const t = setup();
    let allow: (value: boolean) => void = () => undefined;
    api.hasHostPermission = () => new Promise<boolean>((resolve) => (allow = resolve));
    try {
      await t.session.sync();
      await t.connect();
      t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
      await flush();
      t.socket().event('browser.command', payload('open', { url: `${ORIGIN}/` }));
      await flush();
      t.socket().reply(t.socket().last('browser.command.ack'));
      await flush();

      void t.session.handleRequest({ type: 'browser.grant.refresh' });
      await flush();
      t.socket().reply(t.socket().last('browser.grant.list'), { grants: [] });
      await flush();
      allow(true);
      await flush();
      expect(t.socket().last('browser.command.result').params).toMatchObject({ ok: false, error: { code: 'grant_revoked' } });
    } finally {
      api.hasHostPermission = async () => true;
    }
  });

  it('never runs a command whose ack the Gateway refused as unknown, and sends no result', async () => {
    await enrolledHere();
    await saveSettings(settings(gw.id));
    const t = setup();
    const permission = vi.spyOn(api, 'hasHostPermission');
    const createTab = vi.spyOn(api, 'createTab');
    try {
      await t.session.sync();
      await t.connect();
      t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
      await flush();
      t.socket().event('browser.command', payload('open', { url: `${ORIGIN}/` }));
      await flush();
      t.socket().refuse(t.socket().last('browser.command.ack'), 'NOT_FOUND');
      await flush();
      expect(permission).not.toHaveBeenCalled();
      expect(createTab).not.toHaveBeenCalled();
      expect(t.socket().methods()).not.toContain('browser.command.result');
    } finally {
      permission.mockRestore();
      createTab.mockRestore();
    }
  });

  it('explains a refused grant: a device revoked elsewhere is forgotten, an agent or key without the right is refused', async () => {
    await enrolledHere([]);
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    const request = (): BrowserRequest => ({ type: 'browser.grant.create', agentIds: [AGENT_ID], origins: [ORIGIN], capabilities: ['browser.read'], ttlSeconds: 3600 });

    const shared = t.session.handleRequest(request());
    await flush();
    t.socket().refuse(t.socket().last('browser.grant.create'), 'UNAUTHORIZED');
    await expect(shared).resolves.toEqual({ ok: false, code: 'grant_unauthorized' });
    expect(t.session.state().device).toMatchObject({ device_id: DEVICE_ID });

    const revoked = t.session.handleRequest(request());
    await flush();
    t.socket().refuse(t.socket().last('browser.grant.create'), 'NOT_FOUND');
    await expect(revoked).resolves.toEqual({ ok: false, code: 'device_revoked' });
    expect(t.session.state().device).toBeNull();
    expect(await fakeBrowser.storage.local.get(deviceKey(gw.id))).toEqual({});
  });

  it('sends no control state after attach when the person never chose one', async () => {
    await enrolledHere();
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    expect(t.session.state().control).toBe('active');
    expect(t.socket().methods()).not.toContain('browser.control.state');
  });

  it('keeps Pause across a Chrome restart and re-sends it after attach', async () => {
    await enrolledHere();
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    const paused = t.session.handleRequest({ type: 'browser.control', state: 'paused' });
    await flush();
    expect(t.socket().last('browser.control.state').params).toEqual({ device_id: DEVICE_ID, state: 'paused' });
    t.socket().reply(t.socket().last('browser.control.state'));
    await expect(paused).resolves.toEqual({ ok: true });
    expect((await fakeBrowser.storage.local.get(controlKey(gw.id)))[controlKey(gw.id)]).toEqual({ device_id: DEVICE_ID, state: 'paused' });

    // Chrome restarts: storage.session is gone, storage.local is kept; the person signs in again.
    await fakeBrowser.storage.session.clear();
    await writeCredential(gw.id, { kind: 'api_key', apiKey: 'k1' }, false);
    const restarted = setup();
    await restarted.session.sync();
    expect(restarted.session.state().control).toBe('paused');
    await restarted.connect();
    restarted.socket().reply(restarted.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    expect(restarted.socket().last('browser.control.state').params).toEqual({ device_id: DEVICE_ID, state: 'paused' });

    // Resume is the person's choice too, and is re-sent from then on.
    const resumed = restarted.session.handleRequest({ type: 'browser.control', state: 'active' });
    await flush();
    restarted.socket().reply(restarted.socket().last('browser.control.state'));
    await expect(resumed).resolves.toEqual({ ok: true });
    expect((await fakeBrowser.storage.local.get(controlKey(gw.id)))[controlKey(gw.id)]).toEqual({ device_id: DEVICE_ID, state: 'active' });
  });

  it('keeps Stop across a profile switch and back', async () => {
    await enrolledHere();
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    const stopped = t.session.handleRequest({ type: 'browser.control', state: 'stopped' });
    await flush();
    t.socket().reply(t.socket().last('browser.control.state'));
    await expect(stopped).resolves.toEqual({ ok: true });

    await saveSettings(settings(gw2.id));
    await t.session.sync();
    expect(t.session.state().control).toBe('active');

    await saveSettings(settings(gw.id));
    await t.session.sync();
    expect(t.session.state().control).toBe('stopped');
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    expect(t.socket().last('browser.control.state').params).toEqual({ device_id: DEVICE_ID, state: 'stopped' });
  });

  it('stays paused and sends nothing when the stored control state is damaged', async () => {
    await enrolledHere();
    await fakeBrowser.storage.local.set({ [controlKey(gw.id)]: { device_id: DEVICE_ID, state: 'running' } });
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    expect(t.session.state().control).toBe('paused');
    expect(t.socket().methods()).not.toContain('browser.control.state');
  });

  it('ignores a stored control state of another device', async () => {
    await enrolledHere();
    await fakeBrowser.storage.local.set({ [controlKey(gw.id)]: { device_id: '99999999-9999-4999-8999-999999999999', state: 'paused' } });
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
    await flush();
    expect(t.session.state().control).toBe('active');
    expect(t.socket().methods()).not.toContain('browser.control.state');
  });

  it('refuses a device name with control characters before sending it', async () => {
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    await expect(t.session.handleRequest({ type: 'browser.enroll', name: 'Work‮laptop' })).resolves.toEqual({ ok: false, code: 'invalid_device_name' });
    expect(t.socket().methods()).not.toContain('browser.device.enroll');
  });

  it('forgets the device and its grant ids when the device is revoked', async () => {
    await enrolledHere();
    await saveSettings(settings(gw.id));
    const t = setup();
    await t.session.sync();
    await t.connect();
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
    await flush();
    t.socket().event('browser.device.revoked', { device_id: DEVICE_ID });
    await flush();
    expect(t.session.state()).toMatchObject({ device: null, grants: [] });
    const stored = await fakeBrowser.storage.local.get([deviceKey(gw.id), grantsKey(gw.id)]);
    expect(stored).toEqual({});
  });

  it('refuses a grant for a site Chrome has no access to', async () => {
    await fakeBrowser.storage.local.set({ [deviceKey(gw.id)]: { device_id: DEVICE_ID, name: 'Chrome on Windows' } });
    await saveSettings(settings(gw.id));
    const t = setup();
    api.hasHostPermission = async () => false;
    try {
      await t.session.sync();
      await t.connect();
      t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [] });
      await flush();
      const response = await t.session.handleRequest({ type: 'browser.grant.create', agentIds: ['33333333-3333-4333-8333-333333333333'], origins: ['https://shop.example.test'], capabilities: ['browser.read'], ttlSeconds: 3600 });
      expect(response).toEqual({ ok: false, code: 'origin_permission_missing' });
      expect(t.socket().methods()).not.toContain('browser.grant.create');
      const restricted = await t.session.handleRequest({ type: 'browser.grant.create', agentIds: ['33333333-3333-4333-8333-333333333333'], origins: ['https://chromewebstore.google.com'], capabilities: ['browser.read'], ttlSeconds: 3600 });
      expect(restricted).toEqual({ ok: false, code: 'invalid_origin' });
    } finally {
      api.hasHostPermission = async () => true;
    }
  });
});
