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
});
