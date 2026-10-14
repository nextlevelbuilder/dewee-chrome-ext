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

/**
 * True when a granted host permission pattern names exactly this origin's host: same scheme, the
 * same host with no wildcard, any path, and either the same port or no port (Chrome then matches
 * every port of that host). Wildcard hosts (Ask Dewee's all-HTTPS pattern) and `<all_urls>` never count.
 */
export function patternCoversExactHost(pattern: string, origin: string): boolean {
  const match = /^(https?):\/\/([^/:*]+)(?::(\d+))?\/.*$/.exec(pattern);
  if (!match) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const [, scheme, host, port] = match;
  if (`${scheme}:` !== url.protocol || host?.toLowerCase() !== url.hostname.toLowerCase()) return false;
  if (port === undefined) return true;
  return port === (url.port || (url.protocol === 'https:' ? '443' : '80'));
}

/** Match pattern for `chrome.permissions` covering exactly one origin (any port must be kept). */
export function originPermissionPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}/*`;
}
