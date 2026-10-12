# Re-review: 34a9f15 (PR #4 SSE cap follow-up) + 09ead18 (PR #6 split CRLF)

Read-only review of worktree agent-a4929d1c86d85c6dd @ 09ead18. The shell failed (ENAMETOOLONG), so this review comes from reading the code only. No tests were run, and `git show` was not available.

## Verified (no finding)
- Frames come before the error. When `push` throws, `readSseFrames` catches it, awaits `reader.cancel(...).catch(()=>{})`, runs `yield* error.frames` and then `throw` (sse-reader.ts:132-137). streamChat maps and yields each frame before the next `frames.next()` rejects (dewee-client.ts:147-159), so use-chat dispatches `chat.started` / `message.completed` first.
- No double yield. A throwing `push` never returns, so `yield* parser.push(...)` (sse-reader.ts:129) yields nothing for that chunk. Frames from earlier chunks were already yielded and are not in `error.frames`. The test's exact `toEqual` (sse-reader.test.ts:242) would catch a duplicate.
- Cancel errors are swallowed (sse-reader.ts:134). A body already errored by abort makes cancel reject, and that rejection is ignored too. Test: sse-reader.test.ts:247.
- Plain Stop is unchanged. With no overflow, `frames.next()` rejects with AbortError and goes past the `SseProtocolError` branch (dewee-client.ts:164) to `throw error` at line 173. use-chat:570 still handles it, and dewee-client.test.ts:288 covers it. Mapping before the stall check is right: an overflow that races the idle timer stays `protocol_error` with afterResponse=true.
- Cap and CRLF:
  - `endedWithCr` is only true right after a line ending, so the buffer is empty when the `\n` is skipped.
  - `rest = chunk.length - start` accounts for the skip.
  - After an overflow the parser is `failed`, so a stale flag does no harm.
  - Ordering the empty-chunk guard first (sse-reader.ts:53-55) matters in practice: `TextDecoder` with `stream:true` returns '' for a partial multibyte chunk.
  - The EOF flush (`decode() + '\n\n'` after a trailing `\r`) still dispatches correctly; sse-reader.test.ts:189 covers it.
- dataSize overcount fixed (sse-reader.ts:109, test :134). Redundant `limit(0)` is gone.
- Regression power:
  - dewee-client.test.ts:410 fails if the mapping moves below the abort check, because a raw SseProtocolError would escape.
  - dewee-client.test.ts:399 fails if `error.frames` is dropped.

## Findings
- should-fix: use-chat.ts:520-568 with dewee-client.ts:144-160. If the overflow chunk also completed `message.completed`, the turn first goes terminal. Then `protocol_error` arrives and the catch adds an error bubble and a reconcile to an already completed reply (use-chat.ts:637-639; for a continuation, `taken=settled` is true). Nothing is lost and there is no resend, but the person sees a failure on a successful turn. Options: ignore the error in the catch when `terminal` is already true, or stop reading after a terminal event in streamChat. No integration test covers "frames then protocol_error".
- nit: use-chat.ts:548-553. A Stop requested before `chat.started`, when `chat.started` arrives in the overflow chunk, now ends as `protocol_error` + reconcile, not `chat.stopped`. This is acceptable because afterResponse=true means there is no "Send again". Note it in the docs or a test if it is intended.
- nit: sse-reader.test.ts:247. The cancel-rejects test has no completed frame before the overflow, so it does not prove frames are still yielded when `cancel` rejects. Add one frame to the chunk.
- nit: sse-reader.test.ts has no test that combines a split CRLF with the cap. Example: `'data: a\r'`, then `'\n' + 'x'.repeat(cap)`, checking the skipped `\n` is not counted and the frame is delivered.
- nit (pre-existing, outside these commits): sse-reader.ts:131 dispatches an unterminated trailing event at EOF. WHATWG discards it. This is intentional per test :175, but it differs from the spec.

Status: DONE_WITH_CONCERNS
Summary: No blocking issues. The yield-then-throw order, single delivery, cancel swallowing, plain-Stop behaviour and the CRLF/cap interaction are all correct. One should-fix: an error bubble can follow a completed reply.
Concerns/Blockers: Tests were not run because the shell failed with ENAMETOOLONG. Run `pnpm test` before merging.
