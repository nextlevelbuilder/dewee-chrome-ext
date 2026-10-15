# Dewee Chrome Extension

Chat with your Dewee agents, with Super Agent pinned first, in Chrome's side panel. When an agent needs an API key or an OAuth connection, the extension shows a secure card, so you never paste secrets into chat.

- **Two connection modes:** Dewee Cloud (sign in with OAuth + PKCE) or a self-hosted Dewee Gateway (personal API key with `operator.read` + `operator.write`).
- **Workspaces and agents:** pick a workspace, search agents, and keep separate sessions per agent.
- **Reliable chat:** streaming, stop, retry, history, new chat. If the connection drops, the panel checks the server instead of sending your message twice.
- **Credential cards:** secrets stay in the form and go only to Dewee's respond endpoint. Nothing secret is stored by the extension.
- **Connected browser (self-hosted, opt-in):** turn on *Connected browser* in Settings, register this browser, and allow chosen agents on chosen sites for a limited time. Agents can then open, read, and act in tabs they open themselves, never in your other tabs. Risky clicks wait for your approval, passwords and payment fields are never read or typed, and *Pause*, *Stop* and *Revoke* are always one click away. Agent tabs carry an "AI" badge, and using one yourself pauses the agents.
- **Advanced build (sideload, opt-in):** `pnpm build:advanced` adds Chrome's `debugger` permission. After you turn on *Advanced mode* in the browser drawer, agents read pages through the accessibility tree, use real input and can take viewport screenshots, in their own tabs only. It shares the extension ID with the standard build, so install one or the other. See the [threat model](docs/browser-control-threat-model.md#advanced-mode-debugger).
- **Pending badge**, English and Vietnamese, light/dark/system theme, keyboard shortcuts.

## Install (development build)

```bash
pnpm install
pnpm build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked** and select `.output/chrome-mv3`. Pin the extension and click it (or press `Alt+Shift+D`) to open the side panel.

## Connect

- **Dewee Cloud:** choose *Dewee Cloud* and *Sign in*. You approve access on Dewee, then return to the panel.
- **Self-hosted:** choose *Self-hosted*, enter your Gateway URL (HTTPS, or `http://localhost` for development) and a personal API key created in Dewee. The Gateway operator must allow the origin `chrome-extension://poicgajeapmbcilfbeobdfedibiffbbm` (`GOCLAW_ALLOWED_ORIGINS`). Never use the gateway master token.

By default the credential is kept only until Chrome closes. Tick *Remember on this device* to keep it on disk.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Alt+Shift+D` | Open the side panel (change in `chrome://extensions/shortcuts`) |
| `Enter` / `Shift+Enter` | Send / new line |
| `Esc` | Stop the reply |
| `Alt+N` | New chat |
| `/` | Focus the message box |

## Docs

- [Architecture](docs/architecture.md)
- [Extension API contract](docs/api-contract.md)
- [Authentication threat model](docs/auth-threat-model.md)
- [Credential request threat model](docs/credential-threat-model.md)
- [Connected browser threat model](docs/browser-control-threat-model.md) and [relay contract](docs/connected-browser-relay-contract.md)
- [Development](docs/development.md) and [contributor workflow](AGENTS.md)

## License

[MIT](LICENSE)
