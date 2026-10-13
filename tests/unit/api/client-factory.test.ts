import { fakeBrowser } from 'wxt/testing/fake-browser';
import { pageAuthAdapter } from '../../../src/api/client-factory';
import type { BackgroundResponse } from '../../../src/protocol/messages';

function workerReplies(response: BackgroundResponse | Error) {
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pageAuthAdapter.renew', () => {
  it('reports success and a refused renewal as booleans', async () => {
    workerReplies({ ok: true });
    await expect(pageAuthAdapter('p1').renew!()).resolves.toBe(true);
    workerReplies({ ok: false, code: 'token_revoked', status: 401 });
    await expect(pageAuthAdapter('p1').renew!()).resolves.toBe(false);
  });

  // After a server 401, a renewal that cannot reach the server must not end in a sign-out.
  it('throws a transport error when the renewal could not reach the server', async () => {
    workerReplies({ ok: false, code: 'network_error', status: 0 });
    await expect(pageAuthAdapter('p1').renew!()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });
});

describe('pageAuthAdapter.authorization', () => {
  it('returns the header the worker provides', async () => {
    workerReplies({ ok: true, authorization: 'Bearer test-token' });
    await expect(pageAuthAdapter('p1').authorization()).resolves.toBe('Bearer test-token');
  });

  it('treats a reply without a header as not connected', async () => {
    workerReplies({ ok: true });
    await expect(pageAuthAdapter('p1').authorization()).rejects.toMatchObject({ status: 401, code: 'not_connected' });
  });

  it('passes a 401 from the worker through as a sign-out', async () => {
    workerReplies({ ok: false, code: 'token_revoked', status: 401 });
    await expect(pageAuthAdapter('p1').authorization()).rejects.toMatchObject({ status: 401, code: 'token_revoked' });
  });

  // A failed renewal because the network is down must not sign the person out.
  it('keeps a network failure during renewal as a transport error', async () => {
    workerReplies({ ok: false, code: 'network_error', status: 0 });
    await expect(pageAuthAdapter('p1').authorization()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('reports an unreachable worker as a transport error, not a sign-out', async () => {
    workerReplies(new Error('Receiving end does not exist'));
    await expect(pageAuthAdapter('p1').authorization()).rejects.toMatchObject({ status: 0, code: 'background_unavailable' });
  });
});
