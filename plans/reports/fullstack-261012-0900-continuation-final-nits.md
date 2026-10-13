# Continuation queue: final review findings (S-1, N-1 to N-4)

Uncommitted, worktree `dewee-chrome-ext-bootstrap-58115d`. `.env` never opened (only moved aside for e2e and restored).

## Fixes
- **S-1** (use-chat.ts, i18n.ts):
  - 400, 404, 410, and any 403 except `scope_required`/`owner_binding_required`: dropped, shown once as `continuation_refused` (en and vi), no "Continue".
  - The drop logs `console.warn('Card continuation refused', { status, code })`, with no payload.
  - 403 `scope_required`/`owner_binding_required`: falls through to the held path, so the item is held with "Continue" and the key error.
- **N-1**: a single `live()` check (epoch current and mounted) is used in the frame loop, the early-close branch and the catch. Unmount now does what a switch does: the stream is dropped without `hold`, and a reopened panel sends the item again. That is what architecture.md already said ("reopening the session sends what is pending"), and the doc now spells it out. A user Stop still holds.
- **N-2**:
  - `enqueue` follows the stored flag and refreshes the queued copy. An unheld copy releases a held item and removes its "Continue" (new `dropContinue` reducer action in chat-state.ts).
  - `forget` (local delivery, or another panel's removal) also removes that item's "Continue".
  - A stale click is harmless: `retry` drops the bubble, and `continueWith` returns because of `doneRef`.
- **N-4**: new optional `in_progress_since` (ms) on the stored item (pending-continuations.ts). It is written at the first 409 `continuation_in_progress`, and the retry window starts from it, so a reopened panel keeps the window. Pressing "Continue" stores a fresh item, which starts a new window.

## Docs
- architecture.md:42 (Cards):
  - the stored fields;
  - switch and unmount behave the same mid-stream;
  - `continuation_refused`, the warn, and the fixable 403 hold;
  - the stored retry-window start;
  - the cross-panel held/unheld/removed behaviour.
- api-contract.md: the continuation delivery rule now covers the refusal and the fixable 403.
- credential-threat-model.md: the stored item now includes `in_progress_since`.

## Tests (tests/integration/chat/use-chat.test.tsx)
- The dead-refusal `it.each` now asserts `continuation_refused` and the warn.
- New `it.each` for the fixable 403s: held, "Continue" works, no warn.
- New describe "continuation across panels, unmount and reopen":
  - B is in the in-progress backoff when A stores the item held: B stops retrying and shows "Continue" (N-3);
  - unmount while streaming: the item is not held and the reopened panel sends it (N-1, N-3);
  - an unheld copy releases the item, and "Continue" is gone while the resend streams (N-2);
  - another panel's removal removes "Continue", and the stale click sends nothing (N-2);
  - `in_progress_since` is stored, and the reopened panel holds at the original 11-minute mark (N-4).

## Mutation check (11 mutants on use-chat.ts, all killed)
- Killed:
  - S-1: refused code reverted; warn removed; fixable 403 dropped.
  - N-1: unmount holds.
  - N-2: unheld copy ignored; release keeps the bubble (killed after the test checked mid-stream); forget keeps the bubble; the `doneRef` guard in `continueWith` removed.
  - N-3: held copy ignored.
  - N-4: stored start ignored; start not stored.
- The script restored the file in a `finally`.

## Gates
- `pnpm lint`, `pnpm typecheck` and `pnpm build` pass; `pnpm test` passes 27 files and 376 tests.
- `pnpm test:e2e`: 5 smoke tests passed and 16 live tests skipped.
- test-results and .output-e2e were removed; playwright-report was not created.

Status: DONE
Summary: S-1 and N-1 to N-4 are fixed, each with a test that kills its mutant. The docs are aligned, and all gates and e2e smoke tests pass.
Concerns/Blockers: Residual: if a stale unheld storage echo lands after a local `hold`, the held flag clears briefly. The held write that follows restores it, so at worst there is one extra resend, which the Gateway deduplicates.
