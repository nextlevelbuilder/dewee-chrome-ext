import { ApprovalBroker } from '@/browser/approvals';
import type { BrowserApi, TabInfo } from '@/browser/chrome-api';
import { Executor, type ExecutionContext } from '@/browser/executor';
import { LocalGuard, type ControlState } from '@/browser/policy';
import type { DriverRequest, DriverResponse } from '@/browser/adapters/page-driver';
import type { BrowserCommand, Grant } from '@/browser/protocol';
import { TabRegistry } from '@/browser/tabs';

type PageRequest = DriverRequest;
type PageResponse = DriverResponse;
import { AGENT_ID, command, grant, GRANT_ID, NOW, ORIGIN } from './fixtures';
import { flush } from './fake-socket';

interface FakeTab extends TabInfo {
  id: number;
}

/** The id of the oldest approval waiting for the person. */
function pendingId(approvals: ApprovalBroker): string {
  const first = approvals.pending[0];
  if (!first) throw new Error('no approval is pending');
  return first.id;
}

function setup(options: { grant?: Grant; page?: (request: DriverRequest) => DriverResponse; redirect?: string; screenshots?: boolean } = {}) {
  const browserTabs = new Map<number, FakeTab>();
  let nextTabId = 100;
  const pageCalls: DriverRequest[] = [];
  const api: BrowserApi & { release: ReturnType<typeof vi.fn> } = {
    release: vi.fn(async () => undefined),
    createTab: vi.fn(async (url: string) => {
      const id = nextTabId++;
      browserTabs.set(id, { id, url: options.redirect ?? url, title: 'Shop', status: 'complete', active: false });
      return id;
    }),
    updateTab: vi.fn(async (tabId: number, url: string) => {
      const tab = browserTabs.get(tabId);
      if (tab) tab.url = url;
    }),
    removeTab: vi.fn(async (tabId: number) => {
      browserTabs.delete(tabId);
    }),
    getTab: async (tabId) => {
      const tab = browserTabs.get(tabId);
      return tab ? { ...tab } : null;
    },
    run: vi.fn(async (_tabId: number, request: DriverRequest): Promise<DriverResponse> => {
      pageCalls.push(request);
      if (options.page) return options.page(request);
      if (request.op === 'describe') return { ok: true, op: 'describe', role: 'button', name: 'Next', sensitive: false, editable: false } as const;
      if (request.op === 'focused') return { ok: true, op: 'describe', role: 'textbox', name: 'Message', sensitive: false, editable: true } as const;
      if (request.op === 'snapshot') return { ok: true, op: 'snapshot', text: '[e1] button "Next"', url: `${ORIGIN}/`, title: 'Shop' } as const;
      if (request.op === 'findText') return { ok: true, op: 'findText', found: true } as const;
      if (request.op === 'screenshot') return { ok: true, op: 'screenshot', data: '/9j/AAAA' } as const;
      return { ok: true, op: request.op } as DriverResponse;
    }),
    hasHostPermission: vi.fn(async (origin: string) => origin === ORIGIN),
  };
  const tabs = new TabRegistry();
  let control: ControlState = 'active';
  let current: Grant | undefined = options.grant ?? grant();
  const approvals = new ApprovalBroker(() => undefined);
  const guard = new LocalGuard(tabs, {
    hasHostPermission: (origin) => api.hasHostPermission(origin),
    tabUrl: async (tabId) => {
      const info = await api.getTab(tabId);
      return info === null ? null : info.url;
    },
    now: () => NOW,
  });
  const activities: string[] = [];
  const executor = new Executor({
    api,
    tabs,
    guard,
    approvals,
    grant: (id) => (current?.grant_id === id ? current : undefined),
    control: () => control,
    screenshots: () => options.screenshots ?? false,
    onActivity: (activity, running) => activities.push(`${running ? 'start' : 'end'}:${activity.action}`),
    onTabsChanged: () => undefined,
    now: () => NOW,
    sleep: async (_ms, signal) => {
      if (signal.aborted) throw signal.reason;
    },
  });
  /** An owned tab `t1` on the granted origin. */
  const ownTab = (url = `${ORIGIN}/cart`) => {
    browserTabs.set(7, { id: 7, url, title: 'Cart', status: 'complete', active: true });
    return tabs.add(7, GRANT_ID, AGENT_ID);
  };
  const run = (cmd: BrowserCommand, signal = new AbortController().signal) => {
    const context: ExecutionContext = { sideEffect: false };
    return { promise: executor.execute(cmd, signal, context), context };
  };
  return {
    api,
    tabs,
    approvals,
    browserTabs,
    pageCalls,
    activities,
    ownTab,
    run,
    setControl: (state: ControlState) => (control = state),
    setGrant: (value: Grant | undefined) => (current = value),
  };
}

const opsOf = (calls: PageRequest[]) => calls.map((c) => c.op);

type Description = { role: string; name: string; sensitive?: boolean; editable?: boolean };

/** A page whose `describe` (and `focused`) answers come from `next()`, called once per lookup. */
function describing(next: () => Description): (request: PageRequest) => PageResponse {
  return (request) => {
    if (request.op === 'describe' || request.op === 'focused') {
      const d = next();
      return { ok: true, op: 'describe', role: d.role, name: d.name, sensitive: d.sensitive ?? false, editable: d.editable ?? false };
    }
    return { ok: true, op: request.op } as PageResponse;
  };
}

describe('Executor: open', () => {
  it('opens a granted site in a new owned tab', async () => {
    const t = setup();
    const { promise, context } = t.run(command('open', { url: `${ORIGIN}/products` }));
    await expect(promise).resolves.toEqual({ tab: 't1', url: `${ORIGIN}/products`, title: 'Shop' });
    expect(context.sideEffect).toBe(true);
    expect(t.tabs.get('t1')).toMatchObject({ tabId: 100, grantId: GRANT_ID });
    expect(t.activities).toEqual(['start:open', 'start:open', 'start:open', 'end:open']);
  });

  it('refuses a site outside the grant without opening anything', async () => {
    const t = setup();
    await expect(t.run(command('open', { url: 'https://evil.example.test/' })).promise).rejects.toMatchObject({ code: 'origin_not_granted' });
    expect(t.api.createTab).not.toHaveBeenCalled();
  });

  it('refuses restricted pages', async () => {
    const t = setup();
    await expect(t.run(command('open', { url: 'chrome://settings' })).promise).rejects.toMatchObject({ code: 'restricted_page' });
    await expect(t.run(command('open', { url: 'file:///etc/passwd' })).promise).rejects.toMatchObject({ code: 'restricted_page' });
  });

  it('closes the tab when a redirect leaves the grant', async () => {
    const t = setup({ redirect: 'https://login.other.test/' });
    await expect(t.run(command('open', { url: `${ORIGIN}/` })).promise).rejects.toMatchObject({ code: 'origin_not_granted' });
    expect(t.api.removeTab).toHaveBeenCalledWith(100);
    expect(t.tabs.get('t1')?.closed).toBe(true);
  });
});

describe('Executor: local policy', () => {
  it('refuses while paused, and when the grant was revoked', async () => {
    const t = setup();
    t.ownTab();
    t.setControl('paused');
    await expect(t.run(command('snapshot', { tab: 't1' })).promise).rejects.toMatchObject({ code: 'device_paused' });
    t.setControl('active');
    t.setGrant(undefined);
    await expect(t.run(command('snapshot', { tab: 't1' })).promise).rejects.toMatchObject({ code: 'no_grant' });
  });

  it('refuses a tab it does not own and a tab that now shows another site', async () => {
    const t = setup();
    await expect(t.run(command('snapshot', { tab: 't1' })).promise).rejects.toMatchObject({ code: 'tab_not_owned' });
    t.ownTab('https://elsewhere.example.test/');
    await expect(t.run(command('snapshot', { tab: 't1' })).promise).rejects.toMatchObject({ code: 'origin_not_granted' });
    await expect(t.run(command('navigate', { tab: 't1', url: `${ORIGIN}/` })).promise).rejects.toMatchObject({ code: 'origin_not_granted' });
  });

  it('refuses screenshots unless the debugger is on', async () => {
    const t = setup();
    t.ownTab();
    await expect(t.run(command('screenshot', { tab: 't1' })).promise).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(opsOf(t.pageCalls)).toEqual([]);
  });

  it('takes a screenshot of a granted page and lets go of the tab after', async () => {
    const t = setup({ screenshots: true });
    t.ownTab();
    await expect(t.run(command('screenshot', { tab: 't1' })).promise).resolves.toEqual({ tab: 't1', url: `${ORIGIN}/cart`, mime: 'image/jpeg', data_base64: '/9j/AAAA' });
    expect(t.api.release).toHaveBeenCalledWith(7);
  });

  it('refuses a screenshot of a page that left the grant, before taking it', async () => {
    const t = setup({ screenshots: true });
    t.ownTab('https://elsewhere.example.test/');
    await expect(t.run(command('screenshot', { tab: 't1' })).promise).rejects.toMatchObject({ code: 'origin_not_granted' });
    expect(opsOf(t.pageCalls)).toEqual([]);
  });

  it('passes on the adapter refusing a screenshot (debugger busy)', async () => {
    const t = setup({ screenshots: true, page: () => ({ ok: false, code: 'debugger_unavailable' }) });
    t.ownTab();
    await expect(t.run(command('screenshot', { tab: 't1' })).promise).rejects.toMatchObject({ code: 'debugger_unavailable' });
    expect(t.api.release).toHaveBeenCalledWith(7);
  });

  it('refuses a screenshot above the Gateway limit', async () => {
    const t = setup({ screenshots: true, page: () => ({ ok: true, op: 'screenshot', data: 'A'.repeat(1536 * 1024 * 2) }) });
    t.ownTab();
    await expect(t.run(command('screenshot', { tab: 't1' })).promise).rejects.toMatchObject({ code: 'internal' });
  });

  it('allows one command per tab at a time', async () => {
    let release: (value: PageResponse) => void = () => undefined;
    const t = setup({
      page: (request) => {
        if (request.op === 'findText') return { ok: true, op: 'findText', found: true };
        return { ok: true, op: request.op } as PageResponse;
      },
    });
    t.ownTab();
    t.api.run = vi.fn(() => new Promise<PageResponse>((resolve) => (release = resolve)));
    const first = t.run(command('scroll', { tab: 't1', direction: 'down' }));
    await flush();
    await expect(t.run(command('scroll', { tab: 't1', direction: 'up' })).promise).rejects.toMatchObject({ code: 'busy' });
    release({ ok: true, op: 'scroll' });
    await expect(first.promise).resolves.toEqual({ tab: 't1' });
  });
});

describe('Executor: click and type', () => {
  it('rejects a ref from an older generation before touching the page', async () => {
    const t = setup();
    t.ownTab();
    t.tabs.bump(7);
    await expect(t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 })).promise).rejects.toMatchObject({ code: 'stale_ref' });
    expect(opsOf(t.pageCalls)).toEqual([]);
  });

  it('clicks a low-risk element without asking', async () => {
    const t = setup();
    t.ownTab();
    await expect(t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 })).promise).resolves.toEqual({ tab: 't1', url: `${ORIGIN}/cart`, title: 'Cart' });
    expect(opsOf(t.pageCalls)).toEqual(['watch', 'describe', 'highlight', 'click']);
    expect(t.api.release).toHaveBeenCalledWith(7);
  });

  it('still clicks when the highlight cannot be shown', async () => {
    const t = setup({
      page: (request) =>
        request.op === 'highlight'
          ? { ok: false, code: 'internal' }
          : request.op === 'describe'
            ? { ok: true, op: 'describe', role: 'button', name: 'Next', sensitive: false, editable: false }
            : ({ ok: true, op: request.op } as PageResponse),
    });
    t.ownTab();
    await expect(t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 })).promise).resolves.toMatchObject({ tab: 't1' });
    expect(opsOf(t.pageCalls)).toEqual(['watch', 'describe', 'highlight', 'click']);
  });

  it('denies a high-risk click when no side panel is open', async () => {
    const t = setup({ page: (request) => (request.op === 'describe' ? { ok: true, op: 'describe', role: 'button', name: 'Place order', sensitive: false, editable: false } : ({ ok: true, op: request.op } as PageResponse)) });
    t.ownTab();
    await expect(t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 })).promise).rejects.toMatchObject({ code: 'approval_denied' });
    expect(opsOf(t.pageCalls)).not.toContain('click');
  });

  it('asks the side panel and follows the answer', async () => {
    const t = setup({ page: (request) => (request.op === 'describe' ? { ok: true, op: 'describe', role: 'button', name: 'Delete account', sensitive: false, editable: false } : ({ ok: true, op: request.op } as PageResponse)) });
    t.ownTab();
    t.approvals.panelOpened();

    const denied = t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 }));
    await flush();
    expect(t.approvals.pending).toMatchObject([{ action: 'click', target: 'Delete account', domain: 'shop.example.test', agentName: 'Researcher', channel: 'telegram' }]);
    t.approvals.answer(pendingId(t.approvals), false);
    await expect(denied.promise).rejects.toMatchObject({ code: 'approval_denied' });
    expect(opsOf(t.pageCalls)).not.toContain('click');

    const approved = t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 }));
    await flush();
    t.approvals.answer(pendingId(t.approvals), true);
    await expect(approved.promise).resolves.toMatchObject({ tab: 't1' });
    expect(opsOf(t.pageCalls)).toContain('click');
  });

  it('denies a pending approval when the panel closes', async () => {
    const t = setup({ page: (request) => (request.op === 'describe' ? { ok: true, op: 'describe', role: 'button', name: 'Pay now', sensitive: false, editable: false } : ({ ok: true, op: request.op } as PageResponse)) });
    t.ownTab();
    t.approvals.panelOpened();
    const run = t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 }));
    await flush();
    t.approvals.panelClosed();
    await expect(run.promise).rejects.toMatchObject({ code: 'approval_denied' });
  });

  it('re-checks Pause after the approval and before the click', async () => {
    const t = setup({ page: (request) => (request.op === 'describe' ? { ok: true, op: 'describe', role: 'button', name: 'Submit', sensitive: false, editable: false } : ({ ok: true, op: request.op } as PageResponse)) });
    t.ownTab();
    t.approvals.panelOpened();
    const run = t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 }));
    await flush();
    t.setControl('paused');
    t.approvals.answer(pendingId(t.approvals), true);
    await expect(run.promise).rejects.toMatchObject({ code: 'device_paused' });
    expect(opsOf(t.pageCalls)).not.toContain('click');
  });

  it('refuses typing into a sensitive field', async () => {
    const t = setup({ page: (request) => (request.op === 'describe' ? { ok: true, op: 'describe', role: 'textbox', name: 'Password', sensitive: true, editable: true } : ({ ok: true, op: request.op } as PageResponse)) });
    t.ownTab();
    await expect(t.run(command('type', { tab: 't1', ref: 'e2', generation: 1, text: 'hunter2' })).promise).rejects.toMatchObject({ code: 'sensitive_field' });
    expect(opsOf(t.pageCalls)).not.toContain('type');
  });

  it('asks before typing with submit', async () => {
    const t = setup({ page: (request) => (request.op === 'describe' ? { ok: true, op: 'describe', role: 'textbox', name: 'Search', sensitive: false, editable: true } : ({ ok: true, op: request.op } as PageResponse)) });
    t.ownTab();
    await expect(t.run(command('type', { tab: 't1', ref: 'e2', generation: 1, text: 'shoes', submit: true })).promise).rejects.toMatchObject({ code: 'approval_denied' });
    await expect(t.run(command('type', { tab: 't1', ref: 'e2', generation: 1, text: 'shoes' })).promise).resolves.toMatchObject({ tab: 't1' });
  });

  it('reports outcome_unknown when the adapter failed after input may have reached the page', async () => {
    for (const action of ['click', 'type', 'press'] as const) {
      const t = setup({
        page: (request) => {
          if (request.op === action) return { ok: false, code: 'debugger_unavailable', effect: 'maybe' };
          if (request.op === 'describe' || request.op === 'focused') return { ok: true, op: 'describe', role: 'textbox', name: 'Search', sensitive: false, editable: true };
          return { ok: true, op: request.op } as PageResponse;
        },
      });
      t.ownTab();
      const params = action === 'press' ? { tab: 't1', key: 'Tab' as const } : action === 'type' ? { tab: 't1', ref: 'e1', generation: 1, text: 'shoes' } : { tab: 't1', ref: 'e1', generation: 1 };
      await expect(t.run(command(action, params)).promise).rejects.toMatchObject({ code: 'outcome_unknown' });
    }
  });

  it('keeps the specific code when the adapter refused before any input', async () => {
    const t = setup({ page: (request) => (request.op === 'click' ? { ok: false, code: 'origin_not_granted' } : request.op === 'describe' ? { ok: true, op: 'describe', role: 'button', name: 'Next', sensitive: false, editable: false } : ({ ok: true, op: request.op } as PageResponse)) });
    t.ownTab();
    await expect(t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 })).promise).rejects.toMatchObject({ code: 'origin_not_granted' });
  });

  it('marks a side effect only once the page action starts', async () => {
    const t = setup();
    t.ownTab();
    const controller = new AbortController();
    controller.abort();
    const run = t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 }), controller.signal);
    await expect(run.promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(run.context.sideEffect).toBe(false);
  });
});

describe('Executor: approvals', () => {
  it('asks before Enter, naming the focused element', async () => {
    const t = setup();
    t.ownTab();
    // No side panel: refused, nothing pressed.
    await expect(t.run(command('press', { tab: 't1', key: 'Enter' })).promise).rejects.toMatchObject({ code: 'approval_denied' });
    expect(opsOf(t.pageCalls)).not.toContain('press');

    t.approvals.panelOpened();
    const denied = t.run(command('press', { tab: 't1', key: 'Enter' }));
    await flush();
    expect(t.approvals.pending).toMatchObject([{ action: 'press', target: 'Message', submit: true, domain: 'shop.example.test' }]);
    t.approvals.answer(pendingId(t.approvals), false);
    await expect(denied.promise).rejects.toMatchObject({ code: 'approval_denied' });
    expect(opsOf(t.pageCalls)).not.toContain('press');

    const approved = t.run(command('press', { tab: 't1', key: 'Enter' }));
    await flush();
    t.approvals.answer(pendingId(t.approvals), true);
    await expect(approved.promise).resolves.toEqual({ tab: 't1' });
    expect(opsOf(t.pageCalls)).toContain('press');
  });

  it('presses other keys without asking', async () => {
    const t = setup();
    t.ownTab();
    await expect(t.run(command('press', { tab: 't1', key: 'Tab' })).promise).resolves.toEqual({ tab: 't1' });
    expect(opsOf(t.pageCalls)).toEqual(['watch', 'focused', 'press']);
  });

  it('sends no key at all to a password field', async () => {
    const t = setup({ page: describing(() => ({ role: 'textbox', name: 'Password', sensitive: true, editable: true })) });
    t.ownTab();
    await expect(t.run(command('press', { tab: 't1', key: 'Backspace' })).promise).rejects.toMatchObject({ code: 'sensitive_field' });
    await expect(t.run(command('press', { tab: 't1', key: 'Tab' })).promise).rejects.toMatchObject({ code: 'sensitive_field' });
    expect(opsOf(t.pageCalls)).not.toContain('press');
  });

  it('sends no key when focus is in a frame the grant does not cover', async () => {
    const t = setup({ page: (request) => (request.op === 'focused' ? { ok: false, code: 'origin_not_granted' } : ({ ok: true, op: request.op } as PageResponse)) });
    t.ownTab();
    const run = t.run(command('press', { tab: 't1', key: 'ArrowDown' }));
    await expect(run.promise).rejects.toMatchObject({ code: 'origin_not_granted' });
    expect(run.context.sideEffect).toBe(false);
    expect(opsOf(t.pageCalls)).not.toContain('press');
  });

  it('refuses Enter when focus moved while the person decided', async () => {
    const names = ['Search', 'Send payment'];
    const t = setup({ page: describing(() => ({ role: 'textbox', name: names.shift() ?? 'Send payment', editable: true })) });
    t.ownTab();
    t.approvals.panelOpened();
    const run = t.run(command('press', { tab: 't1', key: 'Enter' }));
    await flush();
    t.approvals.answer(pendingId(t.approvals), true);
    await expect(run.promise).rejects.toMatchObject({ code: 'stale_ref' });
    expect(opsOf(t.pageCalls)).not.toContain('press');
  });

  it('refuses a click when the element changed while the person decided', async () => {
    const names = ['Delete draft', 'Delete account'];
    const t = setup({ page: describing(() => ({ role: 'button', name: names.shift() ?? 'Delete account' })) });
    t.ownTab();
    t.approvals.panelOpened();
    const run = t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 }));
    await flush();
    t.approvals.answer(pendingId(t.approvals), true);
    await expect(run.promise).rejects.toMatchObject({ code: 'stale_ref' });
    expect(opsOf(t.pageCalls)).not.toContain('click');
  });

  it('shows a clipped preview of the text it would type and submit', async () => {
    const t = setup({ page: describing(() => ({ role: 'textbox', name: 'Message', editable: true })) });
    t.ownTab();
    t.approvals.panelOpened();
    const text = `Hello\n\n  there ${'x'.repeat(400)}`;
    const run = t.run(command('type', { tab: 't1', ref: 'e2', generation: 1, text, submit: true }));
    await flush();
    const [pending] = t.approvals.pending;
    expect(pending).toMatchObject({ action: 'type', target: 'Message', submit: true });
    expect(pending?.preview?.startsWith('Hello there x')).toBe(true);
    expect(pending?.preview?.length).toBe(160);
    t.approvals.answer(pendingId(t.approvals), true);
    await expect(run.promise).resolves.toMatchObject({ tab: 't1' });
    expect(t.pageCalls.find((c) => c.op === 'type')).toMatchObject({ text, submit: true });
  });

  it('gives no preview for a high-risk click', async () => {
    const t = setup({ page: describing(() => ({ role: 'button', name: 'Pay now' })) });
    t.ownTab();
    t.approvals.panelOpened();
    const run = t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 }));
    await flush();
    expect(t.approvals.pending[0]?.preview).toBeUndefined();
    t.approvals.answer(pendingId(t.approvals), false);
    await expect(run.promise).rejects.toMatchObject({ code: 'approval_denied' });
  });
});

describe('Executor: leaving the grant', () => {
  it('reports origin_not_granted when a click lands on another site', async () => {
    const t = setup();
    t.ownTab();
    const run = vi.mocked(t.api.run);
    const original = run.getMockImplementation();
    if (!original) throw new Error('the fake page has no implementation');
    run.mockImplementation(async (tabId, request) => {
      if (request.op === 'click') {
        const tab = t.browserTabs.get(7);
        if (tab) tab.url = 'https://elsewhere.example.test/';
      }
      return original(tabId, request);
    });
    const click = t.run(command('click', { tab: 't1', ref: 'e1', generation: 1 }));
    await expect(click.promise).rejects.toMatchObject({ code: 'origin_not_granted' });
    expect(click.context.sideEffect).toBe(true);
  });

  it('refuses to navigate outside the grant, to restricted pages, or from a page that left the grant', async () => {
    const t = setup();
    t.ownTab();
    await expect(t.run(command('navigate', { tab: 't1', url: 'https://evil.example.test/' })).promise).rejects.toMatchObject({ code: 'origin_not_granted' });
    await expect(t.run(command('navigate', { tab: 't1', url: 'chrome://settings' })).promise).rejects.toMatchObject({ code: 'restricted_page' });
    expect(t.api.updateTab).not.toHaveBeenCalled();
    const shown = t.browserTabs.get(7);
    if (shown) shown.url = 'https://elsewhere.example.test/';
    await expect(t.run(command('navigate', { tab: 't1', url: `${ORIGIN}/` })).promise).rejects.toMatchObject({ code: 'origin_not_granted' });
    expect(t.api.updateTab).not.toHaveBeenCalled();
  });

  it('navigates within the grant', async () => {
    const t = setup();
    t.ownTab();
    await expect(t.run(command('navigate', { tab: 't1', url: `${ORIGIN}/orders` })).promise).resolves.toEqual({ tab: 't1', url: `${ORIGIN}/orders`, title: 'Cart' });
  });

  it('refuses to open about:blank', async () => {
    const t = setup();
    await expect(t.run(command('open', { url: 'about:blank' })).promise).rejects.toMatchObject({ code: 'restricted_page' });
    expect(t.api.createTab).not.toHaveBeenCalled();
  });

  it('closes a tab created after the command was cancelled', async () => {
    const t = setup();
    const controller = new AbortController();
    vi.mocked(t.api.createTab).mockImplementationOnce(async (url: string) => {
      t.browserTabs.set(100, { id: 100, url, title: 'Shop', status: 'complete', active: false });
      controller.abort();
      return 100;
    });
    await expect(t.run(command('open', { url: `${ORIGIN}/` }), controller.signal).promise).rejects.toMatchObject({ code: 'cancelled' });
    expect(t.api.removeTab).toHaveBeenCalledWith(100);
    expect(t.tabs.get('t1')).toBeUndefined();
  });
});

describe('Executor: wait', () => {
  /** A page where the text never appears; `onLookup` runs on each look. */
  function neverFound(onLookup: (count: number) => void) {
    let lookups = 0;
    return (request: PageRequest): PageResponse => {
      if (request.op !== 'findText') return { ok: true, op: request.op } as PageResponse;
      lookups += 1;
      onLookup(lookups);
      return { ok: true, op: 'findText', found: false };
    };
  }

  it('stops waiting for text when Pause is pressed', async () => {
    let pause = () => undefined as unknown;
    const t = setup({ page: neverFound((count) => count === 2 && pause()) });
    pause = () => t.setControl('paused');
    t.ownTab();
    await expect(t.run(command('wait', { tab: 't1', text: 'Order placed' })).promise).rejects.toMatchObject({ code: 'device_paused' });
  });

  it('stops waiting for text when the grant is revoked', async () => {
    let revoke = () => undefined as unknown;
    const t = setup({ page: neverFound((count) => count === 2 && revoke()) });
    revoke = () => t.setGrant(undefined);
    t.ownTab();
    await expect(t.run(command('wait', { tab: 't1', text: 'Order placed' })).promise).rejects.toMatchObject({ code: 'no_grant' });
  });
});

describe('Executor: tabs', () => {
  it('lists owned tabs and hides the address of one that left the grant', async () => {
    const t = setup();
    t.ownTab();
    t.browserTabs.set(8, { id: 8, url: 'https://elsewhere.example.test/', title: 'Elsewhere', status: 'complete', active: false });
    t.tabs.add(8, GRANT_ID, AGENT_ID);
    await expect(t.run(command('tabs', {})).promise).resolves.toEqual({
      tabs: [
        { tab: 't1', url: `${ORIGIN}/cart`, title: 'Cart', active: true },
        { tab: 't2', url: '', title: '', active: false },
      ],
    });
  });

  it('closes an owned tab', async () => {
    const t = setup();
    t.ownTab();
    await expect(t.run(command('close', { tab: 't1' })).promise).resolves.toEqual({});
    expect(t.browserTabs.has(7)).toBe(false);
    await expect(t.run(command('snapshot', { tab: 't1' })).promise).rejects.toMatchObject({ code: 'tab_closed' });
  });
});
