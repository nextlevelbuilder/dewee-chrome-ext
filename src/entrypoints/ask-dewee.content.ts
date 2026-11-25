/**
 * Opt-in page script for "Ask Dewee" on selected text. It is not in the manifest: the service worker
 * registers it only after the person turns the feature on and grants site access.
 */
import { mountAskButton } from '@/ask/selection-button';
import { ASK_BUTTON_POSITIONS, ASK_POSITION_KEY, type AskButtonPosition } from '@/protocol/ask-selection';

function asPosition(value: unknown): AskButtonPosition {
  return (ASK_BUTTON_POSITIONS as readonly unknown[]).includes(value) ? (value as AskButtonPosition) : 'auto';
}

export default defineContentScript({
  matches: ['https://*/*'],
  registration: 'runtime',
  main() {
    // Only the placement key is read; it updates live when changed in Settings.
    let position: AskButtonPosition = 'auto';
    void browser.storage.local.get(ASK_POSITION_KEY).then((r) => (position = asPosition(r[ASK_POSITION_KEY])), () => undefined);
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[ASK_POSITION_KEY]) position = asPosition(changes[ASK_POSITION_KEY].newValue);
    });
    mountAskButton(
      document,
      (message) => void browser.runtime.sendMessage(message).catch(() => undefined),
      undefined,
      undefined,
      () => position,
    );
  },
});