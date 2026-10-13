/**
 * Options page: manage connection profiles (add, verify, use, sign out, remove) and client
 * preferences. Workspace settings stay in Dewee; these are only this browser's preferences.
 */
import { useState } from 'react';
import { ConnectForm } from '@/shared/ConnectForm';
import { removeProfile, signOutProfile, verifyProfile } from '@/shared/connect';
import { errorText, I18nContext, useI18n } from '@/shared/i18n';
import { BrandMark, IconLock, IconPlus } from '@/shared/icons';
import { localePrefs, themes, type Profile, type Settings as StoredSettings } from '@/shared/settings';
import { useSettings, type SettingsState } from '@/shared/use-settings';
import './options.css';

function ProfileRow({ profile, active, connected, update }: { profile: Profile; active: boolean; connected: boolean; update: SettingsState['update'] }) {
  const { t } = useI18n();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="profile-row" data-profile-kind={profile.kind}>
      <div className="profile-main">
        <div className="profile-title">
          <span className={connected ? 'conn-dot on' : 'conn-dot'} aria-hidden="true" />
          <strong className="truncate">{profile.name}</strong>
          {active ? <span className="badge">{t('settings.active')}</span> : null}
        </div>
        <span className="muted small block mono truncate">{profile.origin}</span>
        <span className="muted small block">
          {profile.kind === 'cloud' ? t('connect.cloud') : t('connect.selfHosted')}
          {connected ? (status ? ` · ${status}` : '') : ` · ${t('settings.notConnected')}`}
        </span>
      </div>
      <div className="profile-actions">
        {!active ? (
          <button type="button" className="btn small" disabled={busy} onClick={() => void update((s) => ({ ...s, activeProfileId: profile.id }))}>
            {t('settings.makeActive')}
          </button>
        ) : null}
        {connected ? (
          <>
            <button
              type="button"
              className="btn small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await verifyProfile(profile);
                  setStatus(result.ok ? t('settings.verified', { user: result.me.user.email || result.me.user.display_name || result.me.user.id }) : errorText(t, result.code));
                })
              }
            >
              {t('settings.verify')}
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => void run(() => signOutProfile(profile))}>
              {t('settings.signOut')}
            </button>
          </>
        ) : (
          <button type="button" className="btn small btn-primary" disabled={busy} onClick={() => setReconnecting((v) => !v)}>
            {profile.kind === 'cloud' ? t('connect.cloudSignIn') : t('connect.submit')}
          </button>
        )}
        <button
          type="button"
          className="btn small btn-danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(t('settings.removeConfirm'))) void run(() => removeProfile(profile));
          }}
        >
          {t('settings.remove')}
        </button>
      </div>
      {reconnecting && !connected ? <ConnectForm reconnect={profile} onDone={() => setReconnecting(false)} /> : null}
    </li>
  );
}

type BooleanPref = { [K in keyof StoredSettings['prefs']]: StoredSettings['prefs'][K] extends boolean ? K : never }[keyof StoredSettings['prefs']];

/** One on/off preference with its explanation, saved as soon as it changes. */
function PrefToggle({ pref, label, hint, settings, update }: { pref: BooleanPref; label: string; hint: string; settings: StoredSettings | null; update: SettingsState['update'] }) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={settings?.prefs[pref] ?? false}
        disabled={!settings}
        onChange={(e) => {
          const on = e.target.checked;
          void update((s) => ({ ...s, prefs: { ...s.prefs, [pref]: on } }));
        }}
      />
      <span>
        <span className="block">{label}</span>
        <span className="muted small block">{hint}</span>
      </span>
    </label>
  );
}

export function Settings() {
  const state = useSettings();
  const { settings, connected, update, t, locale } = state;
  const [adding, setAdding] = useState(false);

  return (
    <I18nContext.Provider value={{ t, locale }}>
      <main className="options">
        <header className="options-head">
          <BrandMark size={40} />
          <h1>{t('settings.title')}</h1>
        </header>
        <section aria-labelledby="profiles-heading">
          <div className="section-head">
            <h2 id="profiles-heading">{t('settings.profiles')}</h2>
            <button type="button" className="btn small" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
              <IconPlus size={14} /> {t('settings.addProfile')}
            </button>
          </div>
          {adding ? (
            <div className="panel">
              <ConnectForm onDone={() => setAdding(false)} />
            </div>
          ) : null}
          <ul className="profile-list">
            {settings?.profiles.map((profile) => (
              <ProfileRow key={profile.id} profile={profile} active={profile.id === (settings.activeProfileId ?? settings.profiles[0]?.id)} connected={connected.has(profile.id)} update={update} />
            ))}
          </ul>
        </section>
        <section aria-labelledby="prefs-heading">
          <h2 id="prefs-heading">{t('settings.preferences')}</h2>
          <div className="prefs panel">
            <label className="field">
              <span>{t('settings.theme')}</span>
              <select className="input" value={settings?.prefs.theme ?? 'system'} onChange={(e) => {
                  // Read the value now: the updater runs after an await, when React has reset the select.
                  const theme = e.target.value as (typeof themes)[number];
                  void update((s) => ({ ...s, prefs: { ...s.prefs, theme } }));
                }}>
                {themes.map((theme) => (
                  <option key={theme} value={theme}>
                    {t(`settings.theme.${theme}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('settings.language')}</span>
              <select className="input" value={settings?.prefs.locale ?? 'auto'} onChange={(e) => {
                  const locale = e.target.value as (typeof localePrefs)[number];
                  void update((s) => ({ ...s, prefs: { ...s.prefs, locale } }));
                }}>
                {localePrefs.map((value) => (
                  <option key={value} value={value}>
                    {value === 'auto' ? t('settings.language.auto') : value === 'vi' ? 'Tiếng Việt' : 'English'}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
        <section aria-labelledby="display-heading">
          <h2 id="display-heading">{t('settings.display')}</h2>
          <div className="panel stack">
            <PrefToggle pref="showReasoning" label={t('settings.showReasoning')} hint={t('settings.showReasoning.hint')} settings={settings} update={update} />
            <PrefToggle pref="showToolDetails" label={t('settings.showToolDetails')} hint={t('settings.showToolDetails.hint')} settings={settings} update={update} />
          </div>
          <p className="privacy muted small">
            <IconLock size={13} />
            {t('settings.privacy')}
          </p>
        </section>
      </main>
    </I18nContext.Provider>
  );
}
