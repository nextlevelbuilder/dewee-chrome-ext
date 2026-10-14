/**
 * Turns Chrome's accessibility tree (`Accessibility.getFullAXTree`) plus the DOM attributes
 * (`DOM.getDocument`) into the same compact outline the Standard adapter writes:
 * `[e12] button "Sign in"`, `heading "Account" level=1`, `text "..."`.
 *
 * The rules match the page script: values of sensitive fields (password, PIN, payment card,
 * one-time code; see sensitive.ts) are written as `value=[redacted]` whatever role the page gives
 * them, and so is the value of any node whose DOM attributes could not be read; ignored nodes
 * (hidden, `aria-hidden`) are skipped; a frame is walked only when its origin
 * is in the grant and Chrome could read its tree here (in-process frames). Out-of-process frames
 * are left out, like cross-origin frames in Standard.
 */
import { isEditableField, isSensitiveField, type FieldAttributes } from '../../sensitive';

export interface AXValue {
  type: string;
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** A `DOM.Node` from `DOM.getDocument({ depth: -1, pierce: true })`, reduced to what is read. */
export interface DomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
  shadowRoots?: DomNode[];
  /** Set on frame owner elements (`<iframe>`). */
  frameId?: string;
}

export interface DomInfo {
  tag: string;
  attrs: Map<string, string>;
  parent?: number;
  /** Frame whose document holds the node. */
  frame: string;
  /** For `<iframe>`/`<frame>` owners: the frame they hold. */
  childFrame?: string;
  /** For frame owners: Chrome returned the frame's document here (an in-process frame), so its fields are indexed. */
  contentIndexed?: boolean;
}

const TEXT_LINE_MAX = 300;
const VALUE_MAX = 200;

/** Roles that get a ref, the same list as the page script, plus Chrome's own names for some of them. */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
]);
const ROLE_ALIASES: Record<string, string> = { PopUpButton: 'combobox', MenuListOption: 'option', ToggleButton: 'button', image: 'img' };
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const CHECK_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

const collapse = (text: unknown) => (typeof text === 'string' ? text : text === undefined || text === null ? '' : String(text)).replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function roleOf(node: Pick<AXNode, 'role'>): string {
  const raw = collapse(node.role?.value);
  return ROLE_ALIASES[raw] ?? raw;
}

export function nameOf(node: Pick<AXNode, 'name'>): string {
  return clip(collapse(node.name?.value), TEXT_LINE_MAX);
}

export function property(node: Pick<AXNode, 'properties'>, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value.value;
}

/** Indexes every DOM node by backend id with its tag, attributes, parent and frame. */
export function indexDom(root: DomNode, mainFrame: string): Map<number, DomInfo> {
  const index = new Map<number, DomInfo>();
  const visit = (node: DomNode, parent: number | undefined, frame: string) => {
    const attrs = new Map<string, string>();
    const list = node.attributes ?? [];
    for (let i = 0; i + 1 < list.length; i += 2) attrs.set((list[i] as string).toLowerCase(), list[i + 1] as string);
    const owner = node.nodeType === 1 && (node.frameId !== undefined || node.contentDocument !== undefined);
    index.set(node.backendNodeId, {
      tag: node.nodeName.toUpperCase(),
      attrs,
      parent,
      frame,
      childFrame: node.frameId && node.nodeType === 1 ? node.frameId : undefined,
      ...(owner ? { contentIndexed: node.contentDocument !== undefined } : {}),
    });
    for (const child of node.children ?? []) visit(child, node.backendNodeId, frame);
    for (const shadow of node.shadowRoots ?? []) visit(shadow, node.backendNodeId, frame);
    if (node.contentDocument) visit(node.contentDocument, node.backendNodeId, node.frameId ?? frame);
  };
  visit(root, undefined, mainFrame);
  return index;
}

export function fieldOf(info: DomInfo | undefined): FieldAttributes & { readonly: boolean; contenteditable: string | null } {
  const attrs = info?.attrs ?? new Map<string, string>();
  return {
    tag: info?.tag ?? '',
    type: attrs.get('type') ?? '',
    autocomplete: attrs.get('autocomplete') ?? '',
    name: attrs.get('name') ?? '',
    id: attrs.get('id') ?? '',
    readonly: attrs.has('readonly'),
    contenteditable: attrs.has('contenteditable') ? (attrs.get('contenteditable') ?? '') : null,
  };
}

export const isSensitiveNode = (info: DomInfo | undefined): boolean => info !== undefined && isSensitiveField(fieldOf(info));
export const isEditableNode = (info: DomInfo | undefined): boolean => info !== undefined && isEditableField(fieldOf(info));

export interface OutlineInput {
  /** Accessibility trees by frame id; the main frame's must be present. */
  trees: Map<string, AXNode[]>;
  mainFrame: string;
  dom: Map<number, DomInfo>;
  /** Frames (by id) whose origin is in the grant. */
  grantedFrames: Set<string>;
  maxChars: number;
  refFor(backendNodeId: number, frame: string): string;
}

export function formatOutline(input: OutlineInput): { text: string; title: string } {
  const lines: string[] = [];
  let used = 0;
  let full = false;
  const budget = Math.max(64, input.maxChars) - 32;
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

  const byId = (nodes: AXNode[]) => new Map(nodes.map((node) => [node.nodeId, node]));
  const rootOf = (nodes: AXNode[]) => nodes.find((node) => !node.parentId) ?? nodes[0];
  const walked = new Set<string>();

  const walkFrame = (frame: string, indent: string) => {
    const nodes = input.trees.get(frame);
    if (!nodes || walked.has(frame)) return;
    walked.add(frame);
    const map = byId(nodes);
    const root = rootOf(nodes);
    if (root) for (const id of root.childIds ?? []) walk(map, map.get(id), frame, indent);
  };

  const walk = (map: Map<string, AXNode>, node: AXNode | undefined, frame: string, indent: string) => {
    if (!node || full) return;
    const children = () => {
      for (const id of node.childIds ?? []) walk(map, map.get(id), frame, indent);
    };
    if (node.ignored) return children();
    const role = roleOf(node);
    const info = node.backendDOMNodeId === undefined ? undefined : input.dom.get(node.backendDOMNodeId);
    if (role === 'StaticText') {
      const text = collapse(node.name?.value);
      if (text) push(`${indent}text ${JSON.stringify(clip(text, TEXT_LINE_MAX))}`);
      return;
    }
    if (role === 'InlineTextBox' || role === 'LineBreak') return;
    if (role === 'Iframe' || role === 'IframePresentational') {
      const child = info?.childFrame;
      if (child && input.grantedFrames.has(child) && input.trees.has(child)) {
        push(`${indent}frame ${JSON.stringify(clip(nameOf(node) || collapse(info?.attrs.get('title')), TEXT_LINE_MAX))}`);
        walkFrame(child, `${indent}  `);
      }
      return;
    }
    if (role === 'heading') {
      const level = property(node, 'level');
      push(`${indent}heading ${JSON.stringify(nameOf(node))}${level !== undefined ? ` level=${String(level)}` : ''}`);
      return;
    }
    if (role === 'img') {
      const alt = nameOf(node);
      if (alt) push(`${indent}img ${JSON.stringify(alt)}`);
      return;
    }
    if (INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId !== undefined) {
      // A node the DOM read does not know (added between the two reads) cannot be checked: its value is not shown.
      const sensitive = info === undefined || isSensitiveNode(info);
      const type = info?.tag === 'INPUT' && (info.attrs.get('type') ?? '').toLowerCase() === 'password' ? ' type=password' : '';
      let value = '';
      // Before anything else: a sensitive field is redacted whatever role the page gives it.
      if (sensitive) value = ' value=[redacted]';
      else if (CHECK_ROLES.has(role)) value = property(node, 'checked') === 'true' || property(node, 'checked') === true ? ' checked' : ' unchecked';
      else if (VALUE_ROLES.has(role)) value = ` value=${JSON.stringify(clip(collapse(node.value?.value), VALUE_MAX))}`;
      const disabled = property(node, 'disabled') === true ? ' disabled' : '';
      push(`${indent}[${input.refFor(node.backendDOMNodeId, frame)}] ${role} ${JSON.stringify(nameOf(node))}${type}${value}${disabled}`);
      return;
    }
    children();
  };

  walkFrame(input.mainFrame, '');
  const mainRoot = rootOf(input.trees.get(input.mainFrame) ?? []);
  return { text: lines.join('\n'), title: collapse(mainRoot?.name?.value) };
}
