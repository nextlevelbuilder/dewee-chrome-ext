# Extension final review: stream errors, refusal reasons, credentials form, live e2e

Scope: src/api/dewee-client.ts, src/api/errors.ts, src/credentials/CredentialsForm.tsx, src/shared/i18n.ts,
tests/e2e/live-*.spec.ts, tests/e2e/support/{live.ts,stub-llm.mjs}, tests/unit/{api,credentials}, docs/api-contract.md.
Also read: use-chat.ts, chat-state.ts, ChatShell.tsx (respond), ActionCard.tsx, client-factory.ts, sse-reader.ts.
Method: reading only. The Bash tool failed on every command, so lint, typecheck, tests and build were NOT run.

## Blocking

None. No secret reaches storage, logs, URLs or chat. No agent HTML is rendered, and there is no remote code.
The no-auto-resend invariant holds: `retry` only runs from a user click (use-chat.ts:285-291).

## Should-fix

1. Retrying after a real pre-send failure is lost in an existing conversation. Files: use-chat.ts:210-212, chat-state.ts:194-195, use-chat.ts:101-111.
   `attempt()` (dewee-client.ts:198) and `authorization()` failures (client-factory.ts:20, `background_unavailable`)
   both return status 0, the same status as a mid-stream drop. When a session key exists, `reconcileNeeded` is true, so
   `retryText` is removed. Scenario: the person is offline and sends in an existing chat. The panel shows
   "Reconnecting" for up to about 3 minutes (90 polls; a status-0 poll does not break the loop at line 106), `loadSession`
   fails, and the message has no "Send again" button. If the network comes back during the reconcile, the history reload
   replaces the optimistic user turn, and the unsent message disappears without notice.
   Fix: after reconcile, compare the fresh history with the text that was sent. If the turn is missing, restore it with
   `retryText`/`retryContinuation`. Also stop polling when the first status poll returns status 0 and `navigator.onLine`
   is false. Add a use-chat test for both branches; no hook-level test exists (tests/unit/chat has only reducer tests).
2. In a new chat, a drop before `chat.started` offers "Send again" even though the server accepted the request.
   File: dewee-client.ts:139-148 with use-chat.ts:212. A 200 response proves the Gateway accepted the turn. If the body
   breaks before the first frame, `accepted` is false and there is no session key, so `reconcile` is false and the
   retry button appears. Clicking it starts a second run in a second session.
   Fix: mark errors raised after the response arrived (for example `new DeweeApiError(0,'network_error',…)` plus
   a `afterResponse: true` field). In use-chat, do not offer a retry for those errors. Tell the person the reply may
   continue in the sessions list.
3. The new catch-all also relabels non-transport failures as "connection lost". File: dewee-client.ts:148.
   Any non-`DeweeApiError` error (a bug in `mapRuntimeFrame`, a decoder error, or a raw throw from a future
   auth adapter) becomes `network_error` and starts a reconcile. Fix: narrow the check to `error instanceof TypeError`
   and rethrow other errors unchanged.
4. A bad `details` value makes the client drop the whole error envelope. File: errors.ts:40.
   `details` must be an object with `reason` as a string of at most 80 characters. If an endpoint sends
   `"details": null` (Go `Details any` holding a typed nil map), a non-string `reason`, or a reason longer than 80
   characters, `safeParse` fails. The client then drops the server `code`, `message` and `retry_after_seconds` and falls
   back to `conflict`, `request_failed` or `HTTP 409`. The claim that unknown reasons are ignored only holds for short
   string reasons. Fix: `details: z.unknown().optional()`, then read the reason with
   `z.object({ reason: z.string() }).safeParse(details)` and check it against `specificReasons`. Add tests for
   `details: null` and `{ reason: 5 }`.
5. Typed secrets stay in memory after the card closes without a submit. File: CredentialsForm.tsx:20, 43-49.
   The card can close while the form is still mounted, for example because `isUiActionOpen` is evaluated again after
   expiry on a parent re-render, or because another device answers and the card reloads. The inputs disappear, but
   `values` still holds the secret until the component unmounts. Nothing is written to the DOM or storage, but this
   breaks the rule that "the panel never holds them again". Fix: `useEffect(() => { if (!interactive) { setValues({});
   setMissing([]); } }, [interactive])`. In CredentialsForm.test.tsx:109-124, also check
   `container.innerHTML` does not contain SECRET, and add a test that types a value, re-renders with
   `interactive={false}`, then re-renders with `true` and expects an empty input.
6. The live helpers send the admin master token and run destructive calls against any host. Files: tests/e2e/support/live.ts:90-116,
   live-credentials.spec.ts:43-45 and 115-118. The specs skip cleanly in CI, because the file-level `test.skip`
   needs both env vars. But if a developer's `.env` points `E2E_GATEWAY_URL` at a shared or production Gateway,
   the run uses the master token with `X-GoClaw-User-Id: system` to delete agent policies, mint and revoke API keys,
   and run `sweep`/`expire` on whatever `E2E_DB_DSN` names. Fix: in `requireLiveGateway`, skip unless the hostname
   is loopback (`localhost`, `127.0.0.1`, `::1`) or `E2E_ALLOW_REMOTE=1` is set. Apply the same check to `E2E_CLOUD_ORIGIN`.
7. The revoke e2e test does not prove the new reason path. File: live-credentials.spec.ts:242-245. It also accepts
   "This request is already closed.", so a Gateway that never sends `credential_policy_revoked`, or a broken
   `errors.ts` mapping, still passes. Fix: once dewee#1019 is final, assert only the revoked text, or record the
   generic fallback as a known gap.
8. The docs and the code disagree about the error shape. File: docs/api-contract.md:178 says the respond call
   "returns `409 credential_policy_revoked`", which reads as `error.code`. The client and its unit test
   (errors.test.ts:32) expect `code: 'conflict'` with `details.reason`. Fix: state the actual envelope (code plus
   `details.reason`) after checking dewee#1019. The local dewee `dev` branch has no `credential_policy_revoked`, so I
   could not check this claim.

## Nits

- live-selfhosted.spec.ts:117-139: a failed assertion skips the revoke of the minted key (`created.key`). Move the
  revoke into `finally`.
- live.ts:22-25: the non-admin skip does not require `E2E_WORKSPACE_ID`, but `api()`, `history()` and
  `rememberedSession()` use it. Without it, the selfhosted and resilience specs fail on `/workspaces//…` instead of
  skipping. Require it there too.
- live-resilience.spec.ts:36: the relay ignores https and defaults to port 80. Document that the relay supports only
  http on loopback.
- dewee-client.ts:148 creates the message "The connection was lost", but the UI shows `error.network_error`
  ("Cannot reach the server"), which is misleading mid-reply. Consider a separate `connection_lost` code with its own en/vi strings.
- live-credentials.spec.ts:62-68: `watchLeaks` excludes respond requests by URL but never checks that the respond
  URL does not contain the sentinel.
- sse-reader.ts:14: the line buffer is unbounded, so a server that never sends a newline can grow memory
  without limit. Open a separate `security` issue for this rather than widening this PR.

## Verified OK

- Mid-stream drop: when a session key exists or `chat.started` arrived, `retryText` is removed and the panel
  reconciles. The unit test at dewee-client.test.ts:301-321 covers the client mapping.
- A user abort is passed through as `AbortError` (`signal.aborted` guard). A stall maps to `stream_stalled`.
- errors.ts: only `credential_policy_revoked` is promoted. An unknown string reason keeps the server code (tested).
- i18n: the en and vi strings for `error.credential_policy_revoked` exist (i18n.ts:88, 265). They render as text.
- CredentialsForm: values are cleared before the respond call is awaited. The refusal alert renders from
  `error` state, never from agent text. No input is rendered when the form is not interactive.
- Live specs: the file-level `test.skip` runs before any network call. Nothing writes keys, tokens or sentinels to the
  console. Screenshots are taken before fill or after the form is cleared. stub-llm binds to 127.0.0.1 and logs only
  its URL. `.env` is gitignored.
- Backend status: GET /v1/auth/token/status and the UI action stack are present on the local dewee `dev`. I could not
  check the PR numbers or states (no gh access).

Status: DONE_WITH_CONCERNS
Summary: No blocking security defects. There is no auto-resend anywhere. However, a real pre-send failure in an
existing chat loses the retry option (and can silently drop the message), and a drop before `chat.started` in a new
chat still offers a retry that duplicates the run.
Concerns/Blockers: lint, typecheck, tests and build were not run (the shell was broken). The dewee#1019 error shape
and the PR states in the Backend status table are unverified.
