// Shared helpers for the live specs against a real local Dewee Gateway
// (see tests/e2e/support/live-gateway.md). Nothing here prints a key, token or secret.
import type { Page, Worker } from '@playwright/test';
import { dumpStorage, expect, test } from '../fixtures';
import { remoteHostRefusal } from './live-host-guard';

try {
  process.loadEnvFile('.env');
} catch {
  // No .env: rely on the shell environment.
}

export const GATEWAY = (process.env.E2E_GATEWAY_URL ?? '').replace(/\/+$/, '');
export const API_KEY = process.env.E2E_GATEWAY_API_KEY ?? '';
export const WORKSPACE = process.env.E2E_WORKSPACE_ID ?? '';
export const OWNER = process.env.E2E_OWNER_ID ?? '';
export const ADMIN_TOKEN = process.env.E2E_GATEWAY_ADMIN_TOKEN ?? '';
export const STUB_LLM = (process.env.STUB_LLM_URL ?? 'http://127.0.0.1:18791').replace(/\/v1\/?$/, '').replace(/\/+$/, '');
export const SUPER_AGENT = 'super-agent';
export const SHOTS = 'test-results/live';

/**
 * Skips the calling spec unless a live gateway is configured, so CI stays green without one, and
 * unless that gateway is on loopback (or `E2E_ALLOW_REMOTE=1` says a remote one is intended).
 */
export function requireLiveGateway(admin = false): void {
  test.skip(!GATEWAY || !API_KEY || !WORKSPACE, 'Set E2E_GATEWAY_URL, E2E_GATEWAY_API_KEY and E2E_WORKSPACE_ID to run the live gateway scenarios.');
  const refusal = remoteHostRefusal('E2E_GATEWAY_URL', GATEWAY);
  test.skip(refusal !== null, refusal ?? '');
  if (admin) test.skip(!ADMIN_TOKEN || !OWNER, 'Set E2E_GATEWAY_ADMIN_TOKEN and E2E_OWNER_ID.');
}

/** A unique, readable marker so assertions never match an earlier run's history. */
export const marker = (label: string) => `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function connect(panel: Page, key = API_KEY, gateway = GATEWAY): Promise<void> {
  await panel.getByRole('tab', { name: 'Self-hosted Gateway' }).click();
  await panel.getByLabel('Gateway URL').fill(gateway);
  await panel.getByLabel('Personal API key').fill(key);
  await panel.getByRole('button', { name: 'Connect' }).click();
  await expect(panel.getByTestId('agent-picker')).toContainText('Super Agent', { timeout: 20_000 });
}

export async function send(panel: Page, text: string): Promise<void> {
  await panel.getByRole('textbox', { name: /^Message / }).fill(text);
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
}

export async function pickAgent(panel: Page, name: string): Promise<void> {
  await panel.getByTestId('agent-picker').click();
  await panel.getByRole('listbox').getByRole('option').filter({ hasText: name }).click();
  await expect(panel.getByTestId('agent-picker')).toContainText(name);
}

export const userTurns = (panel: Page, text: string) => panel.locator('li.message.message-user', { hasText: text });
export const assistantTurns = (panel: Page, text: string) => panel.locator('li.message.message-assistant', { hasText: text });

/** The extension's own API with the personal key; used only to check server state. */
export async function api<T>(method: string, route: string, body?: unknown, key = API_KEY): Promise<{ status: number; data: T }> {
  const res = await fetch(`${GATEWAY}/v1/extension/workspaces/${encodeURIComponent(WORKSPACE)}${route}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

export interface HistoryMessage {
  role: string;
  content: string;
}

export async function history(sessionKey: string): Promise<HistoryMessage[]> {
  const { data } = await api<{ messages: HistoryMessage[] }>('POST', '/chat/history', { session_key: sessionKey, limit: 200 });
  return data.messages;
}

export async function userCount(sessionKey: string, text: string): Promise<number> {
  return (await history(sessionKey)).filter((m) => m.role === 'user' && m.content.includes(text)).length;
}

/** The session the panel remembers for an agent (non-secret, in storage.local settings). */
export async function rememberedSession(worker: Worker, agentKey = SUPER_AGENT): Promise<string> {
  const storage = JSON.parse(await dumpStorage(worker)) as {
    local: { settings?: { selections?: Record<string, { workspaces?: Record<string, { sessions?: Record<string, string> }> }> } };
  };
  for (const selection of Object.values(storage.local.settings?.selections ?? {})) {
    const key = selection.workspaces?.[WORKSPACE]?.sessions?.[agentKey];
    if (key) return key;
  }
  throw new Error('no remembered session');
}

/** Local test gateway admin calls, scoped to the e2e tenant. Returns status and parsed body. */
export async function admin<T>(method: string, route: string, body?: unknown, asUser = 'system'): Promise<{ status: number; data: T }> {
  // Second line of defence for a spec that forgot `requireLiveGateway`: never send the master token off-host.
  const refusal = remoteHostRefusal('E2E_GATEWAY_URL', GATEWAY);
  if (refusal) throw new Error(refusal);
  const res = await fetch(`${GATEWAY}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'X-GoClaw-User-Id': asUser,
      'X-GoClaw-Tenant-Id': WORKSPACE,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: res.status, data: data as T };
}

/**
 * Same as `admin`, but throws on a non-2xx answer. Pass `asUser` (for example `OWNER`) for writes
 * the Gateway accepts only from a person, such as the credential-request policy.
 */
export async function adminOk<T>(method: string, route: string, body?: unknown, asUser?: string): Promise<T> {
  const { status, data } = await admin<T>(method, route, body, asUser);
  if (status < 200 || status >= 300) throw new Error(`${method} ${route} -> ${status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

export interface ToolCall {
  name: string;
  arguments: unknown;
}

/** The Gateway refuses other tools until the turn has a task ledger, so every script opens one. */
const ENSURE_LEDGER: ToolCall = { name: 'session_tasks', arguments: { action: 'ensure', current_step: 'Ask the person for a credential' } };

/** Scripts the stub model: a user line containing `match` opens a task ledger, then makes `call`. */
export async function scriptToolCall(match: string, call: ToolCall): Promise<void> {
  await scriptToolCalls(match, [call]);
}

/** Like `scriptToolCall`, with one tool call per model round, in order. */
export async function scriptToolCalls(match: string, calls: ToolCall[]): Promise<void> {
  const steps = [[ENSURE_LEDGER], ...calls.map((call) => [call])];
  const res = await fetch(`${STUB_LLM}/__stub/script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ match, steps }) });
  if (!res.ok) throw new Error(`stub script -> ${res.status}`);
}

interface StubMessage {
  role?: string;
  content?: unknown;
}

async function receivedLists(): Promise<StubMessage[][]> {
  const res = await fetch(`${STUB_LLM}/__stub/requests`);
  const { requests } = (await res.json()) as { requests: StubMessage[][] };
  return requests;
}

/** Every message list the stub model received, serialized; used to prove a value never reached it. */
export async function modelInputs(): Promise<string[]> {
  return (await receivedLists()).map((r) => JSON.stringify(r));
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join('') : '';

/**
 * The tool results the model received in the turn whose user message contains `match`, in order
 * (from the latest model call of that turn, which carries all of them).
 */
export async function turnToolResults(match: string): Promise<string[]> {
  const lists = await receivedLists();
  for (const list of [...lists].reverse()) {
    const lastUser = list.findLastIndex((m) => m?.role === 'user');
    if (lastUser < 0 || !textOf(list[lastUser]?.content).includes(match)) continue;
    return list.slice(lastUser + 1).filter((m) => m?.role === 'tool').map((m) => textOf(m.content));
  }
  return [];
}
