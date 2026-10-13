# dewee#991 — workspace chat runtime fixes

- Worktree: `D:/www/nextlevelbuilder/worktrees/dewee-991-workspace-chat-runtime`
- Branch: `fix/991-workspace-chat-runtime`. It is based on **origin/dev** (57026762), not origin/main. See "Base branch" below.
- Commit: `459633e58d7d376b684eb625ab06b8bee65e92c5`, subject `fix(gateway): stream deltas, register runs and survive disconnects in workspace chat`. The body says `Refs #991` and ends with the Co-Authored-By line.
- Not pushed. No PR opened.

## Base branch (decision)
I created the worktree from origin/main as instructed. Then I moved the branch to origin/dev with `checkout -B` before making any edits. The reasons:
- dewee `CONTRIBUTING.md` says "All PRs target `dev`; `main` is frozen".
- `origin/HEAD` points to `dev`.
- The issue's reference commit `9177af57` is on dev and not on main. main is 34 commits behind dev.

The affected files and line numbers are the same on both branches. When opening the PR, target `dev`.

## Changes
1. Bug 1, empty deltas: `internal/http/provisioning_chat_stream.go`
   - New helper `chunkContent(payload any)` at :278. It accepts `map[string]string`, which is what the agent loop emits, and `map[string]any`.
   - The `message.delta` and `thinking.delta` mapping now uses it (:197, :199).
   - The emitter contract is unchanged. `internal/channels/events.go` and its tests already consume `map[string]string`, so changing the emitters would have been riskier.
2. Bug 2, runs not registered: `internal/http/provisioning_chat_runner.go`
   - `RunWorkspaceChat` now builds `runCtx, cancel := context.WithCancel(...)` and calls `router.RegisterRun(runCtxBase, runID, sessionKey, loop.ID(), cancel)` at :56, with `defer UnregisterRun(runID)` and `defer cancel()`.
   - It passes `InjectCh` (:67) and `OnTraceCreated` → `SetRunTraceID`, so a forced abort marks the correct trace.
   - This is the same pattern as `chat_completions.go` and `gateway/methods/chat.go`.
   - Session status (`IsSessionBusy`/`SessionRunID`) now sees the run, and `AbortRun`/`AbortRunsForSession` cancel it.
3. Bug 3, disconnect kills the run:
   - The runner detaches with `context.WithoutCancel(ctx)` (:46). Tenant, user, role and locale values are kept, and the run is cancelled only by the router abort.
   - I made the fix in the shared runner, so it covers the stream path, the buffered path (`provisioning_chat.go:274`) and any future extension handler that goes through `RunWorkspaceChat`.
   - `sseEventWriter` now takes the request's `Done()` channel and drops frames after a disconnect (:79, wired at :109). I also updated the handler doc comment.
   - Origin/CSRF/HMAC guards are untouched.

## Tests added
- `provisioning_chat_stream_test.go:680` `TestMapAgentEventToWorkspaceChatSSEChunkPayloadShapes`: chunk and thinking events with `map[string]string`, `map[string]any`, a nil payload and non-string content.
- `provisioning_chat_stream_test.go:711` `TestSSEEventWriterStopsAfterDisconnect`: no frames are written after `done` closes.
- `provisioning_chat_runner_test.go:193` `TestAgentRouterWorkspaceChatRunnerRegistersRunForStatusAndAbort`:
  - while the run is in flight, `IsSessionBusy` is true, `SessionRunID` matches and the inject channel is passed;
  - `AbortRunsForSession` returns Stopped, and the run ends with `context.Canceled`;
  - the session is not busy afterwards.
- `provisioning_chat_runner_test.go:225` `TestAgentRouterWorkspaceChatRunnerSurvivesRequestCancel`:
  - the test cancels the request context mid-run;
  - the run context stays live, the user turn is persisted (`OnInputPersisted`/`OnInputDelivered`), the context's user value is kept, and the result is returned;
  - the run is unregistered at the end.

## Commands and results (Windows, PowerShell)
- `go build ./...`: OK
- `go vet ./internal/http/... ./internal/agent/...`: OK
- Focused run `go test ./internal/http/ -run 'WorkspaceChatRunner|ChunkPayloadShapes|SSEEventWriter|WorkspaceChatStream|ProvisionWorkspaceChat' -v`: all PASS.
- `go test ./internal/http/... ./internal/agent/... ./internal/gateway/... -count=1`:
  - `internal/gateway` and `internal/gateway/methods`: ok
  - `internal/http` and `internal/agent`: FAIL. Every failure also fails on an origin/dev baseline worktree (since removed). Details below.

## Failures that also fail on origin/dev (Windows, tracked in #936)
These fail on both origin/dev and the fix branch:
- internal/http:
  - `TestFilesHandleServe_OpenThenSwapToSymlinkEscape_Returns404`
  - `TestProvisioningHandlerStreamContinuesExistingSessionWithMedia`
  - `TestProvisioningHandlerAcceptsWorkspaceChatMediaLegitRoundTrip` (a Windows path inside JSON: `invalid character 'U' in string escape`)
  - `TestProvisioningHandlerCleansUpMediaAfterChatTurn`
  - `TestSecureCLICheckBinaryFindsRuntimeNpmBinary`, `...GoogleWorkspaceRuntimeBinary`, `...NpmPackageCliAlias`
  - `TestPutUserCredential_SSHKeyCRLFNormalized`
  - `TestSkillExportImportRoundTripPreservesResourcesAndModes`
  - `TestSkillExportHTTP_SQLiteSingleSkillDownload`
- internal/agent: `TestGetForRunEvictsLeastRecentlyUsedPinnedLoops`

`TestProvisioningHandlerSweepsStaleUploadsOnNewUpload` is flaky on Windows on both trees:
- It failed in the full suite on the fix branch.
- It passed alone (`-count=5`) on both trees.
- With `-count=40` on the media trio it failed 2 times on origin/dev and 1 time on the fix branch.

The likely cause is that upload filenames come from `UnixNano`, which can produce the same name twice under Windows clock resolution. This is unrelated to this change, which does not touch the upload or sweep code.

I ran `go clean -testcache` afterwards.

## Residual risks
- **No run time limit:** there is no workspace-chat-specific run timeout in the codebase. The detached run is now bounded only by the router abort, the loop's iteration and provider timeouts, and process shutdown. This is the same as `chat.send` in `gateway/methods/chat.go`. A hard wall-clock cap would be a separate decision.
- **Handler goroutine stays alive:** after a disconnect, the handler goroutine stays blocked until the run finishes, because the run is synchronous. Deferred media cleanup and setup-turn lease settlement still run after the run, as before.
- **Shared session run index:** a second concurrent run on the same session key overwrites the router's `sessionRuns` index. This is existing router behaviour that all callers share.
- **Extension routes not merged:** the routes from #956 are not on dev yet. They get the fix automatically if they call `RunWorkspaceChat`. If they create their own `sseEventWriter`, they must pass `r.Context().Done()`, because the constructor signature changed.
- **Parity:** surface parity for CCP web, the extension and CLI is N/A, since this is a backend runtime fix with no contract change. Run registration also feeds the trace id to `forceMarkTraceAborted`, which makes abort traces more accurate.

Status: DONE_WITH_CONCERNS
Summary: All three #991 bugs are fixed in the shared workspace-chat runner and SSE mapping, with 4 new tests, and committed as 459633e5 (not pushed). The branch is based on origin/dev, the repository's PR target, instead of origin/main.
Concerns/Blockers: The PR must target `dev`. Test failures in the scoped packages are all pre-existing on Windows (listed above).
