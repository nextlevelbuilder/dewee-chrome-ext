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
| A compromised or buggy Gateway sends commands or grants the person did not allow | Grants are not taken on the Gateway's word. The extension uses a grant only if this browser created it (its id is remembered in `storage.local` when the person creates it), it names this device, every origin in it is an exact origin, and, on creation, its origins match what the person asked for. Any other grant from attach, list or events is ignored. Every command is then re-checked locally against that grant: present, unexpired, unrevoked; agent listed; capability; exact origin of the tab's current page and of any requested URL; owned tab. Before every page action Chrome must hold host permission for that exact host (`permissions.getAll`); a broad pattern held for another feature, such as Ask Dewee's `https://*/*`, does not count. |
| Code injection from the wire | No remote code, `eval` or CDP. Actions are a fixed list validated with Zod; the page function (`pageRun`) is bundled and receives only data (op, ref, generation, text). Selectors and scripts are never accepted. The page function is injected only after `storage.local` is confirmed locked to trusted extension contexts. |
| Agent reaches the person's other tabs | Agents drive only tabs they opened ("owned tabs"), addressed by opaque handles (`t1`, `t2`); raw tab ids never leave the extension. `tabs` lists only owned tabs. The extension has no `tabs` permission, so other tabs' URLs and titles are invisible to it. A tab Chrome creates after the command was cancelled (Stop, revoke, profile switch) is closed, never registered. |
| Navigation or redirect to an ungranted site | The URL is checked before and after every navigation and click; a page that lands outside the grant fails the command, and every later command on that tab is refused while it stays there. `navigate` also needs the page currently in the tab to be in the grant. `chrome://`, extension pages, the Chrome Web Store, `file:`, `data:`, `javascript:` and every `about:` page (`about:blank` included, since a blank tab has no granted origin) are always refused. |
| Secrets read from the page | The snapshot redacts (`value=[redacted]`) any sensitive field, whatever role the page gives it: `type=password`; `autocomplete` `cc-*`, `one-time-code`, `current-password` or `new-password` (so a password revealed by a "show password" button stays redacted); a name or id containing a password, PIN, OTP, MFA or verification-code word (`userPin`, `otp_code`); payment card, CVC, expiry and IBAN hints. Hidden and `aria-hidden` nodes, hidden inputs, and frames from an origin outside the grant are left out. |
| Agent types into a secret field | `type` into any field the rule above calls sensitive is refused (`sensitive_field`), and `Backspace` never edits one. |
| Destructive or irreversible actions | `type` with `submit`, `press Enter` (which submits forms and sends chat messages), and clicks on elements named like submit, publish, delete, pay or similar wait for a per-action "Allow once" in the side panel. The card names the agent, the site and the target element, and for `type` with `submit` shows the start of the text to be sent (clipped, held only while the card is open, never stored or logged). With no side panel open the action is denied, never auto-approved. After approval the element (or the focused element, for Enter) is described again; if its role, name or sensitivity changed, the command fails with `stale_ref`. |
| Stale refs act on the wrong element | Refs belong to one snapshot generation; navigation or a large DOM change bumps it and old refs fail with `stale_ref`. Clicks check that the element is visible, enabled and actually under the click point. |
| Agent fights the person for the tab | Best effort: real clicks and key presses by the person in an owned tab cancel the agent's running command there and hold new ones for 5 s (`busy`). The watcher listens in the capture phase on the page's window; a page can still stop the event before it arrives, so this is a courtesy, not a security boundary. One command at a time per tab. |
| Person loses control | Pause, Stop and Revoke work locally even if the Gateway does not cooperate: Pause/Stop refuse commands locally (`device_paused`), cancel the running ones and deny pending approvals, including commands waiting for text; Stop also releases owned tabs. Revoking a grant or the device cancels in-flight commands. |
| Replayed side effects | A command id runs at most once while the service worker lives (seen ids are kept in memory). After a worker restart, not running a command twice relies on the Gateway, which does not resend a dispatched command. Results are not replayed across reconnects; a lost result becomes `outcome_unknown` on the Gateway and the agent must re-snapshot. A command runs for at most 120 s locally, whatever deadline it carries. |
| Page data persisted | Snapshots, typed text and page content are never stored. `storage.local` keeps only the device id and name and the ids of grants created here, per profile; `storage.session` keeps the tab handle map and the Pause/Stop state. Storage stays locked to trusted extension contexts. |
| Master token or key leak | Only the personal API key is used, only in the `connect` frame to the profile's own Gateway origin. It is never logged or put in a URL. |
| A web page talks to the worker | Content scripts in web pages may send only the Ask Dewee selection and the owned-tab input notice; `browser.*` requests from a web page (or any non-extension sender) are refused. |
| Over-broad Chrome permission | No new install-time permission. Host permission is requested per exact origin at grant time, never `<all_urls>`, and only an exact-host permission satisfies the per-action check. |

## Residual risks

- Inside a granted origin, an allowed agent sees what the person sees there (minus the redacted fields) and can act as them, within the grant's lifetime. Keep grants short and narrow.
- Sensitive-field detection is a heuristic. A secret field with no password type, no matching `autocomplete` and an unhelpful name or id is read and typed like any other field.
- Revoking a grant does not remove Chrome's host permission for its origins, since another grant may still use them. People can remove it in `chrome://extensions`.
- The high-risk name list is a heuristic; an unusually labelled destructive button may not ask for approval. Approval is only possible while the side panel is open; otherwise such actions are denied.
- Preempting the agent when the person uses the tab is best effort (see above).
- A grant created in another browser of the same person is not usable here; it has to be created again in this browser.
- Synthetic events are not trusted events; some sites refuse them. That is a functional limit, not a bypass.
- Dewee Cloud mode is not supported yet; the panel says so and opens no socket.
