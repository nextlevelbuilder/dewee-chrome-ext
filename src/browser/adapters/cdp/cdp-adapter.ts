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
 * - click/type/press: trusted input (`Input.*`) after a hit test at the element's centre.
 * - screenshot: the visible viewport only, sensitive fields and ungranted frames blacked out.
 * - frames: in-process frames whose origin is in the grant are read and driven; out-of-process
 *   (cross-site) frames are left out and their elements cannot be targeted.
 */
import type { PressKey } from '../../protocol';
import { urlOrigin } from '../../policy';
import type { DriverErrorCode, DriverRequest, DriverResponse, PageDriver } from '../page-driver';
import { CdpFailure, type CdpClient } from './cdp-client';
import { formatOutline, indexDom, isEditableNode, isSensitiveNode, nameOf, property, roleOf, type AXNode, type DomInfo, type DomNode } from './cdp-outline';
import { bytesToBase64, fitScreenshot, quadsToRects, type DecodedImage, type ImageCodec, type Rect } from './screenshot';

/** How long trusted input from the debugger is not taken for the person's own input. */
export const DISPATCH_GRACE_MS = 600;
/** Frames read per snapshot besides the main one. */
const MAX_FRAMES = 10;

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

const fail = (code: DriverErrorCode): DriverResponse => ({ ok: false, code });

/** Chrome's message for a node id that no longer resolves. */
const GONE = /No node|Could not find node|does not exist|not found/i;

export interface CdpAdapterDeps<I extends DecodedImage = DecodedImage> {
  client: CdpClient;
  codec: ImageCodec<I>;
  now?(): number;
}

export class CdpAdapter<I extends DecodedImage = DecodedImage> implements PageDriver {
  private readonly refs = new Map<number, TabRefs>();
  private readonly dispatching = new Map<number, number>();
  private readonly overlay = new Set<number>();
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

  async run(tabId: number, request: DriverRequest): Promise<DriverResponse> {
    try {
      await this.deps.client.attach(tabId);
      switch (request.op) {
        case 'snapshot':
          return await this.snapshot(tabId, request.origins, request.generation, request.maxChars);
        case 'describe': {
          const target = await this.target(tabId, request.origins, request.generation, request.ref);
          const ax = await this.axNode(tabId, target);
          const dom = await this.describeDom(tabId, target);
          return { ok: true, op: 'describe', role: roleOf(ax), name: nameOf(ax), sensitive: isSensitiveNode(dom), editable: isEditableNode(dom) };
        }
        case 'highlight': {
          const target = await this.target(tabId, request.origins, request.generation, request.ref);
          await this.deps.client.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backend });
          if (!this.overlay.has(tabId)) {
            await this.deps.client.send(tabId, 'DOM.enable');
            await this.deps.client.send(tabId, 'Overlay.enable');
            this.overlay.add(tabId);
          }
          await this.deps.client.send(tabId, 'Overlay.highlightNode', {
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
          await this.input(tabId, async () => {
            const base = { x: point.x, y: point.y, button: 'left', clickCount: 1 };
            await this.deps.client.send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
            await this.deps.client.send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
            await this.deps.client.send(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
          });
          return { ok: true, op: 'click' };
        }
        case 'type': {
          const target = await this.target(tabId, request.origins, request.generation, request.ref);
          await this.axNode(tabId, target);
          const dom = await this.describeDom(tabId, target);
          if (isSensitiveNode(dom)) return fail('sensitive_field');
          if (!isEditableNode(dom)) return fail('element_not_interactable');
          await this.reachable(tabId, target);
          await this.input(tabId, async () => {
            await this.deps.client.send(tabId, 'DOM.focus', { backendNodeId: target.backend });
            // Replace what is there, like the Standard adapter: select all, then insert (or delete).
            await this.key(tabId, { key: 'a', code: 'KeyA', keyCode: 65 }, ['selectAll']);
            if (request.text) await this.deps.client.send(tabId, 'Input.insertText', { text: request.text });
            else await this.key(tabId, { key: 'Delete', code: 'Delete', keyCode: 46 });
            if (request.submit) await this.key(tabId, KEYS.Enter);
          });
          return { ok: true, op: 'type' };
        }
        case 'press': {
          const frames = await this.frames(tabId);
          if (!request.origins.includes(frames.origins.get(frames.main) ?? '')) return fail('origin_not_granted');
          await this.input(tabId, () => this.key(tabId, KEYS[request.key]));
          return { ok: true, op: 'press' };
        }
        case 'screenshot':
          return await this.screenshot(tabId, request.origins);
        default:
          // Scrolling, waiting for text, the focused element and the input watcher stay with the page script.
          return fail('internal');
      }
    } catch (error) {
      if (error instanceof CdpFailure) return fail(error.code);
      return fail('internal');
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
    const { frameTree } = await this.deps.client.send<{ frameTree: FrameTreeNode }>(tabId, 'Page.getFrameTree');
    const origins = new Map<string, string | null>();
    const visit = (node: FrameTreeNode) => {
      origins.set(node.frame.id, urlOrigin(node.frame.url));
      for (const child of node.childFrames ?? []) visit(child);
    };
    visit(frameTree);
    return { main: frameTree.frame.id, mainUrl: frameTree.frame.url + (frameTree.frame.urlFragment ?? ''), origins };
  }

  private async document(tabId: number, mainFrame: string): Promise<Map<number, DomInfo>> {
    const { root } = await this.deps.client.send<{ root: DomNode }>(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
    return indexDom(root, mainFrame);
  }

  /** The element's accessibility node: it must still exist, be rendered and not disabled. */
  private async axNode(tabId: number, target: RefTarget): Promise<AXNode> {
    let nodes: AXNode[];
    try {
      ({ nodes } = await this.deps.client.send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getPartialAXTree', { backendNodeId: target.backend, fetchRelatives: false }));
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
      const { node } = await this.deps.client.send<{ node: DomNode }>(tabId, 'DOM.describeNode', { backendNodeId: target.backend });
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
      await this.deps.client.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backend });
      ({ quads } = await this.deps.client.send<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', { backendNodeId: target.backend }));
    } catch (error) {
      throw this.nodeError(error);
    }
    const quad = quads.find((q) => q.length >= 8 && Math.abs((q[4] as number) - (q[0] as number)) * Math.abs((q[5] as number) - (q[1] as number)) >= 1);
    if (!quad) throw new CdpFailure('element_not_interactable', false);
    const x = ((quad[0] as number) + (quad[2] as number) + (quad[4] as number) + (quad[6] as number)) / 4;
    const y = ((quad[1] as number) + (quad[3] as number) + (quad[5] as number) + (quad[7] as number)) / 4;
    const { cssLayoutViewport } = await this.deps.client.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(tabId, 'Page.getLayoutMetrics');
    if (x < 0 || y < 0 || x > cssLayoutViewport.clientWidth || y > cssLayoutViewport.clientHeight) throw new CdpFailure('element_not_interactable', false);
    let hit: number | undefined;
    try {
      ({ backendNodeId: hit } = await this.deps.client.send<{ backendNodeId: number }>(tabId, 'DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }));
    } catch {
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

  // ---------- Input ----------

  private async input(tabId: number, send: () => Promise<void>): Promise<void> {
    this.dispatching.set(tabId, Number.POSITIVE_INFINITY);
    try {
      await send();
    } finally {
      this.dispatching.set(tabId, this.now() + DISPATCH_GRACE_MS);
    }
  }

  private async key(tabId: number, key: { key: string; code: string; keyCode: number; text?: string }, commands?: string[]): Promise<void> {
    const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
    await this.deps.client.send(tabId, 'Input.dispatchKeyEvent', { ...base, type: key.text ? 'keyDown' : 'rawKeyDown', ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}), ...(commands ? { commands } : {}) });
    await this.deps.client.send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  private async hideHighlight(tabId: number): Promise<void> {
    if (this.overlay.has(tabId)) await this.deps.client.send(tabId, 'Overlay.hideHighlight').catch(() => undefined);
  }

  // ---------- Snapshot ----------

  private async snapshot(tabId: number, origins: string[], generation: number, maxChars: number): Promise<DriverResponse> {
    const frames = await this.frames(tabId);
    if (!origins.includes(frames.origins.get(frames.main) ?? '')) return fail('origin_not_granted');
    const dom = await this.document(tabId, frames.main);
    const trees = new Map<string, AXNode[]>();
    trees.set(frames.main, (await this.deps.client.send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree')).nodes);
    const granted = new Set([...frames.origins].filter(([, origin]) => origin !== null && origins.includes(origin)).map(([id]) => id));
    for (const frame of granted) {
      if (frame === frames.main || trees.size > MAX_FRAMES) continue;
      try {
        trees.set(frame, (await this.deps.client.send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree', { frameId: frame })).nodes);
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

  private async screenshot(tabId: number, origins: string[]): Promise<DriverResponse> {
    const frames = await this.frames(tabId);
    if (!origins.includes(frames.origins.get(frames.main) ?? '')) return fail('origin_not_granted');
    const dom = await this.document(tabId, frames.main);
    const { cssVisualViewport } = await this.deps.client.send<{ cssVisualViewport: { clientWidth: number; clientHeight: number } }>(tabId, 'Page.getLayoutMetrics');
    const { data } = await this.deps.client.send<{ data: string }>(tabId, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    // A navigation while capturing could have put another site in the picture.
    const after = await this.frames(tabId);
    if (after.main !== frames.main || !origins.includes(after.origins.get(after.main) ?? '')) return fail('origin_not_granted');

    const image = await this.deps.codec.decode(data);
    try {
      const ratio = cssVisualViewport.clientWidth > 0 ? image.width / cssVisualViewport.clientWidth : 1;
      const redact = await this.redactions(tabId, dom, after, origins, ratio, image);
      const bytes = await fitScreenshot(this.deps.codec, image, redact);
      if (!bytes) return fail('internal');
      return { ok: true, op: 'screenshot', data: bytesToBase64(bytes) };
    } finally {
      image.close?.();
    }
  }

  /** Boxes to black out: every sensitive field, and every frame whose origin is not in the grant. */
  private async redactions(tabId: number, dom: Map<number, DomInfo>, frames: Frames, origins: string[], ratio: number, size: { width: number; height: number }): Promise<Rect[]> {
    const nodes: number[] = [];
    for (const [backend, info] of dom) {
      const field = info.tag === 'INPUT' || info.tag === 'TEXTAREA' || info.tag === 'SELECT' || info.attrs.has('contenteditable');
      if (field && isSensitiveNode(info)) nodes.push(backend);
      else if (info.childFrame !== undefined && !origins.includes(frames.origins.get(info.childFrame) ?? '')) nodes.push(backend);
      else if ((info.tag === 'IFRAME' || info.tag === 'FRAME') && info.childFrame === undefined) nodes.push(backend);
    }
    const rects: Rect[] = [];
    for (const backendNodeId of nodes) {
      try {
        const { quads } = await this.deps.client.send<{ quads: number[][] }>(tabId, 'DOM.getContentQuads', { backendNodeId });
        rects.push(...quadsToRects(quads, ratio, size));
      } catch (error) {
        // Not rendered (no box): nothing to hide. Any refusal from the guard still stops the screenshot.
        if (error instanceof CdpFailure && error.code !== 'internal') throw error;
      }
    }
    return rects;
  }
}
