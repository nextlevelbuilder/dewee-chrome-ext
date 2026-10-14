/**
 * Entry point of the Advanced adapter. This is the only module that touches `chrome.debugger`;
 * the session imports it only in the Advanced build (`ADVANCED_BUILD`), so Standard builds carry
 * neither the code nor the permission.
 */
import type { DriverErrorCode } from '../page-driver';
import { CdpAdapter } from './cdp-adapter';
import { CdpClient, type DebuggerApi } from './cdp-client';
import { offscreenCodec } from './screenshot';

export const chromeDebuggerApi: DebuggerApi = {
  attach: (target, version) => chrome.debugger.attach({ tabId: target.tabId }, version),
  detach: (target) => chrome.debugger.detach({ tabId: target.tabId }),
  sendCommand: (target, method, params) => chrome.debugger.sendCommand({ tabId: target.tabId }, method, params),
  onDetach: {
    addListener: (callback) => chrome.debugger.onDetach.addListener((source, reason) => callback({ tabId: source.tabId }, String(reason))),
  },
};

export interface CdpAdapterOptions {
  check(tabId: number): Promise<DriverErrorCode | null>;
  onDetached(tabId: number, reason: string): void;
  onChange(): void;
}

export function createCdpAdapter(options: CdpAdapterOptions): CdpAdapter<ImageBitmap> {
  const client = new CdpClient({ debugger: chromeDebuggerApi, check: options.check, onDetached: options.onDetached, onChange: options.onChange });
  return new CdpAdapter({ client, codec: offscreenCodec });
}
