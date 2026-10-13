# PR #6 review: split CRLF in the SSE reader (issue #5, commit 873c2a9)

Verdict: approve. Nothing blocking. Logic was checked by hand; I could not run vitest or `gh pr diff` because the Bash tool failed to start (ENAMETOOLONG).

## Correctness checks (all pass)
- `\r\n`, a lone `\r` and a lone `\n` each end exactly one line. The regex alternation tries `\r\n` before `\r` (sse-reader.ts:19).
- `\r` + empty chunk: `push('')` returns before `endedWithCr` is touched (sse-reader.ts:46), so the flag survives until the `\n` arrives. A TextDecoder chunk that decodes to nothing (only part of a multi-byte character) is the same case.
- `\r` + `\n\n`: the first `\n` is skipped and the second is a blank line, so exactly one frame is dispatched.
- `\r` + end of stream: the flush pushes `'\n\n'` (sse-reader.ts:121). One `\n` is skipped and the other dispatches. That is the same result as a stream ending in `\n`.
- `\r\r\n` inside one chunk gives CR, then CRLF: two line endings. That is correct.
- `\r\r\n` split as `\r` | `\r\n` stays correct because the second chunk does not start with `\n`.
- `\r\r\n` split as `\r\r` | `\n`: the `\n` is skipped. That is correct.
- Cap accounting: the skipped `\n` is never counted, since `rest = chunk.length - start` (sse-reader.ts:61). The 1 Mi limit and `pending` do not change.
- Failed state: `endedWithCr` is set before the loop (sse-reader.ts:50). If `limit` throws, every later push throws at line 45, so the stale flag is never read.
- The shared global `NEWLINE.lastIndex` is reset on every push (line 51) and `push` is synchronous, so reentrancy is safe.
- Both new tests fail without the fix. Without it the stray `\n` dispatches an extra `{event:'x', data:''}`. So they are real regression tests (sse-reader.test.ts:14, :129).

## Findings
- should-fix: tests/unit/protocol/sse-reader.test.ts:14-18. The fix depends on edge paths that no test covers. Add these unit cases:
  1. `push('data: a\r')`, `push('')`, then `push('\n\n')`. Expect exactly one frame.
  2. `push('data: a\r')` then `push('\n\n')`. Expect one frame at the second push, not two.
  3. `push('data: a\r\r')` then `push('\n')`. Expect one frame and no further output.
- nit: sse-reader.ts:49-50. The rule "only the first character of the next non-empty chunk is checked" holds only because `push('')` returns early. Say so in the comment at line 34, so that a later move of the early return does not quietly break CRLF joining.
- nit, existing and out of scope: at end of stream the flush dispatches an unterminated event (sse-reader.ts:121). WHATWG says to discard it. This is intended and tested at sse-reader.test.ts:115, so no change.

Status: DONE_WITH_CONCERNS
Summary: The split-CRLF fix is correct for every case checked: empty chunk, end of stream, `\r\r\n` and cap accounting. One should-fix asks for 3 more edge-case unit tests.
Concerns/Blockers: The tests and the PR diff were not run because the Bash tool failed with ENAMETOOLONG; this review rests on reading the code.
