/** Conversation transcript: sanitized Markdown, tool activity, inline cards and error recovery. */
import { memo, useEffect, useRef } from 'react';
import type { ChatMessage, ChatState } from '@/chat/chat-state';
import { looseCards } from '@/chat/chat-state';
import { ActionCard } from '@/credentials/ActionCard';
import type { RespondFn } from '@/credentials/respond-types';
import { errorText, hasMessage, useI18n } from '@/shared/i18n';
import { BrandMark } from '@/shared/icons';
import { renderMarkdown } from '@/shared/markdown';
import type { UiActionCard } from '@/protocol/ui-action';

const Markdown = memo(function Markdown({ text }: { text: string }) {
  // Sanitized by DOMPurify in renderMarkdown; agent HTML never reaches the DOM unsanitized.
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
});

/** What a failed message can do next: send again, reload the conversation or show the conversation list. */
interface Recovery {
  onRetry(message: ChatMessage): void;
  onReload(): void;
  onShowSessions(): void;
}

function MessageError({ message, onRetry, onReload, onShowSessions }: { message: ChatMessage } & Recovery) {
  const { t } = useI18n();
  const error = message.error;
  if (!error) return null;
  const recoveryKey = error.action ? `recovery.${error.action}` : '';
  const text = hasMessage(recoveryKey) ? t(recoveryKey) : errorText(t, error.code, error.retryAfterSeconds);
  return (
    <div className="notice notice-error message-error" role="alert">
      <span>{text}</span>
      {message.retryText || message.retryContinuation ? (
        <button type="button" className="btn small" onClick={() => onRetry(message)}>
          {t(message.retryContinuation ? 'chat.continue' : 'chat.retryMessage')}
        </button>
      ) : message.recover === 'reload' ? (
        <button type="button" className="btn small" onClick={onReload}>
          {t('chat.reloadConversation')}
        </button>
      ) : message.recover === 'sessions' ? (
        <button type="button" className="btn small" onClick={onShowSessions}>
          {t('chat.showConversations')}
        </button>
      ) : null}
    </div>
  );
}

function MessageItem({ message, cards, respond, deweeUrl, ...recovery }: { message: ChatMessage; cards: UiActionCard[]; respond: RespondFn; deweeUrl?: string } & Recovery) {
  const { t } = useI18n();
  const own = cards.filter((c) => message.cardIds?.includes(c.id));
  return (
    <li className={`message message-${message.role}`} aria-busy={message.streaming || undefined}>
      {message.tools?.length ? (
        <ul className="tool-list" aria-label="tools">
          {message.tools.map((tool) => (
            <li key={tool.id} className={`tool tool-${tool.state}`}>
              <span className="tool-dot" aria-hidden="true" />
              {t(tool.state === 'running' ? 'chat.tool.running' : tool.state === 'error' ? 'chat.tool.error' : 'chat.tool.done', { name: tool.name })}
              {tool.viaAgent ? <span className="muted"> · {t('chat.viaAgent', { agent: tool.viaAgent })}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {message.thinking && message.streaming && !message.content ? <p className="muted small thinking">{t('chat.thinking')}…</p> : null}
      {message.role === 'assistant' ? (
        message.content ? (
          <Markdown text={message.content} />
        ) : message.streaming ? (
          <span className="typing" role="img" aria-label={t('app.loading')}>
            <span />
            <span />
            <span />
          </span>
        ) : null
      ) : (
        <p className="plain">{message.content}</p>
      )}
      {own.map((card) => (
        <ActionCard key={card.id} card={card} respond={respond} deweeUrl={deweeUrl} />
      ))}
      {message.stopped ? <p className="muted small">{t('chat.stopped')}</p> : null}
      <MessageError message={message} {...recovery} />
    </li>
  );
}

export function MessageList({
  state,
  agentName,
  respond,
  deweeUrl,
  onRetry,
  onLoadOlder,
  onReload,
  onShowSessions,
}: {
  state: ChatState;
  agentName: string;
  respond: RespondFn;
  deweeUrl?: string;
  onLoadOlder(): void;
} & Recovery) {
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // "Send again", "Continue" and "Reload" remove their own button, so focus moves to the
  // conversation instead of falling back to the page.
  const retry = (message: ChatMessage) => {
    logRef.current?.focus();
    onRetry(message);
  };
  const reload = () => {
    logRef.current?.focus();
    onReload();
  };
  const last = state.messages.at(-1);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [state.messages.length, last?.content.length, state.cards.length]);

  const loose = looseCards(state);
  return (
    <div ref={logRef} tabIndex={-1} className="messages" role="log" aria-live="polite" aria-relevant="additions text">
      {state.hiddenBefore > 0 ? (
        <button type="button" className="btn btn-ghost small older" onClick={onLoadOlder}>
          {t('chat.olderMessages')}
        </button>
      ) : null}
      {state.phase === 'loading' ? (
        <div className="stack">
          <div className="skeleton" style={{ height: 40 }} />
          <div className="skeleton" style={{ height: 64 }} />
        </div>
      ) : null}
      {state.loadError ? (
        <p className="notice notice-error" role="alert">
          {t('chat.historyFailed')}{' '}
          <button type="button" className="link" onClick={reload}>
            {t('app.retry')}
          </button>
        </p>
      ) : null}
      {state.phase !== 'loading' && state.messages.length === 0 && loose.length === 0 && !state.loadError ? (
        <div className="empty-state">
          <BrandMark size={56} />
          <p className="empty-title">{t('chat.empty', { agent: agentName })}</p>
        </div>
      ) : null}
      <ul className="message-list">
        {state.messages.slice(state.hiddenBefore).map((message) => (
          <MessageItem key={message.id} message={message} cards={state.cards} respond={respond} deweeUrl={deweeUrl} onRetry={retry} onReload={reload} onShowSessions={onShowSessions} />
        ))}
      </ul>
      {loose.map((card) => (
        <ActionCard key={card.id} card={card} respond={respond} deweeUrl={deweeUrl} />
      ))}
      {state.phase === 'reconciling' ? (
        <p className="notice" role="status">
          {state.offline ? t('chat.offlineWaiting') : t('chat.reconciling')}
        </p>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
