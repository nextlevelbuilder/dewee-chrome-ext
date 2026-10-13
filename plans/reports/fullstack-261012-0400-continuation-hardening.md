# Continuation hardening (S-4, S-5, S-6, N-1, N-3 to N-6)

The work is uncommitted in the worktree `dewee-chrome-ext-bootstrap-58115d`. I never opened `.env`.

## Fixes
- **S-4** (src/chat/use-chat.ts)
  - A 409 `continuation_in_progress` keeps the item. The placeholder reply is dropped and the chat goes idle.
  - The item is re-sent first after the server's `Retry-After` / `retry_after_seconds` hint (5 s when there is none), then after 15 s, 30 s and every 60 s.
  - Re-sends happen only while the item's own session is shown and idle: the queue effect sets a timer that is cleared when the session changes.
  - The window is about 11 minutes from the first in-progress answer (`IN_PROGRESS_LIMIT_MS`). After it, the item is held and the reply shows "Continue".
  - An item is dropped only when the server answered the stream, or on 409 `continuation_sent`. Any other refusal, including an unknown 409 code, keeps the item and shows "Continue".
  - "Continue" resets the retry window. New i18n keys in en and vi: `error.continuation_in_progress` and `error.continuation_stopped`.
- **S-5** (src/chat/pending-continuations.ts)
  - Each item now has its own `storage.session` key. Adding or removing an item is one write to that key and never touches the others.
  - I chose this over a read-merge-write helper. A read followed by a write is still open to cross-panel races, because `chrome.storage` has no transactions. One key per item has no read step at all. Ownership did not move to the background worker.
  - `watchPendingContinuations` follows `storage.onChanged`. An item another panel adds is queued here; an item another panel removes is forgotten here, so it is never sent twice.
- **S-6**
  - `continueWith(continuation, scope?)` accepts the scope.
  - In ChatShell, `respond` captures `{ profileId, workspaceId }` and the session key when the call starts, and passes them to `continueWith`. This includes the replay path for a lost response.
- **N-1** I picked the simplest correct option. A Stop before the server answered (no frame received) keeps the item, holds it and shows "Continue". Once the server has answered, the item has already left the queue.
- **N-3** `holdsTurn` ignores `injected` user turns.
- **N-4** Doc contradictions fixed:
  - api-contract.md: the history roles paragraph says injected turns are returned with `injected: true`.
  - architecture.md, Restart: user messages are never auto-sent; only continuations are, because delivery is at most once.
- **N-5**
  - `send()` now returns a boolean synchronously; `runStream` returns false when it refuses.
  - Composer clears its text only when `onSend` does not return `false`.
- **N-6** Items carry `profile_id`. Both the storage key and the queue filter use profile + workspace + setup action.
- **N-2** Left as is, as instructed: a new chat's baseline still has no anchor until the next history load. The risk is low because `slice(confirmed)` usually empties the list.

## Docs
- docs/api-contract.md:
  - The continuation section has a table of both 409 codes. It covers the lease timings, the `Retry-After` / `retry_after_seconds` hint (currently 5), the panel's behaviour for each code, and unknown 409s.
  - It names dewee#1047 as the backend change and dewee#1022 as the implementation.
  - `continuation_in_progress` is added to the 409 row of the error table.
- docs/architecture.md: the Cards paragraph is rewritten (per-item keys, onChanged, respond-time scope, backoff and hint, Stop rule); Restart is fixed.
- docs/credential-threat-model.md: the stored IDs now include the profile id.

## Tests (new)
- tests/unit/chat/pending-continuations.test.ts:
  - two writers interleaving (concurrent adds, then a remove concurrent with an add)
  - profile/workspace keying
  - onChanged added/removed, including unsubscribe
- tests/integration/chat/use-chat.test.tsx:
  - in-progress backoff until delivered
  - the Retry-After hint applies to the first wait only
  - holds after about 11 minutes with no further retries
  - waits while its session is hidden
  - unknown 409 (`conflict`, `failed_precondition`) is kept
  - Stop before an answer keeps the item; Stop after an answer drops it
  - respond-time scope
  - another profile's item is not sent
  - two panels share the queue through onChanged
  - an injected user turn is not proof of delivery
  - a refused send returns false
- tests/unit/sidepanel/Composer.test.tsx: text is kept or cleared depending on `onSend`'s result.
- tests/unit/sidepanel/ChatShell.test.tsx: a workspace switch during `respond` still tags the item with the old workspace.

## Mutation check: 18 mutants, all killed by assertion failures
1. in_progress dropped as delivered
2. never retried
3. retried forever
4. retry ignores the open session
5. unknown 409 dropped
6. Stop before an answer drops the item
7. no onChanged subscription
8. removals from other panels ignored
9. scope ignored in the hook
10. ChatShell does not pass the scope
11. queue filter ignores the profile
12. storage key without the profile
13. injected turn counted
14. `send` always returns true
15. Composer clears refused text
16. whole-queue read-merge-write (it survived at first; I fixed it by asserting the state after the concurrent adds)
17. Retry-After hint ignored
18. hint applied on every retry

The first M7 mutant was a syntax error, so it did not count as a kill. I replaced it with a valid mutant.

## Gates
- `pnpm lint` and `pnpm typecheck`: clean.
- `pnpm test`: 27 files, 354 tests passed.
- `pnpm build`: ok (606.58 kB).
- `pnpm test:e2e`, run with `.env` moved unread to the scratchpad and restored in `finally`: 5 smoke tests passed, 16 live tests skipped. Afterwards I removed test-results, playwright-report and .output-e2e.

## Notes
- The retry state (`since`, `attempts`) is kept in memory per panel. A panel that is reopened starts a fresh window of about 11 minutes. This is harmless because delivery is at most once.
- Old items stored under the previous array key `chat.pendingContinuations` are ignored. It was never released, and `storage.session` is cleared when the browser restarts.

Status: DONE
Summary: S-4, S-5, S-6, N-1, N-3, N-4, N-5 and N-6 are fixed, and the coordinator's Retry-After hint and dewee#1047 docs are added. Each fix has a mutation-checked test (18/18 killed). All gates and the e2e smoke run pass.
Concerns/Blockers: The `continuation_in_progress` code and its hint follow the stated dewee#1022 contract. I did not verify them against a live Gateway.
