/** Side panel steps shared by the connected-browser specs (Standard and Advanced builds). */
import type { Page, Worker } from '@playwright/test';
import { expect } from '../fixtures';
import { AGENT, RELAY_API_KEY, type BrowserRelay, type CommandOutcome } from './browser-relay';

export function connectedBrowser(relay: BrowserRelay, siteOrigin: () => string) {
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
    await drawer.getByLabel('Sites, one per line').fill(siteOrigin());
    if (capability === 'control') await drawer.getByRole('radio', { name: /Read and act/ }).check();
    await drawer.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(drawer.getByTestId('browser-grants')).toContainText(siteOrigin());
    expect(relay.activeGrant()).toMatchObject({ origins: [siteOrigin()], agent_ids: [AGENT.id] });
    return panel;
  }

  async function run(action: string, params: Record<string, unknown>, options?: Parameters<BrowserRelay['command']>[2]): Promise<CommandOutcome> {
    const { commandId, outcome } = relay.command(action, params, options);
    const result = await outcome;
    // Acknowledged after validation, before the result.
    expect(relay.acks).toContain(commandId);
    return result;
  }

  async function openSite(path = '/account', title = 'E2E Shop'): Promise<{ tab: string; text: string; generation: number }> {
    const opened = await run('open', { url: `${siteOrigin()}${path}` });
    expect(opened).toMatchObject({ ok: true, result: { tab: 't1', url: `${siteOrigin()}${path}`, title } });
    const snap = await run('snapshot', { tab: 't1' });
    expect(snap.ok).toBe(true);
    const result = snap.result as { text: string; generation: number };
    return { tab: 't1', text: result.text, generation: result.generation };
  }

  return { connectBrowser, run, openSite };
}

export function refOf(text: string, name: string): string {
  const ref = text.split('\n').find((line) => /\[e\d+\]/.test(line) && line.includes(`"${name}"`))?.match(/\[(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`no ref for ${name} in:\n${text}`);
  return ref;
}
