# Re-review: dewee #991 (3bf114aa, 670c5870) and #956 (f0eee75a, 8042aeda, 45aa773d)

Reviewer: isolated, read-only. Baselines: `code-reviewer-261011-2150-dewee-991-review.md` and `code-reviewer-261011-2140-dewee-956-957-rereview.md`. Implementer report: `fullstack-261011-2215-dewee-991-956-stack.md`.
Line numbers below refer to the 956 worktree (HEAD 45aa773d) unless noted otherwise.

## Gates I ran (956 HEAD, a superset of 991)
- `go test ./internal/http ./internal/agent ./internal/gateway/... ./internal/channels -count=1` in the default, `sqlite` and `sqliteonly` modes.
  - gateway, gateway/methods and channels pass.
  - The http and agent failures are exactly the dewee#936 baseline list from the implementer report: 10 http tests, plus the 2 WorkspaceSetup tests in the sqlite modes, plus `TestGetForRunEvictsLeastRecentlyUsedPinnedLoops`. No other test fails.
- The focused new tests (sqlite tags) pass, and `go test ./tests/integration -run TestOpenAPI` passes. I ran `go clean -testcache` afterwards.
- `git range-diff bd177a2d..a078e857 670c5870..8042aeda`: 8042aeda is identical to a078e857. f0eee75a differs only in the runner/stream hunks that took #991's code.

## 1. Earlier findings
| ID | Status | Evidence |
|---|---|---|
| S1 buffered stop | Fixed | `provisioning_chat_runner.go:86-91` wraps the error as `workspaceChatStoppedError` when `runCtx.Err()!=nil` (cancel is deferred, so only an abort or the fence sets it). `provisioning_chat.go:299-306` answers 409 `run_stopped` with run_id/session_key and skips `runFailed`. |
| S1 and the CCP | Compatible | `apps/dewee-app/src/lib/runtime-workspace-chat-client.ts:38-45` throws `AppError("runtime_workspace_chat_failed", error.message, 409)` for any non-2xx, and nothing retries on it. The CCP buffered call never sends `session_key` (:26-32), so the CCP cannot abort its own buffered run. 409 is only reachable through WS `chat.abort` or the fence. No CCP change is needed. |
| S2 double terminal | Fixed | `provisioning_chat_stream.go:146-151,186-202`. `stoppedSent` suppresses a second `chat.stopped`, and a held setup `chat.error` is dropped on a stop. Child run lifecycle events are not forwarded (`loop_pipeline_tool_callbacks_event_tap_test.go:53-60`), so a delegate's `run.cancelled` cannot end the parent stream. |
| S3 busy guard | Fixed | `provisioning_chat.go:257-262`, before `claimContinuation`, so a refused send never consumes a card. `router.go:365-368` uses `CompareAndDelete(sessionKey, runID)`, and `sessionRuns` stores runID strings (:344), so the comparison is valid. |
| S5 / #1001 | Fixed | `provisioning_chat_stream.go:91-109`: marshal happens outside the lock, then `done` is re-checked, the frame written and flushed under `mu`. The writes to `terminalSent`/`heldSetupError` in `onEvent` happen only for run-level terminal events, which fire on the Run goroutine, so they do not race with tool-goroutine taps. |
| S6 handler test | Fixed | `provisioning_chat_stop_test.go:118-180` drives the real handler, `NewAgentRouterWorkspaceChatRunner` and `agent.Router` with a request ctx cancelled mid-run. |
| N1 (956) | Fixed | `cmd/gateway_http_wiring.go:445-446` passes the registering runner and `d.agentRouter` as runtime. Busy guard `extension_api_chat.go:102`, abort `:195-198`. No run deadline exists; this matches `chat.send` and the implementer listed it as a concern. |
| N2 (956) | Fixed (doc) | The `rate_limit_rpm=0` coupling is documented in `docs/18-http-api.md` section 38 and in the OpenAPI `info.description`. The wiring is unchanged (`gateway_http_wiring.go:451-453`). |
| Nits 991 | Fixed | `channels.ExtractPayloadString` is exported (`channels/events.go:686`). Defer order is now drain, then cancel, then Unregister (`runner.go:61-63`, LIFO), matching chat.send. The fence is named in the comment. |
| Nits 956 | Fixed | Dead suspended branch removed. `entitlementSuspended` (`extension_api.go:211-219`, used at :263). `created_at` is omitted for nil/zero (`extension_api_read.go:323-326`, tag `omitempty` at :277). |

## 2. Rebase correctness
- `provisioning_chat_runner.go:44-85` keeps #956's `traceName` default and `TraceName: traceName` (:84). It also keeps all of #991: WithoutCancel, InjectTeamDispatch, WithCancel, RegisterRun, the defers, `InjectCh`, `OnTraceCreated`, and the stop wrap.
- `provisioning_chat_stream.go` keeps #956's `RunContext/TraceName/Surface` (:63-70) and `streamWorkspaceChat` (:127). It also keeps #991's writer (`newSSEEventWriter(w, r.Context().Done())` at :135), `stoppedSent`, the stop branch, and the `channels.ExtractPayloadString` mapping (:239-241).
- Nothing was lost on either side.

## 3. Stopped setup continuation that was not delivered
- How long: `setupContinuationClaimLease = 10*time.Minute` (`provisioning_chat_setup_turn_lease.go:28`).
  - On a stop, `runFailed` is skipped (`stream.go:190`, `provisioning_chat.go:299-306`).
  - Then `finish()` (`lease.go:130-140`) stops the heartbeat and leaves the mark when `!delivered`.
  - A resend within 10 minutes gets 409 `continuation_sent` (`lease.go:167-170`).
  - After that, `ReclaimStaleContinuation` plus `continuationInSession` re-sends the card.
- How often: rarely. `finalizeRun` flushes pending messages under `WithoutCancel` even on a cancel (`pipeline/pipeline.go:200,210-216`, `finalize_stage.go:115-117`), so most Stops fire `OnInputPersisted` and finalize the mark as delivered, which is correct.
  - The undelivered case is a stop or fence before the user turn reaches the pending buffer (setup stage).
  - It also covers a tenant-transfer fence, which cancels inside `RegisterRun` before `loop.Run` starts.
- Extension impact: it does not auto-retry a stop (an AbortError only dispatches `chat.stopped`, `use-chat.ts:205-207`). A manual re-click of the card (`ChatShell.tsx:122`) within 10 minutes, though, shows "The agent already continued after this card." That message is false, because the agent never saw the result.
  - The 409 also sets `reconcile` (`use-chat.ts:211-212`).
  - Its stream-failure retry (`retryContinuation`) has the same problem for a fenced run.
- Verdict: Should-fix (S-A below). The fix is one line and safe.

## 4. Regressions
- chat.send: the only shared change is `UnregisterRun`'s `CompareAndDelete`, which is strictly more correct. Gateway/methods tests pass.
- Workspace chat (CCP stream): there is a new 409 busy refusal when the CCP resends into a session whose detached run is still going. That is the intended behavior. The CCP surfaces it as a generic `runtime_workspace_chat_stream_failed` 409. Nothing else changed for a completed or failed run.
- Extension routes: status, abort and busy now work for real. The read routes are unchanged apart from `created_at`. I found no regression.

## 5. Do the tests fail without the fixes?
- `TestUnregisterRunKeepsNewerSessionRun` fails with `Delete`.
- `...StreamRunSurvivesRequestCancel` fails with a request-bound writer or runner.
- `...StoppedSetupTurnReportsStopOnce` fails if the old code emits `setup_result_delivered`.
- `...RefusesChatInBusySession` fails without the guard.
- The runner test's `workspaceChatStopped` assertion fails without the wrap.
- The implementer showed that the SSE concurrency test fails without `mu`.
- `TestExtensionAPIStreamRunIsRegisteredWithRouter` (`extension_api_router_sqlite_test.go:38-111`) is still meaningful:
  - It exercises everything except the loop: the real route, auth, the registering runner, the real `agent.Router` (RegisterRun, IsSessionBusy, SessionRunID, AbortRun), the stop wrap and the SSE stop path.
  - It would fail on the pre-rebase 956 wiring (no registration, so status is idle and abort returns false).
  - Gap: it cannot prove that the real `loop.Run` emits `run.cancelled`. That is covered by `loop_run.go:219-220` and does not matter here, because the fallback `chat.stopped` at `stream.go:200-201` covers a missing event.
- `TestProvisioningHandlerBufferedChatStopIsNotRetryable` uses a fake runner that returns the stop error directly. That is acceptable because the runner-level test covers the wrap.

## 6. Entitlement mapping and created_at
- Entitlement: correct. `RequireActiveTenant` wraps `ErrTenantEntitlementInactive` for any non-active entitlement (`tenantaccess/evaluator.go:72-73`). Only an exact `suspended` maps to `membership_suspended`.
  - Both the PG and SQLite CHECK constraints allow only active/suspended (`migrations/000082...up.sql:3`), so the fallback is defensive. The lack of a test is acceptable.
- `created_at`: the extension accepts an omitted value. `historyMessage.created_at: nullableString` = `z.string().nullish()` (`src/api/schemas.ts:8,60`). `chat-state.ts:78` uses `m.created_at ?? ''` only in the id fallback, and the gateway always sends `id`. Tests already build `created_at: undefined` (`tests/unit/chat/history.test.ts:6`).

## Findings

### Blocking
None.

### Should-fix
- **S-A. A stopped continuation that was not delivered stays locked for 10 minutes with a false message.**
  - Where: `provisioning_chat_stream.go:188-192` and `provisioning_chat.go:299-306`.
  - Evidence: section 3.
  - Fix: on a stop, still settle the lease without reporting a failure, for example call `setupTurn.runFailed(inputDelivered)` and ignore its result. With `inSession=false` it releases the mark (the run left no trace, so a resend is safe). With `true` it is a no-op, and `finish()` finalizes.
  - Add a case to `TestProvisionWorkspaceChatStoppedSetupTurnReportsStopOnce` that stops without `OnInputDelivered`, then resends the card and expects a run, not a 409.

### Nit
- **N-a.** A tenant-transfer fence is reported to the person as a user stop (`run_stopped` / `chat.stopped`) with no explanation (`runner.go:86-91`). It is rare. Consider a distinct log line or code.
- **N-b.** `entitlementSuspended` adds a second `GetTenant` on the refusal path (`extension_api.go:211-219`). The status is already in the wrapped error text (`evaluator.go:73`). This is cosmetic.
- **N-c.** The busy guard is check-then-act: two simultaneous sends can both pass `IsSessionBusy` (`provisioning_chat.go:259`, `extension_api_chat.go:102`). This is the same as other surfaces, and the narrow window makes it acceptable.
- **N-d.** `CompareAndDelete` fixes the "old run ends last" ordering only. If the newer run ends first, the index is cleared while the older run is still running. That can no longer happen on these routes because of the busy guards, so this is informational.

Status: DONE
Summary: Every earlier finding (S1, S2, S3, S5/#1001, S6, N1, N2 and the nits) is fixed correctly. The rebase lost nothing, CCP and extension clients stay compatible, and the tests fail without the fixes and pass now, apart from the known Windows baseline failures. One should-fix: a stopped continuation that never reached the session stays locked for 10 minutes, and a resend in that window gets a false "already continued" 409.
Concerns/Blockers: no -race (no cgo). The 991 branch was not tested on its own; the 956 HEAD contains it.
