import { checkOrigin, isLoopbackHost, originPermissionPattern, patternCoversExactHost } from '../../../src/shared/origin';

describe('checkOrigin', () => {
  it('keeps only the origin of an https URL', () => {
    expect(checkOrigin('https://gateway.example.com/v1/extension?x=1#frag')).toEqual({
      ok: true,
      origin: 'https://gateway.example.com',
      insecure: false,
    });
  });

  it('trims surrounding whitespace and normalizes the host case', () => {
    expect(checkOrigin('  https://Gateway.Example.com  ')).toMatchObject({ ok: true, origin: 'https://gateway.example.com' });
  });

  it('allows plain http only for loopback hosts and flags it as insecure', () => {
    expect(checkOrigin('http://localhost:8080/path')).toEqual({ ok: true, origin: 'http://localhost:8080', insecure: true });
    expect(checkOrigin('http://127.0.0.1:3000')).toEqual({ ok: true, origin: 'http://127.0.0.1:3000', insecure: true });
  });

  it('refuses http loopback names the manifest cannot grant', () => {
    expect(checkOrigin('http://[::1]:4000')).toEqual({ ok: false, reason: 'https_required' });
    expect(checkOrigin('http://app.localhost:3000')).toEqual({ ok: false, reason: 'https_required' });
  });

  it('rejects plain http for any other host, including look-alike loopback names', () => {
    expect(checkOrigin('http://gateway.example.com')).toEqual({ ok: false, reason: 'https_required' });
    expect(checkOrigin('http://localhost.evil.example')).toEqual({ ok: false, reason: 'https_required' });
  });

  it('rejects URLs that carry credentials', () => {
    expect(checkOrigin('https://user:test-password@gateway.example.com')).toEqual({ ok: false, reason: 'credentials_in_url' });
    expect(checkOrigin('https://user@gateway.example.com')).toEqual({ ok: false, reason: 'credentials_in_url' });
  });

  it('rejects empty, malformed and non-web schemes', () => {
    expect(checkOrigin('')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkOrigin('gateway.example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkOrigin('ftp://gateway.example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkOrigin('javascript:alert(1)')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('isLoopbackHost', () => {
  it('matches the two granted loopback names only', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('dev.localhost')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('patternCoversExactHost', () => {
  it('accepts a pattern for exactly that host', () => {
    expect(patternCoversExactHost('https://shop.example.test/*', 'https://shop.example.test')).toBe(true);
    expect(patternCoversExactHost('https://Shop.Example.test/*', 'https://shop.example.test')).toBe(true);
    expect(patternCoversExactHost('http://localhost/*', 'http://localhost:3000')).toBe(true);
    expect(patternCoversExactHost('http://localhost:3000/*', 'http://localhost:3000')).toBe(true);
    expect(patternCoversExactHost('https://shop.example.test:443/*', 'https://shop.example.test')).toBe(true);
  });

  it('refuses wildcards, other hosts, schemes and ports', () => {
    expect(patternCoversExactHost('https://*/*', 'https://shop.example.test')).toBe(false);
    expect(patternCoversExactHost('https://*.example.test/*', 'https://shop.example.test')).toBe(false);
    expect(patternCoversExactHost('<all_urls>', 'https://shop.example.test')).toBe(false);
    expect(patternCoversExactHost('*://shop.example.test/*', 'https://shop.example.test')).toBe(false);
    expect(patternCoversExactHost('http://shop.example.test/*', 'https://shop.example.test')).toBe(false);
    expect(patternCoversExactHost('https://example.test/*', 'https://shop.example.test')).toBe(false);
    expect(patternCoversExactHost('http://localhost:4000/*', 'http://localhost:3000')).toBe(false);
    expect(patternCoversExactHost('https://shop.example.test/*', 'not a url')).toBe(false);
  });
});

describe('originPermissionPattern', () => {
  it('builds a single-origin match pattern', () => {
    expect(originPermissionPattern('https://gateway.example.com')).toBe('https://gateway.example.com/*');
  });

  it('keeps an explicit port so two ports never share a grant', () => {
    expect(originPermissionPattern('http://localhost:8080')).toBe('http://localhost:8080/*');
    expect(originPermissionPattern('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000/*');
  });
});
