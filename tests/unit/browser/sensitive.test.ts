import { isEditableField, isSensitiveField, type FieldAttributes } from '@/browser/sensitive';
import { pageRun } from '@/browser/snapshot';

/** Fields covering every rule: type, autocomplete, name/id words, payment patterns, and look-alikes that are not secrets. */
const FIELDS: Array<FieldAttributes & { label: string }> = [
  { label: 'pw', tag: 'INPUT', type: 'password' },
  { label: 'otp-ac', tag: 'INPUT', type: 'text', autocomplete: 'one-time-code' },
  { label: 'cc-ac', tag: 'INPUT', type: 'text', autocomplete: 'cc-number' },
  { label: 'cur-pw-ac', tag: 'INPUT', type: 'text', autocomplete: 'current-password' },
  { label: 'pin-name', tag: 'INPUT', type: 'text', name: 'userPin' },
  { label: 'otp-id', tag: 'INPUT', type: 'text', id: 'otp_code' },
  { label: 'cvv', tag: 'INPUT', type: 'text', name: 'cvv' },
  { label: 'card', tag: 'INPUT', type: 'text', name: 'cardNumber' },
  { label: 'iban', tag: 'INPUT', type: 'text', id: 'iban' },
  { label: 'passwordConfirm', tag: 'INPUT', type: 'text', name: 'passwordConfirm' },
  { label: 'area-secret', tag: 'TEXTAREA', name: 'mfa' },
  { label: 'shipping', tag: 'INPUT', type: 'text', name: 'shipping' },
  { label: 'spinner', tag: 'INPUT', type: 'text', id: 'spinner' },
  { label: 'email', tag: 'INPUT', type: 'email', autocomplete: 'email' },
  { label: 'notes', tag: 'TEXTAREA', name: 'notes' },
  { label: 'passenger', tag: 'INPUT', type: 'text', name: 'passenger' },
];

function html(field: FieldAttributes & { label: string }): string {
  const attrs = [
    field.type ? `type="${field.type}"` : '',
    field.autocomplete ? `autocomplete="${field.autocomplete}"` : '',
    field.name ? `name="${field.name}"` : '',
    field.id ? `id="${field.id}"` : '',
    `aria-label="${field.label}"`,
  ].join(' ');
  return field.tag === 'TEXTAREA' ? `<textarea ${attrs}>value-${field.label}</textarea>` : `<input ${attrs} value="value-${field.label}">`;
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__deweeBrowserControl;
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(() => [{}] as unknown as DOMRectList);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, toJSON: () => ({}) }) as DOMRect);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sensitive field rule', () => {
  it('matches the page script, field by field', () => {
    document.body.innerHTML = FIELDS.map(html).join('\n');
    const response = pageRun({ op: 'snapshot', origins: [location.origin], generation: 1, maxChars: 20_000 });
    if (!response.ok || response.op !== 'snapshot') throw new Error('snapshot failed');
    for (const field of FIELDS) {
      const line = response.text.split('\n').find((l) => l.includes(`"${field.label}"`));
      expect(line, field.label).toBeDefined();
      expect(line?.includes('value=[redacted]'), field.label).toBe(isSensitiveField(field));
    }
    // The rule really splits both ways in this list.
    expect(FIELDS.filter((f) => isSensitiveField(f)).length).toBe(11);
  });

  it('knows which fields take typed text', () => {
    expect(isEditableField({ tag: 'INPUT', type: 'email' })).toBe(true);
    expect(isEditableField({ tag: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isEditableField({ tag: 'INPUT', type: 'text', readonly: true })).toBe(false);
    expect(isEditableField({ tag: 'TEXTAREA' })).toBe(true);
    expect(isEditableField({ tag: 'DIV', contenteditable: '' })).toBe(true);
    expect(isEditableField({ tag: 'DIV', contenteditable: 'false' })).toBe(false);
    expect(isEditableField({ tag: 'DIV', contenteditable: null })).toBe(false);
  });
});
