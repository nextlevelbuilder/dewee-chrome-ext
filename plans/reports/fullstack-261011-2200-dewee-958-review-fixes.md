# dewee#958 review fixes

- Worktree: `D:/www/nextlevelbuilder/worktrees/dewee-958-credential-request-capability`
- Branch: `feat/958-credential-request-capability`
- Commit: **3b98e0c6** `fix(agents): re-check credential policy at respond and bound credential request cards`. It is on top of 13795e4d. Nothing was pushed and no PR was opened.
- Paths below are relative to the worktree.

## Findings

### B1: revocation reaches open cards

- **Marker.** A tool card's RequestedBy is set to `credential_request:<agentID>`, so no migration is needed. See `internal/store/credential_request_cards.go` (`CredentialRequestRequester`, `CredentialRequestCardAgent`).
- **Respond re-check.**
  - The check runs before the claim, at `internal/http/workspace_setup_respond_core.go:168`, through `tools.CredentialRequestCardDenial` (`internal/tools/credential_request_target.go:172`).
  - On failure it cancels the card and returns 409 with `details {reason: credential_policy_revoked, action_id}` (`internal/http/workspace_setup_credential_request.go:35`).
- **Sweep.**
  - `CancelRevokedCredentialRequests` (`workspace_setup_credential_request.go:62`) uses the new store method `ListOpenActionsByRequester`, implemented for PG and SQLite and covered by the conformance test.
  - HTTP calls it at `internal/http/agents_credential_request_policy.go:215`, wired at `cmd/gateway_http_wiring.go:339`. WS reaches it through the setup handler interface.
  - A sweep failure is logged and does not fail the write, because respond re-checks anyway.
- **TTL.** `CredentialRequestCardTTL = 1h` (`credential_request_cards.go:18`); the tool sets ExpiresAt (`internal/tools/credential_request_tool.go:221`).
- **Docs.** The CLI help (`cmd/agent_credential_policy_cmd.go`), OpenAPI, `docs/workspace-setup-onboarding.md:115`, the permission matrix and the CHANGELOG no longer say "open cards stay answerable".
- **Tests:**
  - `TestCredentialRequestLifecycleSQLite/respond_is_refused_after_the_policy_is_revoked`
  - `.../sweep_cancels_only_revoked_cards`
  - `TestCredentialRequestCardDenialFollowsTheCurrentPolicy`
  - `TestCredentialPolicyHTTPWriteSweepsRevokedCards`
  - `TestWSCredentialPolicyWriteBroadcastsAndSweeps`
  - `TestCredentialPolicyServerOffersTheRevocationSweep`

### B2: duplicates and spam

- **Dedup key.** `CredentialRequestStepKey` (`credential_request_cards.go:52`) is `credreq/` plus a sha256 of (agent, session, type, identifier, mode). An existing open card is returned, and the tool text says "already open ... no new card was created". Span metadata has `existing:true`.
- **step_id.** The step_id parameter is removed; any value the agent passes is ignored.
- **Caps.** `checkOpenLimits` (`credential_request_tool.go:243`) allows 3 open cards per (agent, session) and 10 per agent per tenant, with the message `credential_request.limit` in en, vi and zh. A dedup match passes before the caps are applied.
- **Tests:**
  - `TestCredentialRequestReturnsTheOpenCardForADuplicate`
  - `TestCredentialRequestIgnoresAnAgentChosenStepID`
  - `TestCredentialRequestCapsOpenCardsPerConversation`
  - `TestCredentialRequestCapsOpenCardsPerAgent`

### S1: a card never moves a plan step

- `stepProgressAfter` returns nil for a marked card or a `credreq/` step (`internal/http/workspace_setup_respond_appliers.go:235`).
- Test: `TestCredentialRequestLifecycle{SQLite,PG}/card_never_moves_a_plan_step`. It forges a step_id equal to a plan step. A mutation check (guard disabled) failed as expected with "moved to running".

### S2: roles

- **HTTP.** `requireTenantAdmin` runs on GET, PUT and DELETE (`agents_credential_request_policy.go:110`). A nil tenant store refuses.
- **WS.** `canManageTenantSettingsWS` runs in `resolveCredentialPolicyAgent` (`internal/gateway/methods/agents_credential_policy.go:97`); the tenant store is wired at `cmd/gateway_methods.go:29`.
- **Tests:**
  - `TestCredentialPolicyHTTPRefusesAMemberHoldingAnAdminScopedKey`
  - `TestCredentialPolicyHTTPWithoutATenantStoreRefuses`
  - `TestWSCredentialPolicyRefusesAMemberWithTheAdminRole`
  - The existing fixtures now use keys whose owners have the owner or admin role.

### S3: MCP scoping

- A policy entry needs exactly one of `server_id` (a canonical lower-case uuid) or `server_name` (`uiaction.IsCode`, at most 255). See `internal/store/agent_credential_request_policy.go:40,210`.
- The card must name a stored server by id; it is resolved and matched at creation and again at respond (`resolveMCPServerRef`, `credential_request_target.go:129`). The tool gets the MCP store at `cmd/gateway.go:556`.
- Tests: `TestCredentialRequestScopesMCPCardsToTheNamedServer`, plus new invalid cases in the policy store tests.

### S4: residual risk of CLI credentials

- Documented in `docs/workspace-setup-onboarding.md:133`: the value enters the agent's CLI environment and output is scrubbed only on an exact match.

### S5: end-to-end tests

- `TestCredentialRequestLifecycleSQLite` and `TestCredentialRequestLifecyclePG` cover four cases:
  - the real tool on a non-setup agent creates a card, a person answers it and it is applied; the result carries only a `credential_ref`, and no sentinel appears in the tool result, the card rows or the activity log;
  - revoke, then 409;
  - the sweep;
  - the plan-step collision.

### S6: docs and OpenAPI

- OpenAPI now describes:
  - the role wording and the 403 cases;
  - the respond 409 details;
  - the TTL, dedup and caps;
  - revocation;
  - the `server_id` and `server_name` schema fields.
- `node apps/dewee-docs/scripts/sync-openapi.mjs` was re-run. `--check` passes: 86 paths, and the hash matches the lock.

### N1: WS broadcast

- A WS policy write broadcasts `EventCacheInvalidate{agent, key}` (`agents_credential_policy.go:206`).

## Gates

| Check | Result |
| --- | --- |
| `go build ./...` in default, `-tags sqlite` and `-tags sqliteonly` | OK |
| `go vet` on http, gateway/methods, tools, store/..., i18n and cmd, in default/sqlite/sqliteonly, and on `integration sqliteonly` http | OK |
| `go vet -tags integration ./tests/integration` | 1 finding in the untouched `git_adapter_ssh_test.go:103`; identical on base |
| Focused `go test` in store/..., i18n, tools, gateway/methods, http, permissions and setup/..., in all 3 modes | 42 / 45 / 45 failures on head against 43 / 45 / 45 on base, compared by name in a temporary worktree of bd177a2d. No failure appears only on head. |
| `go test ./cmd -run 'CommandManifest\|CredentialPolicy\|CLIHelp\|Golden'` in all 3 modes | OK (no golden change needed) |
| `go test -tags integration ./tests/integration -run 'OpenAPI\|WorkspaceSetupStorePGConformance'` | OK, including `open_actions_by_requester` on PG |
| PG, `-tags 'integration sqliteonly'` | `TestCredentialRequestLifecyclePG` passes all 4 cases |
| gofmt on all branch files | clean except `pkg/protocol/methods.go`, which is unformatted on base too (not reformatted) |
| `go clean -testcache` | done |

**PG setup.** I used a throwaway `pgvector/pgvector:pg18` container, `dewee958-throwaway-pg` on 127.0.0.1:25958. It was started by me and stopped afterwards (`--rm`). Each test creates and drops its own database; goclaw_test and dewee_ext_e2e were not used. The existing `pgtest` container was not touched.

**Windows failures, all also failing on base bd177a2d (tracked in #936).** Union over the 3 modes:

- **Exec / CLI binary resolution:**
  - `TestCredentialedExecAcceptsAllowlistedEnvPrefix`, `TestCredentialedExecInjectsNonInteractiveModeForTheOperatorCLI`, `TestCredentialedExecSandboxUsesEffectiveWorkspaceMountAndContainerCwd`
  - `TestExecApprovalScopedPackageGrantRequiresFlagAndExactScope`, `TestExecApprovalTimeoutCanBeRedeemedOnceAfterDurableApproval`, `TestExecSandboxUsesEffectiveWorkspaceMountAndContainerCwd`, `TestExecToolExecuteUsesConfiguredHostTimeout`
  - `TestEffectiveSandboxWorkspace{AllowsMasterFallback,PrefersTenantWorkspace}`
  - `TestHumanOnlyDeweeCommandsBlockedForEveryAgent`, `TestHumanOnlyGuardIgnoresOtherBinaries`
  - `TestResolveAndMatchBinary{AllowsConfiguredAliasPath,FallsBackToRuntimeExecutableDirs,FindsGoogleWorkspaceRuntimeBinary}`
  - `TestSecureCLICheckBinary{FindsGoogleWorkspaceRuntimeBinary,FindsNpmPackageCliAlias,FindsRuntimeNpmBinary}`
  - `TestValidateExecCwd`
- **Setup policy (exec-based):**
  - `TestSetupPolicy{AllowsAutoClasses,ApprovalTokenRunsOnlyTheApprovedCommandOnce,BatchApprovalWindow,DeferredApprovalOnSQLiteStores,DenyArgsRefusalKeepsTheRetryToken,LeavesNonSetupOperatorsUnchanged}`
  - `TestSetupPolicy{ProtectsTheSetupOperatorFlag,RecordsAuditRows,RequiresApprovalForUngovernedBinaries,ReRequestAfterConcurrentApprovalPointsAtExistingToken,ReRequestRotatesTheRetryToken}`
- **Skills and paths:**
  - `TestBuildSkillInfo`, `TestBuildSkillInfo_FilePath{MayPointToSkillMarkdown,OverridesBaseDir}`
  - `TestSkill{BaseDirAcceptsDirectoryPath,BaseDirAcceptsSkillMarkdownPath,MarkdownPath,SlugDir}`
  - `TestSkillExportHTTP_SQLiteSingleSkillDownload`, `TestSkillExportImportRoundTripPreservesResourcesAndModes`
- **Files, provisioning and credentials:**
  - `TestFilesHandleServe_OpenThenSwapToSymlinkEscape_Returns404`
  - `TestProvisioningHandler{AcceptsWorkspaceChatMediaLegitRoundTrip,CleansUpMediaAfterChatTurn,StreamContinuesExistingSessionWithMedia}`
  - `TestPutUserCredential_SSHKeyCRLFNormalized`
- **Onboarding:** `TestWorkspaceSetupOnboardingFlowEndToEnd`, `TestWorkspaceSetupSecretLeakSweep`, and on PG `TestWorkspaceSetupOnboardingFlowPGEndToEndAndSecretSweep` (dewee exec "executable file not found").

Base only, flaky: `TestExec_GateDbTimeout_FailsClosed`.

## Concerns

- **Caps are a soft bound.** Two concurrent tool calls can both pass the count check before either insert, so a cap can be exceeded by the number of racing calls.
- **Check-to-apply window.** The respond re-check runs right before the claim. A policy change landing between the check and the apply is not caught, and the sweep skips cards already in `applying`.
- **Shared dedup key.** An `oauth_request` and a `secret_request` create for the same provider share one key (accepted by spec).
- **Behaviour change.** The policy routes now refuse any caller without owner/admin membership, including admin-scoped API keys with no owner user. The integration fixtures were updated to match.

## Re-review nits and rebase (2026-10-11)

Applied the nits from `code-reviewer-261011-2330-dewee-958-rereview.md` as commit `99b1241f` `fix(agents): tighten credential request dedup and respond re-checks` (Refs #958). Then I rebased onto origin/dev `5edde4e7`.

- **N1.** For update cards, the de-duplication key now includes the target record id, lower-cased (`CredentialRequestRef.RecordID`, `CredentialRequestStepKey`). Create keys are unchanged.
  - Test: `TestCredentialRequestUpdatesOfDifferentRecordsAreTwoCards`. Two updates of different providers create two cards, and the same id in upper case still returns the open card.
- **N2.** `workspace_setup_respond_core.go` re-checks the policy right after `ClaimAction`. On a refusal it cancels the card under the claim (`ResolveClaimedAction` → cancelled), or releases the claim if that cancel fails. It then returns 409 `credential_policy_revoked` and applies nothing.
  - Test: the SQLite/PG lifecycle case "respond is refused when the policy is revoked during the claim". A test-only `claimHookStore` wrapper clears the policy inside `ClaimAction`. No production seam was added.
  - The claim counts one attempt, so the card ends `cancelled` with `attempt_count = 1`.
- **N3.** `CredentialRequestCardDenial` returns the new reason `agent_inactive` when the agent's status is not `active`. A deleted (soft-deleted) agent is not found, so it falls under `policy_lookup_failed`.
  - Unit test: added to `TestCredentialRequestCardDenialFollowsTheCurrentPolicy`.
  - Lifecycle test: "respond is refused for a disabled or deleted agent". In both cases the response is 409 and the card is cancelled.
- **N4.** The docs now recommend `server_id` over `server_name`, because a name entry follows whichever server holds that name. Changed:
  - `docs/workspace-setup-onboarding.md`;
  - the CLI help (whose example now uses `server_id`);
  - the OpenAPI descriptions (re-synced, `--check` passes);
  - `CHANGELOG.md`.
  - The revocation, bounds and permission-matrix text now also describes the post-claim re-check, the agent-status check and the record id in the dedup key.

**Rebase.** The only conflict was in `CHANGELOG.md` (### Added), where I kept both the dev entries and the #958 entry. The OpenAPI spec did not conflict; `sync-openapi.mjs --check` passes after the rebase.

New hashes after the rebase (base `5edde4e7`):

| Commit | Hash |
|---|---|
| feat(agents): let admins grant a credential_request capability to agents | `84630a96` |
| feat(cli): add agent credential-policy get\|set\|clear | `a0f68cce` |
| docs: document the agent credential_request capability | `e4d3b1c5` |
| fix(agents): re-check credential policy at respond and bound credential request cards | `b76d60af` |
| fix(agents): tighten credential request dedup and respond re-checks | `3dfa2788` (HEAD) |

Gates after the rebase:

| Gate | Result |
|---|---|
| `go build ./...` (default, `sqlite`, `sqliteonly`) | OK |
| `go vet` on store/..., tools, http, gateway/methods, i18n and cmd (plus http and store under sqliteonly) | clean |
| Focused tests (store/..., i18n, tools, gateway/methods, http, permissions, setup/...) | 25 / 28 / 28 failures (default / sqlite / sqliteonly). Every one is in the #936 Windows list above (exec/CLI binary resolution, setup policy, symlink, SSH CRLF, onboarding exec), so there are no new failures. |
| `go test ./cmd -run 'CommandManifest\|CredentialPolicy'` | OK |
| `go test -tags integration ./tests/integration -run OpenAPI` | OK |
| `go clean -testcache` | done |

I did not re-run the PG lifecycle after the rebase. Its new cases use the same table and the same store calls, which pass on SQLite. Nothing was pushed and no PR was opened.