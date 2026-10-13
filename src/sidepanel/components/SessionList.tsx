/** Conversations with the selected agent, newest first, plus "New chat". Rendered inside the side drawer. */
import { useEffect, useRef } from 'react';
import type { Session } from '@/api/schemas';
import { errorText, useI18n } from '@/shared/i18n';
import { isApiError } from '@/api/errors';
import { IconClose, IconPlus } from '@/shared/icons';
import type { LoadState } from '../use-directory';

export function SessionList({
  state,
  current,
  busy,
  onSelect,
  onNew,
  onClose,
  onMore,
  canLoadMore,
  onRetry,
}: {
  state: LoadState<{ sessions: Session[]; total: number }>;
  current?: string;
  /** A reply is streaming: switching or starting a conversation would abandon it, so both wait. */
  busy: boolean;
  onSelect(key: string): void;
  onNew(): void;
  onClose(): void;
  onMore(): void;
  /** False once the list shows as many conversations as the server returns in one page. */
  canLoadMore: boolean;
  onRetry(): void;
}) {
  const { t, locale } = useI18n();
  const navRef = useRef<HTMLElement>(null);
  const sessions = state.data?.sessions ?? [];

  // Move focus into the drawer when it opens. The list is usually still loading at that point, so this is
  // normally "New chat"; the open conversation gets focus when the list was already loaded.
  useEffect(() => {
    const nav = navRef.current;
    (nav?.querySelector<HTMLElement>('[aria-current="true"]') ?? nav?.querySelector<HTMLElement>('.drawer-new'))?.focus();
  }, []);

  const date = (iso?: string) => {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
    } catch {
      return '';
    }
  };
  return (
    <nav ref={navRef} className="session-list" aria-label={t('sessions.title')}>
      <div className="session-list-head">
        <span className="section-label">{t('sessions.title')}</span>
        <button type="button" className="btn btn-ghost icon" aria-label={t('app.close')} title={`${t('app.close')} (Esc)`} onClick={onClose}>
          <IconClose />
        </button>
      </div>
      <button type="button" className="btn drawer-new" onClick={onNew} disabled={busy}>
        <IconPlus size={15} /> {t('sessions.new')}
      </button>
      <div className="session-scroll">
        {state.loading && !sessions.length ? (
          <div className="stack">
            <div className="skeleton" style={{ height: 36 }} />
            <div className="skeleton" style={{ height: 36 }} />
            <div className="skeleton" style={{ height: 36 }} />
          </div>
        ) : null}
        {state.error ? (
          <p className="notice notice-error">
            {errorText(t, isApiError(state.error) ? state.error.code : 'runtime_request_failed')}{' '}
            <button type="button" className="link" onClick={onRetry}>
              {t('app.retry')}
            </button>
          </p>
        ) : null}
        {!state.loading && !state.error && sessions.length === 0 ? <p className="muted small session-empty">{t('sessions.empty')}</p> : null}
        <ul>
          {sessions.map((s) => (
            <li key={s.key}>
              <button type="button" className={s.key === current ? 'session-item active' : 'session-item'} aria-current={s.key === current || undefined} disabled={busy} onClick={() => onSelect(s.key)}>
                <span className="session-title truncate">{s.title || t('sessions.untitled')}</span>
                <span className="session-date">{date(s.updated_at)}</span>
              </button>
            </li>
          ))}
        </ul>
        {canLoadMore && state.data && state.data.total > sessions.length ? (
          <button type="button" className="btn btn-ghost small session-more" onClick={onMore}>
            {t('sessions.more')}
          </button>
        ) : null}
      </div>
    </nav>
  );
}
