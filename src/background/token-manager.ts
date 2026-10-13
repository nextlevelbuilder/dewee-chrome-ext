/**
 * Service-worker side of authentication. Cloud access tokens are renewed here only, one refresh
 * per profile at a time: concurrent callers share the in-flight promise, so a rotated refresh
 * token is never presented twice (which the server treats as replay and revokes the family).
 */
import { DeweeApiError, isApiError } from '@/api/errors';
import { clearCredential, readCredential, writeCredential, type Credential } from '@/auth/credential-store';
import { refreshCloudTokens, revokeCloudToken, signInWithCloud } from '@/auth/cloud-oauth';
import { loadSettings, type Profile } from '@/shared/settings';

const RENEW_MARGIN_MS = 60_000;
const inflight = new Map<string, Promise<Credential>>();

async function profileOf(profileId: string): Promise<Profile> {
  const profile = (await loadSettings()).profiles.find((p) => p.id === profileId);
  if (!profile) throw new DeweeApiError(404, 'profile_not_found', 'Connection profile not found');
  return profile;
}

async function credentialOf(profileId: string): Promise<Credential> {
  const credential = await readCredential(profileId);
  if (!credential) throw new DeweeApiError(401, 'not_connected', 'Not signed in');
  return credential;
}

/**
 * `seenRefreshToken` is the token the caller read. If a refresh finished after that read, the
 * stored token has already rotated and is returned as is: presenting the old one would be replay.
 */
function renew(profile: Profile, seenRefreshToken: string, fetchImpl: typeof fetch): Promise<Credential> {
  const running = inflight.get(profile.id);
  if (running) return running;
  const task = (async () => {
    try {
      const current = await credentialOf(profile.id);
      if (current.kind !== 'oauth' || current.refreshToken !== seenRefreshToken) return current;
      const next = await refreshCloudTokens(profile.origin, current.refreshToken, fetchImpl);
      await writeCredential(profile.id, next, profile.remember);
      return next as Credential;
    } catch (error) {
      // A rejected refresh (expired, revoked, replayed) ends the session; network errors do not.
      if (isApiError(error) && (error.status === 400 || error.status === 401 || error.status === 403)) {
        await clearCredential(profile.id);
        throw new DeweeApiError(401, 'token_revoked', 'Signed out: please sign in again');
      }
      throw error;
    } finally {
      inflight.delete(profile.id);
    }
  })();
  inflight.set(profile.id, task);
  return task;
}

/** `Authorization` header value for the profile, renewing a Cloud token close to expiry. */
export async function authorizationFor(profileId: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const credential = await credentialOf(profileId);
  if (credential.kind === 'api_key') return `Bearer ${credential.apiKey}`;
  if (credential.accessExpiresAt - RENEW_MARGIN_MS > now) return `Bearer ${credential.accessToken}`;
  const next = await renew(await profileOf(profileId), credential.refreshToken, fetchImpl);
  return `Bearer ${next.kind === 'oauth' ? next.accessToken : next.apiKey}`;
}

/** Forced renewal after a 401. API keys cannot be renewed: the profile needs a new key. */
export async function renewFor(profileId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const credential = await credentialOf(profileId);
  if (credential.kind === 'api_key') throw new DeweeApiError(401, 'api_key_rejected', 'The API key was rejected');
  await renew(await profileOf(profileId), credential.refreshToken, fetchImpl);
}

export async function signIn(profileId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const profile = await profileOf(profileId);
  if (profile.kind !== 'cloud') throw new DeweeApiError(400, 'invalid_request', 'Only Cloud profiles sign in with OAuth');
  const credential = await signInWithCloud(profile.origin, fetchImpl);
  await writeCredential(profile.id, credential, profile.remember);
}

/** Revokes the Cloud token family (best effort) and always clears local credentials. */
export async function signOut(profileId: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const credential = await readCredential(profileId);
  const profile = (await loadSettings()).profiles.find((p) => p.id === profileId);
  if (credential?.kind === 'oauth' && profile) await revokeCloudToken(profile.origin, credential.refreshToken, fetchImpl);
  await clearCredential(profileId);
}
