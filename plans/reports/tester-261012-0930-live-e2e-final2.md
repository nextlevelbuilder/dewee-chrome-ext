# Live e2e final run 2 against a combined local Dewee stack

Date: 2026-10-12 (Asia/Saigon). The extension code is the latest uncommitted worktree. Nothing was committed in either repo. The procedure is the same as `tester-261012-0800-live-e2e-final.md`.

## Stack
- Gateway: a fresh detached worktree, `worktrees/dewee-e2e-combined4`, created after `git fetch` from `origin/feat/956-gateway-extension-api` `b18b35c9`. Merged in order: 958 `dd164d71`, 1000 `9644cb00`, 992 `70bda2d9`, 1033-1034 `afbe7768`. These are the same heads as the last run.
- Conflict resolutions were the same as last time: `CHANGELOG.md` and `docs/project-changelog.md` kept both entries; `spec.hash.lock` took 956's hash; `provisioning_chat_abort.go` uses the union of the router methods; `loop_types.go` keeps both `credentialRequest` and `unresolvedFallbacks`. 992 merged cleanly.
- `go build` is OK. `go vet ./internal/http` still flags the `recordingChatAborter` test fake, as before.
- `migrate up` on `dewee_ext_e2e` was a no-op at schema 139. It needs `GOCLAW_MIGRATIONS_DIR` when the binary lives outside the tree. The Gateway logged `rpm=120`.
- The Gateway got `DEWEE_PROVISIONING_KEY_ID`/`SECRET` from `app-secrets.env` at its first start, through the launcher `gw/gw-start4.ps1` (values were not printed). Provisioning therefore worked first time: no 404 retry, and no restart was needed.
- App: `apps/dewee-app` from the same tree, built with `DEWEE_APP_BUILD_TARGET=node`, on the new throwaway DB `dewee_ext_e2e_app`, migrated with `runSelfHostedMigrations`. `cloud-setup.mjs` took it to `agent_bootstrapped` in one pass.
- Ports: Gateway 18790, stub 18791, relay 18792 (the spec starts it), app 4321. All four were free at the start.

## Results: `pnpm test:e2e` passed 21/21 twice in a row (1.9 min each, one worker, trace on)
| Test | Run 1 | Run 2 |
|---|---|---|
| A Cloud sign-in, workspace, Super Agent chat | PASS 2.5 s | PASS 5.1 s |
| C `secret_request` encrypted, `credential_ref` only / expired + foreign refused | PASS / PASS | PASS / PASS |
| D policy, allowlist, revoke shows exact `credential_policy_revoked` text | PASS 5.6 s | PASS 6.3 s |
| E double-clicked Save sends one answer, continues once | PASS 4.6 s | PASS 4.7 s |
| **E lost respond reloads as Done, continues once, no re-send** | **PASS 2.8 s** | **PASS 2.8 s** |
| E reopen mid-stream / SW restart / offline then online / cancelled run | PASS (4) | PASS (4) |
| B1, B2 (2), B3 Stop + next turn, B4 revoked key | PASS (5) | PASS (5) |
| E1 history; uncertain turn shows "Delivery could not be confirmed", then reload | PASS | PASS |
| Smoke (5) | PASS | PASS |

No spec was changed, and no flakiness was seen.

## Continuation behaviour
- **E lost respond** took 2.8 s in both runs, so the 59.5 s outlier did not recur.
- Its trace shows this request sequence against the Gateway:
  - `chat/stream` (the turn)
  - `respond` (accepted by the server, response cut, client sees -1)
  - one `GET actions?session_key=…` (the card reloads as Done)
  - exactly one continuation `chat/stream` → 200
- So there was no `continuation_in_progress` retry, and no reconcile poll.
- The earlier 59.5 s is still unexplained, because this run could not reproduce it. Its length still fits the in-progress retry ladder (5/15/30 s) better than any other path.
- E double-click and C continued once, and the queue emptied after delivery: each spec asserts one continuation and one reply.
- The live suite only reaches the delivered path. No live scenario produces `continuation_refused` (400/404/410/403) or a held item with "Continue". Unit tests cover those paths; they are not live-verified.

## Evidence (`plans/reports/assets/live-e2e/`, refreshed from run 2)
- All 12 files were refreshed: `a-cloud-reply`, `b2-streamed-reply`, `b3-stopped`, `b4-revoked`, `c-card-pending`, `c-card-done`, `d-revoked-refused`, `e-lost-respond-reconciled`, `e-offline`, `e-online-reconciled`, `e1-reconciled`, `e1-unconfirmed`.
- `d-revoked-refused.png` is the closed (Cancelled) card. It now reads **"For AI provider openai_compat. Nothing was saved."** above the alert "An admin no longer allows this agent to ask for this credential. The card was closed." This resolves the old nit where it read "Saved to AI provider …" (observation 4 in the 0800 report).

## Bugs and observations
1. No new bugs. The Gateway log shows no `level=ERROR` in either run.
2. Still open from earlier reports:
   - `go vet` flags the `recordingChatAborter` test fake, and `spec.hash.lock` needs regenerating. Both are for the real merge.
   - The stopped-turn marker wording overstates partial output (#1045).
   - The two `bootstrap: agent file backfill failed (SQLSTATE 42P08)` warnings at Gateway start also appeared in the 0800 run. They are pre-existing and do not affect the tests.

## Cleanup
- Stopped the app (35360), the Gateway (49900) and the stub (38900, child 37848); their wrappers exited. Ports 18790, 18791, 18792 and 4321 are free, and no `dewee` process is left.
- The pre-existing `node` process 7696 (started yesterday) is not mine and was left running.
- Dropped `dewee_ext_e2e_app`. `dewee_ext_e2e` keeps 120 rpm. `goclaw_test` and `dewee/.env` were not touched.
- Removed worktree `dewee-e2e-combined4` and ran `git worktree prune`. The Dewee main checkout is untouched (`dev`).
- Removed `test-results/`, `playwright-report/` and `.output-e2e/`, and 0 `%TEMP%/dewee-e2e-*` profiles are left. Ran `go clean -testcache`.

Status: DONE
Summary: 21/21 live tests pass twice against the combined 956(b18b35c9)+958+1000+992+1033/1034 stack with the latest extension code. "E lost respond" took 2.8 s in both runs, with one continuation and no retries. The cancelled card now shows "For … Nothing was saved."
Concerns/Blockers: none blocking. The earlier 59.5 s outlier did not reproduce, so its cause is still unproven. The refused and held ("Continue") continuation paths are covered by unit tests only, not by any live scenario.
