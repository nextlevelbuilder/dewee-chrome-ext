/**
 * Renders one validated `dewee.ui-action.v1` card from a fixed list of kinds. Agent text (title,
 * body) is shown as plain text, never as HTML or Markdown. Kinds answered through other Dewee
 * routes (approvals, uploads) are shown read-only with a pointer to Dewee.
 */
import { useState } from 'react';
import { isUiActionOpen, type UiActionCard, type UiActionPayloadByKind } from '@/protocol/ui-action';
import { errorText, useI18n } from '@/shared/i18n';
import { CredentialsForm } from './CredentialsForm';
import type { RespondFn } from './respond-types';

interface CardProps {
  card: UiActionCard;
  respond: RespondFn;
  /** Web page where the person can finish steps the panel does not cover, if known. */
  deweeUrl?: string;
}

function useRespond(card: UiActionCard, respond: RespondFn) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(body: Parameters<RespondFn>[1]) {
    if (busy) return false;
    setBusy(true);
    setError('');
    const outcome = await respond(card, body);
    setBusy(false);
    if (!outcome.ok) setError(errorText(t, outcome.code, outcome.retryAfterSeconds));
    return outcome.ok;
  }
  return { busy, error, submit };
}

function ErrorLine({ message }: { message: string }) {
  return message ? (
    <p className="notice notice-error" role="alert">
      {message}
    </p>
  ) : null;
}

function ChoiceCard({ card, respond }: CardProps & { card: Extract<UiActionCard, { kind: 'choice_request' }> }) {
  const { t } = useI18n();
  const payload: UiActionPayloadByKind['choice_request'] = card.payload;
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const { busy, error, submit } = useRespond(card, respond);

  async function send(ids: string[]) {
    const response: Record<string, unknown> = {};
    if (ids.length) response.selected = payload.options.map((o) => o.id).filter((id) => ids.includes(id));
    if (freeText.trim()) response.free_text = freeText.trim();
    if (await submit({ response })) setFreeText('');
  }

  return (
    <div className="card-form">
      <div className="choice-list" role={payload.multi ? 'group' : undefined}>
        {payload.options.map((option) =>
          payload.multi ? (
            <label key={option.id} className="choice-option">
              <input
                type="checkbox"
                checked={selected.includes(option.id)}
                disabled={busy}
                onChange={(event) =>
                  setSelected((current) => (event.target.checked ? [...current, option.id] : current.filter((id) => id !== option.id)))
                }
              />
              <span>
                <strong>{option.label}</strong>
                {option.description ? <span className="muted small block">{option.description}</span> : null}
              </span>
            </label>
          ) : (
            <button key={option.id} type="button" className="btn choice-button" disabled={busy} onClick={() => void send([option.id])}>
              <strong>{option.label}</strong>
              {option.description ? <span className="muted small block">{option.description}</span> : null}
            </button>
          ),
        )}
      </div>
      {payload.allow_free_text ? (
        <label className="field">
          <span>{t('choice.freeText')}</span>
          <input className="input" value={freeText} maxLength={500} disabled={busy} onChange={(event) => setFreeText(event.target.value)} />
        </label>
      ) : null}
      <ErrorLine message={error} />
      {payload.multi || payload.allow_free_text ? (
        <div className="card-actions">
          <button type="button" className="btn btn-primary" disabled={busy || (!selected.length && !freeText.trim())} onClick={() => void send(selected)}>
            {t('card.submit')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function OAuthCard({ card, respond, deweeUrl }: CardProps & { card: Extract<UiActionCard, { kind: 'oauth_request' }> }) {
  const { t } = useI18n();
  const { busy, error, submit } = useRespond(card, respond);
  const provider = card.payload.provider;
  const notCompleted = card.result?.error_code === 'oauth_not_completed';
  return (
    <div className="card-form">
      <p className="muted small">{t('oauth.thirdParty', { provider })}</p>
      {notCompleted && !error ? <p className="notice notice-warn">{t('oauth.notCompleted')}</p> : null}
      <ErrorLine message={error} />
      <div className="card-actions">
        {deweeUrl ? (
          <a className="btn" href={deweeUrl} target="_blank" rel="noopener noreferrer">
            {t('oauth.openDewee')}
          </a>
        ) : null}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit({})}>
          {t('oauth.check')}
        </button>
      </div>
    </div>
  );
}

function DecisionCard({ card, respond, decisions }: CardProps & { decisions: { value: string; label: string; primary?: boolean }[] }) {
  const { busy, error, submit } = useRespond(card, respond);
  return (
    <div className="card-form">
      <ErrorLine message={error} />
      <div className="card-actions">
        {decisions.map((d) => (
          <button key={d.value} type="button" className={d.primary ? 'btn btn-primary' : 'btn'} disabled={busy} onClick={() => void submit({ response: { decision: d.value } })}>
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function CardBody({ card, respond, deweeUrl }: CardProps) {
  const { t } = useI18n();
  const open = isUiActionOpen(card);
  switch (card.kind) {
    case 'secret_request':
      return <CredentialsForm card={card} respond={respond} interactive={open} />;
    case 'choice_request':
      return open ? <ChoiceCard card={card} respond={respond} /> : null;
    case 'oauth_request':
      return open ? <OAuthCard card={card} respond={respond} deweeUrl={deweeUrl} /> : null;
    case 'command_preview':
      return (
        <>
          <pre className="command-preview">{card.payload.command.join(' ')}</pre>
          {card.payload.description ? <p className="muted small">{card.payload.description}</p> : null}
          {open && card.payload.policy_outcome !== 'blocked' ? (
            <DecisionCard
              card={card}
              respond={respond}
              decisions={[
                { value: 'confirm', label: t('card.confirm'), primary: true },
                { value: 'cancel', label: t('app.cancel') },
              ]}
            />
          ) : null}
        </>
      );
    case 'setup_progress': {
      const { completed, total } = card.payload;
      return (
        <progress className="progress" max={Math.max(total, 1)} value={completed} aria-label={`${completed}/${total}`}>
          {completed}/{total}
        </progress>
      );
    }
    case 'plan_review':
    case 'permission_request':
    case 'install_request':
    case 'upload_request':
    case 'connection_test':
    case 'handoff':
      return open ? (
        <p className="muted small">
          {t('card.openInDewee')}{' '}
          {deweeUrl ? (
            <a href={deweeUrl} target="_blank" rel="noopener noreferrer">
              Dewee ↗
            </a>
          ) : null}
        </p>
      ) : null;
  }
}

function formatTime(iso: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function ActionCard(props: CardProps) {
  const { t, locale } = useI18n();
  const { card } = props;
  const expired = card.status === 'pending' && !isUiActionOpen(card);
  const status = expired ? 'expired' : card.status;
  return (
    <section className={`action-card status-${status}`} aria-label={card.title} data-kind={card.kind} data-card-id={card.id}>
      <header className="action-card-head">
        <h3>{card.title}</h3>
        <span className={`status-pill status-pill-${status}`}>{t(`card.status.${status}`)}</span>
      </header>
      {card.body ? <p className="action-card-body">{card.body}</p> : null}
      <CardBody {...props} />
      {status === 'resolved' && card.kind === 'secret_request' ? <p className="notice">{t('secret.saved')}</p> : null}
      {status === 'pending' ? <p className="muted small">{t('card.expires', { time: formatTime(card.expires_at, locale) })}</p> : null}
    </section>
  );
}
