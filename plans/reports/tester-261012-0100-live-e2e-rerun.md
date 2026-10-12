# Live e2e re-run against a combined local Dewee stack

Date: 2026-10-12. The extension worktree is uncommitted, and nothing was committed. The previous setup was reused (`tester-261011-2300-live-e2e-full.md`).

## Stack

- Gateway: a temporary detached worktree, `worktrees/dewee-e2e-combined2`, built from `origin/feat/956-gateway-extension-api` (`7b6229d4`). These were merged in order:
  - 958 (`dd164d71`)
  - 1000 (`9644cb00`)
  - 992 (`70bda2d9`)
  - 1033-1034 (`e1ef1171`)
- Schema migrated from 138 to 139 on `dewee_ext_e2e`.
- App: `apps/dewee-app` from the same tree, in node mode, on the new throwaway DB `dewee_ext_e2e_app`.
  - Migrations were applied by importing `runSelfHostedMigrations`, because the Windows no-op bug (#1037) is not merged.
  - The Cloud owner, workspace, stub provider and Super Agent were bootstrapped to `agent_bootstrapped`.
- Bind addresses: Gateway `127.0.0.1:18790`, stub `:18791`, relay `:18792` (started by the spec), app `:4321`.
- Not used: `dewee/.env`, `goclaw_test`, any production URL, and the master token as a client credential.

## Results (final run, 120 rpm: 20 passed, 1 failed, 1.9 min, one worker; extension rebuilt before each run)

| Scenario / test | Result |
|---|---|
| A Cloud sign-in, consent, workspace, Super Agent chat | PASS |
| C Super Agent `secret_request`: encrypted, `credential_ref` only | PASS |
| C expired card and foreign targets refused | PASS |
| D no policy refused, allowlisted Done, other type refused, **revoke shows the localized reason** | **FAIL** (backend bug 1) |
| E double-clicked Save sends one answer | PASS |
| E lost respond reloads as Done, no re-send | PASS |
| E reopen mid-stream reconciles once | PASS |
| E service worker restart mid-stream | PASS |
| E offline, then online, reconciles with no re-send (new "You are offline…" text) | PASS |
| E cancelled run stays cancelled after reopening | PASS |
| B1 connect, agents, Super Agent first | PASS |
| B2 streamed reply | PASS |
| B2 incremental deltas, settings write, Stop | PASS |
| B3 Stop; a repeated abort is harmless | PASS (after the stub fix below) |
| B4 a revoked key ends the session | PASS |
| E1 history after reopen; a lost response reconciles without a duplicate | PASS |
| Smoke (5) | PASS |

Every C, D and E test kept the no-leak checks. The sentinel matched 0 times across all Gateway, app and stub logs.

## Rate limit (#1036)

- The DB override was deleted and `config.json` reset, so the Gateway logged `rpm=20` with separate stream and respond buckets.
- Two default-limit runs failed, both with `429` on `chat/stream`. Respond was never limited.
  - Run 1: E "reopening the panel mid-stream" (the warm-up send).
  - Run 2: D (the allowlisted card send, right after the C tests).
- The limit was raised back to 120 (DB plus `config.json`). `dewee_ext_e2e` keeps 120.
- Quirk: on startup the Gateway writes its in-memory value back to `config.json` and reseeds `system_configs`, so a reset needs a stopped Gateway, a deleted row and a rewritten file.

## Merge conflicts

| File | Branches | Resolution |
|---|---|---|
| `CHANGELOG.md` | 958 vs 956 | Kept both entries |
| `apps/dewee-docs/spec.hash.lock` | 958 vs 956 | Took 956's hash (regenerate on the real merge) |
| `internal/http/provisioning_chat_abort.go` | 1000 vs 956 | Union of the router methods (as before) |
| `CHANGELOG.md`, `docs/project-changelog.md` | **1033 (new)** vs 956/958 | Kept both entries |
| `internal/agent/loop_types.go` | **1033 (new; carries newer dev, e.g. `unresolvedFallbacks`)** vs 958 `credentialRequest` | Union of both fields |

- 992 merged cleanly.
- After the union, `go vet` flags two `internal/http` test fakes (`recordingChatAborter` lacks `AbortRun`). The binary builds; only the test code would need updating on a real merge.

## Bugs and observations (backend: written up only)

1. **Backend bug: the revoke reason never reaches the extension (956 × 958 integration).** The policy DELETE cancels the card. Respond then answers `409 {"code":"conflict","message":"…no longer allowed by the agent's credential request policy…"}` with no `details`.
   - Cause: 958's `credentialPolicyRevokedConflict` puts the reason in `setupError.details`. 956's `writeExtensionSetupError` (`internal/http/extension_api.go`) forwards `details` only for a 403 human-gate refusal, so the extension API drops it.
   - Effect: the panel shows the generic "This changed on the server. The latest state was reloaded." instead of "An admin no longer allows this agent…".
   - Suggested fix (in #1022 or the merge): forward `serr.details` for 409, or set `serr.reason = credential_policy_revoked`.
   - Evidence: a direct API probe, plus `assets/live-e2e/d-revoke-generic-conflict.png`.
   - A local patch to prove the panel path was not allowed (permission denied), so the new message has no screenshot yet. The mapping is unit-tested.
2. **Contract change (958, intended): policy writes now refuse the admin token as `system`** (`403 setup_human_actor_required`, `cause: system_actor`). This fixes last run's observation 5. The test harness was adjusted (see below).
3. **#1045 behaviour: a stopped turn's unanswered message is merged into the next user turn.**
   - The model received `"slow please …\n\nafter stop …"`, so it answers the cancelled request again in the next turn.
   - Probably by design (roles must alternate, and the partial reply is not persisted), but a person may not expect it. Worth a Dewee issue if unintended.
4. The first-turn wait in `requestCard` (`live-credentials.spec.ts`) was kept. Its comment now describes the pre-#1045 cause; the wait is harmless and mirrors a person.
5. Nit (extension copy): a Cancelled card still shows "Saved to AI provider …" (`secret.destination`). Read on a closed card, that sounds as if the value was saved.

## Extension edits (test harness and docs only; no `src/` change)

- `tests/e2e/support/live.ts`: `admin()` and `adminOk()` take an optional `asUser` (default `system`).
- `tests/e2e/live-credentials.spec.ts`: the four policy PUT/DELETE calls pass `OWNER`; `OWNER` is imported.
- `tests/e2e/support/stub-llm.mjs`: the `slow` check now reads only the last line of the user turn, the same as the echo. B3 failed in run 1 because of the merged turn (item 3).
- `tests/e2e/support/live-gateway.md`: policy writes are sent as the owner; streams and respond have separate buckets, and the run still needs more than 20 rpm.
- eslint is clean on the three changed test files, and `tsc --noEmit` is clean.
- Evidence (`plans/reports/assets/live-e2e/`):
  - Added: `d-revoke-generic-conflict.png`, `e-offline.png`, `e1-reconciled.png`, `b3-stopped.png`.
  - Refreshed: `e-online-reconciled.png`.
  - Removed the stale `d-revoked-refused.png`.

## Cleanup

- Stopped the Gateway, stub and app (PIDs 49108/46024, 68792/65484, 64256). Ports 18790, 18791, 18792 and 4321 are free; no `dewee*` process is left.
- Dropped `dewee_ext_e2e_app`. Only `dewee_ext_e2e` remains, at 120 rpm.
- Removed worktree `dewee-e2e-combined2` and its directory, and ran `git worktree prune`. The Dewee main checkout is untouched (`dev`).
- Removed `test-results/`, `playwright-report/` and `.output-e2e/`; 0 `%TEMP%/dewee-e2e-*` profiles are left. Ran `go clean -testcache`.

Status: DONE_WITH_CONCERNS
Summary: 20/21 live tests pass against the combined 956+958+1000+992+1033 stack, including B3 after a stub fix and the policy calls moved to the owner. D fails because the extension API drops 958's `credential_policy_revoked` details, so the panel shows the generic conflict message.
Concerns/Blockers: Backend bug 1 needs a fix in #1022 or the merge before D can pass. The default 20 rpm still 429s the stream tests (respond is fine). The `loop_types.go` and `provisioning_chat_abort.go` unions need test-fake updates on the real merge.
