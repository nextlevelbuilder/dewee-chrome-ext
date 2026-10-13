# dewee #991 / #1001 / #956 stack: fixes, gates, commits

Repo: nextlevelbuilder/dewee. Nothing pushed, no PRs opened, nothing amended.

## Commits
| Branch | Hash | Subject |
|---|---|---|
| fix/991-workspace-chat-runtime | 3bf114aa | fix(gateway): report stopped workspace chat runs once and guard busy sessions (Refs #991) |
| fix/991-workspace-chat-runtime | 670c5870 | fix(gateway): serialize workspace chat SSE writes (Closes #1001) |
| feat/956-gateway-extension-api | f0eee75a, 8042aeda | rebased 5e3e03ae, a078e857 onto 670c5870 (was bd177a2d) |
| feat/956-gateway-extension-api | 45aa773d | fix(http): wire extension chat to registered runs (Refs #956) |

## Part 1 (991 review), 3bf114aa
- S1: `provisioning_chat_runner.go`. A cancelled run ctx returns `workspaceChatStoppedError{RunID,SessionKey}`.
  - Buffered path: `provisioning_chat.go` answers 409 `run_stopped` with run_id/session_key details, not a retryable 500. `runFailed` is skipped.
  - I chose 409, not a 200 `stopped:true`: CCP `assertRuntimeChat` throws on empty content, so a 200 would surface as a 502.
- S2: `provisioning_chat_stream.go`. A stop sends exactly one `chat.stopped` (`stoppedSent` flag), with no follow-up `chat.error`, also on setup turns. `runFailed` and the error log are skipped on a stop.
- S3: 409 busy guard in `provisioning_chat.go`, before `claimContinuation`. It uses #956's wording and the new `IsSessionBusy` on the aborter interface, wired with `d.agentRouter`.
  - `agent/router.go` `UnregisterRun` uses `sessionRuns.CompareAndDelete(sessionKey, runID)`.
- S6: handler test with a mid-run request cancel through a real Router.
- Nits:
  - `channels.ExtractPayloadString` is exported (14 call sites) and replaces `chunkContent`;
  - the runner defers drain team dispatch, then cancel, then UnregisterRun (same order as chat.send);
  - the runner comment names the tenant-transfer fence.
- Tests:
  - `TestUnregisterRunKeepsNewerSessionRun`
  - `TestProvisioningHandlerBufferedChatStopIsNotRetryable`
  - `TestProvisioningHandlerRefusesChatInBusySession` (buffered and stream)
  - `TestProvisioningHandlerStreamRunSurvivesRequestCancel`
  - `TestProvisionWorkspaceChatStoppedSetupTurnReportsStopOnce` (sqlite tags)
  - an extended `TestAgentRouterWorkspaceChatRunnerRegistersRunForStatusAndAbort`

## Part 2 (#1001), 670c5870
- `provisioning_chat_stream.go`: `sseEventWriter` has `mu sync.Mutex`. `send` marshals outside the lock, then under the lock re-checks `done`, writes the frame and flushes.
- Tests in `provisioning_chat_sse_writer_test.go`:
  - `TestSSEEventWriterConcurrentSendsKeepFramesIntact` (16 goroutines x 50 frames, each parsed);
  - `TestSSEEventWriterDropsFramesAfterDisconnect`.
- `-race` is unavailable: `CGO_ENABLED=0` and there is no gcc on this machine.
  - Instead I removed the lock temporarily and ran the concurrent test: it failed (448/800 and 540/800 frames). With the lock it passes.

## Part 3 (#956), rebase and 45aa773d
- `git rebase --onto fix/991-workspace-chat-runtime bd177a2d feat/956-gateway-extension-api`. The worktree was clean first.
- The only conflict was `provisioning_chat_runner.go`. I kept #956's `traceName` default and #991's detach/register/inject/trace block.
- `provisioning_chat_stream.go` auto-merged. `streamWorkspaceChat` keeps `newSSEEventWriter(w, r.Context().Done())` (:135).
- `extension_api_chat.go:116-120` keeps the `WithoutCancel`. The comment no longer claims a run timeout: the run is stopped by the router abort or the fence. The `WithoutCancel` at :161 (continuation lease) is unchanged.
- One busy guard per route:
  - extension at `extension_api_chat.go:102`;
  - provisioning at `provisioning_chat.go:259`;
  - `streamWorkspaceChat` has none.
- New test `TestExtensionAPIStreamRunIsRegisteredWithRouter` (`extension_api_router_sqlite_test.go`) wires the real `agent.Router` as both runner and runtime. It checks:
  - the status route is running with a run_id;
  - a second send gets 409 `run_in_progress`;
  - the abort route stops the run and the run ctx is cancelled;
  - the stream's last frame is the only `chat.stopped`, with no `chat.error`;
  - the status is idle afterwards.
  - The stub is a blocking `agent.Agent`, not a full loop with a stub provider. It emits run.cancelled on stop, as `loop.Run` does.
- N2:
  - `docs/18-http-api.md` section 38 says `gateway.rate_limit_rpm=0` disables extension stream/respond throttling.
  - `openapi_spec.json` `info.description` has a new "Rate Limiting" section. The spec has no `/v1/extension` paths, so the description is the only OpenAPI surface.
  - `node apps/dewee-docs/scripts/sync-openapi.mjs` regenerated the public copy and `spec.hash.lock`. `--check` passes (85 paths, hash matches).
- Nits:
  - `extension_api.go`: the dead workspace-scoped suspended branch in `auth` is removed. `resolveCaller` (~:263) maps `ErrTenantEntitlementInactive` to `membership_suspended` only when the tenant's entitlement is exactly `suspended` (new `entitlementSuspended`, ~:211); anything else is `forbidden`.
  - `extension_api_read.go:323`: `created_at` is omitted when the timestamp is nil or zero.
  - The docs note both changes.

## Gates (both branches, after each commit)
- `go build ./...` in the default, `-tags sqlite` and `-tags sqliteonly` modes: pass.
- `go vet` on internal/http, agent, channels and gateway, in all three modes: pass.
- gofmt -l on the touched files: clean.
- `go test` of internal/http, agent, gateway/..., channels in all three modes: gateway, gateway/methods and channels pass, and every new test passes.
- `go test ./tests/integration -run TestOpenAPI`: ok on both branches.
- Known Windows failures (dewee#936). Each one fails identically on the base worktree at 459633e5 in the same modes:
  - internal/http:
    - TestFilesHandleServe_OpenThenSwapToSymlinkEscape_Returns404
    - TestProvisioningHandlerStreamContinuesExistingSessionWithMedia
    - TestProvisioningHandlerAcceptsWorkspaceChatMediaLegitRoundTrip
    - TestProvisioningHandlerCleansUpMediaAfterChatTurn
    - TestSecureCLICheckBinaryFindsRuntimeNpmBinary
    - TestSecureCLICheckBinaryFindsGoogleWorkspaceRuntimeBinary
    - TestSecureCLICheckBinaryFindsNpmPackageCliAlias
    - TestPutUserCredential_SSHKeyCRLFNormalized
    - TestSkillExportImportRoundTripPreservesResourcesAndModes
    - TestSkillExportHTTP_SQLiteSingleSkillDownload
    - with the sqlite tags only: TestWorkspaceSetupOnboardingFlowEndToEnd and TestWorkspaceSetupSecretLeakSweep
  - internal/agent: TestGetForRunEvictsLeastRecentlyUsedPinnedLoops
- Only per-test temp sqlite DBs were used. goclaw_test and dewee_ext_e2e were not touched.
- `go clean -testcache` ran. The throwaway base worktree `_b991` was removed.


## Follow-up: re-review S-A, then rebase onto origin/dev
- **Fix (S-A):** a stop now calls `setupTurn.runFailed(inputDelivered)` and ignores the result. This is done in `provisioning_chat.go` (the buffered stop branch) and in `provisioning_chat_stream.go`, where `delivered` is then cleared, so a stop still reports only `chat.stopped`.
  - An undelivered card (early abort, or the tenant-transfer fence) is released.
  - A delivered card stays continued.
- **Test:** `TestProvisionWorkspaceChatStoppedSetupTurnSettlesContinuation` (sqlite tags) covers stream and buffered, delivered and undelivered:
  - after an undelivered stop, a resend starts a new run;
  - after a delivered stop, a resend gets 409 and nothing runs.
  - Without the fix the test fails with the false 409 `continuation was already sent`.
- **Commit:** `fix(gateway): release undelivered setup continuations when a run stops` (Refs #991). It was eb2f90c9 before the dev rebase.
- **Rebase onto dev:** 956 was rebased `--onto` eb2f90c9 and its gates re-run. Then `git fetch origin dev`.
  - 991 was rebased onto origin/dev. One conflict, in `provisioning_chat_stream_test.go`: both sides added test helpers, and I kept both.
  - 956 was rebased `--onto` the new 991 tip. `CHANGELOG.md` and `docs/project-changelog.md` conflicted; I kept both entries.
  - dev then advanced to 5edde4e7 (#1009), so I repeated both rebases cleanly onto 5edde4e7.
- **New hashes** (both branches are on origin/dev 5edde4e7):

| Branch | Commit | Subject |
|---|---|---|
| fix/991-workspace-chat-runtime | b02e5158 | stream deltas, register runs (the original #991 commit) |
| fix/991-workspace-chat-runtime | 23af486d | report stopped runs once, busy guard |
| fix/991-workspace-chat-runtime | 4b907f2b | serialize SSE writes (#1001) |
| fix/991-workspace-chat-runtime | 9f3e6e2e | release undelivered setup continuations when a run stops |
| feat/956-gateway-extension-api | 4b6e1a6c | extension API |
| feat/956-gateway-extension-api | 071923a6 | extension tenant role and rate limits |
| feat/956-gateway-extension-api | 3da5cfae | wire extension chat to registered runs |

- **Gates after the final rebase,** for each branch in the default, sqlite and sqliteonly modes:
  - `go build ./...` and `go vet ./internal/http ./internal/agent` pass;
  - `go test ./internal/http ./internal/agent`: agent passes, and http fails only on tests that also fail on a clean origin/dev worktree at 5edde4e7. Those are TestFilesHandleServe_OpenThenSwapToSymlinkEscape_Returns404, the three TestSecureCLICheckBinaryFinds* tests, TestPutUserCredential_SSHKeyCRLFNormalized, and with the sqlite tags TestWorkspaceSetupOnboardingFlowEndToEnd and TestWorkspaceSetupSecretLeakSweep;
  - `tests/integration -run TestOpenAPI` is ok;
  - `sync-openapi.mjs --check` passes on 956.
  - dev's #949 fixed the other earlier Windows failures.
- The throwaway worktree `_bdev` was removed and `go clean -testcache` ran. Nothing is pushed.

## Concerns
- `run_stopped` (409) is a new buffered contract code. The CCP caller surfaces it as an AppError and does not retry; a friendlier CCP message is a follow-up.
- The entitlement mapping for non-suspended states is defensive. The SQLite CHECK constraint allows only active and suspended today, so it has no test.
- #991 adds no hard run deadline. The reviewer's N1 asked for one; runs stop only through abort or the fence. Open an issue if a deadline is wanted.
- S4 (cross-tenant admin abort/status) is out of scope and needs its own security issue.
- The 957 nits N3 and N4 (CCP relay double terminal, sessions fan-out) were not in this scope.


Status: DONE_WITH_CONCERNS
Summary: S-A is fixed on 991: stopped setup turns release an undelivered continuation and keep a delivered one, and tests cover both. Both branches are rebased onto origin/dev 5edde4e7. Gates pass, except Windows failures that also fail on dev.
Concerns/Blockers: no -race (no cgo/gcc); no hard run deadline; the non-suspended entitlement fallback has no test because the DB constraint forbids other states; run_stopped is a new buffered code for CCP. Nothing is pushed.
