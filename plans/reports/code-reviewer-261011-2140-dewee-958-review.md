# Security review: nextlevelbuilder/dewee#958 (credential_request capability)

Branch `feat/958-credential-request-capability` (c486f99c, a7ddbe71, 13795e4d on bd177a2d). I am an isolated reviewer and did not write this code. Paths below are relative to `D:/www/nextlevelbuilder/worktrees/dewee-958-credential-request-capability`. I verified each finding by reading the source; I ran no commands.

## Verdict
**Not ready to merge.** The policy surfaces themselves are sound:
- The policy cannot be written through a generic agent update or an import.
- Writes require an admin and a person; an agent credential is refused.
- Lookups are tenant-scoped, and the tool returns only an action id and, later, a `credential_ref`.

Two parts of acceptance scenario D still fail:
- "duplicate requests are rejected" is not implemented;
- "foreign-target requests are rejected" does not hold once a policy is revoked or narrowed.

## Blocking

**B1. A revoked or narrowed policy does not stop open cards. They can still be answered for 7 days.**
- Evidence:
  - The policy is checked only when the card is created (`internal/tools/credential_request_tool.go:230`).
  - `coreRespond` (`internal/http/workspace_setup_respond_core.go:137-185`) checks the human gate, tenant, expiry and payload, then runs the applier. It never re-reads the agent's policy.
  - The tool sets no `ExpiresAt`, so cards get `SetupActionDefaultTTL = 7 * 24h` (`internal/store/workspace_setup_store.go:79`).
  - The behaviour is intentional and documented (`cmd/agent_credential_policy_cmd.go:113`, OpenAPI DELETE description: "open cards stay answerable by a person").
- Failure scenario:
  1. A prompt-injected support agent has `channel_instance/telegram [update]`. It opens 20 update cards naming the production Telegram instance.
  2. The admin notices and runs `credential-policy clear`.
  3. Three days later another admin answers one of those cards. The applier rotates the production bot token.
  4. The same happens after an admin narrows the allowlist: cards for removed targets still apply.

  Revocation, which is the containment control, therefore does nothing to requests already issued.
- Fix (either option works; do both if possible):
  - Mark cards made by the tool, for example `RequestedBy = "credential_request:<agent_key>"`, which the store already has. In `coreRespond`, before `ClaimAction`, re-load the agent and re-run `resolveTarget` and `policy.Allows` on the stored payload. Refuse with 409 and cancel the card when it no longer matches.
  - When a policy is cleared or set, cancel open `pending` cards of that agent whose target is no longer allowed.
  - Also give tool cards a short TTL, such as 1 to 24 hours.
  - Add a test: create a card, revoke the policy, answer as owner, and expect a refusal with no provider row written.

**B2. Duplicate requests are not rejected, and nothing limits how many cards an agent can create.**
- Evidence:
  - The only de-duplication is the `(tenant_id, session_key, step_id)` partial unique index (`internal/store/pg/workspace_setup.go:140-146` and the sqlite mirror). It applies only when step_id is non-empty.
  - `step_id` is optional and chosen by the agent (`credential_request_tool.go:240`).
  - There is no per-agent, per-session or per-tenant limit on open cards, and no rate limit (the store has no limit check at all).
- Failure scenario: an agent calls `credential_request` in a loop without `step_id` (or with a new one each time). Every call stores a new 7-day secret card for the same target. The chat fills with identical credential prompts, which invites the user to answer a stale one, and the action table grows without bound. Acceptance D explicitly requires duplicates to be rejected.
- Fix:
  - Derive a server-side dedup key from the target, for example `credreq:<type>:<identifier>:<mode>:<id|name>`, and ignore or namespace the agent's `step_id`. An open card for the same target is then returned instead of a new one; `ErrSetupActionOpen` already supports this.
  - Cap open tool cards per agent and session (for example 3) and per tenant, and record `credential_request.denied` with reason `rate_limited`.
  - Add tests for both.

## Should-fix

**S1. A non-setup agent's `step_id` can move steps of the tenant's workspace setup plan.**
- Evidence: `applySecret` and `applyOAuth` run `stepProgressAfter` whenever `a.StepID != ""` (`internal/http/workspace_setup_secret_appliers.go:98-99`, `workspace_setup_respond_appliers.go:184-185`). `mutateSetupPlan` loads the tenant-wide plan (`workspace_setup_respond_appliers.go:193-206`). The step id comes straight from the agent (`credential_request_tool.go:240`).
- Scenario: a non-setup agent passes `step_id` equal to a plan step such as `provider`. When the person answers, the onboarding plan step moves to `running` or `done`. That is a capability only setup operators should have.
- Fix: never forward an agent-chosen `step_id` from this tool. Use the server-derived key from B2, with a prefix that cannot match a plan step.

**S2. The HTTP policy routes take their role from API-key scopes, not from tenant membership.**
- Evidence:
  - `adminMiddleware` is `requireAuth(RoleAdmin)` (`internal/http/agents.go:198-199`, used at `agents_credential_request_policy.go:72-74`). Its role comes from the key's scopes (`internal/http/auth.go:247,300,674`).
  - `apiKeyTenantMembershipOK` only checks that the key owner has some membership, at any role (`auth.go:413-437`).
  - The respond path additionally calls `requireTenantAdmin`, which checks for an owner or admin membership (`workspace_setup_handler.go:156`, `tenant_auth_helpers.go:22-33`).
  - The implementer's report says the HTTP routes use `requireTenantAdmin`. The code does not.
- Scenario: a user who was an admin and was demoted to member keeps an `operator.admin` key. Through HTTP they can still widen an agent's credential allowlist, but they can no longer answer cards.
- Fix: call `requireTenantAdmin(w, r, h.tenants)` (or `isTenantAdminCaller`) in `allowCredentialPolicyWrite` and in the GET handler. Check the WS `client.Role()` path the same way, and add a test for a key with admin scope held by a member.

**S3. An `mcp_server` grant covers every MCP server in the tenant.**
- Evidence:
  - The policy has no identifier for `mcp_server` (`internal/store/agent_credential_request_policy.go:107,145`).
  - The tool returns the target with an empty identifier for both the secret card and the OAuth card when `provider=="mcp"` (`credential_request_tool.go:270-272,293-294`), so `Allows` matches any `id` or `server_id`.
- Scenario: an agent granted MCP rotation for one server asks the user to re-key, or re-authorize, the tenant's other MCP servers, such as a GitHub server holding an admin token.
- Fix: require a `server_id` (or server name) in the `mcp_server` policy entry and match it against the card's `id` or `server_id`. Alternatively, document loudly that this grant covers all servers.

**S4. The claim "the agent can never read the key" is weaker for `cli_agent_credential`.**
- Evidence: the applied secret is injected into the agent's own SecureCLI environment, and the agent chooses the CLI arguments. Output is protected only by exact-value scrubbing (`internal/tools/credentialed_exec.go:663-665`).
- Scenario: a granted `gh` credential, followed by `gh auth token` or `gh api` echoing the token in another encoding, can expose it beyond exact-match scrubbing. I did not prove a specific bypass; this depends on SecureCLI deny rules.
- Fix: state this residual risk in `docs/workspace-setup-onboarding.md#agent-credential-requests`. Consider letting the policy grant `cli_agent_credential` only for presets that have token-printing subcommands denied.

**S5. The tests do not cover the security-relevant paths end to end.** Specifically:
- No test goes tool, then store, then respond with a non-setup agent. `credential_request_respond_human_gate_sqlite_test.go:1618` builds the card by hand with the Super Agent and the bootstrap key.
- No test covers revocation while a card is pending (B1), duplicates or spam (B2), or step_id collision with a plan step (S1).
- There is no PostgreSQL test for the jsonb SQL in `internal/store/pg/agents_credential_request_policy.go`; only sqlite has one.
- No test shows that `agents.update` (WS) or `PUT /v1/agents/{id}` with `other_config.credential_request` neither grants nor drops the policy. The store logic covers this, but the handler level does not.
- No test covers the self-evolution write in `internal/agent/evolution_guardrails.go:189`, which replaces `other_config`.

**S6. Docs and OpenAPI do not match the behaviour.**
- OpenAPI and docs say "tenant owner or admin", but the HTTP check is scope-based (S2).
- The 403 `setup_human_actor_required` uses the generic `Forbidden` response, so the `error.details` shape is not described.
- `docs/workspace-setup-onboarding.md` and the permission matrix do not say that open cards survive revocation, that cards last 7 days, or that an `mcp_server` grant covers all servers.
- The implementer's report contradicts itself (its "Status: not compiled" section versus its later Verification). Fix it before this goes to the PR description.

## Nit
- **N1.** WS writes invalidate the loop only on the local node (`internal/gateway/methods/agents_credential_policy.go:170`); HTTP broadcasts on the bus. This is safe, because the tool re-reads the policy, but on other nodes the tool stays visible until their cache expires. The same is already true of WS `agents.update`. Use the bus broadcast.
- **N2.** Pinned-version runs build the loop from snapshot `other_config` (`internal/agent/resolver_agent_version.go:214`), so tool visibility follows the snapshot, not the live policy. The execution check is live, so this is safe, but it is confusing. Compute `credentialRequest` from the live agent.
- **N3.** The card title and body are written by the agent (120 and 1000 runes, checked for secret-shaped text) and shown above a trusted secure form. A server-made header such as "Agent X requests: provider openai (create)" would make phishing-style wording obvious.
- **N4.** A generic update whose `other_config` is not an object (for example `[]`) silently drops the policy (`agent_credential_request_policy.go`, `TakeOtherConfigWrites`). This fails closed, but reject a non-object `other_config` at the handlers.

## Checks that passed (verified)
- **Agent or non-admin changing its own policy.**
  - HTTP `PUT` filters keys through `agentAllowedFields` (`internal/http/validate.go:43`), and WS `agents.update` uses a typed struct. Neither can send the virtual key.
  - An `other_config` replacement is stripped of the policy and keeps the stored one (`TakeOtherConfigWrites`). This covers evolution and version rollback.
  - `Create` strips the policy (`pg/agents.go:108`).
  - Writes require a person through the `RequireHumanActor` agent-held-key lineage scan.
  - The setup-policy CLI classes `set` and `clear` as Blocked.
- **Allowlist at card creation.** Checked after `uiaction.ValidatePayload`. The payload is re-marshalled from the typed struct, so the stored and applied payloads match. An update card's stored type must match the claimed type, and a CLI card must name the calling agent.
- **Cross-tenant isolation.** The tool compares `ag.TenantID` with the context tenant, the policy handlers return 404 / NOT_FOUND, the store writes add `AND tenant_id`, and the appliers check `p.TenantID != actor.TenantID`.
- **What the model sees.** The tool result is `ForLLM` with only the action id. The applier results are `SecretResult` / `OAuthResult`, which hold a `credential_ref` and no value.
- **Audit records.** Activity rows and span metadata hold only ids, kind, target type, identifier, mode, reason, session, run and trace. HTTP audit details hold `agent_key`, `enabled` and the target count.
- **Expired cards.** Refused (`workspace_setup_respond_core.go:157`).
- **Forbidden items untouched.** `setup_operator` is not widened, and the Origin, CSRF and human-actor guards are unchanged.

## Recommended order
B1, B2 and S1 (one change, with server-derived keys and a check at respond), then S2, S3, the S5 tests and the S6 docs.

## Unresolved questions
1. Is it intended that only tenant owners and admins can answer these cards? `respond` requires `requireTenantAdmin`, so a member chatting with the agent sees a card they cannot submit.
2. Can a tenant member mint an API key with admin scope? This sets how severe S2 is.

Status: DONE_WITH_CONCERNS
Summary: The policy management surfaces are sound (admin plus a person, tenant-scoped, the generic update path cannot grant). Two acceptance-D properties fail: open cards stay answerable for 7 days after the policy is revoked or narrowed, and duplicate or spam requests are not rejected or rate-limited.
Concerns/Blockers: B1 (no policy re-check at respond), B2 (no server-side dedup or cap). Should-fix: plan step_id hijack (S1), HTTP role taken from key scopes (S2), MCP grant covers all servers (S3), missing end-to-end, revoke and PostgreSQL tests (S5).
