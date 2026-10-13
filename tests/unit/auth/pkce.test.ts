import { codeChallengeS256, createCodeVerifier, randomToken, safeEqual } from '../../../src/auth/pkce';

describe('createCodeVerifier and randomToken', () => {
  it('creates a 43-character verifier from the unreserved set', () => {
    const verifier = createCodeVerifier();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a different verifier on each call', () => {
    expect(createCodeVerifier()).not.toBe(createCodeVerifier());
  });

  it('encodes random tokens as unpadded base64url', () => {
    const token = randomToken(24);
    expect(token).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('codeChallengeS256', () => {
  it('matches the RFC 7636 appendix B test vector', async () => {
    expect(await codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('produces an unpadded base64url challenge for any verifier', async () => {
    const challenge = await codeChallengeS256(createCodeVerifier());
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('safeEqual', () => {
  it('returns true only for identical strings', () => {
    expect(safeEqual('state-abc', 'state-abc')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
  });

  it('returns false for a different value of the same length or a different length', () => {
    expect(safeEqual('state-abc', 'state-abd')).toBe(false);
    expect(safeEqual('state', 'state-longer')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });
});
