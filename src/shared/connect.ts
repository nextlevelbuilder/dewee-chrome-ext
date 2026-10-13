/**
 * Adding, verifying and removing connection profiles. Host access is requested per origin at
 * runtime (`optional_host_permissions`), never `<all_urls>`; the request must start inside the
 * click handler, so `requestOriginAccess` is the first call a UI handler makes.
 */
import { browser } from 'wxt/browser';
import { createClient, pageAuthAdapter } from '@/api/client-factory';
import { DeweeApiError, isApiError } from '@/api/errors';
import type { Me } from '@/api/schemas';
import { clearCredential, writeCredential } from '@/auth/credential-store';
import { callBackground } from '@/protocol/messages';
import { originPermissionPattern } from './origin';
import { loadSettings, newProfileId, updateSettings, withoutProfile, type Profile } from './settings';

export type ConnectResult = { ok: true; profile: Profile; me: Me } | { ok: false; code: string };

export async function requestOriginAccess(origin: string): Promise<boolean> {
  try {
    return await browser.permissions.request({ origins: [originPermissionPattern(origin)] });
  } catch {
    return false;
  }
}

function failure(error: unknown): { ok: false; code: string } {
  return { ok: false, code: isApiError(error) ? error.code : 'internal_error' };
}

async function saveProfile(profile: Profile): Promise<void> {
  await updateSettings((s) => ({
    ...s,
    profiles: s.profiles.some((p) => p.id === profile.id) ? s.profiles.map((p) => (p.id === profile.id ? profile : p)) : [...s.profiles, profile],
    activeProfileId: profile.id,
  }));
}

/** Verifies the key with `GET /me` before anything is stored; a rejected key is never saved. */
export async function connectGateway(input: { profileId?: string; name: string; origin: string; apiKey: string; remember: boolean }): Promise<ConnectResult> {
  const apiKey = input.apiKey.trim();
  const profile: Profile = { id: input.profileId ?? newProfileId(), name: input.name.trim() || new URL(input.origin).host, kind: 'gateway', origin: input.origin, remember: input.remember };
  const probe = createClient(profile, { authorization: async () => `Bearer ${apiKey}` });
  try {
    const me = await probe.me();
    if (me.auth.mode !== 'api_key') throw new DeweeApiError(400, 'invalid_response', 'Unexpected auth mode');
    await writeCredential(profile.id, { kind: 'api_key', apiKey }, profile.remember);
    try {
      await saveProfile(profile);
    } catch (error) {
      // Never leave a stored key without the profile that owns it.
      await clearCredential(profile.id);
      throw error;
    }
    void callBackground({ type: 'badge.refresh' });
    return { ok: true, profile, me };
  } catch (error) {
    return failure(error);
  }
}

/** Saves the profile, runs the OAuth flow in the service worker, then verifies with `GET /me`. */
export async function connectCloud(input: { profileId?: string; name: string; origin: string; remember: boolean }): Promise<ConnectResult> {
  const existing = input.profileId ? (await loadSettings()).profiles.find((p) => p.id === input.profileId) : undefined;
  const profile: Profile = existing
    ? { ...existing, remember: input.remember }
    : { id: newProfileId(), name: input.name.trim() || 'Dewee Cloud', kind: 'cloud', origin: input.origin, remember: input.remember };
  await saveProfile(profile);
  const signedIn = await callBackground({ type: 'auth.signIn', profileId: profile.id });
  if (!signedIn.ok) {
    if (!existing) await updateSettings((s) => withoutProfile(s, profile.id));
    return { ok: false, code: signedIn.code };
  }
  try {
    const me = await createClient(profile, pageAuthAdapter(profile.id)).me();
    return { ok: true, profile, me };
  } catch (error) {
    return failure(error);
  }
}

export async function verifyProfile(profile: Profile): Promise<{ ok: true; me: Me } | { ok: false; code: string }> {
  try {
    return { ok: true, me: await createClient(profile, pageAuthAdapter(profile.id)).me() };
  } catch (error) {
    return failure(error);
  }
}

/** Signs out (Cloud: revokes the token family) and clears the stored credential. */
export async function signOutProfile(profile: Profile): Promise<void> {
  const result = await callBackground({ type: 'auth.signOut', profileId: profile.id });
  if (!result.ok) await clearCredential(profile.id);
}

/** Removes the profile, its credential, remembered selections and host access. */
export async function removeProfile(profile: Profile): Promise<void> {
  await signOutProfile(profile);
  await updateSettings((s) => withoutProfile(s, profile.id));
  const remaining = (await loadSettings()).profiles.some((p) => p.origin === profile.origin);
  if (!remaining) {
    try {
      await browser.permissions.remove({ origins: [originPermissionPattern(profile.origin)] });
    } catch {
      // Permission may already be gone; nothing else to clean up.
    }
  }
}
