# Connected browser: MV3 executor, relay connection and local control UI

Issue: nextlevelbuilder/dewee-chrome-ext#17. Branch `feat/17-browser-executor` (from `origin/main`). Contract: `docs/connected-browser-relay-contract.md` (v1).

## What was built

- **Protocol** (`src/browser/protocol.ts`): Zod schemas for every frame, method param/result, the `browser.command` payload and per-action params, error codes and limits. Outbound params are strict; Gateway objects (grant, device) are lenient.
- **Transport** (`src/browser/transport.ts`): `RelayTransport` on `ws(s)://<gateway>/ws`, `connect` with the personal API key, 20 s heartbeat, backoff from 1 s to 30 s with jitter, request timeouts, and no replay. Refused keys stop it for good.
- **Session/device** (`src/browser/session.ts`, `device-name.ts`): follows the *Connected browser* pref, the active profile and its credential. Handles enroll, attach, rename, revoke and list; grants; Pause/Stop/Resume; events (`browser.command`, `.cancel`, `grant.revoked`, `device.revoked`); and the panel port and state broadcast. The worker is kept alive by an alarm plus the heartbeat.
- **Policy** (`policy.ts`): local grant, agent, capability, exact-origin, restricted-page, control-state and Chrome host-permission checks; the high-risk name heuristic (English and Vietnamese).
- **Tabs** (`tabs.ts`): opaque handles for owned tabs, a single-writer lease, a snapshot generation, a 5 s hold after the person's own input, and session persistence.
- **Executor + snapshot** (`executor.ts`, `snapshot.ts`, `chrome-api.ts`, `command-runner.ts`, `approvals.ts`):
  - every action in the contract except `screenshot`, which returns `unsupported_capability`;
  - ack after validation, then exactly one result, with dedupe, deadline, cancel and `outcome_unknown`;
  - a self-contained `pageRun` that produces a redacted accessibility outline and performs click/type/press/scroll/find;
  - per-action approval through the side panel.
- **UI**:
  - Side panel: header toggle, `BrowserControlDrawer` (status, device, grants, allow form, approvals, Pause/Resume/Stop) and the `BrowserActivity` strip.
  - Options: *Connected browser* toggle, off by default.
  - i18n: en and vi.
- **Docs**:
  - `architecture.md`: a Connected browser section;
  - `api-contract.md`: a WS relay section;
  - new `browser-control-threat-model.md`;
  - `development.md`: how to run the e2e;
  - README features and docs links;
  - AGENTS.md: the active-page rule now describes the opt-in, grant-scoped exception;
  - the ADR link in the relay contract now points to the Dewee repo.

Manifest unchanged: no `tabs` and no `debugger`; `https://*/*` stays optional; no `<all_urls>`.

## Files

- New:
  - `src/browser/*` (12 modules);
  - `src/sidepanel/browser/{use-browser-control.ts, BrowserControlDrawer.tsx, BrowserActivity.tsx, GrantForm.tsx}`;
  - `docs/browser-control-threat-model.md`;
  - `tests/unit/browser/*` (10 test files plus fixtures and a fake socket);
  - `tests/unit/sidepanel/grant-form.test.ts`;
  - `tests/e2e/browser-control.spec.ts`;
  - `tests/e2e/support/browser-relay.ts`.
- Changed:
  - `src/background/{service-worker.ts, token-manager.ts}`;
  - `src/protocol/messages.ts`;
  - `src/shared/{settings.ts, i18n.ts, icons.tsx}`;
  - `src/sidepanel/{ChatShell.tsx, sidepanel.css}`;
  - `src/options/Settings.tsx`;
  - `tests/unit/shared/settings.test.ts`;
  - `tests/unit/protocol/messages.test.ts`;
  - the docs listed above.

## Contract deviations and interpretations (for the Gateway agent)

1. Grants and devices are read by `grant_id`/`device_id`, but `id` is also accepted.
2. Results are not queued across a reconnect. Commands in flight when the socket drops are cancelled locally; the Gateway's deadline rules decide `outcome_unknown`/`timeout`.
3. Pause and Stop cancel running commands (`cancelled`), not only new ones. Stop also releases the owned tabs (the next command gets `tab_not_owned`).
4. `type` is also refused for one-time-code fields, not only password and payment fields.
5. After the person clicks or presses a key in an owned tab, the agent's command there is cancelled and new ones get `busy` for 5 s.
6. Revoking a grant does not remove Chrome's host permission, because another grant may use the same origin.
7. `navigate` requires both the current page and the target URL to be in the grant.
8. High-risk actions need approval only when a side panel is open to ask. With no panel open they are denied (`approval_denied`), never auto-approved.
9. `screenshot` returns `unsupported_capability` (no advanced build).
10. Grants are used only if this browser created them. The ids from its own `browser.grant.create` are remembered per profile in `storage.local`; any other grant from attach, list or events is ignored. A grant whose `device_id` is not this device, or with a non-exact origin, is ignored too, and a created grant whose origins differ from the request is refused (`invalid_response`). **The Gateway must return `device_id` on every Grant.** A grant created in another browser has to be created again here.
11. `press Enter` needs the same "Allow once" as `type` with submit, naming the focused element.
12. `open about:blank` is refused (`restricted_page`), like every other `about:` URL.
13. The per-action host-permission check needs a permission for that exact host (`permissions.getAll`); Ask Dewee's `https://*/*` does not count.
14. A command runs for at most 120 s locally, whatever its deadline.
15. After an approval the element is described again; if it changed, the command fails with `stale_ref`.

## Review fixes (second commit)

An isolated review of 8d18be8 led to these changes:

- Enter needs approval.
- Redaction and the `type` refusal now also catch:
  - revealed passwords (`autocomplete` current-password/new-password);
  - PIN, OTP and verification-code names and ids;
  - sensitive fields with any role.
- Grants are trusted only if this browser created them, and the host permission must name the exact host.
- The approval card shows a clipped preview of the text to be sent.
- The element is re-described after approval.
- Waiting for text re-checks the grant and Pause.
- `open about:blank` is refused.
- Command deadlines are capped locally.
- A tab Chrome creates after its command was cancelled is closed.
- Page injection waits for an awaited `storage.local` lock.
- The at-most-once limit after a worker restart is documented.
- The threat model and `api-contract.md` are updated to match.

## Test evidence

After the review fixes, every gate exited 0 (2026-10-14):

- `pnpm lint`, `pnpm typecheck` and `pnpm build`: clean.
- `pnpm test`: 45 files and 669 tests passed.
  - New tests cover:
    - Enter approval;
    - a changed element after approval;
    - the preview;
    - a click that lands off the grant;
    - navigate refusals;
    - open `about:blank`;
    - a tab created after cancel;
    - wait-text stopping on Pause or revoke;
    - the deadline cap;
    - grant trust (unknown id, other device, wildcard origin, mismatched create, kept across restart, cleared on device revoke);
    - `patternCoversExactHost`;
    - `hasHostPermission` through `getAll`;
    - injection gated on the storage lock;
    - redaction of revealed passwords, PINs, OTPs and role-overridden password inputs;
    - same-origin frame inclusion and cross-origin exclusion;
    - the `focused` op;
    - web-page senders refused for `browser.*` in the worker routing.
- `pnpm test:e2e` (browser-control and smoke): 15 of 15 passed. This adds a test for type-with-submit and Enter approvals, which checks the preview and that it is not stored.

The first commit's gates, for reference:

- `pnpm test`: 42 files, 632 tests passed. New suites cover protocol, policy, tabs, snapshot (redaction, hidden nodes, stale refs, max_chars, click/type reachability), transport (backoff, heartbeat, no replay, fatal stop), command runner (ack ordering, dedupe, cancel, deadline, outcome_unknown, busy), executor (open/redirect/close, policy, lease, approvals, sensitive fields), session (modes, enroll/attach, profile switch, revoke events, origin permission) and GrantForm origin parsing.
- `pnpm build`: `.output/chrome-mv3`, 1.29 MB.
- `pnpm test:e2e tests/e2e/browser-control.spec.ts tests/e2e/smoke.spec.ts`: 14 of 14 passed (7 browser-control, 7 smoke). The browser-control tests run against a loopback test relay and page server. They cover open/snapshot/type/click with redaction and no page data in storage, refusal of ungranted and restricted pages, a read-only grant, approve and deny plus denial with the panel closed, Stop/Resume, relay-side revoke during a command, and revoke from the panel.

Cleanup: `test-results`, `playwright-report` and `.output-e2e` were removed, and no test servers or Playwright browsers were left running.

A typo in the WebSocket GUID in the test relay first made every handshake fail. The relay now checks itself against the RFC 6455 example key when it loads.

Fixes made during the gates:

- Origin validation now rejects `*` hosts. The URL parser accepts them, and both the protocol schema and the grant form now refuse them.
- `pageRun` no longer passes `view` to event constructors, because jsdom rejects a window from another realm.

## Open risks

- The high-risk name list is a heuristic. A destructive button with an unusual label will not ask for approval.
- Sensitive-field detection is also a heuristic, and stopping the agent when the person uses the tab is best effort, since a page can stop the event first.
- The Gateway being built in parallel must include `device_id` in every Grant object. Without it, no grant is usable.
- Synthetic events are not trusted events, so some sites ignore them.
- E2E coverage uses a handwritten relay, not the real Gateway. A live run against the Gateway being built in parallel is still pending.
- Dewee Cloud mode is not supported yet; the panel says so.
