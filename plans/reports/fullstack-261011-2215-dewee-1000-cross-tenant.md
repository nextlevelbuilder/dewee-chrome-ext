# dewee#1000: cross-tenant run access (abort / status / steer / inject)

Worktree: `D:/www/nextlevelbuilder/worktrees/dewee-1000-cross-tenant-run-access`, branch `fix/1000-cross-tenant-run-access`
Commits (not pushed, no PR):
- `a3d727b1` fix(gateway): scope run abort and status to the caller's tenant (Closes #1000)
- `3f9fa5dd` fix(gateway): scope steer, inject and channel run lookups to the tenant (Refs #1000). This commit covers the review findings.

## Fix
`internal/agent/router_tenant_scope.go` holds the tenant-scoped router lookups. router.go and its shared `sessionRuns` index are untouched.
- `activeRunInTenant` (:38) matches `ActiveRun.TenantID` against `store.TenantIDFromContext(ctx)`. A nil tenant is treated as master.
- `AbortRunInTenant` (:77) returns NotFound before the session-key check.
- The other lookups are `AbortRunsForSessionInTenant` (:88), `SessionKeyForRunInTenant`, `SessionRunIDInTenant` and `IsSessionBusyInTenant` (:112-138), `InjectMessageInTenant` (:144) and `GetActivityInTenant` (:159).
- The session-index fast path now skips finished runs (State==2), like the fallback scan.
- Every lookup that hides another tenant's run logs `security.cross_tenant_run_access_denied` (:31) with op, run_id, session and both tenant IDs.

Callers switched:
- WS chat.status `chat.go:97-137`, chat.abort `:761-783`, chat.send cancel/status `:278,311,320,395`, and the inject fallback `:428-429`
- Chat concurrency: `internal/chatconcurrency/coordinator.go:121` (busy check, which was the steer path and the existence oracle) and `related.go:43` (steer restart abort)
- HTTP: `internal/http/chat_concurrency_runtime.go:65,116` and the workspace abort `provisioning_chat_abort.go:22-23,136-138`
- Channel consumer: `cmd/gateway_consumer_normal.go:353,502,522,548,946`. Its ctx carries `msg.TenantID`, or master when that is unset.

The only remaining unscoped caller is `cmd/gateway_events.go:345,354`. It maps internal agent events and is not reachable by a client.

## Tests
- `internal/gateway/methods/chat_tenant_scope_test.go`:
  - A tenant-A admin tries chat.abort four ways (runId, runId+session, session, runId+wrong session). Each looks like a missing run, and B's run is not cancelled and stays busy.
  - chat.status for A is idle while B still sees its own run.
  - B can still abort its own run.
- `internal/chatconcurrency/tenant_scope_test.go`:
  - A sends to B's busy session key with steer, cancel or status intent. The decision matches the idle-session decision, the message is not classified, and B's run keeps going.
  - A steer restart aborts A's run on a shared key, never B's.
- `internal/http/provisioning_chat_abort_test.go`, with a real router:
  - The workspace abort, by session or by B's run_id, does not touch the other tenant's run.
  - An own-tenant run is still aborted.
  - The fake checks that the abort receives the workspace tenant.
- `internal/agent/router_tenant_scope_test.go` covers the helpers:
  - other tenants are hidden, and a tenant finds its own run when the shared index points at another tenant's run;
  - a nil tenant is treated as master;
  - inject reaches only the caller's own run;
  - the fast path skips a finished indexed run.
- Fail-without-fix checks:
  - Reverting chat.go made the chat.abort and chat.status tests fail.
  - Reverting coordinator.go and related.go made both chatconcurrency tests fail: tenant A got schedule/related, cancel and status decisions, and B's run was aborted.

## Commands and results (2nd commit)
| Command | Result |
|---|---|
| `go build ./...`, `-tags sqlite`, `-tags sqliteonly` | ok, ok, ok |
| `go vet ./internal/agent/ ./internal/chatconcurrency/ ./internal/gateway/methods/ ./internal/http/ ./cmd/` | ok |
| `gofmt -l` on touched files | clean |
| `go test -count=1 ./internal/chatconcurrency/ ./internal/gateway/methods/ ./internal/agent/` | ok x3 |
| `go test -count=1 -run "ProvisioningHandler.*Abort" ./internal/http/` | ok |
| `go test -count=1 ./internal/http/` | 10 FAIL: symlink, 3 media, 3 SecureCLI, SSH CRLF, 2 skill export |
| `go test -count=1 ./cmd/` | 3 FAIL: TestOnboardEnvFileSurvivesShellSourcing, TestShellQuoteEnvValueRoundTripsThroughBash, TestRGDGrantKeySourceErrors |
| The same failing tests on a clean origin/dev worktree (removed afterwards) | all fail identically there, so they are the known Windows failures (dewee#936) |
| `go clean -testcache` | ok |

`TestGetForRunEvictsLeastRecentlyUsedPinnedLoops` (internal/agent) failed in the first run, on origin/dev too, and passed this time, so it is flaky.

## Parity
- Surface parity:
  - Web UI and CLI: N/A, because response shapes are unchanged and a cross-tenant run looks missing or idle.
  - API contract: unchanged.
- Trace parity: N/A, because no agent activity is added. Denials are logged as `security.*` and contain IDs only.

## Notes for the PR
- Behaviour change: callers with the system owner role reach only runs in the tenant of their request context. Before this change they reached any tenant's run. It fails closed and matches the issue.
- Remaining root cause: the shared `sessionRuns` index (router.go RegisterRun/UnregisterRun) can still be overwritten or cleared across tenants on a session-key collision. The read paths work around it by scanning. The coordinator is filing a separate issue for it.
