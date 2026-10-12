# dewee#1019: revoke reason and system-actor policy writes

PR: https://github.com/nextlevelbuilder/dewee/pull/1019 (branch feat/958-credential-request-capability, base dev)
Worktree: D:/www/nextlevelbuilder/worktrees/dewee-958-credential-request-capability

## Commits (pushed, no force)
- 240d567a fix(agents): keep credential_policy_revoked on cards cancelled by a policy change
- 6336ced3 fix(agents): refuse credential policy writes from the system identity (Closes #1035)
- eaf3f299 docs(agents): document the system_actor refusal and the kept revoke reason
- dd164d71 fix(agents): audit the cause of a refused WebSocket credential policy write (review follow-up)

## Problem 1: the revoke reason is kept
- Re-check cancels (before the claim and after it) and sweep cancels store `{"reason":"credential_policy_revoked"}` as the card result.
- `respondToClosed` returns the same 409 FAILED_PRECONDITION with `details{reason, action_id}` for those cards.
- Other closed cards (cancelled by a person, expired, plain cancel) return the plain 409 with no reason.
- `setupContinuation` skips cancelled cards, so the stored reason never reaches the model.

## Problem 2 (#1035): writes as the system identity are refused
- `RequireCredentialPolicyEditor` refuses user id "system" with 403 `setup_human_actor_required`, cause `system_actor`.
- This covers HTTP PUT/DELETE and WS set/clear (WS now passes `client.UserID()` to the gate). Reads are still allowed.
- Refusals are audited as `refused_not_human` with the cause on both HTTP and WS.
- The CLI prints a hint: use the owner's or admin's `DEWEE_API_KEY`, or `--user-id`.
- CLI decision (written up in the PR): a real owner still works through an owner-bound personal key, or through the gateway token plus `--user-id`/`GOCLAW_GATEWAY_USER_ID`. This is the same model as the web login. Only the anonymous "system" identity is refused.

## Tests
- New lifecycle tests (SQLite; the same list also runs on PG):
  - respond after the sweep returns the reason;
  - repeated respond after the re-check returns the reason, both before and during the claim;
  - other closed cards return no reason.
- New HTTP and WS system-actor tests:
  - PUT/DELETE and set/clear are refused, with no writes and no sweeps;
  - GET still works;
  - the audit includes the cause;
  - an owner/admin user and the admin key still succeed.
- CLI hint test row added.
- Revert proof with `go test -overlay`: each new test fails with its fix reverted.
  - Reverted pieces: no stored result, no closed branch, a too-loose reason check, no system check, no WS user id, no hint, the WS audit without its cause.
- Gates:
  - `go build ./...` passes for default, `-tags sqlite` and `-tags sqliteonly`.
  - `go vet` is clean (default and sqlite) on http, methods and cmd.
  - OpenAPI synced: `sync-openapi --check` passes; the tests/integration TestOpenAPI* tests pass.
  - The focused 958 tests pass, as do the methods and store suites.
- Pre-existing Windows-only failures, unrelated to this change:
  - http: ssh key perms, exec without .exe, symlink;
  - cmd: bash/sh and file perms;
  - tools: exec/binary resolution.

## Docs
- OpenAPI updated (PUT description, `cause` enum adds `system_actor`, respond description); the docs-app copy and hash lock were regenerated.
- docs/workspace-setup-onboarding.md, docs/09-security.md, docs/23-ai-agent-permission-matrix.md, docs/cli-agent-contract.md.

## PR and issue
- PR body: both fixes added under Summary, Behaviour changes and Test plan; `Closes #1035` added; the trailing generated line is kept.
- #1035: label `done` (there was no previous status label), assigned @me (mrgoonie).
- `go clean -testcache` done.

## Review (fresh-context code-reviewer)
- No blocking findings. Fixed: the WS audit now carries its cause.
- Not fixed (non-blocking):
  - the "system" literal is repeated across auth/router;
  - when the cancel race is lost, the response still says "revoked";
  - `customer_session` is missing from the cause enum and the CLI hint (pre-existing);
  - the TS clients don't map `system_actor`;
  - there are no tests for a "system"-owned API key or for the no-auth fallback.

## Concerns
- No local Postgres was available, so TestCredentialRequestLifecyclePG was not run here; CI will cover it.
- The reviewer could not run commands (its shell was broken), so it reviewed the file state, not the diff. I ran the gates myself.
