import type { DriverErrorCode, DriverRequest, DriverResponse } from '@/browser/adapters/page-driver';
import type { BrowserApi } from '@/browser/chrome-api';
import { EngineRouter, type AdvancedEngine, type DebuggerPrefs } from '@/browser/engine-router';
import { ORIGIN } from './fixtures';

const origins = [ORIGIN];

function setup(options: { prefs?: DebuggerPrefs; attach?: DriverErrorCode | null; withCdp?: boolean } = {}) {
  const log: string[] = [];
  const answer = (engine: string, request: DriverRequest): DriverResponse => {
    log.push(`${engine}:${request.op}`);
    if (request.op === 'snapshot') return { ok: true, op: 'snapshot', text: engine, url: `${ORIGIN}/`, title: '' };
    if (request.op === 'screenshot') return engine === 'cdp' ? { ok: true, op: 'screenshot', data: 'x' } : { ok: false, code: 'unsupported_capability' };
    return { ok: true, op: request.op } as DriverResponse;
  };
  const standard: BrowserApi = {
    createTab: async () => 1,
    updateTab: async () => undefined,
    removeTab: async () => undefined,
    getTab: async () => null,
    hasHostPermission: async () => true,
    run: async (_tabId, request) => answer('standard', request),
  };
  let attach: DriverErrorCode | null = options.attach ?? null;
  const cdp: AdvancedEngine = {
    attachedTabs: [],
    prepare: vi.fn(async () => attach),
    run: vi.fn(async (_tabId: number, request: DriverRequest) => (attach ? { ok: false, code: attach } : answer('cdp', request)) as DriverResponse),
    release: vi.fn(async () => undefined),
    forget: vi.fn(),
    forceDetach: vi.fn(async () => undefined),
    detachAll: vi.fn(async () => undefined),
    isDispatching: () => false,
  };
  let prefs: DebuggerPrefs = options.prefs ?? { enabled: true, fallback: true };
  const router = new EngineRouter(standard, () => prefs, options.withCdp === false ? undefined : cdp);
  return { router, log, cdp, setPrefs: (next: DebuggerPrefs) => (prefs = next), setAttach: (code: DriverErrorCode | null) => (attach = code) };
}

describe('EngineRouter', () => {
  it('uses Standard for everything when the debugger is off, and never screenshots', async () => {
    const t = setup({ prefs: { enabled: false, fallback: true } });
    await t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 });
    await t.router.run(1, { op: 'click', origins, generation: 1, ref: 'e1' });
    await expect(t.router.run(1, { op: 'screenshot', origins })).resolves.toEqual({ ok: false, code: 'unsupported_capability' });
    expect(t.log).toEqual(['standard:snapshot', 'standard:click']);
    expect(t.cdp.prepare).not.toHaveBeenCalled();
  });

  it('has no Advanced engine in a Standard build', async () => {
    const t = setup({ withCdp: false });
    expect(t.router.advancedAvailable).toBe(false);
    await expect(t.router.run(1, { op: 'screenshot', origins })).resolves.toEqual({ ok: false, code: 'unsupported_capability' });
    await t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 });
    expect(t.log).toEqual(['standard:snapshot']);
  });

  it('sends ref actions to the engine whose snapshot handed out the refs', async () => {
    const t = setup();
    await t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 });
    await t.router.run(1, { op: 'click', origins, generation: 1, ref: 'e1' });
    // Scrolling and waiting stay with the page script.
    await t.router.run(1, { op: 'scroll', origins, direction: 'down', amount: 'page' });
    await t.router.run(1, { op: 'findText', origins, text: 'x' });
    expect(t.log).toEqual(['cdp:snapshot', 'cdp:click', 'standard:scroll', 'standard:findText']);
  });

  it('makes refs stale when the engine changes within a generation', async () => {
    const t = setup({ prefs: { enabled: false, fallback: true } });
    await t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 });
    t.setPrefs({ enabled: true, fallback: true });
    await expect(t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 })).resolves.toEqual({ ok: false, code: 'stale_ref' });
    await expect(t.router.run(1, { op: 'snapshot', origins, generation: 2, maxChars: 100 })).resolves.toMatchObject({ ok: true, text: 'cdp' });
    // Turned off again: debugger refs are not resolved by the page script.
    t.setPrefs({ enabled: false, fallback: true });
    await expect(t.router.run(1, { op: 'click', origins, generation: 2, ref: 'e1' })).resolves.toEqual({ ok: false, code: 'stale_ref' });
    expect(t.log).not.toContain('standard:click');
  });

  it('falls back to Standard when the debugger cannot attach and fallback is allowed', async () => {
    const t = setup({ attach: 'debugger_unavailable' });
    await expect(t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 })).resolves.toMatchObject({ ok: true, text: 'standard' });
    await t.router.run(1, { op: 'press', origins, key: 'Tab' });
    expect(t.log).toEqual(['standard:snapshot', 'standard:press']);
  });

  it('answers debugger_unavailable without fallback, and for screenshots always', async () => {
    const t = setup({ prefs: { enabled: true, fallback: false }, attach: 'debugger_unavailable' });
    await expect(t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 })).resolves.toEqual({ ok: false, code: 'debugger_unavailable' });
    await expect(t.router.run(1, { op: 'press', origins, key: 'Tab' })).resolves.toEqual({ ok: false, code: 'debugger_unavailable' });
    t.setPrefs({ enabled: true, fallback: true });
    await expect(t.router.run(1, { op: 'screenshot', origins })).resolves.toEqual({ ok: false, code: 'debugger_unavailable' });
    expect(t.log).toEqual([]);
  });

  it('asks for a new snapshot when the debugger is lost before a click on its refs', async () => {
    const t = setup();
    await t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 });
    t.setAttach('debugger_unavailable');
    await expect(t.router.run(1, { op: 'describe', origins, generation: 1, ref: 'e1' })).resolves.toEqual({ ok: false, code: 'stale_ref' });
  });

  it('never falls back on a policy refusal', async () => {
    const t = setup({ attach: 'grant_revoked' });
    await expect(t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 })).resolves.toEqual({ ok: false, code: 'grant_revoked' });
    expect(t.log).toEqual([]);
  });

  it('forgets a tab and lets the debugger go', async () => {
    const t = setup();
    await t.router.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 100 });
    await t.router.forget(1);
    expect(t.cdp.forget).toHaveBeenCalledWith(1);
    expect(t.cdp.release).toHaveBeenCalledWith(1);
    expect(t.router.engineFor(1, 1)).toBe('standard');
  });
});
