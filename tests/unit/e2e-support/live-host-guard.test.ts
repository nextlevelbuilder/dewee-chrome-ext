import { isLoopbackUrl, remoteHostRefusal } from '../../e2e/support/live-host-guard';

describe('isLoopbackUrl', () => {
  it.each(['http://localhost:18790', 'http://127.0.0.1:18790', 'https://127.10.0.3', 'http://[::1]:8080/v1'])('accepts %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    'https://gateway.example.test',
    'http://localhost.example.test',
    'http://127.0.0.1.example.test',
    // Userinfo, wildcard DNS, IPv4-mapped IPv6 and a loopback-looking label must not pass.
    'http://127.0.0.1@evil.com',
    'http://127.0.0.1.nip.io',
    'http://[::ffff:127.0.0.1]',
    'http://localhost.evil.com',
    'http://10.0.0.5:18790',
    'http://0.0.0.0:18790',
    'ftp://localhost',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });
});

describe('remoteHostRefusal', () => {
  it('allows loopback and an unset URL', () => {
    expect(remoteHostRefusal('E2E_GATEWAY_URL', 'http://127.0.0.1:18790', {})).toBeNull();
    expect(remoteHostRefusal('E2E_GATEWAY_URL', '', {})).toBeNull();
  });

  it('refuses a remote host without echoing it, unless E2E_ALLOW_REMOTE=1', () => {
    const refusal = remoteHostRefusal('E2E_CLOUD_ORIGIN', 'https://prod.example.test', {});
    expect(refusal).toContain('E2E_CLOUD_ORIGIN is not a loopback host');
    expect(refusal).toContain('E2E_ALLOW_REMOTE=1');
    expect(refusal).not.toContain('prod.example.test');
    expect(remoteHostRefusal('E2E_CLOUD_ORIGIN', 'https://prod.example.test', { E2E_ALLOW_REMOTE: 'true' })).not.toBeNull();
    expect(remoteHostRefusal('E2E_CLOUD_ORIGIN', 'https://prod.example.test', { E2E_ALLOW_REMOTE: '1' })).toBeNull();
  });
});
