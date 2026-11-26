// Smoke test of the user's own request, "mở google và search dewee", against a real local Gateway:
// the agent calls the `browser` tool WITHOUT naming a target (as models do), and because the person
// has this browser online and granted to the agent, the call runs in the person's Chrome through
// the extension. The model is the deterministic stub, scripted turn by turn; Google is the real site.
// Build with `DEWEE_E2E_HOSTS=https://www.google.com/* pnpm build:e2e` so the Google site access is granted up front.
// If Google answers with a consent or CAPTCHA page, the test stops there and says so (never bypassed).
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { SHOTS, adminOk, connect, marker, requireLiveGateway, scriptToolCalls, send, turnToolResults, type ToolCall } from './support/live';

requireLiveGateway(true);
test.setTimeout(240_000);

const GOOGLE = 'https://www.google.com';
const setFlag = (connected: boolean) => adminOk('PUT', '/v1/tools/builtin/browser/tenant-config', { settings: { connected } });
// No `target`: the Gateway picks the person's granted, online browser.
const browser = (args: Record<string, unknown>): ToolCall => ({ name: 'browser', arguments: args });

async function turn(panel: Page, text: string, calls: ToolCall[]): Promise<string[]> {
  const m = marker('smoke');
  await scriptToolCalls(m, calls);
  await send(panel, `${m} ${text}`);
  await expect.poll(async () => (await turnToolResults(m)).length, { timeout: 90_000 }).toBe(calls.length + 1);
  return (await turnToolResults(m)).slice(1);
}

test.afterAll(async () => {
  await setFlag(false).catch(() => undefined);
});

test('mở google và search dewee: the agent drives the person’s Chrome', async ({ context, openPanel, openOptions }) => {
  await setFlag(true);
  const panel = await openPanel();
  await connect(panel);
  const options = await openOptions();
  const toggle = options.getByRole('checkbox', { name: /Connected browser/ });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await options.close();

  const drawer = panel.getByRole('dialog', { name: 'Browser control' });
  await panel.getByTestId('browser-toggle').click();
  await expect(async () => {
    await drawer.getByRole('button', { name: 'Register this browser' }).click();
    await expect(drawer.getByTestId('browser-device-name')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await drawer.getByRole('checkbox', { name: 'Super Agent' }).check();
  await drawer.getByLabel('Sites, one per line').fill(GOOGLE);
  await drawer.getByRole('radio', { name: /Read and act/ }).check();
  await drawer.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(drawer.getByTestId('browser-grants').locator('li', { hasText: 'Super Agent' })).toContainText(GOOGLE);
  await drawer.getByRole('button', { name: 'Close' }).first().click();

  const [opened = '', snapshot = ''] = await turn(panel, 'mở google và search "dewee"', [
    browser({ action: 'open', targetUrl: GOOGLE }),
    browser({ action: 'snapshot', targetId: 't1' }),
  ]);
  expect(opened).not.toContain('error');
  const google = context.pages().find((p) => p.url().startsWith(GOOGLE));
  expect(google, 'a Google tab opened in the person’s Chrome').toBeTruthy();
  await google!.screenshot({ path: `${SHOTS}/smoke-1-google-opened.png` });

  const box = snapshot.split('\n').find((l) => /\[e\d+\]/.test(l) && /(combobox|textbox|searchbox)/i.test(l));
  test.skip(!box, `Google showed no search box (consent or CAPTCHA page?): ${snapshot.slice(0, 300)}`);
  const ref = box!.match(/\[(e\d+)\]/)![1];
  const generation = Number(snapshot.match(/Generation: (\d+)/)![1]);

  // Typing with submit waits for the person's approval card in the panel.
  const m = marker('smoke type');
  await scriptToolCalls(m, [browser({ action: 'act', targetId: 't1', request: { kind: 'type', ref, generation, text: 'dewee', submit: true } })]);
  await send(panel, `${m} gõ dewee rồi Enter`);
  const card = panel.getByTestId('browser-approval');
  await expect(card).toBeVisible({ timeout: 60_000 });
  await panel.screenshot({ path: `${SHOTS}/smoke-2-approval.png` });
  await card.getByRole('button', { name: /^(Allow|Approve|Allow once)/ }).first().click();
  await expect.poll(async () => (await turnToolResults(m)).length, { timeout: 60_000 }).toBe(2);
  const typed = (await turnToolResults(m))[1];
  expect(typed).not.toContain('error');
  // The search was submitted: Google's results URL, or its bot check ("/sorry") for that same search,
  // which automated Chromium often gets. The bot check is reported, never bypassed.
  await expect.poll(() => decodeURIComponent(google!.url()), { timeout: 30_000 }).toMatch(/search\?q=dewee|[?&]q=dewee/);
  if (google!.url().includes('/sorry/')) test.info().annotations.push({ type: 'note', description: 'Google showed its bot check for the submitted search' });
  await google!.waitForLoadState('domcontentloaded');
  await google!.screenshot({ path: `${SHOTS}/smoke-3-google-search-dewee.png` });
  await panel.screenshot({ path: `${SHOTS}/smoke-4-panel.png` });
});
