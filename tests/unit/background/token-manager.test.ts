import { fakeBrowser } from 'wxt/testing/fake-browser';
import { authorizationFor, renewFor, signIn, signOut } from '../../../src/background/token-manager';
import { DeweeApiError } from '../../../src/api/errors';
import { readCredential, writeCredential, type Credential, type OAuthCredential } from '../../../src/auth/credential-store';
import { saveSettings, defaultSettings, type Profile } from '../../../src/shared/settings';

const NOW = 1_000_000_000;
const cloud: Profile = { id: 'p_cloud', name: 'Cloud', kind: 'cloud', origin: 'https://app.example.test', remember: false };
const gateway: Profile = { id: 'p_gw', name: 'Gateway', kind: 'gateway', origin: 'https://gw.example.test', remember: false };

const oauth = (overrides: Partial<OAuthCredential> = {}): OAuthCredential => ({
  kind: 'oauth',
  accessToken: 'test-access-old',
  accessExpiresAt: NOW + 10 * 60_000,
  refreshToken: 'test-refresh-old',
  ...overrides,
});

const refreshBody = {
  access_token: 'test-access-new',
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: 'test-refresh-new',
  refresh_expires_in: 2_592_000,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function seed(profiles: Profile[] = [cloud, gateway]) {
  await saveSettings({ ...defaultSettings(), profiles, activeProfileId: profiles[0]?.id });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authorizationFor', () => {
  it('returns the API key for a gateway profile without touching the network', async () => {
    await seed();
    await writeCredential(gateway.id, { kind: 'api_key', apiKey: 'test-api-key' }, false);
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await authorizationFor(gateway.id, fetch, NOW)).toBe('Bearer test-api-key');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns the stored access token while it is well before expiry', async () => {
    await seed();
    await writeCredential(cloud.id, oauth(), false);
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(await authorizationFor(cloud.id, fetch, NOW)).toBe('Bearer test-access-old');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('renews within 60 seconds of expiry and stores the rotated credential', async () => {
    await seed();
    await writeCredential(cloud.id, oauth({ accessExpiresAt: NOW + 30_000 }), false);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(refreshBody));

    expect(await authorizationFor(cloud.id, fetch, NOW)).toBe('Bearer test-access-new');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({ refresh_token: 'test-refresh-old' });
    const stored = await readCredential(cloud.id);
    expect(stored).toMatchObject({ kind: 'oauth', accessToken: 'test-access-new', refreshToken: 'test-refresh-new' });
  });

  it('shares one refresh request between concurrent callers', async () => {
    await seed();
    await writeCredential(cloud.id, oauth({ accessExpiresAt: NOW - 1 }), false);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(refreshBody));

    const headers = await Promise.all([authorizationFor(cloud.id, fetch, NOW), authorizationFor(cloud.id, fetch, NOW), authorizationFor(cloud.id, fetch, NOW)]);

    expect(headers).toEqual(['Bearer test-access-new', 'Bearer test-access-new', 'Bearer test-access-new']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not present a refresh token that rotated after the caller read it', async () => {
    await seed();
    await writeCredential(cloud.id, oauth({ accessExpiresAt: NOW - 1 }), false);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(refreshBody));

    // The caller reads the old token; another refresh stores a rotated one before this renewal runs.
    const pending = renewFor(cloud.id, fetch);
    await writeCredential(cloud.id, oauth({ accessToken: 'test-access-rotated', refreshToken: 'test-refresh-rotated' }), false);
    await pending;

    expect(fetch).not.toHaveBeenCalled();
    expect(await readCredential(cloud.id)).toMatchObject({ refreshToken: 'test-refresh-rotated' });
  });

  it('reports a missing credential as not_connected', async () => {
    await seed();
    await expect(authorizationFor(cloud.id, vi.fn<typeof globalThis.fetch>(), NOW)).rejects.toMatchObject({ status: 401, code: 'not_connected' });
  });

  it('reports a credential whose profile was removed as profile_not_found when renewal is needed', async () => {
    await seed([gateway]);
    await writeCredential(cloud.id, oauth({ accessExpiresAt: NOW }), false);
    await expect(authorizationFor(cloud.id, vi.fn<typeof globalThis.fetch>(), NOW)).rejects.toMatchObject({ code: 'profile_not_found' });
  });
});

describe('renewal failures', () => {
  it.each([400, 401, 403])('clears the credential and reports token_revoked when the refresh is rejected with %i', async (status) => {
    await seed();
    await writeCredential(cloud.id, oauth(), false);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ error: { code: 'token_revoked' } }, status));

    const error = await renewFor(cloud.id, fetch).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeweeApiError);
    expect(error).toMatchObject({ status: 401, code: 'token_revoked' });
    expect(await readCredential(cloud.id)).toBeNull();
  });

  it('keeps the credential when the refresh fails because the network is down', async () => {
    await seed();
    await writeCredential(cloud.id, oauth(), false);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('offline');
    });

    await expect(renewFor(cloud.id, fetch)).rejects.toMatchObject({ status: 0, code: 'network_error' });
    expect(await readCredential(cloud.id)).toMatchObject({ refreshToken: 'test-refresh-old' });
  });

  it('never renews an API key; the profile needs a new key', async () => {
    await seed();
    await writeCredential(gateway.id, { kind: 'api_key', apiKey: 'test-api-key' }, false);
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(renewFor(gateway.id, fetch)).rejects.toMatchObject({ status: 401, code: 'api_key_rejected' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps remembered credentials in local storage after a renewal', async () => {
    await seed([{ ...cloud, remember: true }]);
    await writeCredential(cloud.id, oauth(), true);
    await renewFor(cloud.id, vi.fn<typeof globalThis.fetch>(async () => jsonResponse(refreshBody)));
    expect(await fakeBrowser.storage.local.get(`credential:${cloud.id}`)).toMatchObject({
      [`credential:${cloud.id}`]: { refreshToken: 'test-refresh-new' },
    });
    expect(await fakeBrowser.storage.session.get(`credential:${cloud.id}`)).toEqual({});
  });
});

describe('signIn and signOut', () => {
  it('refuses sign-in for a gateway profile', async () => {
    await seed();
    await expect(signIn(gateway.id, vi.fn<typeof globalThis.fetch>())).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  it('stores the tokens from a completed sign-in under the profile', async () => {
    await seed([{ ...cloud, remember: true }]);
    vi.spyOn(fakeBrowser.identity, 'getRedirectURL').mockReturnValue('https://ext.chromiumapp.org/oauth2');
    vi.spyOn(fakeBrowser.identity, 'launchWebAuthFlow').mockImplementation(async (details) => {
      const state = new URL(details.url ?? '').searchParams.get('state');
      return `https://ext.chromiumapp.org/oauth2?code=auth-code&state=${state}`;
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(refreshBody));

    await signIn(cloud.id, fetch);

    expect(await readCredential(cloud.id)).toMatchObject({ kind: 'oauth', accessToken: 'test-access-new' });
    expect(await fakeBrowser.storage.local.get(`credential:${cloud.id}`)).not.toEqual({});
  });

  it('revokes the refresh token and clears local credentials on sign-out', async () => {
    await seed();
    await writeCredential(cloud.id, oauth(), false);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ revoked: true }));

    await signOut(cloud.id, fetch);

    expect(fetch.mock.calls[0]![0]).toBe('https://app.example.test/api/extension/v1/auth/revoke');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({ token: 'test-refresh-old' });
    expect(await readCredential(cloud.id)).toBeNull();
  });

  it('still clears local credentials when revocation fails', async () => {
    await seed();
    await writeCredential(cloud.id, oauth(), false);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError('offline');
    });
    await signOut(cloud.id, fetch);
    expect(await readCredential(cloud.id)).toBeNull();
  });

  it('does not call revoke for an API key credential', async () => {
    await seed();
    const credential: Credential = { kind: 'api_key', apiKey: 'test-api-key' };
    await writeCredential(gateway.id, credential, false);
    const fetch = vi.fn<typeof globalThis.fetch>();
    await signOut(gateway.id, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readCredential(gateway.id)).toBeNull();
  });
});
