/**
 * Dewee Cloud side of the connected browser, called only from the service worker: the workspace
 * switch (status, enable) and the short-lived relay ticket the worker connects to the Gateway with.
 * Requests go to the Cloud BFF for the workspace the side panel chats in (the remembered selection),
 * with the profile's OAuth token (renewed single-flight by the token manager). Enable and ticket need
 * the `browser` OAuth scope: a session signed in before it existed is told to sign in again instead
 * of failing quietly. The ticket key is returned to the caller and never stored, cached or logged.
 */
import { createClient } from '@/api/client-factory';
import { DeweeApiError } from '@/api/errors';
import type { BrowserWorkspaceStatus, RelayTicket } from '@/api/schemas';
import { readCredential } from '@/auth/credential-store';
import { authorizationFor, renewFor } from '@/background/token-manager';
import { loadSettings } from '@/shared/settings';

export interface CloudRelayApi {
  ticket(profileId: string): Promise<RelayTicket>;
  status(profileId: string): Promise<BrowserWorkspaceStatus>;
  enable(profileId: string): Promise<boolean>;
}

export const BROWSER_SCOPE = 'browser';

/** True when the stored grant lacks the `browser` scope (an unknown scope list is left to the server). */
export async function lacksBrowserScope(profileId: string): Promise<boolean> {
  const credential = await readCredential(profileId);
  if (credential?.kind !== 'oauth' || credential.scope === undefined) return false;
  return !credential.scope.split(/\s+/).includes(BROWSER_SCOPE);
}

async function target(profileId: string, needsBrowserScope: boolean) {
  const settings = await loadSettings();
  const profile = settings.profiles.find((p) => p.id === profileId && p.kind === 'cloud');
  if (!profile) throw new DeweeApiError(400, 'invalid_request', 'Not a Dewee Cloud profile');
  const workspaceId = settings.selections[profileId]?.workspaceId;
  if (!workspaceId) throw new DeweeApiError(400, 'workspace_required', 'Pick a workspace in the side panel first');
  if (needsBrowserScope && (await lacksBrowserScope(profileId))) throw new DeweeApiError(403, 'browser_scope_required', 'Sign in again to allow browser use');
  const client = createClient(profile, {
    authorization: () => authorizationFor(profileId),
    renew: async () => {
      await renewFor(profileId);
      return true;
    },
  });
  return { client, workspaceId };
}

/** Server refusals for a missing scope, named the same as the local check. */
function scopeAware(error: unknown): never {
  if (error instanceof DeweeApiError && error.status === 403 && ['scope_required', 'insufficient_scope'].includes(error.code)) {
    throw new DeweeApiError(403, 'browser_scope_required', error.message);
  }
  throw error;
}

export const cloudRelayApi: CloudRelayApi = {
  ticket: async (profileId) => {
    const { client, workspaceId } = await target(profileId, true);
    return client.browserTicket(workspaceId).catch(scopeAware);
  },
  status: async (profileId) => {
    const { client, workspaceId } = await target(profileId, false);
    return client.browserStatus(workspaceId);
  },
  enable: async (profileId) => {
    const { client, workspaceId } = await target(profileId, true);
    return client.browserEnable(workspaceId).catch(scopeAware);
  },
};
