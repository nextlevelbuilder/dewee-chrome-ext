/** Shared builders for the connected-browser unit tests. */
import type { BrowserCommand, Grant } from '@/browser/protocol';

export const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
export const GRANT_ID = '22222222-2222-4222-8222-222222222222';
export const AGENT_ID = '33333333-3333-4333-8333-333333333333';
export const OTHER_AGENT_ID = '44444444-4444-4444-8444-444444444444';
export const ORIGIN = 'https://shop.example.test';
export const NOW = Date.parse('2026-10-14T08:00:00Z');

let counter = 0;
export function commandId(): string {
  counter += 1;
  return `55555555-5555-4555-8555-${String(counter).padStart(12, '0')}`;
}

export function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    grant_id: GRANT_ID,
    device_id: DEVICE_ID,
    agent_ids: [AGENT_ID],
    origins: [ORIGIN],
    capabilities: ['browser.read', 'browser.control'],
    expires_at: new Date(NOW + 3_600_000).toISOString(),
    ...overrides,
  };
}

const CLASS: Record<BrowserCommand['action'], 'read' | 'interact'> = {
  tabs: 'read',
  open: 'interact',
  navigate: 'interact',
  snapshot: 'read',
  click: 'interact',
  type: 'interact',
  press: 'interact',
  scroll: 'read',
  wait: 'read',
  close: 'interact',
  screenshot: 'read',
};

/** A raw `browser.command` payload as the Gateway sends it. */
export function payload(action: BrowserCommand['action'], params: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command_id: commandId(),
    device_id: DEVICE_ID,
    grant_id: GRANT_ID,
    agent_id: AGENT_ID,
    agent_name: 'Researcher',
    channel: 'telegram',
    action,
    params,
    class: CLASS[action],
    deadline: new Date(NOW + 60_000).toISOString(),
    ...overrides,
  };
}

/** A validated command (same shape as `parseCommand` returns). */
export function command<A extends BrowserCommand['action']>(action: A, params: Extract<BrowserCommand, { action: A }>['params'], overrides: Partial<BrowserCommand> = {}): Extract<BrowserCommand, { action: A }> {
  return { ...(payload(action, params as Record<string, unknown>) as object), ...overrides } as Extract<BrowserCommand, { action: A }>;
}
