import { chromium, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Pinned by the manifest `key` (extension-public-key.json). */
export const EXTENSION_ID = 'poicgajeapmbcilfbeobdfedibiffbbm';
/** Unpacked builds from scripts/build-e2e.mjs, one per build profile. */
const EXTENSION_PATHS = {
  standard: path.resolve('.output-e2e/chrome-mv3'),
  advanced: path.resolve('.output-e2e-advanced/chrome-mv3'),
} as const;

export interface ExtensionFixtures {
  /** Which build to load; a spec picks Advanced with `test.use({ buildProfile: 'advanced' })`. */
  buildProfile: keyof typeof EXTENSION_PATHS;
  context: BrowserContext;
  serviceWorker: Worker;
  openPanel(): Promise<Page>;
  openOptions(): Promise<Page>;
}

export const test = base.extend<ExtensionFixtures>({
  buildProfile: ['standard', { option: true }],
  context: async ({ buildProfile }, use) => {
    const extensionPath = EXTENSION_PATHS[buildProfile];
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'dewee-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      locale: 'en-US',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },
  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },
  openPanel: async ({ context, serviceWorker }, use) => {
    void serviceWorker;
    await use(async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
      return page;
    });
  },
  openOptions: async ({ context, serviceWorker }, use) => {
    void serviceWorker;
    await use(async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
      return page;
    });
  },
});

export const expect = test.expect;

/** Every value the extension keeps in chrome.storage, read from the service worker. */
export async function dumpStorage(worker: Worker): Promise<string> {
  return worker.evaluate(async () => {
    const [local, session] = await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]);
    return JSON.stringify({ local, session });
  });
}
