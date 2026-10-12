// Live scenarios against a real local Dewee Gateway (see tests/e2e/support/live-gateway.md).
// Skipped unless E2E_GATEWAY_URL and E2E_GATEWAY_API_KEY are set (shell env or the gitignored .env).
// Screenshots go to test-results/live/ and never show a key: the connect form clears it on submit.
import { dumpStorage, expect, test } from './fixtures';
import {
  ADMIN_TOKEN,
  API_KEY,
  SHOTS,
  SUPER_AGENT,
  WORKSPACE,
  OWNER,
  admin,
  adminOk,
  api,
  assistantTurns,
  connect,
  history,
  marker,
  rememberedSession,
  requireLiveGateway,
  send,
  userCount,
  userTurns,
} from './support/live';

requireLiveGateway();
test.setTimeout(120_000);

test('B1 connects with a personal key and lists agents with the Super Agent first', async ({ openPanel, serviceWorker }) => {
  const panel = await openPanel();
  await connect(panel);
  await expect(panel.getByRole('status', { name: 'Online' })).toBeVisible();
  await expect(panel.getByTestId('workspace-select')).toHaveValue(WORKSPACE);
  await panel.getByTestId('agent-picker').click();
  const options = panel.getByRole('listbox').getByRole('option');
  await expect(options.first()).toContainText('Super Agent');
  await expect(options.filter({ hasText: 'E2E Helper' })).toHaveCount(1);
  await panel.screenshot({ path: `${SHOTS}/b1-connected-agents.png` });
  await panel.keyboard.press('Escape');

  const storage = JSON.parse(await dumpStorage(serviceWorker)) as { local: unknown };
  expect(JSON.stringify(storage.local)).not.toContain(API_KEY);
});

test('B2 streams a reply from the Super Agent', async ({ openPanel }) => {
  const panel = await openPanel();
  await connect(panel);
  const text = marker('hello live');
  await send(panel, text);
  await expect(userTurns(panel, text)).toHaveCount(1);
  await expect(assistantTurns(panel, `stub reply: ${text}`)).toHaveCount(1, { timeout: 30_000 });
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
  await panel.screenshot({ path: `${SHOTS}/b2-streamed-reply.png` });
});

test('B2 deltas render incrementally, a settings write keeps the chat, and Stop ends the server run', async ({ openPanel, openOptions, serviceWorker }) => {
  const panel = await openPanel();
  await connect(panel);
  const first = marker('before settings');
  await send(panel, first);
  await expect(assistantTurns(panel, `stub reply: ${first}`)).toHaveCount(1, { timeout: 30_000 });
  const sessionKey = await rememberedSession(serviceWorker);

  // The stub sends one word every 500 ms, so a partial bubble proves token-by-token rendering.
  const slow = marker('slow stream');
  await send(panel, slow);
  const streaming = panel.locator('li.message.message-assistant[aria-busy="true"]');
  await expect(streaming).toContainText('slow-2', { timeout: 15_000 });
  expect(await streaming.innerText()).not.toContain('slow-20');
  await panel.screenshot({ path: `${SHOTS}/b2-incremental.png` });

  // A settings write (theme) while the reply streams must not reset the conversation.
  const options = await openOptions();
  await options.getByLabel('Theme').selectOption('dark');
  await options.close();
  await expect(streaming).toContainText('slow-6', { timeout: 15_000 });
  await expect(userTurns(panel, first)).toHaveCount(1);
  await expect(userTurns(panel, slow)).toHaveCount(1);

  await panel.getByRole('button', { name: /Stop/ }).click();
  await expect(panel.getByText('Stopped')).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => (await api<{ running: boolean }>('GET', `/sessions/${encodeURIComponent(sessionKey)}/status`)).data.running).toBe(false);
  // Had the run kept going, the last words would reach history within the 20 s stream.
  await panel.waitForTimeout(4_000);
  expect(JSON.stringify(await history(sessionKey))).not.toContain('slow-40');
  await expect(userTurns(panel, first)).toHaveCount(1);
  await panel.screenshot({ path: `${SHOTS}/b2-stopped-after-settings.png` });
});
test('B3 stops a running reply; a repeated abort is harmless', async ({ openPanel, serviceWorker }) => {
  const panel = await openPanel();
  await connect(panel);
  const first = marker('warm up');
  await send(panel, first);
  await expect(assistantTurns(panel, `stub reply: ${first}`)).toHaveCount(1, { timeout: 30_000 });
  const sessionKey = await rememberedSession(serviceWorker);

  const slow = marker('slow please');
  await send(panel, slow);
  const stop = panel.getByRole('button', { name: /Stop/ });
  await expect(stop).toBeVisible();
  await panel.waitForTimeout(1_500);
  await stop.click();
  await expect(panel.getByText('Stopped')).toBeVisible({ timeout: 15_000 });
  await panel.screenshot({ path: `${SHOTS}/b3-stopped.png` });

  await expect.poll(async () => (await api<{ running: boolean }>('GET', `/sessions/${encodeURIComponent(sessionKey)}/status`)).data.running).toBe(false);
  const again = await api<{ aborted: boolean }>('POST', '/chat/abort', { session_key: sessionKey, agent_key: SUPER_AGENT });
  expect(again.status).toBe(200);
  expect(again.data.aborted).toBe(false);
  expect(await userCount(sessionKey, slow)).toBeLessThanOrEqual(1);

  const after = marker('after stop');
  await send(panel, after);
  await expect(assistantTurns(panel, `stub reply: ${after}`)).toHaveCount(1, { timeout: 30_000 });
  expect(await userCount(sessionKey, after)).toBe(1);
});

test('B4 a revoked key ends the session with no fallback and nothing left in storage', async ({ openPanel, serviceWorker }) => {
  test.skip(!ADMIN_TOKEN || !OWNER || !WORKSPACE, 'Set E2E_GATEWAY_ADMIN_TOKEN, E2E_OWNER_ID and E2E_WORKSPACE_ID to mint a throwaway key.');
  const created = await adminOk<{ id: string; key: string }>('POST', '/v1/api-keys', {
    name: 'chrome-extension-revoke-test',
    scopes: ['operator.read', 'operator.write'],
    tenant_id: WORKSPACE,
    owner_id: OWNER,
  });
  const revokeRoute = `/v1/api-keys/${encodeURIComponent(created.id)}/revoke`;
  let revoked = false;
  try {
    const panel = await openPanel();
    await connect(panel, created.key);

    await adminOk('POST', revokeRoute);
    revoked = true;
    await send(panel, marker('after revoke'));
    await expect(panel.getByText('This profile needs a new API key.')).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId('workspace-select')).toHaveCount(0);
    await expect(panel.getByLabel('Personal API key')).toHaveValue('');
    await panel.screenshot({ path: `${SHOTS}/b4-revoked.png` });

    const storage = await dumpStorage(serviceWorker);
    expect(storage).not.toContain(created.key);
    expect(storage).not.toContain(API_KEY);
    expect(storage).not.toContain(ADMIN_TOKEN);
  } finally {
    // A failed step must not leave a live throwaway key behind.
    if (!revoked) await admin('POST', revokeRoute);
  }
});

test('E1 history survives reopening; a lost response reconciles without a duplicate send', async ({ context, openPanel, serviceWorker }) => {
  let panel = await openPanel();
  await connect(panel);
  const kept = marker('keep me');
  await send(panel, kept);
  await expect(assistantTurns(panel, `stub reply: ${kept}`)).toHaveCount(1, { timeout: 30_000 });
  const sessionKey = await rememberedSession(serviceWorker);

  await panel.close();
  panel = await openPanel();
  await expect(userTurns(panel, kept)).toHaveCount(1, { timeout: 20_000 });
  await expect(assistantTurns(panel, `stub reply: ${kept}`)).toHaveCount(1);
  await panel.screenshot({ path: `${SHOTS}/e1-reopened-history.png` });

  // The gateway finishes the turn, but the connection drops (while online) before the panel reads
  // the reply, and the history cannot be read yet either. Delivery is uncertain, so the panel keeps
  // the turn as unconfirmed with a reload action and never offers "Send again" (docs/architecture.md,
  // Chat). A fetch rejected while offline counts as not received and offers "Send again" instead.
  let streamPosts = 0;
  await context.route('**/chat/stream', async (route) => {
    streamPosts += 1;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await context.route('**/chat/history', (route) => route.abort('connectionreset'));
  const lost = marker('lost reply');
  await send(panel, lost);
  const unconfirmed = panel.getByRole('alert').filter({ hasText: 'Delivery could not be confirmed' });
  await expect(unconfirmed).toBeVisible({ timeout: 30_000 });
  await expect(unconfirmed.getByRole('button', { name: 'Reload conversation' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Send again' })).toHaveCount(0);
  await panel.screenshot({ path: `${SHOTS}/e1-unconfirmed.png` });

  await context.unroute('**/chat/history');
  await unconfirmed.getByRole('button', { name: 'Reload conversation' }).click();
  await expect(assistantTurns(panel, `stub reply: ${lost}`)).toHaveCount(1, { timeout: 30_000 });
  await expect(userTurns(panel, lost)).toHaveCount(1);
  await expect(unconfirmed).toHaveCount(0);
  await panel.screenshot({ path: `${SHOTS}/e1-reconciled.png` });
  await context.unroute('**/chat/stream');

  expect(streamPosts).toBe(1);
  expect(await userCount(sessionKey, lost)).toBe(1);
});
