# Architecture

The extension is a thin Chrome MV3 client. Dewee (Gateway, or the CCP app for Dewee Cloud) owns agents, sessions, runs, permissions, card state and the credential store. The extension renders what the server returns and sends what the person types; it never decides permissions and never stores secrets.

## Runtime pieces

```text
┌──────────────── Chrome ────────────────┐
│ Side panel (React)                      │        ┌──────────────────────────┐
│  App → ChatShell → MessageList/Composer │ fetch  │ Self-hosted Gateway      │
│  use-chat ── DeweeClient ───────────────┼───────►│ {gw}/v1/extension/*      │
│  CredentialsForm (secret in local state)│        └──────────────────────────┘
│        │ runtime msgs (no card secrets) │        ┌──────────────────────────┐
│        ▼                                │ fetch  │ Dewee Cloud (CCP BFF)    │
│ Background service worker               ├───────►│ {cloud}/api/extension/v1 │
│  token-manager (OAuth refresh, revoke)  │        │ /oauth/extension/*       │
│  pending-badge (chrome.alarms, 1 min)   │        └──────────────────────────┘
│ Options page (profiles, theme, language)│
└─────────────────────────────────────────┘
```

| Module | Responsibility |
|---|---|
| `src/api/dewee-client.ts` | One typed client for both modes: JSON calls, SSE `chat/stream` with idle-stall detection, 401 → one renew and retry, `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`. |
| `src/api/schemas.ts`, `src/protocol/*` | Zod schemas for every response, SSE frame, `dewee.ui-action.v1` card and background message. Unknown or invalid cards are dropped, never rendered. |
| `src/auth/credential-store.ts` | Credential per profile in `storage.session` (default) or `storage.local` (only when the person ticks "remember"). |
| `src/auth/cloud-oauth.ts`, `src/auth/pkce.ts` | Authorization Code + PKCE S256 through `chrome.identity.launchWebAuthFlow`. |
| `src/background/token-manager.ts` | Owns Cloud token renewal (single flight so a rotated refresh token is never replayed), sign in, sign out with revoke. |
| `src/background/pending-badge.ts` | Counts open cards for the active workspace and shows the number on the action badge. |
| `src/chat/use-chat.ts`, `chat-state.ts` | Chat engine: stream, stop, history paging, reconcile after a lost stream, card continuations. |
| `src/credentials/*` | Card rendering, the secure credentials form, labels from the extension's own copy. |
| `src/shared/settings.ts` | Non-secret settings: profiles, selections (profile → workspace → agent → session), theme, language, opt-in features. |
| `src/browser/*` | Connected browser (off by default, self-hosted only): relay transport, local policy guard, owned-tab registry, executor and the bundled page runtime. See [Connected browser](#connected-browser). |
| `src/sidepanel/browser/*` | "Browser control" drawer, approval cards and the live activity strip with Pause / Resume / Stop. |

## Data flows

**Self-hosted connect.** The options page or the panel asks for host permission for exactly the gateway origin, calls `GET /me` with the API key, and only then stores the profile and credential.

**Cloud connect.** The panel stores the profile, asks the background to run the OAuth flow, then calls `GET /me`. A failed first sign-in removes the new profile.

**Chat.** `use-chat` posts `chat/stream`. `chat.started` gives the session key, which is remembered per workspace and agent. The panel never re-sends a message by itself, and it offers "Send again" only when the server provably did not receive the message: (a) the panel failed before calling fetch (background or credentials unavailable), (b) the fetch was rejected while `navigator.onLine` was false, or (c) the server refused the turn with an explicit 4xx before accepting it (validation, auth, rate limit, or a busy 409 such as `run_in_progress`). Every other failure is uncertain: a 5xx (including a proxy's 502, 503 or 504), a stall, a drop after the response, a fetch rejected while online, a decoder fault (including `protocol_error`: the stream parser holds at most 1 Mi characters for the current line and event, and stops the stream past that, after delivering the frames that were already complete), a history read that failed, or a turn not found after a reconcile. An uncertain turn stays visible once, marked `delivery_unconfirmed`, with "Reload conversation" (or "Show conversations" in a new chat, which has no session to check). It never gets "Send again"; the text stays on screen, so the person can copy it and send it again by hand. After an uncertain failure in a known session, or a break after the server answered (200, any frame or `chat.started`), the engine polls run status and reloads history; polling pauses while the browser is offline, slows down after about 3 minutes and keeps the composer closed until the run ends. Only one reconcile runs per conversation, and a switch, unmount or newer reconcile retires the old one. An unconfirmed turn is dropped only when the history provably holds it: the message that was last at send time (its `m<position>` id, role and text) is still in place, and a user turn with the same text follows it (past the turns confirmed by `chat.started` since). After compaction, renumbered ids, or a highest position below the send-time one, the anchor is gone and the turn stays unconfirmed. A history that cannot be read (including one that keeps shrinking while it is read) is never treated as empty: the transcript stays and the turn stays unconfirmed. Unconfirmed turns survive later history reloads and new sends, and every reconcile or reload checks them again. Residual risks: the offline check is a heuristic, so if the connection drops after the request bytes left, `onLine` can already be false and "Send again" may start a second run; and an identical text sent again after the anchor can make a lost repeat look delivered. Stop calls `chat/abort` and aborts the fetch; pressed before `chat.started` names the run, the abort is sent as soon as it does (or the fetch is dropped after 5 s).

**Cards.** `ui_action` frames and `GET /actions?status=pending` feed the card list. A response goes to `POST /actions/{id}/respond`. If the response is lost (network error or 409) the panel reloads the card. A resolved card's `continuation` is queued for its session, tagged with the profile and workspace captured when the respond call started (a switch during the call does not re-tag it). Queued continuations are sent one at a time once their own session is shown and idle, so two cards answered during a reply both continue after it, and a continuation never streams into another conversation. The queue lives in `storage.session` with one key per item (profile, workspace and setup action; the value holds only those IDs plus session and agent, a `held` flag and the time of the first in-progress answer, never a secret). Adding or removing an item writes only that key, so panels in two windows never remove each other's items, and each panel follows `storage.onChanged` to see what another panel added or delivered. A session or agent switch or a closed panel does not lose an item; reopening the session sends what is pending. Both behave the same while a continuation streams: the stream is dropped without holding the item (this is not a Stop), so it is sent again when its session is shown, here or in a reopened panel, and the Gateway answers `continuation_sent` if it was delivered meanwhile. Unlike user messages, continuations are sent automatically, because the Gateway delivers each at most once. An item leaves the queue only when the agent provably got it: a `message.completed` frame, a 409 `continuation_sent` (already delivered; a silent success that reloads the conversation, with no error bubble), or a `chat.error` with code `setup_result_delivered` (the result reached the agent's session but the run failed; its message is shown and the person continues in the chat). Earlier frames such as `chat.started` are not proof: if the run fails before the result is saved (provider error, rate limit, exhausted credit), the Gateway releases the send lease. It also leaves when it can never succeed (400, 404 or 410, or a 403 other than a key problem: the card or continuation is invalid, gone or not allowed); the panel then says once, with no "Continue", that the card's result could not be delivered and the person should ask the agent again in chat (`continuation_refused`), and logs a `console.warn` with the status and code only (a 400 is a client bug). A 403 `scope_required` or `owner_binding_required` can be fixed by the person, so that item is held with "Continue" and the key error. A 409 `continuation_in_progress` means another request holds a live send lease that may still fail and release, so it is not delivery: the item stays and is sent again after the server's `Retry-After` hint (5 s without one), then 15 s, 30 s and every 60 s, only while its session is shown and idle, for about 11 minutes after the first such answer (a lease goes stale after 10 minutes; the start is stored with the item, so reopening a panel does not restart the window); then it shows "Continue". Any other outcome keeps the item, held, and shows "Continue": any other `chat.error`, `chat.stopped` or Stop, a stream that closes without a terminal frame or drops after the response (the reconcile offers "Continue" once the run ends), and any other refusal, including an unknown 409 code. Resending is safe: the Gateway answers `continuation_sent` if it was delivered and `continuation_in_progress` while a run holds the lease. A held item is stored with a `held` flag, so it is not sent automatically again, neither after a conversation switch nor in a reopened panel; when its session is shown, it offers "Continue". The stored flag wins in every panel: a held copy stored by another panel stops this panel's automatic retries, and an unheld copy (another panel pressed "Continue") releases the item here and removes this panel's "Continue". When another panel delivers the item, its "Continue" here goes away too, and a click on a stale one does nothing. Remaining limit: a held item (including one past the in-progress retry window) stays in `storage.session` until the person presses "Continue" or the browser restarts.

**Restart.** Reopening the panel or a service worker restart loads history, run status and pending cards for the remembered session. A user message is never sent automatically. Only pending card continuations are sent automatically (see Cards), because the Gateway delivers each at most once.

## Connected browser

Dewee agents the person allows can drive tabs in this browser, also when they were asked from another channel (Telegram, the web UI). The wire contract is [connected-browser-relay-contract.md](connected-browser-relay-contract.md); the security reasoning is [browser-control-threat-model.md](browser-control-threat-model.md).

```text
Gateway ──/ws──► service worker
                  transport.ts      connect (personal API key), heartbeat 20 s, backoff 1–30 s
                  session.ts        enroll/attach, grants, Pause/Stop, panel port, profile switch
                  command-runner.ts validate → ack → execute → exactly one result; dedupe, cancel, deadline
                  executor.ts       policy re-check before every side effect, then the action
                  policy.ts         grant, agent, capability, exact origin, restricted pages, owned tab, host permission
                  tabs.ts           owned tabs t1, t2…, generation per document, single writer, user-input hold
                  chrome-api.ts ──► chrome.tabs + chrome.scripting.executeScript({ func: pageRun, args })
                                     snapshot.ts (bundled page runtime, isolated world)
side panel ◄─port "browser-control"─ state, approval cards; Pause/Resume/Stop, enroll, grants
```

- **Lifecycle.** The socket exists only while the "Connected browser" preference is on, the active profile is a self-hosted Gateway and it holds an API key. A profile switch, sign-out or turning the preference off closes it, cancels running commands, denies open approvals and forgets grants and owned tabs. Dewee Cloud shows "not available yet" and opens nothing. A one-minute `chrome.alarms` alarm revives a suspended worker, which reconnects and re-attaches with the stored device id; the 20 s heartbeat keeps it alive while connected (Chrome 116+).
- **Stored.** `storage.local`: the server-generated device id and name, the ids of grants created here and the person's last Pause/Stop/Resume, per profile (not secrets; `storage.local` stays locked to trusted contexts), so Pause/Stop survives a Chrome restart and a profile switch. `storage.session`: owned-tab handles, so a worker restart keeps them. Never stored: the API key outside the credential store, page content, snapshots, typed text, screenshots.
- **Commands.** Each `browser.command` is validated strictly (unknown keys, actions or keys for `press` are refused), acknowledged, executed and answered with exactly one result. A command id is executed at most once. Results are never queued across a reconnect: a dropped link cancels the commands it carried. An interrupted command that may already have changed the page reports `outcome_unknown`.
- **Pages.** Only `chrome.tabs` and `chrome.scripting.executeScript` with the bundled `pageRun` function (func + args, never a code string), top frame only. Same-origin iframes are read only when their origin is granted; cross-origin iframes are omitted. No `tabs` and no `debugger` permission; screenshots answer `unsupported_capability`.
- **The person stays in charge.** High-risk clicks and `type` with `submit` wait for an "Allow once" card in an open side panel; no panel or a denial gives `approval_denied`. Pause and Stop cancel what is running and refuse new commands (Stop also releases the agent's tabs). A click or key press by the person in an owned tab cancels the agent's command there and holds the tab for 5 s.

## Decisions

- The panel calls the API directly. Moving every call through the service worker would add a message hop per SSE frame and a second place where tokens live. Only OAuth refresh, which must be single flight across pages, runs in the background.
- Secrets never cross `chrome.runtime` messaging. The background message schema has no secret fields.
- Card field labels and target names come from the extension's own copy. Agent text is shown as plain text, so an agent cannot dress up a phishing form.
- Host permissions are optional and requested per origin at connect time. There is no `<all_urls>`. The only page script is the opt-in "Ask Dewee" button: turning it on in Settings requests `https://*/*` and registers the script at runtime; turning it off unregisters it. A click sends the selected text, title and address to the service worker, which opens the side panel and leaves a quoted draft in `storage.session` for the composer of that window. Nothing is sent to Dewee until the person submits. The connected browser adds no install-time permission: it uses the per-origin host access the person grants when they allow an agent a site.
- One workspace per view. A load error in one workspace never falls back to another workspace or profile.

See [api-contract.md](api-contract.md) for the wire contract and the two threat models for security reasoning.
