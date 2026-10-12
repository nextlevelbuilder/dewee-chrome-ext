# dewee#956: Gateway `/v1/extension/*` routes for personal API keys

Status: DONE_WITH_CONCERNS. The commit is `5e3e03ae` on branch `feat/956-gateway-extension-api`, in worktree
`D:/www/nextlevelbuilder/worktrees/dewee-956-gateway-extension-api`. It is not pushed and no PR was opened.

## Files changed (21 files, +1936 / -47)

New files:
- `internal/http/extension_api.go`: the handler, routes, the credential rules, the caller, and the error envelope.
- `internal/http/extension_api_read.go`: me, workspaces, agents, sessions, history and status, plus the agent and session ownership helpers.
- `internal/http/extension_api_chat.go`: stream (including the setup_action_id continuation) and abort.
- `internal/http/extension_api_actions.go`: the actions list and respond.
- Tests: `extension_api_sqlite_test.go` (real SQLite stores and real auth), `extension_api_test.go` (untagged unit tests) and `internal/gateway/extension_cors_test.go`.

Shared refactors (no logic copied, existing responses unchanged):
- `provisioning_chat_stream.go`: the free function `streamWorkspaceChat`, with new params `RunContext`, `TraceName` and `Surface`.
- `provisioning_chat.go` and `provisioning_chat_runner.go`: a `TraceName` override. The default stays `app chat <agent>`.
- `provisioning_chat_setup_turn.go` and `provisioning_chat_setup_turn_lease.go`: `setupActionChatTurn`, `claimSetupContinuation` and `continuationInSession` are now free functions shared by both surfaces.
- `workspace_setup_handler.go`, `workspace_setup_respond_core.go` and `workspace_setup_actor_gate.go`:
  - `setupError.reason` is a conflict category. It is not serialized by the existing writers.
  - `applyHumanGate` was extracted.
  - New actor source `extension`.

Wiring:
- `internal/gateway/server.go`: `SetExtensionHandler`.
- `cmd/gateway_http_wiring.go`: mounted whenever the tenant, agent and session stores and the agent router exist. This is independent of the provisioning keys.

Docs:
- `docs/18-http-api.md`: new section 38.
- `docs/20-api-keys-auth.md`: new "Browser Extension Keys" section with the CLI example.
- `CHANGELOG.md`: an Unreleased/Added entry.
- `docs/project-changelog.md`: a 2026-10-11 entry with surface and trace parity.

## Routes (all under `/v1/extension`, all `Cache-Control: no-store`)

| Route | Scope | OK | Specific errors |
|---|---|---|---|
| GET `/me` | read | 200 | – |
| GET `/workspaces` | read | 200, exactly one entry (the key's tenant) | – |
| GET `/workspaces/{id}/agents` | read | 200 | – |
| GET `/workspaces/{id}/sessions` | read | 200 | 400 limit not in 1–50, or bad offset/agent_key |
| POST `/workspaces/{id}/chat/history` | read | 200 | 400 body/cursor/limit, 404 session |
| POST `/workspaces/{id}/chat/stream` | write | 200 SSE | see below |
| POST `/workspaces/{id}/chat/abort` | write | 200 `{aborted}` | 404 session or agent_key mismatch |
| GET `/workspaces/{id}/sessions/{session_key}/status` | read | 200 `{running,run_id?}` | 404 |
| GET `/workspaces/{id}/actions?session_key=&status=` | read | 200 `{actions:[envelope]}` | 400 status, 404 foreign session |
| POST `/workspaces/{id}/actions/{action_id}/respond` | write | 200 | see below |

`chat/stream` errors:
- 400 `invalid_request`: a `[[dewee:` marker, message plus setup_action_id, an empty message, unknown keys, or an over-length field.
- 404: agent or session.
- 409 `run_in_progress`.
- 409 `continuation_sent`.
- 403 `forbidden` or `setup_human_actor_required`, for a continuation.

`respond` errors:
- 400: unknown keys, more than 8 secret keys, or a response over 8 KiB.
- 403 `forbidden`: the caller is not a tenant owner or admin.
- 403 `setup_human_actor_required`.
- 404.
- 409: `action_closed`, `action_in_progress`, `response_conflict` or `rotate_required`.

Auth outcomes, applied to every route:
- 401 `unauthenticated`: no key, or an unknown key.
- 403 `forbidden`: the gateway token, a session token, an agent.chat/agent-bound key, an MCP-only key, a customer-scoped key, an inactive tenant, or an owner who is not a member.
- 403 `owner_binding_required`: the key lacks an owner or a tenant.
- 403 `scope_required`: the key lacks the needed scope.
- 404 `not_found`: `{workspace_id}` is not the key's tenant (including a non-UUID).
- 403 `membership_suspended`: the workspace entitlement is suspended.
- 503 `runtime_unavailable`: a dependency is not wired.

## Design notes and contract deviations

- **Separate `ExtensionHandler`.** Self-hosted installs have no ProvisioningHandler, so the extension cannot hang off it. The binding is synthesized from the key's tenant (`Source: "extension"`). The HMAC routes are untouched.
- **Never master scope.** Requests always run with `store.WithTenantScopeOnly`, even on the master tenant. This is least privilege, and it also keeps the `ui_action` tool gate open. The run role is the owner's tenant role, capped by the key's scopes.
- **Agent visibility.** Tenant owners and admins see every active agent in the tenant. Other roles see `ListAccessible`/`CanAccess`. An inaccessible agent returns 404.
- **Foreign sessions.** A session the caller does not own returns 404, not the 403 the provisioning route returns. This avoids leaking that the session exists.
- **History.** Ids are `m<position>` because stored messages have no id. `created_at` is omitted when it is unknown. System messages, injected messages and setup-marker user turns are dropped, and tool output is redacted.
- **Actions list.**
  - An empty `session_key` lists the concierge session (the core default).
  - It returns one page of up to `SetupActionListMax` cards, with no cursor; the contract has none.
  - `status` is filtered on the envelope status.
- **Respond result.** `result` is the stored card result, or `null`. `continuation` is `null` when there is none. `agent_key` is looked up from the card's agent id, falling back to the agent segment of the session key.
- **Extra error code.** `continuation_sent` is a 409 code that is not in the contract's list. A generic 409 falls back to `conflict`, which the contract also does not list. The client treats any 409 as "reload state".
- **`/me` user fields.** `email` is the user id when it contains `@`, otherwise `null`; self-hosted has no email store. `display_name` is the tenant membership's display name, falling back to the user id.
- **Not added.**
  - Rate limiting: no `rate_limited` is emitted.
  - OpenAPI spec entries: the coverage test only checks spec→source.
- **CORS.** No code change: `corsMiddleware` already reflects exact allowlisted origins and allows Authorization and Content-Type. A gateway test now pins the preflight behavior for `/v1/extension/*`. No origin is hard-coded.

## Commands and results (Windows)

- `go build ./...`: pass.
- `go vet ./internal/http/... ./internal/gateway/`: pass. `go vet -tags sqlite ./internal/http/`: pass.
- `go test -tags sqlite ./internal/http/ -run TestExtensionAPI -v`: 6/6 pass. The tests are:
  - the auth matrix;
  - me/workspaces/agents;
  - stream frames including ui_action, the run context, and the 400/404/409 refusals;
  - sessions, history, status and abort;
  - actions, respond with the secret absent from the response and logs, replay, 409 and continuation once-only;
  - the human-gate and viewer refusals.
- `go test ./internal/http/ -run TestExtension` (untagged unit tests): pass. `go test ./internal/gateway/ -run TestExtensionAPIPreflight`: pass.
- Regression runs pass:
  - `go test -tags sqlite ./internal/http/ -run 'TestExtension|TestProvisionWorkspaceChatSetup|TestProvisioningHandlerStreams|TestWorkspaceChatStream|TestWorkspaceSetupRespond'`
  - `./internal/gateway/...`
- Pre-existing Windows-only failures, unrelated to this change:
  - Media tests: JSON with unescaped `C:\Users` paths.
  - `TestWorkspaceSetupOnboardingFlowEndToEnd` and `TestWorkspaceSetupSecretLeakSweep`: they exec a `dewee` binary without `.exe`.
  - Symlink and npm binary tests, skill export tests, and `cmd TestRGDGrantKeySourceErrors` (file-permission warning).
- `-race` was not run: it needs cgo on Windows.

## Concerns

1. Most extension tests are under the `sqlite` build tag, so CI must run with `-tags sqlite` to exercise them. That matches the existing workspace-setup tests.
2. `continuation_sent` and `conflict` are not in the contract's error list. The client should treat any 409 as "reload".
3. There is no rate limiting on `/v1/extension/*` yet.

Status: DONE_WITH_CONCERNS
Summary: The /v1/extension/* routes are implemented on shared, refactored chat and setup cores. They are wired, documented and tested (real SQLite auth matrix, streaming including ui_action, abort/status, actions/respond with secret-leak checks, once-only continuation), and committed as 5e3e03ae without a push.
Concerns/Blockers: two 409 codes outside the contract list; no rate limiting; the tests need `-tags sqlite`; several existing Windows-only test failures are unrelated to this change.
