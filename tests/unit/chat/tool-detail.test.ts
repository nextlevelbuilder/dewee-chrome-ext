import { clip, DETAIL_LIMIT, formatToolInput, formatToolText, isSecretName, redactText } from '../../../src/chat/tool-detail';

describe('tool detail text', () => {
  it('formats arguments as indented JSON and hides credential-like keys at any depth', () => {
    const text = formatToolInput({ provider: 'anthropic', apiKey: 'value-a', nested: { password: 'value-b', list: [{ access_token: 'value-c' }] } });
    expect(text).toContain('"provider": "anthropic"');
    expect(text).not.toMatch(/value-[abc]/);
    expect(text?.match(/\[redacted\]/g)).toHaveLength(3);
  });

  it('stops at a fixed depth instead of printing deeper objects', () => {
    let deep: Record<string, unknown> = { password: 'value-deep' };
    for (let i = 0; i < 12; i++) deep = { inner: deep };
    expect(formatToolInput(deep)).not.toContain('value-deep');
  });

  it.each(['password', 'client_secret', 'GITHUB_TOKEN', 'accessToken', 'x-api-key', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'apiKey', '--api-key'])('treats %s as a secret name', (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  it.each(['max_tokens', 'bypass', 'agent_key', 'session_key', 'command', 'tokens'])('does not treat %s as a secret name', (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  it('returns nothing for missing or empty arguments and blank text', () => {
    expect(formatToolInput(undefined)).toBeUndefined();
    expect(formatToolInput({})).toBeUndefined();
    expect(formatToolText('   ')).toBeUndefined();
    expect(formatToolText(undefined)).toBeUndefined();
  });

  it.each([
    ['dewee providers create --api-key abc123 --name x', 'dewee providers create --api-key [redacted] --name x'],
    ['GITHUB_TOKEN=value-1 gh repo list', 'GITHUB_TOKEN=[redacted] gh repo list'],
    ['export AWS_SECRET_ACCESS_KEY="value 2"', 'export AWS_SECRET_ACCESS_KEY=[redacted]'],
    ['{"password":"value-3","user":"ann"}', '{"password":[redacted],"user":"ann"}'],
    ['curl "https://api.example.com/v1?api_key=value-7&page=2"', 'curl "https://api.example.com/v1?api_key=[redacted]&page=2"'],
    ['{"callback":"https://h/x?token=value-8"}', '{"callback":"https://h/x?token=[redacted]"}'],
    ['Error: GITHUB_TOKEN=value-9 is invalid', 'Error: GITHUB_TOKEN=[redacted] is invalid'],
    ['env: DB_PASSWORD=value-10', 'env: DB_PASSWORD=[redacted]'],
    ['PGPASSWORD=value-11 psql', 'PGPASSWORD=[redacted] psql'],
    ['Authorization: token 0123456789abcdef0123', 'Authorization: [redacted]'],
    ['Basic authentication required', 'Basic authentication required'],
    ['Token expired, sign in again', 'Token expired, sign in again'],
    ['curl -H "Authorization: Basic dmFsdWUtNA=="', 'curl -H "Authorization: [redacted]"'],
    ['Bearer abcdef123456', '[redacted]'],
    ['clone https://ann:value-5@git.example.com/repo', 'clone https://[redacted]@git.example.com/repo'],
    ['key sk-ant-0123456789abcdef here', 'key [redacted] here'],
    ['Invalid token provided', 'Invalid token provided'],
    ['max_tokens: 2048', 'max_tokens: 2048'],
  ])('redacts secrets inside free text: %s', (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it('redacts JSON result text field by field', () => {
    const text = formatToolText('{"ok":true,"data":{"client_secret":"value-6","name":"demo"}}');
    expect(text).toContain('"name": "demo"');
    expect(text).not.toContain('value-6');
  });

  it('clips long text with a marker', () => {
    const long = 'x'.repeat(DETAIL_LIMIT + 10);
    expect(clip(long)).toHaveLength(DETAIL_LIMIT + 2);
    expect(clip(long).endsWith('\n…')).toBe(true);
    expect(clip('short')).toBe('short');
  });
});