# Final review: continuation hardening (fresh context)

Method: I reviewed by reading only. Bash fails with ENAMETOOLONG, so I ran no gates; the gate results come from the fullstack report. I did not open `.env` or edit source.
Read: use-chat.ts, pending-continuations.ts, chat-state.ts, ChatShell.tsx, components/Composer.tsx, errors.ts, i18n keys, the docs (continuation sections) and the new tests. Backend: dewee `internal/http/provisioning_chat_setup_turn{,_lease}.go` (local checkout; PR #1022 itself is not local).

## Earlier findings
- S-4: in_progress is kept and retried (use-chat.ts:501-513), continuation_sent leaves the queue (:516), and an unknown 409 is kept (:99, :521). The bounded window is at :253-264. One gap remains: see B-1.
- S-5 fixed: one key per item, with no read-modify-write (pending-continuations.ts:34-40). onChanged is subscribed and unsubscribed (:45-57, use-chat.ts:394). `doneRef` stops a late `added` event from bringing a delivered item back (:223).
- S-6 fixed: the scope is captured when respond starts (ChatShell.tsx:106-107) and passed on both paths (:112, :124).
- N-1, N-3, N-4, N-5 and N-6 are fixed: use-chat.ts:486-491, :175, the docs, Composer.tsx:13 with ChatShell.tsx:293, and pending-continuations.ts:18-19.
- No regressions: X-1 anchor (:169-173), X-2 queue by id (:220-229), S-1 5xx not a refusal (:100), S-2 null baseline never delivered (:168).

## Invariants
1. Holds. A user message is re-sent only through `retry` (:647-650), a user action.
2. Does not fully hold. See B-1.
3. Holds. Each item has its own key, removals arrive through onChanged, and the queue effect filters on session, agent, profile and workspace (:587-594).
4. Holds, with the two short timers noted in N-3. The storage listener is removed on unmount, and the retry timer is cleared by the effect cleanup (:604).
5. Holds. Zod strips unknown keys, so only the five IDs are stored (pending-continuations.ts:14).
6. Holds. The retry runs only when phase is idle and the item's own session is shown (:583-594), and the window is bounded (:258). A Retry-After hint is capped at 3600 s (errors.ts:49, :73).

## Blocking
**B-1. A continuation is dropped as soon as any frame arrives, but the Gateway frees it for a retry when the run fails before the result is saved.**
- Where:
  - use-chat.ts:448 (dequeue on the first frame), :477 (a clean close without a terminal frame) and :516-517 (`responded` and `afterResponse` count as delivered).
  - architecture.md:42 and api-contract.md:154 ("an item leaves the queue when the server answered").
- What the Gateway does: in dewee `provisioning_chat_setup_turn.go:55-73`, `runFailed(inSession=false)` calls `lease.release()` when the loop fails to resolve or the first model call fails (provider error, rate limit, exhausted credit). The continuation can then be sent again.
- Scenario: `chat.started`, then `chat.error` (e.g. `rate_limited`). The item has already been dequeued and removed from storage, and the card is resolved. The reply shows only the error, with no "Continue". The agent never receives the card result, which breaks invariant 2. A drop after the response has the same problem: the reconcile gives no "Continue" (:535-537).
- Fix: dequeue only on `message.completed` or 409 `continuation_sent`. On `chat.error`, a close without a terminal frame or `afterResponse`, keep the item and hold it with "Continue" (`retryContinuation`). Re-sending is safe: a delivered result answers 409 `continuation_sent`, and a live run answers `continuation_in_progress`.
- Also: add a test for `started` then `chat.error` on a continuation that asserts the item stays stored. Update the two doc sentences.
- Caveat: this assumes the `/v1/extension` stream in dewee#1022 sends `chat.started` before the first model call, as the provisioning route's run does. Confirm this; if it does not, downgrade to should-fix.

## Should-fix
None beyond B-1.

## Nits
- **N-1. A refusal that can never succeed keeps the item forever and re-sends it on every visit.**
  - Where: use-chat.ts:386 (`heldRef` is reset on every switch), :521 and :259.
  - Effect: a held item (404 action gone, 403, 400, or an in-progress item past its window) is sent automatically again each time its session is reopened or the panel reopens, and each time starts a fresh 11-minute window. It leaves storage only when the browser restarts.
  - Fix: drop on 404/410, or document this as a residual in architecture.md:42.
- **N-2. A benign 409 `continuation_sent` shows an error bubble.**
  - Where: use-chat.ts:535-537.
  - Effect: the losing panel in a two-panel race briefly shows "The agent already continued" until the reconcile's history fold removes the bubble.
  - Fix: on `continuation_sent`, drop the turn and reload quietly instead of `streamFailed`.
- **N-3. Two short timers are not cleared on unmount** (strict reading of invariant 4).
  - The Stop grace `setTimeout` (use-chat.ts:614) lasts at most 5 s.
  - The reconcile sleep (:342) lasts at most 15 s.
  - Neither writes state after unmount, so the impact is nil. Clear them, or record them as accepted.
- **N-4. The replay path builds the continuation from the panel's current agent.**
  - Where: ChatShell.tsx:124 (from before this change).
  - Effect: if the card's real continuation targets another agent or session, the Gateway refuses it and the item is held as in N-1.
  - Fix: prefer reading `continuation` from the refreshed action, if the actions API returns it.

## Docs and tests
- The docs match the code apart from B-1's "server answered" rule. The credential threat model lists the profile id (credential-threat-model.md:25).
- The tests are behavioural, not phantom. The backoff, hint, window, hidden-session wait, unknown 409, Stop before and after an answer, scope, cross-profile, two-panel and refused-send cases are all asserted on calls and on storage (use-chat.test.tsx:1019-1252).
- Missing: a test for a continuation that ends with `chat.error` after `chat.started`.

Status: DONE_WITH_CONCERNS
Summary: S-4 to S-6 and N-1, N-3 to N-6 are fixed with real tests, with no regressions to X-1, X-2 or S-1 to S-3. One blocking gap: a continuation is dequeued on the first frame, but the Gateway releases the lease when the first model call fails, so a `chat.error` after `chat.started` loses the card result.
Concerns/Blockers: B-1 depends on dewee#1022's stream order (not local). The shell is broken, so no gates were run here.
