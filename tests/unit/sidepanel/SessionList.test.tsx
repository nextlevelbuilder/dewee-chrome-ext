import { fireEvent, render, screen } from '@testing-library/react';
import { SessionList } from '../../../src/sidepanel/components/SessionList';

const state = { loading: false, error: null, data: { sessions: [{ key: 's1', title: 'First' }], total: 1 } };

function renderList(busy: boolean) {
  const onSelect = vi.fn();
  const onNew = vi.fn();
  render(<SessionList state={state as never} busy={busy} onSelect={onSelect} onNew={onNew} onClose={vi.fn()} onMore={vi.fn()} canLoadMore={false} onRetry={vi.fn()} />);
  return { onSelect, onNew };
}

describe('SessionList', () => {
  it('keeps a streaming reply: new chat and switching wait until it ends', () => {
    const { onSelect, onNew } = renderList(true);
    const item = screen.getByRole('button', { name: /First/ });
    const newChat = screen.getByRole('button', { name: /New chat/ });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect((newChat as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(item);
    fireEvent.click(newChat);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onNew).not.toHaveBeenCalled();
  });

  it('switches conversations when idle', () => {
    const { onSelect } = renderList(false);
    fireEvent.click(screen.getByRole('button', { name: /First/ }));
    expect(onSelect).toHaveBeenCalledWith('s1');
  });
});