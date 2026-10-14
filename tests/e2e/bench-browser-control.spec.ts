/**
 * Small latency benchmark: snapshot and click through the relay, the standard way and with the
 * debugger, on the same Advanced build and page. Runs only via `pnpm bench:browser`
 * (DEWEE_BENCH=1). Timings include the relay round trip, policy checks and, for the debugger,
 * the attach and detach around every command.
 */
import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';
import { BrowserRelay, startPageServer } from './support/browser-relay';
import { connectedBrowser, refOf } from './support/connect-browser';

test.use({ buildProfile: 'advanced' });
test.skip(!process.env.DEWEE_BENCH, 'benchmark: run with pnpm bench:browser');

const ROUNDS = Number(process.env.DEWEE_BENCH_ROUNDS ?? 20);

function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1);
  return `median ${at(0.5)} ms, p90 ${at(0.9)} ms, min ${sorted[0]!.toFixed(1)} ms (n=${sorted.length})`;
}

test('Standard vs Advanced snapshot and click latency', async ({ serviceWorker, openPanel }) => {
  test.setTimeout(10 * 60_000);
  const relay = new BrowserRelay();
  await relay.start();
  const site = await startPageServer();
  const siteOrigin = `http://127.0.0.1:${site.port}`;
  try {
    const { connectBrowser, run } = connectedBrowser(relay, () => siteOrigin);
    const panel: Page = await connectBrowser(serviceWorker as Worker, openPanel);
    expect(await run('open', { url: `${siteOrigin}/account` })).toMatchObject({ ok: true });

    const measure = async (label: string) => {
      const snapshots: number[] = [];
      const clicks: number[] = [];
      for (let i = 0; i < ROUNDS; i += 1) {
        let start = performance.now();
        const snap = await run('snapshot', { tab: 't1' });
        snapshots.push(performance.now() - start);
        expect(snap.ok).toBe(true);
        const { text, generation } = snap.result as { text: string; generation: number };
        start = performance.now();
        expect(await run('click', { tab: 't1', ref: refOf(text, 'Next'), generation })).toMatchObject({ ok: true });
        clicks.push(performance.now() - start);
      }
      process.stdout.write(`[bench] ${label} snapshot: ${summary(snapshots)}\n[bench] ${label} click: ${summary(clicks)}\n`);
    };

    await measure('standard');
    const drawer = panel.getByRole('dialog', { name: 'Browser control' });
    const enable = drawer.getByRole('checkbox', { name: /Let agents use Chrome’s debugger/ });
    await enable.click();
    await expect(enable).toBeChecked();
    await expect.poll(() => relay.capabilities.at(-1)).toEqual(['standard', 'advanced']);
    await measure('advanced');
  } finally {
    await relay.stop();
    await site.stop();
  }
});
