import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  clearCredential,
  credentialKey,
  readCredential,
  writeCredential,
  type Credential,
} from '../../../src/auth/credential-store';

const PROFILE = 'p_cloud';
const KEY = credentialKey(PROFILE);

const apiKey: Credential = { kind: 'api_key', apiKey: 'test-api-key' };
const oauth: Credential = {
  kind: 'oauth',
  accessToken: 'test-access-token',
  accessExpiresAt: 1_700_000_000_000,
  refreshToken: 'test-refresh-token',
  refreshExpiresAt: 1_800_000_000_000,
  scope: 'chat workspaces actions',
};

const sessionValue = async (key = KEY) => (await fakeBrowser.storage.session.get(key))[key];
const localValue = async (key = KEY) => (await fakeBrowser.storage.local.get(key))[key];

describe('writeCredential', () => {
  it('keeps the credential in session storage only by default', async () => {
    await writeCredential(PROFILE, apiKey, false);
    expect(await sessionValue()).toEqual(apiKey);
    expect(await localValue()).toBeUndefined();
  });

  it('stores in local storage only when the profile opted in to remember', async () => {
    await writeCredential(PROFILE, oauth, true);
    expect(await localValue()).toEqual(oauth);
    expect(await sessionValue()).toBeUndefined();
  });

  it('removes the older copy when the remember choice changes', async () => {
    await writeCredential(PROFILE, apiKey, false);
    await writeCredential(PROFILE, apiKey, true);
    expect(await sessionValue()).toBeUndefined();
    expect(await localValue()).toEqual(apiKey);

    await writeCredential(PROFILE, apiKey, false);
    expect(await localValue()).toBeUndefined();
    expect(await sessionValue()).toEqual(apiKey);
  });

  it('never writes to sync storage', async () => {
    await writeCredential(PROFILE, apiKey, true);
    await writeCredential(PROFILE, oauth, false);
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
  });

  it('rejects an invalid credential without touching storage', async () => {
    await expect(writeCredential(PROFILE, { kind: 'api_key', apiKey: '' } as Credential, false)).rejects.toThrow();
    expect(await sessionValue()).toBeUndefined();
    expect(await localValue()).toBeUndefined();
  });
});

describe('readCredential', () => {
  it('returns null when nothing is stored', async () => {
    expect(await readCredential(PROFILE)).toBeNull();
  });

  it('prefers the session copy over a remembered one', async () => {
    await fakeBrowser.storage.local.set({ [KEY]: apiKey });
    await fakeBrowser.storage.session.set({ [KEY]: { ...apiKey, apiKey: 'test-api-key-session' } });
    expect(await readCredential(PROFILE)).toEqual({ kind: 'api_key', apiKey: 'test-api-key-session' });
  });

  it('falls back to the remembered copy when the session is empty', async () => {
    await writeCredential(PROFILE, oauth, true);
    expect(await readCredential(PROFILE)).toEqual(oauth);
  });

  it('returns null for a stored value that fails the schema', async () => {
    await fakeBrowser.storage.session.set({ [KEY]: { kind: 'oauth', accessToken: '' } });
    expect(await readCredential(PROFILE)).toBeNull();
  });

  it('isolates credentials per profile', async () => {
    await writeCredential(PROFILE, apiKey, false);
    expect(await readCredential('p_other')).toBeNull();
  });
});

describe('clearCredential', () => {
  it('removes the record from both storage areas', async () => {
    await fakeBrowser.storage.local.set({ [KEY]: apiKey });
    await fakeBrowser.storage.session.set({ [KEY]: apiKey });
    await clearCredential(PROFILE);
    expect(await localValue()).toBeUndefined();
    expect(await sessionValue()).toBeUndefined();
    expect(await readCredential(PROFILE)).toBeNull();
  });
});
