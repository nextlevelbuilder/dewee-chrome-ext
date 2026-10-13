# Review: dewee a3d727b1 (fix/1000-cross-tenant-run-access), dewee#1000

Scope: `git diff origin/dev...HEAD` (7 files). This was a read-only review. A scratch export was used to revert the fix, and the scratch copy has been deleted.

## Verdict
The fix is correct for chat.abort, chat.status, the cancel keyword, the HTTP concurrency cancel/status, and the workspace chat abort.
One cross-tenant abort path remains through the chat-concurrency steer intent, and one status oracle remains.

## Blocking
1. **A cross-tenant abort still works through chat.send or HTTP using the steer intent.** See `internal/chatconcurrency/related.go:43` and `internal/chatconcurrency/coordinator.go:121`.
   - `Prepare` calls the unscoped `router.IsSessionBusy(in.VisibleSessionKey)` (coordinator.go:121). This returns true when tenant B has a run on that key, even though tenant A's `ListActiveChatRunContexts` is empty.
   - On `IntentSteer`, `selectActiveContext(empty, visible)` falls back to the caller-supplied key (session.go:39-41). `prepareRelatedRestart` then calls the unscoped `c.router.AbortRunsForSession(target.RunSessionKey)` (related.go:43), which aborts tenant B's run.
   - Entry points:
     - WS `chat.send` with `sessionKey` set to B's key. Ownership is not an obstacle: `m.sessions.Get(ctxA, keyB)` returns nil, so the call is treated as a new session (chat.go:258-263), and `agentId` can be the caller's own agent.
     - HTTP `X-GoClaw-Session-Key` (chat_completions.go:181-187, and the same in responses.go) through `prepareExplicitChatConcurrency`.
   - Exploitability: this is the same precondition as the issue (knowing B's session key). But it is broader, because **any authenticated member** can do it, not only an admin. The attacker controls the message, so the steer classification is easy to steer. It also needs a provider or usage caps so the classifier runs. The coordinator is non-nil in both PG and SQLite wiring (store/pg/factory.go:51, sqlitestore/factory.go:46), and `EffectiveEnabled` defaults to true.
   - Fix: scope coordinator.go:121 with `IsSessionBusyInTenant(ctx, …)` and related.go:43 with `AbortRunsForSessionInTenant(ctx, …)`. Add a two-tenant test in chatconcurrency. If you would rather keep this PR narrow, open a linked `security` issue. Note that the comment in router_tenant_scope.go:14-17 currently claims that "cancel keywords" paths are covered.
2. **The same line, coordinator.go:121, is an existence oracle.** When B's key is busy, the cancel or status intent returns a "cancelled" or "idle status" reply and no run starts. When the key is free, a normal run is scheduled. That is a visible difference, so a cross-tenant run does not yet look like a missing run on this surface. Scoping line 121 fixes both problems.

## Should-fix
3. **The mid-run injection at `internal/gateway/methods/chat.go:428-429` is still unscoped** (`IsSessionBusy` and `InjectMessage`). A member of tenant A could inject a user message into tenant B's run. This path is only reached when `m.concurrency == nil`, and production wiring always sets the coordinator, so the real exploitability is low. It is a one-line defence-in-depth change: gate it on `SessionRunIDInTenant` and add an `InjectMessageInTenant`.
4. **The `sessionRuns` index is shared across tenants.** `RegisterRun` overwrites `sessionRuns[key]` (router.go:351), and `UnregisterRun` deletes it by key (router.go:366). A tenant A run started on B's key (finding 1 path) therefore hides or clears B's index entry. B's own `IsSessionBusy`, `SessionRunID` and `InjectMessage` then misbehave, which is a cross-tenant disturbance or DoS. `SessionRunIDInTenant` works around this for reads, but the index itself should be keyed by tenant and session (for example `tenant:session`). This was already true before the change; it is the remaining root cause.
5. **The channel consumers in `cmd/gateway_consumer_normal.go` (lines 353, 502, 522, 548 and 946 via `abortSessionRunsForSender`) still use unscoped lookups.**
   - The session key there comes from channel, peer and agent, so the caller cannot choose it.
   - A collision needs the same peer, the same channel name and the same agent key in two tenants. That is effectively the same person on two bots, so exploitability is low. The result would be wrong-tenant steer injection, status or cancel.
   - `ctx` already carries `msg.TenantID` (line 43), so switching to the `InTenant` variants is cheap.
   - `cmd/gateway_events.go:345,354` (`SessionKeyForRun` from internal agent events) cannot be reached by a client. That is fine.
6. **Team and subagent paths.** No other router lookups exist: the grep over internal/ and cmd/ found only the sites listed above. Team and subagent runs go through the scheduler, using the consumer lookups in finding 5 and `Sched.CancelSession` (gateway_consumer_handlers.go:519), which is keyed by session only. No caller-chosen key reaches them.

## Nit
7. Logging is asymmetric. `security.cross_tenant_run_abort_denied` (router_tenant_scope.go:48-51) fires only for run-ID aborts, not for session-key aborts or status probes. The logged fields are `run_id` and two tenant UUIDs. They contain no secrets and are safe to log.
8. `SessionRunIDInTenant` skips `State==2` in the fallback scan (line 97) but not on the fast path (line 88). This is harmless, but inconsistent.
9. Behaviour change: the owner role, which `IsMasterScope` treats as cross-tenant, no longer reaches runs in other tenants. Only the caller's ctx tenant counts. This fails closed and is consistent with the issue, but it is worth a line in the PR body. The `uuid.Nil` to Master mapping matches the tenant half of `store.IsMasterScope` (context.go:507-516). Non-master callers never match runs with a nil tenant (test at router_tenant_scope_test.go:62-72). WS clients always get a tenant (gateway/router.go:236-237 and 322-323).
10. The workspace chat runner calls `loop.Run` directly and never calls `RegisterRun` (provisioning_chat_runner.go:46). So the provisioning abort only reaches router-registered runs on the same app session key. This is pre-existing and outside this fix. `tenantCtx` always carries `binding.TenantID` (provisioning_chat_abort.go:96), so the changed interface is sound.

## Checks
- Not-found equivalence: a cross-tenant run-ID abort returns `{RunID, NotFound}` before the session check, so there is no `Unauthorized` leak. The session paths return an empty list, the same as for a missing run. The timing difference is one extra `sync.Map` load plus a log line (microseconds, not observable over WS or HTTP). Error codes are identical.
- TOCTOU between the tenant check and `AbortRun`: run IDs are UUIDs and never reused, so this is not an issue.
- Same-tenant behaviour is unchanged. `TestChatAbortSameTenantStillAborts` and the same-tenant asserts in the agent test pass. Runs register with the caller's ctx tenant on every surface (chat.go:454, the HTTP handlers, and the scheduler's `pending.Ctx`).
- Tests would fail without the fix. I verified this by putting the origin/dev `chat.go` into a scratch copy of HEAD: all 4 `TestChatAbortCannotReachAnotherTenantsRun` subcases and `TestChatStatusHidesAnotherTenantsRun` fail. The agent and http tests depend on the new API, so they would not compile without it. The http test only checks that the tenant is passed through; there is no real-router two-tenant test for the provisioning abort.
- There is no test for the chat.send cancel or steer path, or for chatconcurrency (see finding 1).

## Test runs (Windows)
- `go vet` on the 3 packages is clean. `internal/gateway/methods` passes.
- `internal/agent`: only `TestGetForRunEvictsLeastRecentlyUsedPinnedLoops` fails, and it fails identically on origin/dev.
- `internal/http`: 10 failures (symlink, media, SecureCLI, SSH CRLF, skill export). The same 10 fail on origin/dev, so they are the known Windows failures tracked in dewee#936.
- I ran `go clean -testcache` afterwards, and the worktree is unchanged.

Status: DONE_WITH_CONCERNS
Summary: The fix correctly scopes chat.abort, chat.status, the cancel keyword, the HTTP cancel/status and the workspace abort to the caller's tenant, and its tests are real regressions. One blocking path remains: the chat-concurrency steer path (coordinator.go:121, related.go:43) still lets any member abort, or probe, another tenant's run by session key.
Concerns/Blockers: Scope coordinator.go:121 and related.go:43, and add a test, or explicitly move them to a linked security issue. The tenant-shared `sessionRuns` index (router.go:351, 366) is the remaining root cause.
