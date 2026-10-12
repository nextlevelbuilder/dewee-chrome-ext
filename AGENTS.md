# AGENTS.md

Guidance for humans and coding agents contributing to `nextlevelbuilder/dewee-chrome-ext`.

## What this repo is

A thin Chrome Manifest V3 client for Dewee. It renders a right side panel for chat with Dewee agents (Super Agent pinned first) and renders server-defined credential request cards. The Dewee Gateway is authoritative for agents, tenants, sessions, permissions and the credential store. Backend changes belong in [`nextlevelbuilder/dewee`](https://github.com/nextlevelbuilder/dewee); never copy Dewee source into this repo.

Read before changing code: [docs/architecture.md](docs/architecture.md), [docs/api-contract.md](docs/api-contract.md), [docs/auth-threat-model.md](docs/auth-threat-model.md), [docs/credential-threat-model.md](docs/credential-threat-model.md), [docs/development.md](docs/development.md).

## Commands

```bash
pnpm install        # also runs `wxt prepare`
pnpm dev            # Chrome with the extension loaded and hot reload
pnpm lint
pnpm typecheck
pnpm test           # unit + integration (Vitest)
pnpm test:e2e       # builds, then runs Playwright against the unpacked build
pnpm build          # .output/chrome-mv3
pnpm zip            # sideload zip (keeps the pinned extension key)
pnpm zip:store      # Chrome Web Store zip (manifest without `key`)
```

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before every push. CI runs the same gates plus e2e.

## Issue and PR workflow (required for every contributor)

Status labels show who is working on what so contributors do not step on each other.

| Label | When to set it |
|---|---|
| `in progress` | You started work. Assign yourself at the same time. |
| `blocked` | Work cannot continue (missing backend API, decision, credential). Comment with the blocker and a link. |
| `in review` | Implementation is done and an isolated reviewer (human or a subagent with fresh context) is reviewing. |
| `done` | The PR is open and linked with `Closes #N` / `Refs #N`. |
| `shipped` | The PR is merged into `main`. |

Rules:

1. Before starting, check the issue is not already `in progress` with another assignee. If it is, coordinate on the issue instead of starting parallel work.
2. Move one label at a time (remove the previous status label when you add the next).
3. Code review runs in an isolated context (a separate reviewer or subagent that did not write the code). Address blocking findings before `done`.
4. If you find an unrelated bug, gap or hardening need, open a new issue (labels `bug` or `security` plus `ai-handle` when an agent can take it) instead of widening the current PR.
5. Backend dependencies go to `nextlevelbuilder/dewee` as linked issues/PRs. Do not ship UI-only mocks for missing backend APIs.
6. Conventional commits, no secrets, no AI attribution in commit subjects.

## Security rules (non-negotiable)

- Never put secrets in chat messages, `chat.send`, URLs, logs, telemetry, Chrome `storage.local`/`sync`, or app-wide React state. Secret values live only in the credential form's local state and go only to the action respond endpoint.
- Never use the Dewee gateway master token as a client credential. Self-hosted mode uses a personal scoped API key (`operator.read`/`operator.write`).
- Never render agent-generated HTML. Cards render from a fixed list of kinds validated with Zod; markdown is sanitized with DOMPurify.
- No remote code, no `eval`, strict extension CSP. Host permissions are requested per gateway origin at runtime, never `<all_urls>`.
- The side panel never reads the active page.

## Code layout

- `src/entrypoints/` thin WXT entrypoints (background, sidepanel, options).
- `src/background/` service worker logic; `src/sidepanel/` and `src/options/` React UI.
- `src/api/` one typed `DeweeClient` for both modes (self-hosted Gateway and Cloud BFF) plus response schemas.
- `src/protocol/` Zod schemas for SSE events, UI actions and the background⇄panel messages.
- `src/auth/`, `src/chat/`, `src/credentials/`, `src/shared/` feature modules.
- `tests/unit`, `tests/integration`, `tests/e2e`.

Keep files small and focused; kebab-case for new non-component files, PascalCase for React components.
