# feat/957 after the rebase onto dev c4c5c6c8: fixing the extension chat stream

Repo: nextlevelbuilder/dewee. Nothing was pushed and no PR was opened.

## Check of the conflict resolution (`pages/api/workspaces/[workspaceId]/chat-stream.ts`)
I compared the file with `c4c5c6c8` (dev) and `7948bfe3` (957 before the rebase). Nothing is lost:
- From dev: `prepareWorkspaceChatStream` is used, the runtime stream call ends in `.catch(... platformManagedChatRefusal(error, context.platformManaged))`, and the `errorEvent` branch for `WORKSPACE_CHAT_PLATFORM_MANAGED` is unchanged.
- From 957: the abort, the chat-ready marker, the membership recheck and the setup-id parser call `@lib/workspace-chat-stream-support`. That module keeps dev's `forgetRequestReads` and `shouldStopRealtimeStream` logic and the `agentKey` abort fix.
- One leftover: the `type WorkspaceChatStreamContext` import was unused, because dev only needed it for `bestEffortMarkChatReady`, which now lives in the support module. I removed it. The old `RuntimeWorkspaceChatAbortClientEnv` part of `runtimeEnv` was correctly dropped, since the support module resolves that env itself.

## Root cause of the three 500s
Dev changed `prepareWorkspaceChatStream` (`src/lib/workspace-chat.ts`). It now reads the membership sync result: `membership.platformManaged === true`. In `extension-api-routes.test.ts`, the fake still did `runtime.upsertWorkspaceMembership.mockResolvedValue(undefined)`. Reading `undefined.platformManaged` threw a `TypeError`. That error is not an `AppError`, so `extensionErrorShape` logged `extension_api.route_failed { error: 'TypeError' }` and answered 500. The fake was out of date: the real client always returns `{tenantId, role, platformManaged?}`.

The route was also missing dev's contract. The extension stream route did not apply `platformManagedChatRefusal`, so a master-attached workspace would have sent the extension the raw runtime 403 message instead of the browser route's explanation.

## Fix (commit 8f034132 on feat/957)
- `apps/dewee-app/src/pages/api/extension/v1/workspaces/[workspaceId]/chat/stream.ts:31,86-91`: imports `platformManagedChatRefusal`, and `streamWorkspaceChat(...)` now ends in `.catch(... throw platformManagedChatRefusal(error, prepared.platformManaged))`, as in the browser route. The refusal code `workspace_chat_platform_managed` is not an extension contract code, so `extensionErrorShape` answers 403 `forbidden` and keeps the explanation as the message. That fits the extension contract ("403 forbidden: show the reason, no retry"), so the shared wire contract does not change.
- `apps/dewee-app/src/lib/extension-api/extension-api-routes.test.ts:161`: the fake now resolves `{ tenantId: "tnt-1", role: "owner" }`.
- `extension-api-routes.test.ts:546-565`: new test "explains a platform-managed refusal only when the membership sync was declined":
  - with `platformManaged: true` and a runtime 403 `master_tenant_platform_managed`, the answer is 403 `forbidden` with the platform-owner explanation;
  - without `platformManaged`, the same 403 keeps the runtime's own message.
- `apps/dewee-app/src/pages/api/workspaces/[workspaceId]/chat-stream.ts:30`: the unused type import is gone.
- `docs/extension-oauth-and-bff.md:98`: one paragraph documents the platform-managed refusal on `chat/stream`.

## New hashes
- feat/957-ccp-extension-oauth: bcd767a8, 4fcca2d5, 5b4e41ef, then **8f034132** (new), on c4c5c6c8.
- feat/992-own-session-filter: `git rebase --onto feat/957-ccp-extension-oauth 5b4e41ef` ran with no conflicts. 54436970 is now **90e8ac4b**, and c70003c8 is now **70bda2d9**, on 8f034132.

## Gates
| Gate | feat/957 (8f034132) | feat/992 (70bda2d9) |
|---|---|---|
| vitest apps/dewee-app (full) | 563 files, 3966 passed, 1 skipped, 0 failed | 563 files, 3970 passed, 1 skipped, 0 failed |
| `tsc --noEmit` | exit 0 | exit 0 |
| `go build ./...` | exit 0 | exit 0 |
| `go test -tags sqlite ./internal/store/sqlitestore/ -run Session` | n/a | ok (3.2 s) |

I ran `go clean -testcache` at the end. Both worktrees are clean.

ESLint was not run, because `apps/dewee-app` has no eslint config.

Status: DONE
Summary: The 500s came from an out-of-date test fake: it resolved `undefined` from the membership sync, and dev's `prepareWorkspaceChatStream` now reads that result. I fixed the fake and made the extension stream apply dev's platform-managed refusal (403 `forbidden` with the explanation), with a new test. 992 was restacked, and every gate passes on both branches.
Concerns/Blockers: none. The conflict resolution in the browser route was correct; I only removed one unused type import.
