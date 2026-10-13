# Dewee #956 review fixes (Gateway /v1/extension)

Worktree `D:/www/nextlevelbuilder/worktrees/dewee-956-gateway-extension-api`, branch `feat/956-gateway-extension-api`.
Commit **a078e857** `fix(http): enforce tenant role and rate limits on the extension API` (local only, not pushed).
The gateway on :18790 was not touched.

## Findings

1. **B2 viewer runs chat as operator/admin: confirmed, fixed.** `runRole` fell back to the key role because `permissionRoleFromTenantRole("viewer")` returns "". Added `extensionTenantPermissionRole` (owner/admin→admin, operator/member→operator, viewer→viewer, unknown→refused) in `extension_api.go`. The provisioning mapping is unchanged. `resolveCaller` refuses an unknown tenant role on every route, and refuses a viewer with 403 `forbidden` on the write routes (stream, abort, respond). `runRole` = min(tenant role, key role).
   Tests: `TestExtensionAPIViewerReadsButCannotWrite` (operator.admin viewer key: reads OK, stream/abort/respond 403, no run or abort happened), `TestExtensionAPIRunRoleIsTheLowerOfTenantAndKey` (sqlite and unit).
2. **S4 rate limit: confirmed, fixed.** `ExtensionHandler.SetRateLimiter(allow, rpm)` is wired in `cmd/gateway_http_wiring.go` from `d.server.RateLimiter()` (when enabled) and `cfg.Gateway.RateLimitRPM`. It applies after auth with the key `extension_key:<api key id>` (never the token). A refused request gets 429 `rate_limited`, `retry_after_seconds`, and `Retry-After` = ceil(60/rpm), at least 1 (3s at the default 20 rpm). `Retry-After` was added to `corsContractExposeHeaders` (`internal/gateway/server.go`).
   Scope decision: only `chat/stream` and `respond` are limited. Reads are not, because the default bucket (20 rpm, burst 5) would throttle the panel's ~6 parallel reads on open. `chat/abort` is not, so a run can always be stopped. Test: `TestExtensionAPIRateLimitsWritesPerKey`.
3. **S7 actions paging: confirmed, fixed.** `listActionEnvelopes` follows `next_cursor` (up to 10 pages of 200) when `status` is set, and returns at most 200 cards. The query without a filter is unchanged (1 page). Test: `TestExtensionAPIActionsFollowCursorForStatusFilter` (1 old pending card behind 200 closed ones).
4. **S6 missing tests: added.** Customer session token refused, a former member refused on read and stream (`TestExtensionAPIRefusesSessionTokensAndFormerMembers`), suspended workspace (`TestExtensionAPISuspendedWorkspace`), viewer stream (item 1). CORS and preflight now go through the real `Server.Handler()` with the extension handler mounted (`internal/gateway/extension_cors_test.go: TestExtensionAPICORSThroughServerHandler`).
   **New bug found by the suspended test:** `resolveActiveTenantByID` already refuses a suspended entitlement, so the client got 403 `forbidden`, and the `membership_suspended` branch in `auth` could never run. Fixed: `resolveCaller` calls the evaluator directly and maps `store.ErrTenantEntitlementInactive` to 403 `membership_suspended` on every route.
5. **Nits: fixed.**
   - The status route trims `session_key` once and uses the trimmed value everywhere.
   - `continuation`: verified that `setupContinuation` never returns one for `setup:concierge`. The empty-`agent_key` case was still reachable (creator agent gone and a session key with no agent segment), so the handler now omits `continuation` (`null`) when no agent key resolves. Test: `TestExtensionAPIRespondOmitsUnaddressableContinuation`.
   - `run_id`: kept `omitempty`, added a comment, and section 38 now says the field may be absent or null.

## Coordinator extra: run detached from request cancellation

`extension_api_chat.go`: `runCtx` is built from `context.WithoutCancel(ctx)`, which keeps the tenant, user and key values and the tenant-scope-only flag. `setupActionChatTurn` also gets a `WithoutCancel` ctx, so claiming and releasing the continuation lease does not depend on the connection. The SSE writer only writes, so writes after a disconnect fail and nothing else happens. The run timeout belongs to the runtime and is unchanged.
Test: `TestExtensionAPIStreamRunSurvivesClientDisconnect` cancels the request ctx during the run and asserts the run ctx is not cancelled and keeps its scope. It fails when the fix is reverted (verified).
Not fixed here, as instructed (tracked in nextlevelbuilder/dewee#991, branch `fix/991-workspace-chat-runtime`): empty deltas from the `map[string]string` payload, runs not registered with the router (status and abort), and the request ctx in `provisioning_chat_stream.go` / `provisioning_chat.go`. The extension handler stays compatible: it always passes `RunContext`, so the `r.Context()` fallback in `streamWorkspaceChat` is never used.

## Docs

- `docs/18-http-api.md` section 38: tenant-role rule, rate limit, suspended on every route, detached run, `run_id`, `continuation` null rule, actions paging, `rate_limited`/`retry_after_seconds` envelope, CORS `Retry-After`.
- `CHANGELOG.md`: the #956 Added entry now covers the viewer rule, the rate limit and the detached run.

## Commands (PowerShell, Windows)

- `go build ./...` → OK
- `go vet ./internal/http/ ./internal/gateway/` → OK (also `go vet -tags sqlite ./internal/http/` → OK)
- `go test -tags sqlite ./internal/http/ -run 'TestExtension'` → ok (13 sqlite + 5 unit tests)
- `go test ./internal/http/ -run 'TestExtension'` → ok
- `go test ./internal/gateway/ -run 'Extension|RateLimit'` → ok (also `TestHandlerWrappers` passes)
- Broader `-tags sqlite -run 'WorkspaceSetup|Provision|SetupAction'`: 5 failures, all Windows-only and in code this change did not touch (#936):
  - Backslash temp paths in JSON give "invalid character 'U' in string escape".
  - "executable file not found" in exec tests.
- `gofmt` is clean on the touched files.

Status: DONE_WITH_CONCERNS
Summary: All 956 review findings and the coordinator's detach request are fixed, tested and committed locally as a078e857. A further bug was found and fixed: suspended workspaces returned `forbidden` instead of `membership_suspended`.
Concerns/Blockers: The rate limit deliberately covers only chat/stream and respond, not reads or abort, because the shared 20 rpm / burst 5 bucket would throttle the panel. Widen it only with a separate, larger bucket. The shared-runner bugs stay with #991.
