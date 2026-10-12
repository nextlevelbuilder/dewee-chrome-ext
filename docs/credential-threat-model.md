# Credential request threat model

Scope: how a person gives a secret (API key, password, token) to Dewee when an agent asks for one through a `secret_request` card, and how OAuth connections are started through an `oauth_request` card.

## Flow

1. An agent with `setup_operator`, or an agent granted a `credential_request` policy, emits a `dewee.ui-action.v1` card. The Gateway stores it.
2. The panel receives the card from the stream or from `GET /actions?status=pending`, validates it with Zod and renders `CredentialsForm`.
3. The person types the secret. The value lives only in the form component's local state.
4. Submit sends `{ response: { fields }, secret: { <key>: <value> } }` to `POST /actions/{id}/respond` and clears the inputs before awaiting the result.
5. The Gateway checks the human-actor gate and role, encrypts the secret into its credential store, and returns the card status, a non-secret `result` and an optional `continuation`. The agent continues with a credential reference, never the value.

## Threats and controls

| Threat | Control |
|---|---|
| Secret typed into chat | The form is the only secret input. Chat text is never inspected or rewritten; docs and the form tell people to use the card. |
| Secret persisted by the extension | No storage call carries a secret; secret fields are `type=password` with `autocomplete=new-password`. Tests check `storage.local`/`session` and runtime messages after a submit. |
| Secret in logs, URLs or telemetry | No telemetry. Secrets go only in a JSON body to one endpoint. Errors from the server never echo submitted values. |
| Secret passed between extension pages | The background message schema has no secret fields; the form calls the API directly. |
| Phishing card (agent pretends to be another service) | Field labels and destination names come from the extension's copy keyed by declared field and target type. Agent-provided text is plain text. The card shows the destination workspace. |
| Agent asks for a secret it should not have | Only `setup_operator` agents or agents with an owner-granted `credential_request` policy can create cards, and only for policy targets. Holding the policy never allows reading or approving a credential. |
| Automation or another agent submits a secret | Gateway human-actor gate: only a person with owner/admin rights can respond. |
| Duplicate submit or lost response | Respond is idempotent per card; the panel reloads the card after a network error or 409 and continues only through `setup_action_id`, delivered at most once. |
| Pending continuations kept across a switch or a closed panel | The panel stores only IDs in `storage.session` (profile id, workspace id, `session_key`, `agent_key`, `setup_action_id`), a boolean `held` flag and `in_progress_since` (a millisecond timestamp of the first 409 `continuation_in_progress`). These are not secrets and never include a card response or secret value. |
| Overwriting an existing credential by accident | Update mode needs an explicit rotate step. |
| Malicious OAuth link in a card | The panel shows the third-party notice and opens Dewee; completion is checked server side (`oauth_not_completed` until it is). |
| Rendering attacks (HTML/JS in card or markdown) | No agent HTML. Markdown is sanitized with DOMPurify, images dropped, only http(s)/mailto links, `rel="noopener noreferrer nofollow"`. |

## Residual risks

- A compromised browser or OS can read keystrokes; out of scope for the extension.
- The person can still paste a secret into chat on purpose. Dewee-side redaction is the backstop.
