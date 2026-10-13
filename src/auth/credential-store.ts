/**
 * Connection credentials (a self-hosted API key, or Cloud OAuth tokens), one record per profile.
 *
 * Default: `storage.session` (memory-backed, cleared when the browser closes, readable only by
 * extension pages and the service worker). With the profile's opt-in "remember on this device",
 * the record goes to `storage.local` instead; the UI discloses that trade-off. Never `sync`.
 * Clearing always removes the record from both areas so a logout cannot leave a copy behind.
 */
import { browser } from 'wxt/browser';
import { z } from 'zod';

const apiKeyCredential = z.object({ kind: z.literal('api_key'), apiKey: z.string().min(1) });
const oauthCredential = z.object({
  kind: z.literal('oauth'),
  accessToken: z.string().min(1),
  accessExpiresAt: z.number(),
  refreshToken: z.string().min(1),
  refreshExpiresAt: z.number().optional(),
  scope: z.string().optional(),
});
const credentialSchema = z.discriminatedUnion('kind', [apiKeyCredential, oauthCredential]);
export type Credential = z.infer<typeof credentialSchema>;
export type OAuthCredential = z.infer<typeof oauthCredential>;

export const credentialKey = (profileId: string) => `credential:${profileId}`;

export async function readCredential(profileId: string): Promise<Credential | null> {
  const key = credentialKey(profileId);
  const fromSession: unknown = (await browser.storage.session.get(key))[key];
  const value: unknown = fromSession ?? (await browser.storage.local.get(key))[key];
  const parsed = credentialSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function writeCredential(profileId: string, credential: Credential, remember: boolean): Promise<void> {
  const key = credentialKey(profileId);
  const value = credentialSchema.parse(credential);
  if (remember) {
    await browser.storage.local.set({ [key]: value });
    await browser.storage.session.remove(key);
  } else {
    await browser.storage.session.set({ [key]: value });
    await browser.storage.local.remove(key);
  }
}

export async function clearCredential(profileId: string): Promise<void> {
  const key = credentialKey(profileId);
  await Promise.all([browser.storage.session.remove(key), browser.storage.local.remove(key)]);
}
