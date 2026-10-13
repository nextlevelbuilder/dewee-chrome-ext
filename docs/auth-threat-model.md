# Authentication threat model

Scope: how the extension proves who the person is to Dewee, and how those credentials are kept.

## Assets

| Asset | Where it lives | Lifetime |
|---|---|---|
| Cloud access token (opaque, audience `dewee-extension`) | `storage.session`, or `storage.local` if "remember" | 15 min |
| Cloud refresh token (rotating, family revocation on reuse) | same as access token | server-defined |
| Self-hosted personal API key (`operator.read` + `operator.write`, owner-bound) | same rule | until revoked in Dewee |
| PKCE verifier and `state` | memory of the background worker during one flow | one flow |

The Dewee gateway master token is never accepted as an extension credential, and the UI asks for a personal key only.

## Threats and controls

| Threat | Control |
|---|---|
| Authorization code interception | PKCE S256; exact redirect URI `https://<extension-id>.chromiumapp.org/oauth2`; codes single-use, 60 s expiry. |
| CSRF / mix-up on the OAuth redirect | Random `state` compared in constant time; redirect origin and path checked before reading `code`. |
| Refresh token replay | Rotation on every refresh; a reused token revokes the family. The background runs renewals single flight so the extension itself never replays a rotated token. |
| Token theft from disk | Default storage is `storage.session` (memory, cleared when the browser closes). "Remember" is opt-in and its hint explains the trade-off. |
| Stolen token used from a web page | Routes accept bearer tokens only, never cookies; CORS reflects only configured `chrome-extension://` origins and never sends `Access-Control-Allow-Credentials`. |
| Token sent to the wrong host | Each profile has one origin; requests use `credentials: 'omit'`, `redirect: 'error'`; host permission is granted per origin. HTTPS is required except for loopback development. |
| Origin with embedded credentials (`https://user:pass@host`) | Rejected by `checkOrigin`. |
| Wrong workspace or tenant | Every call names the workspace; Dewee enforces membership and returns 404 for non-members. The client never falls back to another workspace or profile. |
| Expired or revoked credential | 401 → one renew (Cloud) → on failure the credential is cleared and the panel asks to reconnect that same profile. |
| Sign-out leaves a live token | Sign-out calls revoke (best effort) and clears both storage areas. Removing a profile also drops its host permission when no other profile uses the origin. |
| Messages from other extensions or pages | The background accepts messages only from its own extension id and validates them with Zod. It returns the `Authorization` value only to extension pages, which hold it in memory for the request. A network failure while renewing keeps the credential; only a 401 signs the profile out. |
| A web page abusing the "Ask Dewee" script | The script runs only when the person turns the feature on and grants site access. A message from it (a tab sender, top frame, non-extension URL) goes only to the selection handler: one schema-checked `ask.selection` that opens the panel and leaves a quoted draft in `storage.session`, never sent automatically. It never reaches the auth handlers or a credential. The page sees only a closed shadow-root button. |
| Page secrets carried into a draft | Selections inside inputs, text areas and editable regions are ignored. The address drops its fragment, user info and query values whose names look like credentials. The draft is plain text the person reads and edits before sending. |
| Remote code | Strict CSP (`script-src 'self'`), no `eval`, no remote scripts. |

## Residual risks

- Malware with access to the Chrome profile can read `storage.session` while the browser runs. Tokens are short-lived and revocable.
- "Remember" keeps the credential on disk in the Chrome profile; the person accepts this when they tick it.
- "Ask Dewee" needs read access to every https page while it is on. Turning it off removes the script, but Chrome keeps the site access until the person removes it in the extension settings, because removing it could also drop gateway origins covered by the same grant. `storage.local` is limited to extension pages where Chrome supports it.
- Self-hosted operators must allowlist the extension origin (`GOCLAW_ALLOWED_ORIGINS`) and keep API keys scoped.
