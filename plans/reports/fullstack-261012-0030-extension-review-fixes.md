# Fixes for the final review (should-fix and nits)

Source: `plans/reports/code-reviewer-261012-0020-extension-final-review.md`. Not committed. The SSE buffer cap was left alone (tracked in #2).

## Should-fix items

1. **Failures before and after the response** (`src/api/errors.ts`, `src/api/dewee-client.ts`, `src/chat/use-chat.ts`, `src/chat/chat-state.ts`, `MessageList.tsx`, i18n)
   - `DeweeApiError.afterResponse` is true only for status-0 failures after a 200.
   - Panel-only failures (background or credentials unavailable, or a rejected fetch in a new chat) keep "Send again".
   - A delivered turn (`chat.started` or `afterResponse`) reconciles with no retry.
   - An uncertain failure in a known session (a rejected fetch, a stall before the response, or a 409) reconciles, then puts the turn back with its retry if the history lacks it (`restoreTurn`).
   - Polling pauses while `navigator.onLine === false` and resumes on `online`. The panel shows "You are offline. The reply will load when the connection is back."
   - Tests, in `tests/integration/chat/use-chat.test.tsx`, describe "useChat pre-send and post-response failures":
     - keeps "Send again" when the request never left the panel; keeps "Send again" after a rejected fetch in a new chat
     - reconciles a drop after the server answered, with no retry
     - restores an undelivered turn ... (rejected fetch, stall, 409); does not restore a turn the server history already holds
     - sends offline in an existing chat ...; pauses reconnect polling while offline and resumes on the online event
   - Mutations: M1 (old status-0 rule) 1 fail, M2 (`afterResponse` ignored) 2 fail, M3 (no restore) 4 fail, M4 (offline ignored) 2 fail. All caught.
2. **New chat drops after 200 but before `chat.started`.**
   - Behaviour: no "Send again" and no auto-select. The panel shows `error.delivery_unconfirmed`: the message may still be answered, so check the conversation list first.
   - Why: a retry could run the message twice, and picking the newest session could open a chat from another tab or device. A message cannot misroute anything.
   - Test: "does not offer "Send again" when a new chat drops after the server answered, before chat.started". Covered by M2.
3. **Narrower catch-all** (`dewee-client.ts`)
   - Only `TypeError`, or a `DOMException` named NetworkError, from the body read becomes `connection_lost`. Anything else is rethrown unchanged.
   - Tests:
     - "surfaces a non-network error from the body unchanged ..."
     - "surfaces an auth adapter bug unchanged"
     - before and after response `afterResponse` cases
   - Mutations: M5 1 fail, M6 2 fail.
4. **Lenient `details`** (`errors.ts`)
   - `details` is `z.unknown()`; the reason is promoted only when `{reason:string}` names a known reason.
   - Test: `it.each` "keeps the envelope code, message and retry when details is" null, a string, an array, a non-string reason or an overlong reason.
   - Mutation: M7 5 fail.
5. **CredentialsForm**
   - Values and the missing list are cleared during render when the card stops being interactive.
   - Tests: the revoke test asserts that no secret is left in the DOM; new test "drops typed values when the card closes without a submit".
   - Mutation: M8 1 fail.
6. **Live host guard** (`tests/e2e/support/live-host-guard.ts`)
   - `live.ts` skips non-loopback `E2E_GATEWAY_URL` unless `E2E_ALLOW_REMOTE=1`, and `admin()` throws as well.
   - `live-cloud.spec.ts` applies the same check to `E2E_CLOUD_ORIGIN`.
   - The refusal message never echoes the URL.
   - Test: `tests/unit/e2e-support/live-host-guard.test.ts`.
   - Mutation: M9 6 fail.
7. **Revoke e2e** (`live-credentials.spec.ts`): asserts the exact `credential_policy_revoked` text, with a comment naming dewee PR #1019.
8. **Docs**
   - `api-contract.md`: revoke is a 409 with `error.details.reason: "credential_policy_revoked"`, and malformed `details` keeps the envelope code.
   - `architecture.md`: the Chat paragraph is updated.
   - `development.md`: adds `E2E_ALLOW_REMOTE`.

## Nits

- **B4:** the throwaway key is revoked in `finally` if the test fails first.
- **Non-admin live skip:** now also requires `E2E_WORKSPACE_ID`.
- **`connection_lost` code:** added with en and vi strings, plus `delivery_unconfirmed` and `chat.offlineWaiting`.
- **`watchLeaks`/`assertNoLeak`:** also checks the respond URLs, raw and encoded, for the sentinel.

## Gates

- `pnpm lint`: clean.
- `pnpm typecheck`: clean.
- `pnpm test`: 23 files and 281 tests passed.
- `pnpm build`: OK (599 kB).
- `pnpm test:e2e` with `.env` moved to the scratchpad unread, inside try/finally: 5 passed, 16 live tests skipped.
  - `.env` was restored.
  - `test-results`, `playwright-report` and `.output-e2e` were removed.
- Mutations: 9 of 9 caught. The script backs up and restores each file; the tree is unchanged afterwards.

Status: DONE_WITH_CONCERNS
Summary: All 8 should-fix items and the nits are fixed, each with tests that fail under a matching mutation. All gates and the smoke e2e pass.
Concerns/Blockers:
- The live specs were not run.
  - E1 and the resilience offline assertions now expect the new offline text.
  - E1's rejected fetch now reconciles rather than retrying.
- The revoke e2e needs dewee#1019 deployed.
- `E2E_DB_DSN` is not host-checked.
