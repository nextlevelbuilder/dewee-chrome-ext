# dewee#958 credential_request capability: implementation report (verified and committed locally, see Verification)

Worktree: `D:/www/nextlevelbuilder/worktrees/dewee-958-credential-request-capability`, branch
`feat/958-credential-request-capability` (base `origin/dev`). Committed locally (see Verification); no push, no PR.

## Status
All five items are written. They have not been compiled, tested or committed: no command could run.
- The Bash tool fails on every command, including `git status`, with
  `/usr/bin/bash: -c: line 157: unexpected EOF while looking for matching '"'`.
- The coordinator said to use the PowerShell tool instead, but this agent has no PowerShell tool.
- I did not touch user or global config, so I did not repair the hook.

Everything listed as verified below was verified before the shell broke.

## Verified earlier (build and tests passed)
- **Policy model** (`internal/store/agent_credential_request_policy.go`):
  - strict decode; unknown fields and trailing data are refused;
  - an enabled policy needs at least one target, and there are at most 32;
  - each type requires exactly its own identifier, in code form;
  - `mcp_server` is update-only, and duplicate entries are refused;
  - an invalid stored policy is read as disabled.
- **Store writes**: the policy can only be written through the virtual key `credential_request_policy` (pg and sqlite). A full `other_config` write neither drops nor injects it, and `Create` strips it.
- **Tool `credential_request`** (`internal/tools/credential_request_tool.go`):
  - gates on tenant, master scope, app channel, session, agent and the policy, which is re-read on every call;
  - runs uiaction validation;
  - checks the allowlist, that a CLI credential belongs to the calling agent, and that the stored type matches on update;
  - persists through `recordAgentCard` with AgentID, run id and trace id;
  - writes span metadata and `credential_request.requested`/`.denied` activity rows with no secrets.
  - Tests are in `credential_request_tool_test.go`.
- **Loop visibility**: the tool is hidden unless the policy is enabled (`internal/agent/loop_setup_operator.go`, with a test).
- **HTTP** (`internal/http/agents_credential_request_policy.go`, `GET|PUT|DELETE /v1/agents/{id|key}/credential-request-policy`):
  - Admin-only: operator and viewer get 403, and another tenant's agent gets 404.
  - Writes are person-only (403 `setup_human_actor_required`); a missing gate gives 503 and an invalid policy 400.
  - Writes are audited and invalidate the cache.
  - Tests passed on the default build only; `-tags sqliteonly` was not run.
- **Wiring and i18n**: wiring in `cmd/gateway.go`, `cmd/gateway_builtin_tools.go` and `cmd/gateway_http_wiring.go`; i18n keys in en, vi and zh.

## Written after the shell broke (not compiled, not run)
1. **WS RPC**:
   - three methods in `pkg/protocol/methods.go`: `agents.credential_policy.get`, `.set` and `.clear`, also mirrored in `ui/web/src/api/protocol.ts`;
   - the methods are added to `isAdminMethod` in `internal/permissions/policy.go`, with a test in `credential_policy_methods_test.go`;
   - handlers in `internal/gateway/methods/agents_credential_policy.go`, registered from `agents.go`. They resolve the agent by id or key, require the tenant to match (NOT_FOUND otherwise), and use the same `RequireCredentialPolicyEditor` gate as HTTP via `setupGateContext`;
   - tests in `agents_credential_policy_test.go`: admin and owner can set, get and clear; operator and viewer are refused; cross-tenant gets NOT_FOUND; a gate refusal returns its details; a nil gate gives UNAVAILABLE; invalid policies fail validation.
2. **CLI `dewee agent credential-policy get|set --file <f|->|clear`** (`cmd/agent_credential_policy_cmd.go`, registered in `cmd/agent.go`):
   - `set` validates locally before calling the gateway;
   - `set` and `clear` are human-only, and the setup policy classes them as blocked (`internal/setup/policy/dewee_rules.go`); `get` is classed as read;
   - hand-edited the generated files: the golden manifest (`cmd/testdata/command-manifest.golden.json`) and the command tree (`internal/setup/policy/command_tree_generated.go`);
   - updated `setup_policy_manifest_test.go` and `cli_parity_matrix_test.go`;
   - new test `cmd/agent_credential_policy_cmd_test.go`: request paths and bodies, stdin input, invalid policy refused before any request, and table output.
3. **Respond-path test** `internal/http/credential_request_respond_human_gate_sqlite_test.go`:
   - a card with AgentID set is refused for the agent's own key (403 `setup_human_actor_required`);
   - the card stays pending, no provider row is written, and no sentinel secret leaks;
   - the owner's answer then applies.
4. **Docs**:
   - `docs/03-tools-system.md` (tool row)
   - `docs/23-ai-agent-permission-matrix.md` (layer row and security note)
   - `docs/workspace-setup-onboarding.md` (new section "Agent credential requests")
   - `docs/ccp-cli-command-parity-matrix.md` (new row)
   - `docs/cli-agent-contract.md` (human-only note)
   - `docs/04-gateway-protocol.md` and `docs/19-websocket-rpc.md` (method rows)
   - `internal/http/openapi_spec.json` (new path and two schemas)
   - `CHANGELOG.md` (an "Added" entry)

## Verification still to run
Done; see Verification below.

## Risks in the unverified code (all resolved, see Verification)
- **Gateway handlers**:
  - `internal/gateway/methods` imports `internal/http` (other files there already do);
  - the gate is found by asserting `client.SetupApprovalHumanGate()` to `RequireHumanActor`; if the server's gate type lacks that method, writes refuse with UNAVAILABLE unless `SetCredentialPolicyHumanGate` is wired. That is fail-closed, not a leak, but it should be checked in `cmd/gateway*.go`.
- **Golden manifest**: entries are hand-written. Likely drift points are the `stdin` annotation text for `set` and the exact `usage`/`args` rendering of `set <agentId|agentKey> --file <policy.json|->`.
- **WS test fake store**: `wsPolicyAgentStore` must satisfy the full `store.AgentStore` interface (it embeds the interface, so this should compile).

## Deviations
- The CLI is under the existing `dewee agent` group (singular).
- HTTP `DELETE` and WS `clear` back the CLI `clear` command.

## Verification (2026-10-11, Windows 11, PowerShell)
**Commits** on `feat/958-credential-request-capability` (local only, nothing pushed, no PR). Each ends with the Co-Authored-By line.
- `c486f99c` feat(agents): let admins grant a credential_request capability to agents
- `a7ddbe71` feat(cli): add agent credential-policy get|set|clear
- `13795e4d` docs: document the agent credential_request capability

**Build and vet**
- `go build ./...`, plus `-tags sqlite` and `-tags sqliteonly`: clean.
- `go vet` on cmd, store, tools, http, gateway/methods, permissions, setup/policy and agent (also sqliteonly for http and sqlitestore): clean.

**Generated artifacts, regenerated instead of trusted**
- `go test ./cmd -run CommandManifest -update` produced exactly the hand-edited golden.
- `UPDATE_SETUP_POLICY_COMMAND_TREE=1 go test ./internal/setup/policy -run TestCommandTreeMatchesManifest`, the go:generate line run directly because it uses `sh -c`, produced exactly the hand-edited tree.
- `node apps/dewee-docs/scripts/sync-openapi.mjs`: the public copy and `spec.hash.lock` are updated. Every earlier spec change in the repo did the same, and `tests/integration/openapi_contract_test.go` enforces it.

**Fixes made**
1. *OpenAPI path parameters.* The new path declared `parameters` at path level. That broke the existing narrow decoder in `TestOpenAPIWorkspaceSetupActionListKindEnumMatchesGo`, which is a new failure versus baseline. The repo's convention is per-operation parameters (no other path uses path-level ones), so I moved `id` into get, put and delete. I re-inserted the entries as text into the HEAD spec so other response keys were not reordered. The synced hash is unchanged, so the content is semantically identical.
2. *gofmt.* A lone `"agent credential-policy get"` line in `internal/setup/policy/dewee_rules.go` had broken gofmt alignment; I joined it onto the next line. `pkg/protocol/methods.go` was already unformatted at HEAD; I left it alone.
3. *Security test.* Added `TestCredentialPolicyServerGateOffersRequireHumanActor` in `agents_credential_policy_test.go`. It mirrors the runtime assertion from `gateway.SetupApprovalHumanGate` to `RequireHumanActor`.

**Focused tests: all pass**
- `go test ./internal/setup/policy/`
- `go test ./internal/gateway/methods/` (the whole package, 4 CredentialPolicy tests)
- `go test ./internal/permissions/` and `./internal/i18n/`
- `go test ./internal/tools/ -run CredentialRequest`, `./internal/store/... -run CredentialRequest`, `./internal/agent/ -run SetupOperator`
- `go test -tags sqliteonly ./internal/store/sqlitestore/ -run CredentialRequest` (3 tests)
- `go test -tags sqliteonly|sqlite|default ./internal/http/ -run 'CredentialRequest|CredentialPolicy|OpenAPI'` (6 tests, including the respond human gate)
- `go test ./cmd/ -run 'CredentialPolicy|CommandManifest|SetupPolicy|HumanOnly|CLIParity'` (16 tests)
- `go test ./tests/integration/ -run OpenAPI`
- `ui/web`: `pnpm install --frozen-lockfile; pnpm exec tsc -b` exits 0.

**Windows-only failures, all pre-existing (nextlevelbuilder/dewee#936).** I compared against a temporary `git worktree` at the merge-base `bd177a2d`, removed afterwards. The sorted lists of failing tests are identical for `./internal/tools ./internal/agent ./internal/store` (37 lines each) and for `./cmd` plus sqliteonly `./internal/http ./internal/store/sqlitestore`. The only exception was the OpenAPI test, fixed in item 1.
- tools: exec, sandbox and setup-policy exec tests, `TestValidateExecCwd` and `TestResolveAndMatchBinary*` (C:\ paths, no `.exe`).
- store: `TestSkill*Path`/`Dir` (path separators).
- agent: `TestGetForRunEvictsLeastRecentlyUsedPinnedLoops` (fails on baseline too).
- http: `TestWorkspaceSetupSecretLeakSweep` and `TestWorkspaceSetupOnboardingFlowEndToEnd` (`exec: ...\dewee: executable file not found`), `TestPutUserCredential_SSHKeyCRLFNormalized` ("UNPROTECTED PRIVATE KEY FILE" ACL), `TestSkillExport*` (lost exec mode), `TestProvisioningHandler*Media` (`invalid character 'U' in string escape` from a C:\Users path in JSON), `TestFilesHandleServe_*Symlink*`, `TestRGDGrantKeySourceErrors`.
- cmd: `TestOnboardEnvFileSurvivesShellSourcing` and `TestShellQuoteEnvValueRoundTripsThroughBash` (bash exit 127), `TestSecureCLICheckBinaryFinds*`.

**Security review**
- *WS person-only gate.* The server sets `setupApprovalGate` only in `SetWorkspaceSetupHandler(*httpapi.WorkspaceSetupHandler)`, and that type has `RequireHumanActor` (`workspace_setup_actor_gate.go`). The type assertion therefore succeeds in production, so writes are not permanently UNAVAILABLE. A nil gate fails closed. The new test above guards this.
- *Owner/admin only.* The methods are in `isAdminMethod`, and the handlers re-check `HasMinRole(admin)`. HTTP uses `requireTenantAdmin`. Tests refuse operator and viewer.
- *Cross-tenant.* The agent is resolved in the caller's tenant and `ag.TenantID` must equal the context tenant, else NOT_FOUND (WS) or 404 (HTTP). Tests cover this.
- *Agents.* Policy writes are person-only on HTTP and WS, and the CLI `set` and `clear` are ClassBlocked for setup agents. The tool only creates a card. Card respond goes through `httpHumanGatedActor` (tenant admin plus human gate), and the sqlite test proves the requesting agent's key is refused with no provider row and no secret echoed.
- *Secrets.* Tool logs, span metadata and activity rows carry kind, target type, identifier, mode and action id only. Policy handlers log tenant and agent ids and error causes. Policies contain no secrets.
