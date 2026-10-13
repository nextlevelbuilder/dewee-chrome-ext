// Live Cloud scenario against a local Dewee app (apps/dewee-app, self-hosted node mode) in front of
// a local Gateway (see tests/e2e/support/live-gateway.md, "Cloud"). Skipped unless E2E_CLOUD_ORIGIN,
// E2E_CLOUD_EMAIL and E2E_CLOUD_PASSWORD are set. The password is typed into the app's own login page
// inside the sign-in window and never reaches the extension, storage or a screenshot.
import type { Page } from '@playwright/test';
import { dumpStorage, expect, test } from './fixtures';
import { SHOTS, assistantTurns, marker, send, userTurns } from './support/live';
import { remoteHostRefusal } from './support/live-host-guard';

const CLOUD = (process.env.E2E_CLOUD_ORIGIN ?? '').replace(/\/+$/, '');
const EMAIL = process.env.E2E_CLOUD_EMAIL ?? '';
const PASSWORD = process.env.E2E_CLOUD_PASSWORD ?? '';

test.skip(!CLOUD || !EMAIL || !PASSWORD, 'Set E2E_CLOUD_ORIGIN, E2E_CLOUD_EMAIL and E2E_CLOUD_PASSWORD to run the live Cloud scenario.');
const cloudRefusal = remoteHostRefusal('E2E_CLOUD_ORIGIN', CLOUD);
test.skip(cloudRefusal !== null, cloudRefusal ?? '');
test.setTimeout(120_000);

/** The window chrome.identity.launchWebAuthFlow opens on the Cloud origin. */
async function authWindow(pages: () => Page[], waitForPage: Promise<Page>): Promise<Page> {
  const open = pages().find((page) => page.url().startsWith(CLOUD));
  return open ?? waitForPage;
}

test('A signs in to Dewee Cloud, picks the workspace and chats with the Super Agent', async ({ context, openPanel, serviceWorker }) => {
  const panel = await openPanel();
  await panel.getByRole('tab', { name: 'Dewee Cloud' }).click();
  await panel.locator('summary', { hasText: 'Cloud URL' }).click();
  await panel.getByLabel('Cloud URL').fill(CLOUD);

  const nextPage = context.waitForEvent('page', { predicate: (page) => page.url().startsWith(CLOUD), timeout: 20_000 });
  await panel.getByRole('button', { name: 'Sign in with Dewee' }).click();
  const auth = await authWindow(() => context.pages(), nextPage);
  await auth.waitForLoadState('domcontentloaded');

  // No web session yet: the app shows its email/password login, then the consent screen.
  await auth.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await auth.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await auth.getByRole('textbox', { name: 'Password' }).press('Enter');
  const allow = auth.getByRole('button', { name: /^Allow/ });
  await expect(allow).toBeVisible({ timeout: 20_000 });
  await auth.screenshot({ path: `${SHOTS}/a-consent.png` });
  await allow.click();

  await expect(panel.getByTestId('workspace-select')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId('agent-picker')).toContainText('Super Agent', { timeout: 20_000 });
  await panel.screenshot({ path: `${SHOTS}/a-cloud-connected.png` });

  const text = marker('hello cloud');
  await send(panel, text);
  await expect(userTurns(panel, text)).toHaveCount(1);
  await expect(assistantTurns(panel, `stub reply: ${text}`)).toHaveCount(1, { timeout: 45_000 });
  await panel.screenshot({ path: `${SHOTS}/a-cloud-reply.png` });

  const storage = await dumpStorage(serviceWorker);
  expect(storage).not.toContain(PASSWORD);
});
