import { act, renderHook, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ASK_DRAFT_KEY, ASK_DRAFT_TTL_MS } from '../../../src/protocol/ask-selection';
import { useAskDraft } from '../../../src/sidepanel/use-ask-draft';

const draft = (patch: Record<string, unknown> = {}) => ({ id: 'd1', text: '> quote\n\n', createdAt: Date.now(), windowId: 1, ...patch });

beforeEach(() => {
  vi.spyOn(fakeBrowser.windows, 'getCurrent').mockResolvedValue({ id: 1 } as never);
});

describe('useAskDraft', () => {
  it('takes a waiting draft once and removes it from session storage', async () => {
    await fakeBrowser.storage.session.set({ [ASK_DRAFT_KEY]: draft() });
    const { result } = renderHook(() => useAskDraft());
    await waitFor(() => expect(result.current.draft?.id).toBe('d1'));
    expect(await fakeBrowser.storage.session.get(ASK_DRAFT_KEY)).toEqual({});
  });

  it('takes a draft that arrives while the panel is open', async () => {
    const { result } = renderHook(() => useAskDraft());
    await act(() => fakeBrowser.storage.session.set({ [ASK_DRAFT_KEY]: draft({ id: 'd2' }) }));
    await waitFor(() => expect(result.current.draft?.id).toBe('d2'));
  });

  it('leaves a draft for another window alone', async () => {
    await fakeBrowser.storage.session.set({ [ASK_DRAFT_KEY]: draft({ windowId: 9 }) });
    const { result } = renderHook(() => useAskDraft());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.draft).toBeNull();
    expect((await fakeBrowser.storage.session.get(ASK_DRAFT_KEY))[ASK_DRAFT_KEY]).toBeDefined();
  });

  it('drops a stale or malformed draft without using it', async () => {
    await fakeBrowser.storage.session.set({ [ASK_DRAFT_KEY]: draft({ createdAt: Date.now() - ASK_DRAFT_TTL_MS - 1000 }) });
    const { result } = renderHook(() => useAskDraft());
    await waitFor(async () => expect(await fakeBrowser.storage.session.get(ASK_DRAFT_KEY)).toEqual({}));
    expect(result.current.draft).toBeNull();

    await act(() => fakeBrowser.storage.session.set({ [ASK_DRAFT_KEY]: { text: 'no id' } }));
    await waitFor(async () => expect(await fakeBrowser.storage.session.get(ASK_DRAFT_KEY)).toEqual({}));
    expect(result.current.draft).toBeNull();
  });

  it('forgets a draft once the composer has taken it', async () => {
    await fakeBrowser.storage.session.set({ [ASK_DRAFT_KEY]: draft({ id: 'd3' }) });
    const { result } = renderHook(() => useAskDraft());
    await waitFor(() => expect(result.current.draft?.id).toBe('d3'));
    act(() => result.current.taken('other'));
    expect(result.current.draft?.id).toBe('d3');
    act(() => result.current.taken('d3'));
    expect(result.current.draft).toBeNull();
  });
});