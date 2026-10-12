# Live e2e, self-hosted: report

Date: 2026-10-11. Worktree: `dewee-chrome-ext-bootstrap-58115d`. Gateway source: `D:/www/nextlevelbuilder/worktrees/dewee-956-gateway-extension-api` @ `5e3e03ae`. The gateway was read and built only, never modified. Nothing was committed.

## Result

| Scenario | Result |
|---|---|
| B1: connect, status, workspace, agents (Super Agent first) | PASS |
| B2: chat reply | PASS (text arrives at completion, see gateway bug 1) |
| B3: stop a running reply; second abort is harmless; follow-up works | PASS |
| B4: revoked key → reconnect screen, no fallback, no key/token in storage | PASS |
| E1: reopen keeps history; lost response reconciles, one POST, one user turn | PASS |
| Smoke spec (5 tests) | PASS |

Final run: `npx playwright test tests/e2e/live-selfhosted.spec.ts tests/e2e/smoke.spec.ts`, 10 passed in 1.6 min.

Evidence is in `test-results/live/`:

- `b1-connected-agents.png`
- `b2-streamed-reply.png`
- `b3-stopped.png`
- `b4-revoked.png`
- `e1-reopened-history.png`
- `e1-reconnecting.png`
- `e1-reconciled.png`

I checked the screenshots by eye: the key field is empty and no secret is on screen.

## Gates (all exit 0)

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`: 21 files, 230 tests
- `pnpm build`
- `pnpm build:e2e`
- the Playwright run above

## Files

New:

- `tests/e2e/support/stub-llm.mjs`: deterministic OpenAI-compatible stub on `127.0.0.1:18791`. Any message containing `slow` streams 40 words, one every 500 ms. Tool calls can be added through `plan()`, for the credential-card scenarios C/D.
- `tests/e2e/support/setup-live-gateway.mjs`: idempotent setup. Creates the tenant `ext-e2e`, the owner, the `stub-llm` provider, and the agents `super-agent` and `e2e-helper`. Mints the personal key through `dewee api-keys create`, upserts `.env`, and prints only ids.
- `tests/e2e/support/live-gateway.md`: how-to.
- `tests/e2e/live-selfhosted.spec.ts`: B1–B4 and E1. Loads `.env` with `process.loadEnvFile`. Skips unless `E2E_GATEWAY_URL` and `E2E_GATEWAY_API_KEY` are set. B4 also skips without `E2E_GATEWAY_ADMIN_TOKEN`, `E2E_OWNER_ID` and `E2E_WORKSPACE_ID`.

Changed:

- `docs/development.md`: added the new `.env` keys and a "Live end-to-end" subsection.
- `.env.example`: added empty `E2E_OWNER_ID` and `E2E_GATEWAY_ADMIN_TOKEN`.
- `eslint.config.js`: added Node globals for `tests/e2e/support/**/*.mjs`.

No `src/` changes. I found no client bug: reconcile, stop, 401 handling and history restore all behaved correctly against the real gateway.

## Environment used

- **Database:** `dewee_ext_e2e`. `goclaw_test` was not touched.
- **Gateway secrets:** generated locally with random bytes and kept in the scratchpad (`gw/secrets.env`), never printed. Nothing was reused from `dewee/.env`.
- **Gateway env:** `GOCLAW_HOST=127.0.0.1`, `GOCLAW_PORT=18790`, `GOCLAW_ALLOWED_ORIGINS=chrome-extension://poicgajeapmbcilfbeobdfedibiffbbm`, `GOCLAW_ALLOW_PRIVATE_PROVIDER_URLS=1`, `GOCLAW_TELEMETRY_ENABLED=false`.
- **Extension credential:** owner-bound personal key with scopes `operator.read,operator.write`, minted by the CLI and written straight to `.env` ("written").
  - Key id: `01a12aaa-d87b-7720-9676-03d99d0bf3d9`.
  - Tenant id: `<workspace-id>`.
  - `.env` is gitignored: `git check-ignore .env` returns `.gitignore:10`.
- **Master token:** used only for admin setup, and in B4 to mint and revoke a throwaway key. Admin calls send `X-GoClaw-User-Id: system`; revoke also needs `X-GoClaw-Tenant-Id`. B4 checks that storage contains neither key nor the admin token.
- **Secret scan:** all 128 tracked or unignored files contain neither secret value.

## Commands

```powershell
# Each in the background, from the scratchpad gw dir
. gw-env.ps1; ./dewee.exe *> gateway.log                 # PID 53424, 127.0.0.1:18790
node tests/e2e/support/stub-llm.mjs --port 18791          # PID 60480, 127.0.0.1:18791

# Setup (token taken from the env, never printed)
$env:DEWEE_BIN=...; node tests/e2e/support/setup-live-gateway.mjs

# Gates
pnpm lint; pnpm typecheck; pnpm test; pnpm build; pnpm build:e2e
npx playwright test tests/e2e/live-selfhosted.spec.ts tests/e2e/smoke.spec.ts
```

## Gateway bugs (documented, not fixed)

### 1. Stream deltas are always empty

- **Where:** `internal/agent/loop_pipeline_callbacks.go:443` and `internal/agent/loop_pipeline_adapter.go:329` emit `Payload: map[string]string{"content": ...}`. `internal/http/provisioning_chat_stream.go:201` does `payload, _ := ae.Payload.(map[string]any)`. The type assertion fails, so every `message.delta` has `delta:""`.
- **Effect:** text appears only at `message.completed`. Nothing streams token by token.
- **Repro:** POST `/v1/extension/workspaces/{ws}/chat/stream`. Every `message.delta` frame has an empty delta, and the full text arrives only in `message.completed`.
- **Fix:** accept `map[string]string`, or emit `map[string]any`.

### 2. Extension and provisioning chat runs are not registered with the router

- **Where:** `internal/http/provisioning_chat_runner.go:25-67` (`RunWorkspaceChat`) calls `loop.Run` at `:50` and never calls `RegisterRun`. Compare `internal/http/chat_completions.go:211` and `internal/gateway/methods/chat.go:454`.
- **Effect:** during a run, `GET .../sessions/{key}/status` returns `running:false`, and `POST .../chat/abort` returns 200 `{aborted:false}` without stopping the run.
- **Repro:** send `slow ...` in an existing session, then call abort twice. Both return `aborted:false`, and the run finishes all 40 words.
- **Client impact:** Stop still works, because the client also aborts its fetch. Reconcile cannot observe a running turn.

### 3. Client disconnect cancels the run and drops the turn

- **Where:** the run context comes from `r.Context()` (`internal/http/extension_api_chat.go:81,116`), so closing the connection cancels the run.
- **Effect:**
  - The cancelled turn's user message is not saved.
  - In a brand-new session, `/status` returns 404 until the first run saves the session.
- **Repro:**
  - New session, disconnect mid-stream: history is empty.
  - Existing session, disconnect mid-stream: that turn is missing from history.
- **Test impact:** a true mid-stream disconnect cannot reconcile to a reply. So E1 simulates a lost response instead:
  1. `context.route` lets the gateway finish the turn (`route.fetch`).
  2. The browser goes offline and the response is aborted (`internetdisconnected`).
  3. The panel shows "Reconnecting…" and Offline, then goes back online.
  4. The panel restores the reply from history, with exactly one stream POST and one user turn on the server.
- **Fix:** detach the run with `context.WithoutCancel` plus the router's cancel.

B3 asserts `≤1` copies of the stopped user turn, because bug 3 drops it.

## Cleanup and process state

- The gateway (PID 53424, port 18790) and the stub (PID 60480, port 18791) are stopped through TaskStop. I confirmed nothing listens on 18790 or 18791.
- `playwright-report/` removed. Non-live `test-results/` subdirectories removed; `test-results/live/*.png` kept.
- I removed one leftover `%TEMP%/dewee-e2e-*` profile dir. It most likely came from an aborted earlier run in this session.
- Kept in the scratchpad `gw/`: the built `dewee.exe`, `secrets.env`, `gw-env.ps1`, the logs and the probe scripts. The `dewee_ext_e2e` database is kept so the suite can run again.
- To run again: restart both processes with the commands above. Setup is optional, because `.env` is already filled.
- **Nothing is left running.**
