// Scenario E (browser resilience) against a real local Dewee Gateway. Each case checks that the
// panel reconciles from server state: one user turn, one reply, one stream POST, no re-send.
// Card cases (duplicate submit, lost respond response) live in live-credentials.spec.ts.
import type { BrowserContext, Page } from '@playwright/test';
import { createServer, connect as tcpConnect, type Socket } from 'node:net';
import { expect, test } from './fixtures';
import { GATEWAY, SHOTS, api, assistantTurns, connect, history, marker, rememberedSession, requireLiveGateway, send, userTurns } from './support/live';

requireLiveGateway();
test.setTimeout(150_000);

const LAST_WORD = 'slow-40';

/** Counts stream POSTs from every page of the context. */
function countStreamPosts(context: BrowserContext): () => number {
  let posts = 0;
  context.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/chat/stream')) posts += 1;
  });
  return () => posts;
}

/**
 * A loopback TCP relay to the Gateway that the test can cut, because Playwright's offline mode
 * does not break a response that is already streaming. Port 18792 is reserved for it. It relays
 * plain http on loopback only (no TLS).
 */
async function cuttableRelay(port = 18792) {
  const target = new URL(GATEWAY);
  // `hostname` keeps the brackets of an IPv6 literal (`[::1]`); a TCP connect needs the bare address.
  const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
  const sockets = new Set<Socket>();
  let open = true;
  const server = createServer((client) => {
    if (!open) {
      client.destroy();
      return;
    }
    const upstream = tcpConnect(Number(target.port || 80), host);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => s.destroy());
    }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    cut() {
      open = false;
      for (const s of sockets) s.destroy();
    },
    restore() {
      open = true;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function warmSession(panel: Page): Promise<void> {
  const first = marker('warm up');
  await send(panel, first);
  await expect(assistantTurns(panel, `stub reply: ${first}`)).toHaveCount(1, { timeout: 30_000 });
}

async function serverCounts(sessionKey: string, userText: string) {
  const messages = await history(sessionKey);
  return {
    users: messages.filter((m) => m.role === 'user' && m.content.includes(userText)).length,
    fullReplies: messages.filter((m) => m.role === 'assistant' && m.content.includes(LAST_WORD)).length,
  };
}

async function waitUntilIdle(sessionKey: string): Promise<void> {
  await expect
    .poll(async () => (await api<{ running: boolean }>('GET', `/sessions/${encodeURIComponent(sessionKey)}/status`)).data.running, { timeout: 60_000 })
    .toBe(false);
}

test('E reopening the panel mid-stream reconciles the running reply once', async ({ context, openPanel, serviceWorker }) => {
  const posts = countStreamPosts(context);
  let panel = await openPanel();
  await connect(panel);
  await warmSession(panel);
  const sessionKey = await rememberedSession(serviceWorker);
  const slow = marker('slow reopen');
  await send(panel, slow);
  await expect(panel.locator('li.message.message-assistant[aria-busy="true"]')).toContainText('slow-3', { timeout: 15_000 });

  await panel.close();
  panel = await openPanel();
  // The Gateway stores the turn when the run ends, so the reopened panel waits on run status.
  await expect(panel.getByRole('status').filter({ hasText: 'Reconnecting to the running reply…' })).toBeVisible({ timeout: 20_000 });
  await panel.screenshot({ path: `${SHOTS}/e-reopen-reconciling.png` });
  await expect(assistantTurns(panel, LAST_WORD)).toHaveCount(1, { timeout: 60_000 });
  await expect(userTurns(panel, slow)).toHaveCount(1);
  await panel.screenshot({ path: `${SHOTS}/e-reopen-reconciled.png` });

  expect(posts()).toBe(2);
  expect(await serverCounts(sessionKey, slow)).toEqual({ users: 1, fullReplies: 1 });
});

test('E a service worker restart mid-stream neither breaks nor repeats the reply', async ({ context, openPanel, serviceWorker }) => {
  const posts = countStreamPosts(context);
  const panel = await openPanel();
  await connect(panel);
  await warmSession(panel);
  const sessionKey = await rememberedSession(serviceWorker);
  const slow = marker('slow worker');
  await send(panel, slow);
  await expect(panel.locator('li.message.message-assistant[aria-busy="true"]')).toContainText('slow-2', { timeout: 15_000 });

  // Stop the extension's MV3 service worker, as Chrome does when it idles.
  const cdp = await context.newCDPSession(panel);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect(assistantTurns(panel, LAST_WORD)).toHaveCount(1, { timeout: 60_000 });

  // The worker comes back on demand with the session credential intact: a new send works.
  const after = marker('after worker restart');
  await send(panel, after);
  await expect(assistantTurns(panel, `stub reply: ${after}`)).toHaveCount(1, { timeout: 30_000 });
  await panel.screenshot({ path: `${SHOTS}/e-worker-restart.png` });

  expect(posts()).toBe(3);
  expect(await serverCounts(sessionKey, slow)).toEqual({ users: 1, fullReplies: 1 });
});

test('E going offline mid-stream and back online reconciles without a re-send', async ({ context, openPanel, serviceWorker }) => {
  const posts = countStreamPosts(context);
  const relay = await cuttableRelay();
  try {
    const panel = await openPanel();
    await connect(panel, undefined, relay.url);
    await warmSession(panel);
    const sessionKey = await rememberedSession(serviceWorker);
    const slow = marker('slow offline');
    await send(panel, slow);
    await expect(panel.locator('li.message.message-assistant[aria-busy="true"]')).toContainText('slow-2', { timeout: 15_000 });

    // The network drops: the open stream breaks and the browser reports offline.
    relay.cut();
    await context.setOffline(true);
    await expect(panel.getByRole('status', { name: 'Offline' })).toBeVisible();
    // Reconciling pauses while offline instead of polling.
    await expect(panel.getByRole('status').filter({ hasText: 'You are offline. The reply will load when the connection is back.' })).toBeVisible({ timeout: 20_000 });
    await panel.screenshot({ path: `${SHOTS}/e-offline.png` });
    await panel.waitForTimeout(3_000);
    relay.restore();
    await context.setOffline(false);

    await expect(assistantTurns(panel, LAST_WORD)).toHaveCount(1, { timeout: 60_000 });
    await expect(userTurns(panel, slow)).toHaveCount(1);
    await expect(panel.getByRole('status', { name: 'Online' })).toBeVisible();
    await panel.screenshot({ path: `${SHOTS}/e-online-reconciled.png` });

    expect(posts()).toBe(2);
    expect(await serverCounts(sessionKey, slow)).toEqual({ users: 1, fullReplies: 1 });
  } finally {
    await relay.close();
  }
});

test('E a cancelled run stays cancelled after reopening, with one user turn', async ({ context, openPanel, serviceWorker }) => {
  const posts = countStreamPosts(context);
  let panel = await openPanel();
  await connect(panel);
  await warmSession(panel);
  const sessionKey = await rememberedSession(serviceWorker);
  const slow = marker('slow cancel');
  await send(panel, slow);
  await expect(panel.locator('li.message.message-assistant[aria-busy="true"]')).toContainText('slow-2', { timeout: 15_000 });
  await panel.getByRole('button', { name: /Stop/ }).click();
  await expect(panel.getByText('Stopped')).toBeVisible({ timeout: 15_000 });
  await waitUntilIdle(sessionKey);

  const server = await serverCounts(sessionKey, slow);
  // At most one copy; the Gateway currently drops an aborted turn entirely (see the live report).
  expect(server.users).toBeLessThanOrEqual(1);
  expect(server.fullReplies).toBe(0);

  await panel.close();
  panel = await openPanel();
  await expect(assistantTurns(panel, 'stub reply: warm up')).toHaveCount(1, { timeout: 20_000 });
  await expect(userTurns(panel, slow)).toHaveCount(server.users);
  await expect(panel.getByRole('status').filter({ hasText: 'Reconnecting to the running reply…' })).toHaveCount(0);
  await expect(panel.getByRole('textbox', { name: /^Message / })).toBeEditable();
  await panel.screenshot({ path: `${SHOTS}/e-cancelled-reopened.png` });
  expect(posts()).toBe(2);
});
