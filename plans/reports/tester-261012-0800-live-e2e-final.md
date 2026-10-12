# Live e2e final run against a combined local Dewee stack

Date: 2026-10-12 (Asia/Saigon). Nothing was committed in either repo. The setup from `tester-261012-0100-live-e2e-rerun.md` was reused.

## Stack
- Gateway: a temporary detached worktree, `worktrees/dewee-e2e-combined3`, based on `origin/feat/956-gateway-extension-api` `b18b35c9` (includes `2d02e47a`). Merged in order: 958 `dd164d71` (PR #1019), 1000 `9644cb00`, 992 `70bda2d9`, 1033-1034 `afbe7768` (PR #1045, with the stopped-turn marker `8640e1e9`).
- `dewee_ext_e2e` was already at schema 139 (`migrate up` was a no-op). The rate limit is 120 rpm (`gateway.rate_limit_rpm=120`; the Gateway logged `rpm=120`).
- App: `apps/dewee-app` from the same tree, built for node, using a new throwaway DB `dewee_ext_e2e_app`. Migrations ran through `runSelfHostedMigrations`. Owner, workspace, stub provider and Super Agent were bootstrapped to `agent_bootstrapped`.
- Ports: Gateway 18790, stub 18791, relay 18792 (the spec starts it), app 4321. All four were free at the start.
- Setup note: the Gateway must also load `DEWEE_PROVISIONING_KEY_ID`/`SECRET` from `app-secrets.env`, because `gw-env.ps1` does not. Without them, workspace provisioning answers 404. I restarted the Gateway once with the pair loaded.

## Results (final: `pnpm test:e2e`, 21/21 passed, twice in a row: 2.8 min and 1.8 min)
| Test | Result |
|---|---|
| A Cloud sign-in, workspace, Super Agent chat | PASS |
| C `secret_request` stored encrypted, agent sees `credential_ref` only | PASS |
| C expired card and foreign targets refused | PASS |
| D policy needed, allowlist enforced, **revoke shows the exact `credential_policy_revoked` text** | PASS |
| E double-clicked Save sends one answer | PASS |
| E lost respond reloads as Done, no re-send | PASS (59.5 s once, 2.8 s in 3 other runs; see bug 2) |
| E reopen mid-stream / service worker restart / offline then online / cancelled run | PASS (4) |
| B1 agents, Super Agent first; B2 streamed reply; B2 deltas, settings, Stop | PASS (3) |
| B3 Stop, harmless repeated abort, **next turn works** | PASS |
| B4 revoked key ends the session | PASS |
| E1 history after reopen; uncertain turn shows "Delivery could not be confirmed", then reload | PASS (after the spec change below) |
| Smoke (5) | PASS |

- **D:** the card alert reads exactly "An admin no longer allows this agent to ask for this credential. The card was closed." The card shows Cancelled, and nothing was stored.
- **B3:** for the next turn, the model received `user: slow please …` / `assistant: [Stopped before replying]` / `user: after stop …`. The marker keeps the turns apart, so the merged-turn problem from the 0100 report (observation 3) is gone.
- **E:** a user message is never sent again automatically. Every `streamPosts`/`posts()` count and every server user count is exactly 1. All C/D/E no-leak checks passed (sentinel absent from the Gateway log, storage, console and model inputs).

## Spec change (old behaviour, intentionally changed)
- In the first run, E1 failed. It cut the stream *after* the Gateway took the turn, then went offline and expected an automatic reconcile. The panel offered "Send again" instead.
- That matches the documented policy: in `docs/architecture.md` (Chat), case (b) treats a fetch rejected while `navigator.onLine` is false as not received. The doc names this exact case as a residual risk.
- So the spec encoded pre-policy behaviour. `tests/e2e/live-selfhosted.spec.ts` E1 now:
  - drops the stream while online (uncertain), with `chat/history` briefly unreadable;
  - asserts the alert "Delivery could not be confirmed…" with "Reload conversation" and no "Send again";
  - unblocks history, clicks Reload, and checks one reply, one user turn and one stream POST.
- eslint and `tsc --noEmit` are clean.

## Merge notes
| File | Branches | Resolution |
|---|---|---|
| `CHANGELOG.md` | 958 vs 956, 1033 vs merged | Kept both entries |
| `apps/dewee-docs/spec.hash.lock` | 958 vs 956 | Took 956's hash (regenerate on the real merge) |
| `internal/http/provisioning_chat_abort.go` | 1000 vs 956 | Union: `AbortRun`, `AbortRunsForSession`, `IsSessionBusy` plus `AbortRunInTenant`, `AbortRunsForSessionInTenant` (ctx) |
| `internal/agent/loop_types.go` | 1033 vs 958 | Kept both `credentialRequest` and `unresolvedFallbacks` |
| `docs/project-changelog.md` | 1033 vs merged | Kept both entries |

- 992 merged cleanly.
- `router.AbortRun` ctx: no change was needed. 956's `ExtensionRouterRuntime.AbortRun(ctx, …)` already adapts it.
- `go build` is OK. `go vet ./internal/http` still flags the test fake `recordingChatAborter` (no `AbortRun`), as before; it needs updating on the real merge.

## Evidence (`plans/reports/assets/live-e2e/`)
- Refreshed: `a-cloud-reply`, `b2-streamed-reply`, `b3-stopped`, `b4-revoked`, `c-card-pending`, `c-card-done`, `e-lost-respond-reconciled`, `e-offline`, `e-online-reconciled`, `e1-reconciled`.
- New: `d-revoked-refused.png` (the exact revoke message) and `e1-unconfirmed.png` ("Delivery could not be confirmed" with Reload).
- Removed the stale `d-revoke-generic-conflict.png`, because D now passes.

## Bugs and observations
1. None blocking. The 956 409-details fix (`2d02e47a`) closes last run's backend bug 1.
2. Intermittent: in one full run, "E lost respond" took 59.5 s (it normally takes 2.8 s), but stayed within its timeouts. It did not reproduce in 2 isolated runs or a third full run with traces. The duration fits the `continuation_in_progress` retry ladder (5/15/30 s), but this is not proven. Worth watching.
3. Copy nit (#1045): a turn stopped after partial output (`slow-1 slow-2` was streamed) is stored as `[Stopped before replying]`. The wording overstates it slightly. This is a backend detail.
4. Still open from earlier reports: a Cancelled card still shows "Saved to AI provider …"; the app outbox needs the Gateway provisioning pair before the first workspace (otherwise it retries a 404).

## Cleanup
- Stopped the stub (40940), the Gateway (42392) and its wrapper (43376), and the app (63436) and its wrapper (69136). Ports 18790, 18791, 18792 and 4321 are free; no `dewee` process is left.
- Dropped `dewee_ext_e2e_app`. `dewee_ext_e2e` keeps `gateway.rate_limit_rpm=120`. `goclaw_test` and `dewee/.env` were not touched.
- Removed worktree `dewee-e2e-combined3` and its directory, and ran `git worktree prune`. The Dewee main checkout is untouched (`dev`).
- Removed `test-results/`, `playwright-report/` and `.output-e2e/`; 0 `%TEMP%/dewee-e2e-*` profiles are left. Ran `go clean -testcache`.

Status: DONE
Summary: 21/21 live tests pass, twice, against the combined 956(b18b35c9)+958+1000+992+1033/1034 stack. D shows the exact `credential_policy_revoked` text, B3's next turn works with the stopped-turn marker, and E1 now follows the documented no-auto-resend and "Delivery could not be confirmed" policy.
Concerns/Blockers: none blocking. There was one unexplained slow pass of "E lost respond" (59.5 s). The test fakes for `provisioning_chat_abort` and `spec.hash.lock` need fixing on the real merge.
