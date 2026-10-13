/**
 * One error type for every transport failure. `code` is the server's error code (see
 * docs/api-contract.md) or a client code: `network_error` (rejected fetch), `timeout`,
 * `invalid_response`, `stream_stalled`, `connection_lost`, `runtime_request_failed` (a client
 * fault after the stream answered), `history_changed` (the history kept shrinking while it was
 * read), `not_connected`, or a background code such as
 * `background_unavailable`. Messages never contain request bodies or credentials.
 */
import { z } from 'zod';

export type ErrorKind = 'auth' | 'forbidden' | 'not_found' | 'conflict' | 'rate_limited' | 'invalid' | 'server' | 'network';

export class DeweeApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;
  /**
   * A transport failure (status 0) that happened after the server answered 200: the request was
   * accepted, so it must be reconciled, never sent again. False for failures before any response.
   */
  readonly afterResponse: boolean;

  constructor(status: number, code: string, message: string, retryAfterSeconds?: number, afterResponse = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DeweeApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.afterResponse = afterResponse;
  }

  get kind(): ErrorKind {
    if (this.status === 0) return 'network';
    if (this.status === 401) return 'auth';
    if (this.status === 403) return 'forbidden';
    if (this.status === 404) return 'not_found';
    if (this.status === 409) return 'conflict';
    if (this.status === 429) return 'rate_limited';
    if (this.status >= 500) return 'server';
    return 'invalid';
  }
}

const envelope = z.object({
  error: z.object({
    code: z.string().max(80),
    // Optional siblings are dropped when malformed, so they never cost the code or `details.reason`.
    message: z.string().max(500).optional().catch(undefined),
    retry_after_seconds: z.number().int().positive().max(3600).optional().catch(undefined),
    // Parsed on its own below: a malformed `details` must not cost the code, message and retry.
    details: z.unknown().optional(),
  }),
});

const detailsReason = z.object({ reason: z.string() });

/** `error.details.reason` values that name the refusal more precisely than `error.code`. */
const specificReasons = new Set(['credential_policy_revoked']);

const statusCodes: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'invalid_request',
  429: 'rate_limited',
};

function retryAfterHeader(response: Response): number | undefined {
  const raw = response.headers.get('Retry-After');
  const seconds = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : undefined;
}

/** Builds the error for a non-2xx response from its envelope, falling back to the status. */
export async function errorFromResponse(response: Response): Promise<DeweeApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error bodies (proxies, HTML pages) are ignored: only the status is trusted.
  }
  const parsed = envelope.safeParse(body);
  const fallbackCode = statusCodes[response.status] ?? (response.status >= 500 ? 'runtime_unavailable' : 'request_failed');
  if (parsed.success) {
    const { code, message, retry_after_seconds, details } = parsed.data.error;
    const detail = detailsReason.safeParse(details);
    const specific = detail.success && specificReasons.has(detail.data.reason) ? detail.data.reason : code;
    return new DeweeApiError(response.status, specific, message ?? code, retry_after_seconds ?? retryAfterHeader(response));
  }
  return new DeweeApiError(response.status, fallbackCode, `HTTP ${response.status}`, retryAfterHeader(response));
}

export function isApiError(value: unknown): value is DeweeApiError {
  return value instanceof DeweeApiError;
}
