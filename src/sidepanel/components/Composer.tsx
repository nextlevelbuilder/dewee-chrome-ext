/** Message composer. Enter sends, Shift+Enter adds a line, Escape stops a running reply. */
import { forwardRef, useState } from 'react';
import { useI18n } from '@/shared/i18n';

export const Composer = forwardRef<HTMLTextAreaElement, { agentName: string; busy: boolean; disabled?: boolean; /** False when the send was refused locally and nothing left; the text is then kept. */ onSend(text: string): boolean | void; onStop(): void }>(
  function Composer({ agentName, busy, disabled, onSend, onStop }, ref) {
    const { t } = useI18n();
    const [text, setText] = useState('');

    function submit() {
      const value = text.trim();
      if (!value || busy || disabled) return;
      if (onSend(value) === false) return;
      setText('');
    }

    return (
      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={ref}
          className="input composer-input"
          rows={2}
          maxLength={32_000}
          value={text}
          disabled={disabled}
          placeholder={t('chat.placeholder', { agent: agentName })}
          aria-label={t('chat.placeholder', { agent: agentName })}
          aria-describedby="composer-hint"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            } else if (event.key === 'Escape' && busy) {
              event.preventDefault();
              onStop();
            }
          }}
        />
        <div className="composer-row">
          <span id="composer-hint" className="muted small">
            {t('chat.composerHint')}
          </span>
          {busy ? (
            <button type="button" className="btn btn-danger" onClick={onStop}>
              ■ {t('chat.stop')}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={disabled || !text.trim()}>
              {t('chat.send')}
            </button>
          )}
        </div>
      </form>
    );
  },
);
