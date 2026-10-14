/**
 * "Browser control" drawer: connection state, this browser's registration, the person's other
 * devices, the agents allowed to use this browser, and the form that allows one. Every change goes
 * through the service worker, which owns the relay connection; nothing here holds a secret.
 */
import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Agent } from '@/api/schemas';
import type { PanelState } from '@/browser/panel-state';
import { deviceNameFor, platformOs } from '@/browser/device-name';
import type { Device, Grant } from '@/browser/protocol';
import type { BackgroundResponse, BrowserRequest } from '@/protocol/messages';
import { errorText, useI18n } from '@/shared/i18n';
import { IconClose } from '@/shared/icons';
import { ApprovalCards, ControlButtons } from './BrowserActivity';
import { GrantForm } from './GrantForm';

type Call = (request: BrowserRequest) => Promise<BackgroundResponse>;

/** Default device name from the platform, e.g. "Chrome on Windows". */
const defaultDeviceName = async (): Promise<string> => deviceNameFor(await platformOs());

/** Current time, refreshed every 30 s so grant expiry labels stay honest while the drawer is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function useRun(call: Call) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (request: BrowserRequest): Promise<BackgroundResponse | null> => {
    setBusy(true);
    setError(null);
    try {
      const response = await call(request);
      if (!response.ok) setError(response.code);
      return response;
    } catch {
      setError('internal_error');
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

function DeviceSection({ device, call }: { device: PanelState['device']; call: Call }) {
  const { t } = useI18n();
  const { error, busy, run } = useRun(call);
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [devices, setDevices] = useState<Device[] | null>(null);

  useEffect(() => {
    if (device) return;
    let live = true;
    void defaultDeviceName().then((value) => {
      if (live) setName((current) => current || value);
    });
    return () => {
      live = false;
    };
  }, [device]);

  const loadDevices = async () => {
    const response = await run({ type: 'browser.device.list' });
    if (response?.ok) setDevices(response.devices ?? []);
  };
  const revoke = async (deviceId: string) => {
    if (!window.confirm(t('browser.revokeDeviceConfirm'))) return;
    const response = await run({ type: 'browser.device.revoke', deviceId });
    if (response?.ok && devices) setDevices(devices.filter((item) => item.device_id !== deviceId));
  };

  return (
    <section className="browser-section" aria-label={t('browser.device')}>
      <span className="section-label">{t('browser.device')}</span>
      {device ? (
        renaming ? (
          <form
            className="browser-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const next = name.trim();
              if (!next) return;
              void run({ type: 'browser.device.rename', deviceId: device.device_id, name: next }).then((response) => {
                if (response?.ok) setRenaming(false);
              });
            }}
          >
            <input className="input compact grow" aria-label={t('browser.deviceName')} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} autoFocus />
            <button type="submit" className="btn small" disabled={busy || !name.trim()}>
              {t('browser.save')}
            </button>
          </form>
        ) : (
          <div className="browser-row">
            <span className="truncate grow" data-testid="browser-device-name">
              {device.name}
            </span>
            <button
              type="button"
              className="btn btn-ghost small"
              onClick={() => {
                setName(device.name);
                setRenaming(true);
              }}
            >
              {t('browser.rename')}
            </button>
            <button type="button" className="btn btn-ghost small text-danger" disabled={busy} onClick={() => void revoke(device.device_id)}>
              {t('browser.revokeDevice')}
            </button>
          </div>
        )
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void run({ type: 'browser.enroll', name: name.trim() });
          }}
        >
          <label className="field">
            <span>{t('browser.deviceName')}</span>
            <input className="input compact" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
          </label>
          <p className="muted small">{t('browser.enrollHint')}</p>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {t('browser.enroll')}
          </button>
        </form>
      )}
      {devices ? (
        <ul className="browser-list" aria-label={t('browser.devices')}>
          {devices
            .filter((item) => !item.revoked_at)
            .map((item) => (
              <li key={item.device_id} className="browser-row">
                <span className="truncate grow">
                  {item.name}
                  {item.device_id === device?.device_id ? <span className="badge">{t('browser.thisDevice')}</span> : null}
                </span>
                {item.online !== undefined ? <span className="muted small">{item.online ? t('browser.deviceOnline') : t('browser.deviceOffline')}</span> : null}
                <button type="button" className="btn btn-ghost small text-danger" disabled={busy} onClick={() => void revoke(item.device_id)}>
                  {t('browser.revokeDevice')}
                </button>
              </li>
            ))}
        </ul>
      ) : (
        <button type="button" className="link small browser-more" onClick={() => void loadDevices()}>
          {t('browser.showDevices')}
        </button>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {errorText(t, error)}
        </p>
      ) : null}
    </section>
  );
}

function GrantList({ grants, agents, call }: { grants: Grant[]; agents: Agent[]; call: Call }) {
  const { t, locale } = useI18n();
  const { error, busy, run } = useRun(call);
  const now = useNow();
  const agentName = (id: string) => {
    const agent = agents.find((item) => item.id === id);
    return agent ? agent.name || agent.key : id;
  };
  const time = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeStyle: 'short', dateStyle: 'short' }).format(new Date(iso));
    } catch {
      return iso;
    }
  };
  return (
    <section className="browser-section" aria-label={t('browser.grants')}>
      <span className="section-label">{t('browser.grants')}</span>
      {grants.length ? (
        <ul className="browser-list" data-testid="browser-grants">
          {grants.map((grant) => {
            const expired = Date.parse(grant.expires_at) <= now;
            return (
              <li key={grant.grant_id} className="browser-grant">
                <div className="browser-row">
                  <span className="grow truncate">{grant.agent_ids.map(agentName).join(', ')}</span>
                  <button type="button" className="btn btn-ghost small text-danger" disabled={busy} onClick={() => void run({ type: 'browser.grant.revoke', grantId: grant.grant_id })}>
                    {t('browser.grant.revoke')}
                  </button>
                </div>
                <span className="mono small browser-origins">{grant.origins.join(' ')}</span>
                <span className="muted small">
                  {grant.capabilities.includes('browser.control') ? t('browser.grant.control') : t('browser.grant.read')} ·{' '}
                  {expired ? t('browser.grant.expired') : t('browser.grant.until', { time: time(grant.expires_at) })}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted small">{t('browser.noGrants')}</p>
      )}
      {error ? (
        <p className="field-error" role="alert">
          {errorText(t, error)}
        </p>
      ) : null}
    </section>
  );
}

export function BrowserControlDrawer({ state, agents, call, onClose }: { state: PanelState; agents: Agent[]; call: Call; onClose(): void }) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('.browser-panel-head button')?.focus();
  }, []);

  const status = t(`browser.status.${state.connection}`);
  return (
    <section ref={panelRef} className="browser-panel" aria-labelledby="browser-panel-title">
      <div className="session-list-head browser-panel-head">
        <span className="section-label" id="browser-panel-title">
          {t('browser.title')}
        </span>
        <button type="button" className="btn btn-ghost icon" aria-label={t('app.close')} title={`${t('app.close')} (Esc)`} onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <div className="browser-scroll">
        {state.mode === 'ready' ? (
          <>
            <div className="browser-row">
              <span className={`status-pill browser-status browser-status-${state.connection}`} role="status" data-testid="browser-status">
                {status}
              </span>
              <span className="grow" />
              <ControlButtons control={state.control} call={call} />
            </div>
            {state.error === 'permission_denied' || state.error === 'unauthorized' ? (
              <p className="notice notice-error" role="alert">
                {t('browser.refused')}
              </p>
            ) : null}
            {state.control !== 'active' ? <p className="notice notice-warn">{state.control === 'paused' ? t('browser.control.paused') : t('browser.control.stopped')}</p> : null}
            <ApprovalCards approvals={state.approvals} call={call} />
            {state.connection === 'connected' ? (
              <>
                <DeviceSection device={state.device} call={call} />
                {state.device ? (
                  <>
                    <GrantList grants={state.grants} agents={agents} call={call} />
                    <GrantForm agents={agents} call={call} />
                  </>
                ) : null}
              </>
            ) : null}
          </>
        ) : (
          <div className="stack">
            <p className="notice">{t(`browser.mode.${state.mode}`)}</p>
            {state.mode !== 'cloud' ? (
              <button type="button" className="btn" onClick={() => void browser.runtime.openOptionsPage()}>
                {t('browser.openSettings')}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
