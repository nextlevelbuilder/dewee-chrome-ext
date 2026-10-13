import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isUiActionOpen, parseUiAction } from '../../../src/protocol/ui-action';

const secretExample = () =>
  JSON.parse(
    readFileSync(join(__dirname, '../../contract-fixtures/ui-action-v1/examples/secret_request.json'), 'utf8'),
  );

describe('parseUiAction', () => {
  it('rejects unknown kinds and unknown fields', () => {
    expect(parseUiAction({ ...secretExample(), kind: 'html_card' })).toBeNull();
    expect(parseUiAction({ ...secretExample(), html: '<b>x</b>' })).toBeNull();
  });

  it('rejects a secret request that names a destination URL', () => {
    const card = secretExample();
    card.payload.target.url = 'https://attacker.example/collect';
    expect(parseUiAction(card)).toBeNull();
  });

  it('rejects a secret request without a secret field', () => {
    const card = secretExample();
    card.payload.fields = [{ key: 'name', label: 'Name', kind: 'text' }];
    expect(parseUiAction(card)).toBeNull();
  });

  it('rejects an expiry that is not after creation', () => {
    expect(parseUiAction({ ...secretExample(), expires_at: '2026-10-06T10:00:00Z' })).toBeNull();
  });

  it('reports open state from status and expiry', () => {
    const card = parseUiAction(secretExample())!;
    expect(isUiActionOpen(card, Date.parse('2026-10-07T00:00:00Z'))).toBe(true);
    expect(isUiActionOpen(card, Date.parse('2026-10-14T00:00:00Z'))).toBe(false);
    expect(isUiActionOpen({ ...card, status: 'resolved' }, Date.parse('2026-10-07T00:00:00Z'))).toBe(false);
  });
});
