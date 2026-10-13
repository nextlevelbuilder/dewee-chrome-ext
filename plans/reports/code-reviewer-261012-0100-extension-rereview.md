# Extension re-review after the review fixes

Method: I only read the code. Bash failed with ENAMETOOLONG on every command, so lint, typecheck, tests and the build were NOT run. I did not open `.env`.

## Status of the earlier findings

| # | Status | Evidence |
|---|---|---|
| S1 pre-send vs post-response | Fixed, with gaps (see B-1..B-3) | use-chat.ts:263-291 and 136-143; errors.ts:18; dewee-client.ts:141-162; use-chat.test.tsx:119-268 |
| S2 new chat drops after 200 | Fixed | use-chat.ts:269-272; use-chat.test.tsx:169-184 |
| S3 narrower catch-all | Fixed, but it causes a regression (B-4) | dewee-client.ts:149-155, 219-222; dewee-client.test.ts:344-363 |
| S4 lenient `details` | Fixed (N-1 remains) | errors.ts:47, 51, 84-85; errors.test.ts:38-44 |
| S5 CredentialsForm clears values | Fixed | CredentialsForm.tsx:30-33; CredentialsForm.test.tsx:124, 127-145 |
| S6 live host guard | Fixed. `E2E_DB_DSN` is still not checked; the fix report says so | live-host-guard.ts:6-25; live.ts:26-31, 96-99; live-cloud.spec.ts:15-16 |
| S7 revoke e2e asserts the exact reason | Fixed | live-credentials.spec.ts:245 |
| S8 docs | Fixed. architecture.md:40 is still incomplete (B-5) | api-contract.md:178; development.md:26 |
| Nits | 4 of 4 claimed fixes verified | live-selfhosted.spec.ts:144-147; live.ts:27; i18n.ts:100-101 and 280-281; live-credentials.spec.ts:65, 102 |

Two nits from the earlier review are still open. The fix report does not claim them:
- the relay supports only http (live-resilience.spec.ts:36);
- the SSE buffer is unbounded (deferred to #2).

New codes:
- `connection_lost` and `delivery_unconfirmed` have en and vi strings (i18n.ts:100-101, 280-281), and so does `chat.offlineWaiting` (:66, :246).
- Errors render inside `role="alert"` (MessageList.tsx:23). The offline notice renders inside `role="status"` (:122).
- Leaving them out of `RecoveryCode` is correct. That union lists server `chat.error` codes only, and `ChatMessage.error.code` is `RecoveryCode | string`.
- The doc comment at errors.ts:3 that lists client codes is stale.

## Blocking

None. No secret reaches storage, logs or URLs. The panel never resends automatically: `retry` runs only on a click (use-chat.ts:351-357).

## Should-fix

**B-1. A nested reconcile is overwritten by the outer `idle`, so the panel shows idle while a run is live.**
- Where: use-chat.ts:110 with 155-158.
- How it happens: the 90 polls run out after about 3 minutes, which a long tool run can exceed. The run is still going, so `loadSession` sees `status.running` and starts a second reconcile, which dispatches `reconciling`. The outer reconcile then dispatches `idle`.
- Failure: the composer opens while the run continues. A send gets a 409 and starts a third reconcile. If the user sends after the run ends, the nested reconcile's later `history` dispatch replaces the messages in the middle of the new stream. The optimistic turn and the streaming reply disappear, and `patchStreaming` drops every later delta. An accepted turn vanishes from view.
- Fix:
  - Give `loadSession` a `{ followRun: false }` option for calls from reconcile.
  - Have reconcile return or keep looping while `status.running`, and dispatch `idle` only from the reconcile that owns the loop.
  - Add a test: status stays `running` for more than 90 polls (fake timers).

**B-2. `endsWithUserTurn` matches on text alone, so a turn can be lost or shown twice.**
- Where: use-chat.ts:58-61 and 157.
- Lost: the person sends "continue", gets a reply, then sends "continue" again while the connection is flaky (network_error in an existing chat). The earlier "continue" is the last user turn in history, so the new turn is treated as delivered and silently dropped.
- Shown twice: another tab or device posts a later turn, or the server stores the text in a slightly different form. The last user turn then differs, so `restoreTurn` appends a duplicate and offers "Send again" for a turn the server already has.
- Fix:
  - Record a server baseline before the send: the history length, or the last server message id (`m<position>`) from the last `history` action.
  - Treat the turn as delivered only if a new user message after that baseline equals the text.
  - Add a test that repeats the previous text.

**B-3. When history fails to load, the turn is still restored with "Send again", although nothing proved it missing.**
- Where: use-chat.ts:155-157 (`history === null` means `endsWithUserTurn` is false).
- Failure: the network flaps. Status polls fail with status 0 until the poll cap. Then `loadSession` fails, and a turn the server may already hold gets a retry button. One click starts a duplicate run.
- Fix:
  - When `history` is null, do not dispatch `restoreTurn` with `retryText`.
  - Show `delivery_unconfirmed` with the existing reload link instead.
  - Note that the `restoreTurn` branch for an existing `localId` (chat-state.ts:210-211) only runs in this case and has no test.

**B-4. A non-network error after a 200 now offers "Send again", which duplicates the run.**
- Where: dewee-client.ts:154 and use-chat.ts:257-291.
- How it happens: the S3 fix rethrows non-`TypeError` body errors unchanged, and they carry no `afterResponse` mark. For example, a `RangeError`, a decoder or `mapRuntimeFrame` bug, or a reader error before `chat.started`.
- Failure: in use-chat, `apiError` is null, so `delivered = accepted = false` and `unsure` is false. The else branch offers `retryText` in both new and existing chats, although the 200 proved the server accepted the turn.
- Fix: in the client, keep the original error but mark acceptance. For example, `if (responded && !(error instanceof DeweeApiError) && !isAbort(error)) throw Object.assign(error, { afterResponse: true })`, or wrap it in `DeweeApiError(0,'runtime_request_failed',…,true)` with `cause`. Alternatively, in use-chat, treat any non-API error as not provably undelivered. Add a hook test.

**B-5. A new chat still offers "Send again" after failures where the request may have reached the server.**
- Where: use-chat.ts:267-276. The failures are a stall before the response, or a rejected fetch.
- Failure: a `stream_stalled` with `afterResponse: false` fires after 120 s with no headers. The request was almost certainly sent, so "Send again" can create a second session with the same run.
- This breaks the stated invariant that "Send again" appears only when the server provably did not get the message. It also contradicts architecture.md:40, which says only failures that "never left the panel" keep "Send again".
- Fix:
  - For a new chat, map `stream_stalled` to `delivery_unconfirmed` with no retry.
  - Keep the retry for `network_error` only when `navigator.onLine === false` at the time of failure.
  - If you choose to accept the risk instead, that is a product decision: record it in architecture.md.

**B-6. A card continuation lost before delivery is never retried.**
- Where: use-chat.ts:275 (`text !== undefined` only) with chat-state.ts:198.
- Failure: the person saves a credential, the continuation stream gets `network_error` in a known session, and the panel reconciles with no `unconfirmed`. Setup-turn markers never appear in history (api-contract.md:92), so nothing restores the continuation, and `retryContinuation` is cleared. The card is already resolved, so the agent never continues and no button can resume it.
- Fix: the Gateway delivers each `setup_action_id` at most once (api-contract.md:152), so a resend is safe. After reconcile, keep `retryContinuation` for continuation failures that are not provably delivered. Add a test.

## Nits

- **N-1. errors.ts:43-45.** `retry_after_seconds` must be a positive integer of at most 3600, and the message at most 500 characters. A value of 0, a float or an overlong message still drops the whole envelope, and with it `details.reason` (the same class of bug as S4). Fix: use `.catch(undefined)` on each optional field.
- **N-2. The loopback logic is correct.** WHATWG `hostname` strips userinfo, keeps the IPv6 brackets, and normalizes `0x7f000001` and `127.1`; trailing-dot and IPv4-mapped forms fail closed. The tests (live-host-guard.test.ts:8-19) miss three cases, which should be added as regression cases: `http://127.0.0.1@evil.com`, `http://127.0.0.1.nip.io` and `http://[::ffff:127.0.0.1]`.
- **N-3. live-resilience.spec.ts:36.** `tcpConnect(target.hostname)` receives `[::1]` with the brackets and fails on an IPv6 gateway. The relay also ignores https. Strip the brackets and document "http on loopback only".
- **N-4. Missing hook tests.**
  - Session or agent switch during a reconcile, and during the offline wait.
  - Unmount during the offline wait, to check that the `online` listener is removed.
  - The code looks correct: use-chat.ts:44-53, 133, 140, 156. But nothing guards against regression.
- **N-5. use-chat.ts:50-52.** `waitForOnline` resumes only on the `online` event. Also resolve in the interval when `!isOffline()`, in case the event is missed.
- **N-6. CredentialsForm.tsx:119 (informational).** React DOM mirrors a controlled input's value into its `value` attribute, so `innerHTML` holds the secret while the person types. This happens only while the form is open, in the extension's own panel, and the attribute is cleared on submit or close. No change needed. Note it in credential-threat-model.md.

## Tests: meaningful or tautological?

- The hook tests are real behaviour tests: they count `streamChat`, `status` and history loads, and check the retry fields. They are not tautological.
- The gaps are B-1 to B-4, B-6 and N-4. The reducer has no `restoreTurn` test (tests/unit/chat/chat-state.test.ts).
- The fix report says 9 of 9 mutations were caught. I could not re-run them.

Status: DONE_WITH_CONCERNS
Summary: All 8 should-fix items and the 4 claimed nits are present in the code. Nothing blocks, and there is still no automatic resend. Six state-machine gaps remain: B-1, B-2, B-4 and B-6 can lose an accepted turn or reply from view, or offer a duplicating "Send again", and B-3 and B-5 can offer "Send again" without proof the server lacks the turn.
Concerns/Blockers: Lint, typecheck, tests and build were not run because the shell is broken. B-5 needs a product decision. `E2E_DB_DSN` is not host-checked.
