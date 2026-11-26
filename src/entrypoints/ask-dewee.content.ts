/**
 * Opt-in page script for "Ask Dewee" on selected text. It is not in the manifest: the service worker
 * registers it only after the person turns the feature on and grants site access.
 */
import { mountAskButton } from '@/ask/selection-button';
import { asAskPosition, type AskButtonPosition } from '@/protocol/ask-selection';

export default defineContentScript({
  matches: ['https://*/*'],
  registration: 'runtime',
  main() {
    // The worker answers with the placement only. Asked again when the tab regains focus, so a change
    // made in Settings applies on return without reloading the page.
    let position: AskButtonPosition = 'auto';
    const refresh = () =>
      void browser.runtime.sendMessage({ type: 'ask.position' }).then((value: unknown) => (position = asAskPosition(value)), () => undefined);
    refresh();
    window.addEventListener('focus', refresh);
    mountAskButton(
      document,
      (message) => void browser.runtime.sendMessage(message).catch(() => undefined),
      undefined,
      undefined,
      () => position,
    );
  },
});
