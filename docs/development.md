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
| `E2E_DEWEE_CLI` (or `DEWEE_BIN`) | Optional path of the `dewee` CLI for the live connected browser checks: device and grant lists, cleanup of earlier test devices, and traces. |
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
pnpm build:advanced  # Advanced profile into .output-advanced/chrome-mv3
pnpm test:e2e     # builds both profiles into .output-e2e*/, then Playwright loads them
pnpm zip          # .output/dewee-chrome-ext-<version>-chrome.zip (keeps the pinned key, for sideloading)
pnpm zip:advanced # .output-advanced/… Advanced sideload zip (keeps the pinned key)
pnpm zip:store    # .output-store/… without `key`, for the Chrome Web Store (Standard only)
```

The Chrome Web Store rejects a manifest that carries `key` and assigns its own extension ID. Register that store ID's `chromiumapp.org` redirect URI and `chrome-extension://` origin next to the unpacked ones.

### Build profiles

`DEWEE_PROFILE` picks the profile at build time (`src/shared/build-profile.ts`): `standard` (default) or `advanced`. Advanced adds the `debugger` permission, names the extension "Dewee (Advanced)" and compiles in the CDP adapter (`src/browser/adapters/cdp/`); Standard bundles leave it out (`__DEWEE_ADVANCED__` is `false`, so the bundler drops it). Unit tests run as Standard. Both profiles share the pinned sideload key, so they have the same extension ID and only one of them can be installed in a Chrome profile at a time; remove one before loading the other. Advanced has no Chrome Web Store listing yet: `DEWEE_STORE=1` with the Advanced profile fails the build on purpose.

Chrome Web Store review notes for a future Advanced listing (`debugger` is a sensitive permission and needs a justification and in-depth review):

- Single purpose: the connected browser drives only tabs the agent opened, on sites the person allowed, after the person turned on Advanced mode in the side panel; Chrome's debugging bar shows while attached.
- Justification: the accessibility tree gives agents a more faithful page outline than DOM heuristics, `Input.dispatch*` produces the input sites expect, and `Page.captureScreenshot` gives the agent a viewport image; none of this is possible with `scripting` alone.
- Limits to state: fixed CDP method whitelist (no `Runtime.evaluate`, network, storage or cookies), tab targets only, attached only during a command, nothing stored.
- Policies: [Use of permissions](https://developer.chrome.com/docs/webstore/program-policies/permissions), [Privacy fields and permission justification](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [Limited use of user data](https://developer.chrome.com/docs/webstore/program-policies/limited-use), [`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger).

### Connected browser end-to-end

`tests/e2e/browser-control.spec.ts` needs no Dewee Gateway. Each test starts two loopback servers on random ports: `tests/e2e/support/browser-relay.ts` plays the Gateway (the `/ws` relay with `connect`, `browser.device.*`, `browser.grant.*` and the `browser.command` events, plus the small `/v1/extension` HTTP API the panel needs to sign in), and a page server serves a test shop page with a password field, a hidden input and a "Delete account" button. The person's side (enroll, allow, approve, Stop, revoke) runs through the real side panel; the relay sends commands and records acks, results and control states.

```bash
pnpm test:e2e -- tests/e2e/browser-control.spec.ts
```

Both servers close in `afterEach`. The relay's API key is a fixed test value, not a secret.

`tests/e2e/browser-control-advanced.spec.ts` runs the same setup on the Advanced build (`test.use({ buildProfile: 'advanced' })` in `tests/e2e/fixtures.ts`): the opt-in, AX snapshot redaction, click and type, the JPEG screenshot, same-site and cross-site frames, attach and detach as Chrome reports them, revoke and opt-in off mid-action, and a debugger conflict. The conflict is simulated by attaching `chrome.debugger` to the agent tab from the service worker first; Chrome allows one client per extension per tab, so the adapter's attach fails as it does when DevTools holds the tab (real DevTools cannot be opened from Playwright).

```bash
pnpm build:e2e:advanced
pnpm exec playwright test tests/e2e/browser-control-advanced.spec.ts
pnpm bench:browser   # Standard vs Advanced snapshot/click latency (DEWEE_BENCH_ROUNDS, default 20)
```

### Live end-to-end

The `tests/e2e/live-*.spec.ts` specs drive the built extension against a real local Dewee Gateway: connect, agents, chat, stop, key revocation, reopening the panel, reconciling a lost response (`live-selfhosted`), stream resilience (`live-resilience`), credential cards and admin policy (`live-credentials`), the connected browser driven by the agent's `browser` tool with the workspace feature flag, grants, approval, revoke and Stop (`live-connected-browser`), and Cloud sign-in through a local Dewee app (`live-cloud`). Each is skipped unless its environment is set (shell or `.env`). The model is the deterministic stub `tests/e2e/support/stub-llm.mjs`; `tests/e2e/support/setup-live-gateway.mjs` creates the tenant, agents and personal key and writes them to `.env`. Steps: [tests/e2e/support/live-gateway.md](../tests/e2e/support/live-gateway.md).

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
