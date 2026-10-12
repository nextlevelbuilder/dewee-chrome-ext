# Dewee Extension API contract (v1)

The extension talks to Dewee through one versioned HTTP contract, served in two places:

| Mode | Base URL | Credential | Served by |
|---|---|---|---|
| Self-hosted | `{gatewayOrigin}/v1/extension` | Personal API key, owner-bound and tenant-bound, scopes `operator.read` + `operator.write` | Dewee Gateway (Go) |
| Dewee Cloud | `{cloudOrigin}/api/extension/v1` | OAuth access token from the Extension OAuth client (Authorization Code + PKCE) | CCP app (`apps/dewee-app`), which calls the Gateway through the existing signed provisioning routes |

Both bases expose the same paths, bodies and stream frames, so the extension has one typed client (`src/api/dewee-client.ts`) with two auth adapters. The Gateway stays authoritative for agents, sessions, runs, UI actions, RBAC and the encrypted credential store; the extension never decides permissions.

Source of truth for this contract: this file plus the Zod schemas in `src/protocol/`. Backend changes live in `nextlevelbuilder/dewee` (see "Backend status" at the end of this file).

## Conventions

- JSON bodies use `snake_case`. Requests carry `Authorization: Bearer <token>` and `Content-Type: application/json`. Cookies are never used or accepted by these routes.
- Errors use one envelope and an HTTP status:

  ```json
  { "error": { "code": "forbidden", "message": "Human-readable text", "retry_after_seconds": 30, "details": {} } }
  ```

  | Status | `code` examples | Client behavior |
  |---|---|---|
  | 400 | `invalid_request` | Show message; do not retry. |
  | 401 | `unauthenticated`, `token_expired`, `token_revoked` | Cloud: one refresh attempt, then sign out. Self-hosted: mark profile as needing a new key. Never fall back to another profile or workspace. |
  | 403 | `forbidden`, `owner_binding_required`, `scope_required`, `setup_human_actor_required`, `membership_suspended` | Show the reason; keep the session; no retry. |
  | 404 | `not_found` (also for a workspace the caller is not a member of) | Show "not found or no access". |
  | 409 | `action_closed`, `action_in_progress`, `response_conflict`, `rotate_required`, `run_in_progress`, `continuation_sent`, `continuation_in_progress`, `conflict` | Reload the action or run state from the server. Clients treat any 409 this way, including codes not listed. |
  | 429 | `rate_limited` | Wait `retry_after_seconds` (or `Retry-After`). |
  | 5xx | `runtime_unavailable` | Backoff and retry reads; never replay a chat send or action respond automatically. |

- The Gateway rate limits writes (`chat/stream`, `actions/{id}/respond`) per API key; `chat/abort` is never limited, so a run can always be stopped. A 429 shows the wait time and leaves retry to the person.
- A workspace `viewer` can read (status, agents, sessions, history, actions) but gets 403 `forbidden` on stream, abort and respond, whatever the key's scopes. A run uses the lower of the tenant role and the key's role.
- Error messages never echo submitted values.
- `Cache-Control: no-store` on every response.
- CORS: only exact `chrome-extension://<id>` origins configured by the operator are reflected; `Access-Control-Allow-Credentials` is never sent.

## Endpoints

### `GET /me`

```json
{ "user": { "id": "u_123", "email": "a@b.c", "display_name": "An" },
  "auth": { "mode": "api_key", "scopes": ["operator.read", "operator.write"], "expires_at": null } }
```

`mode` is `api_key` (self-hosted) or `oauth` (Cloud).

### `GET /workspaces`

```json
{ "workspaces": [ { "id": "ws_1", "name": "Acme", "role": "owner", "status": "active" } ] }
```

- Cloud: every workspace where the user has a membership. `status` is `active`, `suspended` or `not_ready`; the panel lists the others but only opens `active` ones.
- Self-hosted: exactly one entry, the key's tenant (`id` = tenant UUID).
- `role` is `owner`, `admin`, `member` (Cloud) or `owner`, `admin`, `operator`, `viewer` (Gateway). The UI only uses it for hints; the server enforces.

All paths below are under `/workspaces/{workspace_id}`. A workspace the caller cannot access returns 404.

### `GET /workspaces/{id}/agents`

```json
{ "agents": [ { "key": "super-agent", "id": "uuid", "name": "Super Agent", "status": "active", "model": "gpt-5", "provider": "openai", "is_super": true } ],
  "super_agent_key": "super-agent" }
```

Only active agents the caller may chat with. `is_super` is true for `agent_key == "super-agent"` or the workspace's onboarding Super Agent id. The client pins it first.

### `GET /workspaces/{id}/sessions?agent_key=&limit=20&offset=0`

```json
{ "sessions": [ { "key": "agent:super-agent:app:direct:u_123-1a2b3c4d", "agent_key": "super-agent", "title": "…", "updated_at": "2026-10-11T10:00:00Z", "message_count": 12 } ],
  "total": 1, "limit": 20, "offset": 0 }
```

Only the caller's own `app` channel sessions. `limit` is 1–50.

### `POST /workspaces/{id}/chat/history`

Request `{ "session_key": "…", "cursor": "…", "limit": 50 }` (cursor and limit optional).

```json
{ "session_key": "…", "cursor": "…", "next_cursor": "…", "reset": false,
  "messages": [ { "id": "m1", "role": "user", "content": "Hi", "created_at": "…" },
                { "id": "m2", "role": "assistant", "content": "Hello", "created_at": "…" } ] }
```

History is a follow log. `cursor` is a message position (`0` = oldest, default `0`), `limit` is 1–200 (default 50), and `next_cursor` is the position after the last message returned. A page shorter than `limit` means the end. `reset: true` means the cursor is past the end, and `next_cursor` is then the log length; a client that was following reads again. The cursor is at most 9 digits. The panel first asks with a cursor past the end to learn the length, follows only the newest 1,000 messages, and reveals them 50 at a time.

Roles are `user`, `assistant` or `tool`; ids are `m<position>`. System messages and Gateway setup-turn markers are never returned, and tool output is redacted. Turns the server wrote itself are returned only with `injected: true` (below). A session that does not belong to the caller returns 404.

A message carries `injected: true` when the server, not the model or the person, wrote it. Since [dewee#1045](https://github.com/nextlevelbuilder/dewee/pull/1045) a run stopped before replying stores an injected assistant turn with the marker content `[Stopped before replying]`. The panel shows an injected assistant turn as an empty reply labelled "Stopped", like a live Stop, and never shows the marker text; it drops any other injected message, and never counts an injected user turn as one the person sent.

### `POST /workspaces/{id}/chat/stream`

Request:

```json
{ "agent_key": "super-agent", "message": "Hello", "session_key": "optional", "setup_action_id": "optional uuid" }
```

- `session_key` absent starts a new server-generated session; the key is returned in `chat.started`.
- `setup_action_id` sends the Gateway-composed continuation of a resolved card instead of `message` (which must then be empty). The client never writes the continuation text itself.
- A `message` starting with `[[dewee:` is rejected (400).

Response: `text/event-stream`, one frame per event, terminated by `message.completed`, `chat.error` or `chat.stopped`:

| Event | Data |
|---|---|
| `chat.started` | `{ "run_id", "session_key", "agent_key" }` |
| `message.delta` / `thinking.delta` | `{ "delta" }` |
| `tool.call.started` | `{ "tool_call": { "id", "name", "arguments", "via_agent"? } }` |
| `tool.call.completed` / `tool.call.error` | `{ "tool_call": { "id", "name", "result_summary", "error"?, "via_agent"? }, "ui_action"?: <dewee.ui-action.v1 envelope> }` |
| `reasoning.activity` | `{ "phase", "details" }` |
| `message.completed` | `{ "message": { "role": "assistant", "content", "created_at" }, "usage"?, "media"? }` |
| `chat.error` | `{ "code", "message", "recovery_action", "retry_after_seconds"? }` |
| `chat.stopped` | `{}` |

These are exactly the frames the Gateway already emits for CCP (`internal/http/provisioning_chat_stream.go`). `ui_action` is present only after the Gateway re-validated the card; the client validates again (`src/protocol/ui-action.ts`).

### `POST /workspaces/{id}/chat/abort`

Request `{ "session_key": "…", "run_id": "optional", "agent_key": "optional" }` → `{ "aborted": true }`.

### `GET /workspaces/{id}/sessions/{session_key}/status`

`{ "running": true, "run_id": "…" }`. Used after the panel reopens or the service worker restarts, to reconcile instead of re-sending.

### `GET /workspaces/{id}/actions?session_key=&status=pending`

`{ "actions": [ <dewee.ui-action.v1 envelope> ] }`. Reloads cards that were emitted while the panel was closed.

### `POST /workspaces/{id}/actions/{action_id}/respond`

Request (only these keys):

```json
{ "response": { "fields": { "name": "openai-prod" } }, "secret": { "api_key": "<typed by the person>" } }
```

- `secret` is accepted only for `secret_request` cards and only for declared `secret` fields (1–8 keys, each ≤ 16 KiB). `response` is ≤ 8 KiB.
- The caller must be a person (Gateway human-actor gate) with owner/admin on the workspace (Cloud) or owner/admin tenant role (self-hosted); otherwise 403 `setup_human_actor_required` or `forbidden`.

Response:

```json
{ "action": <envelope with new status>, "replayed": false,
  "result": { "target_type": "provider", "name": "openai", "connected": true, "credential_ref": "cred:v1:provider:<id>" },
  "continuation": { "session_key": "…", "agent_key": "super-agent", "setup_action_id": "<action id>" } }
```

The response never contains the secret. When `continuation` is present the client starts `chat/stream` with `setup_action_id`. The Gateway delivers a continuation at most once, so a client may resend a pending one, by hand or automatically, when it cannot tell whether the first one arrived: it is not a user message and cannot start a second run. A continuation counts as delivered only on `message.completed`, a 409 `continuation_sent` or a `chat.error` `setup_result_delivered`. `chat.started` is not proof: it is emitted before the first model call, and if the run fails before the result is saved (provider error, rate limit, exhausted credit) the Gateway releases the send lease, so the continuation can be sent again. The outcomes that settle a continuation (backend change [dewee#1047](https://github.com/nextlevelbuilder/dewee/issues/1047), implemented in [dewee#1022](https://github.com/nextlevelbuilder/dewee/pull/1022)):

| Code | Meaning | Panel |
|---|---|---|
| `continuation_sent` (409) | The continuation was delivered. | Drops the item silently (no error bubble) and reloads the conversation. |
| `setup_result_delivered` (`chat.error`, `recovery_action` `continue_in_chat`) | The continuation reached the agent's session, but the run then failed. It must not be resent. | Drops the item, shows the error's message and lets the person continue in the chat. |
| `continuation_in_progress` (409) | Another request holds a live send lease (renewed every 2.5 min, stale after 10 min). It may still fail and release, so delivery is not confirmed. The response carries a `Retry-After` header and `error.retry_after_seconds` (currently 5). | Keeps the item and sends it again after the server's hint (5 s without one), then 15 s, 30 s and every 60 s, while its session is shown and idle, for about 11 min after the first such answer; then shows "Continue". |

A 400, 404 or 410, or a 403 other than `scope_required` / `owner_binding_required`, means the card or continuation is invalid, gone or not allowed: the panel drops the item, says once that the card's result could not be delivered so the person should ask the agent again in chat (`continuation_refused`), and logs a `console.warn` with the status and code only. A 403 `scope_required` or `owner_binding_required` is a key problem the person can fix, so the item is kept, held, with "Continue" and the key error. Anything else is not proof of delivery: any other `chat.error`, a stream that closes early or drops after the response, Stop, or any other refusal, including an unknown 409 code. The panel keeps the item, held, and shows "Continue"; a held item is not sent automatically again.

## Cloud authentication (Extension OAuth client)

Public client `dewee-chrome-extension`, Authorization Code + PKCE S256, launched with `chrome.identity.launchWebAuthFlow`.

1. `GET {cloudOrigin}/oauth/extension/authorize?response_type=code&client_id=dewee-chrome-extension&redirect_uri=https://<extension-id>.chromiumapp.org/oauth2&code_challenge=<S256>&code_challenge_method=S256&state=<random>&scope=chat%20workspaces%20actions`
   - Signs the person in with the existing web login if needed, shows a consent screen, then redirects to `redirect_uri?code=…&state=…`.
   - `redirect_uri` must exactly match an allowlisted URI (env `DEWEE_EXTENSION_REDIRECT_URIS`).
2. `POST /api/extension/v1/auth/exchange` `{ "grant_type": "authorization_code", "code", "code_verifier", "redirect_uri", "client_id" }`
   → `{ "access_token", "token_type": "Bearer", "expires_in": 900, "refresh_token", "refresh_expires_in", "scope" }`. Codes are single-use and expire after 60 s.
3. `POST /api/extension/v1/auth/refresh` `{ "refresh_token", "client_id" }` → same shape with a rotated refresh token. Reusing a rotated refresh token revokes the whole token family (replay detection).
4. `POST /api/extension/v1/auth/revoke` `{ "token" }` → `{ "revoked": true }`. Revokes the family.

Tokens are opaque, stored hashed, bound to user, client and audience `dewee-extension`. They are not web sessions and are never accepted by cookie routes; Google/GitHub tokens are never used as Dewee bearers.

## Generic agent credential requests

Agents without `setup_operator` may emit only `secret_request` / `oauth_request` cards through the `credential_request` tool, and only when a workspace owner/admin granted the agent a policy:

```json
{ "enabled": true, "targets": [ { "type": "provider", "provider_type": "openai", "modes": ["create", "update"] } ] }
```

The card uses the same `dewee.ui-action.v1` envelope, store, appliers, human-actor gate and continuation as setup cards. Holding the capability never allows reading, approving or submitting a credential. Policy is managed through the Gateway HTTP API, WS RPC and the `dewee agents credential-policy` CLI, by tenant owners/admins only.

Tool-issued cards expire after one hour. The Gateway re-checks the agent's current policy when the person responds; a revoked or narrowed policy cancels the card and the respond call returns `409` with the card's usual error `code` plus `error.details.reason: "credential_policy_revoked"` (dewee#1019). The panel maps that reason to its localized `error.credential_policy_revoked` message; any other or malformed `details` keeps the envelope's own `code`. Like every 409 on respond, the panel reloads the card (now cancelled) and shows the reason. Repeat requests for the same target in a session return the existing open card, and open cards are capped per conversation and per agent.

## Backend status

Already on Dewee `dev`: runtime SSE frames including `ui_action`, the UI action store with respond, appliers, human-actor gate and continuation, `GET /v1/auth/token/status`, and owner-bound API keys.

The extension depends on these open Dewee pull requests. They target `dev`; stacked PRs are retargeted after their base merges.

| Capability | Pull request | Notes |
|---|---|---|
| Workspace chat runtime: deltas, run registration for status/abort, busy guard, one terminal frame, serialized SSE writes | [dewee#1021](https://github.com/nextlevelbuilder/dewee/pull/1021) | Closes #991 and #1001 |
| Gateway `/v1/extension/*` for personal API keys (streaming, abort, status, actions, CORS), tenant-scoped run lookups, a separate respond rate limit, `continuation_in_progress` vs `continuation_sent` | [dewee#1022](https://github.com/nextlevelbuilder/dewee/pull/1022) | Closes #956, #1036 and #1047; stacked on #1021 |
| `credential_request` capability for non-setup agents, the kept `credential_policy_revoked` reason, and policy writes refused without a human actor | [dewee#1019](https://github.com/nextlevelbuilder/dewee/pull/1019) | Closes #958 and #1035 |
| First-turn session visible to its owner during the run; a stopped run keeps the user turn in history, followed by an injected `[Stopped before replying]` marker | [dewee#1045](https://github.com/nextlevelbuilder/dewee/pull/1045) | Closes #1033 and #1034 |
| Extension OAuth client (PKCE, rotation, revoke) and CCP BFF `/api/extension/v1/*` | [dewee#1014](https://github.com/nextlevelbuilder/dewee/pull/1014) | Closes #957 |
| Own-session filter in the Gateway for the BFF sessions list | [dewee#1015](https://github.com/nextlevelbuilder/dewee/pull/1015) | Closes #992; stacked on #1014 |
| 160 KiB respond body cap on the browser route | [dewee#1011](https://github.com/nextlevelbuilder/dewee/pull/1011) | Closes #993 |
| Tenant-scoped run lookups for status and abort | [dewee#1010](https://github.com/nextlevelbuilder/dewee/pull/1010) | Closes #1000 |
| Key the router session-run index by tenant | [dewee#1028](https://github.com/nextlevelbuilder/dewee/pull/1028) | Closes #1008; stacked on #1021 |
| Scope run-ID abort, scheduler session queues and activity by tenant | [dewee#1031](https://github.com/nextlevelbuilder/dewee/pull/1031) | Closes #1029; stacked on #1028 |
| Scope the heartbeat busy check and throttle estimate by tenant; clear only the finishing run's activity | [dewee#1040](https://github.com/nextlevelbuilder/dewee/pull/1040) | Closes #1032; stacked on #1031 |
