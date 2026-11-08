/**
 * Dewee Cloud browser use, in the order the person meets it: turn it on, accept the policy once,
 * get the workspace switched on (owner/admin) or learn who can, then share the tab they have open
 * with the agent of the current chat. Chrome's site access for that tab's exact origin is asked for
 * inside the click; the service worker re-reads the tab and creates the shared-tab grant. Nothing
 * here holds a secret or page content.
 */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Agent } from '@/api/schemas';
import type { PanelState } from '@/browser/panel-state';
import { isRestrictedUrl, urlOrigin } from '@/browser/policy';
import { isExactOrigin } from '@/browser/protocol';
import { callBackground, type BackgroundResponse, type BrowserRequest } from '@/protocol/messages';
import { errorText, useI18n } from '@/shared/i18n';
import { IconStop } from '@/shared/icons';
import { originPermissionPattern } from '@/shared/origin';
import { formatTime } from './BrowserActivity';

type Call = (request: BrowserRequest) => Promise<BackgroundResponse>;

function ErrorLine({ code }: { code: string | null }) {
  const { t } = useI18n();
  if (!code) return null;
  return (
    <p className="field-error" role="alert">
      {errorText(t, code)}
    </p>
  );
}

/** Browser use is off for this profile: one switch turns it on. */
export function CloudTurnOn({ onTurnOn }: { onTurnOn(): void }) {
  const { t } = useI18n();
  return (
    <div className="stack" data-testid="browser-cloud-off">
      <p className="notice">{t('browser.cloud.intro')}</p>
      <button type="button" className="btn btn-primary" onClick={onTurnOn}>
        {t('browser.cloud.turnOn')}
      </button>
    </div>
  );
}

/** The browser-use policy, accepted once per person and profile (kept locally, not a secret). */
export function PolicyScreen({ call, onTurnOff }: { call: Call; onTurnOff?(): void }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    setError(null);
    const response = await call({ type: 'browser.policy.accept' });
    if (!response.ok) setError(response.code);
    setBusy(false);
  };
  return (
    <section className="browser-section stack" aria-labelledby="browser-policy-title" data-testid="browser-policy">
      <span className="section-label" id="browser-policy-title">
        {t('browser.policy.title')}
      </span>
      <ul className="browser-policy small">
        <li>{t('browser.policy.tab')}</li>
        <li>{t('browser.policy.ends')}</li>
        <li>{t('browser.policy.sensitive')}</li>
        <li>{t('browser.policy.confirm')}</li>
        <li>{t('browser.policy.data')}</li>
      </ul>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void accept()}>
        {t('browser.policy.accept')}
      </button>
      {onTurnOff ? (
        <button type="button" className="link small" onClick={onTurnOff}>
          {t('browser.cloud.turnOff')}
        </button>
      ) : null}
      <ErrorLine code={error} />
    </section>
  );
}

/** The session predates the `browser` OAuth scope: one click signs in again (the relay reconnects by itself). */
export function SignInAgain({ profileId }: { profileId: string }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    setBusy(true);
    setError(null);
    const response = await callBackground({ type: 'auth.signIn', profileId });
    if (!response.ok) setError(response.code);
    setBusy(false);
  };
  return (
    <section className="browser-section stack" data-testid="browser-sign-in-again">
      <p className="notice notice-warn">{t('error.browser_scope_required')}</p>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void signIn()}>
        {t('browser.signInAgain')}
      </button>
      <ErrorLine code={error} />
    </section>
  );
}

/** The workspace has browser use off: an owner/admin turns it on here; a member is told whom to ask. */
export function WorkspaceGate({ call }: { call: Call }) {
  const { t } = useI18n();
  const [canEnable, setCanEnable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void call({ type: 'browser.workspace.status' }).then((response) => {
      if (!live) return;
      if (response.ok) setCanEnable(response.workspace?.canEnable ?? false);
      else setError(response.code);
    });
    return () => {
      live = false;
    };
  }, [call]);

  const enable = async () => {
    setBusy(true);
    setError(null);
    const response = await call({ type: 'browser.workspace.enable' });
    if (!response.ok) {
      setError(response.code);
      if (response.code === 'admin_required') setCanEnable(false);
    }
    setBusy(false);
  };

  return (
    <section className="browser-section stack" aria-label={t('browser.workspace.off')} data-testid="browser-workspace-gate">
      <p className="notice notice-warn">{t('browser.workspace.off')}</p>
      {canEnable === null && !error ? <p className="muted small">{t('browser.workspace.checking')}</p> : null}
      {canEnable ? (
        <>
          <p className="muted small">{t('browser.workspace.enableHint')}</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void enable()}>
            {t('browser.workspace.enable')}
          </button>
        </>
      ) : null}
      {canEnable === false ? <p className="muted small">{t('browser.workspace.askAdmin')}</p> : null}
      <ErrorLine code={error} />
    </section>
  );
}

interface ActiveTab {
  id: number;
  url?: string;
}

/** The tab in front of the panel's window. Its URL is visible only once Chrome gave access to it (toolbar click or site access). */
function useActiveTab(): ActiveTab | null {
  const [tab, setTab] = useState<ActiveTab | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      void browser.tabs
        .query({ active: true, currentWindow: true })
        .then(([current]) => {
          if (live) setTab(current?.id !== undefined ? { id: current.id, url: current.url } : null);
        })
        .catch(() => undefined);
    };
    read();
    browser.tabs.onActivated.addListener(read);
    browser.tabs.onUpdated.addListener(read);
    return () => {
      live = false;
      browser.tabs.onActivated.removeListener(read);
      browser.tabs.onUpdated.removeListener(read);
    };
  }, []);
  return tab;
}

/** "Let the agent use this tab", for the agent of the current chat. */
export function ShareTab({ state, agent, call }: { state: PanelState; agent: Agent | undefined; call: Call }) {
  const { t } = useI18n();
  const tab = useActiveTab();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agentId = agent?.id ?? undefined;
  const agentName = agent ? agent.name || agent.key : '';
  const origin = tab?.url && !isRestrictedUrl(tab.url) ? urlOrigin(tab.url) : null;
  const shareable = origin !== null && isExactOrigin(origin);
  const shared = tab !== null && state.shares.some((share) => share.tabId === tab.id);

  const share = async () => {
    if (!tab || !origin || !agentId) return;
    setBusy(true);
    setError(null);
    try {
      // First await in the click: Chrome shows its site access prompt only during a user gesture.
      let granted = false;
      try {
        granted = await browser.permissions.request({ origins: [originPermissionPattern(origin)] });
      } catch {
        granted = false;
      }
      if (!granted) {
        setError('origin_permission_missing');
        return;
      }
      const response = await call({ type: 'browser.share.start', tabId: tab.id, agentId, agentName: agentName.slice(0, 200) });
      if (!response.ok) setError(response.code);
    } finally {
      setBusy(false);
    }
  };

  let hint: string;
  if (!agentId) hint = t('browser.share.noAgent');
  else if (!tab || !tab.url) hint = t('browser.share.unknownTab');
  else if (!shareable) hint = t('browser.share.restricted');
  else hint = t('browser.share.hint', { agent: agentName, domain: new URL(origin).host });

  return (
    <section className="browser-section stack" aria-label={t('browser.share.button')} data-testid="browser-share">
      {shared ? (
        <p className="muted small" role="status">
          {t('browser.share.current')}
        </p>
      ) : (
        <>
          <button type="button" className="btn btn-primary" disabled={busy || !agentId || !shareable} onClick={() => void share()} data-testid="browser-share-button">
            {t('browser.share.button')}
          </button>
          <p className="muted small">{hint}</p>
        </>
      )}
      <ErrorLine code={error} />
    </section>
  );
}

/** "Agent is using this tab · Stop", one line per shared tab. */
export function SharedTabs({ shares, call }: { shares: PanelState['shares']; call: Call }) {
  const { t, locale } = useI18n();
  if (!shares.length) return null;
  return (
    <ul className="browser-list" data-testid="browser-shares">
      {shares.map((share) => (
        <li key={share.grantId} className="browser-row small">
          <span className="browser-tab-marker" aria-hidden="true">
            AI
          </span>
          <span className="grow truncate" role="status">
            {t('browser.share.banner', { agent: share.agentName || t('browser.share.agent'), domain: share.domain })}
            {share.expiresAt ? <span className="muted"> · {t('browser.grant.until', { time: formatTime(locale, share.expiresAt) })}</span> : null}
          </span>
          <button type="button" className="btn btn-ghost small text-danger" onClick={() => void call({ type: 'browser.share.stop', grantId: share.grantId })}>
            <IconStop size={12} /> {t('browser.share.stop')}
          </button>
        </li>
      ))}
    </ul>
  );
}
