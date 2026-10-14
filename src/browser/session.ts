/**
 * Connected browser session in the service worker: one relay connection for the active
 * self-hosted profile, while the "Connected browser" preference is on and the profile holds an
 * API key. A profile switch, sign-out or turning the preference off closes the socket, cancels
 * running commands and forgets grants and owned tabs, so nothing carries over to another profile.
 *
 * Kept in storage: the server-generated device id and name per profile, the ids of grants the
 * person created here and the person's last Pause/Stop/Resume (`storage.local`, not secrets), and,
 * for a worker restart, the owned-tab handles (`storage.session`). Never kept: page content,
 * snapshots, typed text, the API key.
 *
 * Grants are not taken on the Gateway's word: one is used only if this browser created it, it
 * names this device, and every origin in it is an exact origin.
 */
import { browser } from 'wxt/browser';
import { z } from 'zod';
import { isApiError } from '@/api/errors';
import { readCredential } from '@/auth/credential-store';
import { apiKeyFor } from '@/background/token-manager';
import type { BackgroundResponse, BrowserRequest } from '@/protocol/messages';
import { checkOrigin } from '@/shared/origin';
import { activeProfile, loadSettings, type Profile } from '@/shared/settings';
import { ApprovalBroker } from './approvals';
import { chromeBrowserApi, type BrowserApi } from './chrome-api';
import { CommandRunner } from './command-runner';
import { deviceNameFor, platformOs } from './device-name';
import { Executor, type Activity } from './executor';
import { isRestrictedUrl, LocalGuard, type ControlState } from './policy';
import { commandCancelSchema, deviceRevokedSchema, grantRevokedSchema, isExactOrigin, isValidDeviceName, RELAY_EVENTS, type EventFrame, type Grant } from './protocol';
import { BROWSER_PORT, type PanelState } from './panel-state';
import { TabRegistry } from './tabs';
import { RelayError, RelayTransport, relayUrl, type SocketFactory, type TransportState } from './transport';

export const BROWSER_ALARM = 'browser-relay';
export const deviceKey = (profileId: string) => `browserDevice:${profileId}`;
export const controlKey = (profileId: string) => `browserControl:${profileId}`;
export const tabsKey = (profileId: string) => `browserTabs:${profileId}`;
/** Ids of the grants the person created in this browser (not secret). Grants are honoured only from this list. */
export const grantsKey = (profileId: string) => `browserGrants:${profileId}`;
const OWN_GRANTS_MAX = 200;
/** The Gateway's answer (lowercased) while the workspace has connected browsing turned off. */
export const FEATURE_DISABLED = 'failed_precondition';

const deviceRecord = z.object({ device_id: z.uuid(), name: z.string() });
const ownGrantsRecord = z.array(z.string().min(1)).max(OWN_GRANTS_MAX);
/** The person's last Pause/Stop/Resume for the device (not secret). */
const controlRecord = z.object({ device_id: z.uuid().nullable(), state: z.enum(['active', 'paused', 'stopped']) }).strict();

export interface SessionDeps {
  api?: BrowserApi;
  createSocket?: SocketFactory;
  token?(profileId: string): Promise<string>;
  random?(): number;
  now?(): number;
}

export interface PanelPort {
  name: string;
  postMessage(message: unknown): void;
  onDisconnect: { addListener(callback: () => void): void };
}

function connectionOf(state: TransportState): PanelState['connection'] {
  if (state === 'connected') return 'connected';
  if (state === 'connecting') return 'connecting';
  if (state === 'reconnecting') return 'reconnecting';
  return 'offline';
}

function errorCode(error: unknown): string {
  if (error instanceof RelayError) return error.code.toLowerCase();
  if (error instanceof z.ZodError) return 'invalid_request';
  if (isApiError(error)) return error.code;
  return 'internal_error';
}

/** Same members, ignoring order (the lists hold no repeats). */
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item) => b.includes(item));

const tabOf = (params: object): string | undefined => ('tab' in params && typeof params.tab === 'string' ? params.tab : undefined);

export class BrowserSession {
  private profileId: string | null = null;
  private origin: string | null = null;
  private epoch = 0;
  private transport: RelayTransport | null = null;
  private mode: PanelState['mode'] = 'off';
  private connection: PanelState['connection'] = 'offline';
  private error: string | undefined;
  /** The Gateway refused the key; retried only after the credential changes. */
  private refused = false;
  private device: z.infer<typeof deviceRecord> | null = null;
  private readonly grants = new Map<string, Grant>();
  /** Grant ids created from this browser for the current profile. */
  private ownGrants: string[] = [];
  private control: ControlState = 'active';
  /** True when `control` is the person's own stored choice, which is re-sent after attach. */
  private controlChosen = false;
  /** The transport whose socket finished `browser.device.attach` (or has no device to attach). */
  private attachedTransport: RelayTransport | null = null;
  private readonly tabs = new TabRegistry();
  private readonly activities = new Map<string, Activity>();
  private readonly ports = new Set<PanelPort>();
  private readonly approvals = new ApprovalBroker(() => this.broadcast());
  private readonly api: BrowserApi;
  private readonly runner: CommandRunner;
  private readonly now: () => number;
  private syncing: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SessionDeps = {}) {
    this.api = deps.api ?? chromeBrowserApi;
    this.now = deps.now ?? Date.now;
    const guard = new LocalGuard(this.tabs, {
      hasHostPermission: (origin) => this.api.hasHostPermission(origin),
      tabUrl: async (tabId) => {
        const info = await this.api.getTab(tabId);
        return info === null ? null : info.url;
      },
      now: this.now,
    });
    const executor = new Executor({
      api: this.api,
      tabs: this.tabs,
      guard,
      approvals: this.approvals,
      grant: (grantId) => this.grants.get(grantId),
      control: () => this.control,
      onActivity: (activity, running) => {
        if (running) this.activities.set(activity.commandId, { ...activity });
        else this.activities.delete(activity.commandId);
        this.broadcast();
      },
      onTabsChanged: () => this.persistTabs(),
      now: this.now,
    });
    this.runner = new CommandRunner({
      ack: (params) => this.transport?.request('browser.command.ack', params) ?? Promise.reject(new RelayError('device_offline', 'offline')),
      result: (params) => this.transport?.request('browser.command.result', params) ?? Promise.reject(new RelayError('device_offline', 'offline')),
      execute: (command, signal, context) => executor.execute(command, signal, context) as Promise<Record<string, unknown>>,
      deviceId: () => this.device?.device_id ?? null,
      now: this.now,
    });
  }

  /** Brings the connection in line with the preference, the active profile and its credential. One run at a time. */
  sync(options: { credentialChanged?: boolean } = {}): Promise<void> {
    const run = this.syncing.then(() => this.syncNow(options.credentialChanged ?? false));
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async syncNow(credentialChanged: boolean): Promise<void> {
    if (credentialChanged) this.refused = false;
    const settings = await loadSettings();
    const profile = activeProfile(settings);
    if (!settings.prefs.connectedBrowser || !profile) this.mode = 'off';
    else if (profile.kind === 'cloud') this.mode = 'cloud';
    else this.mode = (await readCredential(profile.id))?.kind === 'api_key' ? 'ready' : 'signed_out';

    if (this.mode !== 'ready' || !profile) {
      await this.stop();
    } else if (this.profileId !== profile.id || this.origin !== profile.origin) {
      await this.stop();
      await this.start(profile);
    } else if (this.transport && this.transport.currentState === 'stopped' && !this.refused) {
      this.transport.start();
    } else if (this.transport?.isReady && this.device) {
      void this.refreshGrants();
    }
    this.broadcast();
  }

  private async start(profile: Profile): Promise<void> {
    const epoch = ++this.epoch;
    this.profileId = profile.id;
    this.origin = profile.origin;
    this.refused = false;
    const [local, session, storedControl] = await Promise.all([
      browser.storage.local.get([deviceKey(profile.id), grantsKey(profile.id)]),
      browser.storage.session.get([tabsKey(profile.id)]),
      browser.storage.local.get(controlKey(profile.id)).then(
        (items) => ({ read: true as const, value: items[controlKey(profile.id)] }),
        () => ({ read: false as const, value: undefined }),
      ),
    ]);
    if (epoch !== this.epoch) return;
    this.device = deviceRecord.safeParse(local[deviceKey(profile.id)]).data ?? null;
    this.ownGrants = ownGrantsRecord.safeParse(local[grantsKey(profile.id)]).data ?? [];
    this.restoreControl(storedControl);
    this.tabs.restore(session[tabsKey(profile.id)]);
    const profileId = profile.id;
    const transport: RelayTransport = new RelayTransport({
      url: relayUrl(profile.origin),
      token: () => (this.deps.token ?? apiKeyFor)(profileId),
      version: browser.runtime.getManifest().version,
      onReady: () => this.attach(transport, epoch),
      heartbeat: () => {
        const device = this.device;
        return device ? transport.request('browser.device.heartbeat', { device_id: device.device_id }).then(() => undefined) : undefined;
      },
      onEvent: (frame) => {
        if (this.transport === transport) this.onEvent(frame);
      },
      onState: (state, detail) => {
        if (this.transport !== transport) return;
        this.connection = connectionOf(state);
        if (detail?.code) {
          this.error = detail.code;
          this.refused = true;
        } else if (state === 'connected') {
          this.error = undefined;
        }
        // A dropped link stops the commands it carried: their results could not be reported anyway.
        if (state !== 'connected') {
          if (this.attachedTransport === transport) this.attachedTransport = null;
          this.runner.cancelAll();
          this.approvals.denyAll();
        }
        this.broadcast();
      },
      createSocket: this.deps.createSocket,
      random: this.deps.random,
    });
    this.transport = transport;
    transport.start();
  }

  /** Closes the connection and forgets everything held for the profile. */
  private async stop(): Promise<void> {
    const profileId = this.profileId;
    if (!profileId) return;
    this.epoch += 1;
    const transport = this.transport;
    this.transport = null;
    this.profileId = this.origin = null;
    this.runner.cancelAll();
    this.approvals.denyAll();
    transport?.stop();
    this.device = null;
    this.grants.clear();
    this.ownGrants = [];
    this.tabs.clear();
    this.activities.clear();
    this.connection = 'offline';
    this.error = undefined;
    // The person's Pause/Stop stays in storage.local for when this profile comes back.
    this.control = 'active';
    this.controlChosen = false;
    this.attachedTransport = null;
    await browser.storage.session.remove([tabsKey(profileId)]).catch(() => undefined);
  }

  /**
   * Pause/Stop survives a Chrome restart and a profile switch. Three cases:
   * - a record for this device: the person's last choice, used locally and re-sent after attach;
   * - no record (never chose, or a new device): `active` locally, nothing sent, the Gateway keeps its state;
   * - the record cannot be read or is damaged: `paused` locally and nothing sent, so a Pause is never
   *   lifted by accident; the person sees Paused and can Resume.
   */
  private restoreControl(stored: { read: boolean; value: unknown }): void {
    this.controlChosen = false;
    this.control = 'active';
    if (!stored.read) {
      this.control = 'paused';
      return;
    }
    if (stored.value === undefined) return;
    const parsed = controlRecord.safeParse(stored.value);
    if (!parsed.success) {
      this.control = 'paused';
      return;
    }
    if (parsed.data.device_id !== (this.device?.device_id ?? null)) return;
    this.control = parsed.data.state;
    this.controlChosen = true;
  }

  private async persistControl(): Promise<void> {
    const profileId = this.profileId;
    if (!profileId) return;
    await browser.storage.local.set({ [controlKey(profileId)]: { device_id: this.device?.device_id ?? null, state: this.control } }).catch(() => undefined);
  }

  private async attach(transport: RelayTransport, epoch: number): Promise<void> {
    const device = this.device;
    if (!device) {
      this.setGrants([]);
      if (epoch === this.epoch) this.attachedTransport = transport;
      return;
    }
    try {
      const attached = await transport.request('browser.device.attach', { device_id: device.device_id, capabilities: ['standard'] });
      if (epoch !== this.epoch) return;
      this.setGrants(attached.grants);
      this.attachedTransport = transport;
      // Re-send the person's own Pause/Stop/Resume: the Gateway may hold an older state, or none
      // after its own restart. Without a stored choice nothing is sent, so `active` never
      // replaces a pause the extension does not know about.
      if (this.controlChosen) void transport.request('browser.control.state', { device_id: device.device_id, state: this.control }).catch(() => undefined);
    } catch (error) {
      // The device was revoked or belongs to someone else: forget it; the person can register again.
      if (error instanceof RelayError && error.code.toLowerCase() === 'not_found') {
        await this.forgetDevice();
        return;
      }
      // The workspace has connected browsing turned off: say so. The reconnect backoff keeps
      // retrying, so the device attaches by itself once an admin turns it on.
      if (error instanceof RelayError && error.code.toLowerCase() === FEATURE_DISABLED && epoch === this.epoch) {
        this.error = FEATURE_DISABLED;
        this.broadcast();
      }
      throw error;
    }
  }

  private async forgetDevice(): Promise<void> {
    const profileId = this.profileId;
    this.device = null;
    this.runner.cancelAll();
    this.approvals.denyAll();
    this.setGrants([]);
    this.tabs.clear();
    this.persistTabs();
    this.ownGrants = [];
    // The choice belonged to the removed device; keep it in memory only (a new device is enrolled
    // from this state and the person still sees it).
    this.controlChosen = false;
    if (profileId) await browser.storage.local.remove([deviceKey(profileId), grantsKey(profileId), controlKey(profileId)]).catch(() => undefined);
    this.broadcast();
  }

  /** A grant this browser created, for this device, over exact origins only. */
  private acceptable(grant: Grant): boolean {
    const device = this.device;
    return (
      !grant.revoked_at &&
      this.ownGrants.includes(grant.grant_id) &&
      device !== null &&
      grant.device_id === device.device_id &&
      grant.origins.length > 0 &&
      grant.origins.every(isExactOrigin)
    );
  }

  private async rememberGrant(grantId: string): Promise<void> {
    const profileId = this.profileId;
    if (!profileId) return;
    this.ownGrants = [...this.ownGrants.filter((id) => id !== grantId), grantId].slice(-OWN_GRANTS_MAX);
    await browser.storage.local.set({ [grantsKey(profileId)]: this.ownGrants });
  }

  private forgetGrantId(grantId: string): void {
    const profileId = this.profileId;
    if (!profileId || !this.ownGrants.includes(grantId)) return;
    this.ownGrants = this.ownGrants.filter((id) => id !== grantId);
    void browser.storage.local.set({ [grantsKey(profileId)]: this.ownGrants }).catch(() => undefined);
  }

  private setGrants(list: Grant[]): void {
    this.grants.clear();
    for (const grant of list) if (this.acceptable(grant)) this.grants.set(grant.grant_id, grant);
    // A grant the Gateway no longer lists is gone: stop what runs under it, approvals included.
    this.runner.cancelWhere((command) => !this.grants.has(command.grant_id), 'grant_revoked');
    for (const tab of this.tabs.all()) if (!this.grants.has(tab.grantId)) this.tabs.releaseGrant(tab.grantId);
    this.persistTabs();
    this.broadcast();
  }

  private dropGrant(grantId: string): void {
    this.grants.delete(grantId);
    this.forgetGrantId(grantId);
    this.runner.cancelWhere((command) => command.grant_id === grantId, 'grant_revoked');
    this.tabs.releaseGrant(grantId);
    this.persistTabs();
    this.broadcast();
  }

  private async refreshGrants(): Promise<void> {
    const transport = this.transport;
    const device = this.device;
    if (!transport?.isReady || !device) return;
    try {
      const { grants } = await transport.request('browser.grant.list', { device_id: device.device_id });
      if (this.transport === transport) this.setGrants(grants);
    } catch {
      // Keep the grants seen so far; the guard still checks expiry before every command.
    }
  }

  private onEvent(frame: EventFrame): void {
    switch (frame.event) {
      case RELAY_EVENTS.command:
        void this.runner.handle(frame.payload);
        return;
      case RELAY_EVENTS.cancel: {
        const parsed = commandCancelSchema.safeParse(frame.payload);
        if (parsed.success) this.runner.cancel(parsed.data.command_id);
        return;
      }
      case RELAY_EVENTS.grantRevoked: {
        const parsed = grantRevokedSchema.safeParse(frame.payload);
        if (parsed.success) this.dropGrant(parsed.data.grant_id);
        return;
      }
      case RELAY_EVENTS.deviceRevoked: {
        const parsed = deviceRevokedSchema.safeParse(frame.payload);
        if (parsed.success && parsed.data.device_id === this.device?.device_id) void this.forgetDevice();
        return;
      }
    }
  }

  // ---------- Browser events ----------

  onTabRemoved(tabId: number): void {
    const tab = this.tabs.markClosed(tabId);
    if (!tab) return;
    this.runner.cancelWhere((command) => tabOf(command.params) === tab.handle, 'tab_closed');
    this.persistTabs();
  }

  /** A navigation or reload in an owned tab: refs from earlier snapshots are stale. */
  onTabUpdated(tabId: number, change: { status?: string; url?: string }): void {
    if (change.status !== 'loading' && change.url === undefined) return;
    if (!this.tabs.byTabId(tabId)) return;
    this.tabs.bump(tabId);
    this.persistTabs();
  }

  /** The person clicked or typed in an owned tab: their input wins over the agent's current command there. */
  onUserInput(tabId: number): void {
    const tab = this.tabs.noteUserInput(tabId, this.now());
    if (tab) this.runner.cancelWhere((command) => tabOf(command.params) === tab.handle);
  }

  // ---------- Side panel ----------

  connectPanel(port: PanelPort): void {
    if (port.name !== BROWSER_PORT) return;
    this.ports.add(port);
    this.approvals.panelOpened();
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
      this.approvals.panelClosed();
    });
    this.post(port);
  }

  state(): PanelState {
    const activity = [...this.activities.values()].at(-1);
    return {
      mode: this.mode,
      connection: this.mode === 'ready' ? this.connection : 'offline',
      error: this.error,
      device: this.device ? { ...this.device } : null,
      grants: [...this.grants.values()],
      control: this.control,
      activity: activity ? { agentName: activity.agentName, channel: activity.channel, domain: activity.domain, action: activity.action } : null,
      approvals: this.approvals.pending,
    };
  }

  private broadcast(): void {
    for (const port of this.ports) this.post(port);
  }

  private post(port: PanelPort): void {
    try {
      port.postMessage({ type: 'browser.state', state: this.state() });
    } catch {
      this.ports.delete(port);
    }
  }

  async handleRequest(request: BrowserRequest): Promise<BackgroundResponse> {
    try {
      switch (request.type) {
        case 'browser.control':
          await this.setControl(request.state);
          return { ok: true };
        case 'browser.approval':
          this.approvals.answer(request.id, request.approve);
          return { ok: true };
        case 'browser.grant.refresh':
          await this.refreshGrants();
          return { ok: true };
      }
      const transport = this.transport;
      if (this.mode !== 'ready' || !transport?.isReady) return { ok: false, code: 'device_offline' };
      switch (request.type) {
        case 'browser.enroll': {
          if (this.attachedTransport !== transport) return { ok: false, code: 'device_offline' };
          const os = await platformOs();
          const name = request.name.trim() || deviceNameFor(os);
          if (!isValidDeviceName(name)) return { ok: false, code: 'invalid_device_name' };
          const { device_id } = await transport.request('browser.device.enroll', { name, platform: os, capabilities: ['standard'] });
          const profileId = this.profileId;
          if (!profileId || this.transport !== transport) return { ok: false, code: 'device_offline' };
          this.device = { device_id, name };
          await browser.storage.local.set({ [deviceKey(profileId)]: this.device });
          // A Pause/Stop the person set before registering applies to the new device too.
          if (this.controlChosen || this.control !== 'active') {
            this.controlChosen = true;
            await this.persistControl();
          }
          await this.attach(transport, this.epoch);
          this.broadcast();
          return { ok: true };
        }
        case 'browser.device.list':
          return { ok: true, devices: (await transport.request('browser.device.list', {})).devices };
        case 'browser.device.rename': {
          if (!isValidDeviceName(request.name.trim())) return { ok: false, code: 'invalid_device_name' };
          const { device } = await transport.request('browser.device.rename', { device_id: request.deviceId, name: request.name });
          if (this.device && this.profileId && device.device_id === this.device.device_id) {
            this.device = { device_id: this.device.device_id, name: device.name || request.name.trim() };
            await browser.storage.local.set({ [deviceKey(this.profileId)]: this.device });
            this.broadcast();
          }
          return { ok: true };
        }
        case 'browser.device.revoke':
          await transport.request('browser.device.revoke', { device_id: request.deviceId });
          if (request.deviceId === this.device?.device_id) await this.forgetDevice();
          return { ok: true };
        case 'browser.grant.create':
          return await this.createGrant(transport, request);
        case 'browser.grant.revoke':
          await transport.request('browser.grant.revoke', { grant_id: request.grantId });
          this.dropGrant(request.grantId);
          return { ok: true };
      }
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
  }

  private async createGrant(transport: RelayTransport, request: Extract<BrowserRequest, { type: 'browser.grant.create' }>): Promise<BackgroundResponse> {
    const device = this.device;
    if (!device) return { ok: false, code: 'not_enrolled' };
    // Only from a socket that finished attach: the Gateway accepts grant.create only there, and a
    // refusal from a socket still attaching must not be taken for a removed device.
    if (this.attachedTransport !== transport) return { ok: false, code: 'device_offline' };
    const origins: string[] = [];
    for (const input of request.origins) {
      const checked = checkOrigin(input);
      if (!checked.ok || isRestrictedUrl(checked.origin) || checked.origin !== input.trim().replace(/\/$/, '')) return { ok: false, code: 'invalid_origin' };
      // The panel asked Chrome for site access in the click; a grant Chrome cannot act on is useless.
      if (!(await this.api.hasHostPermission(checked.origin))) return { ok: false, code: 'origin_permission_missing' };
      if (!origins.includes(checked.origin)) origins.push(checked.origin);
    }
    const capabilities: ['browser.read'] | ['browser.read', 'browser.control'] = request.capabilities.includes('browser.control') ? ['browser.read', 'browser.control'] : ['browser.read'];
    let grant: Grant;
    try {
      ({ grant } = await transport.request('browser.grant.create', { device_id: device.device_id, agent_ids: request.agentIds, origins, capabilities, ttl_seconds: request.ttlSeconds }));
    } catch (error) {
      const code = errorCode(error);
      // The device was revoked elsewhere: forget it, so the person can register again.
      if (code === 'not_found') {
        if (this.transport === transport) await this.forgetDevice();
        return { ok: false, code: 'device_revoked' };
      }
      // An agent the person may not allow (shared by someone else), or a key without the right.
      if (code === 'unauthorized') return { ok: false, code: 'grant_unauthorized' };
      throw error;
    }
    if (this.transport !== transport) return { ok: false, code: 'device_offline' };
    await this.rememberGrant(grant.grant_id);
    // The Gateway's copy must be exactly what the person approved: sites, agents and capabilities.
    if (!sameSet(grant.origins, origins) || !sameSet(grant.agent_ids, request.agentIds) || !sameSet(grant.capabilities, capabilities) || !this.acceptable(grant)) {
      this.forgetGrantId(grant.grant_id);
      // It exists on the Gateway, so withdraw it there as well (best effort).
      void transport.request('browser.grant.revoke', { grant_id: grant.grant_id }).catch(() => undefined);
      return { ok: false, code: 'invalid_response' };
    }
    this.grants.set(grant.grant_id, grant);
    this.broadcast();
    return { ok: true };
  }

  private async setControl(state: ControlState): Promise<void> {
    this.control = state;
    this.controlChosen = true;
    await this.persistControl();
    if (state !== 'active') {
      this.runner.cancelAll();
      this.approvals.denyAll();
    }
    // Stop also ends the agent's hold on its tabs; they stay open for the person.
    if (state === 'stopped') {
      this.tabs.clear();
      this.persistTabs();
    }
    // Not yet attached: attach re-sends the stored choice once it completes.
    const device = this.device;
    const transport = this.transport;
    if (device && transport?.isReady && this.attachedTransport === transport) await transport.request('browser.control.state', { device_id: device.device_id, state }).catch(() => undefined);
    this.broadcast();
  }

  private persistTabs(): void {
    if (!this.profileId) return;
    void browser.storage.session.set({ [tabsKey(this.profileId)]: this.tabs.serialize() }).catch(() => undefined);
  }
}
