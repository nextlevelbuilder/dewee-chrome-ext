import { fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../../../src/sidepanel/components/Composer';

function renderComposer(onSend: (text: string) => boolean | void) {
  render(<Composer agentName="Super Agent" busy={false} onSend={onSend} onStop={vi.fn()} />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Hello' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input;
}

describe('Composer', () => {
  it('keeps the typed text when the send was refused and nothing left', () => {
    const onSend = vi.fn(() => false);
    const input = renderComposer(onSend);

    expect(onSend).toHaveBeenCalledWith('Hello');
    expect(input.value).toBe('Hello');
  });

  it('clears the text once the send started', () => {
    const input = renderComposer(() => true);

    expect(input.value).toBe('');
  });

  it('takes focus back once a loading conversation re-enables it', () => {
    const props = { agentName: 'Super Agent', busy: false, onSend: vi.fn(), onStop: vi.fn() };
    const { rerender } = render(<Composer {...props} disabled />);
    const input = screen.getByRole('textbox');
    expect(document.activeElement).toBe(document.body);

    rerender(<Composer {...props} disabled={false} />);
    expect(document.activeElement).toBe(input);
  });

  it('leaves focus alone when the user is elsewhere', () => {
    const props = { agentName: 'Super Agent', busy: false, onSend: vi.fn(), onStop: vi.fn() };
    const { rerender } = render(
      <>
        <button type="button">Other</button>
        <Composer {...props} disabled />
      </>,
    );
    const other = screen.getByRole('button', { name: 'Other' });
    other.focus();
    rerender(
      <>
        <button type="button">Other</button>
        <Composer {...props} disabled={false} />
      </>,
    );
    expect(document.activeElement).toBe(other);
  });
});

describe('Composer draft', () => {
  const base = { agentName: 'Super Agent', busy: false, onSend: vi.fn(), onStop: vi.fn() };

  it('puts a draft in the box once, above anything typed, with the caret at the end and nothing sent', () => {
    const { rerender } = render(<Composer {...base} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'my note' } });

    rerender(<Composer {...base} draft={{ id: 'd1', text: '> quote\n\n' }} />);
    expect(input.value).toBe('> quote\n\nmy note');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
    expect(base.onSend).not.toHaveBeenCalled();

    // The same draft rendered again is not added twice.
    rerender(<Composer {...base} draft={{ id: 'd1', text: '> quote\n\n' }} />);
    expect(input.value).toBe('> quote\n\nmy note');

    rerender(<Composer {...base} draft={{ id: 'd2', text: '> second\n\n' }} />);
    expect(input.value).toBe('> second\n\n> quote\n\nmy note');
  });
});