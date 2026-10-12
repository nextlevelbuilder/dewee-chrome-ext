# dewee-web: Chrome extension user guide (EN + VI)

Worktree: `D:/www/nextlevelbuilder/worktrees/dewee-web-chrome-extension` (branch `docs/chrome-extension-guide`). Not committed.

## Files changed

- Added `src/content/docs/en/integrations/chrome-extension.md`: title "Chrome extension", order 4, updated 2026-10-11.
- Added `src/content/docs/vi/integrations/chrome-extension.md`: title "Extension cho Chrome", the same structure, and the UI labels from the extension's `vi` catalog.
- Changed `src/content/pages/docs.ts`: the Integrations section blurb (EN and VI) now mentions the Chrome extension.

The sidebar is built from the content collection by `section` and `order`, so there is no list to register the pages in. `src/content/pages/integrations.ts` only links to website-chat, and I left it alone. No test or index lists the integrations pages.

## Where each claim comes from (extension worktree unless noted)

- Install, Chrome 116+, `Alt+Shift+D`, and the extension id: `wxt.config.ts`, `README.md`, `docs/development.md`.
- Connect flow, labels, HTTPS/loopback rule, "Remember" hint: `src/shared/ConnectForm.tsx`, `connect.ts`, `origin.ts`, `i18n.ts`, and `optional_host_permissions`.
- The key command, `owner_binding_required` / `scope_required`, and `GOCLAW_ALLOWED_ORIGINS`: gateway `docs/20-api-keys-auth.md` "Browser Extension Keys" and `docs/18-http-api.md` §38.
- Chat: Super Agent pinned, search, conversations, stop, "Send again", reconcile behaviour, shortcuts: `AgentPicker.tsx`, `ChatShell.tsx`, `MessageList.tsx`, `use-chat.ts`.
- Cards: secret and OAuth flow, rotate step, owner/admin gate, reference-only result, badge: `CredentialsForm.tsx`, `ActionCard.tsx`, `pending-badge.ts`, `docs/credential-threat-model.md`.
- Sign out and remove behaviour: `src/shared/connect.ts`, `background/token-manager.ts`. Only Cloud tokens are revoked on the server, so the page tells self-hosted users to revoke their API key on the gateway.
- `credential_request`: marked as needing a gateway version that includes it, with the policy managed through the gateway API. I did not include CLI syntax.
- Troubleshooting rows quote i18n strings word for word. The CORS-to-"Cannot reach the server" mapping holds because `dewee-client.ts` turns a failed fetch into `network_error`.

## Commands (run by a helper agent with PowerShell, because Bash is broken here)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0; node_modules was missing before |
| `pnpm check` | exit 0; 0 errors, 0 warnings, 1 hint in an unrelated file |
| `pnpm test` | exit 0; 33 files, 416 tests passed |
| `pnpm build` | exit 0; built `/docs/integrations/chrome-extension` and `/vi/docs/integrations/chrome-extension`, with Markdown twins and OG images |
| Sidebar check | the built website-chat pages link to the chrome-extension page in each locale |
| Frontmatter lengths | EN description 157, VI description 153 (allowed 140–160); titles 16 and 20 |
| Cleanup | removed `dist` and `.astro` (created by the build); kept `node_modules` |

## Open points

- The Releases page has no release yet, so the page says "download the zip attached to a release, or build from source".
- The threat-model links point to `blob/main/docs/...`. They return 404 until the extension bootstrap branch is merged into `main`.
- Server side: the gateway `/v1/extension` routes are still on a feature branch, and the Cloud BFF/OAuth is "Missing" in `docs/api-contract.md`. The page's NOTE says a matching server is required, but publishing should wait until both are deployed.
