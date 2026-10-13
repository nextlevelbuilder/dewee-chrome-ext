/** Builds the `DeweeClient` for a connection profile with the right base URL and auth adapter. */
import { callBackground } from '@/protocol/messages';
import type { Profile } from '@/shared/settings';
import { cloudBaseUrl, DeweeClient, gatewayBaseUrl, type AuthAdapter } from './dewee-client';
import { DeweeApiError } from './errors';

export function baseUrlFor(profile: Pick<Profile, 'kind' | 'origin'>): string {
  return profile.kind === 'cloud' ? cloudBaseUrl(profile.origin) : gatewayBaseUrl(profile.origin);
}

/** Pages ask the service worker for credentials so Cloud renewal stays single-flight. */
export function pageAuthAdapter(profileId: string): AuthAdapter {
  return {
    async authorization() {
      const result = await callBackground({ type: 'auth.authorization', profileId });
      if (result.ok && result.authorization) return result.authorization;
      if (result.ok || result.status === 401) throw new DeweeApiError(401, result.ok ? 'not_connected' : result.code, 'Not signed in');
      // A network error during renewal or an unavailable worker is not a sign-out: keep the
      // credential and report a transport failure the caller can retry.
      throw new DeweeApiError(result.status ?? 0, result.code, result.message ?? 'Could not get credentials');
    },
    async renew() {
      const result = await callBackground({ type: 'auth.renew', profileId });
      if (result.ok) return true;
      if (result.status === 401) return false;
      // Renewal could not reach the server: report that instead of the 401, so the caller keeps
      // the credential and can retry rather than signing the person out.
      throw new DeweeApiError(result.status ?? 0, result.code, result.message ?? 'Could not renew the session');
    },
  };
}

export function createClient(profile: Pick<Profile, 'kind' | 'origin'>, auth: AuthAdapter, fetchImpl?: typeof fetch): DeweeClient {
  return new DeweeClient({ baseUrl: baseUrlFor(profile), auth, fetch: fetchImpl });
}
