# Review: Dewee 956 (Gateway /v1/extension) + 957 (CCP extension OAuth + BFF)

Reviewer: isolated code-reviewer, read-only. Date: 2026-10-11.

## Limits of this review
- Bash fails in this session (`unexpected EOF` from the profile) and no PowerShell tool was available, so
  `git show`, `go test`, `go vet` and `vitest` were NOT run. The commit message, exact diff hunks and
  the plan/PR parity matrix could not be checked. The review reads the worktree files directly
  (assumes HEAD == 5e3e03ae / 14183ba5 with a clean tree).
- Files read: 956 `internal/http/extension_api{,_read,_chat,_actions}.go`, `extension_api_sqlite_test.go`,
  `provisioning_chat_stream.go`, `provisioning_chat_setup_turn.go`, `workspace_setup_actor_gate.go`,
  `workspace_setup_respond_core.go`, `workspace_setup_actions_routes.go`, `auth.go`, `api_keys.go`,
  `gateway/server.go` (CORS), `cmd/gateway_http_wiring.go`. 957 `lib/extension-oauth/*`,
  `lib/extension-api/*`, all `pages/api/extension/v1/**`, `pages/oauth/extension/authorize.astro`,
  both migrations, `http-guards.ts`, `local-password-accounts.ts`, `workspace-session-read-scope.ts`.

## Blocking

**B1. CCP history returns tool output without redaction, and returns runtime-injected user turns**
`apps/dewee-app/src/lib/extension-api/extension-api-views.ts:102-113`
- The view keeps `role: "tool"` messages with raw `content`. It drops only user turns that start with `[[dewee:`.
  The upstream provisioning history (`internal/http/provisioning_chat_history.go:126-141` ->
  `sessions.go:228`) returns raw `providers.Message` and does not redact.
- Failure: a tool result that echoes an env var, a config file or a provider error with a key goes in
  plaintext to the extension. The web chat skips tool messages (`workspace-chat-history.ts:27`), so this
  route shows more than the web does. An injected runtime turn (not marker-prefixed) also appears as the
  person's own text.
- The contract says "tool output is redacted" and "runtime-injected turns are never returned". The
  Gateway path does both (`extension_api_read.go:339-355`, using `redactTracePreview` and `Injected`).
- Fix: redact tool content server-side with the same patterns, or drop tool messages. Expose the
  `injected` flag through the provisioning history (or a filtered variant) and drop those turns. Add a
  test with a secret-shaped tool result.

**B2. A tenant `viewer` with a write-scoped key runs chat as `operator` (or `admin`)**
`internal/http/extension_api.go:113-119` (`runRole`), used at `extension_api_chat.go:115-117`
- `permissionRoleFromTenantRole("viewer")` returns `""` (`provisioning_chat_runner.go:94-105`).
  `runRole` then returns `c.KeyRole`. For a key with `operator.write` that is `operator`; with
  `operator.admin` it is `admin`.
- The `auth(write=true)` check looks only at key scopes, never at the tenant role. A viewer whose
  system owner minted an owner-bound read+write key (`api_keys.go:114-149` allows this) can start runs,
  and the tools in those runs act above the viewer's tenant role. The comment above `runRole` says the
  run role is "never more than the key grants", but here the tenant role is what gets exceeded.
- Fix: map `viewer` to `RoleViewer`. Use the minimum of the tenant role and the key role. Refuse
  `chat/stream` and `chat/abort` with 403 `forbidden` when the tenant role is below operator/member.
  Add a test for a viewer key on `/chat/stream`.

## Should-fix

**S1. Account recovery does not revoke extension sign-ins** (957)
`src/lib/local-password-accounts.ts:136` deletes every web session on password recovery but leaves
`extension_oauth_token_families` alone. Result: someone who took over the account and approved the
extension keeps API access (refresh tokens rotate) for up to 90 days after the owner recovers it.
Fix: add `UPDATE extension_oauth_token_families SET revoked_at=?, revoked_reason='account_recovery' WHERE user_id=? AND revoked_at IS NULL`
to the same batch. Apply the same change to any other "sign out everywhere" path.

**S2. The CCP respond body cap is below the contract maximum** (957)
`pages/api/extension/v1/workspaces/[workspaceId]/actions/[actionId]/respond.ts:28` uses the default 64 KiB cap
(`extension-api-route.ts:145`). The contract allows `response` up to 8 KiB plus 8 secrets of up to 16 KiB each
(about 136 KiB, which the Gateway's own route accepts: `extension_api_actions.go:21`). A valid multi-field
secret card is refused as "too large". Fix: pass `8*1024 + 8*16*1024 + framing`.

**S3. The two servers return different history shapes** (956 vs 957)
Gateway ids are `m<position>` (`extension_api_read.go:322`, matching the contract). CCP ids are bare numbers
(`extension-api-views.ts:108`). A limit above 200 is clamped by the Gateway (`extension_api_read.go:307`)
but rejected with 400 by CCP (`history.ts:75`). Pick one behavior: `m` + position, and either clamp or reject in both.

**S4. No rate limit on `/v1/extension/*`** (956)
Nothing on the extension routes returns 429. `chat/stream` and `respond` can be called with no limit by a
leaked key. CCP limits every route (for example `stream.ts:40`). Fix: apply the server `RateLimiter`
keyed by API key id on the write routes and add `Retry-After`. Also add `Retry-After` to the CORS
expose list (`server.go:1392`).

**S5. CCP session list scans the whole tenant and caps it** (957)
`pages/api/extension/v1/workspaces/[workspaceId]/sessions.ts:34-46`: up to 10 sequential runtime calls
per request (each list call fetches every app chat in the tenant). A member's chats older than the
newest 500 app chats in the tenant are never listed, and `total` is wrong. Fix: filter by user on the
gateway list (own_only-style) and page there.

**S6. Risky paths without tests** (956)
`extension_api_sqlite_test.go` does not cover: a customer session token (`kind='session'`) being refused;
a key owner who is no longer a tenant member; a suspended tenant (`membership_suspended`); a viewer
streaming chat (B2). The fixture calls `RegisterRoutes` directly on a mux
(`extension_api_sqlite_test.go:109-110`), so CORS and preflight for a `chrome-extension://` origin
through `server.go` are not tested either.

**S7. Pending cards beyond the newest 200 are dropped** (956)
`extension_api_actions.go:44-54` fetches one page (`SetupActionListMax` = 200), filters by status
afterwards, and never follows the cursor. Older pending cards in a busy session are silently left out.
Push the status filter into the store query, or keep paging.

## Nits
- `extension_api_read.go:369-374`: `ownedSession` trims `session_key`, but `IsSessionBusy` and `SessionRunID`
  get the untrimmed path value. Trim once and use that value everywhere.
- `extension_api_actions.go:134`: for a concierge card (`setup:concierge`) whose creator agent is not found,
  `continuation.agent_key` is `""`. The extension's `continuation` schema needs `min(1)`, so the whole
  respond result fails to parse after the card has already been answered.
- `extension-oauth-service.ts:141-147`: a code replay that lands between `consumeExtensionCode` and
  `insertExtensionFamily` sees `family_id` NULL and revokes nothing.
- `extension-oauth-service.ts:201-207`: marking the old refresh token rotated and inserting the new pair
  are separate batches. If the insert fails, the old token is spent and the person must sign in again.
  Batch them together.
- `pages/api/extension/v1/workspaces.ts:14-27`: N+1, two reads per membership.
- `extension-chat-relay.ts:98-128`: if the runtime stream ends without a terminal frame, the relay closes
  without sending `chat.stopped` or `chat.error`. The contract says every stream ends with one of them.
- Status `run_id`: CCP sends `null`, the Gateway omits the field. The client accepts both; the contract
  should say which one is correct.
- `server.go:1381`: the gateway CORS allowlist accepts a `*` entry (this predates the commit, and the
  extension routes inherit it). The contract says exact origins only.

## Checked and found correct
- Gateway auth: the gateway token is refused, compared in constant time (`auth.go:38-43`). Agent-chat,
  MCP-only, customer-scope, session and ownerless keys are refused. Tenant and owner come from the key;
  `enrichContext` forces the user to the owner (`auth.go:555-564`). `{workspace_id}` must equal the key's
  tenant, otherwise 404. Membership is re-checked on every request. Tenant-scope-only is forced.
- Gateway sessions: `isProvisionedWorkspaceChatSession` checks user, `app` channel, agent UUID and key.
  A tenant check on the agent blocks cross-tenant access. Foreign-session 404s are tested.
- Respond and continuation: owner/admin plus the human gate with the key's lineage (`APIKeyID` in ctx).
  Tenant-scoped load, a claim CAS, single-use continuation lease. Secret size and count are validated in
  `uiaction/responses.go:51-65`. The response does not include the secret. `zeroSecrets` is deferred.
- Shared refactor: `handleProvisionWorkspaceChatStream` builds the same context and stream as before.
  `setupActionChatTurn` keeps the provisioning path's `Human: true` and `CanWrite` checks. No regression
  found for existing callers.
- CCP OAuth: PKCE S256 only, with strict verifier and challenge formats. The challenge comparison is
  timing-safe. Codes are single-use through a conditional UPDATE, and a replay revokes the family.
  Refresh rotation and replay revoke the family. The redirect URI must match an exact,
  pattern-filtered allowlist. Only hashes are stored. A revoked family is re-checked while a stream runs.
- Consent: POST is guarded by an exact `Origin` match (`http-guards.ts:3-8`) and a per-user rate limit.
  The page sends `frame-ancestors 'none'`, XFO DENY and no-store. `state` is bounded.
- CCP CORS and bearer: exact `chrome-extension://` origins only, a foreign `Origin` is refused, no
  Allow-Credentials. The routes never read the cookie. Error messages for 5xx and unknown errors are generic.
- Migrations: D1 0034 and self-hosted 0033 have the same tables. The self-hosted one writes its schema-version row.
  ISO-8601 TEXT timestamps compare correctly on both. The conditional UPDATEs rely on `rowsAffected`,
  which the PG adapter maps (`statement-database.ts:102-103`).

## Recommended order
1. B1, B2 (with tests). 2. S1, S2, S3. 3. S4, S5, S6, S7. 4. Nits.

## Unresolved questions
- Should a tenant `viewer` be able to chat from the extension at all, or only read? (This decides the B2 fix.)
- With an empty `session_key`, `GET /actions` returns concierge cards to any member with read or chat access, on both
  servers. Is that the intended reload scope for the panel?
- Does the 956 PR include the required trace/surface/CLI parity statements? Not checked, because git was unavailable.

Status: DONE_WITH_CONCERNS
Summary: 2 blocking (CCP history leaks unredacted tool output and injected turns; Gateway viewer role runs chat as operator/admin) and 7 should-fix issues. The auth, PKCE, rotation, CORS, CSRF and migration code is otherwise sound.
Concerns/Blockers: Shell unavailable, so tests, vet and git show were not run. Findings come from reading the source.
