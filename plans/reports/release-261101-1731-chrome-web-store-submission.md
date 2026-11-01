# Chrome Web Store submission: Dewee 0.1.0 (Standard)

Status: package uploaded as a draft (store item ID `fckahaihlmpbcldmlopffgmocflpnjha`); listing, privacy tab and
submit still to do by hand (Chrome does not let extensions script the Developer Dashboard).

Privacy policy URL: `https://github.com/nextlevelbuilder/dewee-chrome-ext/blob/main/docs/privacy-policy.md`
(live once [docs/privacy-policy.md](../../docs/privacy-policy.md) is on `main`).

## Package

- File: `.output-store/dewee-chrome-ext-0.1.0-chrome.zip` (603 kB, 34 entries), built from `main` at `68189ae` with `pnpm zip:store`.
- Gates on that commit: `pnpm lint`, `pnpm typecheck`, `pnpm test` (814 passed). CI on `main` is green.
- Manifest: MV3, version `0.1.0`, no `key`, no `debugger`, no `host_permissions` (only `optional_host_permissions`),
  CSP `script-src 'self'`. No source maps or env files in the zip.
- Permissions: `sidePanel`, `storage`, `identity`, `alarms`, `scripting`; optional hosts `https://*/*`,
  `http://localhost/*`, `http://127.0.0.1/*`.

## Store listing (English)

- **Name:** Dewee
- **Summary (≤132 chars):** Chat with your Dewee agents and Super Agent in a side panel, and answer credential requests without exposing secrets.
- **Category:** Productivity (Tools)
- **Language:** English (the UI also ships Vietnamese)
- **Description:**

  Dewee brings your Dewee agents into a Chrome side panel.

  - Chat with any agent in your workspace, with Super Agent pinned first. Replies stream live; you can stop, retry and
    pick up earlier conversations.
  - Connect to Dewee Cloud (sign in with your Dewee account) or to your own self-hosted Dewee Gateway with a personal,
    scoped API key.
  - Answer the cards agents send: secure credential forms, sign-in requests, choices and command previews. Secret values
    go straight to your Dewee server and are never stored by the extension.
  - Optional connected browser: let an agent you approve open and operate tabs on the sites you allow, for a limited
    time. You can pause, stop or revoke it at any time, and risky actions ask you first.
  - Optional "Ask Dewee" about text you select on a page.
  - Light and dark themes, English and Vietnamese, keyboard shortcut Alt+Shift+D.

  The extension needs a Dewee account or a Dewee Gateway.

## Privacy practices tab

- **Single purpose:** A side panel client for Dewee: chat with Dewee agents and respond to their requests, including
  agent-driven browsing on sites the user explicitly allows.
- **Permission justifications:**
  - `sidePanel`: the whole UI is a side panel opened from the toolbar button.
  - `storage`: connection profiles, settings and (in session storage by default) the connection credential.
  - `identity`: `launchWebAuthFlow` for the Dewee Cloud OAuth sign-in (Authorization Code + PKCE).
  - `alarms`: periodic refresh of the pending-request badge and token renewal in the MV3 service worker.
  - `scripting`: injects the bundled page script only (a) into tabs an approved agent opened on origins the user granted,
    to read an accessibility outline and perform click/type/scroll, and (b) for the opt-in "Ask Dewee" selection
    button. No remote code.
  - Host permissions (optional, requested at runtime per origin): the user's Dewee Gateway origin, the sites the user
    grants to the connected browser, and `https://*/*` only when the user turns on "Ask Dewee".
- **Remote code:** No.
- **Data usage (declare):** Authentication information (API key / OAuth tokens, sent only to the user's Dewee server);
  Website content (page outline and selected text, only on granted sites or on the user's request, sent to the user's
  Dewee server); Personal communications (chat messages with Dewee agents). Not sold, not used for unrelated purposes,
  not used for creditworthiness. Certify the three limited-use statements.
- **Privacy policy URL:** `https://github.com/nextlevelbuilder/dewee-chrome-ext/blob/main/docs/privacy-policy.md`.
  The general `https://dewee.sh/privacy` does not mention the extension.

## Assets still needed

- At least one screenshot 1280×800 (or 640×400): the chat panel, a credential card, the grant dialog.
- Small promo tile 440×280 (optional but recommended).
- Store icon 128×128: `public/icons/128.png`.

## After the first upload

The store ID is `fckahaihlmpbcldmlopffgmocflpnjha`. Before Cloud sign-in works for store users:

1. Dewee Cloud runtime env (`apps/dewee-app`, read by `extension-oauth-config.ts`; set in the deployment, not the repo),
   appended to the existing comma-separated values:
   - `DEWEE_EXTENSION_REDIRECT_URIS` += `https://fckahaihlmpbcldmlopffgmocflpnjha.chromiumapp.org/oauth2`
   - `DEWEE_EXTENSION_ORIGINS` += `chrome-extension://fckahaihlmpbcldmlopffgmocflpnjha`
2. Each self-hosted Gateway that store users connect to: add `chrome-extension://fckahaihlmpbcldmlopffgmocflpnjha` to
   `GOCLAW_ALLOWED_ORIGINS`.
Done on 1 November 2026:
- The Cloud allowlists were set as Worker secrets on `dewee-app`, with the store ID only. On `dewee-app-staging` they hold the dev ID `poicgajeapmbcilfbeobdfedibiffbbm` plus the store ID. A CORS preflight confirmed both.
- The store origin was added to `GOCLAW_ALLOWED_ORIGINS` on the production Gateway (`dewee.zuey.me`), with a backup made first. The staging Gateway has no allowlist, so it already accepts every origin and was left unchanged.

3. Tag `v0.1.0` so the GitHub release workflow publishes matching zips, and date the `CHANGELOG.md` entry.

## Open questions

- Which publisher account (individual or the Dewee group publisher) and visibility: Public, Unlisted, or Private?
- Privacy policy URL.
- Should Cloud redirect URIs be registered before the listing goes public, so the first users can sign in?
