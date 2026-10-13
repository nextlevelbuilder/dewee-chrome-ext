# Re-review: retry policy, continuation queue, stopped marker

Method: I only read the code, because Bash failed with ENAMETOOLONG. No gates were run, and I did not open `.env`. I read use-chat.ts, chat-state.ts, history.ts, pending-continuations.ts, errors.ts, dewee-client.ts, ChatShell.tsx, components/MessageList.tsx, Composer.tsx, i18n.ts, schemas.ts, the docs, the test titles and key bodies, and dewee `internal/http/provisioning_chat_setup_turn{,_lease}.go`.

## Previous findings
- X-1 fixed. The baseline now has an anchor (use-chat.ts:116-128), and holdsTurn needs the anchor in place (:137-146). History throws `history_changed` and never returns `[]` (history.ts:47). A null history keeps the turn unconfirmed (:298-302). The compaction it.each is at use-chat.test.tsx:799-816.
- X-2 fixed. Continuations are queued by id, with no overwrite (:190-199), persisted (:186), sent only to their own session (:499-502), and kept across a switch or unmount (:331, :427). Two caveats are listed under S-4 and S-5.
- S-1 fixed: a 5xx is not a refusal (:70). S-2 fixed: a null baseline is never "delivered" (:138). S-3: the tests exist (:158, :233, :384, :503, :527, :561, :799).
- Nits:
  - N-c fixed: 'send' clears only `retryText` (chat-state.ts:219).
  - N-d fixed: en and vi are reworded (i18n.ts:104 and :287, full diacritics).
  - N-e fixed: focus moves to the log (MessageList.tsx:100-107).
  - N-f fixed by the session filter.
  - N-b is documented (architecture.md:40).

## Invariants
1. Holds. A user message is resent only by `retry` (:537-551), and it is offered only when `notReceived` (:64-73) holds.
2. Holds, apart from the documented compaction duplicate and the identical-text risk. An uncertain turn is marked `local` (chat-state.ts:237-239), survives the 'history' fold (:203), and is settled once (use-chat.ts:297-304).
3. Partly holds. The at-most-once delivery matches the doc (api-contract.md:154), but see S-4 for what a 409 really means on the Gateway.
4. Holds. There is one owner (:261-263 and :307), and the switch, reload and runStream guards are at :328, :528 and :361. The waits are bounded: `waitForOnline` takes at most 2 s, the sleep at most 15 s, and the stop grace 5 s, and none of them writes state.
5. Holds. Only IDs are stored (pending-continuations.ts:13), `storage.session` uses the default trusted access level, and logs carry only the cause (:433).
6. Holds. An injected assistant message becomes an empty `stopped` reply, and other injected messages are dropped (chat-state.ts:110-112). MessageItem shows only "Stopped" (MessageList.tsx:66 and :73).

## Blocking
None.

## Should-fix

**S-4. A 409 on a continuation is not proof of delivery, and the code name is unverified.**
- Where: use-chat.ts:69 and :438-439; architecture.md:42; pending-continuations.ts:5.
- What the Gateway does: in dewee `provisioning_chat_setup_turn_lease.go:160-171`, a mark held by a live sender also returns 409, not only a delivered mark. If that run then fails before the result reaches the session, `release()` (:114-125) clears the mark so the continuation can be sent again.
- Scenario: two windows each show the panel, or the panel reopens while the old request's handler still holds the lease. Both auto-send the same continuation. The second request gets the 409 and dequeues the item into `doneRef`. The first run then fails and releases the mark. Nobody sends the continuation again.
- Code name: the same route answers with code `FAILED_PRECONDITION`, not `continuation_sent` (:170 and :178). The `/v1/extension` mapping is in the open PR dewee#1022, which I could not check.
  - If the code is passed through, `notReceived` treats it as a refusal (use-chat.ts:69). The panel then offers "Continue", which fails with the same 409 every time.
- Fix:
  - Confirm that dewee#1022 maps both 409 cases to `continuation_sent`, or match on the reason instead of the code.
  - On `continuation_sent`, keep the item until a reconcile's history load. Dequeue only when the card is not pending, or let the next auto-send settle it.
  - Fix the doc wording "refuses a repeat" (architecture.md:42) to cover the in-flight case.

**S-5. Two panels overwrite each other's stored queue.**
- Where: use-chat.ts:186-188 and :194; pending-continuations.ts:22-25.
- Cause: each side panel instance (one per window) writes its whole in-memory `queueRef`. The last writer wins.
- Scenario: window A queues X. Window B then dequeues its own Y and writes `[]`, which removes X from storage. If panel A closes before it sends X, X is lost. This is the same loss as X-2 Scenario B, now across windows.
- Fix: read, merge and write on each change (add or remove by `setup_action_id`), or move the queue into the background service worker as its single owner.

**S-6. A continuation can be tagged with the wrong workspace after a switch.**
- Where: ChatShell.tsx:106-109; use-chat.ts:483-486.
- Cause: `continueWith` takes `workspace_id` from `ctxRef` when the call is made, not from the request.
- Scenario: the person switches workspace while `respond` is in flight. The item stores the new workspace with the old session. It never matches the filter (:500), so it is never sent and stays in storage.
- Fix: pass the respond-time `workspaceId` into `continueWith`, for example with an optional `workspaceId` argument.

## Nits
- **N-1. A stopped continuation can be dropped unsent.** Stop during the 5 s grace, before any response, aborts the fetch, and the AbortError path dequeues it (use-chat.ts:427). The continuation may never have reached the server, and its card is already resolved. This is the accepted "stopped is dropped" decision, but the doc should say that this can lose the card's result.
- **N-2. A new chat's baseline has no anchor.** It is `{position:-1}` (:400). It is only refreshed by a history load, which does not happen after the session key is adopted (:323). Long chats started in the panel therefore fall back to a text match without an anchor. The risk is low because `slice(confirmed)` usually empties the list.
- **N-3. Injected user turns are counted.** `holdsTurn` counts them in `after` and `slice(confirmed)` (:144), although `fromHistory` drops them (chat-state.ts:110). A server-written user turn shifts the confirmed count.
- **N-4. The docs contradict each other.**
  - api-contract.md:92 says runtime-injected turns are "never returned", but :94 documents `injected: true`.
  - architecture.md:44 says "Nothing is sent automatically", but :42 auto-sends pending continuations on reopen.
- **N-5. A refused send loses the typed text (pre-existing).** If `runStream` refuses silently (:361), for example because an auto-sent continuation won the same tick, Composer has already cleared the text (Composer.tsx:12-14).
- **N-6. Queue items are keyed by workspace id only, not by profile or origin** (pending-continuations.ts:13). Collisions are unlikely.

Status: DONE_WITH_CONCERNS
Summary: X-1, X-2, S-1 to S-3 and the nits are fixed with real tests, and invariants 1, 2, 4, 5 and 6 hold. Invariant 3 has gaps: a Gateway 409 also means "in flight" (a lease can be released later), panels in different windows overwrite the shared stored queue, and a workspace switch during respond mis-tags a continuation.
Concerns/Blockers: Shell broken, so no gates were run. The `continuation_sent` code for `/v1/extension` (dewee#1022) is not in the local dewee checkout; the provisioning route there returns `FAILED_PRECONDITION`.
