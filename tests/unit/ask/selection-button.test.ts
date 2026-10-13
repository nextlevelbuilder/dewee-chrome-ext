import { mountAskButton, selectedText } from '../../../src/ask/selection-button';
import type { AskSelection } from '../../../src/protocol/ask-selection';

function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Ask Dewee button', () => {
  let mounted: ReturnType<typeof mountAskButton> | undefined;
  let sent: AskSelection[];

  beforeAll(() => {
    // jsdom has no layout.
    Range.prototype.getBoundingClientRect ??= () => new DOMRect(100, 100, 50, 20);
  });
  beforeEach(() => {
    document.body.innerHTML = '<p id="text">Dewee runs agents.</p><input id="field" value="hunter2"><div id="edit" contenteditable="true">draft</div>';
    document.title = 'Docs';
    sent = [];
    mounted = mountAskButton(document, (message) => sent.push(message), 'Ask Dewee');
  });
  afterEach(() => {
    mounted?.dispose();
    document.getSelection()?.removeAllRanges();
  });

  it('shows after a selection and sends the text, address and title once on click', async () => {
    select(document.getElementById('text')!);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush();
    expect(mounted!.button.hidden).toBe(false);
    expect(mounted!.button.textContent).toBe('Ask Dewee');

    mounted!.button.click();
    expect(sent).toEqual([{ type: 'ask.selection', text: 'Dewee runs agents.', url: document.location.href, title: 'Docs' }]);
    expect(mounted!.button.hidden).toBe(true);
  });

  it('ignores selections inside form fields and editable areas', async () => {
    select(document.getElementById('edit')!);
    expect(selectedText(document)).toBeNull();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush();
    expect(mounted!.button.hidden).toBe(true);
    mounted!.button.click();
    expect(sent).toEqual([]);
  });

  it('hides on Escape and when the selection is cleared', async () => {
    select(document.getElementById('text')!);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush();
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    expect(mounted!.button.hidden).toBe(true);

    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush();
    expect(mounted!.button.hidden).toBe(true);
  });

  it('removes its element and listeners on dispose', async () => {
    select(document.getElementById('text')!);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush();
    expect(document.querySelector('dewee-ask')).not.toBeNull();
    mounted!.dispose();
    mounted = undefined;
    expect(document.querySelector('dewee-ask')).toBeNull();
  });
});