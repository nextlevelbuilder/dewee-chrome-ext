/**
 * Typed messages between extension pages (side panel, options) and the service worker. The
 * worker owns Cloud token renewal (single flight, so rotated refresh tokens are never replayed),
 * sign-in/out and the pending-action badge. Secret form values never travel over this channel:
 * the credential form posts them straight to the respond endpoint.
 */
import { z } from 'zod';
import { browser } from 'wxt/browser';

const profileRef = { profileId: z.string().min(1) };

export const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth.authorization'), ...profileRef }),
  z.object({ type: z.literal('auth.renew'), ...profileRef }),
  z.object({ type: z.literal('auth.signIn'), ...profileRef }),
  z.object({ type: z.literal('auth.signOut'), ...profileRef }),
  z.object({ type: z.literal('badge.refresh') }),
]);
export type BackgroundRequest = z.infer<typeof requestSchema>;

export type BackgroundResponse =
  | { ok: true; authorization?: string }
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
