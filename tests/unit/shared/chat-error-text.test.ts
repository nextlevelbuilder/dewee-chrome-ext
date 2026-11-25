import { chatErrorText, type Translate } from '../../../src/shared/i18n';

const t: Translate = (key) => `t:${key}`;

describe('chatErrorText', () => {
  it('shows the server reason for a generic 409 instead of "changed on the server"', () => {
    expect(chatErrorText(t, { code: 'conflict', message: 'The AI provider is unavailable.' })).toBe('The AI provider is unavailable.');
  });
  it('keeps the localized text for a known code', () => {
    expect(chatErrorText(t, { code: 'rate_limited', message: 'slow down' })).toBe('t:error.rate_limited');
  });
  it('falls back to the code text when the server gave no reason', () => {
    expect(chatErrorText(t, { code: 'conflict', message: 'HTTP 409' })).toBe('t:error.conflict');
    expect(chatErrorText(t, { code: 'conflict' })).toBe('t:error.conflict');
  });
});
