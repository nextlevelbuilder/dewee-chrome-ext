/**
 * Runs one validated command: local policy first, then the semantic action with `chrome.tabs` and a
 * page adapter (the bundled page runtime, or the debugger in the Advanced build; see
 * engine-router.ts). Checks run again right before every side effect (the grant can be revoked,
 * Pause pressed or the tab navigated while a step was waiting). Results carry only what the
 * contract returns; page text, typed text, screenshots and DOM are never logged or stored.
 */
import { MAX_SCREENSHOT_BYTES, type DriverRequest, type DriverResponse } from './adapters/page-driver';
import { approvalPreview, type ApprovalBroker, type ApprovalRequest } from './approvals';
import type { BrowserApi } from './chrome-api';
import { isHighRiskName, isRestrictedUrl, LocalGuard, urlOrigin, type ControlState, type GuardResult } from './policy';
import { SNAPSHOT_DEFAULT_CHARS, type ActionResult, type BrowserCommand, type BrowserErrorCode, type Grant } from './protocol';
import type { OwnedTab, TabRegistry } from './tabs';

export class CommandError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/** Shared between the runner and the executor: once true, an interrupted command may have had an effect. */
export interface ExecutionContext {
  sideEffect: boolean;
}

export interface Activity {
  commandId: string;
  grantId: string;
  agentName: string;
  channel: string;
  domain: string;
  action: string;
  /** The owned tab's handle, once known. */
  tab?: string;
}

export interface ExecutorDeps {
  api: BrowserApi;
  tabs: TabRegistry;
  guard: LocalGuard;
  approvals: ApprovalBroker;
  grant(grantId: string): Grant | undefined;
  control(): ControlState;
  /** Screenshots can be taken (Advanced build, debugger turned on). */
  screenshots?(): boolean;
  onActivity(activity: Activity, running: boolean): void;
  onTabsChanged(): void;
  now?(): number;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

const LOAD_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
const SETTLE_MS = 300;
const WAIT_TEXT_MS = 10_000;
/** How long the target stays outlined before a click, so the person can see it. */
const HIGHLIGHT_MS = 250;

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CommandError('cancelled'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CommandError('cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function ensure(result: GuardResult): asserts result is { ok: true; tab?: OwnedTab } {
  if (!result.ok) throw new CommandError(result.code, result.message);
}

function pageError(response: DriverResponse): never {
  throw new CommandError(response.ok ? 'internal' : response.code, response.ok ? undefined : response.message);
}

type Described = Extract<DriverResponse, { op: 'describe' }>;

/** The element still looks the way it did when the person was asked. */
function sameTarget(before: Described, after: Described): boolean {
  return before.role === after.role && before.name === after.name && before.sensitive === after.sensitive && before.editable === after.editable;
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

export class Executor {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly deps: ExecutorDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? abortableSleep;
  }

  async execute(command: BrowserCommand, signal: AbortSignal, context: ExecutionContext): Promise<ActionResult[BrowserCommand['action']]> {
    const grant = this.recheck(command, signal);
    const activity: Activity = { commandId: command.command_id, grantId: command.grant_id, agentName: command.agent_name ?? '', channel: command.channel ?? '', domain: '', action: command.action };
    this.deps.onActivity(activity, true);
    try {
      return await this.dispatch(command, grant, signal, context, activity);
    } finally {
      this.deps.onActivity(activity, false);
    }
  }

  /** Grant, agent, capability and local Pause/Stop, plus cancellation; run again before each side effect. */
  private recheck(command: BrowserCommand, signal: AbortSignal): Grant {
    if (signal.aborted) throw new CommandError('cancelled');
    const grant = this.deps.grant(command.grant_id);
    ensure(this.deps.guard.checkGrant(command, grant, this.deps.control(), this.deps.screenshots?.() ?? false));
    return grant as Grant;
  }

  private remaining(command: BrowserCommand, cap: number): number {
    return Math.max(0, Math.min(cap, Date.parse(command.deadline) - this.now()));
  }

  private async dispatch(command: BrowserCommand, grant: Grant, signal: AbortSignal, context: ExecutionContext, activity: Activity): Promise<ActionResult[BrowserCommand['action']]> {
    const { guard, tabs } = this.deps;
    if (command.action === 'tabs') return this.listTabs(grant);
    if (command.action === 'open') {
      activity.domain = hostOf(command.params.url);
      this.deps.onActivity(activity, true);
      ensure(await guard.checkUrl(command.params.url, grant));
      this.recheck(command, signal);
      context.sideEffect = true;
      const tabId = await this.deps.api.createTab(command.params.url);
      if (signal.aborted) {
        // Cancelled while Chrome created the tab (Stop, revoke, a profile switch): never hand it to the agent.
        await this.deps.api.removeTab(tabId).catch(() => undefined);
        throw new CommandError('cancelled');
      }
      const owned = tabs.add(tabId, grant.grant_id, command.agent_id);
      activity.tab = owned.handle;
      this.deps.onActivity(activity, true);
      this.deps.onTabsChanged();
      await this.waitForLoad(tabId, signal, this.remaining(command, LOAD_TIMEOUT_MS));
      const info = await this.tabInfo(tabId);
      const landed = await guard.checkUrl(info.url, grant);
      if (!landed.ok) {
        // A redirect left the grant: close the tab this command opened instead of leaving it to the agent.
        await this.deps.api.removeTab(tabId).catch(() => undefined);
        tabs.markClosed(tabId);
        this.deps.onTabsChanged();
        throw new CommandError(landed.code, landed.message);
      }
      await this.watch(tabId, grant);
      return { tab: owned.handle, url: info.url ?? '', title: info.title ?? '' };
    }

    const handle = command.params.tab;
    // The page now in the tab must be in the grant too (navigate included); closing an owned tab and a plain delay are always allowed.
    const needsPage = command.action !== 'close' && !(command.action === 'wait' && 'ms' in command.params);
    const target = await guard.checkTab(handle, grant, needsPage);
    ensure(target);
    const tab = target.tab as OwnedTab;
    if (!tabs.lease(handle)) throw new CommandError('busy', 'Another command is using this tab');
    try {
      activity.domain = hostOf((await this.deps.api.getTab(tab.tabId))?.url);
      activity.tab = handle;
      this.deps.onActivity(activity, true);
      return await this.onTab(command, grant, tab, signal, context);
    } finally {
      // The debugger (Advanced) is held only while a command runs on the tab.
      await Promise.resolve(this.deps.api.release?.(tab.tabId)).catch(() => undefined);
      tabs.release(handle);
    }
  }

  private async onTab(command: Exclude<BrowserCommand, { action: 'tabs' | 'open' }>, grant: Grant, tab: OwnedTab, signal: AbortSignal, context: ExecutionContext): Promise<ActionResult[BrowserCommand['action']]> {
    const { guard, tabs, api } = this.deps;
    const origins = grant.origins;
    switch (command.action) {
      case 'navigate': {
        ensure(await guard.checkUrl(command.params.url, grant));
        this.recheck(command, signal);
        context.sideEffect = true;
        tabs.bump(tab.tabId);
        this.deps.onTabsChanged();
        await api.updateTab(tab.tabId, command.params.url);
        await this.waitForLoad(tab.tabId, signal, this.remaining(command, LOAD_TIMEOUT_MS));
        return this.landed(tab, grant);
      }
      case 'snapshot': {
        const maxChars = command.params.max_chars ?? SNAPSHOT_DEFAULT_CHARS;
        let response = await api.run(tab.tabId, { op: 'snapshot', origins, generation: tab.generation, maxChars }, signal);
        if (!response.ok && response.code === 'stale_ref') {
          // The page changed a lot since the last snapshot: start a new generation and read it again.
          tabs.bump(tab.tabId);
          this.deps.onTabsChanged();
          response = await api.run(tab.tabId, { op: 'snapshot', origins, generation: tab.generation, maxChars }, signal);
        }
        if (!response.ok || response.op !== 'snapshot') pageError(response);
        ensure(await guard.checkUrl(response.url, grant));
        return { tab: tab.handle, url: response.url, title: response.title, generation: tab.generation, text: response.text };
      }
      case 'click':
      case 'type': {
        const { ref, generation } = command.params;
        if (generation !== tab.generation) throw new CommandError('stale_ref', 'The page changed since that snapshot');
        await this.watch(tab.tabId, grant);
        const described = await this.page(tab.tabId, { op: 'describe', origins, generation, ref }, signal);
        if (described.op !== 'describe') pageError(described);
        if (command.action === 'type') {
          if (described.sensitive) throw new CommandError('sensitive_field', 'Typing into password or payment fields is not allowed');
          if (!described.editable) throw new CommandError('element_not_interactable', 'This element does not accept text');
        }
        const submit = command.action === 'type' && command.params.submit === true;
        if (submit || isHighRiskName(described.name)) {
          await this.approve(command, tab, signal, { action: command.action, target: described.name, submit, preview: submit && command.action === 'type' ? approvalPreview(command.params.text) : undefined });
          // The page may have changed while the person decided: act only on the element they approved.
          const again = await this.page(tab.tabId, { op: 'describe', origins, generation, ref }, signal);
          if (again.op !== 'describe' || !sameTarget(described, again)) throw new CommandError('stale_ref', 'The element changed while waiting for approval');
        }
        if (command.action === 'click') await this.highlight(tab.tabId, { op: 'highlight', origins, generation, ref }, signal);
        this.recheck(command, signal);
        ensure(await guard.checkTab(tab.handle, grant, true));
        if (tab.generation !== generation) throw new CommandError('stale_ref', 'The page changed since that snapshot');
        context.sideEffect = true;
        const request: DriverRequest =
          command.action === 'click' ? { op: 'click', origins, generation, ref } : { op: 'type', origins, generation, ref, text: command.params.text, submit };
        await this.page(tab.tabId, request, signal);
        await this.settle(tab.tabId, signal, command);
        return this.landed(tab, grant);
      }
      case 'press': {
        await this.watch(tab.tabId, grant);
        // Keys go to whatever has focus: never a password or payment field, never a frame the grant
        // does not cover (the adapters check again right before sending).
        const focused = await this.page(tab.tabId, { op: 'focused', origins }, signal);
        if (focused.op !== 'describe') pageError(focused);
        if (focused.sensitive) throw new CommandError('sensitive_field', 'Keys are not sent to password or payment fields');
        if (command.params.key === 'Enter') {
          // Enter submits forms and sends messages in chat boxes: the same confirmation as `type` with submit.
          await this.approve(command, tab, signal, { action: 'press', target: focused.name, submit: true });
          const again = await this.page(tab.tabId, { op: 'focused', origins }, signal);
          if (again.op !== 'describe' || !sameTarget(focused, again)) throw new CommandError('stale_ref', 'The focused element changed while waiting for approval');
          ensure(await guard.checkTab(tab.handle, grant, true));
        }
        this.recheck(command, signal);
        context.sideEffect = true;
        await this.page(tab.tabId, { op: 'press', origins, key: command.params.key }, signal);
        return { tab: tab.handle };
      }
      case 'scroll': {
        await this.page(tab.tabId, { op: 'scroll', origins, direction: command.params.direction, amount: command.params.amount ?? 'page' }, signal);
        return { tab: tab.handle };
      }
      case 'wait': {
        if ('ms' in command.params) {
          await this.sleep(command.params.ms, signal);
          return { tab: tab.handle };
        }
        const until = this.now() + this.remaining(command, WAIT_TEXT_MS);
        for (;;) {
          const found = await this.page(tab.tabId, { op: 'findText', origins, text: command.params.text }, signal);
          if (found.op === 'findText' && found.found) return { tab: tab.handle };
          if (this.now() >= until) throw new CommandError('timeout', 'The text did not appear in time');
          await this.sleep(250, signal);
          // The grant can expire or be revoked, or Pause pressed, while waiting.
          this.recheck(command, signal);
          ensure(await guard.checkTab(tab.handle, grant, true));
        }
      }
      case 'close': {
        this.recheck(command, signal);
        context.sideEffect = true;
        await api.removeTab(tab.tabId).catch(() => undefined);
        tabs.markClosed(tab.tabId);
        this.deps.onTabsChanged();
        return {};
      }
      case 'screenshot': {
        this.recheck(command, signal);
        const shot = await this.page(tab.tabId, { op: 'screenshot', origins }, signal);
        if (shot.op !== 'screenshot') pageError(shot);
        // The adapter keeps it within the Gateway's limit; check again rather than send an oversized frame.
        if (Math.floor((shot.data.length * 3) / 4) > MAX_SCREENSHOT_BYTES + 2) throw new CommandError('internal', 'The screenshot is too large');
        const landed = await this.landed(tab, grant);
        return { tab: tab.handle, url: landed.url, mime: 'image/jpeg', data_base64: shot.data };
      }
    }
  }

  /** Outlines the element for a moment before a click (best effort: a failure does not stop the click). */
  private async highlight(tabId: number, request: Extract<DriverRequest, { op: 'highlight' }>, signal: AbortSignal): Promise<void> {
    const shown = await this.deps.api.run(tabId, request, signal).catch(() => null);
    if (shown?.ok) await this.sleep(HIGHLIGHT_MS, signal);
  }

  /** Waits for the person's "Allow once"; anything else (deny, no panel, panel closed, cancel) refuses. */
  private async approve(command: BrowserCommand, tab: OwnedTab, signal: AbortSignal, details: Pick<ApprovalRequest, 'action' | 'target' | 'submit' | 'preview'>): Promise<void> {
    const domain = hostOf((await this.deps.api.getTab(tab.tabId))?.url);
    const approved = await this.deps.approvals.request({ agentName: command.agent_name ?? '', channel: command.channel ?? '', domain, ...details }, signal);
    if (!approved) throw new CommandError('approval_denied', 'The person did not approve this action');
  }

  private async listTabs(grant: Grant): Promise<ActionResult['tabs']> {
    const list: ActionResult['tabs']['tabs'] = [];
    for (const tab of this.deps.tabs.ownedBy(grant.grant_id)) {
      const info = await this.deps.api.getTab(tab.tabId);
      if (!info) {
        this.deps.tabs.markClosed(tab.tabId);
        continue;
      }
      // A tab that left the grant is listed without its address or title.
      const visible = info.url && !isRestrictedUrl(info.url) && grant.origins.includes(urlOrigin(info.url) ?? '');
      list.push({ tab: tab.handle, url: visible ? (info.url ?? '') : '', title: visible ? (info.title ?? '') : '', active: info.active });
    }
    this.deps.onTabsChanged();
    return { tabs: list };
  }

  private async page(tabId: number, request: DriverRequest, signal: AbortSignal): Promise<Extract<DriverResponse, { ok: true }>> {
    const response = await this.deps.api.run(tabId, request, signal);
    if (!response.ok) {
      // Input may already have reached the page (a click pressed, text inserted): the agent must
      // look before trying again, whatever stopped the rest of the step.
      if (response.effect === 'maybe') throw new CommandError('outcome_unknown');
      if (response.code === 'stale_ref') {
        // A large DOM change: move the generation so the next snapshot hands out fresh refs.
        this.deps.tabs.bump(tabId);
        this.deps.onTabsChanged();
      }
      pageError(response);
    }
    return response;
  }

  /** Watches for the person's own clicks and key presses in the tab (best effort). */
  private async watch(tabId: number, grant: Grant): Promise<void> {
    await this.deps.api.run(tabId, { op: 'watch', origins: grant.origins }).catch(() => undefined);
  }

  private async tabInfo(tabId: number) {
    const info = await this.deps.api.getTab(tabId);
    if (!info) {
      this.deps.tabs.markClosed(tabId);
      this.deps.onTabsChanged();
      throw new CommandError('tab_closed', 'The tab was closed');
    }
    return info;
  }

  /** The page an action ended on must still be in the grant (a click or redirect may have left it). */
  private async landed(tab: OwnedTab, grant: Grant): Promise<ActionResult['click']> {
    const info = await this.tabInfo(tab.tabId);
    ensure(await this.deps.guard.checkUrl(info.url, grant));
    return { tab: tab.handle, url: info.url ?? '', title: info.title ?? '' };
  }

  private async waitForLoad(tabId: number, signal: AbortSignal, timeoutMs: number): Promise<void> {
    const until = this.now() + timeoutMs;
    await this.sleep(POLL_MS, signal);
    for (;;) {
      const info = await this.tabInfo(tabId);
      if (info.status === 'complete' || this.now() >= until) return;
      await this.sleep(POLL_MS, signal);
    }
  }

  /** After a click or typing, give a navigation it started the chance to begin, then to finish. */
  private async settle(tabId: number, signal: AbortSignal, command: BrowserCommand): Promise<void> {
    await this.sleep(SETTLE_MS, signal);
    const info = await this.tabInfo(tabId);
    if (info.status === 'loading') await this.waitForLoad(tabId, signal, this.remaining(command, LOAD_TIMEOUT_MS));
  }
}
