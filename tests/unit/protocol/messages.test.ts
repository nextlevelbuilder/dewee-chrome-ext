import { fakeBrowser } from 'wxt/testing/fake-browser';
import { callBackground, requestSchema } from '../../../src/protocol/messages';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestSchema', () => {
  it('accepts the known request types with their required fields', () => {
    expect(requestSchema.safeParse({ type: 'auth.renew', profileId: 'p_1' }).success).toBe(true);
    expect(requestSchema.safeParse({ type: 'auth.signIn', profileId: 'p_1' }).success).toBe(true);
    expect(requestSchema.safeParse({ type: 'badge.refresh' }).success).toBe(true);
  });

  it('rejects unknown request types', () => {
    expect(requestSchema.safeParse({ type: 'auth.export', profileId: 'p_1' }).success).toBe(false);
    expect(requestSchema.safeParse({ type: 'chat.send', profileId: 'p_1', message: 'hi' }).success).toBe(false);
  });

  it('rejects a missing or empty profile id', () => {
    expect(requestSchema.safeParse({ type: 'auth.renew' }).success).toBe(false);
    expect(requestSchema.safeParse({ type: 'auth.renew', profileId: '' }).success).toBe(false);
  });

  it('strips secret-looking extra fields so the worker never reads them', () => {
    const parsed = requestSchema.safeParse({
      type: 'auth.signIn',
      profileId: 'p_1',
      apiKey: 'test-api-key',
      accessToken: 'test-access-token',
      secret: { api_key: 'test-api-key' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ type: 'auth.signIn', profileId: 'p_1' });
    expect(JSON.stringify(parsed.data)).not.toContain('test-');
  });

  it('defines no request type that carries a secret field', () => {
    const fields = requestSchema.options.flatMap((option) => Object.keys(option.shape)).sort();
    expect([...new Set(fields)]).toEqual(['profileId', 'type']);
  });
});

describe('callBackground', () => {
  it('sends the request to the service worker and returns its response', async () => {
    const send = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue({ ok: true, authorization: 'Bearer test-api-key' } as never);
    const response = await callBackground({ type: 'auth.authorization', profileId: 'p_1' });
    expect(send).toHaveBeenCalledWith({ type: 'auth.authorization', profileId: 'p_1' });
    expect(response).toEqual({ ok: true, authorization: 'Bearer test-api-key' });
  });

  it('turns a missing response into no_response', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    expect(await callBackground({ type: 'badge.refresh' })).toEqual({ ok: false, code: 'no_response' });
  });

  it('turns a failed message channel into background_unavailable', async () => {
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockRejectedValue(new Error('Could not establish connection'));
    expect(await callBackground({ type: 'badge.refresh' })).toEqual({ ok: false, code: 'background_unavailable' });
  });
});
