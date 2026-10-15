/**
 * Connected browser on the Advanced build: the same loopback relay and site as
 * browser-control.spec.ts, with the person turning on the debugger in the side panel.
 *
 * A debugger conflict is simulated by attaching chrome.debugger to the agent's tab from the
 * extension's own service worker first. Chrome allows one client per extension per tab, so the
 * adapter's attach fails exactly as it does when DevTools or another debugging extension holds
 * the tab. Opening real DevTools is not scriptable from Playwright.
 */
import type { Page, Worker } from '@playwright/test';
import { dumpStorage, expect, test } from './fixtures';
import { BrowserRelay, startPageServer } from './support/browser-relay';
import { connectedBrowser, refOf } from './support/connect-browser';

test.use({ buildProfile: 'advanced' });

const MAX_SCREENSHOT_BYTES = 1536 * 1024;

let relay: BrowserRelay;
let site: Awaited<ReturnType<typeof startPageServer>>;
let siteOrigin: string;
let connectBrowser: ReturnType<typeof connectedBrowser>['connectBrowser'];
let run: ReturnType<typeof connectedBrowser>['run'];
let openSite: ReturnType<typeof connectedBrowser>['openSite'];

test.beforeEach(async () => {
  relay = new BrowserRelay();
  await relay.start();
  site = await startPageServer();
  siteOrigin = `http://127.0.0.1:${site.port}`;
  ({ connectBrowser, run, openSite } = connectedBrowser(relay, () => siteOrigin));
});

test.afterEach(async () => {
  await relay.stop();
  await site.stop();
});

/** Connects, then turns on the debugger opt-in in the drawer and waits for the relay to hear it. */
async function connectAdvanced(worker: Worker, openPanel: () => Promise<Page>): Promise<Page> {
  const panel = await connectBrowser(worker, openPanel);
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  const enable = drawer.getByRole('checkbox', { name: /Let agents use Chrome’s debugger/ });
  // Off by default. Enroll says what the build can do; the attach right after it says what is usable now.
  await expect(enable).not.toBeChecked();
  expect(relay.capabilities[0]).toEqual(['standard', 'advanced']);
  expect(relay.capabilities.at(-1)).toEqual(['standard']);
  // The box shows the worker's state, so it turns checked once the worker has applied the change.
  await enable.click();
  await expect(enable).toBeChecked();
  await expect.poll(() => relay.capabilities.at(-1)).toEqual(['standard', 'advanced']);
  await expect(drawer.getByRole('checkbox', { name: /When the debugger is busy/ })).toBeChecked();
  return panel;
}

/**
 * Whether the extension's debugger holds the site tab, as Chrome enforces it: Chrome allows one
 * debugger client per extension per tab, so a probe attach from the same worker fails while the
 * adapter is attached (and is detached at once otherwise). `getTargets().attached` cannot tell,
 * because Playwright's own CDP session counts as attached on every page.
 */
async function siteAttached(worker: Worker): Promise<boolean> {
  const tabId = await siteTabId(worker);
  return worker.evaluate(async (id) => {
    try {
      await chrome.debugger.attach({ tabId: id }, '1.3');
    } catch (error) {
      if (String(error).includes('Another debugger')) return true;
      throw error;
    }
    await chrome.debugger.detach({ tabId: id });
    return false;
  }, tabId);
}

async function siteTabId(worker: Worker): Promise<number> {
  const id = await worker.evaluate(async (origin) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(origin))?.id ?? -1, siteOrigin);
  if (id < 0) throw new Error('no site tab');
  return id;
}

test('the Advanced build asks for the debugger and keeps it off until the person turns it on', async ({ serviceWorker, openPanel }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions).toContain('debugger');
  await connectBrowser(serviceWorker, openPanel);
  expect(relay.capabilities).toEqual([
    ['standard', 'advanced'],
    ['standard'],
  ]);
  // Without the opt-in, screenshots are refused and reads go the standard way.
  expect(await run('open', { url: `${siteOrigin}/account` })).toMatchObject({ ok: true });
  expect(await run('screenshot', { tab: 't1' })).toMatchObject({ ok: false, error: { code: 'unsupported_capability' } });
  expect(await siteAttached(serviceWorker)).toBe(false);
});

test('reads the accessibility tree with the same redaction, acts, and lets go after each command', async ({ serviceWorker, openPanel, context }) => {
  await connectAdvanced(serviceWorker, openPanel);
  const { text, generation } = await openSite();

  expect(text).toMatch(/heading "Account"/);
  expect(text).toMatch(/\[e\d+\] textbox "Email"/);
  expect(text).toMatch(/textbox "Password" type=password value=\[redacted\]/);
  for (const secret of ['hunter2-e2e-secret', 'hidden-token-e2e', 'Hidden text e2e']) expect(text).not.toContain(secret);
  await expect.poll(() => siteAttached(serviceWorker)).toBe(false);

  expect(await run('type', { tab: 't1', ref: refOf(text, 'Email'), generation, text: 'ada@example.test' })).toMatchObject({ ok: true });
  expect(await run('type', { tab: 't1', ref: refOf(text, 'Password'), generation, text: 'guess' })).toMatchObject({ ok: false, error: { code: 'sensitive_field' } });
  expect(await run('click', { tab: 't1', ref: refOf(text, 'Next'), generation })).toMatchObject({ ok: true, result: { tab: 't1' } });
  const page = context.pages().find((p) => p.url().startsWith(siteOrigin));
  await expect(page!.locator('#status')).toHaveText('Clicked next');
  await expect(page!.locator('#email')).toHaveValue('ada@example.test');
  await expect(page!.locator('#pw')).toHaveValue('hunter2-e2e-secret');
  expect(await run('press', { tab: 't1', key: 'Tab' })).toMatchObject({ ok: true });

  // Old refs are refused, not guessed.
  expect(await run('click', { tab: 't1', ref: refOf(text, 'Next'), generation: generation + 5 })).toMatchObject({ ok: false, error: { code: 'stale_ref' } });
  await expect.poll(() => siteAttached(serviceWorker)).toBe(false);

  const stored = await dumpStorage(serviceWorker);
  for (const pageData of ['ada@example.test', 'Clicked next', 'hunter2', 'E2E Shop', 'textbox']) expect(stored).not.toContain(pageData);
});

test('takes a JPEG screenshot of the viewport under the size limit and keeps none of it', async ({ serviceWorker, openPanel }) => {
  const panel = await connectAdvanced(serviceWorker, openPanel);
  await openSite();
  const shot = await run('screenshot', { tab: 't1' });
  expect(shot).toMatchObject({ ok: true, result: { tab: 't1', url: `${siteOrigin}/account`, mime: 'image/jpeg' } });
  const data = (shot.result as { data_base64: string }).data_base64;
  const bytes = Buffer.from(data, 'base64');
  expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  expect(bytes.length).toBeLessThanOrEqual(MAX_SCREENSHOT_BYTES);
  await expect.poll(() => siteAttached(serviceWorker)).toBe(false);

  // The image is sent once: not in storage, not in the timeline.
  expect(await dumpStorage(serviceWorker)).not.toContain(data.slice(0, 64));
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  await expect(drawer.getByTestId('browser-timeline')).toContainText('screenshot');
  await expect(drawer.getByTestId('browser-tabs')).toContainText('127.0.0.1');
});

test('reads and acts inside a same-site frame, and leaves a cross-site frame out', async ({ serviceWorker, openPanel, context }) => {
  await connectAdvanced(serviceWorker, openPanel);
  const { text, generation } = await openSite('/frames', 'E2E Frames');
  expect(text).toMatch(/button "Inner button"/);
  expect(text).not.toContain('Foreign');
  expect(await run('click', { tab: 't1', ref: refOf(text, 'Inner button'), generation })).toMatchObject({ ok: true });
  const page = context.pages().find((p) => p.url().startsWith(siteOrigin));
  await expect(page!.frameLocator('iframe[title="Same site"]').getByRole('button')).toHaveText('Inner clicked');
  expect(await run('screenshot', { tab: 't1' })).toMatchObject({ ok: true });
});

test('presses keys in a background agent tab where nothing has focus', async ({ serviceWorker, openPanel }) => {
  await connectAdvanced(serviceWorker, openPanel);
  await openSite();
  const tabId = await siteTabId(serviceWorker);
  // Agent tabs open in the background; nothing on the page was focused.
  expect(await serviceWorker.evaluate(async (id) => (await chrome.tabs.get(id)).active, tabId)).toBe(false);
  expect(await run('press', { tab: 't1', key: 'PageDown' })).toMatchObject({ ok: true });
  expect(await run('press', { tab: 't1', key: 'Escape' })).toMatchObject({ ok: true });
  await expect.poll(() => siteAttached(serviceWorker)).toBe(false);
});

test('sends no key while focus is inside a cross-site frame', async ({ serviceWorker, openPanel, context }) => {
  await connectAdvanced(serviceWorker, openPanel);
  await openSite('/frames', 'E2E Frames');
  const page = context.pages().find((p) => p.url().startsWith(siteOrigin));
  await page!.bringToFront();
  await page!.frameLocator('iframe[title="Other site"]').getByRole('button', { name: 'Foreign button' }).focus();
  // The window may not hold OS focus in this run, so focus is read from the documents, not `:focus`.
  const foreignFrame = page!.frames().find((f) => f.url().includes('/foreign'));
  const focusedInFrame = () => foreignFrame!.evaluate(() => document.activeElement?.textContent ?? '');
  await expect.poll(() => page!.evaluate(() => document.activeElement?.getAttribute('title') ?? '')).toBe('Other site');
  await expect.poll(focusedInFrame).toBe('Foreign button');
  expect(await run('press', { tab: 't1', key: 'Tab' })).toMatchObject({ ok: false, error: { code: 'origin_not_granted' } });
  // Focus did not move: no key reached the frame.
  expect(await focusedInFrame()).toBe('Foreign button');
  await expect.poll(() => siteAttached(serviceWorker)).toBe(false);
});

test('sends no key while focus is inside a cross-site frame hidden in a closed shadow root', async ({ serviceWorker, openPanel, context }) => {
  await connectAdvanced(serviceWorker, openPanel);
  await openSite('/shadow-frame', 'E2E Shadow Frame');
  const page = context.pages().find((p) => p.url().startsWith(siteOrigin));
  await page!.bringToFront();
  // Locators do not reach into a closed shadow root; the frame itself is still a Playwright frame.
  await expect.poll(() => page!.frames().some((f) => f.url().includes('/foreign'))).toBe(true);
  const foreignFrame = page!.frames().find((f) => f.url().includes('/foreign'))!;
  await foreignFrame.getByRole('button', { name: 'Foreign button' }).focus();
  const focusedInFrame = () => foreignFrame.evaluate(() => document.activeElement?.textContent ?? '');
  await expect.poll(focusedInFrame).toBe('Foreign button');
  // The page itself only sees the shadow host, which is neither a frame nor a sensitive field, so
  // the check every build makes before a key lets this one through to the debugger engine.
  expect(await page!.evaluate(() => document.activeElement?.tagName)).toBe('AD-SLOT');
  // Tab needs no approval (Enter would wait for the person), and would move focus if it arrived.
  const answer = await run('press', { tab: 't1', key: 'Tab' });
  // The refusal comes from the debugger engine: only it gives this reason.
  expect(answer).toMatchObject({ ok: false, error: { code: 'origin_not_granted', message: expect.stringContaining('focus may be inside a frame the grant does not cover') } });
  expect(await foreignFrame.evaluate(() => document.body.dataset.keys ?? '')).toBe('');
  expect(await focusedInFrame()).toBe('Foreign button');
  await expect.poll(() => siteAttached(serviceWorker)).toBe(false);
});

test('reports outcome_unknown when input reached the page but the step after it failed', async ({ serviceWorker, openPanel, context }) => {
  test.setTimeout(90_000);
  await connectAdvanced(serviceWorker, openPanel);
  const { text, generation } = await openSite('/slow', 'E2E Slow');
  // The button's mousedown handler keeps the page busy past the debugger's per-command wait.
  expect(await run('click', { tab: 't1', ref: refOf(text, 'Slow button'), generation })).toMatchObject({ ok: false, error: { code: 'outcome_unknown' } });
  const page = context.pages().find((p) => p.url().startsWith(siteOrigin));
  // The press did reach the page.
  await expect(page!.getByRole('button', { name: 'Slow done' })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => siteAttached(serviceWorker), { timeout: 15_000 }).toBe(false);
});

test('answers debugger_unavailable when another debugger holds the tab, and falls back only when allowed', async ({ serviceWorker, openPanel }) => {
  const panel = await connectAdvanced(serviceWorker, openPanel);
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  expect(await run('open', { url: `${siteOrigin}/account` })).toMatchObject({ ok: true });
  const tabId = await siteTabId(serviceWorker);
  await serviceWorker.evaluate((id) => chrome.debugger.attach({ tabId: id }, '1.3'), tabId);
  try {
    // Fallback on (the default): reads and keys go the standard way; screenshots never do.
    const read = await run('snapshot', { tab: 't1' });
    expect(read).toMatchObject({ ok: true });
    expect((read.result as { text: string }).text).toMatch(/textbox "Password" type=password value=\[redacted\]/);
    expect(await run('screenshot', { tab: 't1' })).toMatchObject({ ok: false, error: { code: 'debugger_unavailable' } });

    const fallback = drawer.getByRole('checkbox', { name: /When the debugger is busy/ });
    await fallback.click();
    await expect(fallback).not.toBeChecked();
    expect(await run('snapshot', { tab: 't1' })).toMatchObject({ ok: false, error: { code: 'debugger_unavailable' } });
    expect(await run('press', { tab: 't1', key: 'Tab' })).toMatchObject({ ok: false, error: { code: 'debugger_unavailable' } });
  } finally {
    await serviceWorker.evaluate((id) => chrome.debugger.detach({ tabId: id }), tabId);
  }
  // Free again: the debugger is used once more.
  expect(await run('screenshot', { tab: 't1' })).toMatchObject({ ok: true });
});

test('revoking the grant mid-action detaches the debugger at once', async ({ serviceWorker, openPanel }) => {
  const panel = await connectAdvanced(serviceWorker, openPanel);
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  const { text, generation } = await openSite();

  // A risky click holds the debugger while it waits for the person.
  const pending = relay.command('click', { tab: 't1', ref: refOf(text, 'Delete account'), generation });
  await expect(drawer.getByTestId('browser-approval')).toBeVisible();
  await expect(drawer.getByTestId('browser-advanced-attached')).toContainText('1 tab');
  expect(await siteAttached(serviceWorker)).toBe(true);

  relay.revokeGrant(relay.activeGrant()!.grant_id);
  expect(await pending.outcome).toMatchObject({ ok: false, error: { code: 'grant_revoked' } });
  await expect.poll(() => siteAttached(serviceWorker)).toBe(false);
  await expect(drawer.getByTestId('browser-advanced-attached')).toHaveCount(0);
  await expect(drawer.getByTestId('browser-approval')).toHaveCount(0);
});

test('turning the opt-in off mid-action detaches and stops announcing advanced', async ({ serviceWorker, openPanel }) => {
  const panel = await connectAdvanced(serviceWorker, openPanel);
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  const { text, generation } = await openSite();

  const pending = relay.command('click', { tab: 't1', ref: refOf(text, 'Delete account'), generation });
  await expect(drawer.getByTestId('browser-approval')).toBeVisible();
  expect(await siteAttached(serviceWorker)).toBe(true);
  const enable = drawer.getByRole('checkbox', { name: /Let agents use Chrome’s debugger/ });
  await enable.click();
  await expect(enable).not.toBeChecked();
  expect(await pending.outcome).toMatchObject({ ok: false });
  await expect.poll(() => siteAttached(serviceWorker)).toBe(false);
  await expect.poll(() => relay.capabilities.at(-1)).toEqual(['standard']);
  expect(await run('screenshot', { tab: 't1' })).toMatchObject({ ok: false, error: { code: 'unsupported_capability' } });
});
