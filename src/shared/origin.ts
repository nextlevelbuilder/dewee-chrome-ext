/**
 * Gateway / Cloud origin validation. Only an origin is kept (no path, query, credentials or
 * fragment), HTTPS is required, and plain HTTP is accepted only for loopback hosts so local
 * development works; the UI warns whenever `insecure` is true.
 */
export type OriginCheck = { ok: true; origin: string; insecure: boolean } | { ok: false; reason: 'invalid' | 'https_required' | 'credentials_in_url' };

/** Exactly the HTTP hosts the manifest lists in optional_host_permissions; Chrome cannot grant others. */
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

export function checkOrigin(input: string): OriginCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  if (url.protocol === 'https:') return { ok: true, origin: url.origin, insecure: false };
  if (url.protocol === 'http:') {
    return isLoopbackHost(url.hostname) ? { ok: true, origin: url.origin, insecure: true } : { ok: false, reason: 'https_required' };
  }
  return { ok: false, reason: 'invalid' };
}

/** Match pattern for `chrome.permissions` covering exactly one origin (any port must be kept). */
export function originPermissionPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/*`;
}
