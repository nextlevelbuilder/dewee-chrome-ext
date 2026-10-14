import { CDP_METHODS, CdpClient, CdpFailure, isAllowedCdpMethod, type CdpMethod, type DebuggerApi } from '@/browser/adapters/cdp/cdp-client';
import type { DriverErrorCode } from '@/browser/adapters/page-driver';

function fakeDebugger(options: { attachError?: string; reply?: (method: string) => unknown } = {}) {
  let detachListener: (source: { tabId?: number }, reason: string) => void = () => undefined;
  const api = {
    attach: vi.fn(async () => {
      if (options.attachError) throw new Error(options.attachError);
    }),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async (_target: { tabId: number }, method: string) => options.reply?.(method) ?? {}),
    onDetach: { addListener: (callback: typeof detachListener) => (detachListener = callback) },
  } satisfies DebuggerApi;
  return { api, chromeDetaches: (tabId: number, reason: string) => detachListener({ tabId }, reason) };
}

function client(options: { refuse?: DriverErrorCode | null; attachError?: string; reply?: (method: string) => unknown; timeoutMs?: number } = {}) {
  const fake = fakeDebugger(options);
  let refusal: DriverErrorCode | null = options.refuse ?? null;
  const check = vi.fn(async () => refusal);
  const onDetached = vi.fn();
  const instance = new CdpClient({ debugger: fake.api, check, onDetached, timeoutMs: options.timeoutMs });
  return { instance, fake, check, onDetached, refuse: (code: DriverErrorCode | null) => (refusal = code) };
}

describe('CDP method whitelist', () => {
  it('is exactly the methods the adapter needs', () => {
    expect([...CDP_METHODS].sort()).toEqual(
      [
        'Accessibility.getFullAXTree',
        'Accessibility.getPartialAXTree',
        'DOM.describeNode',
        'DOM.enable',
        'DOM.focus',
        'DOM.getContentQuads',
        'DOM.getDocument',
        'DOM.getNodeForLocation',
        'DOM.scrollIntoViewIfNeeded',
        'Input.dispatchKeyEvent',
        'Input.dispatchMouseEvent',
        'Input.insertText',
        'Overlay.enable',
        'Overlay.hideHighlight',
        'Overlay.highlightNode',
        'Page.captureScreenshot',
        'Page.getFrameTree',
        'Page.getLayoutMetrics',
      ].sort(),
    );
  });

  it('has no script evaluation, network, storage, cookies, targets or navigation', () => {
    for (const method of CDP_METHODS) expect(method).not.toMatch(/^(Runtime|Network|Storage|Fetch|Target|Browser|Debugger|IndexedDB|CacheStorage|ServiceWorker|Emulation|Security)\./);
    for (const method of ['Runtime.evaluate', 'Runtime.callFunctionOn', 'Network.getCookies', 'Network.getAllCookies', 'Storage.getCookies', 'Page.navigate', 'Page.bringToFront', 'Target.attachToTarget', 'DOM.setAttributeValue', 'DOM.getOuterHTML', 'Input.dispatchDragEvent']) {
      expect(isAllowedCdpMethod(method)).toBe(false);
    }
  });

  it('refuses a method outside the list at runtime, even through a cast, without calling Chrome', async () => {
    const t = client();
    await t.instance.attach(1);
    await expect(t.instance.send(1, 'Runtime.evaluate' as CdpMethod, { expression: '1' })).rejects.toMatchObject({ code: 'internal' });
    expect(t.fake.api.sendCommand).not.toHaveBeenCalled();
  });
});

describe('CdpClient', () => {
  it('attaches to the tab target only after the policy check', async () => {
    const t = client({ refuse: 'device_paused' });
    await expect(t.instance.attach(1)).rejects.toMatchObject({ code: 'device_paused', beforeEffect: true });
    expect(t.fake.api.attach).not.toHaveBeenCalled();
    t.refuse(null);
    await t.instance.attach(1);
    expect(t.fake.api.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
    expect(t.instance.attachedTabs).toEqual([1]);
  });

  it('answers debugger_unavailable when Chrome refuses to attach (DevTools or another debugger)', async () => {
    const t = client({ attachError: 'Another debugger is already attached to the tab with id: 1.' });
    const error = await t.instance.attach(1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CdpFailure);
    expect(error).toMatchObject({ code: 'debugger_unavailable', beforeEffect: true });
    expect(t.instance.isAttached(1)).toBe(false);
  });

  it('attaches once when two steps ask at the same time', async () => {
    const t = client();
    await Promise.all([t.instance.attach(1), t.instance.attach(1)]);
    expect(t.fake.api.attach).toHaveBeenCalledTimes(1);
  });

  it('checks the policy before every command and detaches on a refusal', async () => {
    const t = client({ reply: () => ({ nodes: [] }) });
    await t.instance.attach(1);
    await expect(t.instance.send(1, 'Accessibility.getFullAXTree')).resolves.toEqual({ nodes: [] });
    t.refuse('grant_revoked');
    await expect(t.instance.send(1, 'Accessibility.getFullAXTree')).rejects.toMatchObject({ code: 'grant_revoked' });
    expect(t.fake.api.detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(t.instance.isAttached(1)).toBe(false);
    expect(t.fake.api.sendCommand).toHaveBeenCalledTimes(1);
  });

  it('sends nothing to a tab it is not attached to', async () => {
    const t = client();
    await expect(t.instance.send(1, 'Page.getFrameTree')).rejects.toMatchObject({ code: 'debugger_unavailable' });
    expect(t.fake.api.sendCommand).not.toHaveBeenCalled();
  });

  it('forgets a session Chrome ended and reports why', async () => {
    const t = client();
    await t.instance.attach(1);
    t.fake.chromeDetaches(1, 'canceled_by_user');
    expect(t.instance.isAttached(1)).toBe(false);
    expect(t.onDetached).toHaveBeenCalledWith(1, 'canceled_by_user');
    // A session it never held is not reported.
    t.fake.chromeDetaches(2, 'target_closed');
    expect(t.onDetached).toHaveBeenCalledTimes(1);
  });

  it('times out a command that never answers', async () => {
    const fake = fakeDebugger();
    fake.api.sendCommand.mockImplementation(() => new Promise(() => undefined));
    const instance = new CdpClient({ debugger: fake.api, check: async () => null, timeoutMs: 20 });
    await instance.attach(1);
    await expect(instance.send(1, 'Page.getFrameTree')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('detaches as soon as an attach completes when Pause or Stop asked for it while attaching', async () => {
    const t = client();
    let finish: () => void = () => undefined;
    t.fake.api.attach.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const attaching = t.instance.attach(1);
    await vi.waitFor(() => expect(t.fake.api.attach).toHaveBeenCalled());
    await t.instance.detach(1);
    expect(t.fake.api.detach).not.toHaveBeenCalled();
    finish();
    await expect(attaching).rejects.toMatchObject({ code: 'debugger_unavailable', beforeEffect: true });
    expect(t.fake.api.detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(t.instance.isAttached(1)).toBe(false);
    // A later attach is not affected.
    await t.instance.attach(1);
    expect(t.instance.isAttached(1)).toBe(true);
  });

  it('detaches a pending attach on detachAll too', async () => {
    const t = client();
    let finish: () => void = () => undefined;
    t.fake.api.attach.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const attaching = t.instance.attach(2);
    await vi.waitFor(() => expect(t.fake.api.attach).toHaveBeenCalled());
    await t.instance.detachAll();
    finish();
    await expect(attaching).rejects.toMatchObject({ code: 'debugger_unavailable' });
    expect(t.instance.attachedTabs).toEqual([]);
  });

  it('tells the policy check whether it runs for an attach or a command', async () => {
    const t = client();
    await t.instance.attach(1);
    await t.instance.send(1, 'Page.getFrameTree');
    expect(t.check.mock.calls).toEqual([
      [1, 'attach'],
      [1, 'send'],
    ]);
  });

  it('reports a dispatch only once the policy check passed', async () => {
    const t = client();
    await t.instance.attach(1);
    const onDispatch = vi.fn();
    t.refuse('grant_revoked');
    await expect(t.instance.send(1, 'Input.dispatchKeyEvent', {}, { onDispatch })).rejects.toMatchObject({ code: 'grant_revoked' });
    expect(onDispatch).not.toHaveBeenCalled();
    t.refuse(null);
    await t.instance.attach(1);
    await t.instance.send(1, 'Input.dispatchKeyEvent', {}, { onDispatch });
    expect(onDispatch).toHaveBeenCalledTimes(1);
  });

  it('sends nothing once the command is cancelled, and stops waiting for Chrome when it is', async () => {
    const t = client();
    await t.instance.attach(1);
    const controller = new AbortController();
    controller.abort();
    await expect(t.instance.send(1, 'Page.getFrameTree', {}, { signal: controller.signal })).rejects.toBeInstanceOf(CdpFailure);
    expect(t.fake.api.sendCommand).not.toHaveBeenCalled();

    const later = new AbortController();
    t.fake.api.sendCommand.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = t.instance.send(1, 'Page.getFrameTree', {}, { signal: later.signal });
    await vi.waitFor(() => expect(t.fake.api.sendCommand).toHaveBeenCalled());
    later.abort();
    await expect(pending).rejects.toBeInstanceOf(CdpFailure);
  });

  it('detaches every tab, and a forced detach asks Chrome even for a tab it does not remember', async () => {
    const t = client();
    await t.instance.attach(1);
    await t.instance.attach(2);
    await t.instance.detachAll();
    expect(t.instance.attachedTabs).toEqual([]);
    expect(t.fake.api.detach).toHaveBeenCalledTimes(2);
    await t.instance.detach(3);
    expect(t.fake.api.detach).toHaveBeenCalledTimes(2);
    await t.instance.detach(3, true);
    expect(t.fake.api.detach).toHaveBeenLastCalledWith({ tabId: 3 });
  });
});
