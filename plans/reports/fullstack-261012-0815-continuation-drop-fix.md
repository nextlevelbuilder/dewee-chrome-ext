# Continuation drop fix (B-1 and nits N-1 to N-4)

Uncommitted, in worktree `dewee-chrome-ext-bootstrap-58115d`. `.env` never opened. No build, e2e, zip or Playwright run.

## B-1 (src/chat/use-chat.ts)
- A queued continuation is removed only on `message.completed`, 409 `continuation_sent` or `chat.error` `setup_result_delivered`. The dequeue on the first frame and on a clean close is gone.
- `setup_result_delivered`: the item is dropped and the reply shows the `continue_in_chat` text, with no "Continue".
- Any other `chat.error` or `chat.stopped`: the item is held and the reply keeps the stream's error and offers "Continue" (new `offerContinue` reducer action in chat-state.ts).
- An early close, or a drop after the response: the item is held. The reconcile then restores "Continue" on the failed turn once the run ends.
- Stop after `chat.started` now keeps the item with "Continue". Per the rule, only the three proofs remove it; the old test that asserted a drop was rewritten.

## Nits
- **N-1 (refusals that can never succeed):**
  - 400, 403, 404 and 410 drop the item (with `doneRef`) and show the error once, with no "Continue".
  - A held item is stored with `held: true` (new optional field in pending-continuations.ts). `heldRef` is no longer reset on a conversation switch, and a stored held flag is honoured on load and on onChanged. So a held item is never auto-sent again, after a switch or in a reopened panel.
  - When its session is shown, a held item gets one "Continue" bubble (`continuation_unconfirmed`, new i18n key in en and vi).
  - "Continue" rewrites the item without the flag.
- **N-2:** 409 `continuation_sent` drops the turn, goes idle and reloads history quietly, with no error bubble.
- **N-3:** the reconcile sleep and the Stop grace timer use a `sleep` registered in `timersRef`. Unmount clears and resolves them.
- **N-4 (ChatShell.tsx):** the agent is captured as `agentKeyAtStart` with the session at respond start. The actions view strips `session_key` and has only `agent_id`, and a lost response returns nothing, so there is no server target to prefer. The old closure already captured the agent at start; the change makes this explicit.

## Docs
- architecture.md (Cards):
  - the three delivery proofs, why `chat.started` is not proof, and the dead statuses;
  - the held flag, the "Continue" cases and why a resend is safe;
  - the remaining limit: a held item, including one past the retry window, stays until "Continue" or a browser restart.
- api-contract.md (continuation): the delivery rule; `setup_result_delivered` added to the table; the statuses noted on the codes; the dead-refusal and "keep" sentence.
- credential-threat-model.md: the stored item now also lists the boolean `held` flag.

## Tests
- tests/integration/chat/use-chat.test.tsx, new tests:
  - `chat.started` then `chat.error` `provider_rate_limited`: the item stays stored as held with "Continue", is not auto-resent, and "Continue" delivers it;
  - `setup_result_delivered`;
  - early close;
  - a drop after the response;
  - 400, 403, 404 and 410 (`it.each`);
  - a silent `continuation_sent` (records every render);
  - a held item after a switch;
  - a held item in a reopened panel;
  - both unmount timers.
- The Stop-after-start test was rewritten as described under B-1.
- tests/unit/sidepanel/ChatShell.test.tsx: an agent switch during a lost respond still queues the original agent and session.
- Note: the extension maps a Gateway `chat.error` code only when it matches its recovery action, so the rate-limit test uses `provider_rate_limited`.

## Mutation check (13 mutants on use-chat.ts)
- 12 were killed by assertion failures: dequeue on the first frame; `setup_result_delivered` not settled; early close not held; drop counted as delivery (killed after I tightened that test); dead statuses kept; `continuation_sent` shown as an error; no "Continue" on `chat.error`; the held flag ignored on load; the held flag not stored; the reconcile sleep not cleared; the Stop timer not cleared; Stop after the answer drops the item.
- 1 survived as equivalent: resetting `heldRef` on a switch. The stored `held` flag re-holds the item on reload, so this has two layers of protection.
- ChatShell: no mutant can tell the closure value from the captured constant, so that test is a regression guard only.

## Gates
`pnpm lint`, `pnpm typecheck` and `pnpm test` all pass: 27 files, 368 tests.

Status: DONE_WITH_CONCERNS
Summary: Continuations are now removed only on `message.completed`, `continuation_sent` or `setup_result_delivered`, or dropped on 400/403/404/410. Every other failure holds the item (stored with a `held` flag) with "Continue". The timers, the silent `continuation_sent` and the explicit respond-time agent are fixed, with tests that kill 12 of 13 mutants.
Concerns/Blockers: Two behaviour changes: Stop after `chat.started` now keeps the item, and a held item is no longer auto-resent when its session is reopened. N-4 had no server target available, so the change only makes the start-time capture explicit.
