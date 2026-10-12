# Re-review: Dewee 956 fix a078e857 + 957 fix fcab6128

Reviewer: isolated code-reviewer, read-only. Date: 2026-10-11. Baseline: `code-reviewer-261011-1930-dewee-956-957-review.md`.

## Limits
- Bash fails in this session (`unexpected EOF` from the profile), so `git show`, `go test` and `vitest` were NOT run.
  I read the worktree files directly and assume HEAD equals a078e857 / fcab6128 with a clean tree.
- The implementers' test runs (go 13+5 extension tests, vitest 91 tests) were not reproduced.

## Original findings

| ID | Status | Evidence |
|---|---|---|
| B1 CCP history leak | **Closed** | `extension-api-views.ts:105-117` drops system/unknown roles, empty turns, `injected` user turns and `[[dewee:` turns, and runs tool `content` through `redactSensitiveString`. Only `id/role/content/created_at` are emitted, so `tool_calls`, `thinking` and `media_refs` never leave the server. `injected` is really serialized upstream (`providers/types.go:179`, `provisioning_chat_history.go:41`). Same rule as Gateway `extension_api_read.go:339-355`. Tests are at `extension-api-routes.test.ts:390,422`. |
| B2 viewer runs as operator/admin | **Closed** | `extension_api.go:271-280` refuses an unknown tenant role on every route and a viewer on stream/abort/respond. `runRole` (`:162-171`) is min(tenant, key) via `HasMinRole`. Tests are at `extension_api_sqlite_test.go:549,570`. |
| S1 recovery keeps extension sign-ins | **Closed** | `local-password-accounts.ts:138`: the revoke runs in the same `db.batch` as `DELETE FROM sessions`. |
| S2 respond cap 64 KiB | **Closed** | `respond.ts:23,31`: the 160 KiB cap applies to that route only. The default stays 64 KiB (`extension-api-route.ts:145`). The upstream provisioning body limit is 1 MiB (`provisioning.go:216`), so nothing is refused downstream. |
| S3 history shape parity | **Closed** | Ids are `m${cursor+index}` on both sides. Limit: <1 gets 400, >200 is clamped to 200 on both (`history.ts:74-80`, `extension_api_read.go:301-307`). |
| S4 no rate limit (956) | **Closed (scoped)** | `extension_api.go:97-109` wraps only stream and respond, after `auth`. The key is `extension_key:<key UUID>`, never the token (`:99`, test `:648`). Retry-After is exposed (`server.go:1392`). The limit is off when `gateway.rate_limit_rpm=0` (`gateway_http_wiring.go:449`). |
| S5 CCP sessions scan | **Partially closed** | `sessions.ts:44-54`: `total` is now honest for the window. Chats older than the tenant's newest 500 are still invisible, and a runtime filter is still needed (follow-up issue). |
| S6 missing tests | **Closed** | Session token, former member, suspended, viewer and CORS through `Server.Handler()` (`extension_cors_test.go:59`). |
| S7 pending cards beyond 200 | **Mostly closed** | `extension_api_actions.go:59-82` follows the cursor up to 10 pages (2000 cards). This is bounded, not complete. Acceptable. |
| Nit status trim | Closed | `extension_api_read.go:371-378`. |
| Nit empty continuation agent_key | Closed | `extension_api_actions.go:142-146` returns `continuation: null`. Test at `:714`. |
| Nit code replay before family row | **Closed** | `consumeExtensionCode` reserves `family_id` in the CAS UPDATE (`extension-oauth-store.ts:97`). The replay upserts a revoked family (`:145-154`). The winner's INSERT then hits the PK, `isExtensionFamilyRevoked` returns true, and the result is `invalid_grant` (`extension-oauth-service.ts:176-179`). The prune (`expires_at < now-1d`) cannot delete that row. |
| Nit refresh rotation two batches | **Closed** | `rotateExtensionRefreshToken` (`extension-oauth-store.ts:163-180`) runs as one batch. D1 `batch` is a transaction. The `SqlStatementDatabase.batch` adapter refuses a multi-statement batch without `transaction()` (`statement-database.ts:44-58`), and `rowsAffected` maps `changes`. On PG, the row lock on the conditional UPDATE serializes racers, so the loser sees 0 changes. The loser's tokens are written but never returned, and its family is revoked. |
| Nit relay without terminal frame | **Closed** | `extension-chat-relay.ts:137-140`. |
| Nit run_id null vs omitted | Closed (documented) | Both forms are documented. |
| Nit workspaces N+1 | Open (accepted) | Parallel reads. Low impact. |
| Nit CORS `*` entry | Open | Not addressed. Predates 956. |

## New findings

### Blocking

**N1. 956: a detached extension run cannot be stopped and has no deadline**
`internal/http/extension_api_chat.go:120,160`
- `runCtx` is now `context.WithoutCancel(ctx)`, but the extension runner never registers the run with the router.
  `agentRouterWorkspaceChatRunner.RunWorkspaceChat` (`provisioning_chat_runner.go:25-67`) calls `loop.Run` directly.
  `RegisterRun` is only called by `methods/chat.go:454`, `chat_completions.go`, `responses.go`, `wake.go` and `webhooks_llm.go`.
- As a result, `AbortRunsForSession`/`AbortRun` find nothing, so `chat/abort` answers `aborted:false`.
  `IsSessionBusy` is always false, so the `run_in_progress` guard (`:102`) never fires.
- The WS chat path pairs `WithoutCancel` with `WithCancel` + `RegisterRun` (`methods/chat.go:444-454`). The extension now has
  neither a cancel func nor a router entry.
- I found no run-level deadline in `internal/agent` (no `WithTimeout`/`WithDeadline` around `loop.Run`). The report's claim
  "the runtime's own run timeout still applies" (`fullstack-...-956-review-fixes.md:23`) is not supported by the code.
- Failure scenario:
  - The person presses Stop, or closes the panel on a runaway tool loop. Before a078e857 the disconnect cancelled the run.
    Now it keeps running and spending provider tokens until the loop ends by itself.
  - The person reopens the panel and resends. A second concurrent run starts in the same session, because the busy check is blind.
  - A leaked write key can start 20 unstoppable runs per minute (and unlimited runs when rpm=0).
- No goroutine is leaked: the handler stays blocked in `streamWorkspaceChat` until `loop.Run` returns. But the request
  goroutine and its SSE writer now live as long as the run.
- The test `TestExtensionAPIStreamRunSurvivesClientDisconnect` uses a fake runtime (`e.runtime.running`), so it hides this.
- Fix (any one):
  - (a) Revert the detach until #991 lands router registration.
  - (b) Do it here: `runCtx, cancel := context.WithCancel(WithoutCancel(ctx))`, call `RegisterRun(runCtx, runID, sessionKey, agentID, cancel)`
    with `defer UnregisterRun`, and add a hard `context.WithTimeout` cap.
  - Add a test against a real `*agent.Router` that abort cancels the run ctx and that `IsSessionBusy` is true during the run.

### Should-fix

**N2. 956: the rate limit is silently off when `gateway.rate_limit_rpm=0`** (`cmd/gateway_http_wiring.go:449`)
- Operators who disable the WS limiter also lose the only throttle on extension stream and respond.
- Combined with N1, a leaked key has no bound at all.
- Fix: give the extension its own limiter with a non-zero floor, or document the coupling in `docs/18-http-api.md` section 38.

**N3. 957: the relay can send two terminal frames** (`extension-chat-relay.ts:141-142`)
- The `catch` calls `writeError` without checking `terminated`.
- Scenario: `message.completed` is written, then `bestEffortMarkWorkspaceChatReady` or `touchExtensionChatRun` throws
  synchronously (or any later await rejects outside a `.catch`). The client then gets `chat.error` after `message.completed`.
- Fix: `if (!terminated) writeError(error)`.

**N4. 957: the sessions route fans out to up to 10 parallel runtime calls per request**
`sessions.ts:48` makes up to 10 parallel calls, and each call lists the tenant's app chats. With the 120/min read limit per
person, one member can drive about 1200 runtime list calls a minute.
- A chat updated between page reads can also be missed (it leaves its old page before that page is read). Dedupe does not help.
- Fix: lower the per-route limit, or cache page 0 for a few seconds. The real fix is still the runtime own-only filter.

### Nit
- `extension_api.go:201-204`: the `membership_suspended` branch in `auth` is now dead (`resolveCaller` returns first). Remove it,
  or keep it with a comment.
- `extension_api.go:256`: `ErrTenantEntitlementInactive` probably covers every non-active entitlement, not only `suspended`. A
  pending or cancelled workspace would then also say "suspended". Confirm against `store` and map only `suspended`.
- `created_at` parity: the Gateway formats RFC3339 seconds and omits a nil timestamp. CCP passes the runtime string, or `""`
  (`extension-api-views.ts:128`). The client should accept both, or one side should change.
- Refresh loser path: the losing rotation writes a pair under the family before revoking it. If `revokeExtensionFamily` then
  fails, a live, never-disclosed pair remains (hash only). Harmless, but `rotated_at` could be gated inside the inserts with
  `WHERE changes()`-style SQL.

## Specific checks requested
- **WithoutCancel**: no goroutine leak (the call is synchronous), but the run outlives the client with no deadline and no abort. See N1.
- **Rate limit order and key**: after auth; the key is `extension_key:<api key UUID>`, not the token. It is a single shared bucket
  for stream+respond per key, with abort and reads excluded on purpose.
- **Redaction coverage**: only `content` is emitted for tool messages, and it is redacted. Assistant `content` is not redacted on
  either server (same as the web chat), so a model that quotes a secret from a tool result still shows it. This matches the
  contract text ("tool output is redacted") and is noted as residual risk, not a defect.
- **Batch atomicity**: real on D1 (implicit transaction), on the APP_SQL adapter (requires `transaction()`), and in the test helper (`BEGIN`).
- **160 KiB scope**: the respond route only. Every other extension route keeps 64 KiB.
- **Forbidden shortcuts**: none found.
  - The Origin/CSRF consent guard is intact (`extension-oauth-authorize.ts:116`, `http-guards.ts:3-8`).
  - The gateway token is still refused (`extension_api.go:225`).
  - No `setup_operator` widening, and no secret in chat (the respond view is built field by field, and `zeroSecrets` is deferred).

## Recommended actions
1. N1 before merge of 956: revert the detach, or add a cancel func, router registration and a hard timeout, with a test.
2. N3 (one line), N2 (doc or own limiter).
3. N4 and the S5 runtime filter as a linked follow-up issue in nextlevelbuilder/dewee.

## Unresolved questions
- Is #991 (router registration) going to merge before #956? If so, N1 drops to Should-fix, provided #991 also adds a run deadline.
- Should the extension limiter be independent of `gateway.rate_limit_rpm`?

Status: DONE_WITH_CONCERNS
Summary: Every original blocking and should-fix finding is closed or bounded, except S5, which is partial. The detach in 956 adds a blocking regression: extension runs cannot be aborted, have no deadline, and the busy guard is blind.
Concerns/Blockers: N1 blocks 956. Shell unavailable, so tests and diffs were not run, and the findings come from reading the source.
