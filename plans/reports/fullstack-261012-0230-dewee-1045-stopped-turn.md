# Dewee #1045: stopped turn answered on the next send

Worktree: D:/www/nextlevelbuilder/worktrees/dewee-1033-session-persistence, branch `fix/1033-1034-session-persistence`. It was clean and up to date before the work started.

## Cause
- `internal/agent/loop_history_sanitize.go` `sanitizeHistory` (step 3) merges consecutive same-role messages on purpose. Providers need user/assistant alternation, and the merge also folds runtime `[System]` nudges into the next user turn.
- After #1034, a stopped turn stays last in history. The next user turn follows it, so the model gets a single merged user message.
- A second effect: `buildMessages` (`loop_history.go:333-341`) writes the merged history back through `SetHistory`/`Save` whenever the sanitizer merged anything. The stored history then lost the separate stopped turn. The test showed history holding 0 copies of "hello" before the fix.

## Fix (option: stored assistant marker)
- `internal/pipeline/finalize_stage.go`: when the run was cancelled, produced no reply, and its input is stored (not `HideInput`, non-empty message), finalize stores the assistant turn `StoppedTurnMarker = "[Stopped before replying]"` with `Injected: true`.
- `internal/providers/types.go`: the `Injected` comment now covers this assistant-role marker.
- `internal/http/channel_instances_verify.go`: `scanProbeHistory` ignores injected assistant turns, so a cancelled probe run is not counted as a reply. The reviewer found this.
- Why this option over hiding the stopped turn from model context:
  - It is one change and reuses the existing `Injected` field.
  - The sanitizer never rewrites the stored history.
  - The model knows the request went unanswered.
  - Hiding the turn would need a new persisted field, a filter in `buildMessages` and a guard on the sanitizer's write-back.
- What history shows:
  - The provisioning (CCP) and `/v1` history endpoints return raw messages, so the marker appears as an assistant message with `"injected": true`.
  - The extension's `fromHistory` (`src/chat/chat-state.ts:93`) keeps only user and assistant roles and does not read `injected`. It will show "[Stopped before replying]" where the live view showed an empty bubble labelled "Stopped". This is intended: the marker replaces that label.
  - Correction to the brief: nothing in the extension or dewee filters `injected` today.

## Tests (each fails with the fix reverted; checked by disabling the branch)
- `internal/pipeline/finalize_stop_flush_test.go`:
  - A stop before any reply flushes one injected marker.
  - A partial reply, a hidden input or a non-stop failure flushes no marker.
- `internal/agent/loop_run_stop_session_test.go`:
  - New `TestRunAfterStopDoesNotFoldStoppedRequestIntoNextTurn`: stop, then two more runs. The model input ends with the marker and then the new user turn. No call carries "hello" and "after stop" in one user message. History holds "hello" exactly once. All three checks fail without the fix.
  - The existing stop test now expects the user turn followed only by the marker.
- `internal/http/channel_instances_verify_probe_test.go`: a probe followed only by the marker is not counted as outbound.

## Gates
- `go build ./...` passes in the default, `-tags sqlite` and `-tags sqliteonly` builds.
- `go vet` passes on agent, pipeline, providers and http, and with `-tags sqlite` on http.
- `go test ./internal/agent ./internal/pipeline` passes.
- `go test -tags sqlite ./internal/http` fails only in Windows-only tests: symlink, SecureCLI x3, SSH CRLF, and `TestWorkspaceSetupOnboardingFlowEndToEnd`/`TestWorkspaceSetupSecretLeakSweep`. The last two fail with "credentialed exec: failed to start ...\dewee", the same SecureCLI exec class, and they are already listed as Windows-only failures on `dev` in the PR body. The PR's first-turn sqlite tests pass.
- `go clean -testcache` was run.

## Review
- A fresh code-reviewer subagent found no blocking issues. It could only read code, because its shell was broken.
- Non-blocking findings and what was done:
  - "by user" wording was wrong for a disconnect or shutdown: changed to a neutral wording.
  - A cancelled probe would pass channel verification: fixed and tested.
  - The finalize comment was too narrow: rewritten.
  - Summaries and memory take the marker as assistant text: left as is, since it is harmless.

## Delivery
- Commits pushed to the PR branch:
  - `8640e1e9 fix(pipeline): store a stopped-turn marker after a run stopped before replying`
  - `afbe7768 fix(http): ignore runtime-written assistant turns in channel verification`
- PR #1045 body updated: Summary and Test plan, with the trailing Claude Code line kept.

Status: DONE_WITH_CONCERNS
Summary: The stopped turn now gets an injected assistant marker, so the next turn is no longer merged into it, and the sanitizer no longer rewrites stored history. Tests, gates, review, push and the PR body update are done.
Concerns/Blockers: Clients show "[Stopped before replying]" as an assistant bubble after a reload; the extension could read `injected` to style it. Older sessions that already hold a trailing stopped turn without a marker still merge once.
