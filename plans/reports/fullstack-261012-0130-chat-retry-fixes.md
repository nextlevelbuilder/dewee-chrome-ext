# Chat send, reconcile and retry fixes (re-review B-1 to B-6, N-1 to N-5)

Source: `plans/reports/code-reviewer-261012-0100-extension-rereview.md`. Not committed. `.env` not opened. No Playwright run.
Hook tests are in `tests/integration/chat/use-chat.test.tsx`. Mutation runs back up each file, apply one change, run the matching tests and restore the file. All 12 mutations failed at least one test, and the tree was restored.

## Should-fix
- **B-1 single-owner reconcile** (`src/chat/use-chat.ts`)
  - `ownerRef` holds the running loop's identity. `owns()` = still owner, same epoch and mounted.
  - A context switch, unmount or newer loop retires the old loop. A retired loop writes nothing, and only the owner dispatches `idle`.
  - `loadSession(live, key, followRun)`: a reconcile calls it with `followRun=false`. A reopen starts a loop only when none is running.
  - A run still going after 90 fast polls (2 s) is polled every 15 s. The composer stays closed, because I picked a slower poll over a new UI state.
  - 30 failed polls in a row while online end the loop. `send` and `continueWith` refuse to start while a loop owns the conversation.
  - Test: "keeps the conversation busy while a run outlasts the fast polls, and starts no second loop" (fake timers, more than 91 polls).
  - Mutation M1, the old bounded loop: 1 test fails.
- **B-2 baseline instead of text alone**
  - The baseline is the last `m<position>` id from the last history load, plus the user turns confirmed by `chat.started` since. It is copied at send time.
  - A new chat starts at `{position:-1, confirmed:1}`.
  - A turn counts as delivered only when a user turn after the baseline (past the confirmed ones) has the same whitespace-normalised text.
  - When ids are missing, any matching user turn counts. The residual risk is written in a code comment.
  - Tests: "restores a repeated message that the server lacks…", "counts turns the server confirmed since the last history load", "does not restore a delivered turn when another device posted a later one".
  - Mutations: M2, baseline ignored: 2 tests fail. M2b, confirmed count ignored: 1 test fails.
- **B-3 history failure**
  - The turn gets `delivery_unconfirmed` with `recover:'reload'` and no "Send again".
  - `reload()` re-runs the reconcile for that turn instead of dropping it.
  - Test: "shows delivery_unconfirmed with a reload action when the history cannot be read, then settles it on reload".
  - Mutation M3 (retry offered): 1 test fails.
- **B-4 faults after the response**
  - Client: any non-API error after the 200, unless the caller aborted, is thrown as `DeweeApiError(0,'runtime_request_failed',…, afterResponse=true, cause)`. `DeweeApiError` now accepts `cause`.
  - Hook: any received frame marks the turn delivered. A raw error, or an API error with a cause, is logged with `console.error('Chat stream failed', err)`. The request is not logged.
  - Tests:
    - `tests/unit/api/dewee-client.test.ts` "marks a non-network error after the response as accepted…", which replaces the old "unchanged" test.
    - Hook: "reconciles with no retry when a client fault follows the response".
    - Hook: "does not offer "Send again" in a new chat when the client marks a fault…".
  - Mutations: M4, client wrap removed: 1 test fails. M4b, frames ignored: 1 test fails.
- **B-5 new chat, never a duplicate run**
  - A stall, or a fetch rejected while `navigator.onLine !== false`, now gives `delivery_unconfirmed` with `recover:'sessions'`.
  - The "Show conversations" button refreshes and opens the session list (`ChatShell.tsx`, `MessageList.tsx`).
  - "Send again" stays only for a fetch rejected while offline, server refusals and failures in the panel before the fetch.
  - The `delivery_unconfirmed` text (en and vi) is reworded. New i18n keys: `chat.reloadConversation` and `chat.showConversations`.
  - `docs/architecture.md`: the Chat paragraph is rewritten to describe this exactly.
  - Tests: "keeps "Send again" after a fetch rejected while the browser is offline, in a new chat", and it.each "never offers "Send again" in a new chat after…" (rejected fetch while online, stall).
  - Mutations: M5: 2 tests fail. M5b, offline check ignored: 1 test fails.
- **B-6 continuation retry**
  - A continuation that was not proven delivered keeps `retryContinuation` after a reconcile, even when the history fails.
  - A 409 `continuation_sent` counts as delivered.
  - At-most-once delivery is confirmed in the API contract (409 `continuation_sent`, :29 and :152) and in the Gateway lease (`dewee/internal/http/provisioning_chat_setup_turn_lease.go`). api-contract.md:152 now says a manual resend is safe.
  - Test: "keeps a manual retry for a continuation lost before delivery in a known session, and resends it once".
  - Mutation M6: 1 test fails.

## Nits
- **N-1:** `message` and `retry_after_seconds` use `.catch(undefined)`. Test: it.each "keeps the code and details.reason when the envelope has …" (6 cases). Mutation M7: 6 tests fail.
- **N-2:** 4 rejection cases were added to `tests/unit/e2e-support/live-host-guard.test.ts`. They pass. No mutation was run, so the support file shared with the running e2e agent stayed untouched.
- **N-3:** `live-resilience.spec.ts` strips the brackets before `tcpConnect`. Its doc says "plain http on loopback only".
- **N-4:** new tests:
  - "retires a reconcile loop when the session switches…"
  - "drops the offline wait of a conversation that was switched away"
  - "removes the online listener when the panel unmounts during the offline wait"
  - reducer `restoreTurn` tests (4) in `tests/unit/chat/chat-state.test.ts`

  Mutation M9 (loop not retired): 2 tests fail.
- **N-5:** the offline-wait interval also resolves when `!isOffline()`. Test: "resumes when the connection is back even if the online event was missed". Mutation M8: 1 test fails.
- The doc comment at `errors.ts:3` now lists the current client codes.

## Gates
- `pnpm lint`: clean.
- `pnpm typecheck`: clean.
- `pnpm test`: 23 files and 309 tests passed.
- `pnpm build`: OK (601.94 kB).

## Live-spec expectations
- None need editing. E1 and the resilience cases run in known sessions, and those paths are unchanged.
- No spec asserts the `delivery_unconfirmed` text or "Send again" in a new chat.
- Behaviour change to know about: in a new chat, a stall or a fetch rejected while online now shows "may have been delivered" with "Show conversations" instead of "Send again".

Status: DONE
Summary: B-1 to B-6 and N-1 to N-5 are fixed. Each B item has hook, reducer or client tests that a matching mutation breaks (12 of 12 caught). All gates pass.
Concerns/Blockers: These remain:
- Delivery proof relies on `m<position>` ids. With missing ids it falls back to text presence, as documented in a code comment.
- History compaction that renumbers positions could mislead the baseline. This is rare and not handled.
- Live specs were not run here.
