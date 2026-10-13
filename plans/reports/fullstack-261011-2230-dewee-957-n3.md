# Dewee 957 N3 fix + 992 rebase

Date: 2026-10-11. Nothing pushed, no PRs opened.

## Part 1: N3 (nextlevelbuilder/dewee, feat/957-ccp-extension-oauth)

Worktree: `D:/www/nextlevelbuilder/worktrees/dewee-957-ccp-extension-oauth`
Commit: `7948bfe3` fix(ccp): send one terminal frame from the extension chat relay (parent fcab6128, `Refs #957`)

Change:
- `apps/dewee-app/src/lib/extension-api/extension-chat-relay.ts`: the catch now runs `if (!terminated) writeError(error)`.
  `terminated` already existed and is set by `write()` for any terminal event.
- `extension-chat-relay.test.ts`: new test "sends exactly one terminal frame when the stream fails after message.completed".
  The upstream delivers `chat.started` + `message.completed`, and the next pull errors. `onCompleted` throws synchronously.
  The test asserts that the only terminal frame is `message.completed`, and that it is the last frame.

Note on the test: the relay `break`s after a terminal frame, so an upstream error after `message.completed` is never read.
The path that really reaches the catch is a synchronous throw in the completion hook (it escapes `.catch`), so the test covers both.
Verified red before the fix (`['event: message.completed', 'event: chat.error']`) and green after.
(A first draft used `controller.error()` right after `enqueue()`. That drops the queued chunks, so it was replaced with a pull-based stream.)

957 nits from the re-review:
- `extension_api.go` (dead `membership_suspended` branch, entitlement mapping): Go Gateway code from #956. Not in this branch, so not touched.
- `created_at` parity (`extension-api-views.ts:128` sends `""`): a contract choice (omit vs empty). Not cheap or safe without a decision, so left open.
- N4 (sessions fan-out): out of scope, follow-up issue.

Gates (apps/dewee-app):
| Command | Result |
|---|---|
| `npx vitest run src/lib/extension-api/extension-chat-relay.test.ts` (fix reverted) | 1 failed / 5 passed (expected red) |
| `npx vitest run src/lib/extension-api` | 3 files, 39 passed |
| `npx vitest run` | 560 files, 3942 passed, 1 skipped |
| `npx tsc --noEmit` | exit 0 |

## Part 2: rebase #992 (feat/992-own-session-filter)

Worktree: `D:/www/nextlevelbuilder/worktrees/dewee-992-own-sessions`
- `git status --short`: clean before the rebase.
- `git rebase --onto feat/957-ccp-extension-oauth fcab6128 feat/992-own-session-filter`: "Successfully rebased", no conflicts.
- 6690a9b0 is now `10c31ee8` feat(gateway): filter the provisioning session list to the actor's own chats (parent 7948bfe3).

Gates:
| Command | Result |
|---|---|
| `go build ./...` (repo root) | exit 0 |
| `npx vitest run src/lib/extension-api` | 40 passed |
| `npx vitest run` | 3945 passed, 1 skipped |
| `npx tsc --noEmit` | exit 0 |

## Extra: agent_key fix on 992
Commit: `3dd36e5a` fix(http): accept normalized agent keys in the session filter (parent 10c31ee8, `Refs #992`)
- Gateway `provisioning_sessions.go` now validates with the existing `config.IsValidAgentID` (the `NormalizeAgentID` regex), not `isValidSlug`.
- `sessions.ts` mirrors it: `/^[a-z0-9][a-z0-9_-]{0,63}$/`.
- `buildSessionFilter` (pg + sqlite) uses each package's existing `escapeLike`, plus `ESCAPE '\'`, for the agent and channel values.
- Docs: `ccp-session-detail-inspection.md:17` and `extension-oauth-and-bff.md`.
- Tests:
  - Go `...AcceptsNormalizedAgentKeys` covers `sales_bot`, `sales-` and `9lives`.
  - The rejection list is now `%`, `Agent`, `a:b`, `-lead` and `a b`.
  - SQLite `...AgentKeyUnderscoreIsLiteral`: `sales_bot` does not match `salesxbot`. It is red without the escape and green with it.
  - Vitest: `sales_bot` is accepted, and `sales_bot%`, `Sales` and `-lead` return an empty list.

Gates on 3dd36e5a:
- `go build ./...`: exit 0.
- `go vet` (http, pg, and sqlite with `-tags sqlite`): exit 0.
- Touched files are gofmt-clean.
- `go test -tags sqlite ./internal/store/sqlitestore/`: ok.
- `go test ./internal/config/`: ok.
- Focused session tests in http (both tag sets): pass.
- vitest: 560 files, 3946 passed, 1 skipped. `tsc --noEmit`: exit 0.
- Pre-existing Windows-only failures, also failing on base 10c31ee8 in a temporary worktree (since removed):
  - pg: `TestBuildSkillInfo*` (path separators).
  - sqlite http: 12 tests (secure CLI binary lookup, media, symlink, skill export, workspace setup exec, SSH CRLF).
  - None of them touch the session code.

## Unresolved
- `created_at` empty-string vs omitted: needs a contract decision (CCP or client side).
- Both branches need a force-push by the owner (957 gained a commit; 992 was rewritten and gained 3dd36e5a).
- Full Go suites are not green on Windows for the pre-existing reasons above; CI (Linux) should confirm.

Status: DONE_WITH_CONCERNS
