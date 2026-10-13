import { defineConfig } from 'wxt';
import extensionKey from './extension-public-key.json' with { type: 'json' };

// End-to-end builds pre-grant loopback hosts so Playwright never meets Chrome's permission prompt,
// and go to their own folder so they cannot be zipped or shipped by mistake.
const e2e = process.env.DEWEE_E2E === '1';
// The Chrome Web Store refuses a manifest with `key` and assigns its own ID, so store builds drop it.
const store = process.env.DEWEE_STORE === '1';

// Thin entrypoints live in src/entrypoints; feature code lives in src/{background,sidepanel,options,...}.
export default defineConfig({
  srcDir: 'src',
  outDir: e2e ? '.output-e2e' : store ? '.output-store' : '.output',
  modules: ['@wxt-dev/module-react'],
  hooks: {
    // WXT copies a runtime-registered content script's `matches` into required `host_permissions`. The
    // "Ask Dewee" script must stay optional (asked for in Settings), so drop that copy again.
    'build:manifestGenerated': (_wxt, manifest) => {
      const required = (manifest.host_permissions ?? []).filter((pattern: string) => pattern !== 'https://*/*');
      if (required.length) manifest.host_permissions = required;
      else delete manifest.host_permissions;
    },
  },
  manifest: {
    name: 'Dewee',
    // Public key only: pins the unpacked/dev extension ID (poicgajeapmbcilfbeobdfedibiffbbm) so OAuth redirect URIs and
    // Gateway origin allowlists stay stable. The Chrome Web Store build gets its own store-assigned ID.
    ...(store ? {} : { key: extensionKey.key }),
    description:
      'Chat with your Dewee agents and Super Agent in a side panel, and answer credential requests without exposing secrets.',
    minimum_chrome_version: '116',
    // scripting registers the opt-in "Ask Dewee" page script only after the person turns it on.
    permissions: ['sidePanel', 'storage', 'identity', 'alarms', 'scripting'],
    // Gateway origins are requested at runtime, one origin at a time, after the user adds a profile.
    // "Ask Dewee" on selected text asks for https://*/* when it is turned on in Settings.
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    ...(e2e ? { host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'] } : {}),
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: { default_title: 'Open Dewee', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
    // The action opens the side panel (setPanelBehavior), so this shortcut opens it too.
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+D', mac: 'Alt+Shift+D' }, description: 'Open the Dewee side panel' },
    },
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  },
});
