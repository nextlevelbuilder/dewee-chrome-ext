// Connected browser end to end: the real built extension, a real local Dewee Gateway and the stub
// model, which calls the `browser` tool with target "connected" as scripted. A loopback page server
// plays the site. The person's side (turning the feature on, registering, allowing, approving,
// revoking, Stop) goes through the real options page and side panel.
//
// Optional env (the checks are skipped without them):
//   E2E_DEWEE_CLI    path of the `dewee` CLI (or DEWEE_BIN): device list, cleanup and trace checks
//   E2E_GATEWAY_LOG  path of the Gateway's log file, grepped for the typed text
import type { Page, Worker } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dumpStorage, expect, test } from './fixtures';
import { startPageServer } from './support/browser-relay';
import {
  ADMIN_TOKEN,
  API_KEY,
  GATEWAY,
  SHOTS,
  WORKSPACE,
  adminOk,
  connect,
  marker,
  rememberedSession,
  requireLiveGateway,
  scriptToolCalls,
  send,
  turnToolResults,
  type ToolCall,
} from './support/live';

requireLiveGateway(true);
test.setTimeout(300_000);

const DEWEE_CLI = process.env.E2E_DEWEE_CLI ?? process.env.DEWEE_BIN ?? '';
const hasCli = Boolean(DEWEE_CLI && existsSync(DEWEE_CLI));
const GATEWAY_LOG = process.env.E2E_GATEWAY_LOG ?? '';
const FLAG_ROUTE = '/v1/tools/builtin/browser/tenant-config';

/** Runs the CLI with the personal key (browser commands) or the admin token (traces). Never prints either. */
function cli(args: string[], auth: 'personal' | 'admin'): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GOCLAW_GATEWAY_URL: GATEWAY, GOCLAW_SERVER: GATEWAY, GOCLAW_TENANT_ID: WORKSPACE, GOCLAW_GATEWAY_TOKEN: auth === 'personal' ? API_KEY : ADMIN_TOKEN };
  delete env.DEWEE_API_KEY;
  delete env.DEWEE_SERVER;
  return execFileSync(DEWEE_CLI, args, { env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

interface CliDevice {
  id: string;
  name: string;
  online: boolean;
  state?: string;
}

const listDevices = (): CliDevice[] => JSON.parse(cli(['browser', 'devices', 'list', '--json'], 'personal')) as CliDevice[];

const setFlag = (connected: boolean) => adminOk('PUT', FLAG_ROUTE, { settings: { connected } });

const browserCall = (args: Record<string, unknown>): ToolCall => ({ name: 'browser', arguments: { target: 'connected', ...args } });

let turns = 0;

/** Sends a chat turn whose model calls `calls` in order; returns the tool results it received, without the ledger's. */
async function ask(panel: Page, label: string, calls: ToolCall[]): Promise<string[]> {
  const m = marker(label);
  await scriptToolCalls(m, calls);
  await send(panel, `${m} please use my browser`);
  // One result per call plus the task ledger's; the last model call (which sees them all) follows.
  await expect.poll(async () => (await turnToolResults(m)).length, { timeout: 90_000 }).toBe(calls.length + 1);
  turns += 1;
  await expect(panel.locator('li.message.message-assistant', { hasText: 'tool result:' })).toHaveCount(turns, { timeout: 30_000 });
  return (await turnToolResults(m)).slice(1);
}

function refOf(snapshot: string, name: string): string {
  const ref = snapshot.split('\n').find((line) => /\[e\d+\]/.test(line) && line.includes(`"${name}"`))?.match(/\[(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`no ref for ${name} in the snapshot`);
  return ref;
}

function generationOf(snapshot: string): number {
  const generation = snapshot.match(/Generation: (\d+)/)?.[1];
  if (!generation) throw new Error('no generation in the snapshot');
  return Number(generation);
}

type Span = Record<string, unknown> & { metadata?: unknown; input_preview?: unknown };

/** Every span in a trace whose metadata names a browser action (connected browser tool calls). */
function browserSpans(node: unknown): Span[] {
  if (Array.isArray(node)) return node.flatMap(browserSpans);
  if (!node || typeof node !== 'object') return [];
  const record = node as Span;
  const own = record.metadata !== undefined && metaOf(record).includes('browser_action') ? [record] : [];
  return [...own, ...Object.values(record).flatMap(browserSpans)];
}

/** A span's metadata as compact JSON, whether the trace carries it as an object or as a JSON string. */
function metaOf(span: Span): string {
  if (typeof span.metadata !== 'string') return JSON.stringify(span.metadata ?? null);
  try {
    return JSON.stringify(JSON.parse(span.metadata));
  } catch {
    return span.metadata;
  }
}

async function deviceIdOf(worker: Worker): Promise<string> {
  const storage = JSON.parse(await dumpStorage(worker)) as { local: Record<string, unknown> };
  const record = Object.entries(storage.local).find(([key]) => key.startsWith('browserDevice:'))?.[1] as { device_id?: string } | undefined;
  if (!record?.device_id) throw new Error('no registered device');
  return record.device_id;
}

async function openDrawer(panel: Page) {
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  if (!(await drawer.isVisible())) await panel.getByTestId('browser-toggle').click();
  await expect(drawer).toBeVisible();
  return drawer;
}

async function closeDrawer(panel: Page): Promise<void> {
  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  if (await drawer.isVisible()) await drawer.getByRole('button', { name: 'Close' }).first().click();
  await expect(drawer).toBeHidden();
}

async function allow(panel: Page, agentName: string, origin: string): Promise<void> {
  const drawer = await openDrawer(panel);
  await drawer.getByRole('checkbox', { name: agentName }).check();
  await drawer.getByLabel('Sites, one per line').fill(origin);
  await drawer.getByRole('radio', { name: /Read and act/ }).check();
  await drawer.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(drawer.getByTestId('browser-grants').locator('li', { hasText: agentName })).toContainText(origin);
}

let site: Awaited<ReturnType<typeof startPageServer>>;

test.beforeAll(async () => {
  site = await startPageServer();
  // Start from a known state: the feature off and no devices left from earlier runs (10 per person).
  await setFlag(false);
  if (hasCli) for (const device of listDevices()) cli(['browser', 'devices', 'revoke', device.id, '--force'], 'personal');
});

test.afterAll(async () => {
  await site?.stop();
  await setFlag(false).catch(() => undefined);
});

test('an agent drives the person’s own Chrome only as far as the person allows', async ({ context, serviceWorker, openPanel, openOptions }) => {
  const siteOrigin = `http://127.0.0.1:${site.port}`;
  const sitePage = () => context.pages().find((p) => p.url().startsWith(siteOrigin));
  const typed = `ada-${Date.now().toString(36)}@example.test`;
  const sendText = `send-${Date.now().toString(36)} please`;
  let deviceId = '';

  const panel = await openPanel();
  await connect(panel);
  const options = await openOptions();
  // The checkbox follows the saved settings, so it turns on after the write, not on the click itself.
  const toggle = options.getByRole('checkbox', { name: /Connected browser/ });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await options.close();
  await expect(panel.getByTestId('browser-toggle')).toBeVisible();

  await test.step('feature flag off: the tool refuses and nothing reaches the extension', async () => {
    const drawer = await openDrawer(panel);
    await expect(drawer.getByTestId('browser-status')).toHaveText('Connected');
    await drawer.getByRole('button', { name: 'Register this browser' }).click();
    await expect(drawer.getByText('Connected browsing is turned off for this workspace').first()).toBeVisible();
    await panel.screenshot({ path: `${SHOTS}/cb-1-flag-off.png` });
    await closeDrawer(panel);

    const [result] = await ask(panel, 'cb flag off', [browserCall({ action: 'open', targetUrl: `${siteOrigin}/account` })]);
    expect(result).toContain('connected browser error [permission_denied]');
    expect(result).toContain('not enabled');
    expect(sitePage()).toBeUndefined();
    await expect(panel.getByTestId('browser-approval')).toHaveCount(0);
  });

  await test.step('turn the flag on, register this browser', async () => {
    await setFlag(true);
    const drawer = await openDrawer(panel);
    // The Gateway may cache the setting briefly; registering is safe to retry until it applies.
    await expect(async () => {
      await drawer.getByRole('button', { name: 'Register this browser' }).click();
      await expect(drawer.getByTestId('browser-device-name')).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    deviceId = await deviceIdOf(serviceWorker);
  });

  await test.step('a grant for another agent does not let Super Agent in', async () => {
    await allow(panel, 'E2E Helper', siteOrigin);
    await closeDrawer(panel);
    const [result] = await ask(panel, 'cb other agent', [browserCall({ action: 'open', targetUrl: `${siteOrigin}/account` })]);
    expect(result).toContain('connected browser error [no_grant]');
    expect(sitePage()).toBeUndefined();
  });

  let snapshot = '';
  await test.step('allow Super Agent; it opens and reads the page, with the password redacted', async () => {
    await allow(panel, 'Super Agent', siteOrigin);
    await panel.screenshot({ path: `${SHOTS}/cb-2-granted.png` });
    await closeDrawer(panel);
    const [opened, read] = await ask(panel, 'cb open', [browserCall({ action: 'open', targetUrl: `${siteOrigin}/account` }), browserCall({ action: 'snapshot', targetId: 't1' })]);
    expect(opened).toContain('Tab: t1');
    expect(read).toContain('Tab: t1');
    expect(read).toMatch(/\[e\d+\] textbox "Email"/);
    expect(read).toMatch(/textbox "Password" type=password value=\[redacted\]/);
    expect(read).toContain('button "Next"');
    expect(read).not.toContain('hunter2-e2e-secret');
    expect(read).not.toContain('hidden-token-e2e');
    snapshot = read ?? '';
    await expect.poll(() => sitePage()?.url()).toBe(`${siteOrigin}/account`);
  });

  await test.step('it clicks and types, and the page changes', async () => {
    const generation = generationOf(snapshot);
    const [clicked, typedResult, after] = await ask(panel, 'cb act', [
      browserCall({ action: 'act', targetId: 't1', request: { kind: 'click', ref: refOf(snapshot, 'Next'), generation } }),
      browserCall({ action: 'act', targetId: 't1', request: { kind: 'type', ref: refOf(snapshot, 'Email'), generation, text: typed } }),
      browserCall({ action: 'snapshot', targetId: 't1' }),
    ]);
    expect(clicked).toContain('Done.');
    expect(typedResult).toContain('Done.');
    expect(after).toContain('Clicked next');
    expect(after).toContain(`value="${typed}"`);
    expect(after).not.toContain('hunter2-e2e-secret');
    const page = sitePage()!;
    await expect(page.locator('#status')).toHaveText('Clicked next');
    await expect(page.locator('#email')).toHaveValue(typed);
    await page.screenshot({ path: `${SHOTS}/cb-3-page-after.png` });
  });

  await test.step('a site outside the grant is refused', async () => {
    const [result] = await ask(panel, 'cb other site', [browserCall({ action: 'open', targetUrl: `http://localhost:${site.port}/account` })]);
    expect(result).toContain('connected browser error [origin_not_granted]');
  });

  await test.step('typing with submit waits for the person; a denial reaches the model', async () => {
    const m = marker('cb submit');
    const generation = generationOf(snapshot);
    await scriptToolCalls(m, [browserCall({ action: 'act', targetId: 't1', request: { kind: 'type', ref: refOf(snapshot, 'Email'), generation, text: sendText, submit: true } })]);
    await send(panel, `${m} please use my browser`);
    const card = panel.getByTestId('browser-approval');
    await expect(card).toContainText(`wants to type into “Email” on 127.0.0.1:${site.port} and submit it.`, { timeout: 60_000 });
    await expect(card.getByTestId('browser-approval-preview')).toHaveText(`Text to send: ${sendText}`);
    await panel.screenshot({ path: `${SHOTS}/cb-4-approval.png` });
    await card.getByRole('button', { name: 'Deny' }).click();
    await expect.poll(async () => (await turnToolResults(m)).length, { timeout: 60_000 }).toBe(2);
    turns += 1;
    expect((await turnToolResults(m))[1]).toContain('connected browser error [approval_denied]');
    await expect(sitePage()!.locator('#status')).toHaveText('Clicked next');
    await expect(panel.locator('li.message.message-assistant', { hasText: 'tool result:' })).toHaveCount(turns, { timeout: 30_000 });
  });

  await test.step('revoking the grant in the side panel refuses the next command', async () => {
    const drawer = await openDrawer(panel);
    await drawer.getByTestId('browser-grants').locator('li', { hasText: 'Super Agent' }).getByRole('button', { name: 'Revoke' }).click();
    await expect(drawer.getByTestId('browser-grants').locator('li', { hasText: 'Super Agent' })).toHaveCount(0);
    await closeDrawer(panel);
    const [result] = await ask(panel, 'cb revoked', [browserCall({ action: 'snapshot', targetId: 't1' })]);
    expect(result).toContain('connected browser error [grant_revoked]');
  });

  await test.step('Stop refuses commands with device_paused until Resume', async () => {
    await allow(panel, 'Super Agent', siteOrigin);
    const drawer = await openDrawer(panel);
    await drawer.getByRole('button', { name: 'Stop' }).click();
    await expect(drawer.getByText('Stopped: agents cannot use this browser')).toBeVisible();
    await panel.screenshot({ path: `${SHOTS}/cb-5-stopped.png` });
    await closeDrawer(panel);
    // The Gateway learns the state over the socket; poll until it applies it.
    let result = '';
    await expect(async () => {
      result = (await ask(panel, 'cb stopped', [browserCall({ action: 'open', targetUrl: `${siteOrigin}/account` })]))[0] ?? '';
      expect(result).toContain('connected browser error [device_paused]');
    }).toPass({ timeout: 60_000 });
    const resumed = await openDrawer(panel);
    await resumed.getByRole('button', { name: 'Resume' }).click();
    await expect(resumed.getByText('Stopped: agents cannot use this browser')).toHaveCount(0);
  });

  await test.step('the Gateway lists the device; traces record browser calls without typed text', async () => {
    const stored = await dumpStorage(serviceWorker);
    for (const pageData of [typed, sendText, 'Clicked next', 'hunter2', 'textbox']) expect(stored).not.toContain(pageData);
    if (GATEWAY_LOG && existsSync(GATEWAY_LOG)) {
      const log = readFileSync(GATEWAY_LOG, 'utf8');
      expect(log.includes(sendText), 'the denied text is not in the Gateway log').toBe(false);
    }
    if (!hasCli) {
      test.info().annotations.push({ type: 'skipped', description: 'Set E2E_DEWEE_CLI to check devices and traces through the CLI.' });
      return;
    }

    const device = listDevices().find((item) => item.id === deviceId);
    expect(device).toMatchObject({ id: deviceId, online: true });
    const grants = JSON.parse(cli(['browser', 'grants', 'list', '--device', deviceId, '--json'], 'personal')) as { agent_ids: string[]; origins: string[] }[];
    expect(grants.length).toBe(2);
    for (const grant of grants) expect(grant.origins).toEqual([siteOrigin]);

    const session = await rememberedSession(serviceWorker);
    const listed = cli(['traces', 'list', '--session', session, '--limit', '50', '-o', 'json'], 'admin');
    const ids = [...new Set([...listed.matchAll(/"id":\s*"([0-9a-f-]{36})"/g)].map((match) => match[1] ?? ''))].filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    const spans = ids.flatMap((id) => browserSpans(JSON.parse(cli(['traces', 'get', id, '-o', 'json'], 'admin'))));
    const actions = spans.map(metaOf);
    for (const action of ['open', 'snapshot', 'click', 'type']) expect(actions.some((m) => m.includes(`"browser_action":"${action}"`))).toBe(true);
    expect(actions.some((m) => m.includes('approval_denied'))).toBe(true);
    // Browser span inputs are redacted, and an action span carries no typed text at all. Only a
    // snapshot's output may show the text, because the page shows it.
    for (const span of spans) {
      expect(String(span.input_preview ?? '')).not.toContain(typed);
      expect(JSON.stringify(span)).not.toContain(sendText);
      if (!metaOf(span).includes('"browser_action":"snapshot"')) expect(JSON.stringify(span)).not.toContain(typed);
    }
  });

  await test.step('revoke the device from the side panel', async () => {
    const drawer = await openDrawer(panel);
    panel.once('dialog', (dialog) => void dialog.accept());
    await drawer.getByRole('button', { name: 'Remove' }).first().click();
    await expect(drawer.getByRole('button', { name: 'Register this browser' })).toBeVisible();
    if (hasCli) expect(listDevices().some((item) => item.id === deviceId)).toBe(false);
  });
});
