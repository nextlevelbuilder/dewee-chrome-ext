# Dewee: continuation_in_progress vs continuation_sent

## Outcome
- Issue: nextlevelbuilder/dewee#1047 (labels bug, ai-handle, done; assigned to mrgoonie). It references PR #1022.
- Commit d3db3f74 on feat/956-gateway-extension-api (PR #1022), pushed. PR body updated with a new
  bullet, a test line and `Closes #1047`. The trailing Claude Code line is kept.
- The lease code is already on origin/dev (from #881, commit 8569ca1b). As instructed, the fix landed on feat/956.

## Change
- `store.WorkspaceSetupStore.ContinuationDelivered(ctx, id) (bool, error)`: a tenant-scoped read,
  true only when the mark equals `SetupContinuationDeliveredAt`. A card outside the tenant gives
  ErrSetupActionNotFound. It is implemented for PG (`internal/store/pg/workspace_setup_actions.go`) and
  SQLite (`internal/store/sqlitestore/workspace_setup_actions.go`).
- `claimSetupContinuation`: when the mark can be neither marked nor reclaimed, it reads the mark.
  - Delivered: `409 continuation_sent`, as before.
  - Otherwise: `409` with reason `continuation_in_progress` and `retryAfter` = 5s (the existing
    MsgSetupActionInProgress message).
  - The reclaim path that finds the result in the session stays `continuation_sent`.
- `setupError` gains a `retryAfter` field. Like `reason`, `write` never serializes it, so the browser
  and HMAC routes are unchanged: still 409 `failed_precondition`, and only the message text differs.
- `writeExtensionSetupError` sets `Retry-After` and `error.retry_after_seconds` (the existing
  `extensionErrorBody` field) when a hint is present. The extension code is the reason, `continuation_in_progress`.
- Docs: `docs/18-http-api.md`, in the extension stream bullet.
- Web client check: dewee-app sends continuations through the HMAC/BFF route, which returns no
  reason. Its status and code are unchanged, so it does not regress. `ui/` has no `continuation_sent`.

## Tests
- New: `TestClaimSetupContinuationTellsInProgressFromDelivered` (sqlite). It checks four cases:
  - a live lease gives in_progress with a hint;
  - a retry after release claims the continuation;
  - a delivered continuation gives sent with no hint;
  - a stale mark is reclaimed.
- New: `TestExtensionAPIContinuationInProgressIsRetryable` (sqlite, `/v1/extension` route). It checks
  the code, the Retry-After header and the body hint, that the retry sends after release, and that
  sent then has no hint.
- Store conformance (`storetest/workspace_setup_continuation_lease_conformance.go`): ContinuationDelivered
  before and after finalize, across tenants, and on an unsent card.
- `TestExtensionCodeForSetupConflicts` includes the new reason. The existing test at
  `extension_api_sqlite_test.go:525` still passes, because the fake runner confirms delivery, so no edit was needed.
- Mutation check: all 5 mutants were killed:
  - `!delivered` forced false;
  - retryAfter not set;
  - extension body drops the hint;
  - sqlite read forced false;
  - sqlite read forced true.

## Gates
- `go build ./...` passes in the default, `-tags sqlite` and `-tags sqliteonly` builds.
- `go vet` is clean on http, store, pg, storetest, sqlitestore (sqlite tag) and tests/integration (integration tag).
- `go test -tags sqlite ./internal/http -run 'Extension|Setup|Continuation'` passes except for two failures
  that already exist on Windows: TestWorkspaceSetupOnboardingFlowEndToEnd and TestWorkspaceSetupSecretLeakSweep
  (workspace-setup exec, "executable file not found"). The default-build run passes.
- sqlitestore WorkspaceSetup tests pass.
- PG: TestWorkspaceSetupContinuationLeasePG and TestWorkspaceSetupStorePGConformance pass. They ran on pgtest:5433
  in the throwaway DB dewee_956_cont_pg_verify, which was dropped afterwards. The DSN came from gw/secrets.env and
  was not printed.
- `go clean -testcache` was run.

Status: DONE_WITH_CONCERNS
Summary: Issue #1047 is filed. The fix is pushed to PR #1022 as commit d3db3f74: a live lease now returns
409 continuation_in_progress with a 5s retry hint, and delivered stays continuation_sent. It is tested on
SQLite and PG, and the mutation check passed.
Concerns/Blockers:
- The AGENTS.md isolated-review step (`in review`) was not run. The issue went straight to `done`, as the task asked.
- The 5s retry hint is a judgment call.
- The dewee-app web client still cannot tell the two cases apart, because the BFF route has no reason field.
- The Chrome extension must still map `continuation_in_progress` to keep-and-retry.
