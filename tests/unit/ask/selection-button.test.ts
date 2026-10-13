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

/** jsdom cannot make trusted events; a click with detail 1 stands in for one a person made. */
const byPerson = (event: MouseEvent) => event.detail === 1;
function personClick(button: HTMLButtonElement) {
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
}

describe('Ask Dewee button', () => {
  let mounted: ReturnType<typeof mountAskButton> | undefined;
  let sent: AskSelection[];

  beforeAll(() => {
    // jsdom has no layout.
    Range.prototype.getBoundingClientRect ??= () => new DOMRect(100, 100, 50, 20);
  });
  beforeEach(() => {
    document.body.innerHTML = '<p id="text">Dewee runs agents.</p><input id="field" value="hunter2"><div id="edit" contenteditable="true">draft</div><div id="upper" contenteditable="TRUE"><span id="inner">note</span></div>';
    document.title = 'Docs';
    sent = [];
    mounted = mountAskButton(document, (message) => sent.push(message), 'Ask Dewee', byPerson);
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
    expect(sent).toEqual([]);
    personClick(mounted!.button);
    expect(sent).toEqual([{ type: 'ask.selection', text: 'Dewee runs agents.', url: document.location.href, title: 'Docs' }]);
    expect(mounted!.button.hidden).toBe(true);
  });

  it('ignores selections inside form fields and editable areas', async () => {
    select(document.getElementById('edit')!);
    expect(selectedText(document)).toBeNull();
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush();
    expect(mounted!.button.hidden).toBe(true);
    personClick(mounted!.button);
    expect(sent).toEqual([]);
  });

  it('ignores editable areas in any case and text selected while a field has focus', () => {
    select(document.getElementById('inner')!);
    expect(selectedText(document)).toBeNull();

    // Chrome anchors a selection inside an input at the field's parent; focus gives it away.
    select(document.getElementById('text')!);
    document.getElementById('field')!.focus();
    expect(selectedText(document)).toBeNull();
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
describe('Ask Dewee button defaults', () => {
  it('ignores a click made by page script', async () => {
    document.body.innerHTML = '<p id="text">Dewee runs agents.</p>';
    const sent: AskSelection[] = [];
    const mounted = mountAskButton(document, (message) => sent.push(message), 'Ask Dewee');
    select(document.getElementById('text')!);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await flush();
    mounted.button.click();
    expect(sent).toEqual([]);
    mounted.dispose();
  });
});