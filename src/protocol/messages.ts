/**
 * Typed messages between extension pages (side panel, options) and the service worker. The
 * worker owns Cloud token renewal (single flight, so rotated refresh tokens are never replayed),
 * sign-in/out and the pending-action badge. Secret form values never travel over this channel:
 * the credential form posts them straight to the respond endpoint.
 */
import { z } from 'zod';
import { browser } from 'wxt/browser';
import type { Device } from '@/browser/protocol';

const profileRef = { profileId: z.string().min(1) };
const id = z.string().min(1).max(100);

export const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth.authorization'), ...profileRef }),
  z.object({ type: z.literal('auth.renew'), ...profileRef }),
  z.object({ type: z.literal('auth.signIn'), ...profileRef }),
  z.object({ type: z.literal('auth.signOut'), ...profileRef }),
  z.object({ type: z.literal('badge.refresh') }),
  // Connected browser (the worker re-validates every value against the relay contract before sending).
  z.object({ type: z.literal('browser.enroll'), name: z.string().max(80) }),
  z.object({ type: z.literal('browser.device.list') }),
  z.object({ type: z.literal('browser.device.rename'), deviceId: id, name: z.string().max(80) }),
  z.object({ type: z.literal('browser.device.revoke'), deviceId: id }),
  z.object({
    type: z.literal('browser.grant.create'),
    agentIds: z.array(id).max(20),
    origins: z.array(z.string().max(300)).max(20),
    capabilities: z.array(z.enum(['browser.read', 'browser.control'])).max(2),
    ttlSeconds: z.number().int(),
  }),
  z.object({ type: z.literal('browser.grant.revoke'), grantId: id }),
  z.object({ type: z.literal('browser.grant.refresh') }),
  z.object({ type: z.literal('browser.control'), state: z.enum(['active', 'paused', 'stopped']) }),
  z.object({ type: z.literal('browser.approval'), id, approve: z.boolean() }),
]);
export type BackgroundRequest = z.infer<typeof requestSchema>;
export type BrowserRequest = Extract<BackgroundRequest, { type: `browser.${string}` }>;

export type BackgroundResponse =
  | { ok: true; authorization?: string; devices?: Device[] }
  /** `status` is the HTTP-style status of the failure; absent means the worker could not answer. */
  | { ok: false; code: string; message?: string; status?: number };

/** Sends a request to the service worker; transport failures become `{ ok: false }`. */
export async function callBackground(request: BackgroundRequest): Promise<BackgroundResponse> {
  try {
    const response = (await browser.runtime.sendMessage(request)) as BackgroundResponse | undefined;
    return response ?? { ok: false, code: 'no_response' };
  } catch {
    return { ok: false, code: 'background_unavailable' };
  }
}
