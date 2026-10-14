import { CdpAdapter, DISPATCH_GRACE_MS, MAX_REDACTIONS } from '@/browser/adapters/cdp/cdp-adapter';
import { CDP_METHODS, CdpClient, type DebuggerApi } from '@/browser/adapters/cdp/cdp-client';
import type { AXNode, DomNode } from '@/browser/adapters/cdp/cdp-outline';
import type { ImageCodec, Rect } from '@/browser/adapters/cdp/screenshot';
import type { DriverErrorCode } from '@/browser/adapters/page-driver';
import { ORIGIN } from './fixtures';

const ADS = 'https://ads.example.test';
const SECRET = 'hunter2-e2e-secret';

const el = (backendNodeId: number, nodeName: string, attributes: string[] = [], extra: Partial<DomNode> = {}): DomNode => ({ nodeId: backendNodeId, backendNodeId, nodeType: 1, nodeName, attributes, ...extra });
const ax = (nodeId: string, role: string, name: string, backend?: number, extra: Partial<AXNode> = {}): AXNode => ({
  nodeId,
  ignored: false,
  role: { type: 'role', value: role },
  name: { type: 'computedString', value: name },
  ...(backend !== undefined ? { backendDOMNodeId: backend } : {}),
  ...extra,
});

interface PageOptions {
  /** A web component with a password field in a closed shadow root, and a password field in the same-site frame. */
  secrets?: boolean;
  /** The same-site frame runs out of process: Chrome returns no document for it. */
  innerOutOfProcess?: boolean;
  /** Extra password fields in the main document. */
  passwords?: number;
}

/** A small page as Chrome would describe it: the E2E shop with a same-origin frame and a cross-site ad frame. */
function page(options: PageOptions = {}) {
  const frames = { main: `${ORIGIN}/cart`, inner: `${ORIGIN}/frame`, ads: `${ADS}/banner` };
  const innerChildren = [el(21, 'BUTTON'), ...(options.secrets ? [el(22, 'INPUT', ['type', 'password', 'name', 'pin'])] : [])];
  const extraPasswords = Array.from({ length: options.passwords ?? 0 }, (_, i) => el(1000 + i, 'INPUT', ['type', 'password']));
  const dom = (): DomNode => ({
    nodeId: 1,
    backendNodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    children: [
      el(2, 'HTML', [], {
        children: [
          el(3, 'BODY', [], {
            children: [
              el(4, 'H1'),
              el(5, 'INPUT', ['type', 'email', 'name', 'email', 'id', 'email']),
              el(6, 'INPUT', ['type', 'password', 'name', 'password']),
              el(7, 'BUTTON', ['id', 'next']),
              el(10, 'LABEL', ['for', 'email'], { children: [el(11, 'SPAN')] }),
              el(8, 'IFRAME', ['title', 'Coupons'], {
                frameId: 'F2',
                ...(options.innerOutOfProcess ? {} : { contentDocument: { nodeId: 20, backendNodeId: 20, nodeType: 9, nodeName: '#document', children: innerChildren } }),
              }),
              el(9, 'IFRAME', ['title', 'Ad'], { frameId: 'F3' }),
              ...(options.secrets ? [el(12, 'SECRET-BOX', [], { shadowRoots: [{ nodeId: 13, backendNodeId: 13, nodeType: 11, nodeName: '#document-fragment', children: [el(14, 'INPUT', ['type', 'password'])] }] })] : []),
              ...extraPasswords,
            ],
          }),
        ],
      }),
    ],
  });
  const main: AXNode[] = [
    ax('1', 'RootWebArea', 'E2E Shop', 1, { childIds: ['2', '3', '4', '5', '6', '7', '8', ...(options.secrets ? ['14'] : [])] }),
    ax('2', 'heading', 'Cart', 4, { properties: [{ name: 'level', value: { type: 'integer', value: 1 } }], parentId: '1' }),
    ax('3', 'textbox', 'Email', 5, { value: { type: 'string', value: 'a@b.test' }, parentId: '1' }),
    ax('4', 'textbox', 'Password', 6, { value: { type: 'string', value: SECRET }, parentId: '1' }),
    ax('5', 'button', 'Next', 7, { parentId: '1' }),
    ax('6', 'Iframe', 'Coupons', 8, { parentId: '1' }),
    ax('7', 'Iframe', 'Ad', 9, { parentId: '1' }),
    { nodeId: '8', ignored: true, parentId: '1', childIds: ['9'] },
    ax('9', 'StaticText', 'Free shipping', undefined, { parentId: '8' }),
    ...(options.secrets ? [ax('14', 'textbox', 'Secret', 14, { parentId: '1' })] : []),
  ];
  const inner: AXNode[] = [
    ax('100', 'RootWebArea', 'Coupons', 20, { childIds: ['101', ...(options.secrets ? ['102'] : [])] }),
    ax('101', 'button', 'Apply coupon', 21, { parentId: '100' }),
    ...(options.secrets ? [ax('102', 'textbox', 'PIN', 22, { parentId: '100' })] : []),
  ];
  return { frames, dom, main, inner };
}

/** Where focus is: a backend node id, `'document'` (the main page itself) or `'elsewhere'` (an out-of-process frame no tree shows). */
type Focus = number | 'document' | 'elsewhere';

interface SetupOptions extends PageOptions {
  refuse?: () => DriverErrorCode | null;
  hit?: (target: number) => number;
  attachError?: string;
  size?: (scale: number, quality: number) => number;
  focus?: Focus;
  /** Where focus ends up after `DOM.focus` on a node (a page's focus handler can move it). */
  focusMovesTo?: (backend: number) => number;
  /** Fails (throws Chrome's error text) for a method, optionally only for some params. */
  failOn?: (method: string, params: Record<string, unknown>) => string | null;
  /** The visual viewport each `Page.getLayoutMetrics` call reports (the call count starts at 1). */
  viewport?: (call: number) => { pageX: number; pageY: number };
}

function setup(options: SetupOptions = {}) {
  const p = page(options);
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let lastQuads = 0;
  let metricsCalls = 0;
  let focus: Focus = options.focus ?? 'document';
  let afterCapture: (() => void) | null = null;
  const quad = (n: number) => [10, n * 20, 110, n * 20, 110, n * 20 + 10, 10, n * 20 + 10];
  const withFocus = (nodes: AXNode[], frameRoot: number) =>
    nodes.map((node) => {
      const focused = node.backendDOMNodeId !== undefined && (node.backendDOMNodeId === focus || (focus === 'document' && node.backendDOMNodeId === frameRoot && frameRoot === 1));
      return focused ? { ...node, properties: [...(node.properties ?? []), { name: 'focused', value: { type: 'booleanOrUndefined', value: true } }] } : node;
    });
  const reply = (method: string, params: Record<string, unknown> = {}): unknown => {
    const failure = options.failOn?.(method, params);
    if (failure) throw new Error(failure);
    switch (method) {
      case 'Page.getFrameTree':
        return {
          frameTree: {
            frame: { id: 'F1', url: p.frames.main },
            childFrames: [{ frame: { id: 'F2', url: p.frames.inner } }, { frame: { id: 'F3', url: p.frames.ads } }],
          },
        };
      case 'DOM.getDocument':
        return { root: p.dom() };
      case 'Accessibility.getFullAXTree':
        if (params.frameId === 'F2') return { nodes: withFocus(p.inner, 20) };
        if (params.frameId === 'F3') throw new Error('Frame with the given id was not found.');
        return { nodes: withFocus(p.main, 1) };
      case 'Accessibility.getPartialAXTree': {
        const all = [...p.main, ...p.inner];
        const node = all.find((n) => n.backendDOMNodeId === params.backendNodeId);
        if (!node) throw new Error('No node with given id found');
        return { nodes: [node] };
      }
      case 'DOM.describeNode': {
        const find = (node: DomNode): DomNode | undefined => {
          if (node.backendNodeId === params.backendNodeId) return node;
          for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
            const hit = find(child);
            if (hit) return hit;
          }
          return undefined;
        };
        const node = find(p.dom());
        if (!node) throw new Error('No node with given id found');
        return { node: { ...node, children: undefined, contentDocument: undefined } };
      }
      case 'DOM.focus': {
        const backend = params.backendNodeId as number;
        focus = options.focusMovesTo ? options.focusMovesTo(backend) : backend;
        return {};
      }
      case 'DOM.getContentQuads':
        lastQuads = params.backendNodeId as number;
        return { quads: [quad(lastQuads)] };
      case 'DOM.getNodeForLocation':
        return { backendNodeId: options.hit ? options.hit(lastQuads) : lastQuads };
      case 'Page.getLayoutMetrics': {
        metricsCalls += 1;
        const scroll = options.viewport?.(metricsCalls) ?? { pageX: 0, pageY: 0 };
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 }, cssVisualViewport: { clientWidth: 800, clientHeight: 600, ...scroll } };
      }
      case 'Page.captureScreenshot': {
        const run = afterCapture;
        afterCapture = null;
        run?.();
        return { data: 'iVBORw0KGgo=' };
      }
      default:
        return {};
    }
  };
  const debuggerApi: DebuggerApi = {
    attach: vi.fn(async () => {
      if (options.attachError) throw new Error(options.attachError);
    }),
    detach: vi.fn(async () => undefined),
    sendCommand: vi.fn(async (_target, method, params) => {
      sent.push({ method, params });
      return reply(method, params);
    }),
    onDetach: { addListener: () => undefined },
  };
  const encoded: Array<{ scale: number; quality: number; redact: Rect[] }> = [];
  const codec: ImageCodec = {
    decode: async () => ({ width: 1600, height: 1200 }),
    encode: async (_image, step) => {
      encoded.push(step);
      return new Uint8Array(options.size ? options.size(step.scale, step.quality) : 1000);
    },
  };
  let now = 1_000;
  const client = new CdpClient({ debugger: debuggerApi, check: async () => options.refuse?.() ?? null });
  const adapter = new CdpAdapter({ client, codec, now: () => now });
  const methods = () => sent.map((s) => s.method);
  const inputs = () => sent.filter((s) => s.method.startsWith('Input.'));
  return {
    adapter,
    sent,
    methods,
    inputs,
    encoded,
    debuggerApi,
    page: p,
    frames: p.frames,
    setNow: (value: number) => (now = value),
    setFocus: (value: Focus) => (focus = value),
    afterCapture: (run: () => void) => (afterCapture = run),
  };
}

const origins = [ORIGIN];

async function snapshot(t: ReturnType<typeof setup>, generation = 1) {
  const response = await t.adapter.run(1, { op: 'snapshot', origins, generation, maxChars: 20_000 });
  if (!response.ok || response.op !== 'snapshot') throw new Error(`snapshot failed: ${JSON.stringify(response)}`);
  return response;
}

describe('CdpAdapter: snapshot', () => {
  it('writes the accessibility tree in the Standard outline format, redacting sensitive values', async () => {
    const t = setup();
    const result = await snapshot(t);
    expect(result).toMatchObject({ url: `${ORIGIN}/cart`, title: 'E2E Shop' });
    expect(result.text.split('\n')).toEqual([
      'heading "Cart" level=1',
      '[e1] textbox "Email" value="a@b.test"',
      '[e2] textbox "Password" type=password value=[redacted]',
      '[e3] button "Next"',
      'frame "Coupons"',
      '  [e4] button "Apply coupon"',
      'text "Free shipping"',
    ]);
    expect(result.text).not.toContain(SECRET);
    // The cross-site ad frame is neither read nor listed.
    expect(result.text).not.toContain('"Ad"');
    expect(t.sent.filter((s) => s.method === 'Accessibility.getFullAXTree').map((s) => s.params?.frameId)).toEqual([undefined, 'F2']);
  });

  it('does not print the value of a field the DOM read does not know (added between the two reads)', async () => {
    const t = setup();
    const root = t.page.main[0];
    root?.childIds?.push('50');
    t.page.main.push(ax('50', 'textbox', 'Code', 500, { value: { type: 'string', value: '492817' }, parentId: '1' }));
    const result = await snapshot(t);
    expect(result.text).toContain('textbox "Code" value=[redacted]');
    expect(result.text).not.toContain('492817');
  });

  it('refuses a page outside the grant', async () => {
    const t = setup();
    await expect(t.adapter.run(1, { op: 'snapshot', origins: ['https://other.example.test'], generation: 1, maxChars: 20_000 })).resolves.toEqual({ ok: false, code: 'origin_not_granted' });
    expect(t.methods()).not.toContain('Accessibility.getFullAXTree');
  });

  it('keeps refs stable within a generation and starts over on the next', async () => {
    const t = setup();
    await snapshot(t);
    const again = await snapshot(t);
    expect(again.text).toContain('[e3] button "Next"');
    await expect(t.adapter.run(1, { op: 'click', origins, generation: 2, ref: 'e3' })).resolves.toEqual({ ok: false, code: 'stale_ref' });
  });

  it('only sends whitelisted methods', async () => {
    const t = setup();
    await snapshot(t);
    await t.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e3' });
    await t.adapter.run(1, { op: 'type', origins, generation: 1, ref: 'e1', text: 'x', submit: false });
    await t.adapter.run(1, { op: 'press', origins, key: 'Tab' });
    await t.adapter.run(1, { op: 'screenshot', origins });
    for (const method of t.methods()) expect(CDP_METHODS).toContain(method);
  });

  it('stops between steps once the command is cancelled', async () => {
    const t = setup();
    const controller = new AbortController();
    t.debuggerApi.sendCommand = vi.fn(async (_target, method) => {
      t.sent.push({ method });
      if (method === 'Page.getFrameTree') controller.abort();
      return { frameTree: { frame: { id: 'F1', url: t.frames.main } } };
    });
    const response = await t.adapter.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 1000 }, controller.signal);
    expect(response.ok).toBe(false);
    expect(t.methods()).toEqual(['Page.getFrameTree']);
  });

  it('gives up on a command Chrome has not answered once the command is cancelled', async () => {
    const t = setup();
    const controller = new AbortController();
    t.debuggerApi.sendCommand = vi.fn(() => {
      queueMicrotask(() => controller.abort());
      return new Promise<unknown>(() => undefined);
    });
    await expect(t.adapter.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 1000 }, controller.signal)).resolves.toMatchObject({ ok: false });
  });
});

describe('CdpAdapter: click, type and press', () => {
  it('clicks the centre of the element with trusted mouse events', async () => {
    const t = setup();
    await snapshot(t);
    await expect(t.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e3' })).resolves.toEqual({ ok: true, op: 'click' });
    const mouse = t.sent.filter((s) => s.method === 'Input.dispatchMouseEvent');
    expect(mouse.map((s) => s.params?.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(mouse[1]?.params).toMatchObject({ x: 60, y: 145, button: 'left', clickCount: 1 });
  });

  it('refuses an element covered by something else, and allows its own label', async () => {
    const covered = setup({ hit: () => 4 });
    await snapshot(covered);
    await expect(covered.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e3' })).resolves.toEqual({ ok: false, code: 'element_not_interactable' });
    expect(covered.methods()).not.toContain('Input.dispatchMouseEvent');

    const label = setup({ hit: (target) => (target === 5 ? 11 : target) });
    await snapshot(label);
    await expect(label.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e1' })).resolves.toEqual({ ok: true, op: 'click' });
  });

  it('answers element_not_found for an unknown ref', async () => {
    const t = setup();
    await snapshot(t);
    await expect(t.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e99' })).resolves.toEqual({ ok: false, code: 'element_not_found' });
  });

  it('refuses an element in a frame that no longer shows a granted origin', async () => {
    const t = setup();
    await snapshot(t);
    t.frames.inner = `${ADS}/swapped`;
    await expect(t.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e4' })).resolves.toEqual({ ok: false, code: 'origin_not_granted' });
    expect(t.methods()).not.toContain('Input.dispatchMouseEvent');
  });

  it('never types into a password field', async () => {
    const t = setup();
    await snapshot(t);
    await expect(t.adapter.run(1, { op: 'type', origins, generation: 1, ref: 'e2', text: 'guess', submit: false })).resolves.toEqual({ ok: false, code: 'sensitive_field' });
    expect(t.methods()).not.toContain('Input.insertText');
    expect(t.methods()).not.toContain('DOM.focus');
  });

  it('replaces the text of a field and submits with Enter when asked', async () => {
    const t = setup();
    await snapshot(t);
    await expect(t.adapter.run(1, { op: 'type', origins, generation: 1, ref: 'e1', text: 'me@example.test', submit: true })).resolves.toEqual({ ok: true, op: 'type' });
    const input = t.sent.filter((s) => s.method.startsWith('Input.') || s.method === 'DOM.focus');
    expect(input.map((s) => `${s.method}:${String(s.params?.type ?? s.params?.text ?? '')}`)).toEqual([
      'DOM.focus:',
      'Input.dispatchKeyEvent:rawKeyDown',
      'Input.dispatchKeyEvent:keyUp',
      'Input.insertText:me@example.test',
      'Input.dispatchKeyEvent:keyDown',
      'Input.dispatchKeyEvent:keyUp',
    ]);
    expect(input[1]?.params).toMatchObject({ commands: ['selectAll'] });
  });

  it('types nothing when a focus handler moves focus to a password field or another element', async () => {
    const toPassword = setup({ focusMovesTo: () => 6 });
    await snapshot(toPassword);
    await expect(toPassword.adapter.run(1, { op: 'type', origins, generation: 1, ref: 'e1', text: 'me@example.test', submit: false })).resolves.toEqual({ ok: false, code: 'sensitive_field' });
    expect(toPassword.inputs()).toEqual([]);

    const toButton = setup({ focusMovesTo: () => 7 });
    await snapshot(toButton);
    await expect(toButton.adapter.run(1, { op: 'type', origins, generation: 1, ref: 'e1', text: 'me@example.test', submit: false })).resolves.toEqual({ ok: false, code: 'element_not_interactable' });
    expect(toButton.inputs()).toEqual([]);
  });

  it('describes an element from the accessibility tree and the DOM', async () => {
    const t = setup();
    await snapshot(t);
    await expect(t.adapter.run(1, { op: 'describe', origins, generation: 1, ref: 'e2' })).resolves.toEqual({ ok: true, op: 'describe', role: 'textbox', name: 'Password', sensitive: true, editable: true });
  });

  it('presses a key on a granted page only', async () => {
    const t = setup();
    await expect(t.adapter.run(1, { op: 'press', origins, key: 'Tab' })).resolves.toEqual({ ok: true, op: 'press' });
    await expect(t.adapter.run(1, { op: 'press', origins: ['https://other.example.test'], key: 'Tab' })).resolves.toEqual({ ok: false, code: 'origin_not_granted' });
  });

  it('presses keys in the main frame and in a granted same-process frame', async () => {
    const t = setup({ focus: 5 });
    await expect(t.adapter.run(1, { op: 'press', origins, key: 'Backspace' })).resolves.toEqual({ ok: true, op: 'press' });
    t.setFocus(21);
    await expect(t.adapter.run(1, { op: 'press', origins, key: 'Tab' })).resolves.toEqual({ ok: true, op: 'press' });
    expect(t.sent.filter((s) => s.method === 'Accessibility.getFullAXTree').map((s) => s.params?.frameId)).toEqual([undefined, undefined, 'F2']);
  });

  it('sends no key when focus is in a frame it cannot read or that is not granted', async () => {
    // Focus inside a cross-site (out-of-process) frame: no tree this session reads shows it.
    const oopif = setup({ focus: 'elsewhere' });
    await expect(oopif.adapter.run(1, { op: 'press', origins, key: 'Backspace' })).resolves.toEqual({ ok: false, code: 'origin_not_granted' });
    expect(oopif.inputs()).toEqual([]);

    // Focus in a same-process frame that now shows a site outside the grant.
    const swapped = setup({ focus: 21 });
    swapped.frames.inner = `${ADS}/swapped`;
    await expect(swapped.adapter.run(1, { op: 'press', origins, key: 'ArrowDown' })).resolves.toEqual({ ok: false, code: 'origin_not_granted' });
    expect(swapped.inputs()).toEqual([]);

    // Focus reported on the frame element itself.
    const owner = setup({ focus: 9 });
    await expect(owner.adapter.run(1, { op: 'press', origins, key: 'Enter' })).resolves.toEqual({ ok: false, code: 'origin_not_granted' });
    expect(owner.inputs()).toEqual([]);
  });

  it('sends no key to a secret field in a shadow root or in a granted frame', async () => {
    const shadow = setup({ secrets: true, focus: 14 });
    await expect(shadow.adapter.run(1, { op: 'press', origins, key: 'Backspace' })).resolves.toEqual({ ok: false, code: 'sensitive_field' });
    const framed = setup({ secrets: true, focus: 22 });
    await expect(framed.adapter.run(1, { op: 'press', origins, key: 'Tab' })).resolves.toEqual({ ok: false, code: 'sensitive_field' });
    expect([...shadow.inputs(), ...framed.inputs()]).toEqual([]);
  });

  it('counts its own input as not the person’s while it is sent and shortly after', async () => {
    const t = setup();
    await snapshot(t);
    expect(t.adapter.isDispatching(1)).toBe(false);
    await t.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e3' });
    expect(t.adapter.isDispatching(1)).toBe(true);
    t.setNow(1_000 + DISPATCH_GRACE_MS + 1);
    expect(t.adapter.isDispatching(1)).toBe(false);
  });

  it('stops before input when the policy check refuses mid-action (revoked while running)', async () => {
    let refusal: DriverErrorCode | null = null;
    const t = setup({ refuse: () => refusal });
    await snapshot(t);
    let calls = 0;
    const original = t.debuggerApi.sendCommand;
    t.debuggerApi.sendCommand = vi.fn(async (target, method, params) => {
      calls += 1;
      if (method === 'DOM.getContentQuads') refusal = 'grant_revoked';
      return original(target, method, params);
    });
    await expect(t.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e3' })).resolves.toEqual({ ok: false, code: 'grant_revoked' });
    expect(calls).toBeGreaterThan(0);
    expect(t.methods()).not.toContain('Input.dispatchMouseEvent');
    expect(t.debuggerApi.detach).toHaveBeenCalledWith({ tabId: 1 });
  });

  it('marks a refusal between mouse press and release as a possible effect', async () => {
    let refusal: DriverErrorCode | null = null;
    const t = setup({ refuse: () => refusal });
    await snapshot(t);
    const original = t.debuggerApi.sendCommand;
    t.debuggerApi.sendCommand = vi.fn(async (target, method, params) => {
      const result = await original(target, method, params);
      // A mousedown handler navigated away: the next step's policy check refuses.
      if (params?.type === 'mousePressed') refusal = 'origin_not_granted';
      return result;
    });
    await expect(t.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e3' })).resolves.toEqual({ ok: false, code: 'origin_not_granted', effect: 'maybe' });
    expect(t.inputs().map((s) => s.params?.type)).toEqual(['mouseMoved', 'mousePressed']);
  });

  it('marks Chrome failing after the mouse press (debugger gone, renderer stuck) as a possible effect', async () => {
    const t = setup({ failOn: (method, params) => (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased' ? 'Debugger is not attached to the tab' : null) });
    await snapshot(t);
    await expect(t.adapter.run(1, { op: 'click', origins, generation: 1, ref: 'e3' })).resolves.toEqual({ ok: false, code: 'internal', effect: 'maybe' });
  });

  it('marks failures after the first key of type or press as a possible effect', async () => {
    const typed = setup({ failOn: (method, params) => (method === 'Input.dispatchKeyEvent' && params.key === 'Enter' ? 'Internal error' : null) });
    await snapshot(typed);
    await expect(typed.adapter.run(1, { op: 'type', origins, generation: 1, ref: 'e1', text: 'me@example.test', submit: true })).resolves.toEqual({ ok: false, code: 'internal', effect: 'maybe' });

    const pressed = setup({ failOn: (method, params) => (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' ? 'Internal error' : null) });
    await expect(pressed.adapter.run(1, { op: 'press', origins, key: 'Tab' })).resolves.toEqual({ ok: false, code: 'internal', effect: 'maybe' });
  });

  it('marks a type whose focus moved after the text was inserted as a possible effect', async () => {
    const t = setup();
    await snapshot(t);
    const original = t.debuggerApi.sendCommand;
    t.debuggerApi.sendCommand = vi.fn(async (target, method, params) => {
      const result = await original(target, method, params);
      if (method === 'Input.insertText') t.setFocus(7);
      return result;
    });
    await expect(t.adapter.run(1, { op: 'type', origins, generation: 1, ref: 'e1', text: 'hello', submit: true })).resolves.toEqual({ ok: false, code: 'element_not_interactable', effect: 'maybe' });
    expect(t.inputs().some((s) => s.params?.key === 'Enter')).toBe(false);
  });

  it('answers debugger_unavailable when Chrome will not attach', async () => {
    const t = setup({ attachError: 'Another debugger is already attached' });
    await expect(t.adapter.prepare(1)).resolves.toBe('debugger_unavailable');
    await expect(t.adapter.run(1, { op: 'snapshot', origins, generation: 1, maxChars: 1000 })).resolves.toEqual({ ok: false, code: 'debugger_unavailable' });
  });
});

describe('CdpAdapter: screenshot', () => {
  it('captures the visible viewport only and blacks out sensitive fields and ungranted frames', async () => {
    const t = setup();
    const response = await t.adapter.run(1, { op: 'screenshot', origins });
    expect(response).toMatchObject({ ok: true, op: 'screenshot' });
    expect(t.sent.find((s) => s.method === 'Page.captureScreenshot')?.params).toEqual({ format: 'png', fromSurface: true, captureBeyondViewport: false });
    const redact = t.encoded[0]?.redact ?? [];
    // Device pixel ratio 2 (1600 px image, 800 css px): the password field (node 6) and the ad frame (node 9).
    expect(redact).toEqual([
      { x: 16, y: 236, width: 208, height: 28 },
      { x: 16, y: 356, width: 208, height: 28 },
    ]);
  });

  it('measures the boxes before and after the capture', async () => {
    const t = setup();
    await t.adapter.run(1, { op: 'screenshot', origins });
    const order = t.methods().filter((m) => m === 'DOM.getContentQuads' || m === 'Page.captureScreenshot');
    expect(order).toEqual(['DOM.getContentQuads', 'DOM.getContentQuads', 'Page.captureScreenshot', 'DOM.getContentQuads', 'DOM.getContentQuads']);
  });

  it('blacks out a cross-site frame even when its origin is granted, and a same-site frame Chrome did not return', async () => {
    const granted = setup();
    await granted.adapter.run(1, { op: 'screenshot', origins: [ORIGIN, ADS] });
    expect(granted.encoded[0]?.redact).toContainEqual({ x: 16, y: 356, width: 208, height: 28 });

    const outOfProcess = setup({ innerOutOfProcess: true });
    await outOfProcess.adapter.run(1, { op: 'screenshot', origins });
    // Node 8 is the same-site frame.
    expect(outOfProcess.encoded[0]?.redact).toContainEqual({ x: 16, y: 316, width: 208, height: 28 });
  });

  it('tries again when the page scrolled during the capture, then refuses rather than misplace the boxes', async () => {
    const once = setup({ viewport: (call) => ({ pageX: 0, pageY: call === 1 ? 0 : 120 }) });
    await expect(once.adapter.run(1, { op: 'screenshot', origins })).resolves.toMatchObject({ ok: true });
    expect(once.methods().filter((m) => m === 'Page.captureScreenshot')).toHaveLength(2);

    const moving = setup({ viewport: (call) => ({ pageX: 0, pageY: call * 40 }) });
    await expect(moving.adapter.run(1, { op: 'screenshot', origins })).resolves.toEqual({ ok: false, code: 'internal' });
    expect(moving.encoded).toEqual([]);
  });

  it('refuses when a sensitive field cannot be measured, and skips one that has no box', async () => {
    const broken = setup({ failOn: (method, params) => (method === 'DOM.getContentQuads' && params.backendNodeId === 6 ? 'Internal error' : null) });
    await expect(broken.adapter.run(1, { op: 'screenshot', origins })).resolves.toEqual({ ok: false, code: 'internal' });
    expect(broken.encoded).toEqual([]);

    const hidden = setup({ failOn: (method, params) => (method === 'DOM.getContentQuads' && params.backendNodeId === 6 ? 'Could not compute content quads.' : null) });
    await expect(hidden.adapter.run(1, { op: 'screenshot', origins })).resolves.toMatchObject({ ok: true });
    expect(hidden.encoded[0]?.redact).toEqual([{ x: 16, y: 356, width: 208, height: 28 }]);
  });

  it('refuses a page with more areas to black out than it measures', async () => {
    const t = setup({ passwords: MAX_REDACTIONS });
    await expect(t.adapter.run(1, { op: 'screenshot', origins })).resolves.toEqual({ ok: false, code: 'internal' });
    expect(t.methods()).not.toContain('Page.captureScreenshot');
    expect(t.methods()).not.toContain('DOM.getContentQuads');
  });

  it('lowers quality, then size, until it fits the Gateway limit', async () => {
    const t = setup({ size: (scale, quality) => Math.round(4_000_000 * scale * scale * quality) });
    const response = await t.adapter.run(1, { op: 'screenshot', origins });
    expect(response).toMatchObject({ ok: true });
    expect(t.encoded.map((s) => [s.scale, s.quality])).toEqual([
      [1, 0.8],
      [1, 0.6],
      [0.75, 0.6],
    ]);
  });

  it('refuses when the tab navigated to another site while it was captured', async () => {
    const t = setup();
    t.afterCapture(() => (t.frames.main = 'https://elsewhere.example.test/'));
    await expect(t.adapter.run(1, { op: 'screenshot', origins })).resolves.toEqual({ ok: false, code: 'origin_not_granted' });
    expect(t.encoded).toEqual([]);
  });

  it('fails rather than sending an image over the limit', async () => {
    const t = setup({ size: () => 2_000_000 });
    await expect(t.adapter.run(1, { op: 'screenshot', origins })).resolves.toEqual({ ok: false, code: 'internal' });
  });
});
