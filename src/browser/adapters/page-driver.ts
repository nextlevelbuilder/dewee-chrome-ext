/**
 * The semantic page actions the executor asks for, whatever drives the page. Two adapters
 * implement them:
 *
 * - Standard (`chrome-api.ts`): the bundled `pageRun` function injected with `chrome.scripting`.
 * - Advanced (`adapters/cdp/`): the Chrome DevTools Protocol through `chrome.debugger`, on the
 *   agent's own tab only, after the person turned it on.
 *
 * Policy (grant, origin, approvals, redaction rules, Pause/Stop) is decided once, in the executor
 * and the local guard, before either adapter is called. Adapters only carry out an action that
 * was already allowed, and refuse rather than guess.
 */
import type { BrowserErrorCode } from '../protocol';
import type { PageRequest, PageResponse } from '../snapshot';

export type DriverRequest = PageRequest | { op: 'screenshot'; origins: string[] };

/** Codes an adapter may answer with; all of them are relay error codes. */
export type DriverErrorCode = Extract<
  BrowserErrorCode,
  | 'stale_ref'
  | 'element_not_found'
  | 'element_not_interactable'
  | 'sensitive_field'
  | 'origin_not_granted'
  | 'restricted_page'
  | 'debugger_unavailable'
  | 'unsupported_capability'
  | 'device_paused'
  | 'no_grant'
  | 'grant_expired'
  | 'grant_revoked'
  | 'tab_not_owned'
  | 'tab_closed'
  | 'timeout'
  | 'internal'
>;

export type DriverResponse =
  | Exclude<PageResponse, { ok: false }>
  /** A JPEG of the visible viewport, base64, at most `MAX_SCREENSHOT_BYTES` once decoded. */
  | { ok: true; op: 'screenshot'; data: string }
  | { ok: false; code: DriverErrorCode };

export interface PageDriver {
  run(tabId: number, request: DriverRequest): Promise<DriverResponse>;
  /** The command that used the tab is over: let go of anything held for it (the debugger). */
  release?(tabId: number): Promise<void>;
}

/** Gateway limit for a screenshot, in decoded bytes (1.5 MiB). */
export const MAX_SCREENSHOT_BYTES = 1536 * 1024;
