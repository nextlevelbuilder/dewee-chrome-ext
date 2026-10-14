import { actionResultSchemas, deviceSchema, ERROR_CODES, grantSchema, isExactOrigin, isValidDeviceName, methodParamsSchemas, parseCommand } from '@/browser/protocol';
import { AGENT_ID, DEVICE_ID, GRANT_ID, payload } from './fixtures';

describe('parseCommand', () => {
  it('accepts a valid command and keeps its params typed', () => {
    const parsed = parseCommand(payload('click', { tab: 't1', ref: 'e3', generation: 2 }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.command).toMatchObject({ action: 'click', params: { tab: 't1', ref: 'e3', generation: 2 }, agent_id: AGENT_ID });
  });

  it('refuses unknown params and keeps the command id for the refusal', () => {
    const raw = payload('click', { tab: 't1', ref: 'e3', generation: 2, selector: '#buy' });
    expect(parseCommand(raw)).toEqual({ ok: false, commandId: raw.command_id, code: 'invalid_params' });
  });

  it('refuses unknown envelope keys, bad ids and unknown actions', () => {
    expect(parseCommand({ ...payload('tabs', {}), extra: 1 }).ok).toBe(false);
    expect(parseCommand(payload('tabs', {}, { grant_id: 'not-a-uuid' })).ok).toBe(false);
    expect(parseCommand(payload('tabs', {}, { action: 'eval' })).ok).toBe(false);
    expect(parseCommand('nope')).toEqual({ ok: false, commandId: undefined, code: 'invalid_params' });
  });

  it('refuses a class that does not match the action', () => {
    expect(parseCommand(payload('click', { tab: 't1', ref: 'e1', generation: 1 }, { class: 'read' })).ok).toBe(false);
  });

  it('only accepts opaque tab handles and refs', () => {
    expect(parseCommand(payload('snapshot', { tab: '123' })).ok).toBe(false);
    expect(parseCommand(payload('snapshot', { tab: 't0' })).ok).toBe(false);
    expect(parseCommand(payload('click', { tab: 't1', ref: '#submit', generation: 1 })).ok).toBe(false);
  });

  it('limits press keys, wait time and snapshot size', () => {
    expect(parseCommand(payload('press', { tab: 't1', key: 'Enter' })).ok).toBe(true);
    expect(parseCommand(payload('press', { tab: 't1', key: 'Control+A' })).ok).toBe(false);
    expect(parseCommand(payload('wait', { tab: 't1', ms: 10_001 })).ok).toBe(false);
    expect(parseCommand(payload('wait', { tab: 't1', text: 'Done' })).ok).toBe(true);
    expect(parseCommand(payload('snapshot', { tab: 't1', max_chars: 60_001 })).ok).toBe(false);
  });

  it('requires an ISO deadline', () => {
    expect(parseCommand(payload('tabs', {}, { deadline: 'soon' })).ok).toBe(false);
  });
});

describe('method params', () => {
  it('connect sends exactly token, client and version', () => {
    expect(methodParamsSchemas.connect.safeParse({ token: 'k', client: 'dewee-chrome-ext', version: '1.0.0' }).success).toBe(true);
    expect(methodParamsSchemas.connect.safeParse({ token: 'k', client: 'other', version: '1.0.0' }).success).toBe(false);
    expect(methodParamsSchemas.connect.safeParse({ token: 'k', client: 'dewee-chrome-ext', version: '1', extra: true }).success).toBe(false);
  });

  it('grant.create accepts only exact origins and the two capability sets', () => {
    const base = { device_id: DEVICE_ID, agent_ids: [AGENT_ID], capabilities: ['browser.read'], ttl_seconds: 3600 };
    const schema = methodParamsSchemas['browser.grant.create'];
    expect(schema.safeParse({ ...base, origins: ['https://example.com'] }).success).toBe(true);
    expect(schema.safeParse({ ...base, origins: ['http://127.0.0.1:8080'] }).success).toBe(true);
    expect(schema.safeParse({ ...base, origins: ['https://example.com/path'] }).success).toBe(false);
    expect(schema.safeParse({ ...base, origins: ['http://example.com'] }).success).toBe(false);
    expect(schema.safeParse({ ...base, origins: ['https://*.example.com'] }).success).toBe(false);
    expect(schema.safeParse({ ...base, origins: ['https://example.com'], capabilities: ['browser.control'] }).success).toBe(false);
    expect(schema.safeParse({ ...base, origins: ['https://example.com'], ttl_seconds: 28_801 }).success).toBe(false);
  });

  it('command.result carries a known error code', () => {
    const schema = methodParamsSchemas['browser.command.result'];
    for (const code of ERROR_CODES) expect(schema.safeParse({ command_id: GRANT_ID, ok: false, error: { code, message: 'x' } }).success).toBe(true);
    expect(schema.safeParse({ command_id: GRANT_ID, ok: false, error: { code: 'made_up', message: 'x' } }).success).toBe(false);
  });
});

describe('gateway objects', () => {
  it('reads grants and devices with either id spelling and ignores unknown capabilities', () => {
    const parsed = grantSchema.parse({ id: GRANT_ID, agent_ids: [AGENT_ID], origins: ['https://example.com'], capabilities: ['browser.read', 'browser.root'], expires_at: '2026-10-14T09:00:00Z' });
    expect(parsed.grant_id).toBe(GRANT_ID);
    expect(parsed.capabilities).toEqual(['browser.read']);
    expect(deviceSchema.parse({ id: DEVICE_ID, name: 'Chrome on Windows' }).device_id).toBe(DEVICE_ID);
  });
});

describe('action results', () => {
  it('are strict, so nothing beyond the contract is reported', () => {
    expect(actionResultSchemas.click.safeParse({ tab: 't1', url: 'https://example.com/', title: 'Home' }).success).toBe(true);
    expect(actionResultSchemas.click.safeParse({ tab: 't1', url: 'https://example.com/', title: 'Home', html: '<p>' }).success).toBe(false);
    expect(actionResultSchemas.snapshot.safeParse({ tab: 't1', url: 'https://example.com/', title: '', generation: 1, text: 'x'.repeat(60_001) }).success).toBe(false);
  });

  it('carry the page url wherever the Gateway checks it', () => {
    expect(actionResultSchemas.snapshot.safeParse({ tab: 't1', url: 'https://example.com/', title: '', generation: 1, text: 'x' }).success).toBe(true);
    for (const action of ['open', 'navigate', 'click', 'type'] as const) {
      expect(actionResultSchemas[action].safeParse({ tab: 't1', title: 'Home' }).success).toBe(false);
      expect(actionResultSchemas[action].safeParse({ tab: 't1', url: '', title: 'Home' }).success).toBe(false);
    }
    expect(actionResultSchemas.snapshot.safeParse({ tab: 't1', url: '', title: '', generation: 1, text: 'x' }).success).toBe(false);
    expect(actionResultSchemas.screenshot.safeParse({ tab: 't1', url: 'https://example.com/', mime: 'image/jpeg', data_base64: 'AA==' }).success).toBe(true);
    expect(actionResultSchemas.screenshot.safeParse({ tab: 't1', mime: 'image/jpeg', data_base64: 'AA==' }).success).toBe(false);
  });
});

describe('contract limits', () => {
  it('knows grant_revoked', () => {
    expect(ERROR_CODES).toContain('grant_revoked');
  });

  it('refuses a trailing dot, an over-long host and a non-punycode host in grant origins', () => {
    expect(isExactOrigin('https://example.com.')).toBe(false);
    expect(isExactOrigin(`https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`)).toBe(false);
    expect(isExactOrigin('https://bücher.example')).toBe(false);
    expect(isExactOrigin('https://xn--bcher-kva.example')).toBe(true);
  });

  it('refuses device names with control or format characters or over 100 bytes', () => {
    const schema = methodParamsSchemas['browser.device.rename'];
    expect(schema.safeParse({ device_id: DEVICE_ID, name: 'Work laptop' }).success).toBe(true);
    expect(isValidDeviceName('Work\nlaptop')).toBe(false);
    expect(isValidDeviceName('Work‮laptop')).toBe(false);
    expect(isValidDeviceName('Work​laptop')).toBe(false);
    expect(isValidDeviceName('ứ'.repeat(34))).toBe(false);
    expect(schema.safeParse({ device_id: DEVICE_ID, name: 'Work‮laptop' }).success).toBe(false);
  });
});
