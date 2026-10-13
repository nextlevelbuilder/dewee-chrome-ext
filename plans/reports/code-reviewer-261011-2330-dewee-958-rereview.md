# Security re-review: dewee#958 fix commit 3b98e0c6

I re-reviewed `feat/958-credential-request-capability` (bd177a2d..3b98e0c6) in isolation and did not write this code. Paths are relative to `D:/www/nextlevelbuilder/worktrees/dewee-958-credential-request-capability`. Nothing was edited; `git status` is clean.

## Verdict
**Ready to merge from a security standpoint. Nothing is blocking.** Acceptance scenario D holds:
- A non-setup agent is refused unless it has an enabled policy, and only for allowlisted targets. The policy is re-read at call time and again at respond.
- Duplicate requests return the open card.
- Revoked, narrowed or expired cards are refused or cancelled.
- The agent only ever receives an action id or a `credential_ref`.

## How I checked
- Focused tests pass:
  - `internal/http` with `-tags sqlite` and `-tags sqliteonly` (`CredentialRequest|CredentialPolicy`);
  - `internal/tools`, `internal/store`, `internal/gateway/methods`;
  - `internal/store/sqlitestore` with `-tags sqliteonly` (`WorkspaceSetup`).
- I did not re-run PostgreSQL; the implementer's PG run is the only evidence for it.
- **Mutation checks.** I disabled each fix with `go test -overlay` using copies in the scratchpad, so the worktree was untouched. Every mutation made a test fail:
  - m1, no respond re-check (`workspace_setup_respond_core.go:168`): `TestCredentialRequestLifecycleSQLite` fails.
  - m2, caps disabled (`credential_request_tool.go:259`): the `...CapsOpenCardsPerConversation` and `...PerAgent` tests fail.
  - m3, step key made unique per call (`credential_request_cards.go:54`): `...ReturnsTheOpenCardForADuplicate` and `...IgnoresAnAgentChosenStepID` fail.
  - m4, HTTP `requireTenantAdmin` removed (`agents_credential_request_policy.go:110`): `...RefusesAMemberHoldingAnAdminScopedKey` and `...WithoutATenantStoreRefuses` fail.
  - m5, sweep turned into a no-op (`workspace_setup_credential_request.go:79`): the lifecycle sweep case fails.
  - m6, MCP match always true (`agent_credential_request_policy.go:202`): `...ScopesMCPCardsToTheNamedServer` fails.
  - m7, WS membership check removed (`agents_credential_policy.go:97`): `TestWSCredentialPolicyRefusesAMemberWithTheAdminRole` fails.
- S1 is covered by `credReqCardNeverMovesAPlanStep`. It forges `RequestedBy` with plan step id `provider.openrouter`, so it fails if the marker guard at `workspace_setup_respond_appliers.go:235` is removed.
- `go clean -testcache` was run afterwards.

## Prior findings
| ID | Status | Evidence |
|---|---|---|
| B1 | Fixed | The re-check runs before the claim (`respond_core.go:168`) and goes through `CredentialRequestCardDenial` (`credential_request_target.go:172`), which fails closed if the agent is missing, belongs to another tenant, has no policy, or the marker does not match `agent_id`. The sweep is wired for HTTP (`agents_credential_request_policy.go:215`) and WS (`agents_credential_policy.go:215`). The TTL is 1h (`credential_request_tool.go:221`). |
| B2 | Fixed | The dedup key is server-derived (`credential_request_cards.go:52`) and the agent's `step_id` is ignored. The caps are 3 per session and 10 per agent (`credential_request_tool.go:243-263`). Expired pending cards are excluded from the count (pg `workspace_setup_actions.go:201`, sqlite `:245`). |
| S1 | Fixed | `stepProgressAfter` returns nil when the card carries the marker or the `credreq/` prefix (`workspace_setup_respond_appliers.go:235`). |
| S2 | Fixed | HTTP routes check `requireTenantAdmin` (`agents_credential_request_policy.go:110`); WS checks `canManageTenantSettingsWS` (`agents_credential_policy.go:97`). A nil store refuses. |
| S3 | Fixed | The policy needs exactly one of `server_id` (canonical uuid) or `server_name` (`agent_credential_request_policy.go:161-175`). The card's server is resolved through the tenant-scoped `GetServer` (`pg/mcp_servers.go:80-86`), and this runs both at create and at respond. |
| S4 | Fixed (documented) | `docs/workspace-setup-onboarding.md:135`. |
| S5 | Fixed | The real tool, store and respond path run for a non-setup agent, with no secret on any surface. The suite also covers revoke, the sweep, the step collision, duplicates, caps, the role checks, and a PG mirror. |
| S6 | Fixed | The docs (lines 100-135), the CLI help and OpenAPI describe the role check, the 409 details, the TTL, the caps and MCP scoping. |
| N1 | Fixed | WS broadcasts `EventCacheInvalidate` (`agents_credential_policy.go:205-210`). |

## The implementer's concerns, by real risk
1. **The caps are soft. Low risk; acceptable.** A race needs parallel tool calls, and every racing call must still pass the allowlist. Within one session each distinct key (type, identifier, mode) gets at most one open card, because the `(tenant, session_key, step_id)` unique index covers the server-derived key. Overshoot is therefore bounded by the size of the allowlist, at most 32×2 keys, and the cards are only prompts that need a person. A transactional count or an advisory lock is not worth it now.
2. **The gap between re-check and claim is real but tiny. Low risk.** The sweep lists only `pending` cards (`workspace_setup_credential_request.go:76`). A policy write that commits after the re-check (`:168`) but before `ClaimAction` (`:173`), with its sweep running after the claim, lets that one answer apply. The window is microseconds, and it needs an admin answering at the same moment another admin revokes. A cheap hardening (Nit N2 below) is to re-run the denial after the claim and release or cancel the card on refusal. A stale `applying` claim swept back to `pending` is re-checked on the next respond.
3. **A shared dedup key for oauth_request and secret_request. Not a security issue.** The second call returns the first card, which is the same allowed target. This only affects function; see N1.
4. **Admin keys with no owner user are now refused. Correct, and consistent with respond.** Respond already requires `requireTenantAdmin`. Writes already needed a person, so the only behaviour lost is GET for ownerless keys. A system owner (`IsOwnerRole`) still bypasses the membership check, but writes stay person-only through `RequireCredentialPolicyEditor`.

## Can the agent reach the secret? No path found
- **Tool result.** `ForLLM` holds only the action id (`credential_request_tool.go:232-235`). `Data` is the envelope: payload, fields and target, never values.
- **Continuation and transcript.** `setupContinuation` sends `a.Result` (`workspace_setup_continuation.go:27-35`), which is a `SecretResult` or `OAuthResult` holding a `credential_ref`. A cancelled or refused card has no result and gets no continuation.
- **Logs, activity and spans.** They hold ids, kind, target type, identifier, mode, server name and denial reason (`credential_request_tool.go:267-312`, `workspace_setup_credential_request.go:36,52`). The lifecycle test asserts a sentinel is absent from tool results, card rows and the activity log.
- **Residual risk.** `cli_agent_credential` is documented as the remaining exposure (S4).

## Tenant isolation: holds
- The tool compares the agent's tenant with the context tenant (`:167`), and the re-check compares the agent's tenant with the card's (`credential_request_target.go:184`).
- `ListOpenActionsByRequester` adds `tenant_id` (pg `:200`).
- MCP, provider and channel lookups are tenant-scoped.
- The policy routes return 404 for another tenant's agent (`agents_credential_request_policy.go:129`), and the sweep refuses `uuid.Nil` (`workspace_setup_credential_request.go:64`).

## Migrations and the RequestedBy marker: none needed, and the marker is reliable
- Only the tool writes `credential_request:<uuid>` (`credential_request_tool.go:216`). `fillSetupActionRunLinks` keeps a requester the caller already set and otherwise writes `agent:` (`credentialed_exec_setup_policy_card.go:72-78`). The other writers are the concierge (user id or `system`, `workspace_setup_concierge_routes.go:144-149`), the setup policy and `ui_action` (`agent:`). None of them can produce the prefix.
- If a non-tool card did carry the prefix (for example a user id that literally begins with it), the re-check would fail closed: it would be refused or cancelled, never widened.
- A tool card cannot lose the marker: no update path rewrites `requested_by`. If `agent_id` disagrees with the marker, the card is denied (`credential_request_cards.go:43-45`).

## Blocking
None.

## Should-fix
None.

## Nit
- **N1. The dedup key leaves out the record id of an update card** (`credential_request_cards.go:52-55`; the identifier is the provider or channel *type*, see `credential_request_target.go:101-104`). Two update requests in one session, for two different Telegram instances or two providers of the same type, collapse into the first card. The agent is told the card for instance B "is already open", and the person rotates instance A. This is not an escalation, because both were allowed, but it is wrong. Add `tg.ID` to the key for `mode=update`.
- **N2. Re-check after `ClaimAction` as well** (`respond_core.go:173`): on a denial, cancel the card and refuse. This closes the narrow window described in concern 2.
- **N3. `CredentialRequestCardDenial` ignores the agent's status** (`credential_request_target.go:183-190`). Cards of a disabled or archived agent stay answerable for up to 1h. Consider denying when the status is not active.
- **N4. `server_name` matching follows renames.** A server later renamed to the allowlisted name (`agent_credential_request_policy.go:202`) becomes requestable. This is admin-controlled, so it is low risk; recommend `server_id` in the docs.

Status: DONE
Summary: All of B1, B2, S1-S6 and N1 are fixed and tested; mutation checks show each fix is guarded by a failing test. There is no secret path to the agent, tenant isolation holds, and the RequestedBy marker is reliable without a migration.
Concerns/Blockers: None blocking. Nits: the dedup key ignores the update record id (N1), an optional post-claim re-check (N2), agent status ignored at re-check (N3). PG was not re-run by me.
