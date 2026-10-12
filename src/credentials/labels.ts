/**
 * Labels for credential cards come from the extension's own copy, keyed by target type and field
 * key. The agent-supplied label is never shown, so an agent cannot word a field to phish for a
 * different secret than the one the Gateway will store.
 */
import { hasMessage, type Translate } from '@/shared/i18n';

export function targetLabel(t: Translate, type: string, name?: string): string {
  const key = `target.${type}`;
  return hasMessage(key) ? t(key, { name: name ?? '' }).trim() : `${type} ${name ?? ''}`.trim();
}

export function fieldLabel(t: Translate, fieldKey: string): string {
  const key = `secret.field.${fieldKey}`;
  return hasMessage(key) ? t(key) : t('secret.field.generic', { key: fieldKey });
}
