/**
 * The page side of the executor: one function bundled with the extension and injected with
 * `chrome.scripting.executeScript({ func, args })` into the isolated world of an owned tab. It is
 * never built from a string and never receives code; the Gateway only picks an operation and
 * plain arguments.
 *
 * `executeScript` serializes the function's source, so `pageRun` must be self-contained: every
 * helper is declared inside it and nothing from this module's scope is referenced.
 *
 * Snapshot: a compact accessibility outline, one element per line (`[e12] button "Sign in"`).
 * Refs live in the isolated world (invisible to the page), bound to a generation the extension
 * moves on every navigation; a large DOM change marks them stale. Values of password, PIN, payment
 * and one-time-code fields are never read out, whatever role the page gives them; hidden and
 * invisible nodes are skipped;
 * cross-origin frames are omitted and same-origin frames are included only when their origin is
 * in the grant.
 */
import type { PressKey } from './protocol';

export type PageRequest =
  | { op: 'snapshot'; origins: string[]; generation: number; maxChars: number }
  | { op: 'describe'; origins: string[]; generation: number; ref: string }
  /** Describes the element that has keyboard focus (the page body when nothing has). */
  | { op: 'focused'; origins: string[] }
  | { op: 'click'; origins: string[]; generation: number; ref: string }
  /** Outlines the element for a moment before a click, so the person sees what the agent is about to press. */
  | { op: 'highlight'; origins: string[]; generation: number; ref: string }
  | { op: 'type'; origins: string[]; generation: number; ref: string; text: string; submit: boolean }
  | { op: 'press'; origins: string[]; key: PressKey }
  | { op: 'scroll'; origins: string[]; direction: 'up' | 'down'; amount: 'page' | 'half' }
  | { op: 'findText'; origins: string[]; text: string }
  | { op: 'watch'; origins: string[] };

export type PageErrorCode = 'stale_ref' | 'element_not_found' | 'element_not_interactable' | 'sensitive_field' | 'origin_not_granted' | 'internal';

export type PageResponse =
  | { ok: true; op: 'snapshot'; text: string; url: string; title: string }
  | { ok: true; op: 'describe'; role: string; name: string; sensitive: boolean; editable: boolean }
  | { ok: true; op: 'click' | 'highlight' | 'type' | 'press' | 'scroll' | 'watch' }
  | { ok: true; op: 'findText'; found: boolean }
  | { ok: false; code: PageErrorCode };

export function pageRun(request: PageRequest): PageResponse {
  const STATE_KEY = '__deweeBrowserControl';
  /** DOM nodes added or removed after a snapshot beyond which its refs are treated as stale. */
  const MUTATION_LIMIT = 200;
  const TEXT_LINE_MAX = 300;
  const VALUE_MAX = 200;

  interface RefState {
    generation: number;
    next: number;
    refs: Map<string, WeakRef<Element>>;
    ids: WeakMap<Element, string>;
    mutations: number;
    dirty: boolean;
    observer: MutationObserver | null;
  }
  type Holder = Record<string, unknown>;
  const holder = globalThis as unknown as Holder;

  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
  ]);
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'svg', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED']);
  const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'month', 'time', 'week']);

  const collapse = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const tagOf = (el: Element) => el.tagName.toUpperCase();
  const attr = (el: Element, name: string) => el.getAttribute(name);

  function pageOrigin(doc: Document): string {
    try {
      return doc.location.origin;
    } catch {
      return 'null';
    }
  }

  function inputType(el: Element): string {
    return tagOf(el) === 'INPUT' ? (attr(el, 'type') ?? '').toLowerCase() : '';
  }

  function roleOf(el: Element): string {
    const explicit = collapse(attr(el, 'role')).split(' ')[0];
    if (explicit) return explicit;
    switch (tagOf(el)) {
      case 'A':
        return el.hasAttribute('href') ? 'link' : '';
      case 'BUTTON':
      case 'SUMMARY':
        return 'button';
      case 'SELECT':
        return el.hasAttribute('multiple') || Number(attr(el, 'size') ?? 0) > 1 ? 'listbox' : 'combobox';
      case 'TEXTAREA':
        return 'textbox';
      case 'OPTION':
        return 'option';
      case 'IMG':
        return collapse(attr(el, 'alt')) ? 'img' : '';
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        return 'heading';
      case 'INPUT': {
        const type = inputType(el);
        if (type === 'hidden') return '';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'search') return 'searchbox';
        if (['button', 'submit', 'reset', 'image', 'file'].includes(type)) return 'button';
        return 'textbox';
      }
    }
    const editable = attr(el, 'contenteditable');
    if (editable !== null && editable !== 'false') return 'textbox';
    return '';
  }

  function isVisible(el: Element): boolean {
    if ((el as HTMLElement).hidden || attr(el, 'aria-hidden') === 'true' || inputType(el) === 'hidden') return false;
    const view = el.ownerDocument.defaultView;
    const style = view ? view.getComputedStyle(el) : null;
    if (style) {
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (style.display === 'contents') return true;
    }
    return el.getClientRects().length > 0;
  }

  function hasArea(el: Element): boolean {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Words in a field's name or id that mark a password, PIN or one-time code. */
  const SECRET_WORDS = new Set(['pass', 'password', 'passwd', 'passcode', 'passphrase', 'pwd', 'pin', 'otp', 'totp', 'otc', 'mfa', '2fa']);

  /**
   * Password, PIN, payment card and one-time-code fields: their values never leave the page and
   * nothing is typed into them. A password field switched to `type=text` by a "show password"
   * button is still caught by its `autocomplete`, name or id.
   */
  function isSensitive(el: Element): boolean {
    if (inputType(el) === 'password') return true;
    const autocomplete = (attr(el, 'autocomplete') ?? '').toLowerCase();
    if (/(^|\s)(cc-|one-time-code|current-password|new-password)/.test(autocomplete)) return true;
    const raw = `${attr(el, 'name') ?? ''} ${attr(el, 'id') ?? ''}`;
    // Split camelCase and separators into words, so "userPin" and "otp_code" match but "shipping" does not.
    const hints = raw.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    if (hints.split(/[^a-z0-9]+/).some((word) => SECRET_WORDS.has(word) || word.startsWith('password'))) return true;
    return /card.?num|cc.?num|cc.?number|cvc|cvv|csc|security.?code|card.?code|expiry|exp.?date|iban|verification.?code|auth.?code|one.?time/.test(hints);
  }

  function isEditable(el: Element): boolean {
    const tag = tagOf(el);
    if (tag === 'TEXTAREA') return !(el as HTMLTextAreaElement).readOnly;
    if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(inputType(el)) && !(el as HTMLInputElement).readOnly;
    const editable = attr(el, 'contenteditable');
    return editable !== null && editable !== 'false';
  }

  function isDisabled(el: Element): boolean {
    if ((el as HTMLButtonElement).disabled === true) return true;
    if (attr(el, 'aria-disabled') === 'true') return true;
    return Boolean(el.closest('fieldset[disabled]'));
  }

  function textOf(el: Element): string {
    return collapse(el.textContent);
  }

  function nameOf(el: Element): string {
    const label = collapse(attr(el, 'aria-label'));
    if (label) return label;
    const labelledBy = attr(el, 'aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter((node): node is HTMLElement => Boolean(node))
        .map((node) => textOf(node))
        .join(' ');
      if (collapse(text)) return collapse(text);
    }
    const tag = tagOf(el);
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const labels = (el as HTMLInputElement).labels;
      const fromLabels = labels ? collapse([...labels].map((node) => textOf(node)).join(' ')) : '';
      if (fromLabels) return fromLabels;
      const type = inputType(el);
      if (['button', 'submit', 'reset'].includes(type)) return collapse((el as HTMLInputElement).value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      if (type === 'image') return collapse(attr(el, 'alt'));
      return collapse(attr(el, 'placeholder')) || collapse(attr(el, 'title'));
    }
    if (tag === 'IMG') return collapse(attr(el, 'alt'));
    const role = roleOf(el);
    if (role === 'textbox') return collapse(attr(el, 'placeholder')) || collapse(attr(el, 'title'));
    return textOf(el) || collapse(attr(el, 'title'));
  }

  function valueOf(el: Element, role: string): string {
    // Before anything else: a sensitive field is redacted whatever role the page gives it.
    if (isSensitive(el)) return ' value=[redacted]';
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const checked = tagOf(el) === 'INPUT' ? (el as HTMLInputElement).checked : attr(el, 'aria-checked') === 'true';
      return checked ? ' checked' : ' unchecked';
    }
    const tag = tagOf(el);
    if (tag === 'SELECT') {
      const select = el as HTMLSelectElement;
      const chosen = [...select.selectedOptions].map((option) => collapse(option.textContent)).join(', ');
      return ` value=${JSON.stringify(clip(chosen, VALUE_MAX))}`;
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (['button', 'submit', 'reset', 'image', 'file'].includes(inputType(el))) return '';
      return ` value=${JSON.stringify(clip((el as HTMLInputElement).value, VALUE_MAX))}`;
    }
    if (role === 'textbox') return ` value=${JSON.stringify(clip(textOf(el), VALUE_MAX))}`;
    return '';
  }

  function topGranted(): boolean {
    return request.origins.includes(pageOrigin(document));
  }

  function currentState(): RefState | undefined {
    return holder[STATE_KEY] as RefState | undefined;
  }

  function freshState(generation: number): RefState {
    currentState()?.observer?.disconnect();
    const state: RefState = { generation, next: 1, refs: new Map(), ids: new WeakMap(), mutations: 0, dirty: false, observer: null };
    if (typeof MutationObserver === 'function' && document.documentElement) {
      state.observer = new MutationObserver((records) => {
        for (const record of records) state.mutations += record.addedNodes.length + record.removedNodes.length;
        if (state.mutations > MUTATION_LIMIT) state.dirty = true;
      });
      state.observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    holder[STATE_KEY] = state;
    return state;
  }

  function refFor(state: RefState, el: Element): string {
    const known = state.ids.get(el);
    if (known) return known;
    const ref = `e${state.next++}`;
    state.ids.set(el, ref);
    state.refs.set(ref, new WeakRef(el));
    return ref;
  }

  function snapshot(generation: number, maxChars: number): PageResponse {
    const existing = currentState();
    if (existing && existing.generation === generation && existing.dirty) return { ok: false, code: 'stale_ref' };
    const state = existing && existing.generation === generation ? existing : freshState(generation);
    state.mutations = 0;
    const lines: string[] = [];
    let used = 0;
    let full = false;
    const budget = Math.max(64, maxChars) - 32;

    const push = (line: string) => {
      if (full) return;
      if (used + line.length + 1 > budget) {
        full = true;
        lines.push('… (truncated)');
        return;
      }
      lines.push(line);
      used += line.length + 1;
    };

    const walk = (node: Element, indent: string) => {
      for (const child of [...node.childNodes]) {
        if (full) return;
        if (child.nodeType === Node.TEXT_NODE) {
          const text = collapse(child.textContent);
          if (text) push(`${indent}text ${JSON.stringify(clip(text, TEXT_LINE_MAX))}`);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const el = child as Element;
        if (SKIP_TAGS.has(el.tagName) || SKIP_TAGS.has(tagOf(el))) continue;
        if (!isVisible(el)) continue;
        const tag = tagOf(el);
        if (tag === 'IFRAME' || tag === 'FRAME') {
          let inner: Document | null;
          try {
            inner = (el as HTMLIFrameElement).contentDocument;
          } catch {
            inner = null;
          }
          // Cross-origin frames are unreadable and omitted; same-origin ones only when the grant covers them.
          if (inner?.body && request.origins.includes(pageOrigin(inner))) {
            push(`${indent}frame ${JSON.stringify(clip(nameOf(el) || collapse(attr(el, 'title')), TEXT_LINE_MAX))}`);
            walk(inner.body, `${indent}  `);
          }
          continue;
        }
        const role = roleOf(el);
        if (role === 'heading') {
          const level = /^H[1-6]$/.test(tag) ? tag.slice(1) : attr(el, 'aria-level') ?? '';
          push(`${indent}heading ${JSON.stringify(clip(nameOf(el), TEXT_LINE_MAX))}${level ? ` level=${level}` : ''}`);
          continue;
        }
        if (role === 'img') {
          const alt = nameOf(el);
          if (alt) push(`${indent}img ${JSON.stringify(clip(alt, TEXT_LINE_MAX))}`);
          continue;
        }
        if (INTERACTIVE_ROLES.has(role) && hasArea(el)) {
          const name = clip(nameOf(el), TEXT_LINE_MAX);
          const type = inputType(el) === 'password' ? ' type=password' : '';
          push(`${indent}[${refFor(state, el)}] ${role} ${JSON.stringify(name)}${type}${valueOf(el, role)}${isDisabled(el) ? ' disabled' : ''}`);
          continue;
        }
        walk(el, indent);
        const shadow = (el as HTMLElement).shadowRoot;
        if (shadow) walk(shadow as unknown as Element, indent);
      }
    };

    if (document.body) walk(document.body, '');
    return { ok: true, op: 'snapshot', text: lines.join('\n'), url: document.location.href, title: collapse(document.title) };
  }

  type Resolved = { ok: true; el: Element } | { ok: false; code: PageErrorCode };

  function resolve(ref: string, generation: number): Resolved {
    const state = currentState();
    if (!state || state.generation !== generation || state.dirty) return { ok: false, code: 'stale_ref' };
    const el = state.refs.get(ref)?.deref();
    if (!el || !el.isConnected) return { ok: false, code: 'element_not_found' };
    if (!request.origins.includes(pageOrigin(el.ownerDocument))) return { ok: false, code: 'origin_not_granted' };
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (!isVisible(node)) return { ok: false, code: 'element_not_interactable' };
    }
    if (!hasArea(el) || isDisabled(el)) return { ok: false, code: 'element_not_interactable' };
    return { ok: true, el };
  }

  /** Scrolls the element into view and checks that a click at its centre would land on it. */
  function reachable(el: Element): { x: number; y: number } | null {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = el.ownerDocument.elementFromPoint(x, y);
    if (!hit) return null;
    if (hit === el || el.contains(hit)) return { x, y };
    // A label wrapping or naming the control receives the click on its behalf.
    const labels = (el as HTMLInputElement).labels;
    if (labels && [...labels].some((label) => label === hit || label.contains(hit))) return { x, y };
    return null;
  }

  function pointer(el: Element, x: number, y: number) {
    const view = el.ownerDocument.defaultView ?? window;
    // `view` is optional and left out: some DOM implementations reject a window from another realm.
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
    const PointerCtor = (view as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent;
    if (PointerCtor) el.dispatchEvent(new PointerCtor('pointerdown', { ...init, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new view.MouseEvent('mousedown', init));
    if (PointerCtor) el.dispatchEvent(new PointerCtor('pointerup', { ...init, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new view.MouseEvent('mouseup', init));
  }

  function setValue(el: Element, text: string) {
    const view = el.ownerDocument.defaultView ?? window;
    const proto = tagOf(el) === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    // The prototype setter keeps frameworks that track the value (React) in sync with the change.
    if (setter) setter.call(el, text);
    else (el as HTMLInputElement).value = text;
    el.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new view.Event('change', { bubbles: true }));
  }

  function key(target: Element, name: string, type: 'keydown' | 'keyup'): boolean {
    const view = target.ownerDocument.defaultView ?? window;
    return target.dispatchEvent(new view.KeyboardEvent(type, { key: name, code: name, bubbles: true, cancelable: true, composed: true }));
  }

  function focusables(doc: Document): HTMLElement[] {
    const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable]:not([contenteditable="false"])';
    return [...doc.querySelectorAll<HTMLElement>(selector)].filter((el) => el.tabIndex >= 0 && !isDisabled(el) && isVisible(el));
  }

  try {
    if (!topGranted()) return { ok: false, code: 'origin_not_granted' };
    switch (request.op) {
      case 'snapshot':
        return snapshot(request.generation, request.maxChars);
      case 'describe': {
        const found = resolve(request.ref, request.generation);
        if (!found.ok) return found;
        const role = roleOf(found.el);
        return { ok: true, op: 'describe', role, name: clip(nameOf(found.el), TEXT_LINE_MAX), sensitive: isSensitive(found.el), editable: isEditable(found.el) };
      }
      case 'focused': {
        const active = document.activeElement;
        const el = active && active !== document.documentElement ? active : document.body;
        if (!el) return { ok: true, op: 'describe', role: '', name: '', sensitive: false, editable: false };
        return { ok: true, op: 'describe', role: roleOf(el), name: el === document.body ? '' : clip(nameOf(el), TEXT_LINE_MAX), sensitive: isSensitive(el), editable: isEditable(el) };
      }
      case 'click': {
        const found = resolve(request.ref, request.generation);
        if (!found.ok) return found;
        const point = reachable(found.el);
        if (!point) return { ok: false, code: 'element_not_interactable' };
        pointer(found.el, point.x, point.y);
        (found.el as HTMLElement).focus?.({ preventScroll: true });
        (found.el as HTMLElement).click();
        return { ok: true, op: 'click' };
      }
      case 'highlight': {
        const found = resolve(request.ref, request.generation);
        if (!found.ok) return found;
        found.el.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = found.el.getBoundingClientRect();
        const doc = found.el.ownerDocument;
        // A short-lived outline drawn by the extension; it takes no clicks and is gone in about a second.
        const box = doc.createElement('div');
        box.setAttribute('aria-hidden', 'true');
        box.style.cssText = [
          'position:fixed',
          `left:${rect.left - 3}px`,
          `top:${rect.top - 3}px`,
          `width:${rect.width + 6}px`,
          `height:${rect.height + 6}px`,
          'border:3px solid #7c3aed',
          'border-radius:4px',
          'background:rgba(124,58,237,0.12)',
          'box-sizing:border-box',
          'pointer-events:none',
          'z-index:2147483647',
        ].join(';');
        doc.documentElement.appendChild(box);
        setTimeout(() => box.remove(), 900);
        return { ok: true, op: 'highlight' };
      }
      case 'type': {
        const found = resolve(request.ref, request.generation);
        if (!found.ok) return found;
        const el = found.el;
        if (isSensitive(el)) return { ok: false, code: 'sensitive_field' };
        if (!isEditable(el) || !reachable(el)) return { ok: false, code: 'element_not_interactable' };
        (el as HTMLElement).focus({ preventScroll: true });
        const tag = tagOf(el);
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          setValue(el, request.text);
        } else {
          const doc = el.ownerDocument;
          const selection = doc.getSelection();
          const range = doc.createRange();
          range.selectNodeContents(el);
          selection?.removeAllRanges();
          selection?.addRange(range);
          // insertText goes through the editor's own input handling; fall back to plain text.
          const inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, request.text);
          if (!inserted) {
            el.textContent = request.text;
            el.dispatchEvent(new (doc.defaultView ?? window).Event('input', { bubbles: true, composed: true }));
          }
        }
        if (request.submit) {
          const form = (el as HTMLInputElement).form;
          if (form) {
            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.submit();
          } else {
            key(el, 'Enter', 'keydown');
            key(el, 'Enter', 'keyup');
          }
        }
        return { ok: true, op: 'type' };
      }
      case 'press': {
        const doc = document;
        const target = (doc.activeElement && doc.activeElement !== doc.documentElement ? doc.activeElement : doc.body) ?? doc.documentElement;
        const proceed = key(target, request.key, 'keydown');
        // Synthetic key events have no default action, so the harmless ones are applied here. Enter and
        // Escape are only dispatched: activating a focused control could skip the high-risk confirmation.
        if (proceed) {
          const editing = isEditable(target);
          const page = window.innerHeight * 0.9;
          if (request.key === 'Tab') {
            const list = focusables(doc);
            const next = list[(list.indexOf(target as HTMLElement) + 1) % Math.max(1, list.length)];
            next?.focus();
          } else if (request.key === 'Backspace' && editing && (tagOf(target) === 'INPUT' || tagOf(target) === 'TEXTAREA')) {
            if (!isSensitive(target)) setValue(target, (target as HTMLInputElement).value.slice(0, -1));
          } else if (!editing) {
            const delta: Partial<Record<PressKey, number>> = { PageDown: page, PageUp: -page, ArrowDown: 40, ArrowUp: -40, ArrowRight: 0, ArrowLeft: 0 };
            if (request.key === 'Home') window.scrollTo({ top: 0 });
            else if (request.key === 'End') window.scrollTo({ top: doc.documentElement.scrollHeight });
            else if (delta[request.key]) window.scrollBy({ top: delta[request.key] });
          }
        }
        key(target, request.key, 'keyup');
        return { ok: true, op: 'press' };
      }
      case 'scroll': {
        const distance = window.innerHeight * (request.amount === 'half' ? 0.5 : 0.9);
        window.scrollBy({ top: request.direction === 'down' ? distance : -distance });
        return { ok: true, op: 'scroll' };
      }
      case 'findText': {
        const body = document.body;
        const text = body ? ((body as HTMLElement).innerText ?? body.textContent ?? '') : '';
        return { ok: true, op: 'findText', found: text.includes(request.text) };
      }
      case 'watch': {
        // Clicks and key presses made by the person (trusted events only; the executor's own events
        // are synthetic) stop the agent's current command in this tab.
        const WATCH_KEY = '__deweeBrowserWatch';
        if (!holder[WATCH_KEY]) {
          holder[WATCH_KEY] = true;
          let last = 0;
          const notify = (event: Event) => {
            if (!event.isTrusted || Date.now() - last < 500) return;
            last = Date.now();
            void chrome.runtime.sendMessage({ type: 'browser.userInput' }).catch(() => undefined);
          };
          window.addEventListener('pointerdown', notify, true);
          window.addEventListener('keydown', notify, true);
        }
        return { ok: true, op: 'watch' };
      }
    }
  } catch {
    return { ok: false, code: 'internal' };
  }
}
