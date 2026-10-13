# Re-review: continuation drop fix (fresh context, read-only)

Method: read only. Bash fails with ENAMETOOLONG, so no gates were run; the gate results are from the fullstack report. `.env` not opened, no source edited.

## B-1 (earlier blocker): fixed
- Dequeue happens only on `message.completed` / `chat.error setup_result_delivered` (use-chat.ts:499), 409 `continuation_sent` (:562-569) and 400/403/404/410 before a response (:583-588). The first-frame and clean-close dequeues are gone.
- Every other path holds the item: `chat.error`/`chat.stopped` (:505-510), early close (:534-539), AbortError (:546-551), in-progress window over (:578), and any other error (:590). The reconcile restores "Continue" (:388-391).
- `settle()` runs before the epoch check (:499-500), so a delivery proof that arrives after a switch still dequeues.
- A `setup_result_delivered` frame whose `recovery_action` does not match falls back to `runtime_request_failed` (chat-events.ts:119). The item is then held, and a resend gets a silent `continuation_sent`, so this fails safe. Dewee's test confirms the pair `setup_result_delivered`/`continue_in_chat`.

## Invariants
1. Holds. User text is resent only through `retry` (:732-735).
2. Holds, but see S-1 on whether the refusal is shown in a useful way.
3. Holds. The queue filters on profile, workspace, agent and session (:670-672). The item's `agent_key`/`session_key` override the context's (:472, :492). "Continue" runs only on a bubble of the shown session.
4. Holds. A held item is never auto-sent (:679). The in-progress retries are bounded (:299). Residual: see N-4.
5. Holds. `sleep` timers are cleared on unmount (:275-287, :742-750). The queue timer has an effect cleanup (:689), and the storage listener is removed (:435). The `waitForOnline` interval still lasts up to 2 s after unmount; this predates the change and was accepted.
6. Holds. Storage keeps only the IDs plus an optional boolean `held` (pending-continuations.ts:15). The threat model is updated (credential-threat-model.md:25).

## Checks requested
- Two-panel held/onChanged race:
  - The logic is safe. A's `hold` writes `held:true`, and B's `enqueue` adds it to `heldRef` (:234). B's pending in-progress timer then fires, but the effect excludes held items (:679), so there is no auto-resend.
  - If the lease is released before A's write lands, B's retry can deliver. That is a legitimate delivery, and it dequeues.
  - The held flag is sticky: an unheld copy never clears B's `heldRef`. This is conservative (see N-2).
- Stop after `chat.started` keeps the item, both through `chat.stopped` and through AbortError (:505-510, :546-551). Test at use-chat.test.tsx:1167 asserts stored `held:true` and no resend.
- `continuation_sent` is silent: it returns at :562 before `notReceived`, and :105 excludes it. The test at :1358 records every render and finds no error.
- i18n: the vi strings have full diacritics (i18n.ts:260, 277-280, 300, 308-311).
- No regressions found: `notReceived` and its transport codes (:100-109), the anchor/baseline proof (:173-183), per-key storage (pending-continuations.ts:35-41), respond-time scope plus explicit agent and session capture (ChatShell.tsx:106-110, :127), and the timer clearing (N-3 from the last review).

## Blocking
None.

## Should-fix
**S-1. A dead 400 (and 403) is dropped behind a misleading message, and a client bug leaves no trace.** use-chat.ts:583-588, :558; i18n.ts:114/300.
- Dewee answers 400 to a continuation only for a malformed request: a bad UUID, `setup_handoff` together with `setup_action_id`, or an empty body (provisioning_chat_setup_turn.go:108; the sqlite tests at :111-117). That is a client bug, and resending the same bytes can never succeed, so dropping the item is correct.
- The problem is what the person sees: "The request was rejected. Check the values and try again." There are no values to check and no button. Nothing tells them the agent never got the card result, so the setup silently stalls.
- Nothing is logged: `console.error` fires only when `apiError.cause` is set, which it is not for a 400. The bug stays invisible in devtools.
- 403 `scope_required` and `owner_binding_required` can be fixed by the person (by fixing their key), so the item is not truly dead for them.
- Fix:
  - Show a dedicated `continuation_refused` text (en and vi): "The agent did not receive this card's result; tell it in the chat."
  - `console.warn` the status and code (IDs only) for a 400.
  - Optionally hold, rather than drop, a 403 whose code is a key or scope problem.

## Nits
- **N-1. Unmount and a conversation switch handle a mid-stream continuation differently.** (:544 vs :546-551)
  - On a switch, the epoch check at :544 returns before `hold`, so the item stays unheld and is auto-sent on return.
  - On unmount the epoch is unchanged, so the AbortError path holds the item (`mountedRef` is not checked). A reopened panel then shows "may not have received" with "Continue" instead of resuming.
  - This is safe, but architecture.md:42 says "reopening the session sends what is pending". Skip `hold` when `!mountedRef.current`, or document the behaviour.
- **N-2. A "Continue" bubble can go stale in another panel.**
  - `enqueue` never clears `heldRef` when an unheld copy arrives (:231-235).
  - `forget` does not remove a "Continue" bubble that is already rendered (:246-251). After another panel delivers the item, clicking that bubble drops it and then does nothing (`doneRef` at :651).
  - This is benign. Optionally drop the bubbles that carry that `setup_action_id` in `forget`.
- **N-3. Missing tests.**
  - The two-panel case where B is in the in-progress backoff and A writes `held` (B must stop auto-resending).
  - Unmount while a continuation streams.
  - Reading the code, both behave as described above, but neither is asserted.
- **N-4. Each panel open restarts the 11-minute in-progress window.** `waitRef` is in memory only (:225, :296), so an unheld item that is waiting gets a fresh window every time a panel opens. This is bounded by the number of reopens. It is not listed among the residuals in architecture.md:42.

Status: DONE_WITH_CONCERNS
Summary: B-1 is fixed. A continuation leaves the queue only on `message.completed`, `continuation_sent`, `setup_result_delivered` or 400/403/404/410, and is otherwise held with "Continue", including Stop after `chat.started`. All six invariants hold, `continuation_sent` is silent and the vi strings are correct.
Concerns/Blockers: S-1: the dead-refusal drop (a 400 is a client bug) shows a misleading message and logs nothing. Gates were not re-run because the shell fails with ENAMETOOLONG.
