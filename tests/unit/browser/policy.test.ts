import { isHighRiskName, isRestrictedUrl, LocalGuard, type GuardDeps } from '@/browser/policy';
import { TabRegistry } from '@/browser/tabs';
import { command, grant, GRANT_ID, NOW, ORIGIN, OTHER_AGENT_ID, AGENT_ID } from './fixtures';

function setup(overrides: Partial<GuardDeps> = {}) {
  const tabs = new TabRegistry();
  const deps: GuardDeps = {
    hasHostPermission: vi.fn(async () => true),
    tabUrl: vi.fn(async () => `${ORIGIN}/cart`),
    now: () => NOW,
    ...overrides,
  };
  return { tabs, deps, guard: new LocalGuard(tabs, deps) };
}

const click = () => command('click', { tab: 't1', ref: 'e1', generation: 1 });
const snapshot = () => command('snapshot', { tab: 't1' });

describe('isRestrictedUrl', () => {
  it.each([
    'chrome://settings',
    'chrome-extension://abc/options.html',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
    'file:///C:/secret.txt',
    'data:text/html,<p>x</p>',
    'javascript:alert(1)',
    'about:blank',
    'about:config',
    'https://user:pass@example.com/',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isRestrictedUrl(url)).toBe(true);
  });

  it('allows ordinary sites', () => {
    expect(isRestrictedUrl('https://example.com/a')).toBe(false);
    expect(isRestrictedUrl('https://chrome.google.com/search')).toBe(false);
  });
});

describe('isHighRiskName', () => {
  it.each(['Submit', 'Place order', 'Delete account', 'Pay now', 'Send', 'Xóa tài khoản', 'Thanh toán', 'Đặt hàng', 'Confirm transfer'])('flags %s', (name) => {
    expect(isHighRiskName(name)).toBe(true);
  });
  it.each(['Sign in', 'Log in', 'Đăng nhập', 'Next', 'Search', 'Postcode', 'Order history', ''])('does not flag %s', (name) => {
    expect(isHighRiskName(name)).toBe(false);
  });
});

describe('LocalGuard.checkGrant', () => {
  const { guard } = setup();

  it('accepts a granted agent with the right capability', () => {
    expect(guard.checkGrant(click(), grant(), 'active')).toEqual({ ok: true });
  });

  it.each([
    ['paused', 'device_paused'],
    ['stopped', 'device_paused'],
  ] as const)('refuses while %s', (state, code) => {
    expect(guard.checkGrant(click(), grant(), state)).toMatchObject({ ok: false, code });
  });

  it('refuses a missing or revoked grant', () => {
    expect(guard.checkGrant(click(), undefined, 'active')).toMatchObject({ ok: false, code: 'no_grant' });
    expect(guard.checkGrant(click(), grant({ revoked_at: new Date(NOW).toISOString() }), 'active')).toMatchObject({ ok: false, code: 'grant_revoked' });
  });

  it('refuses an expired grant', () => {
    expect(guard.checkGrant(click(), grant({ expires_at: new Date(NOW).toISOString() }), 'active')).toMatchObject({ ok: false, code: 'grant_expired' });
  });

  it('refuses an agent outside the grant', () => {
    expect(guard.checkGrant(click(), grant({ agent_ids: [OTHER_AGENT_ID] }), 'active')).toMatchObject({ ok: false, code: 'no_grant' });
  });

  it('refuses interaction under a read-only grant but allows reading', () => {
    const readOnly = grant({ capabilities: ['browser.read'] });
    expect(guard.checkGrant(click(), readOnly, 'active')).toMatchObject({ ok: false, code: 'capability_not_granted' });
    expect(guard.checkGrant(snapshot(), readOnly, 'active')).toEqual({ ok: true });
  });

  it('refuses screenshots in the standard build', () => {
    expect(guard.checkGrant(command('screenshot', { tab: 't1' }), grant(), 'active')).toMatchObject({ ok: false, code: 'unsupported_capability' });
  });
});

describe('LocalGuard.checkUrl', () => {
  it('requires the exact granted origin', async () => {
    const { guard } = setup();
    expect(await guard.checkUrl(`${ORIGIN}/products?q=1`, grant())).toEqual({ ok: true });
    expect(await guard.checkUrl('https://evil.example.test/', grant())).toMatchObject({ ok: false, code: 'origin_not_granted' });
    expect(await guard.checkUrl('http://shop.example.test/', grant())).toMatchObject({ ok: false, code: 'origin_not_granted' });
    expect(await guard.checkUrl('https://shop.example.test:8443/', grant())).toMatchObject({ ok: false, code: 'origin_not_granted' });
    expect(await guard.checkUrl('https://sub.shop.example.test/', grant())).toMatchObject({ ok: false, code: 'origin_not_granted' });
  });

  it('refuses restricted pages before the origin check', async () => {
    const { guard } = setup();
    expect(await guard.checkUrl('chrome://settings', grant({ origins: ['chrome://settings'] }))).toMatchObject({ ok: false, code: 'restricted_page' });
    expect(await guard.checkUrl('about:blank', grant())).toMatchObject({ ok: false, code: 'restricted_page' });
  });

  it('refuses when Chrome has no host permission for the origin', async () => {
    const { guard } = setup({ hasHostPermission: async () => false });
    expect(await guard.checkUrl(`${ORIGIN}/`, grant())).toMatchObject({ ok: false, code: 'origin_not_granted' });
  });

  it('refuses an unknown page address', async () => {
    const { guard } = setup();
    expect(await guard.checkUrl(undefined, grant())).toMatchObject({ ok: false, code: 'origin_not_granted' });
  });
});

describe('LocalGuard.checkTab', () => {
  it('accepts an owned tab on a granted page', async () => {
    const { guard, tabs } = setup();
    tabs.add(7, GRANT_ID, AGENT_ID);
    expect(await guard.checkTab('t1', grant(), true)).toMatchObject({ ok: true, tab: { handle: 't1', tabId: 7 } });
  });

  it('refuses a tab that is not owned, or owned under another grant', async () => {
    const { guard, tabs } = setup();
    expect(await guard.checkTab('t1', grant(), true)).toMatchObject({ ok: false, code: 'tab_not_owned' });
    tabs.add(7, 'other-grant', AGENT_ID);
    expect(await guard.checkTab('t1', grant(), true)).toMatchObject({ ok: false, code: 'tab_not_owned' });
  });

  it('refuses a closed tab and notices a tab that disappeared', async () => {
    const { guard, tabs } = setup({ tabUrl: async () => null });
    tabs.add(7, GRANT_ID, AGENT_ID);
    expect(await guard.checkTab('t1', grant(), true)).toMatchObject({ ok: false, code: 'tab_closed' });
    expect(await guard.checkTab('t1', grant(), true)).toMatchObject({ ok: false, code: 'tab_closed' });
  });

  it('refuses when the tab now shows a page outside the grant or a hidden page', async () => {
    const away = setup({ tabUrl: async () => 'https://elsewhere.example.test/' });
    away.tabs.add(7, GRANT_ID, AGENT_ID);
    expect(await away.guard.checkTab('t1', grant(), true)).toMatchObject({ ok: false, code: 'origin_not_granted' });
    const hidden = setup({ tabUrl: async () => undefined });
    hidden.tabs.add(7, GRANT_ID, AGENT_ID);
    expect(await hidden.guard.checkTab('t1', grant(), true)).toMatchObject({ ok: false, code: 'origin_not_granted' });
    const restricted = setup({ tabUrl: async () => 'chrome://newtab/' });
    restricted.tabs.add(7, GRANT_ID, AGENT_ID);
    expect(await restricted.guard.checkTab('t1', grant(), true)).toMatchObject({ ok: false, code: 'restricted_page' });
  });

  it('skips the page check when asked (closing a tab)', async () => {
    const { guard, tabs } = setup({ tabUrl: async () => 'https://elsewhere.example.test/' });
    tabs.add(7, GRANT_ID, AGENT_ID);
    expect(await guard.checkTab('t1', grant(), false)).toMatchObject({ ok: true });
  });

  it('answers busy while the person is using the tab', async () => {
    const { guard, tabs } = setup();
    tabs.add(7, GRANT_ID, AGENT_ID);
    tabs.noteUserInput(7, NOW - 1_000);
    expect(await guard.checkTab('t1', grant(), true)).toMatchObject({ ok: false, code: 'busy' });
  });
});
