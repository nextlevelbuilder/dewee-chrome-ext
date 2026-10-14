/**
 * Browser control state for the side panel. The panel holds a runtime port to the service worker
 * while the "Connected browser" preference is on: the worker pushes state over it, and an open
 * port is what lets approval cards reach the person (no port, no approval). Actions go through
 * `callBackground`; nothing here carries a secret or page content.
 */
import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { BROWSER_PORT, panelMessageSchema, type PanelState } from '@/browser/panel-state';
import { callBackground, type BackgroundResponse, type BrowserRequest } from '@/protocol/messages';

const RECONNECT_MS = 1_000;

export interface BrowserControl {
  state: PanelState | null;
  call(request: BrowserRequest): Promise<BackgroundResponse>;
}

export function useBrowserControl(enabled: boolean): BrowserControl {
  const [state, setState] = useState<PanelState | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let port: ReturnType<typeof browser.runtime.connect> | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      try {
        port = browser.runtime.connect({ name: BROWSER_PORT });
      } catch {
        retry = setTimeout(connect, RECONNECT_MS);
        return;
      }
      port.onMessage.addListener((message: unknown) => {
        const parsed = panelMessageSchema.safeParse(message);
        if (parsed.success && !closed) setState(parsed.data.state);
      });
      // The worker restarted (or was suspended): connect again, which also wakes it up.
      port.onDisconnect.addListener(() => {
        port = null;
        if (!closed) retry = setTimeout(connect, RECONNECT_MS);
      });
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      port?.disconnect();
    };
  }, [enabled]);

  const call = useCallback((request: BrowserRequest) => callBackground(request), []);
  return { state: enabled ? state : null, call };
}
