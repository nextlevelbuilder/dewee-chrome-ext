# Retry policy simplified, continuation queue, stopped-turn marker

Uncommitted in worktree `dewee-chrome-ext-bootstrap-58115d`. `.env` was never opened.

## Policy (src/chat/use-chat.ts `notReceived`)
"Send again" is offered only when the server provably did not get the turn:
the panel failed before calling fetch, fetch was rejected while `navigator.onLine === false`, or an
explicit 4xx refusal arrived (validation, auth, 409 busy; not 409 `continuation_sent`).
Everything else (5xx incl. 502/503/504, stall, drop after response, online fetch rejection,
decoder fault, unreadable history, turn missing after reconcile) is uncertain: the turn stays
once, marked `delivery_unconfirmed`, with "Reload conversation" ("Show conversations" in a new chat).

## Findings
- X-1: baseline-based "missing, so retry" path removed. Baseline = position + anchor (last
  message role/content) + confirmed count. The local copy is dropped only if the anchor is
  intact and a matching user turn follows it; otherwise it is kept once as unconfirmed
  (`local: true` survives history reloads). history.ts throws `history_changed` on repeated shrink.
- S-1: 5xx is uncertain. S-2: covered by the policy.
- X-2: continuations are queued by `setup_action_id` (never overwritten), persisted as IDs only in
  `chrome.storage.session` (src/chat/pending-continuations.ts), auto-sent when their own session is
  open and idle, "Continue" after a not-received failure, removed on delivery, on 409
  `continuation_sent`, or on Stop. Never streamed into another session.
- Nits: en/vi `error.delivery_unconfirmed` reworded; focus moves to the log after Send again /
  Continue / Reload; a new send only clears earlier `retryText`, keeping reload and local turns.
- Added (coordinator): history `injected` flag (dewee#1045). `historyMessage` accepts optional
  `injected`; `fromHistory` (it lives in src/chat/chat-state.ts, not history.ts) maps an injected
  assistant turn to an empty `stopped` reply ("Stopped" label, marker text never shown) and drops
  any other injected message.

## Docs
- docs/architecture.md Chat + Cards paragraphs: exact policy, anchor rule, residual risks.
- docs/credential-threat-model.md: pending-continuation IDs are not secrets.
- docs/api-contract.md: continuation resend note; history `injected` field and panel handling.

## Tests
New/updated: 5xx it.each, 4xx refusal it.each, offline vs online rejection, compaction it.each
(renumbered ids, replaced anchor, rewritten anchor with a matching turn after it), history throws on
repeated shrink, two queued continuations, persistence across a switch + wrong session, resume after
unmount, 409 `continuation_sent`, earlier unconfirmed turn kept on next send, focus
(tests/unit/sidepanel/MessageList.test.tsx), injected stop marker + other injected dropped.

## Mutation check (13 mutants, all killed)
M1 anchor ignored (killed after adding the "rewritten anchor" case; it survived before),
M2 online rejection = not received, M3 5xx = refusal, M4 history returns [], M5 single-slot queue,
M6 queue not persisted, M7 session filter removed, M8 continuation_sent not dequeued,
M9 send clears unconfirmed turns, M10 no focus, M11 local turns lost on reload,
M12 injected marker shown as text, M13 other injected message rendered.

## Gates
- pnpm lint: clean. pnpm typecheck: clean.
- pnpm test: 24 files, 335 tests passed.
- pnpm build: ok (604.60 kB).
- pnpm test:e2e (.env moved to scratchpad unread, restored in finally): 5 smoke passed, 16 live skipped.
- test-results, playwright-report, .output-e2e removed.

## Decisions to note
- In-doubt case (anchor gone after compaction): the server copy may show next to the one local
  unconfirmed copy. Accepted per "when in doubt keep a single local copy".
- 409 busy now gives "Send again" without a reconcile.
- A continuation the person stopped is dropped. Held continuations auto-send when their session reopens.
- Residual risks: `navigator.onLine` can be wrong (offline heuristic); identical repeated text after
  an intact anchor is matched by text.

Status: DONE
Summary: Retry policy reduced to "Send again only when provably not received"; continuation queue persisted per session; injected stopped marker renders as "Stopped". All gates pass and all 13 mutants are killed.
Concerns/Blockers: Possible duplicate display (server copy plus local unconfirmed copy) after compaction removes the anchor; accepted by design.
