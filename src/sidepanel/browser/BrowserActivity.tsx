/**
 * What an agent is doing in this browser right now, with Pause/Resume/Stop always one click away,
 * and the approval cards for risky actions. Nothing is approved unless the person clicks "Allow
 * once"; closing the panel denies (the service worker does that when the port goes away).
 */
import type { PanelState } from '@/browser/panel-state';
import type { BackgroundResponse, BrowserRequest } from '@/protocol/messages';
import { hasMessage, useI18n, type Translate } from '@/shared/i18n';
import { IconPause, IconPlay, IconStop } from '@/shared/icons';

type Call = (request: BrowserRequest) => Promise<BackgroundResponse>;

/** Short local date and time; the raw value when it cannot be read. */
export function formatTime(locale: string, value: string | number): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeStyle: 'short', dateStyle: 'short' }).format(new Date(value));
  } catch {
    return String(value);
  }
}

/** The notice for a paused or stopped device; a pause the extension made on takeover says why. */
export function controlNotice(t: Translate, state: Pick<PanelState, 'control' | 'pauseReason'>): string {
  if (state.control === 'stopped') return t('browser.control.stopped');
  if (state.control === 'paused') return state.pauseReason === 'takeover' ? t('browser.control.takeover') : t('browser.control.paused');
  return '';
}

export function ControlButtons({ control, call }: { control: PanelState['control']; call: Call }) {
  const { t } = useI18n();
  return (
    <div className="browser-control-buttons">
      {control === 'active' ? (
        <button type="button" className="btn btn-ghost small" onClick={() => void call({ type: 'browser.control', state: 'paused' })}>
          <IconPause size={14} /> {t('browser.control.pause')}
        </button>
      ) : (
        <button type="button" className="btn btn-ghost small" onClick={() => void call({ type: 'browser.control', state: 'active' })}>
          <IconPlay size={14} /> {t('browser.control.resume')}
        </button>
      )}
      {control !== 'stopped' ? (
        <button type="button" className="btn btn-ghost small text-danger" onClick={() => void call({ type: 'browser.control', state: 'stopped' })}>
          <IconStop size={12} /> {t('browser.control.stop')}
        </button>
      ) : null}
    </div>
  );
}

export function ApprovalCards({ approvals, call }: { approvals: PanelState['approvals']; call: Call }) {
  const { t } = useI18n();
  if (!approvals.length) return null;
  return (
    <ul className="browser-approvals" aria-label={t('browser.approval.title')}>
      {approvals.map((approval) => (
        <li key={approval.id} className="action-card status-pending browser-approval" data-testid="browser-approval">
          <div className="action-card-head">
            <h3>{t('browser.approval.title')}</h3>
          </div>
          <p className="action-card-body">
            {t(`browser.approval.${approval.action}`, { agent: approval.agentName, target: approval.target || t('browser.approval.unnamed'), domain: approval.domain })}
            {approval.channel ? ` ${t('browser.approval.via', { channel: approval.channel })}` : ''}
          </p>
          {approval.preview !== undefined ? (
            <blockquote className="browser-approval-preview small" data-testid="browser-approval-preview">
              <span className="muted">{t('browser.approval.preview')}</span> {approval.preview || t('browser.approval.previewEmpty')}
            </blockquote>
          ) : null}
          <p className="muted small">{t('browser.approval.hint')}</p>
          <div className="card-actions">
            <button type="button" className="btn btn-primary small" onClick={() => void call({ type: 'browser.approval', id: approval.id, approve: true })}>
              {t('browser.approval.allow')}
            </button>
            <button type="button" className="btn small" onClick={() => void call({ type: 'browser.approval', id: approval.id, approve: false })}>
              {t('browser.approval.deny')}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The strip under the header: shown only while something is running, waiting for approval, paused or stopped. */
export function BrowserActivity({ state, call }: { state: PanelState; call: Call }) {
  const { t, locale } = useI18n();
  if (state.mode !== 'ready') return null;
  const { activity, control, approvals } = state;
  if (!activity && !approvals.length && control === 'active') return null;
  const actionKey = activity ? `browser.action.${activity.action}` : '';
  return (
    <section className="browser-activity" aria-label={t('browser.title')} data-testid="browser-activity">
      <div className="browser-activity-row">
        <p className="browser-activity-text small" role="status" aria-live="polite">
          {activity
            ? t('browser.activity', {
                agent: activity.agentName,
                channel: activity.channel ? t('browser.activity.via', { channel: activity.channel }) : '',
                action: hasMessage(actionKey) ? t(actionKey) : activity.action,
                domain: activity.domain,
              })
            : controlNotice(t, state)}
        </p>
        <ControlButtons control={control} call={call} />
      </div>
      {activity && activity.origins.length ? (
        <p className="browser-activity-scope muted small mono truncate" data-testid="browser-activity-scope">
          {t('browser.activity.scope', {
            origins: activity.origins.join(' '),
            until: activity.expiresAt ? t('browser.grant.until', { time: formatTime(locale, activity.expiresAt) }) : '',
          })}
        </p>
      ) : null}
      <ApprovalCards approvals={approvals} call={call} />
    </section>
  );
}
