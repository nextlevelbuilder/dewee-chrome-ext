// Prepares a local Dewee Gateway for the live end-to-end scenarios and writes the extension's
// personal API key into the gitignored .env. Idempotent; prints ids and step names, never secrets.
//
// Env:
//   GOCLAW_GATEWAY_TOKEN  admin token of the local test gateway (setup only, never the extension credential)
//   DEWEE_BIN             path to the `dewee` CLI (used to mint the personal key)
//   E2E_GATEWAY_URL       default http://localhost:18790
//   STUB_LLM_URL          default http://127.0.0.1:18791/v1 (tests/e2e/support/stub-llm.mjs)
//   E2E_OWNER_ID          default e2e-owner@example.test
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const gateway = (process.env.E2E_GATEWAY_URL || 'http://localhost:18790').replace(/\/+$/, '');
const stubUrl = process.env.STUB_LLM_URL || 'http://127.0.0.1:18791/v1';
const ownerId = process.env.E2E_OWNER_ID || 'e2e-owner@example.test';
const adminToken = process.env.GOCLAW_GATEWAY_TOKEN;
const deweeBin = process.env.DEWEE_BIN;
const envFile = path.resolve('.env');
const TENANT_SLUG = 'ext-e2e';
const PROVIDER = 'stub-llm';
const AGENTS = [
  { agent_key: 'e2e-helper', display_name: 'E2E Helper' },
  { agent_key: 'super-agent', display_name: 'Super Agent' },
];

if (!adminToken || !deweeBin) {
  console.error('Set GOCLAW_GATEWAY_TOKEN (test gateway admin token) and DEWEE_BIN (dewee CLI path).');
  process.exit(1);
}

async function admin(method, route, body, tenant) {
  const headers = { Authorization: `Bearer ${adminToken}`, 'X-GoClaw-User-Id': 'system' };
  if (tenant) headers['X-GoClaw-Tenant-Id'] = tenant;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${gateway}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const list = (value, key) => (Array.isArray(value) ? value : (value?.[key] ?? []));

const tenants = list(await admin('GET', '/v1/tenants'), 'tenants');
let tenant = tenants.find((t) => t.slug === TENANT_SLUG);
if (!tenant) tenant = await admin('POST', '/v1/tenants', { name: 'Extension E2E', slug: TENANT_SLUG });
console.log(`tenant ${TENANT_SLUG}: ${tenant.id}`);

const users = list(await admin('GET', `/v1/tenants/${tenant.id}/users`), 'users');
if (!users.some((u) => u.user_id === ownerId)) await admin('POST', `/v1/tenants/${tenant.id}/users`, { user_id: ownerId, role: 'owner' });
console.log(`owner ${ownerId}: member (owner)`);

const providers = list(await admin('GET', '/v1/providers', undefined, tenant.id), 'providers');
if (!providers.some((p) => p.name === PROVIDER)) {
  await admin('POST', '/v1/providers', { name: PROVIDER, provider_type: 'openai_compat', api_base: stubUrl, api_key: 'stub-llm-no-secret', enabled: true }, tenant.id);
}
console.log(`provider ${PROVIDER}: ${stubUrl}`);

const agents = list(await admin('GET', '/v1/agents', undefined, tenant.id), 'agents');
for (const agent of AGENTS) {
  if (!agents.some((a) => a.agent_key === agent.agent_key)) {
    await admin('POST', '/v1/agents', { ...agent, provider: PROVIDER, model: 'stub-model', tenant_id: tenant.id }, tenant.id);
  }
  console.log(`agent ${agent.agent_key}: ready`);
}

// Scenario C: the Super Agent is the setup operator, so it may show secret_request cards.
// e2e-helper stays a normal agent for scenario D (credential_request needs an admin policy).
const superAgent = list(await admin('GET', '/v1/agents', undefined, tenant.id), 'agents').find((a) => a.agent_key === 'super-agent');
const otherConfig = superAgent.other_config && typeof superAgent.other_config === 'object' ? superAgent.other_config : {};
if (otherConfig.setup_operator !== true) {
  await admin('PUT', `/v1/agents/${superAgent.id}`, { other_config: { ...otherConfig, setup_operator: true } }, tenant.id);
}
console.log('agent super-agent: setup operator');

// As in a real workspace, the Super Agent is the default agent. Setup creates both agents as the system
// actor, so for the owner e2e-helper is someone else's agent and the connected browser refuses to grant it.
if (superAgent.is_default !== true) await admin('PUT', `/v1/agents/${superAgent.id}`, { is_default: true }, tenant.id);
console.log('agent super-agent: workspace default');

// The personal key goes straight from the CLI's JSON output into .env; it is never printed.
const created = JSON.parse(
  execFileSync(
    deweeBin,
    ['api-keys', 'create', '--name', 'chrome-extension', '--scopes', 'operator.read,operator.write', '--tenant-id', tenant.id, '--owner-id', ownerId, '--json', '--server', gateway],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  ),
);
if (typeof created.key !== 'string' || !created.key) throw new Error('api-keys create returned no key');

const values = {
  E2E_GATEWAY_URL: gateway,
  E2E_GATEWAY_API_KEY: created.key,
  E2E_WORKSPACE_ID: tenant.id,
  E2E_OWNER_ID: ownerId,
  // Lets the revocation scenario mint and revoke its own throwaway key. Local test gateway only.
  E2E_GATEWAY_ADMIN_TOKEN: adminToken,
};
const lines = existsSync(envFile) ? readFileSync(envFile, 'utf8').split(/\r?\n/) : [];
for (const [name, value] of Object.entries(values)) {
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  if (index >= 0) lines[index] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
}
writeFileSync(envFile, `${lines.filter((line, i) => line || i < lines.length - 1).join('\n')}\n`);
console.log(`api key ${created.id}: written to .env`);
