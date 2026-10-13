# Extension unit and integration tests: report

Status: DONE_WITH_CONCERNS

## Test results overview

- Last full run: 20 files, 220 passed, 1 expected failure (`it.fails`), 221 total. That is 37 pre-existing tests plus 184 new ones.
- One edit came after that run: the `agent()` helper in `tests/unit/sidepanel/use-directory.test.ts` was simplified. It has not been re-run. The shell broke after that edit, so the final run, typecheck and lint were delegated to a background agent whose result was not received before this report.
- Typecheck passed (exit 0) before that last edit. Lint passed for `src`, `tests/unit` and `tests/integration` before that edit.

## Coverage

Not measured. `@vitest/coverage-v8` is not installed, and I did not add a dev dependency for it.

## Dependencies

No devDependencies added. `@testing-library/react` and `@testing-library/user-event` were already in `package.json`.

## Files added

- `tests/unit/shared/`: origin, settings, markdown, i18n
- `tests/unit/auth/`: credential-store, pkce, cloud-oauth
- `tests/unit/api/`: errors, dewee-client
- `tests/unit/background/token-manager.test.ts`
- `tests/unit/protocol/messages.test.ts`
- `tests/unit/chat/chat-state.test.ts`
- `tests/unit/sidepanel/use-directory.test.ts`
- `tests/unit/credentials/`: CredentialsForm, ActionCard
- `tests/integration/chat/use-chat.test.tsx`

## Failed tests

None. One test is marked `it.fails` (see Critical issues).

## Performance

About 7 s for the full suite on this machine.

## Critical issues

1. **Source defect, low likelihood in browsers.** In `src/chat/use-chat.ts`, `runStream` decides whether to reconcile after a stream closes without a terminal frame by reading `stateRef.current.phase`. That ref updates only on React commit. If the stream closes right after `chat.started`, before the send commits, the check sees `idle`, skips reconcile, and the conversation stays `streaming`. Reproduced by `tests/integration/chat/use-chat.test.tsx` (marked `it.fails`). Suggested fix: track a local terminal flag inside `runStream` and reconcile when the loop ends without one. Browser likelihood is low because discrete UI events commit synchronously.
2. **Blocker outside this task.** `pnpm lint` fails on `tests/e2e/fixtures.ts` (four `react-hooks/rules-of-hooks` errors on Playwright `use` fixtures). That file appeared at 17:50, after this work started, and was not touched. Lint passes for `src`, `tests/unit` and `tests/integration`.

## Recommendations

- Fix the `use-chat` end-of-stream check as described above, then remove `.fails`.
- Export the i18n catalogs (or a key list) so the key-set test does not parse source text.
- Install `@vitest/coverage-v8` if a coverage gate is required.

## Notes and deviations

- `requestSchema` in `src/protocol/messages.ts` strips secret-looking extra fields rather than rejecting them. The service worker reads only `parsed.data`, so nothing leaks. The test asserts stripping. If rejection is the required contract, switch to `z.strictObject`.
- `AbortSignal.timeout` reason fails `instanceof DOMException` in vitest's jsdom realm. The timeout test shims `AbortSignal.timeout`. Browsers are same-realm, so `src` is correct.
- `loadSettings` resets all settings to defaults when any field fails validation. `settings.test.ts` pins this current behaviour.

## Unresolved questions

- Is there a real race in `src/background/token-manager.ts`? A caller that reads the stored refresh token before an in-flight refresh completes, and reaches `renew()` after the in-flight entry is cleared, would present an already-rotated token and trigger replay revocation. I did not reproduce it.
- Does the background verification run (test, typecheck, lint) pass after the final `use-directory` edit? It needs a re-run.
