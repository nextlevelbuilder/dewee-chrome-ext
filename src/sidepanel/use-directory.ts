/**
 * Workspaces, agents and sessions for the active profile. Super Agent is pinned first; a failed
 * load shows an error for that scope and never falls back to another workspace or profile.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DeweeClient } from '@/api/dewee-client';
import { isApiError, type DeweeApiError } from '@/api/errors';
import type { Agent, Session, Workspace } from '@/api/schemas';
import { SUPER_AGENT_KEY } from '@/shared/config';

export interface LoadState<T> {
  data: T | null;
  loading: boolean;
  error?: DeweeApiError | Error;
}

const idle = <T,>(): LoadState<T> => ({ data: null, loading: false });

export function sortAgents(agents: Agent[], superKey: string = SUPER_AGENT_KEY): Agent[] {
  const isSuper = (a: Agent) => a.is_super || a.key === superKey;
  return agents
    .filter((a) => a.status === 'active')
    .sort((a, b) => Number(isSuper(b)) - Number(isSuper(a)) || (a.name || a.key).localeCompare(b.name || b.key));
}

interface Settled<T> {
  /** Identifies the request this result belongs to; a result for an older request is ignored. */
  request: object;
  data: T | null;
  error?: DeweeApiError | Error;
}

/** `scope` names what is loaded (for example a workspace id); a new client or scope starts a new request. */
function useLoad<T>(client: DeweeClient | null, scope: string, load: (() => Promise<T>) | null, onAuthError: (error: DeweeApiError) => void): LoadState<T> & { reload(): void } {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [nonce, setNonce] = useState(0);
  // A fresh identity whenever the inputs change or a reload is asked for.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const request = useMemo(() => ({}), [client, scope, nonce]);
  useEffect(() => {
    if (!load) return;
    let live = true;
    load().then(
      (data) => {
        if (live) setSettled({ request, data });
      },
      (error: unknown) => {
        if (!live) return;
        if (isApiError(error) && error.status === 401) onAuthError(error);
        setSettled({ request, data: null, error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  if (!load) return { ...idle<T>(), reload };
  if (settled?.request !== request) return { data: null, loading: true, reload };
  return { data: settled.data, loading: false, error: settled.error, reload };
}

export function useWorkspaces(client: DeweeClient | null, onAuthError: (e: DeweeApiError) => void) {
  return useLoad<Workspace[]>(client, '', client ? () => client.workspaces() : null, onAuthError);
}

export function useAgents(client: DeweeClient | null, workspaceId: string | undefined, onAuthError: (e: DeweeApiError) => void) {
  return useLoad<Agent[]>(
    client,
    workspaceId ?? '',
    client && workspaceId ? async () => {
      const result = await client.agents(workspaceId);
      return sortAgents(result.agents, result.super_agent_key ?? SUPER_AGENT_KEY);
    } : null,
    onAuthError,
  );
}

export function useSessions(
  client: DeweeClient | null,
  workspaceId: string | undefined,
  agentKey: string | undefined,
  limit: number,
  onAuthError: (e: DeweeApiError) => void,
) {
  return useLoad<{ sessions: Session[]; total: number }>(
    client,
    JSON.stringify([workspaceId, agentKey, limit]),
    client && workspaceId && agentKey ? () => client.sessions(workspaceId, { agentKey, limit }) : null,
    onAuthError,
  );
}
