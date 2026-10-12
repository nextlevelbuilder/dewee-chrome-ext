# Dewee Chrome extension bootstrap: retry policy and continuations

**Date**: 2026-10-12 (Asia/Saigon)
**Severity**: Medium
**Component**: side panel chat (`use-chat.ts`), card continuations, Dewee Gateway extension API
**Status**: Resolved. Shipped as PR #3 (Closes #1) with 12 dependent Dewee PRs. Follow-up #2 (SSE buffer cap) is in progress.

## What Happened

We bootstrapped the MV3 side panel: chat, sessions and credential cards. Two areas ate most of the review budget: deciding when to offer "Send again", and making sure a card's continuation is never lost. Final evidence: 21/21 live e2e tests passed in two runs in a row, and 376 unit and integration tests pass.

## The Brutal Truth

We kept writing smarter heuristics, and the reviews kept breaking them. That was humbling. Every "delivered" proof we built on history ids failed, because the server rewrites those ids. Continuations needed three review rounds. Each round found a new way to lose the agent's card result silently. That is the worst failure for a setup flow: the agent just waits.

## Technical Details

- **Retry.** History ids are `m<position>` indices. `TruncateHistory(keepLast)` renumbers them after compaction, so a delivered turn at baseline 140 came back as `m3`. The panel then showed it twice, with "Send again" (review X-1).
- **Continuation queue.**
  - A one-slot `pendingContinuationRef` overwrote the first of two answered cards (review X-2).
  - It is now a per-id queue in `chrome.storage.session`, with one key per item and no read-modify-write.
- **Ambiguous 409.** The panel could not tell a live send lease from a finished delivery. Dewee now returns `continuation_in_progress` and `continuation_sent` separately (dewee#1047).
- **`chat.started` is not delivery.** The Gateway calls `lease.release()` when the run fails before the result is saved (provider error, rate limit), so we dequeued too early (review B-1).
- **Backend bugs found by the live e2e.**
  - #1022 dropped the 409 details, so test D showed a generic message. Fixed in 2d02e47a.
  - #1045 merged a stopped turn into the next message. Fixed with an injected `[Stopped before replying]` marker.

## What We Tried

1. A position baseline. Compaction broke it.
2. An anchor heuristic plus a "match anywhere" fallback. A null baseline made a lost "yes" look delivered.
3. Dequeue on the first frame or on a clean close. This lost results whenever the lease was released.

## Root Cause Analysis

We tried to infer delivery from client-side signals the server never promised to keep stable. The real fix was a policy, not cleverer code:
- Offer "Send again" only when the server provably did not get the turn: no fetch was made, the fetch failed while offline, or the server sent an explicit 4xx refusal.
- Treat everything else as uncertain. Show "Delivery could not be confirmed" with a reload action.
- Continuations leave the queue only on `message.completed`, `continuation_sent` or `setup_result_delivered`. Any other outcome holds the item with "Continue".

## Lessons Learned

- If an id comes from a list index, it is not identity. Ask the backend for an explicit outcome code before writing heuristics.
- Use fresh-context reviewers for at-most-once and exactly-once logic. Each round caught a real data-loss path.
- Live e2e found two backend bugs that unit tests could not see.

## Environment Pain

- The Bash tool failed with `ENAMETOOLONG`, so reviewers read code only and never ran gates. Some subagent types have no PowerShell.
- Some Go tests already failed on Windows before this work.
- `gw-env.ps1` lacked the provisioning key pair. Later runs used the launcher `gw-start4.ps1`.

## Open Risks and Next Steps

- **59.5 s e2e outlier.** It did not reproduce, and it still fits the in-progress retry ladder (5/15/30 s). Capture a trace if it happens again.
- **Refused and held continuations.** These paths (400/403/404/410 and "Continue") are tested only by unit tests. Add a live scenario.
- **Real Dewee merge.** Regenerate `spec.hash.lock`, and fix the `recordingChatAborter` abort test fake that `go vet` flags.
- **Follow-up #2.** Finish the SSE buffer cap.
