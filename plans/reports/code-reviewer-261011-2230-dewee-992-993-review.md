# Code review: dewee#992 (6690a9b0) and dewee#993 (789895f1)

Isolated read-only review. Diffs: `git diff fcab6128 6690a9b0` (worktree dewee-992-own-sessions) and
`git diff 57026762 789895f1` (worktree dewee-993-respond-body-cap).

Verification run:
- `go test ./internal/http -run 'ProvisioningHandlerSessions|ProvisioningHandlerReportsRecentlyActive|ProvisioningWorkspaceSessions'`: ok
- `go test -tags sqlite ./internal/http -run ProvisioningWorkspaceSessionsOwnOnly -v`: PASS
- vitest `runtime-sessions-client.test.ts` + `extension-api-routes.test.ts`: 40/40 pass
- vitest `setup/setup-routes.test.ts` (993): 66/66 pass
- `go clean -testcache` run afterwards.

## Commit 6690a9b0: own_only / agent_key session filter (dewee#992)

### Blocking
None.

### Should-fix
1. **Valid agent keys are rejected by the slug check.** `internal/http/provisioning_sessions.go:116` returns 400 for an
   `agent_key` that does not match `isValidSlug` (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`), and the BFF route returns an empty
   list for the same pattern (`apps/dewee-app/src/pages/api/extension/v1/workspaces/[workspaceId]/sessions.ts:20,31`).
   Agents created via the provisioning path use `config.NormalizeAgentID` (`internal/http/provisioning_agents_crud.go:368`),
   whose pattern is `^[a-z0-9][a-z0-9_-]{0,63}$` (`internal/config/normalize.go:11`). That pattern allows `_` and a
   trailing `-`. So a CCP agent named "sales_bot" gets key `sales_bot`. Its chats can no longer be filtered by agent: the
   extension gets `{sessions: [], total: 0}`. Before this change, the BFF compared keys exactly and only enforced
   length ≤ 128. This is a functional regression, not a security problem.
   Fix: accept the `NormalizeAgentID` shape and escape LIKE metacharacters in the store. Use `ESCAPE '\'` and escape
   `\`, `%` and `_` in `buildSessionFilter` for PG (`internal/store/pg/sessions_list.go`) and SQLite
   (`internal/store/sqlitestore/sessions_list.go`). Alternatively, validate against `validIDRe` and escape `_`. Mirror
   the same pattern in the BFF and update the docs.
2. **The docs claim does not match reality.** `docs/ccp-session-detail-inspection.md:17` says `agent_key` "must be a
   slug". `docs/extension-oauth-and-bff.md` says a non-slug key "lists nothing". Both describe the regression above as
   intended behaviour. Update them with the fix.

### Nit
3. **List rule differs from the detail rule.** The SQL own filter is `user_id = actor AND session_key LIKE 'agent:%:app:%'`
   (`provisioning_sessions.go:163-165` with the store `Channel` LIKE). `isOwnAppChatSession`
   (`provisioning_session_detail.go:171`) instead uses the `channel` column. Both require `user_id = actor`, so no
   cross-user or cross-tenant row can leak. A session can still be listed and then refused on detail, or the reverse,
   when the key and the column disagree (for example a caller-supplied `SessionKey` in `provisioning_chat_runner.go:33`).
4. **`total` can exceed what the BFF returns.** The BFF still post-filters with `mayBeOwnAppChatSessionKey`
   (`agent:[^:]+:app:direct:<userId>-…`), which is stricter than the SQL LIKE (that also matches `app:group:…` or
   custom keys). The route returns the gateway's `total` (`sessions.ts:43`). With such rows, a page can be short while
   `total` still counts them. This only happens with unusual keys. Note it in a comment or count only after the
   guard.
5. **Unconfirmed agent filter.** `agent_key` without `own_only` gets no confirmation echo (`own_only_enforced` only).
   No caller does this today. If a future caller relies on `agent_key` alone, an older gateway would silently ignore it.
6. **Unbounded offset.** BFF `offset` max is now 1,000,000 (`sessions.ts`), and the gateway has no upper bound. It is
   indexed (`idx_sessions_tenant_user`), so the cost is acceptable. A tighter bound would still be cheap insurance.

### Checks that passed
- **Authorization:** `own_only` binds `filter.UserID = actorUserID`. The actor comes from the HMAC-signed provisioning
  body after the membership check, and the tenant comes from `binding.TenantID`. The BFF always sends `ownOnly: true`
  with `actorUserId: userId` from the bearer token. Client query input cannot widen the scope. The sqlite test covers
  a same user_id in another tenant, other users, and other channels.
- **SQL:** every value is parameterised (`$n` / `?`). `agent_key` reaches only a bound LIKE argument, and the slug check
  blocks `%`/`_`. Postgres and SQLite paths are symmetric.
- **Pagination:** `total` and `active_count` come from the same filter (`page := filter`, `active := filter`).
- **Backward compatibility:** with neither field set, the filter equals the old one (Channel and TenantID).
  `own_only_enforced` is `omitempty` and absent, as the test asserts. Other `listSessions` callers do not send the new
  fields (test "sends neither filter").
- **Fail-closed:** `runtime-sessions-client.ts:170` throws 503 `runtime_session_scope_unavailable` unless
  `own_only_enforced === true`, checked after the HTTP status. This is correct.
- **Tests would fail without the fix:** the Go tests reference `OwnOnly`/`OwnOnlyEnforced`, so they do not compile at the
  base. The sqlite test totals would include other users. The BFF tests assert a single call with `ownOnly: true` and
  the old-chat case.

## Commit 789895f1: respond body cap at 160 KiB (dewee#993)

### Blocking
None.

### Should-fix
None.

### Nit
7. **Escaped JSON can exceed the cap.** The cap is in serialized bytes, while the contract limits are in decoded bytes
   (`workspace-setup-respond.ts:32-34`). A secret heavy in `"`, `\` or control characters expands under JSON escaping
   by up to 2x (or 6x for `\uXXXX`). A contract-valid body can therefore exceed 160 KiB and get 413. Realistic secrets
   (PEM, tokens) add only a few hundred bytes. Accept this, or say it in the comment.
8. **Comment refers to a route not on dev.** The comment at `action-respond.ts:15` says "the same cap as the extension
   respond route". That route (`extension/.../actions/[actionId]/respond.ts:23`, 160 KiB) exists on feat/957 but not on
   origin/dev. The reference is accurate only once feat/957 lands.

### Checks that passed
- **Other routes:** the 64 KiB default is untouched and only `action-respond` passes a cap. The test "keeps the 64 KiB cap
  on the other setup routes" covers `plan-approve`.
- **No echo:** the 413 body is `{error: "setup_request_invalid"}`, and the test asserts it contains no secret or filler.
  `handleSetupRoute` logs only the error name.
- **CSRF and Origin:** `assertSameOriginMutation` runs first in `resolveSetupRoute`
  (`workspace-setup-route-support.ts:62`), then the session and membership checks, and the body is read after them.
  This is unchanged.
- **Downstream:** the gateway provisioning respond path reads with `maxProvisioningBodyBytes` (1 MiB,
  `internal/http/provisioning.go:216`), so 160 KiB passes through.
- **Tests would fail without the fix:** the contract-maximum test asserts the body is over 64 KiB and expects 200, which
  gives 413 at the base.

Status: DONE_WITH_CONCERNS
Summary: No blocking or authorization issues. The own_only filter is bound to the signed actor and tenant, parameterised on both stores, and the BFF fails closed with 503. The 993 body cap is scoped to one route with the guards intact.
Concerns/Blockers: In 992, the slug-only agent_key check rejects valid provisioning-created agent keys that contain `_` or a trailing `-` (NormalizeAgentID). This is a filter regression, and the docs describe it as intended.
