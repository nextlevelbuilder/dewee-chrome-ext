/** Searchable agent picker (combobox + listbox) with Super Agent pinned first. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Agent } from '@/api/schemas';
import { SUPER_AGENT_KEY } from '@/shared/config';
import { useI18n } from '@/shared/i18n';

export function AgentPicker({ agents, value, onChange, disabled }: { agents: Agent[]; value?: string; onChange(key: string): void; disabled?: boolean }) {
  const { t } = useI18n();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = agents.find((a) => a.key === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? agents.filter((a) => `${a.name} ${a.key}`.toLowerCase().includes(q)) : agents;
  }, [agents, query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    inputRef.current?.focus();
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  function choose(agent: Agent | undefined) {
    if (!agent) return;
    onChange(agent.key);
    setOpen(false);
    setQuery('');
  }

  const isSuper = (a: Agent) => a.is_super || a.key === SUPER_AGENT_KEY;

  return (
    <div className="agent-picker" ref={rootRef}>
      <button
        type="button"
        className="btn picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('header.agent')}
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          setActive(0);
        }}
        data-testid="agent-picker"
      >
        <span className="truncate">{selected ? selected.name || selected.key : t('header.agent')}</span>
        {selected && isSuper(selected) ? <span className="pin" aria-hidden="true">★</span> : null}
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="popover">
          <input
            ref={inputRef}
            className="input"
            role="combobox"
            aria-controls={listId}
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
            placeholder={t('header.searchAgents')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(filtered[active]);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          <ul id={listId} role="listbox" className="listbox" aria-label={t('header.agent')}>
            {filtered.length === 0 ? <li className="muted small empty">{t('header.noAgents')}</li> : null}
            {filtered.map((agent, index) => (
              <li
                key={agent.key}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={agent.key === value}
                className={index === active ? 'option active' : 'option'}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(agent)}
              >
                <span className="truncate">
                  {agent.name || agent.key}
                  {isSuper(agent) ? <span className="badge">{t('header.superAgent')}</span> : null}
                </span>
                <span className="muted small mono truncate">{agent.key}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
