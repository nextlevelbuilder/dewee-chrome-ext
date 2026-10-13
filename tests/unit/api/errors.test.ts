import { DeweeApiError, errorFromResponse, isApiError } from '../../../src/api/errors';

const jsonResponse = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

describe('errorFromResponse', () => {
  it('uses the envelope code, message and retry_after_seconds', async () => {
    const error = await errorFromResponse(
      jsonResponse({ error: { code: 'rate_limited', message: 'Slow down', retry_after_seconds: 30 } }, 429),
    );
    expect(error).toBeInstanceOf(DeweeApiError);
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', message: 'Slow down', retryAfterSeconds: 30, kind: 'rate_limited' });
  });

  it('uses the code as the message when the envelope has none', async () => {
    const error = await errorFromResponse(jsonResponse({ error: { code: 'forbidden' } }, 403));
    expect(error).toMatchObject({ code: 'forbidden', message: 'forbidden', kind: 'forbidden' });
  });

  it('falls back to the status when the body is not JSON', async () => {
    const error = await errorFromResponse(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(error).toMatchObject({ status: 502, code: 'runtime_unavailable', message: 'HTTP 502', kind: 'server' });
  });

  it('falls back to the status when the envelope does not match the contract', async () => {
    const tooLong = { error: { code: 'x'.repeat(81) } };
    expect(await errorFromResponse(jsonResponse(tooLong, 400))).toMatchObject({ code: 'invalid_request', message: 'HTTP 400' });
    expect(await errorFromResponse(jsonResponse({ nope: true }, 404))).toMatchObject({ code: 'not_found' });
  });

  it('uses a known error.details.reason as the code, and ignores unknown reasons', async () => {
    const revoked = { error: { code: 'conflict', message: 'closed', details: { reason: 'credential_policy_revoked', action_id: 'a1' } } };
    expect(await errorFromResponse(jsonResponse(revoked, 409))).toMatchObject({ status: 409, code: 'credential_policy_revoked', message: 'closed' });
    const other = { error: { code: 'action_closed', details: { reason: 'something_else' } } };
    expect(await errorFromResponse(jsonResponse(other, 409))).toMatchObject({ code: 'action_closed' });
  });

  it.each([
    ['null', null],
    ['a string', 'oops'],
    ['an array', ['credential_policy_revoked']],
    ['a non-string reason', { reason: 5 }],
    ['an overlong reason', { reason: 'r'.repeat(500) }],
  ])('keeps the envelope code, message and retry when details is %s', async (_name, details) => {
    const body = { error: { code: 'action_closed', message: 'Already closed', retry_after_seconds: 7, details } };
    expect(await errorFromResponse(jsonResponse(body, 409))).toMatchObject({
      status: 409,
      code: 'action_closed',
      message: 'Already closed',
      retryAfterSeconds: 7,
    });
  });

  it.each([
    ['a zero retry', { retry_after_seconds: 0 }],
    ['a fractional retry', { retry_after_seconds: 1.5 }],
    ['a retry over one hour', { retry_after_seconds: 99999 }],
    ['a string retry', { retry_after_seconds: '30' }],
    ['an overlong message', { message: 'm'.repeat(501) }],
    ['a non-string message', { message: 42 }],
  ])('keeps the code and details.reason when the envelope has %s', async (_name, sibling) => {
    const body = { error: { code: 'conflict', details: { reason: 'credential_policy_revoked' }, ...sibling } };
    const error = await errorFromResponse(jsonResponse(body, 409, { 'Retry-After': '9' }));
    expect(error).toMatchObject({ status: 409, code: 'credential_policy_revoked' });
    if ('retry_after_seconds' in sibling) expect(error.retryAfterSeconds).toBe(9);
    else expect(error.message).toBe('conflict');
  });

  it('maps unlisted client statuses to request_failed and kind invalid', async () => {
    const error = await errorFromResponse(new Response(null, { status: 418 }));
    expect(error).toMatchObject({ code: 'request_failed', kind: 'invalid' });
  });

  it('reads Retry-After when the envelope omits it, and caps it at one hour', async () => {
    expect((await errorFromResponse(jsonResponse({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '120' }))).retryAfterSeconds).toBe(120);
    expect((await errorFromResponse(jsonResponse({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': '99999' }))).retryAfterSeconds).toBe(3600);
  });

  it('ignores Retry-After values that are not positive integers', async () => {
    for (const value of ['abc', '0', '-5']) {
      const error = await errorFromResponse(jsonResponse({ error: { code: 'rate_limited' } }, 429, { 'Retry-After': value }));
      expect(error.retryAfterSeconds).toBeUndefined();
    }
  });

  it('prefers the envelope retry_after_seconds over the header', async () => {
    const error = await errorFromResponse(
      jsonResponse({ error: { code: 'rate_limited', retry_after_seconds: 10 } }, 429, { 'Retry-After': '120' }),
    );
    expect(error.retryAfterSeconds).toBe(10);
  });
});

describe('DeweeApiError kind', () => {
  it.each([
    [0, 'network'],
    [401, 'auth'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [503, 'server'],
    [400, 'invalid'],
  ])('maps status %i to %s', (status, kind) => {
    expect(new DeweeApiError(status, 'x', 'm').kind).toBe(kind);
  });

  it('isApiError only accepts DeweeApiError instances', () => {
    expect(isApiError(new DeweeApiError(0, 'network_error', 'x'))).toBe(true);
    expect(isApiError(new Error('plain'))).toBe(false);
    expect(isApiError({ status: 401, code: 'x' })).toBe(false);
  });
});
