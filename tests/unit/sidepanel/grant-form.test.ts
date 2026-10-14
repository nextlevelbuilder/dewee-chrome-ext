import { translator } from '@/shared/i18n';
import { parseOrigins } from '@/sidepanel/browser/GrantForm';

const t = translator('en');

describe('parseOrigins', () => {
  it('accepts exact sites, one per line, without duplicates', () => {
    expect(parseOrigins('https://shop.example.com\nhttps://shop.example.com/\nhttp://127.0.0.1:8080', t)).toEqual({ ok: true, origins: ['https://shop.example.com', 'http://127.0.0.1:8080'] });
  });

  it.each(['https://shop.example.com/cart', 'http://shop.example.com', 'shop.example.com', 'https://user:pw@shop.example.com', 'ftp://example.com', 'https://*.example.com'])('refuses %s', (input) => {
    expect(parseOrigins(input, t)).toMatchObject({ ok: false });
  });

  it('refuses restricted sites and empty input', () => {
    expect(parseOrigins('https://chromewebstore.google.com', t)).toEqual({ ok: false, error: 'https://chromewebstore.google.com cannot be controlled.' });
    expect(parseOrigins('  ', t)).toEqual({ ok: false, error: 'Add at least one site.' });
  });

  it('limits the number of sites', () => {
    const many = Array.from({ length: 21 }, (_, i) => `https://s${i}.example.com`).join('\n');
    expect(parseOrigins(many, t)).toEqual({ ok: false, error: 'Use at most 20 sites.' });
  });
});
