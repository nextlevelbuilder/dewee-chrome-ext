/**
 * Side panel root. Without a profile it shows the connect screen; with a profile that lost its
 * credential (expired, revoked, signed out) it asks to reconnect that same profile.
 */
import { useState } from 'react';
import type { DeweeApiError } from '@/api/errors';
import { clearCredential } from '@/auth/credential-store';
import { ConnectForm } from '@/shared/ConnectForm';
import { errorText, I18nContext, useI18n } from '@/shared/i18n';
import { BrandMark } from '@/shared/icons';
import { activeProfile } from '@/shared/settings';
import { useSettings } from '@/shared/use-settings';
import { ChatShell } from './ChatShell';
import './sidepanel.css';

function Welcome({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="welcome-page drum-texture">
      <div className="welcome">
        <div className="welcome-head">
          <BrandMark size={64} />
          <h1 className="brand-title">Dewee</h1>
          <p className="muted">{t('connect.intro')}</p>
        </div>
        <div className="welcome-card">{children}</div>
      </div>
    </div>
  );
}

export function App() {
  const { settings, connected, update, t, locale } = useSettings();
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const profile = settings ? activeProfile(settings) : undefined;

  // `useChat` reads this through a ref, so a new identity per render is harmless.
  const onAuthError = (error: DeweeApiError) => {
    if (!profile) return;
    setAuthNotice(error.code);
    // The credential no longer works for this profile; drop it so nothing keeps using it.
    void clearCredential(profile.id);
  };

  let body: React.ReactNode;
  if (!settings) {
    body = (
      <div className="welcome">
        <div className="skeleton" style={{ height: 120 }} />
      </div>
    );
  } else if (!profile) {
    body = (
      <Welcome>
        <ConnectForm onDone={() => setAuthNotice(null)} />
      </Welcome>
    );
  } else if (!connected.has(profile.id)) {
    body = (
      <Welcome>
        <p className="notice notice-warn" role="alert">
          {authNotice ? `${errorText(t, authNotice)} ` : ''}
          {profile.kind === 'gateway' ? t('connect.reconnectGateway') : t('connect.reconnectCloud')}
        </p>
        {settings.profiles.length > 1 ? (
          <select className="input" aria-label={t('header.profile')} value={profile.id} onChange={(e) => {
            const activeProfileId = e.target.value;
            void update((s) => ({ ...s, activeProfileId }));
          }}>
            {settings.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        <ConnectForm key={profile.id} reconnect={profile} onDone={() => setAuthNotice(null)} />
      </Welcome>
    );
  } else {
    body = <ChatShell key={profile.id} profile={profile} settings={settings} update={update} onAuthError={onAuthError} />;
  }

  return <I18nContext.Provider value={{ t, locale }}>{body}</I18nContext.Provider>;
}
