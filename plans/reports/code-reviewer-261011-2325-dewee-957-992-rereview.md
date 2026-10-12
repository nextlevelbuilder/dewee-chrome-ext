# Re-review: dewee 957 fix 7948bfe3 + 992 fix 3dd36e5a

Isolated, read-only review. Baselines: `code-reviewer-261011-2140-dewee-956-957-rereview.md` (N3) and `code-reviewer-261011-2230-dewee-992-993-review.md` (agent_key).

Runs:
- 957, vitest `src/lib/extension-api/`: 39/39 pass.
- 992, vitest `src/lib/extension-api/` + `runtime-sessions-client.test.ts`: 50/50 pass. `tsc --noEmit`: exit 0.
- 992, `go test ./internal/http -run 'ProvisioningHandlerSessions|ProvisioningWorkspaceSessions'`: ok. The same with `-tags sqlite` (incl. `AgentKeyUnderscoreIsLiteral`): ok.
- `go test -tags sqlite ./internal/store/sqlitestore -run Session`, `go test ./internal/store/pg -run Session`, `./internal/gateway/methods -run Session`: ok.
- `go test -tags sqlite ./internal/http -run 'Session|ChannelInstance'`: one failure, `TestProvisioningHandlerStreamContinuesExistingSessionWithMedia`. The cause is a Windows path inside a raw JSON literal (`invalid character 'U' in string escape`). It is unrelated to this diff and is tracked in dewee#936.
- `go clean -testcache` was run afterwards.
- "Fails without the fix" was established by reasoning, not by running against the parent commit, because the worktrees stay unmodified.

## 1. 7948bfe3: relay single terminal frame (N3)

**N3 is closed.** `extension-chat-relay.ts:143` now runs `if (!terminated) writeError(error)`.
- `terminated` is set in `write` (`:80`) for every terminal event, including relayed runtime frames, `chat.stopped` (`:125,:138`) and `writeError` itself.
- Every terminal path goes through `write`, so no path can emit two terminal frames.
- **The test fails without the fix.** `onCompleted` throws synchronously, before `.catch` attaches (`:133`). The error reaches the catch after `message.completed` was written. At the parent this appends `chat.error`, and `toEqual(["event: message.completed"])` fails. The test's second pull (`controller.error`) is never reached, because the loop breaks on the terminal event. It is harmless.

**The overall 957 branch (origin/dev...7948bfe3, 3 commits, `apps/dewee-app` + 2 docs only) has no unresolved blocking finding.**
- N1 and N2 are Gateway (Go) findings for 956. They are not in this diff.
- B1, B2, S1-S4, S6 and S7 were already closed.
- N4 (sessions fan-out) and S5 are replaced by #992. #992 is stacked on 7948bfe3, and 3dd36e5a's parent chain contains it.

### Blocking
None.
### Should-fix
- **Merge order.** The 957 branch alone still ships the 10-call fan-out (`apps/dewee-app/src/pages/api/extension/v1/workspaces/[workspaceId]/sessions.ts` at 7948bfe3, N4/S5). Land #992 with 957, or immediately after it. Do not release 957 by itself.
### Nit
- `extension-chat-relay.ts:141-143`: after a terminal frame, the caught error is dropped without a log. A synchronously throwing audit hook (`onCompleted`) or mark-ready failure then vanishes silently. Consider a server-side log of the error name (never the payload).
- The re-review nits that were already accepted are still open and unchanged: CORS `*` entry, workspaces N+1, `created_at` parity, refresh loser pair.

## 2. 3dd36e5a: NormalizeAgentID keys + LIKE escaping (992)

**The finding is fixed.**
- The Gateway uses `config.IsValidAgentID` (`internal/http/provisioning_sessions.go:118`), which is the same `validIDRe` as `NormalizeAgentID` (`internal/config/normalize.go:11,53`).
- The BFF regex (`sessions.ts:24`, `/^[a-z0-9][a-z0-9_-]{0,63}$/`) is identical.
- Neither regex is multiline, and `$` anchors at the end of input in both JS and Go.
- Both sides trim before validating.

**The LIKE escaping is correct.**
- PG (`internal/store/pg/sessions_list.go:39,45`):
  - The Go literal `"ESCAPE '\\'"` produces the SQL `ESCAPE '\'`, the same form as `pg/channel_contacts.go:85` and `pg/tracing.go:283`.
  - The values go through `pg.escapeLike` (`tracing.go:337`), which escapes `\`, `%` and `_` in a single pass, so `\` is handled correctly.
  - PG's default LIKE escape is already `\`, so the clause is explicit rather than required.
- SQLite (`internal/store/sqlitestore/sessions_list.go`, AgentID/Channel conditions):
  - SQLite has no default escape, so the clause is required here.
  - `'\'` is a single backslash, because SQLite literals have no backslash escapes.
  - `sqlitestore.escapeLike` (`memory_search.go:128`) replaces `\` first, then `%` and `_`. This is correct.
- Every value is still a bound parameter.

**The tests fail without the fix:**
- At the parent, the Go accept test and the TS `sales_bot` test get 400 or an empty list.
- In the sqlite test, without the escape, `agent:sales_bot:%` also matches `agent:salesxbot:...`, so total=2 and the test fails. This test does check the escape itself, not just the validation.

**Docs.** `docs/ccp-session-detail-inspection.md:17` and `docs/extension-oauth-and-bff.md:96` are accurate. No stale "slug" wording remains in `docs/` or `apps/dewee-app/src`.

**Regressions.**
- `buildSessionFilter` is shared by `methods/sessions.go`, `http/sessions.go`, `channel_instances_verify.go:274`, `usage.go` and the per-agent count.
- Escaping makes `_` and `%` literal for all of these callers. This is a correctness gain: for example, a channel instance named `my_bot` no longer matches `myxbot`, and a client-supplied `%` no longer acts as a wildcard (it was tenant-scoped anyway).
- No caller relies on wildcard semantics.
- The broader session test suites pass.

### Blocking
None.
### Should-fix
None.
### Nit
- **Keys of 65-100 characters.**
  - `internal/http/agents.go:247` creates agents with `isValidSlug`, which has no length cap. The column is `VARCHAR(100)` (`sqlitestore/schema.sql:251`).
  - Such a key is now refused: 400 at `provisioning_sessions.go:118`, and an empty list at `sessions.ts:35`. The previous slug check accepted it.
  - This is an edge case: CCP-created agents use `NormalizeAgentID` (64 characters or fewer).
  - Accept and document it, or cap `isValidSlug` agent keys at 64.
- **No PG-level test of the escape.** Only SQLite exercises it. `buildSessionFilter` in PG is pure, so a cheap check would assert the `ESCAPE` clause and the `agent:sales\_bot:%` argument (next to `pg/sessions_list_hidden_test.go`).
- **The PG `ESCAPE '\'` assumes `standard_conforming_strings=on`.** That is the default and the existing repo convention, so this is informational only.

Status: DONE
Summary: N3 is fixed correctly with a test that fails at the parent. The 957 branch has no unresolved blocking findings (N1/N2 are 956 Gateway findings, N4/S5 move to #992). The 992 fix accepts NormalizeAgentID keys on both sides with identical patterns, and it escapes LIKE correctly on PG and SQLite with a test that checks the escape.
Concerns/Blockers: Land #992 together with 957, or right after it, so the sessions fan-out does not ship alone. One sqlite http test fails for a known Windows reason (dewee#936). It is unrelated to this diff.
