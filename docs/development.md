# Development

## Requirements

- Node 22+, pnpm 10 (`corepack enable`).
- Chrome 116+ (side panel API).
- For end-to-end work: a Dewee Gateway (self-hosted mode) or a CCP app (Cloud mode). See [api-contract.md](api-contract.md).

## Setup

```bash
pnpm install
cp .env.example .env   # optional; only build-time, non-secret values
pnpm dev               # opens Chrome with the extension and hot reload
```

`.env` keys (all optional):

| Key | Purpose |
|---|---|
| `WXT_DEWEE_CLOUD_ORIGIN` | Cloud origin baked into the build. Default `https://app.dewee.sh`. |
| `E2E_GATEWAY_URL`, `E2E_GATEWAY_API_KEY`, `E2E_WORKSPACE_ID` | Used only by the live Playwright scenarios. Never baked into the build. |
| `E2E_OWNER_ID`, `E2E_GATEWAY_ADMIN_TOKEN` | Live tests only, on a local test gateway: mint and revoke a throwaway key, set and delete a credential-request policy. |
| `E2E_GATEWAY_LOG`, `E2E_DB_TOOL`, `E2E_DB_DSN` | Optional live credential checks: the secret is absent from the Gateway log and stored encrypted. |
| `E2E_CLOUD_ORIGIN`, `E2E_CLOUD_EMAIL`, `E2E_CLOUD_PASSWORD` | Live Cloud scenario only, against a local Dewee app. Test values; never a real account. |
| `E2E_ALLOW_REMOTE` | The live specs skip when `E2E_GATEWAY_URL` or `E2E_CLOUD_ORIGIN` is not loopback (`localhost`, `127.0.0.1`, `[::1]`). Set to `1` only to target a remote throwaway test stack on purpose. |

The unpacked extension id is pinned by the public key in `extension-public-key.json`: `poicgajeapmbcilfbeobdfedibiffbbm`. Register this redirect URI with the CCP OAuth client: `https://poicgajeapmbcilfbeobdfedibiffbbm.chromiumapp.org/oauth2`.

## Local gateway for self-hosted mode

1. Start the Dewee Gateway with `GOCLAW_ALLOWED_ORIGINS=chrome-extension://poicgajeapmbcilfbeobdfedibiffbbm` so the extension origin passes CORS.
2. In Dewee, create a personal API key bound to your user with scopes `operator.read` and `operator.write`. Do not use the gateway master token.
3. In the extension, choose **Self-hosted**, enter `http://localhost:<port>` (HTTP is accepted only for loopback) and the key.

## Quality gates

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm test:e2e     # builds, then Playwright loads .output/chrome-mv3
pnpm zip          # .output/dewee-chrome-ext-<version>-chrome.zip (keeps the pinned key, for sideloading)
pnpm zip:store    # .output-store/… without `key`, for the Chrome Web Store
```

The Chrome Web Store rejects a manifest that carries `key` and assigns its own extension ID. Register that store ID's `chromiumapp.org` redirect URI and `chrome-extension://` origin next to the unpacked ones.

### Live end-to-end

The `tests/e2e/live-*.spec.ts` specs drive the built extension against a real local Dewee Gateway: connect, agents, chat, stop, key revocation, reopening the panel, reconciling a lost response (`live-selfhosted`), stream resilience (`live-resilience`), credential cards and admin policy (`live-credentials`), and Cloud sign-in through a local Dewee app (`live-cloud`). Each is skipped unless its environment is set (shell or `.env`). The model is the deterministic stub `tests/e2e/support/stub-llm.mjs`; `tests/e2e/support/setup-live-gateway.mjs` creates the tenant, agents and personal key and writes them to `.env`. Steps: [tests/e2e/support/live-gateway.md](../tests/e2e/support/live-gateway.md).

```bash
pnpm build:e2e
npx playwright test tests/e2e/live-   # all live specs; screenshots in test-results/live/
```

CI (`.github/workflows/ci.yml`) runs the same gates and uploads the built extension and Playwright report. Tagging `v*` runs `.github/workflows/release.yml`, which attaches the zip to a GitHub release.

## Contract sync

`scripts/sync-dewee-contract.mjs` copies the `dewee.ui-action.v1` schema and examples from a Dewee checkout into `tests/contract-fixtures/ui-action-v1`. Contract tests fail when the Zod schemas drift from Dewee.

## Conventions

- Strict TypeScript, Zod at every trust boundary, React function components.
- kebab-case for modules, PascalCase for components.
- No secrets in storage, messages, logs or URLs (see [credential-threat-model.md](credential-threat-model.md)).
- Follow the issue label workflow in [AGENTS.md](../AGENTS.md).

## Decision record

**ADR-001: panel calls the API directly; background owns OAuth renewal.** Streaming through the service worker would add a hop per frame and a second token holder. Renewal must be single flight across pages because refresh tokens rotate, so it lives in the background. The worker hands the current `Authorization` value only to this extension's own pages (sender id checked); card secrets never cross runtime messaging.

**ADR-002: credentials in `storage.session` by default.** Memory-only storage limits exposure; "remember" (opt-in, with a hint) uses `storage.local` for people who accept the trade-off.

**ADR-003: one versioned Extension API for both modes.** Self-hosted `/v1/extension` and Cloud `/api/extension/v1` share paths and bodies so there is one client and one set of schemas.
