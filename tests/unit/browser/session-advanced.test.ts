import { fakeBrowser } from 'wxt/testing/fake-browser';
import { writeCredential } from '@/auth/credential-store';
import type { CdpAdapterOptions } from '@/browser/adapters/cdp';
import type { DriverRequest, DriverResponse } from '@/browser/adapters/page-driver';
import type { BrowserApi, TabInfo } from '@/browser/chrome-api';
import type { AdvancedEngine } from '@/browser/engine-router';
import { BrowserSession, debuggerKey, deviceKey, grantsKey } from '@/browser/session';
import type { ActionApi } from '@/browser/tab-marker';
import { defaultSettings, saveSettings, type Profile, type Settings } from '@/shared/settings';
import type { Grant } from '@/browser/protocol';
import { DEVICE_ID, grant, GRANT_ID, NOW, ORIGIN, payload } from './fixtures';
import { FakeSocket, flush } from './fake-socket';

const gw: Profile = { id: 'p_gw', name: 'Gateway', kind: 'gateway', origin: 'https://gw.example.test', remember: false };

function settings(): Settings {
  const base = defaultSettings();
  return { ...base, profiles: [gw], activeProfileId: gw.id, prefs: { ...base.prefs, connectedBrowser: true } };
}

/** A debugger adapter double: records calls; `prepare` answers from `attachResult`. */
class FakeEngine implements AdvancedEngine {
  attached = new Set<number>();
  attachResult: DriverResponse | null = null;
  dispatching = false;
  readonly calls: string[] = [];
  constructor(readonly options: CdpAdapterOptions) {}
  get attachedTabs() {
    return [...this.attached];
  }
  async prepare(tabId: number) {
    this.calls.push(`prepare:${tabId}`);
    const refused = await this.options.check(tabId);
    if (refused) return refused;
    this.attached.add(tabId);
    this.options.onChange();
    return null;
  }
  async run(tabId: number, request: DriverRequest): Promise<DriverResponse> {
    this.calls.push(`run:${request.op}`);
    const refused = await this.options.check(tabId);
    if (refused) return { ok: false, code: refused };
    this.attached.add(tabId);
    if (request.op === 'screenshot') return { ok: true, op: 'screenshot', data: '/9j/AAAA' };
    if (request.op === 'snapshot') return { ok: true, op: 'snapshot', text: '[e1] button "Next"', url: `${ORIGIN}/`, title: 'Shop' };
    return { ok: true, op: request.op } as DriverResponse;
  }
  async release(tabId: number) {
    this.calls.push(`release:${tabId}`);
    this.attached.delete(tabId);
  }
  forget(tabId: number) {
    this.calls.push(`forget:${tabId}`);
  }
  async forceDetach(tabId: number) {
    this.calls.push(`forceDetach:${tabId}`);
  }
  async detachAll() {
    this.calls.push('detachAll');
    this.attached.clear();
  }
  isDispatching() {
    return this.dispatching;
  }
}

function setup(options: { advanced?: boolean; grant?: Grant } = {}) {
  const clock = { now: NOW };
  const liveGrant = options.grant ?? grant();
  const tabs = new Map<number, TabInfo>();
  let next = 40;
  const api: BrowserApi = {
    createTab: async (url) => {
      const id = next++;
      tabs.set(id, { url, title: 'Shop', status: 'complete', active: false });
      return id;
    },
    updateTab: async (tabId, url) => {
      const tab = tabs.get(tabId);
      if (tab) tab.url = url;
    },
    removeTab: async (tabId) => {
      tabs.delete(tabId);
    },
    getTab: async (tabId) => tabs.get(tabId) ?? null,
    run: async (_tabId, request) => {
      if (request.op === 'snapshot') return { ok: true, op: 'snapshot', text: '[e1] button "Standard"', url: `${ORIGIN}/`, title: 'Shop' };
      if (request.op === 'screenshot') return { ok: false, code: 'unsupported_capability' };
      return { ok: true, op: request.op } as DriverResponse;
    },
    hasHostPermission: async (origin) => origin === ORIGIN,
  };
  let engine: FakeEngine | null = null;
  const badges: string[] = [];
  const action: ActionApi = {
    setBadgeText: async ({ tabId, text }) => void badges.push(`${tabId}:${text ?? 'reset'}`),
    setBadgeBackgroundColor: async () => undefined,
    setTitle: async () => undefined,
  };
  const sockets: FakeSocket[] = [];
  const session = new BrowserSession({
    api,
    action,
    cdp: options.advanced === false ? null : (opts) => (engine = new FakeEngine(opts)),
    token: async () => 'key',
    random: () => 0.5,
    now: () => clock.now,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  const socket = (): FakeSocket => {
    const current = sockets.at(-1);
    if (!current) throw new Error('no socket');
    return current;
  };
  const ready = async () => {
    await session.sync();
    socket().open();
    await flush();
    socket().reply(socket().last('connect'));
    await flush();
    socket().reply(socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [liveGrant] });
    await flush();
  };
  /** Sends one command and waits for its result frame. */
  const command = async (action: Parameters<typeof payload>[0], params: Record<string, unknown>) => {
    const frame = payload(action, params);
    const before = socket().methods().filter((m) => m === 'browser.command.result').length;
    socket().event('browser.command', frame);
    await vi.waitFor(() => expect(socket().methods().filter((m) => m === 'browser.command.result').length).toBe(before + 1), { timeout: 3000 });
    return socket().last('browser.command.result').params as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
  };
  /** Turns the debugger on and answers the re-attach that announces the new capabilities. */
  const enable = async (fallback = true) => {
    const done = session.handleRequest({ type: 'browser.advanced', enabled: true, fallback });
    await flush();
    socket().reply(socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [liveGrant] });
    await expect(done).resolves.toEqual({ ok: true });
  };
  return { session, tabs, api, socket, ready, command, enable, badges, clock, engine: () => engine as FakeEngine | null };
}

beforeEach(async () => {
  fakeBrowser.runtime.getManifest = (() => ({ manifest_version: 3, name: 'Dewee', version: '0.1.0' })) as typeof fakeBrowser.runtime.getManifest;
  await writeCredential(gw.id, { kind: 'api_key', apiKey: 'k1' }, false);
  await fakeBrowser.storage.local.set({ [deviceKey(gw.id)]: { device_id: DEVICE_ID, name: 'Chrome' }, [grantsKey(gw.id)]: [GRANT_ID] });
  await saveSettings(settings());
});

describe('BrowserSession: Standard build', () => {
  it('has no debugger: refuses the opt-in and announces only standard', async () => {
    const t = setup({ advanced: false });
    await t.ready();
    expect(t.socket().last('browser.device.attach').params).toEqual({ device_id: DEVICE_ID, capabilities: ['standard'] });
    expect(t.session.state().advanced).toEqual({ available: false, enabled: false, fallback: true, attached: 0 });
    await expect(t.session.handleRequest({ type: 'browser.advanced', enabled: true, fallback: true })).resolves.toEqual({ ok: false, code: 'unsupported_capability' });
    const open = await t.command('open', { url: `${ORIGIN}/` });
    expect(open.ok).toBe(true);
    await expect(t.command('screenshot', { tab: 't1' })).resolves.toMatchObject({ ok: false, error: { code: 'unsupported_capability' } });
  });
});

describe('BrowserSession: Advanced build', () => {
  it('is off by default, and announces advanced only while the person has it on', async () => {
    const t = setup();
    await t.ready();
    expect(t.socket().last('browser.device.attach').params).toEqual({ device_id: DEVICE_ID, capabilities: ['standard'] });
    expect(t.session.state().advanced).toMatchObject({ available: true, enabled: false });

    const on = t.session.handleRequest({ type: 'browser.advanced', enabled: true, fallback: false });
    await flush();
    expect(t.socket().last('browser.device.attach').params).toEqual({ device_id: DEVICE_ID, capabilities: ['standard', 'advanced'] });
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
    await expect(on).resolves.toEqual({ ok: true });
    expect(t.session.state().advanced).toMatchObject({ enabled: true, fallback: false });
    // Only for this browser session.
    expect((await fakeBrowser.storage.session.get(debuggerKey(gw.id)))[debuggerKey(gw.id)]).toEqual({ enabled: true, fallback: false });
    expect(await fakeBrowser.storage.local.get(debuggerKey(gw.id))).toEqual({});

    const off = t.session.handleRequest({ type: 'browser.advanced', enabled: false, fallback: false });
    await flush();
    expect(t.socket().last('browser.device.attach').params).toEqual({ device_id: DEVICE_ID, capabilities: ['standard'] });
    t.socket().reply(t.socket().last('browser.device.attach'), { device_id: DEVICE_ID, grants: [grant()] });
    await off;
    expect(t.engine()?.calls).toContain('detachAll');
  });

  it('enrolls a new device with what the build can do', async () => {
    await fakeBrowser.storage.local.remove([deviceKey(gw.id)]);
    const t = setup();
    await t.session.sync();
    t.socket().open();
    await flush();
    t.socket().reply(t.socket().last('connect'));
    await flush();
    void t.session.handleRequest({ type: 'browser.enroll', name: 'Laptop' });
    await flush();
    expect(t.socket().last('browser.device.enroll').params).toMatchObject({ capabilities: ['standard', 'advanced'] });
  });

  it('reads and screenshots with the debugger once on, and lets go after each command', async () => {
    const t = setup();
    await t.ready();
    await t.command('open', { url: `${ORIGIN}/` });
    await t.enable();
    const snapshot = await t.command('snapshot', { tab: 't1' });
    expect(snapshot.result).toMatchObject({ text: '[e1] button "Next"' });
    const shot = await t.command('screenshot', { tab: 't1' });
    expect(shot).toMatchObject({ ok: true, result: { tab: 't1', mime: 'image/jpeg', data_base64: '/9j/AAAA' } });
    const calls = t.engine()?.calls ?? [];
    expect(calls.filter((c) => c.startsWith('release:'))).toHaveLength(2);
    expect(t.session.state().advanced.attached).toBe(0);
  });

  it('checks the live policy before every debugger command', async () => {
    const t = setup();
    await t.ready();
    await t.command('open', { url: `${ORIGIN}/` });
    const check = (tabId: number) => t.engine()?.options.check(tabId);
    // Off by default.
    await expect(check(40)).resolves.toBe('debugger_unavailable');
    await t.enable();
    await expect(check(40)).resolves.toBeNull();
    // Not an agent's tab.
    await expect(check(99)).resolves.toBe('tab_not_owned');
    // The tab moved to a restricted page or another site.
    const tab = t.tabs.get(40);
    if (!tab) throw new Error('no tab');
    tab.url = 'https://chromewebstore.google.com/detail/x';
    await expect(check(40)).resolves.toBe('restricted_page');
    tab.url = 'https://elsewhere.example.test/';
    await expect(check(40)).resolves.toBe('origin_not_granted');
    tab.url = `${ORIGIN}/`;
    // Paused.
    void t.session.handleRequest({ type: 'browser.control', state: 'paused' });
    await flush();
    await expect(check(40)).resolves.toBe('device_paused');
  });

  it('lets go of the tab at once when the grant is revoked', async () => {
    const t = setup();
    await t.ready();
    await t.command('open', { url: `${ORIGIN}/` });
    await t.enable();
    t.socket().event('browser.grant.revoked', { grant_id: GRANT_ID });
    await flush();
    expect(t.engine()?.calls).toEqual(expect.arrayContaining(['forget:40', 'release:40']));
    await expect(t.engine()?.options.check(40)).resolves.toBe('tab_not_owned');
  });

  it('turns itself off when the person cancels Chrome’s debugging bar', async () => {
    const t = setup();
    await t.ready();
    await t.enable();
    t.engine()?.options.onDetached(40, 'canceled_by_user');
    await flush();
    expect(t.session.state().advanced.enabled).toBe(false);
  });

  it('pauses when the person uses an agent tab, but not for the debugger’s own input', async () => {
    const t = setup();
    await t.ready();
    await t.command('open', { url: `${ORIGIN}/` });
    const engine = t.engine();
    if (!engine) throw new Error('no engine');
    engine.dispatching = true;
    t.session.onUserInput(40);
    expect(t.session.state().control).toBe('active');
    engine.dispatching = false;
    t.session.onUserInput(40);
    await flush();
    expect(t.session.state()).toMatchObject({ control: 'paused', pauseReason: 'takeover' });
    expect(t.socket().last('browser.control.state').params).toEqual({ device_id: DEVICE_ID, state: 'paused' });
    // A tab the agent does not own is the person's own business.
    void t.session.handleRequest({ type: 'browser.control', state: 'active' });
    await flush();
    t.session.onUserInput(7);
    expect(t.session.state().control).toBe('active');
    expect(t.session.state().pauseReason).toBeUndefined();
  });

  it('marks agent tabs, lists them, and keeps a timeline of outcomes without page data', async () => {
    const t = setup();
    await t.ready();
    await t.command('open', { url: `${ORIGIN}/` });
    await t.command('screenshot', { tab: 't1' });
    const state = t.session.state();
    expect(t.badges).toContain('40:AI');
    expect(state.tabs).toEqual([{ handle: 't1', agentName: 'Researcher', domain: 'shop.example.test', expiresAt: grant().expires_at }]);
    expect(state.timeline.map(({ action, ok, code }) => ({ action, ok, code }))).toEqual([
      { action: 'screenshot', ok: false, code: 'unsupported_capability' },
      { action: 'open', ok: true, code: undefined },
    ]);
    expect(JSON.stringify(state.timeline)).not.toContain('/9j/');

    t.socket().event('browser.grant.revoked', { grant_id: GRANT_ID });
    await flush();
    expect(t.badges).toContain('40:reset');
    expect(t.session.state().tabs).toEqual([]);
  });

  it('detaches from the grant’s tabs when it expires, without waiting for the next command', async () => {
    const t = setup({ grant: grant({ expires_at: new Date(NOW + 800).toISOString() }) });
    await t.ready();
    await t.command('open', { url: `${ORIGIN}/` });
    expect(t.badges).toContain('40:AI');
    t.clock.now = NOW + 1_000;
    await vi.waitFor(() => expect(t.engine()?.calls).toContain('forget:40'), { timeout: 2000 });
    expect(t.badges).toContain('40:reset');
    await expect(t.command('snapshot', { tab: 't1' })).resolves.toMatchObject({ ok: false, error: { code: 'grant_expired' } });
  });
});
