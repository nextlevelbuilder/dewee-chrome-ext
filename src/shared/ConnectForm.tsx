/**
 * Connect a Dewee Cloud account (OAuth PKCE) or a self-hosted Gateway (URL + personal API key).
 * The API key field is cleared as soon as the attempt starts; it is never echoed in errors.
 */
import { useId, useState, type FormEvent } from 'react';
import { DEFAULT_CLOUD_ORIGIN } from './config';
import { connectCloud, connectGateway, requestOriginAccess } from './connect';
import { errorText, useI18n } from './i18n';
import { checkOrigin } from './origin';
import type { Profile } from './settings';

type Mode = 'cloud' | 'gateway';

export function ConnectForm({ reconnect, onDone }: { reconnect?: Profile; onDone(profile: Profile): void }) {
  const { t } = useI18n();
  const id = useId();
  const [mode, setMode] = useState<Mode>(reconnect?.kind ?? 'cloud');
  const [name, setName] = useState(reconnect?.name ?? '');
  const [gatewayUrl, setGatewayUrl] = useState(reconnect?.kind === 'gateway' ? reconnect.origin : '');
  const [cloudUrl, setCloudUrl] = useState(reconnect?.kind === 'cloud' ? reconnect.origin : DEFAULT_CLOUD_ORIGIN);
  const [apiKey, setApiKey] = useState('');
  const [remember, setRemember] = useState(reconnect?.remember ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const urlInput = mode === 'gateway' ? gatewayUrl : cloudUrl;
  const check = urlInput ? checkOrigin(urlInput) : null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const origin = checkOrigin(urlInput);
    if (!origin.ok) {
      setError(t(`origin.${origin.reason}`));
      return;
    }
    // First call in the gesture: Chrome only shows the permission prompt during a user action.
    const granted = await requestOriginAccess(origin.origin);
    if (!granted) {
      setError(t('connect.permissionDenied'));
      return;
    }
    setBusy(true);
    const key = apiKey;
    setApiKey('');
    const result =
      mode === 'gateway'
        ? await connectGateway({ profileId: reconnect?.id, name, origin: origin.origin, apiKey: key, remember })
        : await connectCloud({ profileId: reconnect?.id, name, origin: origin.origin, remember });
    setBusy(false);
    if (result.ok) onDone(result.profile);
    else setError(errorText(t, result.code));
  }

  return (
    <form className="connect-form" onSubmit={(event) => void onSubmit(event)} autoComplete="off" noValidate>
      {reconnect ? null : (
        <div className="segmented" role="tablist" aria-label={t('connect.title')}>
          {(['cloud', 'gateway'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={mode === value ? 'segment active' : 'segment'}
              onClick={() => {
                setMode(value);
                setError('');
              }}
            >
              {value === 'cloud' ? t('connect.cloud') : t('connect.selfHosted')}
            </button>
          ))}
        </div>
      )}
      <p className="muted small">{mode === 'cloud' ? t('connect.cloudHint') : t('connect.selfHostedHint')}</p>

      {reconnect ? null : (
        <label className="field" htmlFor={`${id}-name`}>
          <span>{t('connect.name')}</span>
          <input id={`${id}-name`} className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={mode === 'cloud' ? 'Dewee Cloud' : 'My Gateway'} />
        </label>
      )}

      {mode === 'gateway' ? (
        <>
          <label className="field" htmlFor={`${id}-url`}>
            <span>{t('connect.gatewayUrl')}</span>
            <input id={`${id}-url`} className="input" type="url" inputMode="url" required value={gatewayUrl} readOnly={Boolean(reconnect)} placeholder="https://gateway.example.com" onChange={(e) => setGatewayUrl(e.target.value)} />
          </label>
          <label className="field" htmlFor={`${id}-key`}>
            <span>{t('connect.apiKey')}</span>
            <input
              id={`${id}-key`}
              className="input mono"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              required
              value={apiKey}
              disabled={busy}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <span className="muted small hint-code">{t('connect.apiKeyHint')}</span>
          </label>
        </>
      ) : reconnect ? null : (
        <details className="advanced">
          <summary className="small">Cloud URL</summary>
          <input aria-label="Cloud URL" className="input" type="url" value={cloudUrl} onChange={(e) => setCloudUrl(e.target.value)} />
        </details>
      )}

      {check?.ok && check.insecure ? (
        <p className="notice notice-warn" role="status">
          {t('connect.insecure')}
        </p>
      ) : null}

      <label className="checkbox">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>
          {t('connect.remember')}
          <span className="muted small block">{t('connect.rememberHint')}</span>
        </span>
      </label>

      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary" disabled={busy || (mode === 'gateway' && (!gatewayUrl || !apiKey))}>
        {busy ? t('app.loading') : mode === 'cloud' ? t('connect.cloudSignIn') : t('connect.submit')}
      </button>
    </form>
  );
}
