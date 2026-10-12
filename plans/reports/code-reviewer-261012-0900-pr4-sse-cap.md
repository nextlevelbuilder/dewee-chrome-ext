# PR #4 review: cap SSE line and event buffer (f79f913, Closes #2)

Verdict: no blocking findings. The cap holds and its accounting is correct. Two should-fix items and some test gaps remain. Tests were NOT run: the Bash tool failed with ENAMETOOLONG, so this review comes from reading the code only.

## Verified correct
- Off-by-one: `limit` allows `extra + held == max` and throws at `max + 1`. Tests at sse-reader.test.ts:83-101 pin both sides exactly (13 + 6 + (max-19) = max passes; one more code unit throws).
- Accounting across chunks: a partial line is checked as `buffer + rest + held` before `this.buffer +=` (sse-reader.ts:56-58). A completed line is checked as `line + held` before `line()` appends (:51). Many small partial chunks and many data lines in one event both count against one total, and test :53 covers the many-lines case. A dispatched event releases `event`, `data` and `dataSize` (:82-84).
- Check before append: yes, for both the buffer and the fields. The pre-check is conservative because each append is at most `line.length`.
- Memory release: `limit` clears everything and sets `failed`. The generator cancels the body, then `releaseLock`. `streamChat`'s finally calls `return()` on a finished generator, which is harmless.
- Comment, `retry` and unknown fields are never stored. An oversized comment line still throws, which is correct because it had to be buffered first. `id` persists across events per WHATWG and counts toward `held` at all times (:63). That is consistent, but untested.
- Cancel errors: `reader.cancel(error).catch(() => {})` swallows them (:118), and `releaseLock` runs in finally.
- Mapping: dewee-client.ts:167-168 maps the error to `protocol_error`, `afterResponse: true`, with the cause kept. In use-chat.ts, `notReceived` returns false via `afterResponse`, and `TRANSPORT_CODES` includes `protocol_error` (:97). The logged cause holds only the cap message, so no stream data leaks.
- vi string i18n.ts:297 "Không đọc được câu trả lời vì một phần quá lớn." has full diacritics. Docs (architecture.md:40, errors.ts:4) match the code.

## Should-fix
1. sse-reader.ts:47-55. When the cap trips partway through a chunk, `push` throws and loses frames it already parsed from that same chunk. Example: one read carries `chat.started` (or `message.completed`) followed by the start of an oversized line. The panel then never learns the session key. In a new chat it falls back to "Show conversations" instead of reconciling, and a continuation never sees its settle frame. The result stays safe (uncertain, no resend) but is worse than it needs to be. Fix: on overflow, return the frames parsed so far and throw on the next `push`, or attach them to the error. dewee-client.test.ts:369 hides this case by sending `chat.started` in its own pull.
2. dewee-client.ts:166. The mapping is skipped when `signal?.aborted`. If Stop's 5 s grace abort (use-chat.ts:727-730) fires while `await reader.cancel` (sse-reader.ts:118) is pending, the raw `SseProtocolError` reaches use-chat. There `notReceived` returns true for a non-API error when no frame was seen (use-chat.ts:105-107), so "Send again" is offered. That breaks the invariant. The window is tiny, and the guard itself was already there before this PR (base :165). Fix: map `SseProtocolError` before the `aborted` check, because it proves the server answered 200.

## Test gaps (should-fix)
3. use-chat.test.tsx:994-1008 covers only the new-chat path (`delivery_unconfirmed`, `recover: 'sessions'`). Not covered:
   - The known-session path. There use-chat.ts:637-639 takes the `taken` branch: code `protocol_error`, reconcile with no localId, so the bubble shows `error.protocol_error`, not `delivery_unconfirmed`. Please confirm that matches the intent.
   - "A continuation stays held" (use-chat.ts:618, 640-644).
   Add one test for each.
4. sse-reader tests have no cases for `id` accounting (a large `id` persists and narrows later events), an oversized comment line, or a body whose `cancel` rejects or throws.

## Nits
5. sse-reader.ts:54. `this.limit(0)` after `line()` can never throw, because the pre-check bounds every append. Remove it, or comment that it is only a safety net.
6. sse-reader.ts:96. `dataSize` counts one extra unit for the last data line, so the joined data cap is 1 below what the doc comment says. Harmless; adjust the wording if precision matters.
7. sse-reader.ts:118. Awaiting `cancel` could block the error from propagating if an underlying source's cancel never settles. This is fine for fetch bodies. `void reader.cancel(...)` would avoid the wait.
