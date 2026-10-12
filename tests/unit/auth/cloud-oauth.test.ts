import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DeweeApiError } from '../../../src/api/errors';
import {
  buildAuthorizeUrl,
  credentialFromTokens,
  parseRedirect,
  refreshCloudTokens,
  revokeCloudToken,
  signInWithCloud,
} from '../../../src/auth/cloud-oauth';
import { codeChallengeS256 } from '../../../src/auth/pkce';
import { OAUTH_CLIENT_ID, OAUTH_SCOPE } from '../../../src/shared/config';

const ORIGIN = 'https://app.example.test';
const REDIRECT = 'https://abcdefghijklmnop.chromiumapp.org/oauth2';

const tokenBody = {
  access_token: 'test-access-token',
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: 'test-refresh-token',
  refresh_expires_in: 2_592_000,
  scope: OAUTH_SCOPE,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildAuthorizeUrl', () => {
  it('sends the PKCE, state and scope parameters of the extension client', () => {
    const url = new URL(buildAuthorizeUrl(ORIGIN, { challenge: 'challenge-value', state: 'state-value', redirect: REDIRECT }));
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/oauth/extension/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: REDIRECT,
      code_challenge: 'challenge-value',
      code_challenge_method: 'S256',
      state: 'state-value',
      scope: 'chat workspaces actions',
    });
  });
});

describe('parseRedirect', () => {
  const at = (query: string, base = REDIRECT) => `${base}?${query}`;

  it('returns the code when the state matches', () => {
    expect(parseRedirect(at('code=auth-code&state=s1'), 's1', REDIRECT)).toBe('auth-code');
  });

  it('rejects a state mismatch', () => {
    const error = captureError(() => parseRedirect(at('code=auth-code&state=other'), 's1', REDIRECT));
    expect(error).toBeInstanceOf(DeweeApiError);
    expect(error).toMatchObject({ code: 'oauth_state_mismatch', status: 400 });
  });

  it('rejects a missing state', () => {
    expect(captureError(() => parseRedirect(at('code=auth-code'), 's1', REDIRECT))).toMatchObject({ code: 'oauth_state_mismatch' });
  });

  it('rejects a redirect to another origin or path', () => {
    const wrongOrigin = captureError(() => parseRedirect('https://evil.example.test/oauth2?code=x&state=s1', 's1', REDIRECT));
    const wrongPath = captureError(() => parseRedirect('https://abcdefghijklmnop.chromiumapp.org/other?code=x&state=s1', 's1', REDIRECT));
    expect(wrongOrigin).toMatchObject({ code: 'oauth_invalid_redirect' });
    expect(wrongPath).toMatchObject({ code: 'oauth_invalid_redirect' });
  });

  it('maps access_denied to a 403 and other errors to a 400 with a sanitized code', async () => {
    const denied = captureError(() => parseRedirect(at('error=access_denied&state=s1'), 's1', REDIRECT));
    expect(denied).toMatchObject({ status: 403, code: 'oauth_access_denied' });

    const other = captureError(() => parseRedirect(at('error=server_error&state=s1'), 's1', REDIRECT));
    expect(other).toMatchObject({ status: 400, code: 'oauth_server_error' });

    const junk = captureError(() => parseRedirect(at('error=a%20b;c&state=s1'), 's1', REDIRECT));
    expect(junk).toMatchObject({ code: 'oauth_abc' });
  });

  it('rejects a successful redirect that carries no code', () => {
    expect(captureError(() => parseRedirect(at('state=s1'), 's1', REDIRECT))).toMatchObject({ code: 'oauth_missing_code' });
  });
});

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('credentialFromTokens', () => {
  it('derives absolute expiry times from the token lifetimes', () => {
    expect(credentialFromTokens(tokenBody, 1_000)).toEqual({
      kind: 'oauth',
      accessToken: 'test-access-token',
      accessExpiresAt: 1_000 + 900_000,
      refreshToken: 'test-refresh-token',
      refreshExpiresAt: 1_000 + 2_592_000_000,
      scope: OAUTH_SCOPE,
    });
  });

  it('leaves the refresh expiry unset when the server omits it', () => {
    const { refresh_expires_in: _omit, ...tokens } = tokenBody;
    expect(credentialFromTokens(tokens, 0).refreshExpiresAt).toBeUndefined();
  });
});

describe('signInWithCloud', () => {
  it('binds the code exchange to the PKCE challenge sent to the authorize endpoint', async () => {
    vi.spyOn(fakeBrowser.identity, 'getRedirectURL').mockReturnValue(REDIRECT);
    let authorizeUrl = '';
    vi.spyOn(fakeBrowser.identity, 'launchWebAuthFlow').mockImplementation(async (details) => {
      authorizeUrl = details.url ?? '';
      const state = new URL(authorizeUrl).searchParams.get('state');
      return `${REDIRECT}?code=auth-code&state=${state}`;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(tokenBody));

    const credential = await signInWithCloud(ORIGIN, fetch);

    const sent = new URL(authorizeUrl).searchParams;
    expect(sent.get('code_challenge_method')).toBe('S256');
    const exchange = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as Record<string, string>;
    expect(fetch.mock.calls[0]![0]).toBe(`${ORIGIN}/api/extension/v1/auth/exchange`);
    expect(exchange).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      code_verifier: exchange.code_verifier,
      redirect_uri: REDIRECT,
      client_id: OAUTH_CLIENT_ID,
    });
    expect(await codeChallengeS256(exchange.code_verifier!)).toBe(sent.get('code_challenge'));
    expect(credential).toMatchObject({ kind: 'oauth', accessToken: 'test-access-token' });
  });

  it('reports a closed sign-in window as oauth_cancelled, including an undefined result', async () => {
    vi.spyOn(fakeBrowser.identity, 'getRedirectURL').mockReturnValue(REDIRECT);
    vi.spyOn(fakeBrowser.identity, 'launchWebAuthFlow').mockRejectedValueOnce(new Error('The user did not approve access.'));
    await expect(signInWithCloud(ORIGIN, vi.fn<typeof globalThis.fetch>())).rejects.toMatchObject({ code: 'oauth_cancelled' });

    vi.spyOn(fakeBrowser.identity, 'launchWebAuthFlow').mockResolvedValueOnce(undefined);
    await expect(signInWithCloud(ORIGIN, vi.fn<typeof globalThis.fetch>())).rejects.toMatchObject({ code: 'oauth_cancelled' });
  });
});

describe('refreshCloudTokens and revokeCloudToken', () => {
  it('posts the refresh token with a credentials-free, no-cache, no-redirect request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ...tokenBody, refresh_token: 'rotated-refresh' }));
    const credential = await refreshCloudTokens(ORIGIN, 'test-refresh-token', fetch);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/extension/v1/auth/refresh`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error' });
    expect(JSON.parse(String(init?.body))).toEqual({ refresh_token: 'test-refresh-token', client_id: OAUTH_CLIENT_ID });
    expect(credential.refreshToken).toBe('rotated-refresh');
  });

  it('rejects a token response that is not a bearer token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ...tokenBody, token_type: 'mac' }));
    await expect(refreshCloudTokens(ORIGIN, 'test-refresh-token', fetch)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('surfaces the server error for a rejected refresh and network_error for a failed connection', async () => {
    const rejected = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ error: { code: 'token_revoked' } }, 401));
    await expect(refreshCloudTokens(ORIGIN, 'test-refresh-token', rejected)).rejects.toMatchObject({ status: 401, code: 'token_revoked' });

    const offline = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('offline');
    });
    await expect(refreshCloudTokens(ORIGIN, 'test-refresh-token', offline)).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('reports revocation as true on success and false otherwise', async () => {
    const ok = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ revoked: true }));
    expect(await revokeCloudToken(ORIGIN, 'test-refresh-token', ok)).toBe(true);
    expect(JSON.parse(String(ok.mock.calls[0]![1]?.body))).toEqual({ token: 'test-refresh-token' });

    const failed = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ error: { code: 'not_found' } }, 404));
    expect(await revokeCloudToken(ORIGIN, 'test-refresh-token', failed)).toBe(false);

    const offline = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('offline');
    });
    expect(await revokeCloudToken(ORIGIN, 'test-refresh-token', offline)).toBe(false);
  });
});
