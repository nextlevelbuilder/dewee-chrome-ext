# Final review: chat send, reconcile and retry state machine

Method: I only read the code, because Bash failed with ENAMETOOLONG. Lint, typecheck and tests were not run, and I ran no Playwright. I did not open `.env`. I read use-chat.ts, chat-state.ts, history.ts, dewee-client.ts, errors.ts, chat-events.ts, MessageList.tsx, ChatShell.tsx, both test files and the Dewee history/compaction code.

B-1 to B-6 are in the code as the fix report describes, and each has a real behaviour test (call counts, retry fields, fake timers). None is a tautology. Invariants 1 (no auto-resend), 4 (single-owner loop, no leaks) and 6 (no secrets) hold. Invariants 2, 3 and 5 still have gaps.

## Blocking

**X-1. Server compaction renumbers `m<position>`, so a delivered turn comes back with "Send again" and is shown twice (breaks 2 and 3).**
- Where: use-chat.ts:92-112 and 233-234; history.ts:43-45.
- Server evidence: ids are indices into `GetHistory` (dewee internal/http/sessions.go:228-243). Post-turn summarization calls `TruncateHistory(keepLast)` (dewee internal/agent/loop_history_sanitize.go:314). The indices restart after that.
- Scenario: a long session has baseline position 140. The send hits `stream_stalled`, but the server took the turn. The run ends and compaction keeps the last few messages, so the turn is now `m3`. `holdsTurn` sees no user turn above 140 and dispatches `restoreTurn` with `retry: true`. The history already shows the turn and the panel appends it a second time with "Send again". One click starts a duplicate run.
- The trigger correlates with long sessions, which are the ones that run long and stall. The fix report lists this risk as "not handled", and architecture.md:40 does not record it as accepted.
- Related: `fetchSessionHistory` returns `[]` after two shrink resets instead of failing (history.ts:45). The reconcile then treats an unread history as an empty one. `holdsTurn` is false, so "Send again" appears, and the 'history' dispatch also clears the transcript.
- Fix:
  - Keep an anchor in `Baseline`: the role and normalized content of the message at `position`.
  - If the new history lacks that anchor, or its highest position is below `baseline.position`, settle as `delivery_unconfirmed` with `retry: false`, as the `history === null` branch does.
  - Make history.ts throw instead of returning `[]`.
  - Test both cases.

**X-2. A queued card continuation can be dropped with no retry (breaks 5).**
- Where: use-chat.ts:127, 260 and 414-416; ChatShell.tsx:109.
- Scenario A: two cards are answered while the reply is still streaming. `pendingContinuationRef` is a single slot, so the second continuation overwrites the first. The first card is already `resolved` on the server and is no longer in `GET /actions?status=pending`, so no card or button can ever send its `setup_action_id`.
- Scenario B: one card is answered, then the person switches session or agent, or closes the panel, before the reply ends. The scope effect clears the slot (line 260). The result is the same: the continuation is lost silently.
- Fix: queue continuations by `setup_action_id`. On a switch or unmount, send them anyway (each carries its own `session_key`; the Gateway delivers at most once), or surface each as a `retryContinuation` entry. Test both scenarios.

## Should-fix

**S-1. A 502, 503 or 504 from a proxy or the Cloud BFF counts as a refusal and offers "Send again" (invariant 2).**
- Where: use-chat.ts:368 and 375-394.
- Scenario: the gateway, or a BFF upstream, crashes or times out after it stored the turn, and the proxy answers 502. In a known session the panel offers an immediate retry without reconciling, and the retry creates a duplicate run. An intermediary's 5xx is not proof that the server lacks the turn.
- Fix: treat a 5xx as `mayHaveReached`. A known session reconciles with `unconfirmed`; a new chat gets `recover: 'sessions'`. Add a hook test.

**S-2. A null baseline caused by a failed history load also uses the "any match anywhere" fallback, so a lost short turn disappears silently.**
- Where: use-chat.ts:109, 170 and 299; chat-state.ts:198 (`loadFailed` sets idle); ChatShell.tsx:290 (the composer is enabled).
- Scenario: on a flaky network the initial history load fails, so `baselineRef` stays null. The person sends "yes". The fetch is rejected while the browser is online. The reconcile then loads a history that holds an older "yes", so the turn counts as delivered and is replaced by the history. The code comment limits this fallback to "ids missing", but it covers this case too.
- Fix: when the baseline is null and a match is found, settle as `delivery_unconfirmed` with reload rather than "delivered", or keep a separate "never loaded" state.

**S-3. Test gaps for the paths above.** There are no tests for:
- 409 `continuation_sent` counting as delivered (use-chat.ts:366);
- 5xx;
- compaction or renumbered ids;
- a queued continuation during a switch.

## Nits

- **N-a. The `confirmed` count drifts** (use-chat.ts:110 and 321-328). It undercounts in two cases:
  - a stored turn whose stream sent `chat.error` before `chat.started`;
  - a delivered turn whose reconcile could not load history (the baseline is not refreshed).

  `slice(confirmed)` also assumes no other-device turn falls between our confirmed turns. In each case only a repeated identical text is misjudged as delivered. X-1's anchor helps here as well.
- **N-b. The offline check is weak proof** (use-chat.ts:358 and 379). If Wi-Fi drops after the request bytes went out, `onLine` is false at catch time, and a new chat offers "Send again". This is the accepted heuristic. Note it in architecture.md:40 as residual risk.
- **N-c. A new send drops the unchecked turn** (use-chat.ts:297; chat-state.ts:200). It clears `uncheckedRef` and the reload button of an earlier `delivery_unconfirmed` turn. The next history load then removes that turn silently if the server lacks it.
- **N-d. The `error.delivery_unconfirmed` text is used where it does not fit** (i18n.ts:103 and vi :285). The text says "The connection dropped", but it is also shown for:
  - an early stream end (use-chat.ts:345);
  - a decoder fault (:371);
  - a failed history read (:232).

  Suggested wording: "Delivery could not be confirmed".
- **N-e. Focus is lost after recovery actions** (MessageList.tsx:32-44). The en and vi labels exist, and the controls are native `<button type="button">` elements inside `role="alert"`. But clicking "Send again" or "Reload" unmounts the button (the 'send' and 'history' actions clear it), and focus falls back to `body`. Move focus to the composer or the message list.
- **N-f. A continuation can land in the wrong conversation** (ChatShell.tsx:109). A continuation from `respond` that resolves after a session switch streams into the new conversation's state until `chat.started` switches the panel back.

## Verified OK

- **Invariant 1:** `retry` runs only on a click (use-chat.ts:461-467). The background code has no other caller.
- **Invariant 4:**
  - `ownerRef` and `owns()` are checked after every await, and only the owner dispatches `idle` (:237).
  - The scope effect retires loops and clears refs (:256-263), and `runStream`, `continueWith` and `reload` refuse to start while a loop runs.
  - `waitForOnline` removes its listener and interval within 2 s of retirement. The 15 s sleep timer is not cleared, but it is bounded and writes nothing.
- **Invariant 6:** `console.error` logs only the cause. `mapRuntimeFrame` uses `.catch` and swallows `JSON.parse` errors, so no frame data reaches the log. No request is logged.
- **Baseline arithmetic:** `> position` is correct, the newest-1000 paging keeps absolute positions, and an empty history gives -1. The `stateRef` read before the commit at :326 correctly picks `{-1}` for a new chat.

Status: DONE_WITH_CONCERNS
Summary: B-1 to B-6 are in the code with meaningful tests, and invariants 1, 4 and 6 hold. Two blocking gaps remain: compaction renumbering breaks the delivery proof (duplicate turn and "Send again"), and the single-slot continuation queue drops continuations with no retry.
Concerns/Blockers: Shell broken, so no gates were run. X-1 relies on Dewee's TruncateHistory renumbering positions; I checked this in the dewee source, not live.
