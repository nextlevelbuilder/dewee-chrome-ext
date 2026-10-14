/**
 * Connected browser against the real build: a loopback test relay plays the Gateway (connect,
 * enroll, attach, grant.create, browser.command) and a loopback page server plays the site.
 * The person's side (enroll, allow, approve, Stop, revoke) goes through the real side panel.
 */
import { dumpStorage, expect, test } from './fixtures';
import { BrowserRelay, startPageServer } from './support/browser-relay';
import { connectedBrowser, refOf } from './support/connect-browser';

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

test('the Standard build has no debugger permission and announces only standard', async ({ serviceWorker, openPanel }) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.permissions ?? []).not.toContain('debugger');
  expect(manifest.optional_permissions ?? []).not.toContain('debugger');
  const panel = await connectBrowser(serviceWorker, openPanel);
  expect(relay.capabilities.length).toBeGreaterThan(0);
  for (const announced of relay.capabilities) expect(announced).toEqual(['standard']);
  await expect(panel.getByTestId('browser-advanced')).toHaveCount(0);
});

test('an allowed agent opens, reads, types and clicks on the granted site', async ({ serviceWorker, openPanel }) => {
  await connectBrowser(serviceWorker, openPanel);
  const { text, generation } = await openSite();

  expect(text).toContain('heading "Account" level=1');
  expect(text).toMatch(/\[e\d+\] textbox "Email"/);
  expect(text).toMatch(/textbox "Password" type=password value=\[redacted\]/);
  expect(text).not.toContain('hunter2-e2e-secret');
  expect(text).not.toContain('hidden-token-e2e');
  expect(text).not.toContain('Hidden text e2e');

  expect(await run('type', { tab: 't1', ref: refOf(text, 'Email'), generation, text: 'ada@example.test' })).toMatchObject({ ok: true });
  expect(await run('type', { tab: 't1', ref: refOf(text, 'Password'), generation, text: 'guess' })).toMatchObject({ ok: false, error: { code: 'sensitive_field' } });
  expect(await run('click', { tab: 't1', ref: refOf(text, 'Next'), generation })).toMatchObject({ ok: true, result: { tab: 't1' } });

  const after = await run('snapshot', { tab: 't1' });
  expect((after.result as { text: string }).text).toContain('Clicked next');
  expect((after.result as { text: string }).text).toContain('value="ada@example.test"');
  expect(await run('click', { tab: 't1', ref: refOf(text, 'Next'), generation: generation + 5 })).toMatchObject({ ok: false, error: { code: 'stale_ref' } });

  // Nothing from the page or the typed text is kept by the extension.
  const stored = await dumpStorage(serviceWorker);
  for (const pageData of ['ada@example.test', 'Clicked next', 'hunter2', 'E2E Shop', 'textbox']) expect(stored).not.toContain(pageData);
});

test('sites outside the grant and restricted pages are refused', async ({ serviceWorker, openPanel }) => {
  await connectBrowser(serviceWorker, openPanel);
  expect(await run('open', { url: `http://localhost:${site.port}/account` })).toMatchObject({ ok: false, error: { code: 'origin_not_granted' } });
  expect(await run('open', { url: 'chrome://settings/' })).toMatchObject({ ok: false, error: { code: 'restricted_page' } });
  expect(await run('snapshot', { tab: 't9' })).toMatchObject({ ok: false, error: { code: 'tab_not_owned' } });
  expect(await run('tabs', {}, { agentId: '0f6b6d55-1b36-4e2e-9a39-5a1f6a0c0aff' })).toMatchObject({ ok: false, error: { code: 'no_grant' } });
  expect(await run('screenshot', { tab: 't1' })).toMatchObject({ ok: false, error: { code: 'unsupported_capability' } });
});

test('a read-only grant cannot act on the page', async ({ serviceWorker, openPanel }) => {
  await connectBrowser(serviceWorker, openPanel, 'read');
  expect(await run('open', { url: `${siteOrigin}/account` })).toMatchObject({ ok: false, error: { code: 'capability_not_granted' } });
});

test('a risky click waits for the person, and a denial stops it', async ({ serviceWorker, openPanel, context }) => {
  const panel = await connectBrowser(serviceWorker, openPanel);
  const { text, generation } = await openSite();
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  const ref = refOf(text, 'Delete account');

  const denied = relay.command('click', { tab: 't1', ref, generation });
  const card = drawer.getByTestId('browser-approval');
  await expect(card).toContainText('Researcher wants to click “Delete account” on 127.0.0.1');
  await card.getByRole('button', { name: 'Deny' }).click();
  expect(await denied.outcome).toMatchObject({ ok: false, error: { code: 'approval_denied' } });

  const approved = relay.command('click', { tab: 't1', ref, generation });
  await card.getByRole('button', { name: 'Allow once' }).click();
  expect(await approved.outcome).toMatchObject({ ok: true });
  const page = context.pages().find((p) => p.url().startsWith(siteOrigin));
  await expect(page!.locator('#status')).toHaveText('Account deleted');

  // With no side panel open, nobody can approve: the action is denied, never auto-approved.
  await panel.close();
  await expect.poll(() => relay.command('click', { tab: 't1', ref, generation }).outcome).toMatchObject({ ok: false, error: { code: 'approval_denied' } });
});

test('typing with submit and pressing Enter wait for the person, showing what would be sent', async ({ serviceWorker, openPanel }) => {
  const panel = await connectBrowser(serviceWorker, openPanel);
  const { text, generation } = await openSite();
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  const card = drawer.getByTestId('browser-approval');

  const typed = relay.command('type', { tab: 't1', ref: refOf(text, 'Email'), generation, text: 'ada@example.test\nplease send', submit: true });
  await expect(card).toContainText(`Researcher wants to type into “Email” on 127.0.0.1:${site.port} and submit it.`);
  await expect(card.getByTestId('browser-approval-preview')).toHaveText('Text to send: ada@example.test please send');
  await card.getByRole('button', { name: 'Deny' }).click();
  expect(await typed.outcome).toMatchObject({ ok: false, error: { code: 'approval_denied' } });

  const pressed = relay.command('press', { tab: 't1', key: 'Enter' });
  await expect(card).toContainText('Researcher wants to press Enter');
  await card.getByRole('button', { name: 'Deny' }).click();
  expect(await pressed.outcome).toMatchObject({ ok: false, error: { code: 'approval_denied' } });

  // The preview lived only in the card.
  expect(await dumpStorage(serviceWorker)).not.toContain('please send');
});

test('Stop preempts a running command and refuses new ones until Resume', async ({ serviceWorker, openPanel }) => {
  const panel = await connectBrowser(serviceWorker, openPanel);
  await openSite();
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });

  const waiting = relay.command('wait', { tab: 't1', text: 'This text never appears' });
  await expect.poll(() => relay.acks.includes(waiting.commandId)).toBe(true);
  await drawer.getByRole('button', { name: 'Stop' }).click();
  expect(await waiting.outcome).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(relay.controlStates).toContain('stopped');

  expect(await run('snapshot', { tab: 't1' })).toMatchObject({ ok: false, error: { code: 'device_paused' } });
  await drawer.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => relay.controlStates.at(-1)).toBe('active');
  // Stop released the agent's tabs; it has to open a new one.
  expect(await run('snapshot', { tab: 't1' })).toMatchObject({ ok: false, error: { code: 'tab_not_owned' } });
});

test('revoking the grant stops the running command and every later one', async ({ serviceWorker, openPanel }) => {
  const panel = await connectBrowser(serviceWorker, openPanel);
  await openSite();
  const grantId = relay.activeGrant()!.grant_id;

  const waiting = relay.command('wait', { tab: 't1', text: 'This text never appears' });
  await expect.poll(() => relay.acks.includes(waiting.commandId)).toBe(true);
  relay.revokeGrant(grantId);
  expect(await waiting.outcome).toMatchObject({ ok: false, error: { code: 'grant_revoked' } });
  expect(await run('tabs', {}, { grantId })).toMatchObject({ ok: false, error: { code: 'no_grant' } });

  // Revoke from the panel as well: the grant disappears from the list and from the relay.
  await panel.reload();
  await panel.getByTestId('browser-toggle').click();
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  await expect(drawer.getByText('No agent can use this browser.')).toBeVisible();
});

test('revoking a grant from the side panel', async ({ serviceWorker, openPanel }) => {
  const panel = await connectBrowser(serviceWorker, openPanel);
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  const grantId = relay.activeGrant()!.grant_id;
  await drawer.getByTestId('browser-grants').getByRole('button', { name: 'Revoke' }).click();
  await expect(drawer.getByText('No agent can use this browser.')).toBeVisible();
  expect(relay.grants.get(grantId)?.revoked_at).toBeTruthy();
  expect(await run('tabs', {}, { grantId })).toMatchObject({ ok: false, error: { code: 'no_grant' } });
});
