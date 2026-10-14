/**
 * Local policy guard. The Gateway checks a grant before it dispatches a command; the extension
 * checks again, right before execution, with what only the browser knows: the grant as last seen
 * here, the local Pause/Stop state, the tab's real current URL, tab ownership and Chrome's own
 * host permission for the origin. Any failed check refuses the command; nothing is relaxed.
 */
import { ACTION_CLASS, type BrowserCommand, type BrowserErrorCode, type Grant } from './protocol';
import type { OwnedTab, TabRegistry } from './tabs';

export type ControlState = 'active' | 'paused' | 'stopped';

const WEB_STORE_HOSTS = new Set(['chromewebstore.google.com']);

/** Exact origin of an http(s) URL, or null. */
export function urlOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Pages the extension never drives: browser and extension pages, the Chrome Web Store, local
 * files, inline documents and every `about:` page. `about:blank` is not opened either: a blank tab
 * has no granted origin to check later commands against, so agents open the granted URL directly.
 */
export function isRestrictedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return true;
  if (parsed.username || parsed.password) return true;
  const host = parsed.hostname.toLowerCase();
  if (WEB_STORE_HOSTS.has(host)) return true;
  return host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore');
}

/** Element names that look like an irreversible step: these need a local confirmation per action. */
const HIGH_RISK_WORDS = [
  'submit', 'send', 'publish', 'post', 'delete', 'remove', 'destroy', 'erase', 'pay', 'payment', 'purchase', 'buy', 'place order',
  'checkout', 'check out', 'transfer', 'withdraw', 'donate', 'subscribe', 'confirm', 'approve', 'deploy', 'merge', 'archive', 'cancel subscription',
  'gửi', 'đăng', 'xoá', 'xóa', 'thanh toán', 'mua', 'đặt hàng', 'chuyển khoản', 'chuyển tiền', 'rút tiền', 'xác nhận', 'duyệt', 'huỷ', 'hủy',
];
const HIGH_RISK_PATTERN = new RegExp(`(^|[^\\p{L}\\p{N}])(${HIGH_RISK_WORDS.map((w) => w.replace(/\s+/g, '\\s+')).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu');
/** "Sign in" / "Sign up" / "Đăng nhập" read like risky words but only start a session; they stay low risk. */
const LOW_RISK_PHRASES = /(^|[^\p{L}])(sign\s+in|sign\s+up|log\s*in|đăng\s+nhập|đăng\s+ký)(?=$|[^\p{L}])/iu;

export function isHighRiskName(name: string): boolean {
  const text = name.normalize('NFC').trim();
  if (!text) return false;
  return HIGH_RISK_PATTERN.test(text.replace(LOW_RISK_PHRASES, ' '));
}

export function grantExpired(grant: Grant, now: number): boolean {
  return Date.parse(grant.expires_at) <= now;
}

export interface GuardDeps {
  /** Chrome host permission granted for exactly this origin's host (a wildcard pattern does not count). */
  hasHostPermission(origin: string): Promise<boolean>;
  /** Current URL of a tab; undefined when Chrome hides it (no host permission), null when the tab is gone. */
  tabUrl(tabId: number): Promise<string | undefined | null>;
  now(): number;
}

export type GuardResult = { ok: true; tab?: OwnedTab } | { ok: false; code: BrowserErrorCode; message: string };

const refuse = (code: BrowserErrorCode, message: string): GuardResult => ({ ok: false, code, message });

export class LocalGuard {
  constructor(
    private readonly tabs: TabRegistry,
    private readonly deps: GuardDeps,
  ) {}

  /**
   * Checks that need no browser call: local control state, grant, agent, capability. Screenshots
   * pass only when `screenshots` is true (Advanced build with the debugger turned on).
   */
  checkGrant(command: BrowserCommand, grant: Grant | undefined, control: ControlState, screenshots = false): GuardResult {
    if (control !== 'active') return refuse('device_paused', `Browser control is ${control} on this device`);
    if (!grant) return refuse('no_grant', 'No grant for this command');
    if (grant.revoked_at) return refuse('grant_revoked', 'The grant was revoked');
    if (grantExpired(grant, this.deps.now())) return refuse('grant_expired', 'The grant expired');
    if (!grant.agent_ids.includes(command.agent_id)) return refuse('no_grant', 'This agent is not in the grant');
    const needs = ACTION_CLASS[command.action] === 'read' ? 'browser.read' : 'browser.control';
    if (!grant.capabilities.includes(needs)) return refuse('capability_not_granted', `The grant does not allow ${needs}`);
    if (command.action === 'screenshot' && !screenshots) return refuse('unsupported_capability', 'Screenshots need the advanced build with the debugger turned on');
    return { ok: true };
  }

  /** A URL the agent asked for, or a tab ended up on: allowed page, granted origin, Chrome site access. */
  async checkUrl(url: string | undefined | null, grant: Grant): Promise<GuardResult> {
    if (!url) return refuse('origin_not_granted', 'The page address is not available for this grant');
    if (isRestrictedUrl(url)) return refuse('restricted_page', 'This page cannot be controlled');
    const origin = urlOrigin(url);
    if (!origin || !grant.origins.includes(origin)) return refuse('origin_not_granted', 'This site is not in the grant');
    if (!(await this.deps.hasHostPermission(origin))) return refuse('origin_not_granted', 'Chrome site access for this site is missing');
    return { ok: true };
  }

  /** The owned tab a command targets. `needsPage` also checks the page now shown in it. */
  async checkTab(handle: string, grant: Grant, needsPage: boolean): Promise<GuardResult> {
    const tab = this.tabs.get(handle);
    if (!tab || tab.grantId !== grant.grant_id) return refuse('tab_not_owned', 'This tab was not opened under this grant');
    if (tab.closed) return refuse('tab_closed', 'The tab was closed');
    const url = await this.deps.tabUrl(tab.tabId);
    if (url === null) {
      this.tabs.markClosed(tab.tabId);
      return refuse('tab_closed', 'The tab was closed');
    }
    if (needsPage) {
      const page = await this.checkUrl(url, grant);
      if (!page.ok) return page;
    }
    if (this.tabs.isHeldByUser(tab.tabId, this.deps.now())) return refuse('busy', 'The person is using this tab');
    return { ok: true, tab };
  }
}
