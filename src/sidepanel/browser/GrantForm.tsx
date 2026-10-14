/**
 * "Allow an agent to use this browser": agents, exact sites, read or read-and-act, and a time
 * limit. Chrome's site access is requested inside the click (a user gesture is required), before
 * anything is sent; if Chrome refuses, nothing is granted.
 */
import { useId, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Agent } from '@/api/schemas';
import { isRestrictedUrl } from '@/browser/policy';
import { GRANT_MAX_ORIGINS, isExactOrigin } from '@/browser/protocol';
import type { BackgroundResponse, BrowserRequest } from '@/protocol/messages';
import { errorText, useI18n, type Translate } from '@/shared/i18n';
import { checkOrigin, originPermissionPattern } from '@/shared/origin';

const TTL_OPTIONS = [900, 3600, 14400, 28800] as const;
type Ttl = (typeof TTL_OPTIONS)[number];

/** Parses one site per line into exact origins, or explains the first problem. */
export function parseOrigins(text: string, t: Translate): { ok: true; origins: string[] } | { ok: false; error: string } {
  const lines = text
    .split(/[\s,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return { ok: false, error: t('browser.allow.originsRequired') };
  const origins: string[] = [];
  for (const line of lines) {
    const checked = checkOrigin(line);
    // An exact site: no wildcard, path, query or fragment beyond an optional trailing slash.
    if (!checked.ok || !isExactOrigin(checked.origin) || line.replace(/\/$/, '').toLowerCase() !== checked.origin.toLowerCase()) return { ok: false, error: t('browser.allow.originInvalid', { origin: line }) };
    if (isRestrictedUrl(checked.origin)) return { ok: false, error: t('browser.allow.originRestricted', { origin: line }) };
    if (!origins.includes(checked.origin)) origins.push(checked.origin);
  }
  if (origins.length > GRANT_MAX_ORIGINS) return { ok: false, error: t('browser.allow.tooMany') };
  return { ok: true, origins };
}

export function GrantForm({ agents, call }: { agents: Agent[]; call(request: BrowserRequest): Promise<BackgroundResponse> }) {
  const { t } = useI18n();
  const id = useId();
  const grantable = agents.filter((agent): agent is Agent & { id: string } => typeof agent.id === 'string' && agent.id.length > 0);
  const [picked, setPicked] = useState<string[]>([]);
  const [originsText, setOriginsText] = useState('');
  const [control, setControl] = useState(false);
  const [ttl, setTtl] = useState<Ttl>(3600);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    const agentIds = picked.filter((agentId) => grantable.some((agent) => agent.id === agentId));
    if (!agentIds.length) {
      setError(t('browser.allow.pickAgent'));
      return;
    }
    const parsed = parseOrigins(originsText, t);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      // First await in the click: Chrome only shows its permission prompt during a user gesture.
      let granted = false;
      try {
        granted = await browser.permissions.request({ origins: parsed.origins.map(originPermissionPattern) });
      } catch {
        granted = false;
      }
      if (!granted) {
        setError(t('browser.allow.permissionDenied'));
        return;
      }
      const response = await call({
        type: 'browser.grant.create',
        agentIds,
        origins: parsed.origins,
        capabilities: control ? ['browser.read', 'browser.control'] : ['browser.read'],
        ttlSeconds: ttl,
      });
      if (!response.ok) {
        setError(errorText(t, response.code));
        return;
      }
      setPicked([]);
      setOriginsText('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="browser-grant-form"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <span className="section-label" id={`${id}-title`}>
        {t('browser.allow')}
      </span>
      <fieldset className="browser-fieldset">
        <legend className="small muted">{t('browser.allow.agents')}</legend>
        {grantable.length ? (
          grantable.map((agent) => (
            <label key={agent.id} className="checkbox">
              <input
                type="checkbox"
                checked={picked.includes(agent.id)}
                onChange={(event) => setPicked((current) => (event.target.checked ? [...current, agent.id] : current.filter((value) => value !== agent.id)))}
              />
              <span className="truncate">{agent.name || agent.key}</span>
            </label>
          ))
        ) : (
          <p className="muted small">{t('browser.allow.noAgents')}</p>
        )}
      </fieldset>
      <label className="field">
        <span>{t('browser.allow.origins')}</span>
        <textarea
          className="input mono"
          rows={3}
          value={originsText}
          placeholder="https://example.com"
          spellCheck={false}
          autoCapitalize="off"
          aria-describedby={`${id}-origins-hint`}
          onChange={(event) => setOriginsText(event.target.value)}
        />
        <span className="muted small" id={`${id}-origins-hint`}>
          {t('browser.allow.originsHint')}
        </span>
      </label>
      <fieldset className="browser-fieldset">
        <legend className="small muted">{t('browser.allow.capability')}</legend>
        <label className="checkbox">
          <input type="radio" name={`${id}-capability`} checked={!control} onChange={() => setControl(false)} />
          <span>{t('browser.allow.read')}</span>
        </label>
        <label className="checkbox">
          <input type="radio" name={`${id}-capability`} checked={control} onChange={() => setControl(true)} />
          <span>{t('browser.allow.control')}</span>
        </label>
      </fieldset>
      <label className="field">
        <span>{t('browser.allow.ttl')}</span>
        <select className="input compact" value={ttl} onChange={(event) => setTtl(Number(event.target.value) as Ttl)}>
          {TTL_OPTIONS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {t(`browser.allow.ttl.${seconds}`)}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={busy || !grantable.length}>
        {t('browser.allow.submit')}
      </button>
    </form>
  );
}
