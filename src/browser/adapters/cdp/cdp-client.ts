/**
 * The only path to `chrome.debugger` in the extension. It attaches to one tab target at a time
 * (`{ tabId }`; never a browser-level target, never a remote debugging port) and sends only the
 * Chrome DevTools Protocol methods listed in `CDP_METHODS`, with parameters built by the adapter.
 * Nothing that arrives over the wire is ever a method name or a parameter object.
 *
 * Every command first passes the local policy check for the tab (grant, Pause/Stop, the page's
 * origin, the person's debugger opt-in); a refusal detaches at once.
 */
import type { DriverErrorCode } from '../page-driver';

/**
 * The whitelist. No `Runtime.*` (no script evaluation), no `Network.*`, `Storage.*`, `Fetch.*` or
 * cookies, no `Target.*` (no other targets), no `Page.navigate` (navigation goes through
 * `chrome.tabs` and the guard), no `Page.bringToFront` (never steal focus).
 */
export const CDP_METHODS = [
  'Accessibility.getFullAXTree',
  'Accessibility.getPartialAXTree',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.getContentQuads',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.focus',
  'DOM.getNodeForLocation',
  'Page.getFrameTree',
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Overlay.enable',
  'Overlay.highlightNode',
  'Overlay.hideHighlight',
] as const;
export type CdpMethod = (typeof CDP_METHODS)[number];

const ALLOWED: ReadonlySet<string> = new Set(CDP_METHODS);

export function isAllowedCdpMethod(method: string): method is CdpMethod {
  return ALLOWED.has(method);
}

/** CDP protocol version requested on attach. */
export const CDP_VERSION = '1.3';
/** Longest a single CDP command may take before it counts as failed. */
export const CDP_COMMAND_TIMEOUT_MS = 10_000;

/** A tab target. There is deliberately no way to name a browser, worker or extension target. */
export interface TabTarget {
  tabId: number;
}

/** The parts of `chrome.debugger` the client uses, so tests can provide a fake. */
export interface DebuggerApi {
  attach(target: TabTarget, version: string): Promise<void>;
  detach(target: TabTarget): Promise<void>;
  sendCommand(target: TabTarget, method: string, params?: Record<string, unknown>): Promise<unknown>;
  onDetach: { addListener(callback: (source: { tabId?: number }, reason: string) => void): void };
}

/**
 * A debugger step that did not happen or failed. `beforeEffect` is true only when nothing reached
 * the page (attach itself failed), which is the only case where Standard may take over.
 */
export class CdpFailure extends Error {
  constructor(
    readonly code: DriverErrorCode,
    readonly beforeEffect: boolean,
    /** Chrome's own error text, kept for mapping only; never sent to the Gateway. */
    readonly detail = '',
  ) {
    super(code);
    this.name = 'CdpFailure';
  }
}

export interface CdpClientDeps {
  debugger: DebuggerApi;
  /** Local policy for this tab right now: null when allowed, otherwise the refusal. */
  check(tabId: number): Promise<DriverErrorCode | null>;
  /** Chrome ended a session we held (tab closed, the person pressed Cancel on Chrome's bar, ...). */
  onDetached?(tabId: number, reason: string): void;
  /** The set of attached tabs changed (for the side panel). */
  onChange?(): void;
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CdpFailure('timeout', false, 'CDP command timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class CdpClient {
  private readonly attached = new Set<number>();
  private readonly pending = new Map<number, Promise<void>>();
  private readonly timeoutMs: number;

  constructor(private readonly deps: CdpClientDeps) {
    this.timeoutMs = deps.timeoutMs ?? CDP_COMMAND_TIMEOUT_MS;
    deps.debugger.onDetach.addListener((source, reason) => {
      const tabId = source.tabId;
      if (tabId === undefined || !this.attached.delete(tabId)) return;
      deps.onDetached?.(tabId, reason);
      deps.onChange?.();
    });
  }

  get attachedTabs(): number[] {
    return [...this.attached];
  }

  isAttached(tabId: number): boolean {
    return this.attached.has(tabId);
  }

  /** Attaches to the tab after the policy check. Throws `CdpFailure` (`beforeEffect: true`). */
  async attach(tabId: number): Promise<void> {
    if (this.attached.has(tabId)) return;
    const running = this.pending.get(tabId);
    if (running) return running;
    const attaching = (async () => {
      const refused = await this.deps.check(tabId);
      if (refused) throw new CdpFailure(refused, true);
      try {
        await withTimeout(this.deps.debugger.attach({ tabId }, CDP_VERSION), this.timeoutMs);
      } catch (error) {
        // DevTools or another extension holds the tab, the page is one Chrome never lets extensions
        // debug, or the tab went away.
        throw new CdpFailure('debugger_unavailable', true, error instanceof Error ? error.message : '');
      }
      this.attached.add(tabId);
      this.deps.onChange?.();
    })();
    this.pending.set(tabId, attaching);
    try {
      await attaching;
    } finally {
      this.pending.delete(tabId);
    }
  }

  /** Sends one whitelisted command to an attached tab, after the policy check. */
  async send<T = Record<string, unknown>>(tabId: number, method: CdpMethod, params: Record<string, unknown> = {}): Promise<T> {
    // The type already restricts `method`; this runtime check holds even against a cast.
    if (!isAllowedCdpMethod(method)) throw new CdpFailure('internal', false, `method not allowed: ${String(method)}`);
    if (!this.attached.has(tabId)) throw new CdpFailure('debugger_unavailable', false);
    const refused = await this.deps.check(tabId);
    if (refused) {
      await this.detach(tabId);
      throw new CdpFailure(refused, false);
    }
    try {
      return (await withTimeout(this.deps.debugger.sendCommand({ tabId }, method, params), this.timeoutMs)) as T;
    } catch (error) {
      if (error instanceof CdpFailure) throw error;
      // Detached meanwhile (Stop, revoke, the person cancelled Chrome's bar, the tab closed).
      if (!this.attached.has(tabId)) throw new CdpFailure('debugger_unavailable', false);
      throw new CdpFailure('internal', false, error instanceof Error ? error.message : '');
    }
  }

  /** Lets go of the tab. `force` also asks Chrome when this worker does not remember attaching (after a restart). */
  async detach(tabId: number, force = false): Promise<void> {
    const held = this.attached.delete(tabId);
    if (!held && !force) return;
    await this.deps.debugger.detach({ tabId }).catch(() => undefined);
    if (held) this.deps.onChange?.();
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.attached].map((tabId) => this.detach(tabId)));
  }
}
