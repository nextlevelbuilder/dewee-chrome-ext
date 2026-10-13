/**
 * Plain-text views of a tool call's input and output, and of the agent's reasoning, for the optional
 * details display. Values that look like credentials are replaced before the text reaches chat
 * state, and every text is clipped so a large result cannot bloat the panel. Redaction is best
 * effort: it recognises common names and formats, not every secret.
 */

/** Longest detail text kept per field; the rest is cut with a marker. */
export const DETAIL_LIMIT = 4000;
const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

/**
 * A name whose value is a credential: `password`, `client_secret`, `GITHUB_TOKEN`, `accessToken`,
 * `x-api-key`. Plurals and other words that merely contain one (`max_tokens`, `bypass`, `agent_key`)
 * are not.
 */
const SECRET_NAME = /(?:password|passwd|_pwd)$|(?:^|[_.-])(?:pass(?:word|wd|phrase)?|pwd|secret|token|api_?key|access_?key|secret_?key|private_?key|credentials?|cookie|authorization|session_?id)$/i;

export function isSecretName(name: string): boolean {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/^-+/, '').replace(/-/g, '_');
  return SECRET_NAME.test(snake);
}

const ASSIGNMENT = /(["']?)([A-Za-z][\w.-]*)\1(\s*[=:]\s*)(?!\[redacted\])("[^"]*"|'[^']*'|[^\s,;&"'}\]]+)/g;
const CLI_FLAG = /(^|\s)(--?[A-Za-z][\w-]*)(\s+)(?!\[redacted\])("[^"]*"|'[^']*'|[^\s-]\S*)/g;
/** Header values; Basic and token values must look encoded so prose such as "Basic authentication required" stays. */
const AUTH_SCHEME = /\b(?:[Bb]earer\s+[\w~+/.=-]{8,}|Basic\s+(?=[\w+/=]*[A-Z\d+/=])[\w+/=]{8,}|[Tt]oken\s+(?=[\w.-]*\d)[\w~+/.=-]{16,})/g;
const URL_USERINFO = /\b([a-z][\w+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const KNOWN_KEY = /\b(?:sk-(?:ant-|proj-)?|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abps]-|AKIA|AIza)[\w-]{8,}/g;

/**
 * `name=value` and `"name": "value"` pairs. A pair whose name is harmless (`https:`, `Error:`) is
 * skipped past its name only, so a secret inside its value (`?token=…`, `Error: TOKEN=…`) is still seen.
 */
function redactAssignments(text: string): string {
  const pattern = new RegExp(ASSIGNMENT.source, 'g');
  let out = '';
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [whole, quote = '', name = '', separator = ''] = match;
    if (isSecretName(name)) {
      out += `${text.slice(last, match.index)}${quote}${name}${quote}${separator}${REDACTED}`;
      last = match.index + whole.length;
    } else {
      pattern.lastIndex = match.index + quote.length + name.length;
    }
  }
  return out + text.slice(last);
}

/**
 * Hides credentials inside free text such as a shell command or an error: `--api-key VALUE`,
 * `GITHUB_TOKEN=VALUE`, `"password": "VALUE"`, `?token=VALUE`, `Bearer VALUE`,
 * `https://user:pass@host` and well-known key prefixes.
 */
export function redactText(text: string): string {
  return redactAssignments(text.replace(URL_USERINFO, `$1${REDACTED}@`).replace(AUTH_SCHEME, REDACTED))
    // A space-separated value only counts after a CLI flag (`--token VALUE`), not in prose ("token expired").
    .replace(CLI_FLAG, (match, lead: string, flag: string, separator: string) => (isSecretName(flag) ? `${lead}${flag}${separator}${REDACTED}` : match))
    .replace(KNOWN_KEY, REDACTED);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isSecretName(key) ? REDACTED : redactValue(item, depth + 1)]));
}

export function clip(text: string, limit = DETAIL_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

/** Tool arguments as indented JSON with credential-like values replaced; undefined when there are none. */
export function formatToolInput(args: Record<string, unknown> | undefined): string | undefined {
  if (!args || Object.keys(args).length === 0) return undefined;
  try {
    return clip(JSON.stringify(redactValue(args), null, 2));
  } catch {
    return undefined;
  }
}

/** A result, error or reasoning text, redacted and clipped; JSON text is redacted field by field. Undefined when empty. */
export function formatToolText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  if (/^[[{]/.test(trimmed)) {
    try {
      return clip(JSON.stringify(redactValue(JSON.parse(trimmed)), null, 2));
    } catch {
      // Not JSON after all: fall through to text redaction.
    }
  }
  return clip(redactText(trimmed));
}
