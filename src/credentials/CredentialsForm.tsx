/**
 * Secure credential form for `secret_request` cards. The only place a secret is typed:
 * - values live in this component's local state only (never app state, storage, messages, logs);
 * - they are cleared from state before the request is awaited, success or failure;
 * - they travel only in the body of `POST …/actions/{id}/respond`, never through chat;
 * - the destination is the Gateway-validated target, labelled from extension copy, not agent text.
 */
import { useId, useState, type FormEvent } from 'react';
import type { SecretRequestEnvelope } from '@/protocol/ui-action';
import { errorText, useI18n } from '@/shared/i18n';
import { fieldLabel, targetLabel } from './labels';
import type { RespondFn } from './respond-types';

type Values = Record<string, string>;

export function CredentialsForm({ card, respond, interactive }: { card: SecretRequestEnvelope; respond: RespondFn; interactive: boolean }) {
  const { t } = useI18n();
  const formId = useId();
  const { target, fields } = card.payload;
  const [values, setValues] = useState<Values>({});
  const [missing, setMissing] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Replacing a stored credential is an explicit step, so a stray card cannot look routine.
  const [rotating, setRotating] = useState(target.mode === 'create');
  // Typed identifiers the Gateway validates come before the free-form name the agent chose.
  const destination = targetLabel(t, target.type, target.provider_type ?? target.channel_type ?? target.binary_name ?? target.name);
  // A card that closes without a submit (expired, revoked, answered elsewhere) drops what was typed.
  // Done while rendering, so the closed card never commits with the values still in state.
  if (!interactive && (Object.keys(values).length > 0 || missing.length > 0)) {
    setValues({});
    setMissing([]);
  }

  const head = (
    <div className="secret-head">
      <p className="secret-destination">
        <span aria-hidden="true">🔒</span>{' '}
        {/* A card closed without an answer (cancelled, expired, failed) must not claim it saved anything. */}
        {t(interactive || card.status === 'resolved' ? 'secret.destination' : 'secret.destinationClosed', { target: destination })}
      </p>
      <p className="muted">{target.mode === 'update' ? t('secret.update') : t('secret.create')}</p>
    </div>
  );
  const errorLine = error ? (
    <p className="notice notice-error" role="alert">
      {error}
    </p>
  ) : null;
  // A refused answer (409) reloads the card as closed, so the reason must outlive the form.
  if (!interactive)
    return (
      <>
        {head}
        {errorLine}
      </>
    );

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const blank = fields.filter((f) => f.required && !(values[f.key] ?? '').trim()).map((f) => f.key);
    setMissing(blank);
    if (blank.length) return;
    const secret: Values = {};
    const response: Values = {};
    for (const field of fields) {
      const value = values[field.key] ?? '';
      if (!value) continue;
      if (field.kind === 'secret') secret[field.key] = value;
      else response[field.key] = value.trim();
    }
    // Drop the values before the request is in flight: the panel never holds them again.
    setValues({});
    setBusy(true);
    setError('');
    const outcome = await respond(card, { ...(Object.keys(response).length ? { response: { fields: response } } : {}), secret });
    setBusy(false);
    if (!outcome.ok) setError(errorText(t, outcome.code, outcome.retryAfterSeconds));
  }

  if (!rotating) {
    return (
      <>
        {head}
        <div className="card-actions">
          <button type="button" className="btn" onClick={() => setRotating(true)}>
            {t('secret.rotate')}
          </button>
        </div>
      </>
    );
  }

  return (
    <form className="card-form" onSubmit={(event) => void onSubmit(event)} autoComplete="off" noValidate aria-describedby={`${formId}-privacy`}>
      {head}
      {fields.map((field) => {
        const label = fieldLabel(t, field.key);
        const inputId = `${formId}-${field.key}`;
        const invalid = missing.includes(field.key);
        return (
          <label key={field.key} className="field" htmlFor={inputId}>
            <span>
              {label}
              {field.required ? ' *' : ''}
            </span>
            <input
              id={inputId}
              className="input"
              type={field.kind === 'secret' ? 'password' : 'text'}
              // "new-password" stops Chrome from offering saved site passwords for this field.
              autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              data-secret-field={field.kind === 'secret' ? 'true' : undefined}
              aria-required={field.required || undefined}
              aria-invalid={invalid || undefined}
              disabled={busy}
              value={values[field.key] ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                setValues((current) => ({ ...current, [field.key]: value }));
              }}
            />
            {invalid ? <span className="field-error">{t('secret.required', { label })}</span> : null}
          </label>
        );
      })}
      <p id={`${formId}-privacy`} className="muted small">
        {t('secret.privacy')}
      </p>
      {errorLine}
      <div className="card-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {t('secret.save')}
        </button>
      </div>
    </form>
  );
}
