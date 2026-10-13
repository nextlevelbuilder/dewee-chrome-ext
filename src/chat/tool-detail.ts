/**
 * Plain-text views of a tool call's input and output for the optional "tool call details" display.
 * Values under credential-like keys are replaced before the text reaches chat state, and every
 * text is clipped so a large result cannot bloat the panel.
 */

/** Longest detail text kept per field; the rest is cut with a marker. */
export const DETAIL_LIMIT = 4000;

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|credential|private[-_]?key|cookie/i;

export function clip(text: string, limit = DETAIL_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

/** `--api-key VALUE`, `token=VALUE`, `Bearer VALUE` and `sk-…` style keys inside free text such as a shell command. */
const SECRET_IN_TEXT = /((?:--?|\b)(?:pass(?:word)?|secret|token|api[-_]?key|private[-_]?key)\s*[=: ]\s*)("[^"]*"|'[^']*'|\S+)|(\bBearer\s+)\S+|\bsk-[A-Za-z0-9_-]{12,}/gi;

export function redactText(text: string): string {
  return text.replace(SECRET_IN_TEXT, (match, flag?: string, _value?: string, bearer?: string) => (flag ? `${flag}[redacted]` : bearer ? `${bearer}[redacted]` : '[redacted]'));
}

function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1)]));
}

/** Tool arguments as indented JSON with credential-like fields replaced; undefined when there are none. */
export function formatToolInput(args: Record<string, unknown> | undefined): string | undefined {
  if (!args || Object.keys(args).length === 0) return undefined;
  try {
    return clip(JSON.stringify(redact(args), null, 2));
  } catch {
    return undefined;
  }
}

/** A result or error string, trimmed and clipped; undefined when empty. */
export function formatToolText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? clip(redactText(trimmed)) : undefined;
}
