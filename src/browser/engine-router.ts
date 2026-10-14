/**
 * Picks the adapter for each page request. Standard (the bundled page script) is always there;
 * Advanced (the debugger) only in the Advanced build and only while the person has it turned on.
 *
 * - Refs belong to the adapter whose snapshot handed them out (per tab and generation). A ref is
 *   never resolved by the other adapter: when the engine changes, the executor gets `stale_ref`,
 *   moves the generation and snapshots again.
 * - When Chrome refuses to attach (DevTools or another debugger holds the tab), snapshot and press
 *   use Standard if the person allowed fallback; a click or type on a debugger ref answers
 *   `stale_ref`, so the next snapshot hands out Standard refs. Without fallback the command ends
 *   with `debugger_unavailable`. Screenshots never fall back.
 * - Scrolling, waiting for text, the focused element and the input watcher always use Standard.
 */
import type { BrowserApi } from './chrome-api';
import type { DriverErrorCode, DriverRequest, DriverResponse, PageDriver } from './adapters/page-driver';

export interface DebuggerPrefs {
  /** The person turned the debugger on for this device session. */
  enabled: boolean;
  /** Use Standard for snapshot and press when the debugger cannot attach (ref actions then re-snapshot). */
  fallback: boolean;
}

/** The Advanced adapter as the router sees it (see adapters/cdp/cdp-adapter.ts). */
export interface AdvancedEngine extends PageDriver {
  prepare(tabId: number): Promise<DriverErrorCode | null>;
  release(tabId: number): Promise<void>;
  forget(tabId: number): void;
  forceDetach(tabId: number): Promise<void>;
  detachAll(): Promise<void>;
  isDispatching(tabId: number): boolean;
  /** Tabs the debugger is attached to right now. */
  readonly attachedTabs: number[];
}

type Engine = 'standard' | 'cdp';

const fail = (code: DriverErrorCode): DriverResponse => ({ ok: false, code });

export class EngineRouter implements BrowserApi {
  private readonly issued = new Map<number, { generation: number; engine: Engine }>();

  constructor(
    private readonly standard: BrowserApi,
    private readonly prefs: () => DebuggerPrefs,
    private readonly cdp?: AdvancedEngine,
  ) {}

  get advancedAvailable(): boolean {
    return this.cdp !== undefined;
  }

  get attachedTabs(): number[] {
    return this.cdp?.attachedTabs ?? [];
  }

  createTab(url: string): Promise<number> {
    return this.standard.createTab(url);
  }

  updateTab(tabId: number, url: string): Promise<void> {
    return this.standard.updateTab(tabId, url);
  }

  removeTab(tabId: number): Promise<void> {
    return this.standard.removeTab(tabId);
  }

  getTab(tabId: number) {
    return this.standard.getTab(tabId);
  }

  hasHostPermission(origin: string): Promise<boolean> {
    return this.standard.hasHostPermission(origin);
  }

  /** Engine that handed out the refs of this generation; Standard when none did. */
  engineFor(tabId: number, generation: number): Engine {
    const issued = this.issued.get(tabId);
    return issued && issued.generation === generation ? issued.engine : 'standard';
  }

  async run(tabId: number, request: DriverRequest): Promise<DriverResponse> {
    const cdp = this.cdp;
    const prefs = this.prefs();
    switch (request.op) {
      case 'screenshot':
        if (!cdp || !prefs.enabled) return fail('unsupported_capability');
        return cdp.run(tabId, request);
      case 'snapshot': {
        const engine = await this.choose(tabId, prefs);
        if (typeof engine !== 'string') return engine;
        // Refs of this generation came from the other adapter: start a new generation instead.
        const issued = this.issued.get(tabId);
        if (issued && issued.generation === request.generation && issued.engine !== engine) return fail('stale_ref');
        const response = engine === 'cdp' && cdp ? await cdp.run(tabId, request) : await this.standard.run(tabId, request);
        if (response.ok) this.issued.set(tabId, { generation: request.generation, engine });
        return response;
      }
      case 'press': {
        const engine = await this.choose(tabId, prefs);
        if (typeof engine !== 'string') return engine;
        return engine === 'cdp' && cdp ? cdp.run(tabId, request) : this.standard.run(tabId, request);
      }
      case 'describe':
      case 'highlight':
      case 'click':
      case 'type': {
        if (this.engineFor(tabId, request.generation) === 'standard') return this.standard.run(tabId, request);
        // Refs from a debugger snapshot, but the person turned the debugger off since: snapshot again.
        if (!cdp || !prefs.enabled) return fail('stale_ref');
        const response = await cdp.run(tabId, request);
        // The debugger could not attach for this command (nothing reached the page yet): with fallback
        // allowed, the agent snapshots again and gets Standard refs.
        if (!response.ok && response.code === 'debugger_unavailable' && prefs.fallback && request.op === 'describe') return fail('stale_ref');
        return response;
      }
      default:
        return this.standard.run(tabId, request);
    }
  }

  /** The command using the tab is over: detach. */
  async release(tabId: number): Promise<void> {
    await this.cdp?.release(tabId);
  }

  /** The tab closed or left the agent: drop what is held for it. */
  async forget(tabId: number): Promise<void> {
    this.issued.delete(tabId);
    this.cdp?.forget(tabId);
    await this.cdp?.release(tabId);
  }

  async detachAll(): Promise<void> {
    await this.cdp?.detachAll();
  }

  /** Detaches a tab the worker may have held before it restarted. */
  async forceDetach(tabId: number): Promise<void> {
    await this.cdp?.forceDetach(tabId);
  }

  isDispatching(tabId: number): boolean {
    return this.cdp?.isDispatching(tabId) ?? false;
  }

  /** Debugger when it is on and attaches; Standard when it is off, or cannot attach and fallback is allowed. */
  private async choose(tabId: number, prefs: DebuggerPrefs): Promise<Engine | DriverResponse> {
    if (!this.cdp || !prefs.enabled) return 'standard';
    const refused = await this.cdp.prepare(tabId);
    if (!refused) return 'cdp';
    if (refused === 'debugger_unavailable' && prefs.fallback) return 'standard';
    return fail(refused);
  }
}
