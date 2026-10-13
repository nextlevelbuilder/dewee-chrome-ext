import type { RespondBody } from '@/api/dewee-client';
import type { RespondResult } from '@/api/schemas';
import type { UiActionCard } from '@/protocol/ui-action';

export type RespondOutcome = { ok: true; result: RespondResult } | { ok: false; code: string; retryAfterSeconds?: number };

/**
 * Answers one card. Implementations send `body` straight to the respond endpoint and must not
 * keep, log or forward it (it may contain `secret`).
 */
export type RespondFn = (card: UiActionCard, body: RespondBody) => Promise<RespondOutcome>;
