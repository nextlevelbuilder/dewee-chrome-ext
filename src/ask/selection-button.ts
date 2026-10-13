/**
 * The "Ask Dewee" button shown next to text the person selects on a web page. It reads only the
 * selection, the page title and the address, and only when the button is clicked. Selections in
 * form fields and editable areas are ignored, so typed passwords and drafts are never offered.
 */
import { MAX_SELECTION, type AskSelection } from '@/protocol/ask-selection';

const STYLE = `
:host { all: initial; }
button {
  position: fixed; z-index: 2147483647; display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 10px; border: 1px solid rgb(255 255 255 / 0.14); border-radius: 999px;
  background: #1b1840; color: #f4f2ff; box-shadow: 0 6px 20px rgb(15 12 40 / 0.28);
  font: 500 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0; cursor: pointer;
}
button:hover { background: #2a2560; }
button:focus-visible { outline: 2px solid #8f7cff; outline-offset: 2px; }
svg { width: 13px; height: 13px; }
`;

const SPARKLE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>';

const FIELD = 'input, textarea, select';

/** Fields whose selection must never be sent: inputs, text areas and editable regions. */
function inEditable(node: Node | null): boolean {
  const element = node instanceof Element ? node : node?.parentElement;
  return Boolean(element && (element.closest(FIELD) || (element as HTMLElement).isContentEditable || element.closest('[contenteditable]:not([contenteditable="false" i])')));
}

/** Chrome reports text selected inside an input or text area with the field's parent as anchor, so check focus too. */
function focusInField(doc: Document): boolean {
  // Follow focus into web components, whose host element is all the document reports.
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return Boolean(active && (active.matches(FIELD) || (active as HTMLElement).isContentEditable));
}

export function selectedText(doc: Document): { text: string; rect: DOMRect } | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (focusInField(doc) || inEditable(selection.anchorNode) || inEditable(selection.focusNode)) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  return { text: text.slice(0, MAX_SELECTION + 1), rect: selection.getRangeAt(0).getBoundingClientRect() };
}

/**
 * Mounts the hidden button and its listeners; dispose removes both. `byPerson` decides whether a click
 * came from the person rather than page script (tests replace it, since they cannot make trusted events).
 */
export function mountAskButton(
  doc: Document,
  send: (message: AskSelection) => unknown,
  label = defaultLabel(doc),
  byPerson: (event: MouseEvent) => boolean = (event) => event.isTrusted,
): { button: HTMLButtonElement; dispose(): void } {
  const host = doc.createElement('dewee-ask');
  const root = host.attachShadow({ mode: 'closed' });
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    // Constructed sheets are not blocked by a page's style-src policy.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
    root.adoptedStyleSheets = [sheet];
  } else {
    const style = doc.createElement('style');
    style.textContent = STYLE;
    root.append(style);
  }
  const button = doc.createElement('button');
  button.type = 'button';
  button.innerHTML = SPARKLE; // Static markup from this file, never page or agent content.
  button.append(doc.createTextNode(label));
  button.hidden = true;
  root.append(button);
  let current: string | null = null;

  const hide = () => {
    button.hidden = true;
    current = null;
  };
  const show = () => {
    const found = selectedText(doc);
    if (!found) return hide();
    current = found.text;
    const view = doc.defaultView;
    const width = view?.innerWidth ?? 1024;
    const height = view?.innerHeight ?? 768;
    const top = found.rect.bottom + 8 > height - 40 ? Math.max(8, found.rect.top - 40) : found.rect.bottom + 8;
    button.style.top = `${Math.round(top)}px`;
    button.style.left = `${Math.round(Math.min(Math.max(8, found.rect.right - 100), width - 120))}px`;
    if (!host.isConnected) doc.documentElement.append(host);
    button.hidden = false;
  };
  // Wait for the selection to settle; events on the button itself must not show it again after a click.
  const later = (event: Event) => {
    if (!event.composedPath().includes(host)) setTimeout(show, 0);
  };
  const onKey = (event: KeyboardEvent) => (event.key === 'Escape' ? hide() : later(event));
  const onDown = (event: MouseEvent) => {
    if (!event.composedPath().includes(host)) hide();
  };

  // Keep the page selection while the button is pressed.
  button.addEventListener('mousedown', (event) => event.preventDefault());
  // Only a real click: a page cannot press the button from script to slip its own text into a draft.
  button.addEventListener('click', (event) => {
    if (!current || !byPerson(event)) return;
    send({ type: 'ask.selection', text: current, url: doc.location.href, title: doc.title });
    hide();
  });
  doc.addEventListener('mouseup', later);
  doc.addEventListener('keyup', onKey);
  doc.addEventListener('mousedown', onDown, true);
  doc.defaultView?.addEventListener('scroll', hide, { passive: true, capture: true });

  const dispose = () => {
    doc.removeEventListener('mouseup', later);
    doc.removeEventListener('keyup', onKey);
    doc.removeEventListener('mousedown', onDown, true);
    doc.defaultView?.removeEventListener('scroll', hide, { capture: true });
    host.remove();
  };
  return { button, dispose };
}

function defaultLabel(doc: Document): string {
  const lang = doc.defaultView?.navigator.language ?? 'en';
  return lang.toLowerCase().startsWith('vi') ? 'Hỏi Dewee' : 'Ask Dewee';
}
