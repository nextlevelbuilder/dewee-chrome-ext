import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorText, hasMessage, resolveLocale, translator } from '../../../src/shared/i18n';

// The catalogs are module-private, so the key sets are read from the source literal. `vi` is also
// typed as Record<MessageKey, string>, so the compiler catches a missing key; this check also
// catches extra keys and placeholder drift at test time.
const source = readFileSync(join(__dirname, '../../../src/shared/i18n.ts'), 'utf8');
const block = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const enSource = block('const en = {', '} as const;');
const viSource = block('const vi: Record<MessageKey, string> = {', '\n};');

const keysOf = (text: string) => [...text.matchAll(/^ {2}'([\w.]+)':/gm)].map((m) => m[1]!);
const placeholdersOf = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

const EN_KEYS = keysOf(enSource);
const VI_KEYS = keysOf(viSource);

describe('message catalogs', () => {
  it('define the same key set in English and Vietnamese', () => {
    expect(EN_KEYS.length).toBeGreaterThan(100);
    expect(new Set(VI_KEYS)).toEqual(new Set(EN_KEYS));
    expect(VI_KEYS).toHaveLength(EN_KEYS.length);
  });

  it('have no empty strings in either language', () => {
    const en = translator('en');
    const vi = translator('vi');
    for (const key of EN_KEYS) {
      expect(en(key as never).trim(), `en ${key}`).not.toBe('');
      expect(vi(key as never).trim(), `vi ${key}`).not.toBe('');
    }
  });

  it('use the same interpolation placeholders in both languages', () => {
    const entries = (text: string) => new Map([...text.matchAll(/^ {2}'([\w.]+)':(.*)$/gm)].map((m) => [m[1]!, m[2]!]));
    const en = entries(enSource);
    const vi = entries(viSource);
    for (const [key, line] of en) {
      expect(placeholdersOf(vi.get(key) ?? ''), key).toEqual(placeholdersOf(line));
    }
  });
});

describe('translator', () => {
  it('interpolates named variables and leaves unknown placeholders as written', () => {
    expect(translator('en')('chat.empty', { agent: 'Super Agent' })).toBe('Ask Super Agent anything.');
    expect(translator('en')('chat.empty')).toBe('Ask {agent} anything.');
    expect(translator('vi')('chat.empty', { agent: 'Super Agent' })).toBe('Hỏi Super Agent bất cứ điều gì.');
  });
});

describe('hasMessage', () => {
  it('recognizes catalog keys only', () => {
    expect(hasMessage('target.provider')).toBe(true);
    expect(hasMessage('target.unknown')).toBe(false);
  });
});

describe('resolveLocale', () => {
  it('honours an explicit preference over the browser language', () => {
    expect(resolveLocale('en', 'vi-VN')).toBe('en');
    expect(resolveLocale('vi', 'en-US')).toBe('vi');
  });

  it('follows the browser language when the preference is auto', () => {
    expect(resolveLocale('auto', 'vi-VN')).toBe('vi');
    expect(resolveLocale('auto', 'fr-FR')).toBe('en');
  });
});

describe('errorText', () => {
  it('localizes known codes and fills the retry delay', () => {
    expect(errorText(translator('en'), 'rate_limited', 12)).toBe('Too many requests. Try again in 12s.');
    expect(errorText(translator('en'), 'rate_limited')).toBe('Too many requests. Try again in 30s.');
    expect(errorText(translator('vi'), 'network_error')).toBe('Không kết nối được máy chủ. Kiểm tra mạng của bạn.');
  });

  it('shows a generic message with the code for unknown codes', () => {
    expect(errorText(translator('en'), 'weird_code')).toBe('Something went wrong (weird_code).');
  });
});
