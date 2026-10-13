/** Conversations with the selected agent, newest first, plus "New chat". */
import type { Session } from '@/api/schemas';
import { errorText, useI18n } from '@/shared/i18n';
import { isApiError } from '@/api/errors';
import { IconPlus } from '@/shared/icons';
import type { LoadState } from '../use-directory';

export function SessionList({
  state,
  current,
  onSelect,
  onNew,
  onMore,
  canLoadMore,
  onRetry,
}: {
  state: LoadState<{ sessions: Session[]; total: number }>;
  current?: string;
  onSelect(key: string): void;
  onNew(): void;
  onMore(): void;
  /** False once the list shows as many conversations as the server returns in one page. */
  canLoadMore: boolean;
  onRetry(): void;
}) {
  const { t, locale } = useI18n();
  const sessions = state.data?.sessions ?? [];
  const date = (iso?: string) => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
    } catch {
      return '';
    }
  };
  return (
    <nav className="session-list" aria-label={t('sessions.title')}>
      <div className="session-list-head">
        <span className="section-label">{t('sessions.title')}</span>
        <button type="button" className="btn btn-ghost small" onClick={onNew}>
          <IconPlus size={14} /> {t('sessions.new')}
        </button>
      </div>
      {state.loading && !sessions.length ? <div className="skeleton" style={{ height: 48 }} /> : null}
      {state.error ? (
        <p className="notice notice-error">
          {errorText(t, isApiError(state.error) ? state.error.code : 'runtime_request_failed')}{' '}
          <button type="button" className="link" onClick={onRetry}>
            {t('app.retry')}
          </button>
        </p>
      ) : null}
      {!state.loading && !state.error && sessions.length === 0 ? <p className="muted small">{t('sessions.empty')}</p> : null}
      <ul>
        {sessions.map((s) => (
          <li key={s.key}>
            <button type="button" className={s.key === current ? 'session-item active' : 'session-item'} aria-current={s.key === current || undefined} onClick={() => onSelect(s.key)}>
              <span className="session-title truncate">{s.title || t('sessions.untitled')}</span>
              <span className="session-date">{date(s.updated_at)}</span>
            </button>
          </li>
        ))}
      </ul>
      {canLoadMore && state.data && state.data.total > sessions.length ? (
        <button type="button" className="btn btn-ghost small" onClick={onMore}>
          {t('sessions.more')}
        </button>
      ) : null}
    </nav>
  );
}
