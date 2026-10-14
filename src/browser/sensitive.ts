/**
 * Which form fields hold secrets (password, PIN, payment card, one-time code), decided from the
 * element's attributes only. The debugger adapter uses this; the bundled page script (`pageRun` in
 * snapshot.ts) must stay self-contained, so it carries the same rule inline. A parity test keeps
 * the two in step (tests/unit/browser/sensitive.test.ts).
 */

export interface FieldAttributes {
  /** Upper-case tag name (`INPUT`, `TEXTAREA`, ...). */
  tag: string;
  type?: string | null;
  autocomplete?: string | null;
  name?: string | null;
  id?: string | null;
}

/** Words in a field's name or id that mark a password, PIN or one-time code. */
const SECRET_WORDS = new Set(['pass', 'password', 'passwd', 'passcode', 'passphrase', 'pwd', 'pin', 'otp', 'totp', 'otc', 'mfa', '2fa']);

export function isSensitiveField(field: FieldAttributes): boolean {
  if (field.tag.toUpperCase() === 'INPUT' && (field.type ?? '').toLowerCase() === 'password') return true;
  const autocomplete = (field.autocomplete ?? '').toLowerCase();
  if (/(^|\s)(cc-|one-time-code|current-password|new-password)/.test(autocomplete)) return true;
  const raw = `${field.name ?? ''} ${field.id ?? ''}`;
  // Split camelCase and separators into words, so "userPin" and "otp_code" match but "shipping" does not.
  const hints = raw.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  if (hints.split(/[^a-z0-9]+/).some((word) => SECRET_WORDS.has(word) || word.startsWith('password'))) return true;
  return /card.?num|cc.?num|cc.?number|cvc|cvv|csc|security.?code|card.?code|expiry|exp.?date|iban|verification.?code|auth.?code|one.?time/.test(hints);
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'email', 'search', 'tel', 'url', 'number', 'password', 'date', 'datetime-local', 'month', 'time', 'week']);

/** Accepts typed text: a text-like `<input>`, a `<textarea>` or a content-editable element, not read-only. */
export function isEditableField(field: FieldAttributes & { readonly?: boolean; contenteditable?: string | null }): boolean {
  const tag = field.tag.toUpperCase();
  if (tag === 'TEXTAREA') return !field.readonly;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((field.type ?? '').toLowerCase()) && !field.readonly;
  const editable = field.contenteditable;
  return editable !== null && editable !== undefined && editable !== 'false';
}
