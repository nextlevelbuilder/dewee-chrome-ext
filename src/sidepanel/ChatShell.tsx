/**
 * Connected side panel: header (connection, workspace, agent, settings, online state), the
 * conversation list and the chat. Every request is scoped to the selected profile + workspace;
 * a failure is shown for that scope and never retried against another workspace or profile.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { createClient, pageAuthAdapter } from '@/api/client-factory';
import { isApiError, type DeweeApiError } from '@/api/errors';
import { useChat } from '@/chat/use-chat';
import type { RespondFn } from '@/credentials/respond-types';
import { callBackground } from '@/protocol/messages';
import { errorText, useI18n } from '@/shared/i18n';
import { BrandMark, IconCompose, IconSettings, IconSidebar } from '@/shared/icons';
import { withSelectedWorkspace, withWorkspaceSelection, workspaceSelectionOf, type Profile, type Settings } from '@/shared/settings';
import { AgentPicker } from './components/AgentPicker';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { SessionList } from './components/SessionList';
import { useAskDraft } from './use-ask-draft';
import { useAgents, useSessions, useWorkspaces } from './use-directory';

/** Largest limit the sessions endpoint accepts. */
const MAX_SESSION_LIMIT = 50;

function useOnline(): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function ChatShell({
  profile,
  settings,
  update,
  onAuthError,
}: {
  profile: Profile;
  settings: Settings;
  update(change: (s: Settings) => Settings): Promise<Settings>;
  onAuthError(error: DeweeApiError): void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  // Settings are re-read as new objects on every write (session key, theme, selection). Keying the
  // client on the connection itself keeps those writes from resetting lists and running chats.
  const { id: profileId, kind, origin } = profile;
  const client = useMemo(() => createClient({ kind, origin }, pageAuthAdapter(profileId)), [profileId, kind, origin]);
  const [showSessions, setShowSessions] = useState(false);
  const [sessionLimit, setSessionLimit] = useState(20);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the drawer has closed and the rest of the panel is no longer inert. */
  const drawerReturn = useRef<'toggle' | 'composer'>('toggle');
  const drawerWasOpen = useRef(false);

  const workspaces = useWorkspaces(client, onAuthError);
  const askDraft = useAskDraft();
  const { showReasoning, showToolDetails } = settings.prefs;
  const display = useMemo(() => ({ reasoning: showReasoning, toolDetails: showToolDetails }), [showReasoning, showToolDetails]);
  const remembered = settings.selections[profile.id]?.workspaceId;
  const workspaceList = workspaces.data ?? [];
  const workspace = workspaceList.find((w) => w.id === remembered) ?? (remembered ? undefined : workspaceList.find((w) => w.status === 'active') ?? workspaceList[0]);
  const workspaceId = workspace?.id;
  // A remembered workspace that is no longer listed is reported, not silently swapped.
  const workspaceMissing = Boolean(remembered && workspaces.data && !workspace);

  useEffect(() => {
    if (workspaceId && workspaceId !== remembered) void update((s) => withSelectedWorkspace(s, profile.id, workspaceId));
  }, [workspaceId, remembered, profile.id, update]);

  const agents = useAgents(client, workspace?.status === 'active' ? workspaceId : undefined, onAuthError);
  const selection = workspaceId ? workspaceSelectionOf(settings, profile.id, workspaceId) : { sessions: {} as Record<string, string> };
  const agentList = agents.data ?? [];
  const agent = agentList.find((a) => a.key === selection.agentKey) ?? agentList[0];
  const agentKey = agent?.key;
  const sessionKey = agentKey ? selection.sessions[agentKey] : undefined;
  const agentName = agent ? agent.name || agent.key : '';

  const sessions = useSessions(client, workspaceId, showSessions ? agentKey : undefined, sessionLimit, onAuthError);

  const setSession = useCallback(
    (key: string | undefined) => {
      if (!workspaceId || !agentKey) return;
      void update((s) =>
        withWorkspaceSelection(s, profile.id, workspaceId, (cur) => {
          const next = { ...cur.sessions };
          if (key) next[agentKey] = key;
          else delete next[agentKey];
          return { ...cur, agentKey, sessions: next };
        }),
      );
    },
    [workspaceId, agentKey, profile.id, update],
  );

  const chat = useChat(workspaceId && agentKey ? { client, profileId, workspaceId, agentKey, sessionKey } : null, {
    onSessionKey: (key) => setSession(key),
    onAuthError,
  });

  const respond: RespondFn = useCallback(
    async (card, body) => {
      if (!workspaceId) return { ok: false, code: 'not_found' };
      // Captured when the call starts: a profile or workspace switch during it must not re-tag the continuation.
      const scope = { profileId, workspaceId };
      // The conversation the card was answered in: a lost response rebuilds its continuation from
      // these, since the actions API does not return the continuation's target.
      const sessionKeyAtStart = chat.state.sessionKey;
      const agentKeyAtStart = agentKey;
      try {
        const result = await client.respond(workspaceId, card.id, body);
        chat.updateCard(result.action);
        void callBackground({ type: 'badge.refresh' });
        if (result.continuation) void chat.continueWith(result.continuation, scope);
        return { ok: true, result };
      } catch (error) {
        const apiError = isApiError(error) ? error : null;
        if (apiError?.status === 401) onAuthError(apiError);
        // Lost response or conflict: the server state decides. Reload the card instead of re-sending.
        if (apiError && (apiError.status === 0 || apiError.status === 409)) {
          try {
            const fresh = (await client.actions(workspaceId, { sessionKey: sessionKeyAtStart })).find((c) => c.id === card.id);
            if (fresh) {
              chat.updateCard(fresh);
              if (apiError.status === 0 && fresh.status === 'resolved') {
                if (sessionKeyAtStart && agentKeyAtStart) void chat.continueWith({ session_key: sessionKeyAtStart, agent_key: agentKeyAtStart, setup_action_id: card.id }, scope);
                return { ok: true, result: { action: fresh, replayed: true } };
              }
            }
          } catch {
            // Keep the original error below.
          }
        }
        return { ok: false, code: apiError?.code ?? 'runtime_request_failed', retryAfterSeconds: apiError?.retryAfterSeconds };
      }
    },
    [client, profileId, workspaceId, agentKey, chat, onAuthError],
  );

  const busy = chat.state.phase === 'streaming';
  // Without an agent there is no list to show; forget the request so the drawer does not reopen by itself later.
  if (showSessions && !agentKey) setShowSessions(false);
  const drawerOpen = showSessions && !!agentKey;
  const openDrawer = useCallback(() => setShowSessions(true), []);
  const closeDrawer = useCallback(() => {
    drawerReturn.current = 'toggle';
    setShowSessions(false);
  }, []);
  const newChat = useCallback(() => {
    setSession(undefined);
    drawerReturn.current = 'composer';
    setShowSessions(false);
    composerRef.current?.focus();
  }, [setSession]);

  // Focus can only move back once the panel has rendered without inert; focusing from the
  // click handler would land on an inert element and drop focus to the page body.
  useLayoutEffect(() => {
    if (drawerWasOpen.current && !drawerOpen) (drawerReturn.current === 'composer' ? composerRef : drawerToggleRef).current?.focus();
    drawerWasOpen.current = drawerOpen;
  }, [drawerOpen]);



  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && drawerOpen) {
        // Handled at the window so it still works after focus falls out of a re-rendered list.
        event.preventDefault();
        closeDrawer();
      } else if (event.altKey && (event.key === 'n' || event.key === 'N')) {
        event.preventDefault();
        // Same rule as the button: a running reply is stopped first, never abandoned.
        if (!busy) newChat();
      } else if (event.key === '/' && document.activeElement === document.body) {
        event.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newChat, busy, drawerOpen, closeDrawer]);

  const deweeUrl = workspaceId && profile.kind === 'cloud' ? `${profile.origin}/workspaces/${encodeURIComponent(workspaceId)}` : profile.origin;
  const profileOptions = settings.profiles;

  return (
    <div className="shell">
      {/* While the drawer is open the rest of the panel is inert, so focus and screen readers stay in it. */}
      <div className="shell-content" inert={drawerOpen || undefined}>
      <header className="shell-header">
        <div className="header-row">
          {agentKey ? (
            <button
              ref={drawerToggleRef}
              type="button"
              className="btn btn-ghost icon"
              aria-label={t('sessions.toggle')}
              title={t('sessions.toggle')}
              aria-expanded={drawerOpen}
              aria-controls="session-drawer"
              onClick={openDrawer}
            >
              <IconSidebar />
            </button>
          ) : null}
          <BrandMark size={26} />
          {profileOptions.length > 1 ? (
            <select
              className="input compact profile-select"
              aria-label={t('header.profile')}
              value={profile.id}
              onChange={(e) => {
                const id = e.target.value;
                void update((s) => ({ ...s, activeProfileId: id }));
              }}
            >
              {profileOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="profile-name truncate">{profile.name}</span>
          )}
          <span className={online ? 'status-dot online' : 'status-dot offline'} role="status" aria-label={online ? t('app.online') : t('app.offline')} title={online ? t('app.online') : t('app.offline')}>
            {/* Live regions announce content changes, not label changes. */}
            <span className="sr-only">{online ? t('app.online') : t('app.offline')}</span>
          </span>
          <span className="grow" />
          {agentKey ? (
            <button type="button" className="btn btn-ghost icon" aria-label={t('sessions.new')} title={`${t('sessions.new')} (Alt+N)`} onClick={newChat} disabled={busy}>
              <IconCompose />
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost icon" aria-label={t('app.settings')} title={t('app.settings')} onClick={() => void browser.runtime.openOptionsPage()}>
            <IconSettings />
          </button>
        </div>
        <div className="header-row header-controls">
          {workspaces.loading ? <div className="skeleton grow" style={{ height: 32 }} /> : null}
          {workspaceList.length ? (
            <select
              className="input compact grow"
              aria-label={t('header.workspace')}
              value={workspaceId ?? ''}
              onChange={(e) => {
                const id = e.target.value;
                void update((s) => withSelectedWorkspace(s, profile.id, id));
              }}
              data-testid="workspace-select"
            >
              {workspaceMissing ? <option value="">—</option> : null}
              {workspaceList.map((w) => (
                <option key={w.id} value={w.id} disabled={w.status !== 'active'}>
                  {w.name || w.id}
                  {w.status === 'suspended' ? ` (${t('header.workspaceSuspended')})` : w.status === 'not_ready' ? ` (${t('header.workspaceNotReady')})` : ''}
                </option>
              ))}
            </select>
          ) : null}
          {agentList.length ? (
            <AgentPicker
              agents={agentList}
              value={agentKey}
              disabled={busy}
              onChange={(key) => {
                if (!workspaceId) return;
                void update((s) => withWorkspaceSelection(s, profile.id, workspaceId, (cur) => ({ ...cur, agentKey: key })));
              }}
            />
          ) : null}
        </div>
        {workspaces.error ? (
          <p className="notice notice-error" role="alert">
            {errorText(t, isApiError(workspaces.error) ? workspaces.error.code : 'runtime_request_failed')}{' '}
            <button type="button" className="link" onClick={workspaces.reload}>
              {t('app.retry')}
            </button>
          </p>
        ) : null}
        {workspaces.data && workspaceList.length === 0 ? <p className="notice">{t('header.noWorkspaces')}</p> : null}
        {workspaceMissing ? <p className="notice notice-warn">{t('error.not_found')}</p> : null}
        {agents.error ? (
          <p className="notice notice-error" role="alert">
            {errorText(t, isApiError(agents.error) ? agents.error.code : 'runtime_request_failed')}{' '}
            <button type="button" className="link" onClick={agents.reload}>
              {t('app.retry')}
            </button>
          </p>
        ) : null}
        {agents.data && agentList.length === 0 ? <p className="notice">{t('header.noAgents')}</p> : null}
      </header>

      <main className="chat-main">
        {agentKey && workspaceId ? (
          <MessageList state={chat.state} agentName={agentName} respond={respond} deweeUrl={deweeUrl} display={display} onRetry={(message) => void chat.retry(message)} onLoadOlder={() => void chat.loadOlder()} onReload={() => void chat.reload()} onShowSessions={() => {
            sessions.reload();
            setShowSessions(true);
          }} />
        ) : agents.loading || workspaces.loading ? (
          <div className="stack pad">
            <div className="skeleton" style={{ height: 40 }} />
            <div className="skeleton" style={{ height: 64 }} />
          </div>
        ) : null}
      </main>

      {agentKey && workspaceId ? (
        <Composer
          ref={composerRef}
          agentName={agentName}
          busy={busy}
          draft={askDraft}
          disabled={chat.state.phase === 'reconciling' || chat.state.phase === 'loading'}
          onSend={(text) => chat.send(text)}
          onStop={() => void chat.stop()}
        />
      ) : null}
      </div>

      {drawerOpen ? (
        <div className="drawer" id="session-drawer" role="dialog" aria-modal="true" aria-label={t('sessions.title')}>
          <div className="drawer-scrim" aria-hidden="true" onClick={closeDrawer} />
          <SessionList
            state={sessions}
            current={sessionKey}
            busy={busy}
            onSelect={(key) => {
              setSession(key);
              drawerReturn.current = 'composer';
              setShowSessions(false);
            }}
            onNew={newChat}
            onClose={closeDrawer}
            onMore={() => setSessionLimit((n) => Math.min(n + 20, MAX_SESSION_LIMIT))}
            canLoadMore={sessionLimit < MAX_SESSION_LIMIT}
            onRetry={sessions.reload}
          />
        </div>
      ) : null}
    </div>
  );
}
