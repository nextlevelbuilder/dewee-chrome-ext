# Connected browser relay contract (v1)

The wire contract between the Dewee Gateway and the Dewee Chrome Extension for the
connected browser: Dewee agents drive tabs in a person's own Chrome through the
extension. The design decisions and threat model are in
[adr-026-connected-browser.md](https://github.com/nextlevelbuilder/dewee/blob/dev/docs/adr/adr-026-connected-browser.md). This file is the
contract both repositories build against; change it in both places together.

## Principles

- The extension is an executor, never an agent. It runs a fixed set of semantic
  actions bundled in the extension. It never runs JavaScript, CDP methods or
  selectors that arrive over the wire as code.
- Identity comes only from the authenticated WebSocket connection: an
  owner-bound personal API key (self-hosted) whose owner is the principal. A
  device id, tenant id or user id sent by the client is a lookup key, never proof.
- Enrolling a device grants nothing. A **grant** is created only from the
  device's own authenticated connection after the person approves it in the
  extension. The Gateway enforces the grant before dispatch; the extension
  enforces it again (plus Chrome host permissions) before execution.
- No silent fallback. `browser` with `target: "connected"` never runs on the
  managed (server) browser, and the managed default never reaches a person's
  Chrome.
- Side effects are never replayed. A command whose result is lost after it may
  have run returns `outcome_unknown`; the agent must re-snapshot.

## Transport

The extension's service worker opens `wss://<gateway-origin>/ws` (or `ws://` for
loopback) and sends the standard first frame:

```json
{"type":"req","id":"1","method":"connect","params":{"token":"<personal API key>","client":"dewee-chrome-ext","version":"<ext version>"}}
```

Only API keys with `operator.write` that are bound to one user by credential may
use the `browser.*` relay methods. The gateway master token, unbound keys,
pairing-code connections and customer principals are refused with
`UNAUTHORIZED` (the Gateway protocol's code for a caller that is not allowed).
When the tenant has not enabled the feature, `browser.device.enroll`,
`browser.device.attach`, `browser.device.heartbeat` and `browser.grant.create`
return `FAILED_PRECONDITION`; listing, renaming and revoking devices and grants,
`browser.control.state` and command ack/result stay available so access can
always be seen and removed. Bad params are `INVALID_REQUEST`, another user's
device or grant is `NOT_FOUND`, and limits are `RESOURCE_EXHAUSTED`.

Frame size: the Gateway reads frames of at most 512 KB until
`browser.device.attach` succeeds on the socket, then at most 2.2 MB (room for a
1.5 MB screenshot as base64). A new `connect` on the same socket restores 512 KB.

Keepalive: the extension sends `browser.device.heartbeat` every 20 s (this also
keeps the MV3 worker alive, Chrome 116+). A device is offline 45 s after its last
heartbeat or when its socket closes. Reconnect uses exponential backoff
1 s → 30 s with jitter.

## Methods (extension → Gateway)

All params are strict objects; unknown fields are rejected.

| Method | Params | Result |
|---|---|---|
| `browser.device.enroll` | `{name, platform, capabilities:["standard"] \| ["standard","advanced"]}` | `{device_id}` (server-generated, random) |
| `browser.device.attach` | `{device_id, capabilities}` | `{device_id, grants:[Grant]}`. Binds this socket as the device's live connection. The extension enrolls with what its build can do and sends on every attach what is usable now (`advanced` only while the person has Advanced mode on); it re-attaches on the same socket when that changes. Refused (`NOT_FOUND`) unless the device belongs to the authenticated principal and tenant and is not revoked. A newer attach replaces an older socket. |
| `browser.device.heartbeat` | `{device_id}` | `{}` |
| `browser.device.list` | `{}` | `{devices:[Device]}` (the principal's devices in this tenant) |
| `browser.device.rename` | `{device_id, name}` | `{device}` |
| `browser.device.revoke` | `{device_id}` | `{}`; revokes its grants, cancels in-flight commands, closes its socket. |
| `browser.grant.create` | `{device_id, agent_ids:[uuid,...], origins:["https://example.com",...], capabilities:["browser.read"] \| ["browser.read","browser.control"], ttl_seconds}` | `{grant}` |
| `browser.grant.list` | `{device_id}` | `{grants:[Grant]}` |
| `browser.grant.revoke` | `{grant_id}` | `{}`; in-flight commands under it are cancelled. |
| `browser.command.ack` | `{command_id}` | `{}`; the extension accepted the command. It starts executing only after this response; an error response (`NOT_FOUND` once the Gateway already finished the command) means it must not run. |
| `browser.command.result` | `{command_id, ok:true, result}` or `{command_id, ok:false, error:{code, message}}` | `{}` |
| `browser.control.state` | `{device_id, state:"active" \| "paused" \| "stopped"}` | `{}`; local Pause/Stop. Both `paused` and `stopped` cancel in-flight commands (the extension cancels them locally and may send no result). While not `active` the Gateway refuses new commands with `device_paused`. The state survives a re-attach (Gateway memory); the extension still re-sends it after attach, which also covers a Gateway restart. |

Limits: `ttl_seconds` 60–28800 (default 3600); ≤ 20 origins and ≤ 20 agents per
grant; origins are exact canonical `scheme://host[:port]`: lowercase, https (or
http only for loopback), no default port, path, trailing slash or wildcard, no
repeats. Internationalized hosts are sent in punycode (`xn--...`, the form
`URL.origin` gives); a trailing dot or a host over 253 characters is refused.
A non-canonical origin is refused (`INVALID_REQUEST`), never rewritten.
At most 10 devices per user and 20 active grants per device.
`browser.grant.create` is accepted only from the device's own attached socket,
and fails (`NOT_FOUND`) once the device is revoked. Every `agent_ids` entry must
be an agent of the person's tenant that the person owns, or the tenant's default
agent: unknown agents are `INVALID_REQUEST`, agents shared by another person are
`UNAUTHORIZED`. Device names are at most 100 bytes and may not contain Unicode
control or format characters (line breaks, bidi overrides, zero-width
characters).

Object shapes (every field always present unless marked optional):

```json
Grant  {"id":"<uuid>", "device_id":"<uuid>", "agent_ids":["<uuid>"],
        "origins":["https://example.com"], "capabilities":["browser.read"],
        "created_at":"<RFC3339>", "expires_at":"<RFC3339>"}
Device {"id":"<uuid>", "name":"...", "platform":"...", "capabilities":["standard"],
        "created_at":"<RFC3339>", "last_seen_at?":"<RFC3339>", "online":true,
        "state?":"active|paused|stopped"}
```

`grant.create` returns exactly the requested origins, in request order.
`attach`, `grant.create` and `grant.list` return active grants only. The
extension ignores a grant without `device_id` or whose origins differ from what
the person approved.

## Event (Gateway → extension)

```json
{"type":"event","event":"browser.command","payload":{
  "command_id":"<uuid>", "device_id":"<uuid>", "grant_id":"<uuid>",
  "agent_id":"<uuid>", "agent_name":"Super Agent", "channel":"telegram",
  "action":"snapshot", "params":{...}, "class":"read",
  "deadline":"2026-10-14T15:00:00Z"
}}
```

Events `browser.command.cancel` `{command_id}` and `browser.grant.revoked`
`{grant_id}` and `browser.device.revoked` `{device_id}` are also sent.

The extension must `ack` within 5 s or the Gateway fails the command with
`device_unresponsive` (safe: not executed); a socket that drops before the ack
fails it with `device_offline`. To keep "not executed" true, the extension never
starts work before the Gateway answered its `ack`. A rejected ack, a closed
socket or a request timeout means the command does not run: after `NOT_FOUND`
no result is sent, after any other failure the extension sends a best-effort
`cancelled` result. A cancel that arrives while the ack is pending stops the
command before it runs. After `ack`, a missing result by the deadline yields
`outcome_unknown` for `interact` actions and `timeout` for reads.
The extension does not queue results across reconnects: when the socket drops
after `ack`, the Gateway reports `outcome_unknown` (interact) or `cancelled`
(read) and never re-sends the command. `agent_name` carries the agent key.
Command deadlines default to 30 s and are capped at 120 s.

## Actions

`tab` is an opaque tab handle issued by the extension (`t1`, `t2`, ...), scoped
to the device session. Raw `chrome.tabs` ids never leave the extension. Only tabs
the agent opened under the grant ("owned tabs") can be driven; `tabs` lists only
owned tabs. The Gateway also binds each tab handle to the grant whose `open`
returned it (kept across reconnects until `close` or device revocation) and
sends later commands on that tab under that grant only; a tab no grant opened is
`tab_not_owned`.

| Action | Class | Params | Result |
|---|---|---|---|
| `tabs` | read | `{}` | `{tabs:[{tab, url, title, active}]}` |
| `open` | interact | `{url}` | `{tab, url, title}` |
| `navigate` | interact | `{tab, url}` | `{tab, url, title}` |
| `snapshot` | read | `{tab, max_chars?}` (default 20000, max 60000) | `{tab, url, title, generation, text}` |
| `click` | interact | `{tab, ref, generation}` | `{tab, url, title}` |
| `type` | interact | `{tab, ref, generation, text, submit?}` | `{tab, url, title}` |
| `press` | interact | `{tab, key}` (Enter, Tab, Escape, ArrowUp/Down/Left/Right, Backspace, PageUp/PageDown, Home, End) | `{tab}` |
| `scroll` | read | `{tab, direction:"up"\|"down", amount?:"page"\|"half"}` | `{tab}` |
| `wait` | read | `{tab, ms}` (≤ 10000) or `{tab, text}` (appears within 10 s) | `{tab}` |
| `close` | interact | `{tab}` | `{}` |
| `screenshot` | read | `{tab}` — **advanced capability only** | `{tab, url, mime:"image/jpeg", data_base64}` (≤ 1.5 MB) |

Every `url` (requested and after navigation/redirect) must match a grant origin;
otherwise `origin_not_granted`. `url` is required in the `open`, `navigate`,
`snapshot`, `click`, `type` and `screenshot` results; the Gateway withholds a
result without it (`internal`). `chrome://`, `chrome-extension://`, the Chrome
Web Store, `file:`, `data:`, `javascript:`, `about:` (except `about:blank` while
opening) are always refused (`restricted_page`).

Snapshot text is a compact accessibility outline, one element per line:
`[e12] button "Sign in"`, `[e13] textbox "Email" value=""`. Refs are valid only
for the `generation` they came from; a navigation, reload or large DOM change
bumps it and stale refs fail with `stale_ref`. Password fields, hidden inputs and
`autocomplete="cc-*|one-time-code"` values are never included (`value=[redacted]`).
`type` into a password or payment field is refused (`sensitive_field`) in v1.

## Error codes

`permission_denied`, `device_offline`, `device_paused`, `device_unresponsive`,
`no_grant`, `grant_expired`, `grant_revoked`, `origin_not_granted`, `capability_not_granted`,
`unsupported_capability`, `restricted_page`, `tab_not_owned`, `tab_closed`,
`stale_ref`, `element_not_found`, `element_not_interactable`, `sensitive_field`,
`approval_denied`, `invalid_params`, `timeout`, `outcome_unknown`, `cancelled`,
`busy` (another command holds the tab's single-writer lease), `debugger_unavailable`
(advanced only), `internal`.

## Agent tool surface

The existing `browser` tool gains an optional `target` parameter:
`"managed"` (default, unchanged behaviour) or `"connected"`. With `connected` it
accepts only the actions above (`act` kinds map to click/type/press/wait; a
scroll is an `act` with `request.direction` and no kind, so the managed `kind`
enum stays unchanged), plus an optional `device` name/id when the principal has
more than one online device. `evaluate`, `console`, cookies and raw CDP are never
available on `connected`. Connected browsing is off unless the tenant enables it
with the builtin tool setting `browser` → `{"connected": true}` (feature flag).
On a Gateway without the managed browser the tool is connected-only: offered only
to agents of tenants with the flag on, its schema lists only connected actions,
and a call without `target:"connected"` returns "managed browser not enabled".

The tool runs only for runs bound to the person by the credential that started
them (direct chat over an owner-bound API key or an authenticated session). Runs
from chat channels are refused (`permission_denied`) until verified account
linking exists. A command still running when its grant expires is cancelled
(`grant_expired`); a revoked grant reports `grant_revoked`, also for a command in
flight (an acknowledged interact command reports `outcome_unknown` in both cases).
`screenshot` is refused (`permission_denied`) before the device is asked when the
run's workspace is shared with other people, because the image is stored as a
file in that workspace.

The Gateway also checks every result: content from a page outside the grant is
withheld (`origin_not_granted`), the `tabs` list hides the title and URL of tabs
on ungranted origins, and page content is wrapped as untrusted external content
before the agent sees it. For `navigate` the Gateway checks the target URL; the
extension also requires the current page to be granted.

## Approval

- Grants are approved only in the extension UI by the device owner.
- `interact` actions whose target looks like submit/publish/delete/payment
  (`type` with `submit:true`, or `click` on an element whose name matches the
  extension's high-risk list) need a per-action local confirmation; denial or
  closing the panel returns `approval_denied`. The extension applies this; the
  Gateway forwards `class` so UIs can show it.
