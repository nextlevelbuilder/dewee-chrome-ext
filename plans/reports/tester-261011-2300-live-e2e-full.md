# Live end-to-end verification: extension against a combined local Dewee stack

Date: 2026-10-11 (Asia/Saigon). Tester run. Extension worktree `claude/dewee-chrome-ext-bootstrap-58115d` (uncommitted, nothing committed).

## Stack

- Gateway built from a temporary detached worktree of `nextlevelbuilder/dewee`, merging in this order:
  1. `feat/956-gateway-extension-api`
  2. `feat/958-credential-request-capability`
  3. `fix/1000-cross-tenant-run-access`
  4. `feat/992-own-session-filter`
- Gateway bind: `127.0.0.1:18790`. Database: `dewee_ext_e2e` (local, throwaway). Secrets were generated locally and never printed.
- Stub LLM: `127.0.0.1:18791`. Resilience relay: `127.0.0.1:18792`.
- Dewee app (`apps/dewee-app` at `70bda2d9`, self-hosted node mode): `127.0.0.1:4321`. Database: `dewee_ext_e2e_app` (throwaway, dropped afterwards).
- Rate limit raised from the default 20 to 120 rpm through the `gateway.rate_limit_rpm` system config, on the throwaway database only.
- No production URL, no master token as a client credential, no `dewee/.env`, and no `goclaw_test` were used.

## Results (final full run: 21/21 passed in 2.4 min, one worker)

| Scenario | Spec / test | Result |
|---|---|---|
| A Cloud sign-in (OAuth PKCE via `launchWebAuthFlow`), consent, workspace, Super Agent chat | `live-cloud.spec.ts` | PASS |
| B1 connect with a personal key; agents listed, Super Agent first; key not in storage | `live-selfhosted` | PASS |
| B2 streamed reply; incremental deltas; a settings write keeps the chat; Stop | `live-selfhosted` (2 tests) | PASS |
| B3 Stop; a repeated abort is harmless | `live-selfhosted` | PASS |
| B4 revoked key ends the session, with no fallback and empty storage | `live-selfhosted` | PASS |
| C Super Agent `secret_request`: Done, the agent sees only `credential_ref`, the DB holds no plaintext, a duplicate respond is refused | `live-credentials` | PASS |
| C expired card refused (409 `action_closed`); foreign provider id and foreign base produce no card; nothing stored | `live-credentials` | PASS |
| D normal agent: no policy means refused; allowlisted means Done; another provider type is refused; a revoke while pending closes the card | `live-credentials` | PASS (see backend bug 1) |
| E double-click Save sends one respond and continues once | `live-credentials` | PASS |
| E lost respond response: the card reloads as Done, continues once, no re-send | `live-credentials` | PASS |
| E reopen mid-stream; service worker restart; offline then online; cancelled run stays cancelled | `live-resilience` (4 tests) | PASS |
| E1 history after reopen; a lost response reconciles without a duplicate | `live-selfhosted` | PASS |
| Smoke (5 tests) | `smoke.spec.ts` | PASS |

The no-leak checks on every C, D and E test use a unique sentinel secret. The sentinel was absent from all of these:
- model inputs (`/__stub/requests`)
- `chrome.storage.local` and `chrome.storage.session`
- page and service worker console output
- every non-respond request body
- chat history
- the Gateway log

Across all three Gateway runs, plus the app and stub logs, the sentinel matched 0 times.

Cloud A works under Playwright: the `launchWebAuthFlow` window shows up as a normal `context` page. The spec logs in through the app's email/password page, clicks Allow, and the extension exchanges the code. A real chat then streams `stub reply: …` through the BFF (`/api/extension/v1`) to the Gateway.

## Evidence (`plans/reports/assets/live-e2e/`)

- `a-cloud-reply.png`: Cloud profile, workspace "Extension Cloud E2E", Super Agent reply.
- `b2-streamed-reply.png`, `b4-revoked.png`
- `c-card-pending.png`, `c-card-done.png`
- `d-revoked-refused.png`: Cancelled card with the alert "This request is already closed."
- `e-lost-respond-reconciled.png`, `e-online-reconciled.png`

The full set of 24 screenshots was in `test-results/live/` and was removed during cleanup.

Annotations recorded:
- duplicate respond → `409 rotate_required`
- expired respond → `409 action_closed`

## New and changed test files (extension)

- `tests/e2e/live-credentials.spec.ts` (new): C, D, E credential scenarios. It sweeps old pending cards when the DB helper is configured.
- `tests/e2e/live-cloud.spec.ts` (new): scenario A. Skipped unless `E2E_CLOUD_ORIGIN`, `E2E_CLOUD_EMAIL` and `E2E_CLOUD_PASSWORD` are set.
- `tests/e2e/live-resilience.spec.ts`, `tests/e2e/live-selfhosted.spec.ts`: B and E.
- `tests/e2e/support/stub-llm.mjs`: multi-step scripts, `/__stub/requests`, unique tool-call ids.
- `tests/e2e/support/live.ts`: `scriptToolCall` prepends the `session_tasks` ensure step that the Gateway requires before other tools.
- Docs:
  - `tests/e2e/support/live-gateway.md`: specs table, stub routes, rate limit, DB helper contract, Cloud setup.
  - `docs/development.md`: env keys and live specs.

## Extension bugs found and fixed (each with a unit test)

1. A connection that dropped mid-stream (fetch `TypeError` while reading) showed "Send again" instead of reconciling. `src/api/dewee-client.ts` now maps it to `network_error`, so the panel reconciles and never re-sends. Test: `tests/unit/api/dewee-client.test.ts`.
2. A refused answer (409) reloads the card as closed. That unmounted the form and lost the refusal reason. `src/credentials/CredentialsForm.tsx` now renders the error line in the closed state too. Test: "keeps the refusal reason visible when the refused card reloads as closed".
3. `src/api/errors.ts` now reads `error.details.reason`. A known specific reason (`credential_policy_revoked`) becomes the error code; unknown reasons are ignored. Test: `tests/unit/api/errors.test.ts`.

Quality gates after the changes:
- `pnpm lint`: clean (two lint errors in my new test code were fixed).
- `pnpm typecheck`: clean.
- `pnpm test`: 22 files, 247/247 passed.
- `pnpm build`: OK.

## Backend bugs and observations (written up only; nothing changed in Dewee)

1. **Policy revoke loses its reason.** After `DELETE /v1/agents/{id}/credential-request-policy` while a card is pending, respond answers `409 action_closed` with no `details.reason: credential_policy_revoked`. The API contract documents that reason. The cause is the eager cancel on policy write, which closes the card first, so the panel can only say "This request is already closed." Evidence: `d-revoked-refused.png`; the D test annotation.
2. **First-turn session is invisible while it runs.** A new session is persisted only when its first run ends. Until then, `actions`, `sessions/{key}/status` and `chat/history` answer 404 "session not found: no access". A respond that is lost during the first run therefore cannot be reconciled until the run ends. The spec waits for the reply to finish, as a person would.
3. **Aborted run drops the user turn.** After a cancelled run, the user turn is missing from history. The extension keeps its local turn, so the E test passes; the server-side gap remains.
4. **956 extension API is not tenant-scoped.** It uses router methods without tenant scoping, which #1000 replaced elsewhere. The merge kept both. Tracked by the tenant-scope work (#1008, #1029).
5. **Policy PUT accepted from the admin token.** A policy PUT with the admin token is accepted and attributed to user `system`, although the policy is documented as "person only".
6. **Shared default rate limit.** The default `gateway.rate_limit_rpm` of 20 is shared by chat streams and card answers for each key. A person who answers a few cards while chatting can hit 429. Also, `config.json` is silently overridden by the database value.
7. **Self-hosted migrations are a no-op on Windows.** `apps/dewee-app` `migrate-self-hosted.mjs` checks `import.meta.url === file://${argv[1]}`, which never matches on Windows. I worked around it by importing `runSelfHostedMigrations` directly.
8. **Outbox worker starts before migrations.** The app's outbox worker logs "provisioning_outbox does not exist" when it starts before the migrations have run. A restart fixes it.

## Merge conflicts in the combined build

| File | Branches | Resolution |
|---|---|---|
| `CHANGELOG.md` | 958 vs 956 | Kept both entries |
| `apps/dewee-docs/spec.hash.lock` | 958 vs 956 | Took 956's hash; needs regenerating on the real merge |
| `internal/http/provisioning_chat_abort.go` | 1000 vs 956/991 | Union of the router methods |

`feat/992-own-session-filter` merged cleanly.

## Cleanup

- Stopped the Gateway (PID 51080), the stub (64624), the app (46412) and the Browser pane. Ports 18790, 18791, 18792 and 4321 are free.
- Dropped `dewee_ext_e2e_app`. `dewee_ext_e2e` stays as the reusable local test database; its rate limit is still 120.
- Removed temporary worktrees `worktrees/dewee-e2e-combined` and `worktrees/dewee-e2e-992`, and pruned them. The Dewee main checkout is untouched (`dev`, clean).
- Removed `test-results/`, `playwright-report/`, `.output-e2e/` and `%TEMP%/dewee-e2e-*` profiles (0 left). Ran `go clean -testcache`.
- `.output/` remains from `pnpm build` (gitignored).
- The DB helper (`e2edbtool`) source lived only in the removed worktree. Its command contract is documented in `live-gateway.md`; the binary is still in the session scratchpad.

Status: DONE_WITH_CONCERNS
Summary: Live scenarios A, B, C, D and E all pass (21/21) against a combined 956+958+1000+992 Gateway and a local Dewee app. Three extension bugs were fixed with tests, and lint, typecheck, unit tests and build are green.
Concerns/Blockers: Backend bug 1 (policy revoke reason missing) and observation 2 (first-turn session invisible) need Dewee issues. The DB helper is not in any repository, so the DB assertions need a rebuilt helper. `spec.hash.lock` must be regenerated when 956 and 958 really merge.
