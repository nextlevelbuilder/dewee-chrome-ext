// Scenarios C, D and the card cases of E against a real local Dewee Gateway with the stub model.
// A random sentinel stands in for the secret. The tests never print it; they only assert where it
// must not appear (model inputs, storage, console, non-respond requests, Gateway log, DB rows).
//
// Optional env (the checks are skipped without them):
//   E2E_GATEWAY_LOG  path of the Gateway's log file, grepped for the sentinel
//   E2E_DB_TOOL      a status-only DB helper (expire/provider/action/sweep), see live-gateway.md
//   E2E_DB_DSN       DSN of the throwaway test database, read by E2E_DB_TOOL
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dumpStorage, expect, test } from './fixtures';
import {
  OWNER,
  SHOTS,
  SUPER_AGENT,
  WORKSPACE,
  adminOk,
  api,
  assistantTurns,
  connect,
  history,
  marker,
  modelInputs,
  pickAgent,
  rememberedSession,
  requireLiveGateway,
  scriptToolCall,
  send,
} from './support/live';

requireLiveGateway(true);
test.setTimeout(150_000);

const HELPER = 'e2e-helper';
const GATEWAY_LOG = process.env.E2E_GATEWAY_LOG ?? '';
const DB_TOOL = process.env.E2E_DB_TOOL ?? '';
const hasDb = Boolean(DB_TOOL && process.env.E2E_DB_DSN && existsSync(DB_TOOL));

const sentinel = () => `sk-e2e-sentinel-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const providerName = (label: string) => `e2e-${label}-${Date.now().toString(36)}`;

/** Runs the DB helper; its output is statuses only, never column values. */
function db<T>(...args: string[]): T {
  return JSON.parse(execFileSync(DB_TOOL, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as T;
}

function secretRequest(title: string, target: Record<string, unknown>) {
  return { kind: 'secret_request', title, payload: { target, fields: [{ key: 'api_key', label: 'API key', kind: 'secret', required: true }] } };
}

const providerTarget = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'provider', mode: 'create', provider_type: 'openai_compat', name, ...extra });

/** Collects console text from every page and the service worker, and every non-respond request body. */
function watchLeaks(context: BrowserContext, worker: Worker) {
  const consoleText: string[] = [];
  const otherBodies: string[] = [];
  const respondPosts: string[] = [];
  const onPage = (page: Page) => page.on('console', (m) => consoleText.push(m.text()));
  context.pages().forEach(onPage);
  context.on('page', onPage);
  worker.on('console', (m) => consoleText.push(m.text()));
  context.on('request', (request) => {
    // The respond body is the one place a secret may go; its URL is not, so it is checked below.
    if (request.url().includes('/respond')) {
      if (request.method() === 'POST') respondPosts.push(request.url());
      return;
    }
    otherBodies.push(`${request.url()} ${request.postData() ?? ''}`);
  });
  return { consoleText, otherBodies, respondPosts };
}

const card = (panel: Page, title: string) => panel.locator('section.action-card', { hasText: title });

async function fill(panel: Page, title: string, value: string): Promise<void> {
  await card(panel, title).getByLabel('API key *').fill(value);
}

async function cardId(panel: Page, title: string): Promise<string> {
  const id = await card(panel, title).getAttribute('data-card-id');
  if (!id) throw new Error('card without id');
  return id;
}

/** Asks the scripted agent for a card and waits until the panel shows it. */
async function requestCard(panel: Page, tool: 'ui_action' | 'credential_request', title: string, target: Record<string, unknown>) {
  const ask = marker(`connect ${title}`);
  await scriptToolCall(ask, { name: tool, arguments: secretRequest(title, target) });
  await send(panel, ask);
  await expect(card(panel, title)).toBeVisible({ timeout: 30_000 });
  // The Gateway stores a new conversation when its first run ends; until then it cannot reload
  // the card, so answer after the reply finishes, as a person would.
  await expect(panel.locator('li.message[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
  return ask;
}

async function assertNoLeak(value: string, worker: Worker, leaks: ReturnType<typeof watchLeaks>): Promise<void> {
  expect((await modelInputs()).some((input) => input.includes(value)), 'model inputs').toBe(false);
  expect((await dumpStorage(worker)).includes(value), 'extension storage').toBe(false);
  expect(leaks.consoleText.some((line) => line.includes(value)), 'console').toBe(false);
  expect(leaks.otherBodies.some((body) => body.includes(value)), 'non-respond requests').toBe(false);
  expect(leaks.respondPosts.some((url) => url.includes(value) || url.includes(encodeURIComponent(value))), 'respond URL').toBe(false);
  if (GATEWAY_LOG) expect(readFileSync(GATEWAY_LOG, 'utf8').includes(value), 'gateway log').toBe(false);
}

async function helperId(): Promise<string> {
  const data = await adminOk<{ agents?: { id: string; agent_key: string }[] } | { id: string; agent_key: string }[]>('GET', '/v1/agents');
  const agents = Array.isArray(data) ? data : (data.agents ?? []);
  const helper = agents.find((a) => a.agent_key === HELPER);
  if (!helper) throw new Error('e2e-helper agent missing; run setup-live-gateway.mjs');
  return helper.id;
}

const policyRoute = async () => `/v1/agents/${await helperId()}/credential-request-policy`;
const allowOpenAiCompat = { enabled: true, targets: [{ type: 'provider', provider_type: 'openai_compat', modes: ['create'] }] };

test.beforeEach(() => {
  // Earlier runs leave open cards behind; the Gateway caps open cards per agent and tenant.
  if (hasDb) db('sweep', WORKSPACE);
});

test('C Super Agent secret_request: the value is stored encrypted and the agent sees only a credential_ref', async ({ context, openPanel, serviceWorker }) => {
  const leaks = watchLeaks(context, serviceWorker);
  const panel = await openPanel();
  await connect(panel);
  const name = providerName('c');
  const title = `Connect ${name}`;
  await requestCard(panel, 'ui_action', title, providerTarget(name));
  const id = await cardId(panel, title);
  await expect(card(panel, title).locator('.status-pill')).toHaveText('Waiting for you');
  await panel.screenshot({ path: `${SHOTS}/c-card-pending.png` });

  const value = sentinel();
  await fill(panel, title, value);
  await card(panel, title).getByRole('button', { name: 'Save securely' }).click();
  await expect(card(panel, title).locator('.status-pill')).toHaveText('Done', { timeout: 20_000 });
  await expect(card(panel, title)).toContainText('The agent only receives a reference, never the value.');
  // The continuation turn gives the agent a reference, which the stub echoes back.
  await expect(assistantTurns(panel, 'cred:v1:provider:')).toHaveCount(1, { timeout: 30_000 });
  await panel.screenshot({ path: `${SHOTS}/c-card-done.png` });

  expect(leaks.respondPosts).toHaveLength(1);
  expect((await modelInputs()).some((input) => input.includes('cred:v1:provider:'))).toBe(true);
  const sessionKey = await rememberedSession(serviceWorker);
  expect((await history(sessionKey)).some((m) => m.content.includes(value))).toBe(false);
  await assertNoLeak(value, serviceWorker, leaks);
  if (hasDb) {
    expect(db('provider', WORKSPACE, name, value)).toEqual({ found: true, key_set: true, plaintext: false, contains: false });
    expect(db('action', id, value)).toEqual({ found: true, contains: false });
  }

  // Answering again (a replayed or forged request) must not apply a second value.
  const again = sentinel();
  const duplicate = await api<{ error?: { code: string }; replayed?: boolean }>('POST', `/actions/${id}/respond`, { secret: { api_key: again } });
  expect(duplicate.status === 409 || duplicate.data.replayed === true, `duplicate respond -> ${duplicate.status}`).toBe(true);
  if (hasDb) expect(db('provider', WORKSPACE, name, again)).toMatchObject({ found: true, contains: false });
  test.info().annotations.push({ type: 'duplicate respond', description: `${duplicate.status} ${duplicate.data.error?.code ?? 'replayed'}` });
});

test('C an expired card and foreign targets are refused, and nothing is stored', async ({ openPanel }) => {
  test.skip(!hasDb, 'Set E2E_DB_TOOL and E2E_DB_DSN to expire a card.');
  const panel = await openPanel();
  await connect(panel);

  const name = providerName('exp');
  const title = `Connect ${name}`;
  await requestCard(panel, 'ui_action', title, providerTarget(name));
  const id = await cardId(panel, title);
  expect(db('expire', id)).toEqual({ updated: 1 });
  const value = sentinel();
  const expired = await api<{ error: { code: string } }>('POST', `/actions/${id}/respond`, { secret: { api_key: value } });
  expect(expired.status).toBe(409);
  test.info().annotations.push({ type: 'expired respond', description: `${expired.status} ${expired.data.error.code}` });
  expect(db('provider', WORKSPACE, name, value)).toEqual({ found: false });

  // A target that is not this workspace's: a provider id that does not exist here, and an
  // outside api_base. The Gateway validates targets, so no card may appear for either.
  for (const [label, target] of [
    ['foreign id', { type: 'provider', mode: 'update', provider_type: 'openai_compat', id: crypto.randomUUID() }],
    ['foreign base', providerTarget(providerName('fb'), { api_base: 'https://collector.example.test/v1' })],
  ] as const) {
    const ask = marker(`connect ${label}`);
    await scriptToolCall(ask, { name: 'ui_action', arguments: secretRequest(`Foreign ${label}`, target) });
    await send(panel, ask);
    await expect(assistantTurns(panel, 'tool result:').last()).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('li.message.message-assistant').last()).not.toContainText('pending');
    await expect(card(panel, `Foreign ${label}`)).toHaveCount(0);
  }
  await panel.screenshot({ path: `${SHOTS}/c-foreign-refused.png` });
});

test('D a normal agent needs an admin policy, limited to the allowlist, and a revoke closes its open card', async ({ context, openPanel, serviceWorker }) => {
  const leaks = watchLeaks(context, serviceWorker);
  const route = await policyRoute();
  await adminOk('DELETE', route, undefined, OWNER);
  const panel = await openPanel();
  await connect(panel);
  await pickAgent(panel, 'E2E Helper');

  // No policy: the tool is not offered, so no card.
  const refusedAsk = marker('connect without policy');
  await scriptToolCall(refusedAsk, { name: 'credential_request', arguments: secretRequest('No policy card', providerTarget(providerName('np'))) });
  await send(panel, refusedAsk);
  await expect(assistantTurns(panel, 'tool not allowed by policy: credential_request')).toHaveCount(1, { timeout: 30_000 });
  await expect(card(panel, 'No policy card')).toHaveCount(0);

  try {
    await adminOk('PUT', route, allowOpenAiCompat, OWNER);

    // Allowlisted target: the card appears and the answer is applied.
    const name = providerName('d');
    const title = `Connect ${name}`;
    await requestCard(panel, 'credential_request', title, providerTarget(name));
    const value = sentinel();
    await fill(panel, title, value);
    await card(panel, title).getByRole('button', { name: 'Save securely' }).click();
    await expect(card(panel, title).locator('.status-pill')).toHaveText('Done', { timeout: 20_000 });
    await expect(assistantTurns(panel, 'cred:v1:provider:')).toHaveCount(1, { timeout: 30_000 });
    await panel.screenshot({ path: `${SHOTS}/d-allowlisted-done.png` });
    if (hasDb) expect(db('provider', WORKSPACE, name, value)).toMatchObject({ found: true, key_set: true, contains: false });

    // A provider type outside the allowlist is refused.
    const otherAsk = marker('connect other type');
    await scriptToolCall(otherAsk, {
      name: 'credential_request',
      arguments: secretRequest('Other type card', { type: 'provider', mode: 'create', provider_type: 'anthropic_native', name: providerName('ot') }),
    });
    await send(panel, otherAsk);
    await expect(assistantTurns(panel, 'tool result:').last()).toBeVisible({ timeout: 30_000 });
    await expect(card(panel, 'Other type card')).toHaveCount(0);

    // Revoking the policy while a card is open: the answer is refused with a localized reason.
    // Requires the Gateway change in nextlevelbuilder/dewee#1019: respond on a policy-cancelled card
    // answers 409 with its existing error code plus `details.reason: "credential_policy_revoked"`,
    // which the panel maps to `error.credential_policy_revoked`. A Gateway without it fails here.
    const revokedName = providerName('rv');
    const revokedTitle = `Connect ${revokedName}`;
    await requestCard(panel, 'credential_request', revokedTitle, providerTarget(revokedName));
    await adminOk('DELETE', route, undefined, OWNER);
    const revokedValue = sentinel();
    await fill(panel, revokedTitle, revokedValue);
    await card(panel, revokedTitle).getByRole('button', { name: 'Save securely' }).click();
    const reason = card(panel, revokedTitle).getByRole('alert');
    await expect(reason).toBeVisible({ timeout: 20_000 });
    await expect(reason).toHaveText('An admin no longer allows this agent to ask for this credential. The card was closed.');
    await expect(card(panel, revokedTitle).locator('.status-pill')).toHaveText('Cancelled');
    await panel.screenshot({ path: `${SHOTS}/d-revoked-refused.png` });
    if (hasDb) expect(db('provider', WORKSPACE, revokedName, revokedValue)).toEqual({ found: false });
    await assertNoLeak(value, serviceWorker, leaks);
    await assertNoLeak(revokedValue, serviceWorker, leaks);
  } finally {
    await adminOk('DELETE', route, undefined, OWNER);
  }
});

test('E a double-clicked Save sends one answer and continues once', async ({ context, openPanel, serviceWorker }) => {
  const leaks = watchLeaks(context, serviceWorker);
  const panel = await openPanel();
  await connect(panel);
  const name = providerName('dbl');
  const title = `Connect ${name}`;
  await requestCard(panel, 'ui_action', title, providerTarget(name));
  await fill(panel, title, sentinel());
  await card(panel, title).getByRole('button', { name: 'Save securely' }).dblclick();
  await expect(card(panel, title).locator('.status-pill')).toHaveText('Done', { timeout: 20_000 });
  await expect(assistantTurns(panel, 'cred:v1:provider:')).toHaveCount(1, { timeout: 30_000 });
  await panel.waitForTimeout(2_000);
  await expect(assistantTurns(panel, 'cred:v1:provider:')).toHaveCount(1);
  expect(leaks.respondPosts).toHaveLength(1);
  const sessionKey = await rememberedSession(serviceWorker, SUPER_AGENT);
  expect((await history(sessionKey)).filter((m) => m.role === 'assistant' && m.content.includes('cred:v1:provider:'))).toHaveLength(1);
});

test('E a lost respond response reloads the card as Done and continues once, without re-sending', async ({ context, openPanel, serviceWorker }) => {
  const leaks = watchLeaks(context, serviceWorker);
  const panel = await openPanel();
  await connect(panel);
  const name = providerName('lost');
  const title = `Connect ${name}`;
  await requestCard(panel, 'ui_action', title, providerTarget(name));

  // The Gateway applies the answer, but the panel never sees the response.
  const applied: number[] = [];
  await context.route('**/actions/*/respond', async (route) => {
    applied.push((await route.fetch()).status());
    await route.abort('connectionreset');
  });
  const value = sentinel();
  await fill(panel, title, value);
  await card(panel, title).getByRole('button', { name: 'Save securely' }).click();
  await expect.poll(() => applied, { timeout: 20_000 }).toEqual([200]);
  await expect(card(panel, title).locator('.status-pill')).toHaveText('Done', { timeout: 20_000 });
  await expect(assistantTurns(panel, 'cred:v1:provider:')).toHaveCount(1, { timeout: 30_000 });
  await context.unroute('**/actions/*/respond');
  await panel.screenshot({ path: `${SHOTS}/e-lost-respond-reconciled.png` });

  expect(leaks.respondPosts).toHaveLength(1);
  const sessionKey = await rememberedSession(serviceWorker, SUPER_AGENT);
  expect((await history(sessionKey)).filter((m) => m.role === 'assistant' && m.content.includes('cred:v1:provider:'))).toHaveLength(1);
  if (hasDb) expect(db('provider', WORKSPACE, name, value)).toMatchObject({ found: true, key_set: true, contains: false });
});
