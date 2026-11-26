/**
 * The in-page "an agent is controlling this tab" frame. `executeScript` serializes this function,
 * so it must be self-contained. It runs in the extension's isolated world: the page can remove the
 * host element (it is redrawn on the next load or sync) but cannot reach inside the closed shadow
 * root, and only a trusted click on Stop sends `browser.pageStop`.
 *
 * label null removes the frame.
 */
export function pageGlow(label: string | null, stopLabel: string): void {
  const ID = 'dewee-agent-presence';
  const KEY = '__deweePresence';
  type State = { host: HTMLElement; text: HTMLElement; button: HTMLButtonElement; observer: MutationObserver };
  const scope = globalThis as unknown as Record<string, State | undefined>;
  const current = scope[KEY];

  if (label === null) {
    current?.observer.disconnect();
    current?.host.remove();
    scope[KEY] = undefined;
    return;
  }
  if (current) {
    current.text.textContent = `Dewee · ${label}`;
    current.button.textContent = stopLabel;
    if (!current.host.isConnected) document.documentElement.append(current.host);
    return;
  }

  const host = document.createElement('div');
  host.id = ID;
  // Above the page, never in the way of it: only the label takes pointer events.
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .frame { position: fixed; inset: 0; border: 3px solid #7c3aed; border-radius: 6px;
      box-shadow: inset 0 0 18px 4px rgba(124, 58, 237, .55), 0 0 18px 4px rgba(124, 58, 237, .55);
      animation: dewee-pulse 1.6s ease-in-out infinite; }
    @keyframes dewee-pulse { 0%, 100% { opacity: .45 } 50% { opacity: 1 } }
    @media (prefers-reduced-motion: reduce) { .frame { animation: none; opacity: .8 } }
    .label { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); pointer-events: auto;
      display: flex; gap: 8px; align-items: center; max-width: calc(100vw - 32px);
      font: 500 12px/1.4 system-ui, sans-serif; color: #fff; background: #5b21b6;
      padding: 4px 6px 4px 12px; border-radius: 999px; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button { all: unset; cursor: pointer; font-weight: 600; background: #fff; color: #5b21b6;
      padding: 2px 10px; border-radius: 999px; }
    button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }`;
  const frame = document.createElement('div');
  frame.className = 'frame';
  const bar = document.createElement('div');
  bar.className = 'label';
  bar.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = `Dewee · ${label}`;
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = stopLabel;
  button.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    void chrome.runtime.sendMessage({ type: 'browser.pageStop' }).catch(() => undefined);
  });
  bar.append(text, button);
  root.append(style, frame, bar);
  document.documentElement.append(host);
  // A page that removes the frame gets it back.
  const observer = new MutationObserver(() => {
    if (!host.isConnected) document.documentElement.append(host);
  });
  observer.observe(document.documentElement, { childList: true });
  scope[KEY] = { host, text, button, observer };
}
