# Re-review: Dewee Chrome MV3 extension (after review fixes)

Scope: every finding in code-reviewer-261011-1910-extension-review.md, the claimed fixes, and regressions in src/**, wxt.config.ts, scripts/zip-store.mjs, .github/workflows/*, tests/unit + tests/integration.
Method: I read the code. Contract claims were checked against the Dewee Go source (`dewee/internal/http/sessions.go`).
Gates: NOT run. The Bash tool fails before it executes anything ("unexpected EOF"), so lint, typecheck and vitest are unverified.

## Old findings

| ID | Status | Evidence |
|---|---|---|
| B1 | Closed (no test) | ChatShell.tsx:54-55 memoizes on `profileId/kind/origin`. use-chat.ts:121-125 returns early when the session key is adopted back. Gap: no test mounts ChatShell or round-trips `onSessionKey` through settings. The tests stub `onSessionKey` with `vi.fn()`, so the props-change path is never exercised (see NEW-1). |
| S1 | Partially closed | The proactive path is fixed: client-factory.ts:17-20 keeps status 0, and tests cover it. Still open: on a server 401, dewee-client.ts:170 calls `auth.renew()`. That returns `false` on *any* worker failure, including `{ok:false,status:0}` from a network error during refresh (client-factory.ts:22-24). Line 173 then throws the original 401, and App.tsx:36 clears the credential without a revoke. Scenario: clock skew, or a server-side early expiry, triggers a 401, and Wi-Fi drops during the refresh. The user is signed out locally and the refresh family is left alive. |
| S2 | Closed | token-manager.ts:35-36 re-reads the credential inside the single-flight task and returns it unchanged if the refresh token rotated. Test at token-manager.test.ts:79. Residual (inherent, not a regression): if the worker is suspended after the server rotated but before `writeCredential`, R1 is replayed. |
| S3 | **Open** (not in the fix list) | schemas.ts:64-66 still accepts only string `cursor`/`next_cursor`. Dewee's follow log emits integers (`sessions.go:220-222`, `Cursor int`, `NextCursor int`, `Total int`). If the `/v1/extension` adapter reuses it (no adapter exists yet: grep for `/v1/extension` in dewee/internal finds nothing), then the new length probe (history.ts:20) and every page fail Zod with `invalid_response`, and no conversation loads. The response also carries `total`, so the extra probe request is unnecessary. docs/api-contract.md:85 still shows strings. |
| S4 | Closed | history.ts:28 starts at `max(0, total-1000)`. The page cap is 7. Tests cover the long-log, shrink and no-length cases. |
| S5 | Closed | use-chat.ts:229-244 queues the continuation and drains it on idle and on `streamsEnded`. `agent_key` is passed through (line 237). Double-fire analysis: if the effect runs while `streamRef` is still set, it re-queues. Once `runStream` sets `streamRef` synchronously and `pending` is null, a second run is a no-op. The epoch reset clears `pending` (line 130). Test at use-chat.test.tsx:160. |
| S6 | Partially closed | The happy path works and has a test. See NEW-1 and NEW-2 for the gaps. |
| S7 | Closed | MessageList.tsx:102-105 has a retry for `loadError`, wired to `chat.reload`. |
| S8 | Closed | The release `build` job has `persist-credentials: false` and a read-only token (release.yml:7-18). `contents: write` is only in the `publish` job, which neither checks out nor installs. The store build drops `key` (wxt.config.ts:8,19; zip-store.mjs:4) into `.output-store`, renamed `-store.zip`. |
| S9 | Closed | origin.ts:9 accepts only `localhost`/`127.0.0.1`, which matches wxt.config.ts:25. |
| N1 | Closed | SessionList.tsx:63 gates the button with `canLoadMore`. |
| N2 | Closed | ChatShell.tsx:148. |
| N3 | Closed | chat-state.ts:198-205 `idle` clears `streaming`. |
| N4 | Closed | use-chat.ts:156 checks `streamRef.current`. |
| N5 | Closed | Documented as ADR-001 in docs/development.md:68. |
| N6 | Partially closed | CredentialsForm.tsx:27 prefers typed ids but still falls back to agent-supplied `target.name`. |
| N7 | Closed | i18n.ts:86-89 (`conflict`, `profile_not_found`, `background_unavailable`, plus vi copy). |
| N8 | Closed | connect.ts:46-52 clears the credential when `saveProfile` fails. |
| N9 | Partially closed | settings.ts:63-77 serializes writes **per JS context** only. The panel and the options page each have their own `writes` chain, so a theme change in options racing a session write in the panel can still lose one update. Low impact. |
| Retry-after | Closed | use-chat.ts:210 → chat-state.ts:191 → MessageList.tsx:21 `errorText(..., retryAfterSeconds)`. |
| App onAuthError | Closed | App.tsx:32 is a plain function. Each consumer either reads it through a ref (use-chat) or captures a closure for the same profile (use-directory, ChatShell `key={profile.id}`), so a stale closure is harmless. |

## New findings

### Blocking
None.

### Should-fix

**NEW-1. Stop before `chat.started` in a new chat resets the conversation and leaks a stale `runId`** (use-chat.ts:176-188)
- Line 178 calls `onSessionKey`, and that starts an async `update()`. Line 183 then `await`s the network `abortOnServer` *before* line 188 dispatches `chat.started`.
- The storage write usually finishes first. ChatShell re-renders with `ctx.sessionKey = S`, and the layout effect overwrites `stateRef.current` with reducer state that has no `sessionKey` yet, undoing the mutation at line 177.
- The scope effect at line 125 then sees `S !== undefined` and runs a full reset: epoch bump, stream aborted, `loadSession`. The "Stopped" bubble and the local user message are replaced by history.
- After the await, line 188 dispatches `chat.started` into the *new* conversation with no `isCurrent` check, so `runId = r_old` is stored. If the status poll says the run is not running, nothing clears it: `history` and `send` keep `runId`.
- Next turn: the user presses Stop before the new `chat.started`. `stop()` (line 248) sees a `runId`, so it calls `abort(S, r_old)` and aborts the fetch locally. The new run keeps going on the server, which is exactly the orphan S6 was meant to prevent.
- The integration test misses this because `onSessionKey` is a spy and never changes props.
- Fix: dispatch the event before handling the stop request, re-check `isCurrent(epoch)` after the await, and clear `runId` in the `send` reducer case. Add a test whose `onSessionKey` re-renders with the new session key.

**NEW-2. Stop waits for a `run_id` that may never come, so the server run is never aborted** (use-chat.ts:248)
- The deferral is keyed on `!runId`, but `runId` is optional (chat-events.ts:60,140).
- If the Gateway sends `chat.started` without `run_id`, the event has already been consumed. `stop()` sets `stopRequestedRef` and waits for a second `chat.started` that never arrives, and after 5 s it aborts only locally.
- The same applies to an existing session (where `sessionKey` is already known) while `chat.started` is late: the fallback at lines 253-258 never calls `abortOnServer(sessionKey)`.
- Fix: track "started seen" in a ref, defer only until then, and in the timeout call `abortOnServer` whenever a session key exists.

### Nit
- **NEW-3** use-chat.ts:241-244, 261-262. A card answered mid-stream and then Stop: the stopped stream ends (`chat.stopped` → idle, `streamsEnded++`), and the queued continuation starts a new run immediately after the user pressed Stop. Decide the intended behavior. If Stop should hold it, clear `pendingContinuationRef` in `stop()` and offer a "Continue" action.
- **NEW-4** use-chat.ts:209. A continuation that fails without a reconcile (for example a 429 right after the queue drains) has `retryText` undefined, so there is no retry button. The setup action has already been consumed, and the agent never resumes. Offer a "Continue" retry that carries `setup_action_id`.
- **NEW-5** ChatShell.tsx:122. The lost-response replay builds the continuation with the *current* `agentKey`, not the card's agent. Low risk while cards share the session agent.

## Hard rules (verified)
- **Secrets:** No `console`, `localStorage`, `storage.sync`, `eval`, `new Function`, `executeScript` or `tabs.` in src. Secret values stay in CredentialsForm local state, are cleared before the await (CredentialsForm.tsx:54), and go only to `respond`. The respond retry path never re-sends the body. Credentials live in `storage.session`, or `storage.local` only with the opt-in.
- **No master token:** the gateway flow verifies the key with `/me` and requires `auth.mode === 'api_key'` (connect.ts:44).
- **No agent HTML:** the only `dangerouslySetInnerHTML` is MessageList.tsx:13, which goes through `renderMarkdown` (DOMPurify).
- **Extension policy:** CSP is `script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'`. There is no content script, and no `tabs`/`scripting`/`activeTab`. Host access is requested per origin through `optional_host_permissions`; `host_permissions` exist only in the e2e build.
- **Release token:** passes, as described under S8.

## Recommended actions
1. Fix NEW-1 and NEW-2, and add a test that re-renders with the adopted session key during a Stop.
2. S1: make `renew()` throw a status-0 error on transport failure, or stop clearing the credential in App and let the worker own clearing.
3. S3: accept `int | string` cursors, use `total` instead of the probe, and pin the JSON type in api-contract.md together with the Dewee adapter issue.
4. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. This review could not.

## Unresolved questions
1. Will the `/v1/extension` history adapter emit integer cursors and `total`? This decides S3.
2. Should a continuation queued before Stop still run? (NEW-3)

Status: DONE_WITH_CONCERNS
Summary: 14 of 20 prior items are closed. S1, S6, N6 and N9 are partially closed and S3 remains open. Two new Stop-path races in use-chat.ts can still orphan a server run (NEW-1 also leaks a stale runId). No blocking issues and no hard-rule violations.
Concerns/Blockers: The shell does not work, so no gates were run. S3 depends on the unbuilt Dewee adapter.
