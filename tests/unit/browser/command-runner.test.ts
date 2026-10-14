import { CommandRunner, MAX_COMMAND_MS, MAX_IN_FLIGHT, type RunnerDeps } from '@/browser/command-runner';
import { CommandError } from '@/browser/executor';
import { DEVICE_ID, NOW, payload } from './fixtures';
import { flush } from './fake-socket';

function setup(execute: RunnerDeps['execute']) {
  const log: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  const deps: RunnerDeps = {
    ack: async ({ command_id }) => {
      log.push(`ack:${command_id}`);
    },
    result: async (params) => {
      log.push(`result:${params.command_id}`);
      results.push(params as Record<string, unknown>);
    },
    execute: async (command, signal, context) => {
      log.push(`execute:${command.command_id}`);
      return execute(command, signal, context);
    },
    deviceId: () => DEVICE_ID,
    now: () => NOW,
  };
  const runner = new CommandRunner(deps);
  return { runner, log, results };
}

/** Resolves when the signal aborts, rejecting with its reason (like a real step would). */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

describe('CommandRunner', () => {
  it('acks after validation, then executes, then sends exactly one result', async () => {
    const { runner, log, results } = setup(async () => ({ tab: 't1' }));
    const raw = payload('scroll', { tab: 't1', direction: 'down' });
    await runner.handle(raw);
    const id = raw.command_id as string;
    expect(log).toEqual([`ack:${id}`, `execute:${id}`, `result:${id}`]);
    expect(results).toEqual([{ command_id: id, ok: true, result: { tab: 't1' } }]);
  });

  it('refuses invalid params without an ack or execution', async () => {
    const { runner, log, results } = setup(async () => ({}));
    const raw = payload('click', { tab: 't1', ref: 'e1', generation: 1, selector: 'x' });
    await runner.handle(raw);
    expect(log).toEqual([`result:${raw.command_id}`]);
    expect(results[0]).toMatchObject({ ok: false, error: { code: 'invalid_params' } });
  });

  it('never runs the same command twice', async () => {
    const { runner, log } = setup(async () => ({ tab: 't1' }));
    const raw = payload('scroll', { tab: 't1', direction: 'down' });
    await runner.handle(raw);
    await runner.handle(raw);
    expect(log.filter((l) => l.startsWith('execute'))).toHaveLength(1);
  });

  it('refuses a command for another device or past its deadline', async () => {
    const { runner, results, log } = setup(async () => ({}));
    await runner.handle(payload('tabs', {}, { device_id: '99999999-9999-4999-8999-999999999999' }));
    await runner.handle(payload('tabs', {}, { deadline: new Date(NOW - 1).toISOString() }));
    expect(results.map((r) => (r.error as { code: string }).code)).toEqual(['permission_denied', 'timeout']);
    expect(log.some((l) => l.startsWith('execute'))).toBe(false);
  });

  it('reports the executor refusal code with a fixed message', async () => {
    const { runner, results } = setup(async () => {
      throw new CommandError('origin_not_granted', 'This site is not in the grant');
    });
    await runner.handle(payload('snapshot', { tab: 't1' }));
    expect(results[0]).toMatchObject({ ok: false, error: { code: 'origin_not_granted', message: 'This site is not in the grant' } });
  });

  it('turns an unexpected error into internal and never leaks its message', async () => {
    const { runner, results } = setup(async () => {
      throw new Error('secret page text');
    });
    await runner.handle(payload('snapshot', { tab: 't1' }));
    expect(results[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(JSON.stringify(results[0])).not.toContain('secret page text');
  });

  it('refuses a result that does not match the contract', async () => {
    const { runner, results } = setup(async () => ({ tab: 't1', html: '<p>' }));
    await runner.handle(payload('scroll', { tab: 't1', direction: 'down' }));
    expect(results[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('cancels a running command before any side effect as cancelled', async () => {
    const { runner, results, log } = setup((_command, signal) => untilAborted(signal));
    const raw = payload('wait', { tab: 't1', ms: 5_000 });
    const done = runner.handle(raw);
    await flush();
    expect(runner.cancel(raw.command_id as string)).toBe(true);
    await done;
    expect(log[0]).toBe(`ack:${raw.command_id}`);
    expect(results).toEqual([{ command_id: raw.command_id, ok: false, error: { code: 'cancelled', message: expect.any(String) } }]);
  });

  it('reports outcome_unknown when stopped after a side effect may have happened', async () => {
    const { runner, results } = setup((_command, signal, context) => {
      context.sideEffect = true;
      return untilAborted(signal);
    });
    const done = runner.handle(payload('click', { tab: 't1', ref: 'e1', generation: 1 }));
    await flush();
    runner.cancelAll();
    await done;
    expect(results[0]).toMatchObject({ ok: false, error: { code: 'outcome_unknown' } });
  });

  it('aborts at the deadline', async () => {
    vi.useFakeTimers();
    try {
      const { runner, results } = setup((_command, signal) => untilAborted(signal));
      const done = runner.handle(payload('wait', { tab: 't1', text: 'Done' }, { deadline: new Date(NOW + 2_000).toISOString() }));
      await flush();
      vi.advanceTimersByTime(2_000);
      await done;
      expect(results[0]).toMatchObject({ ok: false, error: { code: 'timeout' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps a far-off deadline at the local limit', async () => {
    vi.useFakeTimers();
    try {
      const { runner, results } = setup((_command, signal) => untilAborted(signal));
      const done = runner.handle(payload('wait', { tab: 't1', text: 'Done' }, { deadline: new Date(NOW + 365 * 86_400_000).toISOString() }));
      await flush();
      vi.advanceTimersByTime(MAX_COMMAND_MS - 1);
      await flush();
      expect(results).toEqual([]);
      vi.advanceTimersByTime(1);
      await done;
      expect(results[0]).toMatchObject({ ok: false, error: { code: 'timeout' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels only the commands that match', async () => {
    const { runner, results } = setup((_command, signal) => untilAborted(signal));
    const a = payload('wait', { tab: 't1', ms: 5_000 });
    const b = payload('wait', { tab: 't2', ms: 5_000 });
    const runs = [runner.handle(a), runner.handle(b)];
    await flush();
    expect(runner.cancelWhere((command) => 'tab' in command.params && command.params.tab === 't1', 'tab_closed')).toBe(1);
    await runs[0];
    expect(results).toEqual([{ command_id: a.command_id, ok: false, error: { code: 'tab_closed', message: expect.any(String) } }]);
    runner.cancelAll();
    await runs[1];
  });

  it('answers busy beyond the in-flight limit', async () => {
    const { runner, results } = setup((_command, signal) => untilAborted(signal));
    const runs = Array.from({ length: MAX_IN_FLIGHT }, (_, i) => runner.handle(payload('wait', { tab: `t${i + 1}`, ms: 5_000 })));
    await flush();
    await runner.handle(payload('tabs', {}));
    expect(results[0]).toMatchObject({ ok: false, error: { code: 'busy' } });
    runner.cancelAll();
    await Promise.all(runs);
  });
});
