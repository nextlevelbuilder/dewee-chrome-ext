# Changelog

## 0.1.0 — unreleased

First MVP of the Dewee Chrome extension.

- Side panel chat with Dewee agents: streaming, stop, retry, sessions, history paging, new chat, and reconcile after a lost stream without re-sending.
- Two connection modes: Dewee Cloud (OAuth Authorization Code + PKCE) and self-hosted Gateway (personal scoped API key).
- Workspace picker and searchable agent picker with Super Agent pinned first.
- Cards: secure credentials form for `secret_request`, `oauth_request`, choice, command preview, progress; other kinds shown read-only.
- Pending-card badge, English and Vietnamese, light/dark/system theme, keyboard shortcuts (Alt+Shift+D, Alt+N, /, Esc).
- Credentials kept in `storage.session` by default; opt-in "remember".

### Fixed

- Connected browser: a command runs only after the Gateway confirmed its ack. A command the Gateway already failed as not run (`device_unresponsive`, `device_offline`) can no longer run late and repeat a side effect when the agent retries; a cancel while the ack is pending stops it before it runs.
