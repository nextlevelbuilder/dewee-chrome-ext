# Dewee PR #1022: tenant-scoped extension runs and rate limit fixes

Branch `feat/956-gateway-extension-api` (base `fix/991-workspace-chat-runtime`), worktree
D:/www/nextlevelbuilder/worktrees/dewee-956-gateway-extension-api. Pushed 3da5cfae..7b6229d4.

## Commits
- 07fe0ce0 fix(http): scope extension run status, abort and busy checks to the key's tenant
- f6e6f1bb fix(http): give extension respond its own rate limit bucket and log the limit (Closes #1036)
- 7b6229d4 fix(gateway): report the extension rate limit from the live limiter (review follow-ups)

## Problem 1: tenant scoping
- `internal/agent/router_tenant_session_runs.go`: `Router.TenantSessionRunIDs(tenantID, sessionKey)`
  lists a session's live runs in one tenant, newest first. It needs an exact tenant match and does
  not use the single-entry session index.
- `internal/http/extension_api_runtime.go`: ctx-taking `extensionChatRuntime` plus the
  `ExtensionRouterRuntime` adapter. Status, abort (by run_id or by session) and the send busy guard
  only see runs in the caller's tenant; a foreign run reads as no run.
- The signatures match #1028's ctx-taking router API. Neither #1000 nor #1028 commits are pulled
  in. Once #1028 merges, the adapter's two `router.AbortRun` calls need ctx (or the adapter can be
  dropped).

## Problem 2: rate limits (#1036)
- Respond uses its own per-key bucket (`extension_respond_key:`) at the same rpm/burst; stream
  keeps `extension_key:`. Abort stays unlimited.
- `cmd/gateway_extension_rate_limit_log.go`: logs `extension_api.rate_limit` once at mount (rpm,
  source config|system_configs, config_rpm, enabled from the live limiter). Logs
  `extension_api.rate_limit_config_changed` on a changed system_configs value; the running limiter
  keeps its rate until restart. Only logging was added to the shared subscriber.
- Docs: `docs/18-http-api.md` (rate limit, override logging, run isolation). OpenAPI description
  updated and re-synced; `sync-openapi.mjs --check` passes.

## Tests
- New: `TestExtensionAPIRunLookupsAreTenantScoped` (real router, colliding key, guessed run ID,
  index takeover), `TestTenantSessionRunIDsOnlyListsTheTenantsRuns`, the updated
  `TestExtensionAPIRateLimitsWritesPerKey`, and `TestExtensionRateLimitLog*`.
- Revert proof: with the unscoped runtime, the tenant test fails (status shows run-tenant-b). With
  respond back on the stream bucket, the rate test fails (429 instead of 404). Without the tenant
  filter, the router test fails.
- All `TestExtension*` tests pass (sqliteonly and sqlite). `go build` passes in default, sqlite and
  sqliteonly. `go vet` passes on cmd, internal/http and internal/agent (default and sqliteonly).
  The integration OpenAPI tests pass. internal/agent and the cmd wiring tests pass.
- Full internal/http sqliteonly run: these failures are Windows-only and pre-existing (missing
  .exe / symlink / CRLF), unrelated to this change: workspace setup e2e, secure CLI binary, files
  symlink.

## Review
A fresh-context code-reviewer found no blocking issues. Fixed: enabled/effective now come from the
limiter, logging tests added, docs wording on source, and an invariant comment on the two-step abort.
Not fixed, out of scope: WS `chat.send` / `Router.InjectMessage` cross-tenant lookups. #1000
(commit 9644cb00, "scope steer, inject and channel run lookups") already covers these, so no new
issue was opened. Note: the reviewer could not run git or tests (shell failure); I ran all gates.

## Delivery
- PR #1022 body: Summary and Test plan updated, `Closes #1036` added, trailer kept.
- Issue #1036: `done` label added, assigned @me (mrgoonie). `go clean -testcache` run.
