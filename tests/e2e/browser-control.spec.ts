/**
 * Connected browser against the real build: a loopback test relay plays the Gateway (connect,
 * enroll, attach, grant.create, browser.command) and a loopback page server plays the site.
 * The person's side (enroll, allow, approve, Stop, revoke) goes through the real side panel.
 */
import type { Page, Worker } from '@playwright/test';
import { dumpStorage, expect, test } from './fixtures';
import { AGENT, BrowserRelay, RELAY_API_KEY, startPageServer, type CommandOutcome } from './support/browser-relay';

let relay: BrowserRelay;
let site: Awaited<ReturnType<typeof startPageServer>>;
let siteOrigin: string;

test.beforeEach(async () => {
  relay = new BrowserRelay();
  await relay.start();
  site = await startPageServer();
  siteOrigin = `http://127.0.0.1:${site.port}`;
});

test.afterEach(async () => {
  await relay.stop();
  await site.stop();
});

/** A self-hosted profile with its API key and "Connected browser" on, written where the extension keeps them. */
async function seedProfile(worker: Worker): Promise<void> {
  await worker.evaluate(
    async ({ origin, key }) => {
      await chrome.storage.session.set({ 'credential:p_e2e': { kind: 'api_key', apiKey: key } });
      await chrome.storage.local.set({
        settings: {
          version: 1,
          profiles: [{ id: 'p_e2e', name: 'Local gateway', kind: 'gateway', origin, remember: false }],
          activeProfileId: 'p_e2e',
          selections: {},
          prefs: { theme: 'system', locale: 'en', showReasoning: false, showToolDetails: false, askOnSelection: false, connectedBrowser: true },
        },
      });
    },
    { origin: relay.origin, key: RELAY_API_KEY },
  );
}

/** Registers this browser and allows the test agent on the loopback site, through the side panel. */
async function connectBrowser(worker: Worker, openPanel: () => Promise<Page>, capability: 'read' | 'control' = 'control'): Promise<Page> {
  await seedProfile(worker);
  const panel = await openPanel();
  await panel.getByTestId('browser-toggle').click();
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  await expect(drawer.getByTestId('browser-status')).toHaveText('Connected');
  await expect(drawer.getByLabel('Device name')).not.toHaveValue('');
  await drawer.getByRole('button', { name: 'Register this browser' }).click();
  await expect(drawer.getByTestId('browser-device-name')).toBeVisible();
  await drawer.getByRole('checkbox', { name: AGENT.name }).check();
  await drawer.getByLabel('Sites, one per line').fill(siteOrigin);
  if (capability === 'control') await drawer.getByRole('radio', { name: /Read and act/ }).check();
  await drawer.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(drawer.getByTestId('browser-grants')).toContainText(siteOrigin);
  expect(relay.activeGrant()).toMatchObject({ origins: [siteOrigin], agent_ids: [AGENT.id] });
  return panel;
}

async function run(action: string, params: Record<string, unknown>, options?: Parameters<BrowserRelay['command']>[2]): Promise<CommandOutcome> {
  const { commandId, outcome } = relay.command(action, params, options);
  const result = await outcome;
  // Acknowledged after validation, before the result.
  expect(relay.acks).toContain(commandId);
  return result;
}

function refOf(text: string, name: string): string {
  const ref = text.split('\n').find((line) => /\[e\d+\]/.test(line) && line.includes(`"${name}"`))?.match(/\[(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`no ref for ${name} in:\n${text}`);
  return ref;
}

async function openSite(): Promise<{ tab: string; text: string; generation: number }> {
  const opened = await run('open', { url: `${siteOrigin}/account` });
  expect(opened).toMatchObject({ ok: true, result: { tab: 't1', url: `${siteOrigin}/account`, title: 'E2E Shop' } });
  const snap = await run('snapshot', { tab: 't1' });
  expect(snap.ok).toBe(true);
  const result = snap.result as { text: string; generation: number };
  return { tab: 't1', text: result.text, generation: result.generation };
}

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
  expect(await waiting.outcome).toMatchObject({ ok: false, error: { code: 'cancelled' } });
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
