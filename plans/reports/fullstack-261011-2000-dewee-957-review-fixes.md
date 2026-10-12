# Dewee 957 review fixes (CCP extension OAuth + BFF)

Worktree `D:/www/nextlevelbuilder/worktrees/dewee-957-ccp-extension-oauth`, branch `feat/957-ccp-extension-oauth`.
Commit `fcab6128` on top of `14183ba5` (local only, not pushed). App: `apps/dewee-app`.

## Findings

1. **B1 history leak: fixed.** Confirmed: the view kept `role: "tool"` raw and only dropped `[[dewee:` user turns.
   The provisioning history already serializes `providers.Message.Injected` (`injected`), so no Go change was needed.
   - `workspace-chat-history.ts` and `runtime-workspace-chat-history-client.ts`: parse `injected`.
   - `extension-api-views.ts`: a new `extensionHistoryEntry` mirrors the Gateway `extensionHistoryEntry`. It drops system/unknown
     roles, empty user/assistant turns, injected user turns and setup markers, and redacts tool content with
     `redactSensitiveString` (`src/lib/secret-redaction.ts`). That helper is the existing TS mirror of `redactTracePreview`,
     pinned by shared test vectors.
   - Tests: "returns history without setup, injected or system turns…" and "redacts secret-shaped tool output in history". Both
     check that `OPENAI_API_KEY=sk-…` and `Bearer sk-…` never appear in the response.
2. **S1 recovery: fixed.** `recoverPassword` now adds `revokeUserExtensionFamiliesStatement` (`revoked_reason='account_recovery'`) to the
   same `db.batch` as `DELETE FROM sessions`. Other sign-out-everywhere paths: none exist. `DELETE FROM sessions WHERE user_id`
   appears only in recovery, and the CCP has no account disable or delete. Member removal does not need a token change,
   because every extension route re-checks membership and the relay re-checks every 5 s.
   Test: new `src/lib/local-password-accounts.test.ts` runs on real 0001/0031/0034 migrations in SQLite. It checks that the
   person's family is revoked, the access token gets `token_revoked`, and another user's sign-in stays valid.
3. **S2 respond cap: fixed.** `respond.ts` reads the body with a 160 KiB cap, for this route only. Test: 8 x 16 KiB secrets plus a
   ~8 KiB response gets 200. A 161 KiB body is refused with "The request body is too large." and never reaches the runtime.
   Note: the browser respond route (`workspace-setup-route-support.ts:59`) still caps at 64 KiB. That is outside 957 scope.
4. **S3 history parity: fixed.** Ids are now `m<position>`. `limit` must be a positive integer; values above 200 are clamped to 200,
   as on the Gateway (`extension_api_read.go:307`) and the provisioning validator. Contract: "1–200 (default 50)".
   Tests are updated (`m4`/`m6`), and a new test covers the clamp to 200 and the 400 for 0.
5. **S5 sessions: partly fixed (bound documented).** The runtime has no per-user filter: `provisionWorkspaceSessionsRequest` has only
   channel/limit/offset, and `own_only` exists only on session-detail. No endpoint was invented. The route now reads page 0,
   then the rest of the 10-page window in parallel, and removes duplicates by key. `total` is the number of the caller's chats
   inside the window, which is exactly what offset/limit can page through. Chats older than the tenant's newest 500 app
   chats are still not listed. The route comment and the docs say so. Test: a 3-page scan with a duplicate, `total` 3, and
   correct paging.
6. **Nits**
   - Relay without a terminal frame: **fixed.** It now emits `chat.error` (`runtime_bff_failed`/`retry`), or `chat.stopped` if
     the client went away. Test added.
   - Status `run_id` null vs omitted: **kept (null), documented** in the docs. The extension accepts both.
   - Refresh rotation in separate batches: **fixed.** `rotateExtensionRefreshToken` does the conditional UPDATE, the token
     inserts and the `last_used_at` update in one batch. The winner is read from `results[0].meta.changes` (D1 and the PG
     adapter both map it). A lost race revokes the family, so the pair that was written is dead and was never handed out.
     Test: when the batch fails, the old refresh token stays usable.
   - Code replay before the family row exists: **fixed.** `consumeExtensionCode` reserves `family_id` in the same conditional
     UPDATE. The replay path (`revokeReplayedCodeFamily`) upserts that family as revoked (`ON CONFLICT … WHERE revoked_at IS NULL`).
     The first exchange's insert then fails, and it maps to `invalid_grant` (`isExtensionFamilyRevoked`). Test: a replay
     injected between consume and insert leaves 0 tokens and one family with reason `code_replay`.
   - Workspaces double read: **rejected (not trivial).** The two reads per membership already run in parallel. Batching them
     needs new repository list methods.

## Docs
`docs/extension-oauth-and-bff.md` covers: code-replay reservation, atomic rotation, the recovery revocation, history rules,
the sessions scan bound and `total`, the terminal-frame guarantee, the 160 KiB respond cap, and `run_id: null`.

## Commands (in apps/dewee-app)
- `npx vitest run extension src/lib/local-password-accounts.test.ts src/lib/runtime-workspace-chat-history src/lib/workspace-chat-history src/pages/api/setup`: 10 files, 91 tests passed.
- `pnpm typecheck` (astro check): 0 errors, 0 warnings (existing hints only). `npx tsc --noEmit`: exit 0.
- Go was not touched, so go tests were not run.

Status: DONE_WITH_CONCERNS
Summary: All 957 findings are verified. B1, S1, S2, S3 and four nits are fixed with tests, and docs are updated in commit fcab6128 (not pushed). S5 is bounded and made honest because the runtime has no per-user list filter. The workspaces N+1 is left as is.
Concerns/Blockers: Members whose chats are older than the tenant's newest 500 app chats still cannot list them. A real fix needs an own-only filter on the Gateway's provisioning session list, which is a follow-up issue. The browser respond route keeps its 64 KiB cap.
