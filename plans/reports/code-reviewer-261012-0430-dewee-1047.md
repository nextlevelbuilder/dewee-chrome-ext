# Review: dewee d3db3f74 (#1047 continuation_in_progress vs continuation_sent)

Method: read-only review of the files in the worktree (the shell failed with ENAMETOOLONG, so `git show` and the tests were not run).

## Verdict
No blocking findings. The logic is sound and the store code is tenant-scoped. PG and SQLite match. Browser and HMAC routes do not leak the new fields. There are 2 test gaps (should-fix) and 4 nits.

## Race / TOCTOU (provisioning_chat_setup_turn_lease.go:160-186)
- The holder releases between Mark/Reclaim and the delivered read, so the mark is NULL. The read returns false and the caller gets `in_progress`. The retry's Mark then wins. This is the correct outcome.
- The holder finalizes between Reclaim and the read, so the read sees the sentinel and the caller gets `sent`. Correct.
- A wrong `sent` cannot happen. The sentinel is written only after a confirmed delivery (lease.go:145) or after a session check (lease.go:187-189). The read is a single statement, so it cannot report a half-written state.
- A wrong `in_progress` is harmless. The worst case is a dead holder whose mark is not yet stale: clients retry every 5 s for up to 10 min (setupContinuationClaimLease) and are then reclaimed. Nothing is sent twice.
- If the finalize at lease.go:189 fails, the caller still gets `sent`. The mark stays at `now`, so callers get `in_progress` for 10 min, then a reclaim re-checks the session and answers `sent`. Harmless.

## Tenant scoping / SQL
- pg/workspace_setup_actions.go:365-380 and sqlitestore/workspace_setup_actions.go:370-386 both filter `tenant_id AND id` and map no rows to ErrSetupActionNotFound. The conformance test covers the cross-tenant read: workspace_setup_continuation_lease_conformance.go:138. Both backends run that suite (sqlitestore test plus tests/integration for PG).
- The SQL matches: `COALESCE(continuation_sent_at = <sentinel>, false|0)`, with the sentinel formatted the same way the Renew writes are. In SQLite, scanning the int into a bool works.

## Contract isolation
- Browser and HMAC routes render through serr.write -> writeErrorDetails (workspace_setup_handler.go:235), which never serializes `reason` or `retryAfter`. Status and code (409 FAILED_PRECONDITION) are unchanged.
- The extension route sets code, Retry-After and `retry_after_seconds` only when `retryAfter > 0` (extension_api.go:337-352).

## Findings
- should-fix provisioning_chat_setup_turn_lease_sqlite_test.go:63-84: no test asserts `reason == continuation_sent` on the reclaim-in-session path (lease.go:192-194). The existing test only checks the 409 and the message text on the browser route. Add a claim-level check (`serr.reason == setupReasonContinuationSent`, `retryAfter == 0`), or an extension-route case with a stale mark plus the turn already in the session.
- should-fix provisioning_chat_setup_turn_lease_sqlite_test.go:87-95: the browser-route in-progress test checks only the status. Assert that the body has no `retry_after_seconds` or `continuation_in_progress` and that there is no Retry-After header. That pins the "no leak" requirement, which today holds only because write() does not serialize those fields.
- nit provisioning_chat_setup_turn_lease.go:173-176: if the card is deleted between Mark and the read, ErrSetupActionNotFound becomes a 500 (setupInternalErr). Map it to 404, or accept it as an unlikely race.
- nit provisioning_chat_setup_turn_lease.go:165-172: with `sessions == nil`, a stale mark is never reclaimed, so the caller gets `in_progress` with Retry-After forever. Both current callers pass a store (extension_api_chat.go:161, provisioning_chat_setup_turn.go:118), so this is latent only. Consider returning no retry hint when sessions is nil.
- nit provisioning_chat_setup_turn_lease.go:178: reuses MsgSetupActionInProgress ("is still being applied"), which describes applying a card, not sending a continuation. The browser and HMAC message text for this case also changes, though status and code do not.
- nit docs/18-http-api.md:3003-3005: the docs do not say that `in_progress` can last up to the 10 min lease when the sender died. Without that, clients may not bound their retries. Otherwise the docs match the code, and the Errors and CORS sections (3024-3030) already cover `retry_after_seconds` and the exposed Retry-After.

## Tests that do cover both cases
- extension_api_sqlite_test.go:533-574 covers both cases end to end on the extension route: in_progress with header, body and no run, then release, retry and send, then `sent` with no hint.
- lease_sqlite_test.go:100-137 covers the same at the claim level, including a stale reclaim.
- conformance.go:125-154 covers the store read: before and after finalize, cross-tenant, and unsent.
