# Connected browser threat model

Scope: the extension side of "Connected browser", where Dewee agents drive tabs in a person's own Chrome through the Gateway relay. The wire contract is [connected-browser-relay-contract.md](connected-browser-relay-contract.md); the Gateway side and its decisions are in Dewee's [ADR-026](https://github.com/nextlevelbuilder/dewee/blob/dev/docs/adr/adr-026-connected-browser.md). Code: `src/browser/` and `src/sidepanel/browser/`.

## What is at stake

The person's signed-in web sessions. An agent that can read and click in a tab can see what the person sees on that site and act as them there. The extension therefore treats every command as untrusted input, even one the Gateway already checked.

## Flow

1. The person turns on *Connected browser* in Settings (off by default; self-hosted profiles only). Only then does the service worker open `wss://<gateway>/ws`, authenticating with the profile's personal API key.
2. In the side panel the person registers this browser (`browser.device.enroll`), which grants nothing.
3. The person allows chosen agents on chosen exact origins, read or read-and-act, for 15 minutes to 8 hours. Chrome's host permission for those origins is requested inside that click; if Chrome refuses, no grant is created.
4. The Gateway sends `browser.command` events. The extension validates and re-checks each one, acks it, runs a fixed bundled action, and returns one result.

## Threats and controls

| Threat | Control |
|---|---|
| A compromised or buggy Gateway sends commands the person did not allow | Every command is re-checked locally against the grant fetched from this device's own connection: grant present, unexpired, unrevoked; agent listed; capability; exact origin of the tab's current page and of any requested URL; owned tab. Chrome host permission is checked before every page action. |
| Code injection from the wire | No remote code, `eval` or CDP. Actions are a fixed list validated with Zod; the page function (`pageRun`) is bundled and receives only data (op, ref, generation, text). Selectors and scripts are never accepted. |
| Agent reaches the person's other tabs | Agents drive only tabs they opened ("owned tabs"), addressed by opaque handles (`t1`, `t2`); raw tab ids never leave the extension. `tabs` lists only owned tabs. The extension has no `tabs` permission, so other tabs' URLs and titles are invisible to it. |
| Navigation or redirect to an ungranted site | The URL is checked before and after every navigation; a page that lands outside the grant fails the command, and every later command on that tab is refused while it stays there. `chrome://`, extension pages, the Chrome Web Store, `file:`, `data:`, `javascript:` and `about:` (except `about:blank` while opening) are always refused. |
| Secrets read from the page | The snapshot never includes values of password, hidden, payment (`cc-*`) or one-time-code fields (`value=[redacted]`), hidden or `aria-hidden` nodes, or anything in frames from another origin. |
| Agent types into a secret field | `type` into password, payment or one-time-code fields is refused (`sensitive_field`). |
| Destructive or irreversible clicks | `type` with `submit`, and clicks on elements named like submit, publish, delete, pay or similar, wait for a per-action "Allow once" in the side panel. With no side panel open the action is denied, never auto-approved. |
| Stale refs act on the wrong element | Refs belong to one snapshot generation; navigation or a large DOM change bumps it and old refs fail with `stale_ref`. Clicks check that the element is visible, enabled and actually under the click point. |
| Agent fights the person for the tab | Real clicks and key presses by the person in an owned tab cancel the agent's running command there and hold new ones for 5 s (`busy`). One command at a time per tab. |
| Person loses control | Pause, Stop and Revoke work locally even if the Gateway does not cooperate: Pause/Stop refuse commands locally (`device_paused`) and cancel the running ones; Stop also releases owned tabs. Revoking a grant or the device cancels in-flight commands. |
| Replayed side effects | A command id runs at most once. Results are not replayed across reconnects; a lost result becomes `outcome_unknown` on the Gateway and the agent must re-snapshot. |
| Page data persisted | Snapshots, typed text and page content are never stored. `storage.local` keeps only the device id and name per profile; `storage.session` keeps the tab handle map and the Pause/Stop state. Storage stays locked to trusted extension contexts. |
| Master token or key leak | Only the personal API key is used, only in the `connect` frame to the profile's own Gateway origin. It is never logged or put in a URL. |
| Over-broad Chrome permission | No new install-time permission. Host permission is requested per exact origin at grant time, never `<all_urls>`. |

## Residual risks

- Inside a granted origin, an allowed agent sees what the person sees there (minus the redacted fields) and can act as them, within the grant's lifetime. Keep grants short and narrow.
- Revoking a grant does not remove Chrome's host permission for its origins, since another grant may still use them. People can remove it in `chrome://extensions`.
- The high-risk name list is a heuristic; an unusually labelled destructive button may not ask for approval. Approval is only possible while the side panel is open; otherwise such actions are denied.
- Synthetic events are not trusted events; some sites refuse them. That is a functional limit, not a bypass.
- Dewee Cloud mode is not supported yet; the panel says so and opens no socket.
