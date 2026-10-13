/**
 * Opt-in page script for "Ask Dewee" on selected text. It is not in the manifest: the service worker
 * registers it only after the person turns the feature on and grants site access.
 */
import { mountAskButton } from '@/ask/selection-button';

export default defineContentScript({
  matches: ['https://*/*'],
  registration: 'runtime',
  main() {
    mountAskButton(document, (message) => void browser.runtime.sendMessage(message).catch(() => undefined));
  },
});