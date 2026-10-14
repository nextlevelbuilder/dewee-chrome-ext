import { TabRegistry, USER_INPUT_HOLD_MS } from '@/browser/tabs';

describe('TabRegistry', () => {
  it('hands out opaque, increasing handles and never reuses them', () => {
    const tabs = new TabRegistry();
    expect(tabs.add(101, 'g1', 'a1').handle).toBe('t1');
    expect(tabs.add(102, 'g1', 'a1').handle).toBe('t2');
    tabs.clear();
    expect(tabs.add(103, 'g1', 'a1').handle).toBe('t3');
    expect(tabs.get('t1')).toBeUndefined();
  });

  it('lists open tabs per grant', () => {
    const tabs = new TabRegistry();
    tabs.add(1, 'g1', 'a');
    tabs.add(2, 'g2', 'a');
    tabs.add(3, 'g1', 'a');
    expect(tabs.ownedBy('g1').map((t) => t.handle)).toEqual(['t1', 't3']);
    tabs.markClosed(3);
    expect(tabs.ownedBy('g1').map((t) => t.handle)).toEqual(['t1']);
  });

  it('keeps a closed tab so later commands learn it was closed', () => {
    const tabs = new TabRegistry();
    tabs.add(1, 'g1', 'a');
    expect(tabs.markClosed(1)?.handle).toBe('t1');
    expect(tabs.get('t1')?.closed).toBe(true);
    expect(tabs.byTabId(1)).toBeUndefined();
    expect(tabs.markClosed(1)).toBeUndefined();
  });

  it('bumps the generation on navigation', () => {
    const tabs = new TabRegistry();
    const tab = tabs.add(1, 'g1', 'a');
    tabs.bump(1);
    tabs.bump(1);
    expect(tab.generation).toBe(3);
    tabs.bump(99);
  });

  it('allows one writer per tab', () => {
    const tabs = new TabRegistry();
    tabs.add(1, 'g1', 'a');
    expect(tabs.lease('t1')).toBe(true);
    expect(tabs.lease('t1')).toBe(false);
    tabs.release('t1');
    expect(tabs.lease('t1')).toBe(true);
  });

  it('holds a tab for a short time after the person used it', () => {
    const tabs = new TabRegistry();
    tabs.add(1, 'g1', 'a');
    expect(tabs.noteUserInput(1, 1_000)?.handle).toBe('t1');
    expect(tabs.isHeldByUser(1, 1_000 + USER_INPUT_HOLD_MS - 1)).toBe(true);
    expect(tabs.isHeldByUser(1, 1_000 + USER_INPUT_HOLD_MS)).toBe(false);
    expect(tabs.noteUserInput(2, 1_000)).toBeUndefined();
  });

  it('releases the tabs of a revoked grant and leaves the rest', () => {
    const tabs = new TabRegistry();
    tabs.add(1, 'g1', 'a');
    tabs.add(2, 'g2', 'a');
    expect(tabs.releaseGrant('g1').map((t) => t.handle)).toEqual(['t1']);
    expect(tabs.all().map((t) => t.handle)).toEqual(['t2']);
  });

  it('survives a worker restart through serialize/restore and ignores corrupt data', () => {
    const tabs = new TabRegistry();
    tabs.add(1, 'g1', 'a');
    tabs.bump(1);
    const restored = new TabRegistry();
    restored.restore(tabs.serialize());
    expect(restored.get('t1')).toMatchObject({ tabId: 1, generation: 2 });
    expect(restored.add(2, 'g1', 'a').handle).toBe('t2');
    restored.restore({ next: 'x' });
    expect(restored.get('t2')).toBeDefined();
  });
});
