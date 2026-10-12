# Extension OAuth client (PKCE) and bearer Extension BFF

The extension OAuth client and the bearer `/api/extension/v1` BFF are committed as `14183ba` on
`feat/957-ccp-extension-oauth` in `D:/www/nextlevelbuilder/worktrees/dewee-957-ccp-extension-oauth`.
Nothing was pushed and no PR was opened. All tests and the typecheck pass.

## Files (47 changed, +4054/-114), all under apps/dewee-app unless noted

- Migrations: `migrations/0034_extension_oauth.sql` (D1) and
  `self-hosted-migrations/0033_extension_oauth.sql` (pg). They add the codes, families, tokens and
  extension_chat_runs tables.
- `src/lib/extension-oauth/`: config, crypto, store, service and authorize, with tests that run
  real SQL through node:sqlite.
- `src/lib/extension-api/`:
  - `extension-api-http.ts`: the error envelope, CORS and no-store.
  - `extension-api-route.ts`: the bearer and public route wrappers, rate limits and audit.
  - `extension-workspace-access.ts`, `extension-api-views.ts`, `extension-chat-runs.ts` and
    `extension-chat-relay.ts`.
  - Tests for routes, the relay and boundaries.
- Shared helpers moved out of the cookie routes, so the logic is not duplicated:
  - `src/lib/workspace-chat-stream-support.ts`, used by `pages/api/workspaces/[workspaceId]/chat-stream.ts`.
  - `src/lib/workspace-setup/workspace-setup-action-list.ts`, used by `setup/actions.ts`.
- `src/pages/api/extension/v1/**`: 13 route files.
- `src/pages/oauth/extension/authorize.astro` with its page contract test, and
  `src/ccp/pages/auth/extension-consent-page.tsx`.
- i18n `auth.json` in en and vi (`extensionConsent.*`).
- Env plumbing: `src/env.d.ts`, `server/self-hosted-runtime-env-keys.mjs` and its test.
- `src/lib/migration-contract-matrix.test.ts`: migration counts are now 34 and 33.
- Docs (repo root): `docs/extension-oauth-and-bff.md` is new, and
  `docs/ccp-cli-command-parity-matrix.md` gained an exceptions bullet.

## Routes

- `GET|POST /oauth/extension/authorize`:
  - A signed-out visitor goes to `/?returnTo=`.
  - The consent POST is guarded by `assertSameOriginMutation` and rate limited.
  - The response redirects to the exact allowlisted `redirect_uri` with `code` and `state`.
  - Security headers: no-store, DENY framing, Referrer-Policy same-origin.
- `POST /api/extension/v1/auth/exchange` (30/min), `auth/refresh` (60/min) and `auth/revoke`
  (30/min, always answers `{revoked:true}`).
- Bearer routes:
  - `GET /me` needs no scope.
  - `GET /workspaces`, `GET /workspaces/{id}/agents` and `GET /workspaces/{id}/sessions` need
    `workspaces`.
  - `POST chat/history`, `POST chat/stream` (30/min), `POST chat/abort` (30/min) and
    `GET sessions/{key}/status` need `chat`.
  - `GET actions` and `POST actions/{action_id}/respond` (owner/admin, 30/min) need `actions`.
  - All other routes allow 120/min. Every route answers OPTIONS preflight.
- Behaviour across all routes:
  - Errors use the envelope `{"error":{"code","message"}}` and responses are no-store.
  - CORS reflects only allowlisted origins and never sends Allow-Credentials.
  - Extension routes ignore cookies.
  - A non-member gets 404. A member whose removal is in progress gets 403 `membership_suspended`.
  - Agents carry `is_super`, and the agents response carries `super_agent_key`.
  - `chat/stream` forwards runtime SSE frames verbatim, including `ui_action`. It rechecks the
    membership and token family every 5 s and on loss aborts and ends with `chat.stopped {}`.
  - Respond returns `{action, replayed, result?, continuation?}` and never echoes the secret.

## Env vars

- `DEWEE_EXTENSION_REDIRECT_URIS`: comma-separated, exact `https://<id>.chromiumapp.org/oauth2`.
- `DEWEE_EXTENSION_ORIGINS`: comma-separated, exact `chrome-extension://<id>`.
- The dev id `poicgajeapmbcilfbeobdfedibiffbbm` appears only in docs and config examples.

## Local e2e run

```sh
pnpm install
pnpm -C apps/dewee-app exec wrangler d1 migrations apply dewee-app --local
# apps/dewee-app/.dev.vars (never committed):
#   DEWEE_EXTENSION_REDIRECT_URIS=https://poicgajeapmbcilfbeobdfedibiffbbm.chromiumapp.org/oauth2
#   DEWEE_EXTENSION_ORIGINS=chrome-extension://poicgajeapmbcilfbeobdfedibiffbbm
#   plus the usual DEWEE_RUNTIME_URL / DEWEE_PROVISIONING_* for a reachable Gateway
pnpm -C apps/dewee-app dev   # http://localhost:4321
```

Point the extension's Cloud origin at `http://localhost:4321`. The chat routes need a workspace
whose onboarding reached `agent_bootstrapped` or `chat_ready`. Self-hosted pg applies
`self-hosted-migrations/0033` instead.

## Deviations

- **Run status:** the runtime has no run-status endpoint. `sessions/{key}/status` reads a CCP-side
  `extension_chat_runs` table, so it only sees runs relayed by this BFF. A run with no frames for
  15 minutes stops counting as running.
- **Sessions:** filtered on the BFF side to the caller's own app chats, with a bounded scan of up to
  10 pages of 50. `total` is the filtered count.
- **`/workspaces`:** lists memberships with status `active`, `suspended` or `not_ready`, rather than
  only chat-ready workspaces.
- **History:** message ids are positional (cursor + index). Cursors are strings. User turns that
  carry the setup marker are dropped.
- **Scope mapping:**
  - workspaces covers workspaces, agents and sessions.
  - chat covers history, stream, abort and status.
  - actions covers actions and respond.
- **New audit action:** `workspace.setup.action_responded` was added for respond. It is not in the
  activity-rows list.
- **Referrer-Policy is `same-origin`, not `no-referrer`:** with `no-referrer`, browsers send
  `Origin: null` on the consent POST and the same-origin check would refuse it.

## Test results

- Focused run (extension-api, extension-oauth, pages/oauth): 6 files, 56/56 passed. Coverage:
  - PKCE missing, plain or mismatched; redirect mismatch; state; code replay and expiry.
  - Refresh rotation and family revoke; revoke.
  - Bearer invalid or expired; cookie ignored; CORS allow and deny.
  - Membership and suspension; cross-workspace isolation.
  - SSE passthrough including `ui_action`; mid-stream membership loss and revoked family.
  - Respond without the secret; route/cookie boundary checks.
- Full `pnpm test`: 559 files, 3933 passed, 1 skipped.
- `pnpm typecheck`: 0 errors, 0 warnings, 75 hints. The hints are pre-existing and in unrelated
  files.
- `pnpm test:server`: 24/24 passed.
- Pre-existing noise, not failures: SQLite ExperimentalWarnings, jsdom navigation notices, and a
  vite dynamic-import warning in `setup-routes.test.ts`.

Status: DONE_WITH_CONCERNS
Summary: The extension OAuth client and bearer BFF are implemented, documented, tested and committed
as 14183ba. Full tests and the typecheck pass.
Concerns/Blockers:
- Run status covers only BFF-relayed runs until the runtime exposes a run-status read.
- In this session the Bash tool failed on every command, so all commands ran through a PowerShell
  subagent.
