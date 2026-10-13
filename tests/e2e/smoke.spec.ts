import { dumpStorage, expect, EXTENSION_ID, test } from './fixtures';

test('service worker runs with the pinned extension id', async ({ serviceWorker }) => {
  expect(serviceWorker.url()).toBe(`chrome-extension://${EXTENSION_ID}/background.js`);
});

test('panel shows the connect screen with both modes', async ({ openPanel }) => {
  const panel = await openPanel();
  await expect(panel.getByRole('heading', { name: 'Dewee' })).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'Dewee Cloud' })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('tab', { name: 'Self-hosted Gateway' }).click();
  await expect(panel.getByLabel('Gateway URL')).toBeVisible();
  await expect(panel.getByLabel('Personal API key')).toHaveAttribute('type', 'password');
  await expect(panel.getByText('Never use the gateway master token')).toBeVisible();
});

test('plain HTTP is refused for a non-loopback gateway', async ({ openPanel }) => {
  const panel = await openPanel();
  await panel.getByRole('tab', { name: 'Self-hosted Gateway' }).click();
  await panel.getByLabel('Gateway URL').fill('http://gateway.example.com');
  await panel.getByLabel('Personal API key').fill('test-not-a-real-key');
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.getByText('Use HTTPS. Plain HTTP works only for localhost.')).toBeVisible();
});

test('a rejected key is never stored', async ({ openPanel, serviceWorker }) => {
  const panel = await openPanel();
  await panel.getByRole('tab', { name: 'Self-hosted Gateway' }).click();
  // Nothing listens on this loopback port, so the connection fails before any credential is saved.
  await panel.getByLabel('Gateway URL').fill('http://127.0.0.1:9');
  await expect(panel.getByText('Plain HTTP is only allowed for local development')).toBeVisible();
  await panel.getByLabel('Personal API key').fill('test-unique-key-value-123');
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByLabel('Personal API key')).toHaveValue('');
  expect(await dumpStorage(serviceWorker)).not.toContain('test-unique-key-value-123');
});

test('options page switches theme and language', async ({ openOptions }) => {
  const options = await openOptions();
  await expect(options.getByRole('heading', { name: 'Settings', exact: false }).first()).toBeVisible();
  await options.getByLabel('Theme').selectOption('dark');
  await expect(options.locator('html')).toHaveAttribute('data-theme', 'dark');
  await options.getByLabel('Language').selectOption('vi');
  await expect(options.locator('html')).toHaveAttribute('lang', 'vi');
});
