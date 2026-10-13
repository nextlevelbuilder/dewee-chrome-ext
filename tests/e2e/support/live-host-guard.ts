// Keeps the live specs on a local test stack. They send chats, mint and revoke API keys, delete
// agent policies and expire cards with the admin token, so a `.env` that points at a shared or
// production host must not run them by accident. Pure, so it is unit tested without Playwright.

/** True for http(s) URLs on localhost, 127.0.0.0/8 or [::1]. */
export function isLoopbackUrl(raw: string): boolean {
  let host: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    host = url.hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * The reason to skip when `url` (named by the env var `name`) is not loopback and
 * `E2E_ALLOW_REMOTE=1` is not set; null when the spec may run. The URL itself is not echoed.
 */
export function remoteHostRefusal(name: string, url: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!url || env.E2E_ALLOW_REMOTE === '1' || isLoopbackUrl(url)) return null;
  return `${name} is not a loopback host. The live specs run admin and mutating calls, so they only run against localhost, 127.0.0.1 or [::1]. Set E2E_ALLOW_REMOTE=1 to target a remote test stack on purpose.`;
}
