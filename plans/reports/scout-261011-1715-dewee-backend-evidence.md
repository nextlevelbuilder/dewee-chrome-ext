# Dewee backend evidence for the Chrome extension (HEAD 9177af57, branch dev)

Status record from read-only scouting on 2026-10-11. Paths are relative to `nextlevelbuilder/dewee`.

## UI actions (`dewee.ui-action.v1`)

- Envelope and kinds: `internal/setup/uiaction/envelope.go:13-163`; limits in `validate.go:16-22` (payload 16 KiB, title 120 runes, body 1000 runes).
- Secret targets: `kinds_secret_request.go` (provider, channel_instance, cli_agent_credential, mcp_server, tts, stt; mode create|update; 1-8 fields). Exfiltration guard in `secret_target_catalog.go:29-91` (no URL, `api_base` only catalog default).
- Emission gate: `internal/tools/ui_action_tool.go:87-88` requires setup operator, tenant, non-master scope, channel `app`, session key.
- Persistence: table `workspace_setup_actions` (`migrations/000124_workspace_setup.up.sql`). TTL default 7 days, max 30.
- Delivery: only on `tool.call.completed` / `tool.call.error` SSE frames (`internal/http/provisioning_chat_stream.go:200-264`), re-validated server side. No WS event carries ui_action.
- Reload: `GET /v1/workspace-setup/actions` (gateway), CCP `GET /api/workspaces/{id}/setup/actions`.
- Respond: gateway `POST /v1/workspace-setup/actions/{id}/respond` (`workspace_setup_handler.go:136`), body `{response?, secret?}`, human-actor gate (`workspace_setup_actor_gate.go:115`, 403 `setup_human_actor_required`), owner/admin only. CAS state machine pending→applying→terminal; replay by response hash returns `replayed:true`; conflicts are 409.
- Continuation is composed by the gateway: `[[dewee:ui-action-result v1]] <kind> <id>: <result JSON>`, sent once via `setup_action_id` on the next chat turn.
- No generic `credential.request` capability exists.

## CCP app (`apps/dewee-app`, Astro 6 SSR)

- Cookie session `dewee_app_session`; `assertSameOriginMutation` blocks `chrome-extension://` origins (by design).
- No OAuth authorization server, no PKCE, no client/token tables.
- BFF calls the gateway with HMAC-signed provisioning requests (`/internal/v1/provision/workspace-chat`, `-abort`, `-history/follow`, `workspace-sessions`, `workspace-agents`, setup action respond).
- Chat SSE event names: `chat.started`, `message.delta`, `thinking.delta`, `tool.call.started`, `tool.call.completed`, `tool.call.error` (with `toolCall.uiAction`), `reasoning.activity`, `message.completed`, `chat.error`, `chat.stopped`.
- Super Agent: `SUPER_AGENT_KEY = "super-agent"`, pinned first, active agents only (`chat-page-data.ts:11,41-54`).
- Roles owner|admin|member, permission keys such as `chat.use`, `sessions.read`.

## Consequences

- Cloud mode needs a new Extension OAuth (Code + PKCE) server and bearer-only BFF routes in `apps/dewee-app`; the existing cookie and same-origin guard stay untouched.
- Self-hosted mode needs a gateway route that streams the same SSE frames (including `ui_action`) for a personal API key, plus CORS for approved extension origins.
- Generic agents need a new `credential.request` capability separate from `setup_operator`.
