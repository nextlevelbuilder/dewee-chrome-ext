/** Message composer. Enter sends, Shift+Enter adds a line, Escape stops a running reply. */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '@/shared/i18n';
import { IconArrowUp, IconStop } from '@/shared/icons';

/** Tallest the box grows before it scrolls, in pixels. */
const MAX_HEIGHT = 200;

export const Composer = forwardRef<HTMLTextAreaElement, { agentName: string; busy: boolean; disabled?: boolean; /** False when the send was refused locally and nothing left; the text is then kept. */ onSend(text: string): boolean | void; onStop(): void }>(
  function Composer({ agentName, busy, disabled, onSend, onStop }, ref) {
    const { t } = useI18n();
    const [text, setText] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => inputRef.current as HTMLTextAreaElement);

    // Grow with the content, up to MAX_HEIGHT; shrink back when the text is sent or cleared.
    useLayoutEffect(() => {
      const el = inputRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    }, [text]);

    // Send and Stop are different buttons, and the box is disabled while a conversation loads; both
    // drop focus to the page. Put it back in the box once it can take focus again.
    const locked = busy || Boolean(disabled);
    const wasState = useRef({ busy, locked });
    useEffect(() => {
      const prev = wasState.current;
      wasState.current = { busy, locked };
      const changed = prev.busy !== busy || (prev.locked && !locked);
      if (changed && !disabled && document.activeElement === document.body) inputRef.current?.focus({ preventScroll: true });
    }, [busy, locked, disabled]);

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
        <div className="composer-box">
          <textarea
            ref={inputRef}
            className="composer-input"
            rows={1}
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
          {busy ? (
            <button type="button" className="composer-action stop" aria-label={t('chat.stop')} title={`${t('chat.stop')} (Esc)`} onClick={onStop}>
              <IconStop size={14} />
            </button>
          ) : (
            <button type="submit" className="composer-action" aria-label={t('chat.send')} title={t('chat.send')} disabled={disabled || !text.trim()}>
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
        <span id="composer-hint" className="composer-hint">
          {t('chat.composerHint')}
        </span>
      </form>
    );
  },
);
