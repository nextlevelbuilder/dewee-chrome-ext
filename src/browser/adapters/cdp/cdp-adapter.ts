/**
 * Advanced page adapter: the semantic page actions over the Chrome DevTools Protocol, on an
 * agent-owned tab, while one command runs there. The executor has already applied the grant,
 * approvals and redaction rules; this adapter only carries the action out, through `CdpClient`
 * (whitelisted methods, policy check before every command).
 *
 * - snapshot: Chrome's accessibility tree, written in the Standard outline format (cdp-outline.ts).
 * - refs: `eN` handles bound to a DOM backend node id, the frame it lives in, and the tab's
 *   snapshot generation. Navigation moves the generation; a node that no longer exists is
 *   `element_not_found`. Refs are never shared with the Standard adapter.
 * - click/type/press: trusted input (`Input.*`) after a hit test at the element's centre. Keys go
 *   only where focus is known to be: the main frame or a granted same-process frame, never a
 *   sensitive field (shadow roots included). A failure once input was sent is marked
 *   `effect: 'maybe'`, which the executor reports as `outcome_unknown`.
 * - screenshot: the visible viewport only, sensitive fields and every frame that cannot be
 *   redacted field by field blacked out; the boxes are measured before and after the capture and
 *   must agree, otherwise no image is returned.
 * - frames: in-process frames whose origin is in the grant are read and driven; out-of-process
 *   (cross-site) frames are left out and their elements cannot be targeted.
 */
import type { PressKey } from '../../protocol';
import { urlOrigin } from '../../policy';
import type { DriverErrorCode, DriverRequest, DriverResponse, PageDriver } from '../page-driver';
import { CdpFailure, type CdpClient, type CdpMethod } from './cdp-client';
import { formatOutline, indexDom, isEditableNode, isSensitiveNode, nameOf, property, roleOf, type AXNode, type DomInfo, type DomNode } from './cdp-outline';
import { bytesToBase64, fitScreenshot, quadsToRects, type DecodedImage, type ImageCodec } from './screenshot';

/** How long trusted input from the debugger is not taken for the person's own input. */
export const DISPATCH_GRACE_MS = 600;
/** Frames read per snapshot (or per focus lookup) besides the main one. */
const MAX_FRAMES = 10;
/** Most boxes a screenshot blacks out; a page with more is refused rather than sent half redacted. */
export const MAX_REDACTIONS = 64;

interface RefTarget {
  backend: number;
  frame: string;
}

interface TabRefs {
  generation: number;
  next: number;
  byRef: Map<string, RefTarget>;
  byBackend: Map<number, string>;
}

interface FrameTreeNode {
  frame: { id: string; url: string; urlFragment?: string };
  childFrames?: FrameTreeNode[];
}

interface Frames {
  main: string;
  mainUrl: string;
  origins: Map<string, string | null>;
}

/** The command running on a tab: its cancellation, and whether input already went out. */
interface RunState {
  signal?: AbortSignal;
  effect: boolean;
}

interface Viewport {
  pageX: number;
  pageY: number;
  clientWidth: number;
  clientHeight: number;
}

/** What a screenshot blacks out, measured at one moment. `key` compares two measurements. */
interface Layout {
  key: string;
  quads: number[][];
  width: number;
}

const KEYS: Record<PressKey, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
};

/** Elements that may hold another document; `<object>`/`<embed>` can host a cross-site page too. */
const OWNER_TAGS = new Set(['IFRAME', 'FRAME', 'FENCEDFRAME', 'PORTAL', 'OBJECT', 'EMBED']);
const isFrameOwner = (info: DomInfo): boolean => OWNER_TAGS.has(info.tag) || info.childFrame !== undefined;

/** The reason given when no tree shows focus and a frame on the page may hold it unseen. */
export const FOCUS_MAY_BE_IN_FRAME =
  'Keys were not sent: focus may be inside a frame the grant does not cover (cross-site or unreadable). Click a field in the granted page first.';

/**
 * The owner holds a document Chrome returned here (same process, so its nodes are indexed too),
 * from a frame listed in the frame tree with the main page's origin, and that origin is granted.
 */
function ownsReadableFrame(info: DomInfo, frames: Frames, mainOrigin: string | null, origins: string[]): boolean {
  const origin = info.childFrame === undefined ? null : (frames.origins.get(info.childFrame) ?? null);
  return info.contentIndexed === true && origin !== null && origin === mainOrigin && origins.includes(origin);
}

const fail = (code: DriverErrorCode): DriverResponse => ({ ok: false, code });

/** Chrome's message for a node id that no longer resolves. */
const GONE = /No node|Could not find node|does not exist|not found/i;
/** Chrome's message for a node that is not rendered (it has no box to black out). */
const NO_BOX = /Could not compute (content )?quads|Could not compute box model/i;

const isFocused = (node: AXNode) => property(node, 'focused') === true;
const isDocumentNode = (node: AXNode) => {
  const role = roleOf(node);
  return role === 'RootWebArea' || role === 'WebArea';
};

export interface CdpAdapterDeps<I extends DecodedImage = DecodedImage> {
  client: CdpClient;
  codec: ImageCodec<I>;
  now?(): number;
}

export class CdpAdapter<I extends DecodedImage = DecodedImage> implements PageDriver {
  private readonly refs = new Map<number, TabRefs>();
  private readonly dispatching = new Map<number, number>();
  private readonly overlay = new Set<number>();
  /** One command per tab at a time (the executor leases the tab), so the run is kept per tab. */
  private readonly runs = new Map<number, RunState>();
  private readonly now: () => number;

  constructor(private readonly deps: CdpAdapterDeps<I>) {
    this.now = deps.now ?? Date.now;
  }

  get attachedTabs(): number[] {
    return this.deps.client.attachedTabs;
  }

  /** Attaches for the command about to run. Null when ready; otherwise why not (`debugger_unavailable` allows Standard to take over). */
  async prepare(tabId: number): Promise<DriverErrorCode | null> {
    try {
      await this.deps.client.attach(tabId);
      return null;
    } catch (error) {
      return error instanceof CdpFailure ? error.code : 'debugger_unavailable';
    }
  }

  /** The local policy for the tab right now (null when the debugger or Standard may act there). */
  policy(tabId: number): Promise<DriverErrorCode | null> {
    return this.deps.client.policy(tabId);
  }

  async release(tabId: number): Promise<void> {
    this.overlay.delete(tabId);
    await this.deps.client.detach(tabId);
  }

  /** The tab is gone (closed, or no longer owned): its refs go too. */
  forget(tabId: number): void {
    this.refs.delete(tabId);
    this.dispatching.delete(tabId);
    this.overlay.delete(tabId);
  }

  async detachAll(): Promise<void> {
    this.overlay.clear();
    await this.deps.client.detachAll();
  }

  /** Detaches a tab this worker may have attached before it restarted. */
  async forceDetach(tabId: number): Promise<void> {
    await this.deps.client.detach(tabId, true);
  }

  /** True while (and shortly after) the adapter sends trusted input to the tab. */
  isDispatching(tabId: number): boolean {
    return (this.dispatching.get(tabId) ?? 0) > this.now();
  }

  async run(tabId: number, request: DriverRequest, signal?: AbortSignal): Promise<DriverResponse> {
    const state: RunState = { signal, effect: false };
    this.runs.set(tabId, state);
    try {
      await this.deps.client.attach(tabId);
      const response = await this.perform(tabId, request);
      return !response.ok && state.effect ? { ...response, effect: 'maybe' } : response;
    } catch (error) {
      const code = error instanceof CdpFailure ? error.code : 'internal';
      // Once input went out, a failure does not mean nothing happened.
      if (state.effect) return { ok: false, code, effect: 'maybe' };
      const reason = error instanceof CdpFailure ? error.reason : undefined;
      return reason ? { ok: false, code, message: reason } : fail(code);
    } finally {
      if (this.runs.get(tabId) === state) this.runs.delete(tabId);
    }
  }

  private async perform(tabId: number, request: DriverRequest): Promise<DriverResponse> {
    switch (request.op) {
      case 'snapshot':
        return this.snapshot(tabId, request.origins, request.generation, request.maxChars);
      case 'describe': {
        const target = await this.target(tabId, request.origins, request.generation, request.ref);
        const ax = await this.axNode(tabId, target);
        const dom = await this.describeDom(tabId, target);
        return { ok: true, op: 'describe', role: roleOf(ax), name: nameOf(ax), sensitive: isSensitiveNode(dom), editable: isEditableNode(dom) };
      }
      case 'highlight': {
        const target = await this.target(tabId, request.origins, request.generation, request.ref);
        await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backend });
        if (!this.overlay.has(tabId)) {
          await this.send(tabId, 'DOM.enable');
          await this.send(tabId, 'Overlay.enable');
          this.overlay.add(tabId);
        }
        await this.send(tabId, 'Overlay.highlightNode', {
          backendNodeId: target.backend,
          highlightConfig: { showInfo: false, contentColor: { r: 124, g: 58, b: 237, a: 0.15 }, borderColor: { r: 124, g: 58, b: 237, a: 0.9 } },
        });
        return { ok: true, op: 'highlight' };
      }
      case 'click': {
        const target = await this.target(tabId, request.origins, request.generation, request.ref);
        await this.axNode(tabId, target);
        const point = await this.reachable(tabId, target);
        await this.hideHighlight(tabId);
        const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
        await this.dispatch(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
        await this.dispatch(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
        await this.dispatch(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
        return { ok: true, op: 'click' };
      }
      case 'type': {
        const target = await this.target(tabId, request.origins, request.generation, request.ref);
        await this.axNode(tabId, target);
        const dom = await this.describeDom(tabId, target);
        if (isSensitiveNode(dom)) return fail('sensitive_field');
        if (!isEditableNode(dom)) return fail('element_not_interactable');
        await this.reachable(tabId, target);
        await this.send(tabId, 'DOM.focus', { backendNodeId: target.backend });
        // A focus handler may have moved focus (to a password field, say): type only into the element itself.
        await this.expectFocus(tabId, request.origins, target);
        // Replace what is there, like the Standard adapter: select all, then insert (or delete).
        await this.key(tabId, { key: 'a', code: 'KeyA', keyCode: 65 }, ['selectAll']);
        if (request.text) await this.dispatch(tabId, 'Input.insertText', { text: request.text });
        else await this.key(tabId, { key: 'Delete', code: 'Delete', keyCode: 46 });
        if (request.submit) {
          await this.expectFocus(tabId, request.origins, target);
          await this.key(tabId, KEYS.Enter);
        }
        return { ok: true, op: 'type' };
      }
      case 'press': {
        const frames = await this.frames(tabId);
        await this.keyTarget(tabId, request.origins, frames);
        await this.key(tabId, KEYS[request.key]);
        return { ok: true, op: 'press' };
      }
      case 'screenshot':
        return this.screenshot(tabId, request.origins);
      default:
        // Scrolling, waiting for text, the focused element and the input watcher stay with the page script.
        return fail('internal');
    }
  }

  // ---------- Sending ----------

  /** A read or a non-input step, cancelled with the command. */
  private send<T = Record<string, unknown>>(tabId: number, method: CdpMethod, params: Record<string, unknown> = {}): Promise<T> {
    return this.deps.client.send<T>(tabId, method, params, { signal: this.runs.get(tabId)?.signal });
  }

  /**
   * An input step: once it passed the policy check and goes to Chrome, the page may change. Only
   * while it is sent (and shortly after) is input on the tab taken for the adapter's own, so the
   * person's clicks and keys during the reads in between still take the tab back.
   */
  private async dispatch(tabId: number, method: CdpMethod, params: Record<string, unknown>): Promise<unknown> {
    const state = this.runs.get(tabId);
    let sent = false;
    try {
      return await this.deps.client.send(tabId, method, params, {
        signal: state?.signal,
        onDispatch: () => {
          sent = true;
          this.dispatching.set(tabId, Number.POSITIVE_INFINITY);
          if (state) state.effect = true;
        },
      });
    } finally {
      // A step refused or cancelled before it reached Chrome leaves the person's input alone.
      if (sent) this.dispatching.set(tabId, this.now() + DISPATCH_GRACE_MS);
    }
  }

  // ---------- Refs ----------

  private refsFor(tabId: number, generation: number): TabRefs {
    const existing = this.refs.get(tabId);
    if (existing && existing.generation === generation) return existing;
    const fresh: TabRefs = { generation, next: 1, byRef: new Map(), byBackend: new Map() };
    this.refs.set(tabId, fresh);
    return fresh;
  }

  /** Resolves a ref of this generation and checks the page and the element's frame are in the grant. */
  private async target(tabId: number, origins: string[], generation: number, ref: string): Promise<RefTarget> {
    const state = this.refs.get(tabId);
    if (!state || state.generation !== generation) throw new CdpFailure('stale_ref', false);
    const target = state.byRef.get(ref);
    if (!target) throw new CdpFailure('element_not_found', false);
    const frames = await this.frames(tabId);
    if (!origins.includes(frames.origins.get(frames.main) ?? '')) throw new CdpFailure('origin_not_granted', false);
    // The frame the element lives in must still exist and still show a granted origin.
    if (!origins.includes(frames.origins.get(target.frame) ?? '')) throw new CdpFailure('origin_not_granted', false);
    return target;
  }

  private async frames(tabId: number): Promise<Frames> {
    const { frameTree } = await this.send<{ frameTree: FrameTreeNode }>(tabId, 'Page.getFrameTree');
    const origins = new Map<string, string | null>();
    const visit = (node: FrameTreeNode) => {
      origins.set(node.frame.id, urlOrigin(node.frame.url));
      for (const child of node.childFrames ?? []) visit(child);
    };
    visit(frameTree);
    return { main: frameTree.frame.id, mainUrl: frameTree.frame.url + (frameTree.frame.urlFragment ?? ''), origins };
  }

  private async document(tabId: number, mainFrame: string): Promise<Map<number, DomInfo>> {
    const { root } = await this.send<{ root: DomNode }>(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    return indexDom(root, mainFrame);
  }

  /** The element's accessibility node: it must still exist, be rendered and not disabled. */
  private async axNode(tabId: number, target: RefTarget): Promise<AXNode> {
    let nodes: AXNode[];
    try {
      ({ nodes } = await this.send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getPartialAXTree', { backendNodeId: target.backend, fetchRelatives: false }));
    } catch (error) {
      throw this.nodeError(error);
    }
    const node = nodes.find((n) => n.backendDOMNodeId === target.backend) ?? nodes[0];
    if (!node) throw new CdpFailure('element_not_found', false);
    if (node.ignored || property(node, 'disabled') === true || property(node, 'hidden') === true) throw new CdpFailure('element_not_interactable', false);
    return node;
  }

  private async describeDom(tabId: number, target: RefTarget): Promise<DomInfo> {
    try {
      const { node } = await this.send<{ node: DomNode }>(tabId, 'DOM.describeNode', { backendNodeId: target.backend });
      return indexDom(node, target.frame).get(node.backendNodeId) ?? { tag: node.nodeName.toUpperCase(), attrs: new Map(), frame: target.frame };
    } catch (error) {
      throw this.nodeError(error);
    }
  }

  private nodeError(error: unknown): CdpFailure {
    if (error instanceof CdpFailure && error.code !== 'internal') return error;
    const detail = error instanceof CdpFailure ? error.detail : '';
    return new CdpFailure(GONE.test(detail) ? 'element_not_found' : 'element_not_interactable', false);
  }

  /**
   * Scrolls the element into view and checks that its centre is inside the viewport and that a
   * pointer there lands on the element itself (or a label for it), as the Standard adapter does.
   */
  private async reachable(tabId: number, target: RefTarget): Promise<{ x: number; y: number }> {
    let quads: number[][];
    try {
      await this.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backend });
      ({ quads } = await this.send<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', { backendNodeId: target.backend }));
    } catch (error) {
      throw this.nodeError(error);
    }
    const quad = quads.find((q) => q.length >= 8 && Math.abs((q[4] as number) - (q[0] as number)) * Math.abs((q[5] as number) - (q[1] as number)) >= 1);
    if (!quad) throw new CdpFailure('element_not_interactable', false);
    const x = ((quad[0] as number) + (quad[2] as number) + (quad[4] as number) + (quad[6] as number)) / 4;
    const y = ((quad[1] as number) + (quad[3] as number) + (quad[5] as number) + (quad[7] as number)) / 4;
    const { cssLayoutViewport } = await this.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(tabId, 'Page.getLayoutMetrics');
    if (x < 0 || y < 0 || x > cssLayoutViewport.clientWidth || y > cssLayoutViewport.clientHeight) throw new CdpFailure('element_not_interactable', false);
    let hit: number | undefined;
    try {
      ({ backendNodeId: hit } = await this.send<{ backendNodeId: number }>(tabId, 'DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }));
    } catch (error) {
      if (error instanceof CdpFailure && error.code !== 'internal') throw error;
      hit = undefined;
    }
    if (hit === undefined) throw new CdpFailure('element_not_interactable', false);
    if (hit !== target.backend) {
      const frames = await this.frames(tabId);
      const dom = await this.document(tabId, frames.main);
      if (!this.covers(dom, hit, target.backend)) throw new CdpFailure('element_not_interactable', false);
    }
    return { x, y };
  }

  /** The node at the point is the element, inside it, or a label naming or wrapping it. */
  private covers(dom: Map<number, DomInfo>, hit: number, target: number): boolean {
    const ancestors = (id: number): number[] => {
      const list: number[] = [];
      for (let node: number | undefined = id, depth = 0; node !== undefined && depth < 512; node = dom.get(node)?.parent, depth += 1) list.push(node);
      return list;
    };
    const hitChain = ancestors(hit);
    if (hitChain.includes(target)) return true;
    const targetId = dom.get(target)?.attrs.get('id');
    const targetChain = ancestors(target);
    return hitChain.some((node) => {
      const info = dom.get(node);
      if (info?.tag !== 'LABEL') return false;
      return (targetId !== undefined && info.attrs.get('for') === targetId) || targetChain.includes(node);
    });
  }

  // ---------- Focus ----------

  /**
   * Where keyboard input would go now, from the `focused` state of the accessibility trees (they
   * see into shadow roots, open or closed): the focused node and its frame, a frame whose document
   * itself has focus, or the main document when no tree shows focus and no frame on the page could
   * hold it unseen. Null when a listed frame could not be read.
   */
  private async focus(tabId: number, origins: string[], frames: Frames): Promise<{ frame: string; node?: AXNode } | null> {
    const others = [...frames.origins.keys()].filter((id) => id !== frames.main);
    let documentFocus: string | null = null;
    let unread = others.length > MAX_FRAMES;
    for (const frame of [frames.main, ...others.slice(0, MAX_FRAMES)]) {
      let nodes: AXNode[];
      try {
        ({ nodes } = await this.send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree', frame === frames.main ? {} : { frameId: frame }));
      } catch (error) {
        // A frame this session cannot read is skipped; if focus is there, nothing below finds it.
        if (frame === frames.main || !(error instanceof CdpFailure) || error.code !== 'internal') throw error;
        unread = true;
        continue;
      }
      const focused = nodes.filter(isFocused);
      const node = focused.find((n) => !isDocumentNode(n));
      if (node) return { frame, node };
      if (documentFocus === null && focused.length > 0) documentFocus = frame;
      // The main document itself has focus: no frame holds it.
      if (documentFocus === frames.main) return { frame: frames.main };
    }
    if (documentFocus !== null) return { frame: documentFocus };
    if (unread) return null;
    // No tree shows focus. In a tab that is not active (agent tabs open in the background) Chrome
    // does not mark the page itself focused, though a focused element is still marked. It also
    // shows nothing when focus is inside an out-of-process frame: such frames are missing from the frame tree and their trees cannot be read from here. The
    // DOM (closed shadow roots included) lists every frame owner, so the key goes to the main
    // document only when each one holds a same-process, same-origin, granted document.
    if (!this.framesAllReadable(await this.document(tabId, frames.main), frames, origins)) {
      throw new CdpFailure('origin_not_granted', false, '', FOCUS_MAY_BE_IN_FRAME);
    }
    return { frame: frames.main };
  }

  /** Every frame owner on the page holds a document this session reads, same-origin with the granted main page. */
  private framesAllReadable(dom: Map<number, DomInfo>, frames: Frames, origins: string[]): boolean {
    const mainOrigin = frames.origins.get(frames.main) ?? null;
    for (const info of dom.values()) {
      if (isFrameOwner(info) && !ownsReadableFrame(info, frames, mainOrigin, origins)) return false;
    }
    return true;
  }

  /**
   * Checks that keys may go where focus is: a granted page, focus in the main frame or a granted
   * same-process frame, not a sensitive field. Returns the focused node (undefined for a document
   * with no focused element); throws the refusal otherwise.
   */
  private async keyTarget(tabId: number, origins: string[], frames: Frames): Promise<number | undefined> {
    if (!origins.includes(frames.origins.get(frames.main) ?? '')) throw new CdpFailure('origin_not_granted', false);
    const focus = await this.focus(tabId, origins, frames);
    if (!focus) throw new CdpFailure('origin_not_granted', false, '', FOCUS_MAY_BE_IN_FRAME);
    if (!origins.includes(frames.origins.get(focus.frame) ?? '')) throw new CdpFailure('origin_not_granted', false);
    if (!focus.node) return undefined;
    const backend = focus.node.backendDOMNodeId;
    const info = backend === undefined ? undefined : (await this.document(tabId, frames.main)).get(backend);
    // A focused node the DOM read cannot place is treated like a secret field.
    if (info === undefined || isSensitiveNode(info)) throw new CdpFailure('sensitive_field', false);
    // Focus on a frame element means keys go into a document no tree here showed.
    if (isFrameOwner(info)) throw new CdpFailure('origin_not_granted', false, '', FOCUS_MAY_BE_IN_FRAME);
    return backend;
  }

  /** Focus is on the element being typed into (and it is still allowed to receive keys). */
  private async expectFocus(tabId: number, origins: string[], target: RefTarget): Promise<void> {
    const focused = await this.keyTarget(tabId, origins, await this.frames(tabId));
    if (focused !== target.backend) throw new CdpFailure('element_not_interactable', false);
  }

  // ---------- Input ----------

  private async key(tabId: number, key: { key: string; code: string; keyCode: number; text?: string }, commands?: string[]): Promise<void> {
    const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
    await this.dispatch(tabId, 'Input.dispatchKeyEvent', { ...base, type: key.text ? 'keyDown' : 'rawKeyDown', ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}), ...(commands ? { commands } : {}) });
    await this.dispatch(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  private async hideHighlight(tabId: number): Promise<void> {
    if (this.overlay.has(tabId)) await this.send(tabId, 'Overlay.hideHighlight').catch(() => undefined);
  }

  // ---------- Snapshot ----------

  private async snapshot(tabId: number, origins: string[], generation: number, maxChars: number): Promise<DriverResponse> {
    const frames = await this.frames(tabId);
    if (!origins.includes(frames.origins.get(frames.main) ?? '')) return fail('origin_not_granted');
    const dom = await this.document(tabId, frames.main);
    const trees = new Map<string, AXNode[]>();
    trees.set(frames.main, (await this.send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree')).nodes);
    const granted = new Set([...frames.origins].filter(([, origin]) => origin !== null && origins.includes(origin)).map(([id]) => id));
    for (const frame of granted) {
      if (frame === frames.main || trees.size > MAX_FRAMES) continue;
      try {
        trees.set(frame, (await this.send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree', { frameId: frame })).nodes);
      } catch (error) {
        // An out-of-process frame cannot be read through this tab's session: it is left out.
        if (error instanceof CdpFailure && error.code !== 'internal') throw error;
      }
    }
    const state = this.refsFor(tabId, generation);
    const outline = formatOutline({
      trees,
      mainFrame: frames.main,
      dom,
      grantedFrames: granted,
      maxChars,
      refFor: (backend, frame) => {
        const known = state.byBackend.get(backend);
        if (known) return known;
        const ref = `e${state.next++}`;
        state.byBackend.set(backend, ref);
        state.byRef.set(ref, { backend, frame });
        return ref;
      },
    });
    // The page must not have moved to another site while it was read.
    const after = await this.frames(tabId);
    if (!origins.includes(after.origins.get(after.main) ?? '')) return fail('origin_not_granted');
    return { ok: true, op: 'snapshot', text: outline.text, url: frames.mainUrl, title: outline.title };
  }

  // ---------- Screenshot ----------

  /**
   * Measures what to black out, captures, measures again. The two measurements must match (same
   * scroll position, viewport, fields and boxes, every box found); otherwise it tries once more and
   * then refuses, so an image is never returned with boxes taken from a different layout.
   */
  private async screenshot(tabId: number, origins: string[]): Promise<DriverResponse> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const frames = await this.frames(tabId);
      if (!origins.includes(frames.origins.get(frames.main) ?? '')) return fail('origin_not_granted');
      const before = await this.layout(tabId, frames, origins);
      const { data } = await this.send<{ data: string }>(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      // A navigation while capturing could have put another site in the picture.
      const after = await this.frames(tabId);
      if (after.main !== frames.main || !origins.includes(after.origins.get(after.main) ?? '')) return fail('origin_not_granted');
      const again = await this.layout(tabId, after, origins);
      if (before && again && before.key === again.key) return this.encode(data, again);
    }
    return fail('internal');
  }

  private async encode(data: string, layout: Layout): Promise<DriverResponse> {
    const image = await this.deps.codec.decode(data);
    try {
      const ratio = layout.width > 0 ? image.width / layout.width : 1;
      const bytes = await fitScreenshot(this.deps.codec, image, quadsToRects(layout.quads, ratio, image));
      if (!bytes) return fail('internal');
      return { ok: true, op: 'screenshot', data: bytesToBase64(bytes) };
    } finally {
      image.close?.();
    }
  }

  /** The boxes to black out right now, or null when one of them could not be measured. */
  private async layout(tabId: number, frames: Frames, origins: string[]): Promise<Layout | null> {
    const targets = this.redactionTargets(await this.document(tabId, frames.main), frames, origins);
    if (targets.length > MAX_REDACTIONS) throw new CdpFailure('internal', false, 'too many areas to black out');
    const { cssVisualViewport: view } = await this.send<{ cssVisualViewport: Viewport }>(tabId, 'Page.getLayoutMetrics');
    const quads: number[][] = [];
    for (const backendNodeId of targets) {
      try {
        quads.push(...(await this.send<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', { backendNodeId })).quads);
      } catch (error) {
        // A refusal, a timeout or a cancellation ends the screenshot.
        if (!(error instanceof CdpFailure) || error.code !== 'internal') throw error;
        // Not rendered: nothing to hide. Any other failure (the node went away, ...) means this measurement cannot be trusted.
        if (!NO_BOX.test(error.detail)) return null;
      }
    }
    return { key: JSON.stringify([view.pageX, view.pageY, view.clientWidth, view.clientHeight, targets, quads]), quads, width: view.clientWidth };
  }

  /**
   * Every sensitive field, and every frame that cannot be redacted field by field: a frame is left
   * visible only when it shows the main frame's origin, that origin is granted, and Chrome returned
   * its document here (so its fields are in this list too). Cross-origin and out-of-process frames,
   * granted or not, are blacked out whole.
   */
  private redactionTargets(dom: Map<number, DomInfo>, frames: Frames, origins: string[]): number[] {
    const mainOrigin = frames.origins.get(frames.main) ?? null;
    const targets: number[] = [];
    for (const [backend, info] of dom) {
      const field = info.tag === 'INPUT' || info.tag === 'TEXTAREA' || info.tag === 'SELECT' || info.attrs.has('contenteditable');
      if (field && isSensitiveNode(info)) {
        targets.push(backend);
      } else if (isFrameOwner(info) && !ownsReadableFrame(info, frames, mainOrigin, origins)) {
        targets.push(backend);
      }
    }
    return targets;
  }
}
