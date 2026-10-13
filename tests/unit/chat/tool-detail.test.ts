import { clip, DETAIL_LIMIT, formatToolInput, formatToolText, redactText } from '../../../src/chat/tool-detail';

describe('tool detail text', () => {
  it('formats arguments as indented JSON and hides credential-like keys at any depth', () => {
    const text = formatToolInput({ provider: 'anthropic', apiKey: 'value-a', nested: { password: 'value-b', list: [{ access_token: 'value-c' }] } });
    expect(text).toContain('"provider": "anthropic"');
    expect(text).not.toMatch(/value-[abc]/);
    expect(text?.match(/\[redacted\]/g)).toHaveLength(3);
  });

  it('returns nothing for missing or empty arguments and blank text', () => {
    expect(formatToolInput(undefined)).toBeUndefined();
    expect(formatToolInput({})).toBeUndefined();
    expect(formatToolText('   ')).toBeUndefined();
    expect(formatToolText(undefined)).toBeUndefined();
  });

  it.each([
    ['dewee providers create --api-key abc123 --name x', 'dewee providers create --api-key [redacted] --name x'],
    ['TOKEN="quoted value" next', 'TOKEN=[redacted] next'],
    ['Authorization: Bearer abc.def', 'Authorization: Bearer [redacted]'],
    ['key sk-ant-0123456789abcdef here', 'key [redacted] here'],
    ['plain output with no keys', 'plain output with no keys'],
  ])('redacts secrets inside free text: %s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('clips long text with a marker', () => {
    const long = 'x'.repeat(DETAIL_LIMIT + 10);
    expect(clip(long)).toHaveLength(DETAIL_LIMIT + 2);
    expect(clip(long).endsWith('\n…')).toBe(true);
    expect(clip('short')).toBe('short');
  });
});