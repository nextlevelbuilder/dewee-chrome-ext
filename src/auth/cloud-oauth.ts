/**
 * Dewee Cloud sign-in: Authorization Code + PKCE S256 through `chrome.identity.launchWebAuthFlow`,
 * then token exchange, rotation and revocation against the Extension OAuth client
 * (docs/api-contract.md, "Cloud authentication"). Tokens never appear in URLs or logs.
 */
import { browser } from 'wxt/browser';
import { DeweeApiError, errorFromResponse } from '@/api/errors';
import { cloudBaseUrl } from '@/api/dewee-client';
import { tokenResponse, type TokenResponse } from '@/api/schemas';
import { OAUTH_CLIENT_ID, OAUTH_SCOPE } from '@/shared/config';
import type { OAuthCredential } from './credential-store';
import { codeChallengeS256, createCodeVerifier, randomToken, safeEqual } from './pkce';

export function redirectUri(): string {
  return browser.identity.getRedirectURL('oauth2');
}

export function buildAuthorizeUrl(origin: string, params: { challenge: string; state: string; redirect: string }): string {
  const url = new URL('/oauth/extension/authorize', origin);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: params.redirect,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
    scope: OAUTH_SCOPE,
  }).toString();
  return url.toString();
}

/** Extracts the code from the redirect, rejecting a state mismatch or an error response. */
export function parseRedirect(responseUrl: string, expectedState: string, redirect: string): string {
  const url = new URL(responseUrl);
  const expected = new URL(redirect);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new DeweeApiError(400, 'oauth_invalid_redirect', 'Unexpected sign-in redirect');
  }
  const params = url.searchParams;
  const state = params.get('state') ?? '';
  if (!safeEqual(state, expectedState)) throw new DeweeApiError(400, 'oauth_state_mismatch', 'Sign-in state did not match');
  const error = params.get('error');
  if (error) {
    throw new DeweeApiError(error === 'access_denied' ? 403 : 400, `oauth_${error.replace(/[^a-z_]/gi, '').slice(0, 40)}`, 'Sign-in was not completed');
  }
  const code = params.get('code');
  if (!code) throw new DeweeApiError(400, 'oauth_missing_code', 'Sign-in returned no code');
  return code;
}

export function credentialFromTokens(tokens: TokenResponse, now = Date.now()): OAuthCredential {
  return {
    kind: 'oauth',
    accessToken: tokens.access_token,
    accessExpiresAt: now + tokens.expires_in * 1000,
    refreshToken: tokens.refresh_token,
    refreshExpiresAt: tokens.refresh_expires_in ? now + tokens.refresh_expires_in * 1000 : undefined,
    scope: tokens.scope,
  };
}

async function postAuth(origin: string, path: string, body: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(`${cloudBaseUrl(origin)}/auth/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new DeweeApiError(0, 'network_error', 'Could not reach Dewee Cloud');
  }
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}

async function readTokens(response: Response): Promise<TokenResponse> {
  const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new DeweeApiError(response.status, 'invalid_response', 'Dewee Cloud returned an unexpected token response');
  return parsed.data;
}

/** Interactive sign-in; must start from a user gesture. */
export async function signInWithCloud(origin: string, fetchImpl: typeof fetch = fetch): Promise<OAuthCredential> {
  const verifier = createCodeVerifier();
  const state = randomToken(24);
  const redirect = redirectUri();
  const authorizeUrl = buildAuthorizeUrl(origin, { challenge: await codeChallengeS256(verifier), state, redirect });
  let responseUrl: string | undefined;
  try {
    responseUrl = await browser.identity.launchWebAuthFlow({ url: authorizeUrl, interactive: true });
  } catch {
    throw new DeweeApiError(0, 'oauth_cancelled', 'Sign-in window was closed');
  }
  if (!responseUrl) throw new DeweeApiError(0, 'oauth_cancelled', 'Sign-in window was closed');
  const code = parseRedirect(responseUrl, state, redirect);
  const response = await postAuth(
    origin,
    'exchange',
    { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, client_id: OAUTH_CLIENT_ID },
    fetchImpl,
  );
  return credentialFromTokens(await readTokens(response));
}

export async function refreshCloudTokens(origin: string, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<OAuthCredential> {
  const response = await postAuth(origin, 'refresh', { refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID }, fetchImpl);
  return credentialFromTokens(await readTokens(response));
}

/** Best effort: a failed revoke still signs out locally. */
export async function revokeCloudToken(origin: string, token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    await postAuth(origin, 'revoke', { token }, fetchImpl);
    return true;
  } catch {
    return false;
  }
}
