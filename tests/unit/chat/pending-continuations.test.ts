import {
  addPendingContinuation,
  loadPendingContinuations,
  removePendingContinuation,
  watchPendingContinuations,
  type PendingContinuation,
} from '../../../src/chat/pending-continuations';

const item = (setup_action_id: string, patch: Partial<PendingContinuation> = {}): PendingContinuation => ({
  profile_id: 'p_1',
  workspace_id: 'ws_1',
  session_key: 's1',
  agent_key: 'super-agent',
  setup_action_id,
  ...patch,
});

const stored = async () => (await loadPendingContinuations()).map((i) => `${i.profile_id}/${i.workspace_id}/${i.setup_action_id}`).sort();

describe('pending continuations storage', () => {
  it('keeps both items when two panels add and remove at the same time', async () => {
    // Two writers whose reads and writes interleave: neither removes the other's item.
    await Promise.all([addPendingContinuation(item('act_a')), addPendingContinuation(item('act_b'))]);
    expect(await stored()).toEqual(['p_1/ws_1/act_a', 'p_1/ws_1/act_b']);
    await Promise.all([removePendingContinuation(item('act_a')), addPendingContinuation(item('act_c'))]);

    expect(await stored()).toEqual(['p_1/ws_1/act_b', 'p_1/ws_1/act_c']);
  });

  it('keys items by profile and workspace, so equal setup action ids never collide', async () => {
    await addPendingContinuation(item('act_1'));
    await addPendingContinuation(item('act_1', { profile_id: 'p_2' }));
    await addPendingContinuation(item('act_1', { workspace_id: 'ws_2' }));

    await removePendingContinuation(item('act_1', { profile_id: 'p_2' }));

    expect(await stored()).toEqual(['p_1/ws_1/act_1', 'p_1/ws_2/act_1']);
  });

  it('reports items added and removed by another panel', async () => {
    const added = vi.fn();
    const removed = vi.fn();
    const stop = watchPendingContinuations({ added, removed });

    await addPendingContinuation(item('act_1'));
    await removePendingContinuation(item('act_1'));
    stop();
    await addPendingContinuation(item('act_2'));

    expect(added.mock.calls).toEqual([[item('act_1')]]);
    expect(removed).toHaveBeenCalledTimes(1);
  });
});
