# Code review: Dewee Chrome MV3 extension (bootstrap)

Scope: src/**, wxt.config.ts, scripts/*, .github/workflows/*, docs/* (tests/e2e/live-* and tests/e2e/support/* excluded).
Method: full read of every src file against AGENTS.md + the four docs; upstream Dewee Go source checked for contract types.
Gates: NOT run. The Bash tool fails on every command in this session and no PowerShell tool was exposed, so lint/typecheck/vitest results are unverified.

## Blocking

### B1. Every settings write tears down the chat: the first reply of a new chat is never streamed
- `src/sidepanel/App.tsx:29` derives `profile = activeProfile(settings)`; `loadSettings()` re-parses storage, so every `update()` and every `storage.onChanged` refresh yields a new `profile` object.
- `src/sidepanel/ChatShell.tsx:49` `useMemo(() => createClient(...), [profile])` then builds a new `DeweeClient` on every settings change.
- Effects: (a) `use-directory.ts:39,60` keys requests on `client`, so workspaces/agents go back to `data: null, loading: true`; `workspaceId` becomes undefined; `useChat(null)` runs. (b) `use-chat.ts:116` `sameScope` compares `scope.client === ctx.client`, so it is false. Either way the effect bumps the epoch, aborts `streamRef`, and resets state.
- Concrete failure: user sends the first message in a new chat. `chat.started` calls `onSessionKey` → `setSession` → `update()` (ChatShell.tsx:79). The settings change creates a new client, the live stream is aborted locally (AbortError swallowed by the epoch check), the panel flashes skeletons, and the reply only shows up later through reconcile/history. The same thing happens on every theme/language change in the options page, on the initial `withSelectedWorkspace` write (ChatShell.tsx:63), and on every agent/session switch. Each of those also re-fetches workspaces and agents.
- Not covered: no test mounts ChatShell, and e2e smoke has no chat flow.
- Fix: memoize on primitives, e.g. `useMemo(() => createClient(...), [profile.id, profile.kind, profile.origin])`, and add an integration test that a settings write during a stream does not abort it.

## Should-fix

### S1. Any background failure becomes a 401 and wipes the credential (local sign-out without revoke)
- `src/api/client-factory.ts:16` maps every `{ ok: false }` from the worker to `DeweeApiError(401, …)`. That includes `network_error`, `runtime_unavailable` and `timeout` from a proactive refresh (token-manager.ts:54, within 60 s of expiry), and `background_unavailable`/`no_response` from messaging.
- `App.tsx:36` `onAuthError` then runs `clearCredential`.
- Scenario: Wi-Fi blips while the access token is near expiry. The panel signs out and drops the refresh token without revoking it. This contradicts token-manager.ts:35 ("network errors do not end the session") and the contract (sign out only after a rejected refresh).
- Fix: keep the real status (use status 0 for transport/background failures). Clear only on `token_revoked`/`not_connected`/`api_key_rejected`, or let the worker own clearing.

### S2. Single-flight refresh can still replay a rotated refresh token (family revoked)
- `src/background/token-manager.ts:51-54`: `authorizationFor` reads the credential, then awaits `profileOf()`, then calls `renew(…, credential.refreshToken)`. If the in-flight task finishes (write + `inflight.delete`) inside that gap, this caller starts a new refresh with the stale R1. The server sees reuse and revokes the family.
- `credential-store.ts:38-40` widens the window: with `remember`, the code writes local before it removes session, and `readCredential` prefers session, so a concurrent reader gets the old token.
- Likely trigger: at expiry, the panel fires about 6 parallel calls (workspaces, agents, sessions, history, status, actions) plus the badge alarm.
- Fix: check `inflight` before reading. Inside the locked task, re-read the credential and skip the network refresh if its `refreshToken` already differs from the one the caller saw (or if `accessExpiresAt` is fresh). Remove the stale area before writing the new one, or write session first.

### S3. History cursor type does not match the Gateway follow log
- `api/schemas.ts:64-66` accepts only string `cursor`/`next_cursor`, and `chat/history.ts:19` sends `cursor: String(n)`.
- Dewee's existing follow-log handlers use integers: `dewee/internal/http/provisioning_chat_history.go:24,38-39` (`Cursor *int`, `NextCursor int`) and `sessions.go:221`.
- If the `/v1/extension` adapter reuses `newSessionHistoryFollowResponse`, two things break: every history call returns 400 (`"0"` into `*int`), and every response fails Zod with `invalid_response`. No conversation would load.
- The unit tests use strings, so they cannot catch this.
- Fix: accept `z.union([z.number().int(), z.string()])`, send a number, and state the JSON type in docs/api-contract.md.

### S4. Sessions longer than 5,000 messages show a stale middle window, not the newest messages
- `chat/history.ts:9-10,18`: `MAX_PAGES = 25` × 200. When the loop stops at the page cap, `messages.slice(-1000)` holds positions 4000–4999, not the tail.
- Opening a long session also costs up to 25 sequential POSTs, and the reconcile path (`use-chat.ts:104`) repeats them.
- Fix: start the follow at `max(0, total - MAX_KEPT_MESSAGES)` (the Gateway returns `total`; add it to the schema), or drop the page cap.

### S5. A card continuation is silently dropped while a run is streaming or reconciling
- `ChatShell.tsx:103` calls `chat.continueWith(result.continuation)`, but `use-chat.ts:133` returns early when the phase is `streaming` or `reconciling`.
- Cards arrive in `tool.call.completed` mid-stream, so the person can submit before `message.completed`. The respond succeeds, the continuation is never sent, and the agent never resumes. Nothing tells the user.
- Fix: queue the continuation and send it when the phase returns to idle, or show a "Continue" action.
- Related: `continueWith` ignores `continuation.agent_key` and uses the current agent (use-chat.ts:145). Pass it through.

### S6. Stop before `chat.started` leaves an orphan server run
- `use-chat.ts:202-212`: in a new chat there is no `sessionKey` yet, so no `chat/abort` is sent and only the fetch is aborted.
- The server may already have accepted the turn. The run keeps going, and it can execute tool and setup actions, in a session the panel never learns about. The UI shows "Stopped".
- Fix: if Stop is pressed before `chat.started`, keep reading until `chat.started` arrives (or a short timeout), then call abort with the returned session and run.

### S7. `loadFailed` has no recovery path; `reload()` is dead code
- `MessageList.tsx:100` shows "Could not load this conversation" with no retry button. `useChat().reload` (use-chat.ts:217) is never used.
- The user can only recover by switching session or agent. Wire `chat.reload` to a retry button.

### S8. Release workflow hardening and a store-incompatible manifest
- `.github/workflows/release.yml`: the job runs with `contents: write`. `actions/checkout` keeps the token in `.git/config` by default, and `pnpm install` runs dependency `postinstall` scripts, which can read it. Fix: set `persist-credentials: false` on checkout, and move `contents: write` to a separate publish job (or step) that does not install dependencies.
- The release job skips e2e, and the zip is built after the tag check without `pnpm build` gating. That is acceptable, but CI on the tag commit is not enforced.
- `wxt.config.ts:17` always sets `manifest.key`, and the release zip is labelled "store-ready". As far as I know, the Chrome Web Store rejects uploads whose manifest has a `key` field. Please confirm. Fix: drop `key` unless building dev/e2e.

### S9. The origin check accepts loopback hosts the manifest cannot grant
- `shared/origin.ts:8,11` accepts `http://[::1]` and `http://*.localhost`.
- `wxt.config.ts:23` `optional_host_permissions` only lists `http://localhost/*` and `http://127.0.0.1/*`. `permissions.request` rejects these hosts, and the user sees a misleading "Chrome did not grant access".
- Fix: add `http://[::1]/*` (and `http://*.localhost/*` if wanted) to the manifest, or narrow the check.

## Nits
- N1 `SessionList.tsx:60` + `ChatShell.tsx:258`: the limit is capped at 50, but "Show more" still renders when `total > 50` and then does nothing. Use `offset` paging or hide the button.
- N2 `ChatShell.tsx:139-141`: Alt+N starts a new chat while streaming, even though the "New chat" button is disabled when `busy`. Apply the same guard to the shortcut.
- N3 `use-chat.ts:89-91`: if the stream closes without a terminal frame before `chat.started` (no session yet), the phase goes idle but the assistant bubble keeps `streaming: true`, so the typing indicator stays on forever.
- N4 `use-chat.ts:133`: the re-entrancy guard reads `stateRef`, which only updates after commit. Prefer `if (streamRef.current) return;` so a double invocation in the same tick cannot send twice. The Composer currently prevents this, but the hook should not rely on it.
- N5 AGENTS.md and architecture.md say secrets never cross runtime messaging, but `auth.authorization` returns the bearer API key/access token to pages over `runtime.sendMessage` (service-worker.ts:20). This is low risk because the sender id is checked and only own pages can call it, but either document the exception or let pages read `storage.session` directly and keep only renewal in the worker.
- N6 `CredentialsForm.tsx:26`: the destination label interpolates agent-supplied `target.name` (≤100 chars). This partly undermines "labels come from extension copy". Consider showing only the type plus `provider_type`.
- N7 `i18n.ts`: en/vi parity is enforced by `Record<MessageKey,string>`, which is good. Client codes `conflict`, `profile_not_found`, `background_unavailable`, `oauth_invalid_redirect`, `oauth_missing_code`, `oauth_access_denied` and `internal_error` fall back to "Something went wrong (code)". Add copy, at least for `conflict` (409 is a documented path).
- N8 `connect.ts:45-46`: `connectGateway` writes the credential before `saveProfile`. If `saveSettings` throws (schema parse), an orphan credential stays in storage. Write the profile first, or clear the credential on failure.
- N9 `settings.ts:64` `updateSettings` is a non-atomic read-modify-write shared by the panel, the options page and the worker. Concurrent writes (options theme change plus panel session write) can lose an update. This is low impact, but worth a single serialized writer.

## Verified OK (risk calibration)
- No `console`, `eval`, `innerHTML`, `localStorage` or `storage.sync` in src. CSP is `script-src 'self'`. There is no content script, no `tabs`/`scripting`/`activeTab`, and no `<all_urls>`. Host access is requested per origin inside the click handler before any await.
- Requests use `credentials: 'omit'`, `redirect: 'error'` and `no-store`. HTTPS is enforced except on loopback. URLs with userinfo are rejected.
- PKCE S256 uses a 32-byte verifier. `state` is compared in constant time, and the redirect origin/path is checked before reading `code`. Revoke is best effort and the credential is always cleared.
- Every response, SSE frame and card is Zod-validated. Card envelopes are strict, unknown kinds are dropped, and `target.url` is refused. Card text renders as plain text. Markdown goes through marked → DOMPurify with an allowlist; images are dropped; only http(s)/mailto links survive, with `noopener noreferrer nofollow`.
- Secret values stay in CredentialsForm local state, are cleared before the await, are sent only to `/respond`, and do not appear in `chat-state`.
- The worker rejects foreign `sender.id` and Zod-validates messages.
- A 409 on stream or respond triggers a reload or reconcile, never a re-send. Reopening the panel loads history, status and cards without sending anything.

## Unresolved questions
1. Will the `/v1/extension` history adapter emit integer cursors, as the existing Gateway follow log does? This decides S3.
2. Should the store build carry `key`, or is it dev/e2e only? (S8)

Status: DONE_WITH_CONCERNS
Summary: One blocking defect (settings writes rebuild the client and abort or reset live chats, including the first reply of every new chat), plus 9 should-fix issues around auth error mapping, a refresh-token replay race, history contract and paging, dropped continuations, and release hardening.
Concerns/Blockers: Bash was broken and no PowerShell tool was available, so pnpm lint/typecheck/test were not run. All findings come from reading the code.
