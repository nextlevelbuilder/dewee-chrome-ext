import { pageRun, type PageRequest } from '@/browser/snapshot';

const STATE_KEY = '__deweeBrowserControl';

function origins(): string[] {
  return [location.origin];
}

function snapshot(generation = 1, maxChars = 20_000) {
  const response = pageRun({ op: 'snapshot', origins: origins(), generation, maxChars });
  if (!response.ok || response.op !== 'snapshot') throw new Error(`snapshot failed: ${JSON.stringify(response)}`);
  return response.text;
}

function refOf(text: string, needle: string): string {
  const line = text.split('\n').find((l) => /\[e\d+\]/.test(l) && l.includes(`"${needle}"`));
  const ref = line?.match(/\[(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`no ref for ${needle} in\n${text}`);
  return ref;
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[STATE_KEY];
  // jsdom has no layout: give every element a box, and let clicks land on their target.
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) }) as DOMRect);
  Element.prototype.scrollIntoView = vi.fn();
  document.elementFromPoint = vi.fn(() => null);
  document.title = 'Sign in';
  document.body.innerHTML = `
    <h1>Welcome back</h1>
    <form id="login">
      <label for="email">Email</label><input id="email" type="email" value="ada@example.com">
      <label for="pw">Password</label><input id="pw" type="password" value="hunter2-secret">
      <label for="card">Card number</label><input id="card" autocomplete="cc-number" value="4111111111111111">
      <input type="hidden" name="csrf" value="csrf-token-value">
      <button type="submit" id="go">Sign in</button>
    </form>
    <button style="display:none">Hidden by style</button>
    <button hidden>Hidden attribute</button>
    <div aria-hidden="true"><button>Hidden from AT</button></div>
    <div style="visibility:hidden"><a href="/x">Invisible link</a></div>
    <button id="del" disabled>Delete account</button>
    <p>Plain paragraph text</p>
  `;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('snapshot', () => {
  it('outlines visible elements with refs and roles', () => {
    const text = snapshot();
    expect(text).toContain('heading "Welcome back" level=1');
    expect(text).toMatch(/\[e\d+\] textbox "Email" value="ada@example.com"/);
    expect(text).toMatch(/\[e\d+\] button "Sign in"/);
    expect(text).toMatch(/\[e\d+\] button "Delete account" disabled/);
    expect(text).toContain('text "Plain paragraph text"');
  });

  it('never reads out password, payment or hidden values', () => {
    const text = snapshot();
    expect(text).toMatch(/textbox "Password" type=password value=\[redacted\]/);
    expect(text).toMatch(/textbox "Card number" value=\[redacted\]/);
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('4111111111111111');
    expect(text).not.toContain('csrf-token-value');
  });

  it('skips hidden and invisible nodes', () => {
    const text = snapshot();
    for (const hidden of ['Hidden by style', 'Hidden attribute', 'Hidden from AT', 'Invisible link']) expect(text).not.toContain(hidden);
  });

  it('keeps refs stable within a generation and starts over in a new one', () => {
    const first = snapshot(1);
    expect(snapshot(1)).toBe(first);
    expect(refOf(snapshot(2), 'Email')).toBe('e1');
  });

  it('caps the output at max_chars', () => {
    document.body.innerHTML = Array.from({ length: 200 }, (_, i) => `<p>Paragraph number ${i} with some words</p>`).join('');
    const text = snapshot(1, 500);
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.endsWith('(truncated)')).toBe(true);
  });

  it('refuses a page whose origin is not granted', () => {
    expect(pageRun({ op: 'snapshot', origins: ['https://other.example.test'], generation: 1, maxChars: 1000 })).toEqual({ ok: false, code: 'origin_not_granted' });
  });

  it('marks refs stale after a large DOM change', async () => {
    snapshot(1);
    const list = document.createElement('div');
    document.body.append(list);
    for (let i = 0; i < 260; i += 1) list.append(document.createElement('span'));
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pageRun({ op: 'snapshot', origins: origins(), generation: 1, maxChars: 1000 })).toEqual({ ok: false, code: 'stale_ref' });
  });
});

describe('actions on refs', () => {
  type RefRequest = Extract<PageRequest, { ref: string }>;
  // Distributes over the union so each op keeps its own fields.
  type WithoutOrigins<T> = T extends unknown ? Omit<T, 'origins'> : never;
  const run = (request: WithoutOrigins<RefRequest>) => pageRun({ ...request, origins: origins() } as PageRequest);

  it('rejects a ref from an older generation', () => {
    const ref = refOf(snapshot(1), 'Email');
    snapshot(2);
    expect(run({ op: 'click', generation: 1, ref })).toEqual({ ok: false, code: 'stale_ref' });
  });

  it('describes a password field as sensitive and refuses to type into it', () => {
    const ref = refOf(snapshot(), 'Password');
    expect(run({ op: 'describe', generation: 1, ref })).toMatchObject({ ok: true, sensitive: true, editable: true });
    expect(run({ op: 'type', generation: 1, ref, text: 'guess', submit: false })).toEqual({ ok: false, code: 'sensitive_field' });
    expect((document.getElementById('pw') as HTMLInputElement).value).toBe('hunter2-secret');
  });

  it('types into a text field with input events', () => {
    const ref = refOf(snapshot(), 'Email');
    const input = document.getElementById('email') as HTMLInputElement;
    const onInput = vi.fn();
    input.addEventListener('input', onInput);
    document.elementFromPoint = vi.fn(() => input);
    expect(run({ op: 'type', generation: 1, ref, text: 'grace@example.com', submit: false })).toEqual({ ok: true, op: 'type' });
    expect(input.value).toBe('grace@example.com');
    expect(onInput).toHaveBeenCalled();
  });

  it('clicks only when the element is reachable', () => {
    const ref = refOf(snapshot(), 'Sign in');
    const button = document.getElementById('go') as HTMLButtonElement;
    const onClick = vi.fn((event: Event) => event.preventDefault());
    button.addEventListener('click', onClick);
    expect(run({ op: 'click', generation: 1, ref })).toEqual({ ok: false, code: 'element_not_interactable' });
    expect(onClick).not.toHaveBeenCalled();
    document.elementFromPoint = vi.fn(() => button);
    expect(run({ op: 'click', generation: 1, ref })).toEqual({ ok: true, op: 'click' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('refuses disabled, removed and newly hidden elements', () => {
    const text = snapshot();
    expect(run({ op: 'click', generation: 1, ref: refOf(text, 'Delete account') })).toEqual({ ok: false, code: 'element_not_interactable' });
    const signIn = refOf(text, 'Sign in');
    (document.getElementById('go') as HTMLElement).style.display = 'none';
    expect(run({ op: 'click', generation: 1, ref: signIn })).toEqual({ ok: false, code: 'element_not_interactable' });
    document.getElementById('go')?.remove();
    expect(run({ op: 'click', generation: 1, ref: signIn })).toEqual({ ok: false, code: 'element_not_found' });
    expect(run({ op: 'click', generation: 1, ref: 'e999' })).toEqual({ ok: false, code: 'element_not_found' });
  });
});

describe('sensitive fields', () => {
  beforeEach(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `
      <input id="shown" type="text" autocomplete="current-password" aria-label="Shown password" value="shown-secret">
      <input id="fresh" type="text" autocomplete="new-password" aria-label="New password" value="fresh-secret">
      <input name="otp" aria-label="Code" value="135790">
      <input id="userPin" aria-label="Your PIN" value="9876">
      <input name="verification_code" aria-label="Verify" value="424242">
      <input type="password" role="button" aria-label="Secret button" value="role-secret">
      <input name="shipping_address" aria-label="Shipping" value="1 Main St">
    `,
    );
  });

  const run = (request: { op: 'describe' | 'type'; ref: string }) =>
    pageRun(request.op === 'type' ? { op: 'type', origins: origins(), generation: 1, ref: request.ref, text: 'guess', submit: false } : { op: 'describe', origins: origins(), generation: 1, ref: request.ref });

  it('redacts revealed passwords, PINs and one-time codes, whatever role the page gives them', () => {
    const text = snapshot();
    for (const secret of ['shown-secret', 'fresh-secret', '135790', '9876', '424242', 'role-secret']) expect(text).not.toContain(secret);
    expect(text).toMatch(/textbox "Shown password" value=\[redacted\]/);
    expect(text).toMatch(/textbox "Code" value=\[redacted\]/);
    expect(text).toMatch(/textbox "Your PIN" value=\[redacted\]/);
    expect(text).toMatch(/button "Secret button" type=password value=\[redacted\]/);
    // A word merely containing "pin" is not a PIN.
    expect(text).toContain('textbox "Shipping" value="1 Main St"');
  });

  it('refuses to type into any of them', () => {
    const text = snapshot();
    for (const name of ['Shown password', 'New password', 'Code', 'Your PIN', 'Verify', 'Secret button']) {
      const ref = refOf(text, name);
      expect(run({ op: 'describe', ref })).toMatchObject({ ok: true, sensitive: true });
      expect(run({ op: 'type', ref })).toEqual({ ok: false, code: 'sensitive_field' });
    }
    expect((document.getElementById('shown') as HTMLInputElement).value).toBe('shown-secret');
  });
});

describe('frames', () => {
  /** jsdom has no real cross-document origins: the frame's document is stood in for with its origin. */
  function frameWith(origin: string, html: string) {
    const inner = document.implementation.createHTMLDocument('');
    inner.body.innerHTML = html;
    const frame = document.createElement('iframe');
    frame.title = 'Embedded';
    Object.defineProperty(frame, 'contentDocument', { get: () => ({ body: inner.body, location: { origin } }) });
    document.body.append(frame);
  }

  it('includes a same-origin frame the grant covers', () => {
    frameWith(location.origin, '<button>Inside frame</button>');
    const text = snapshot();
    expect(text).toContain('frame "Embedded"');
    expect(text).toMatch(/\[e\d+\] button "Inside frame"/);
  });

  it('leaves out a frame from an origin outside the grant', () => {
    frameWith('https://ads.example.test', '<button>Ad button</button>');
    const text = snapshot();
    expect(text).not.toContain('Embedded');
    expect(text).not.toContain('Ad button');
  });
});

describe('focused', () => {
  it('describes the focused element, or the page when nothing has focus', () => {
    (document.getElementById('email') as HTMLInputElement).focus();
    expect(pageRun({ op: 'focused', origins: origins() })).toEqual({ ok: true, op: 'describe', role: 'textbox', name: 'Email', sensitive: false, editable: true });
    (document.getElementById('pw') as HTMLInputElement).focus();
    expect(pageRun({ op: 'focused', origins: origins() })).toMatchObject({ name: 'Password', sensitive: true });
    (document.activeElement as HTMLElement).blur();
    expect(pageRun({ op: 'focused', origins: origins() })).toMatchObject({ ok: true, op: 'describe', name: '' });
    expect(pageRun({ op: 'focused', origins: ['https://other.example.test'] })).toEqual({ ok: false, code: 'origin_not_granted' });
  });
});

describe('findText', () => {
  it('looks for text in the page', () => {
    expect(pageRun({ op: 'findText', origins: origins(), text: 'Plain paragraph' })).toEqual({ ok: true, op: 'findText', found: true });
    expect(pageRun({ op: 'findText', origins: origins(), text: 'Order placed' })).toEqual({ ok: true, op: 'findText', found: false });
  });
});
