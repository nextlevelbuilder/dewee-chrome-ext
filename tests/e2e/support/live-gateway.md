# Live gateway for end-to-end tests

Runs the live specs against a real Dewee Gateway (and, for Cloud, a local Dewee app) on your machine. Use a throwaway local gateway and database only; never a shared or production gateway.

| Spec | Scenarios | Needs |
|---|---|---|
| `live-selfhosted.spec.ts` | B1 to B4, E1: connect, agents, streaming, stop, key revocation, history | steps 1 to 3 |
| `live-resilience.spec.ts` | E: reopening, service worker restart, offline mid-stream, cancelled run | steps 1 to 3; port `18792` free (a cuttable TCP relay to the Gateway) |
| `live-credentials.spec.ts` | C credential cards, D admin policy, E double submit and lost respond | steps 1 to 3; step 5 for the database checks |
| `live-cloud.spec.ts` | A Cloud sign-in, workspace, Super Agent chat | step 6 |

Every spec skips itself when its environment is missing, so CI stays green without a gateway.

## 1. Model stub

```bash
node tests/e2e/support/stub-llm.mjs --port 18791
```

An OpenAI-compatible server on `127.0.0.1:18791/v1` with model `stub-model`:

- A message containing the word `slow` streams 40 words, one every 500 ms. Any other message gets `stub reply: <text>`.
- `POST /__stub/script {match, steps}` scripts tool calls: a turn whose user message contains `match` gets one batch of tool calls per model call (`steps[n]` after `n` tool rounds; each step is a list of `{name, arguments}`), then `tool result: <first line>` once the steps are used up. The Gateway refuses other tools until the turn has a task ledger, so the first step must be `session_tasks` `ensure`; `scriptToolCall()` in `live.ts` adds it.
- `GET /__stub/requests` returns the message lists the model received, so a test can prove a secret never reached the model.

## 2. Gateway

Build `dewee` from a Dewee checkout and start it with a fresh PostgreSQL database and locally generated random secrets:

| Variable | Value |
|---|---|
| `GOCLAW_POSTGRES_DSN` | DSN of a dedicated database, for example `dewee_ext_e2e` |
| `GOCLAW_GATEWAY_TOKEN`, `GOCLAW_ENCRYPTION_KEY` | Random hex you generate now. Never copy them from another `.env`. |
| `GOCLAW_HOST`, `GOCLAW_PORT` | `127.0.0.1`, `18790` |
| `GOCLAW_ALLOWED_ORIGINS` | `chrome-extension://poicgajeapmbcilfbeobdfedibiffbbm` |
| `GOCLAW_ALLOW_PRIVATE_PROVIDER_URLS` | `1`, so a provider may point at the loopback stub |
| `GOCLAW_TELEMETRY_ENABLED` | `false` |

Rate limit: chat streams and card answers each get their own per-key budget of `gateway.rate_limit_rpm` (default 20 per minute). The full live run still needs more, because its chat streams alone pass 20 per minute. The database system config wins over `config.json`, so raise it with `PUT /v1/system-configs/gateway.rate_limit_rpm` (admin token, for example `120`) and restart the Gateway.

## 3. Tenant, agents and personal key

```bash
GOCLAW_GATEWAY_TOKEN=<test gateway token> DEWEE_BIN=<path to dewee> node tests/e2e/support/setup-live-gateway.mjs
```

This is idempotent. It creates tenant `ext-e2e`, owner `e2e-owner@example.test`, the `stub-llm` provider and the agents `super-agent` and `e2e-helper`. It then mints an owner-bound key with `dewee api-keys create --scopes operator.read,operator.write` and writes these keys to the gitignored `.env`:

- `E2E_GATEWAY_URL`
- `E2E_GATEWAY_API_KEY`
- `E2E_WORKSPACE_ID`
- `E2E_OWNER_ID`
- `E2E_GATEWAY_ADMIN_TOKEN`

It prints only ids. The extension only ever uses the personal key. The admin token is used only by the tests: to mint and revoke a throwaway key, and to set or delete the `e2e-helper` credential-request policy. Policy writes are person-only, so the tests send them as the owner (`X-GoClaw-User-Id: E2E_OWNER_ID`); as `system` the Gateway answers `403` with `cause: system_actor`.

## 4. Run

```bash
pnpm build:e2e
npx playwright test tests/e2e/live-selfhosted.spec.ts tests/e2e/live-resilience.spec.ts tests/e2e/live-credentials.spec.ts
```

Evidence screenshots go to `test-results/live/`. Playwright empties `test-results/` at the start of each run.

## 5. Credential checks (optional)

| Variable | Value |
|---|---|
| `E2E_GATEWAY_LOG` | Path of the Gateway's log file. The specs assert the test secret never appears in it. |
| `E2E_DB_TOOL` | Path of a local helper binary that reads `E2E_DB_DSN` and prints JSON statuses only, never column values. |
| `E2E_DB_DSN` | DSN of the same throwaway Gateway database. |

The helper answers these commands; the Dewee repository does not ship it, so build it next to your Gateway checkout:

| Command | Output |
|---|---|
| `expire <action-id>` | `{"updated": n}` after moving a pending card's `expires_at` into the past |
| `provider <tenant-id> <name> <sentinel>` | `{"found", "key_set", "plaintext", "contains"}` for the provider's stored key |
| `action <action-id> <sentinel>` | `{"found", "contains"}` for the card row |
| `sweep <tenant-id>` | cancels the tenant's pending cards, so earlier runs do not hit the open-card caps |

Without them, the expired-card test is skipped and the other tests skip only the database assertions.

## 6. Cloud (`apps/dewee-app`)

Run the Dewee app in self-hosted node mode on `127.0.0.1:4321`, in front of the Gateway above:

- Gateway: add `DEWEE_PROVISIONING_KEY_ID=self-hosted` and a random `DEWEE_PROVISIONING_SECRET`.
- App: `DEWEE_APP_POSTGRES_DSN` (its own throwaway database), `DEWEE_RUNTIME_URL=http://127.0.0.1:18790`, the same provisioning pair, `DEWEE_EXTENSION_REDIRECT_URIS=https://poicgajeapmbcilfbeobdfedibiffbbm.chromiumapp.org/oauth2`, `DEWEE_EXTENSION_ORIGINS=chrome-extension://poicgajeapmbcilfbeobdfedibiffbbm`, `DEWEE_SETUP_TOKEN_MODE=loopback` and `DEWEE_PUBLISHED_BIND_ADDR=127.0.0.1`.
- Create the owner (`POST /api/setup/owner`), a workspace, a provider pointing at the stub (`apiBase` `http://127.0.0.1:18791/v1`, model `stub-model`) and the Super Agent, until the workspace reaches `agent_bootstrapped`.

Then set `E2E_CLOUD_ORIGIN=http://127.0.0.1:4321`, `E2E_CLOUD_EMAIL` and `E2E_CLOUD_PASSWORD` (the owner's test password) and run `npx playwright test tests/e2e/live-cloud.spec.ts`. The spec types the Cloud URL into the connect form, so the normal e2e build works. `launchWebAuthFlow` opens a window that Playwright sees as a page: the spec logs in there and clicks Allow on the consent screen. The password is typed only into the app's login page.
