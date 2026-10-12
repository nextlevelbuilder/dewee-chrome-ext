/**
 * Client-side validation of `dewee.ui-action.v1` envelopes. The Gateway is authoritative and
 * already validates every card; the extension re-validates at its boundary so a malformed or
 * unknown card is dropped instead of rendered. Objects are strict (unknown keys reject), mirroring
 * Go's DisallowUnknownFields decoding. `tests/unit/protocol/ui-action.contract.test.ts` pins these
 * shapes to the Go golden schema vendored in `tests/contract-fixtures/ui-action-v1`.
 */
import { z } from 'zod';

export const UI_ACTION_SCHEMA_V1 = 'dewee.ui-action.v1';

export const uiActionKinds = [
  'choice_request',
  'secret_request',
  'oauth_request',
  'permission_request',
  'install_request',
  'upload_request',
  'plan_review',
  'connection_test',
  'command_preview',
  'setup_progress',
  'handoff',
] as const;
export type UiActionKind = (typeof uiActionKinds)[number];

export const uiActionStatuses = ['pending', 'resolved', 'cancelled', 'expired', 'failed'] as const;
export type UiActionStatus = (typeof uiActionStatuses)[number];

export const secretTargetTypes = ['provider', 'channel_instance', 'cli_agent_credential', 'mcp_server', 'tts', 'stt'] as const;
export const credentialRefKinds = ['provider', 'channel_instance', 'cli_agent_credential', 'mcp_server'] as const;

const code = z.string().max(64).regex(/^[a-z0-9][a-z0-9_.:-]*$/i);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const text = (max: number) => z.string().max(max);
const rfc3339 = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'must be an RFC 3339 timestamp');

export const choiceRequestPayload = z.strictObject({
  purpose: code.optional(),
  options: z
    .array(z.strictObject({ id: code, label: text(80).min(1), description: text(200).optional() }))
    .min(1)
    .max(12),
  multi: z.boolean().optional(),
  allow_free_text: z.boolean().optional(),
});

export const secretTarget = z.strictObject({
  type: z.enum(secretTargetTypes),
  mode: z.enum(['create', 'update']),
  id: uuid.optional(),
  name: text(100).optional(),
  provider_type: code.optional(),
  channel_type: code.optional(),
  api_base: z.string().optional(),
  url: z.string().optional(),
  binary_name: code.optional(),
  agent_key: code.optional(),
});

export const secretField = z.strictObject({
  key: code,
  label: text(80).min(1),
  kind: z.enum(['secret', 'text']),
  required: z.boolean().optional(),
});

export const secretRequestPayload = z
  .strictObject({ target: secretTarget, fields: z.array(secretField).min(1).max(8) })
  .refine((p) => p.fields.some((f) => f.kind === 'secret'), 'fields must include a secret field')
  .refine((p) => new Set(p.fields.map((f) => f.key)).size === p.fields.length, 'fields.key must be unique')
  // Exfiltration guard: a card may never name where a secret is sent.
  .refine((p) => p.target.url === undefined, 'target.url is not allowed');

export const oauthRequestPayload = z.strictObject({
  provider: code,
  server_id: uuid.optional(),
  scopes: z.array(z.string().min(1).max(200).regex(/^\S+$/)).max(20).optional(),
});

export const permissionRequestPayload = z.strictObject({
  approval_id: text(100).min(1),
  risk_class: text(40).startsWith('setup.'),
  command_path: text(200).min(1),
  command: z.array(z.string()).optional(),
  reason: code.optional(),
  confirm_name: text(255).optional(),
  scope: z.enum(['read', 'write', 'admin']).optional(),
});

export const installRequestPayload = z.strictObject({
  approval_id: text(100).min(1),
  package: text(200).min(1),
  runtime: code.optional(),
  version: text(100).optional(),
  reason: code.optional(),
});

export const uploadRequestPayload = z.strictObject({
  purpose: code,
  accept: z.array(text(100).min(1)).max(10).optional(),
  max_bytes: z.number().int().min(1).max(50 * 1024 * 1024),
  multiple: z.boolean().optional(),
});

export const planReviewPayload = z.strictObject({ plan_revision: z.number().int().min(1) });

export const connectionTestPayload = z.strictObject({
  target: z.strictObject({ type: z.enum(credentialRefKinds), id: uuid, name: text(100).optional() }),
  step_id: code.optional(),
  credential_ref: z.string().optional(),
});

export const commandPreviewPayload = z.strictObject({
  command: z.array(z.string()).min(1),
  description: text(300).optional(),
  policy_class: code.optional(),
  policy_outcome: code.optional(),
});

export const setupProgressPayload = z
  .strictObject({
    plan_revision: z.number().int().min(1),
    completed: z.number().int().min(0),
    total: z.number().int().min(0).max(64),
    current_step_id: code.optional(),
  })
  .refine((p) => p.completed <= p.total, 'completed must not exceed total');

export const handoffPayload = z.strictObject({
  purpose: z.enum(['super_agent', 'channel_probe']),
  session_key: text(255).optional(),
  agent_key: code.optional(),
  channel_type: code.optional(),
  channel_instance_id: uuid.optional(),
  probe_expires_at: rfc3339.optional(),
});

export const uiActionPayloadSchemas = {
  choice_request: choiceRequestPayload,
  secret_request: secretRequestPayload,
  oauth_request: oauthRequestPayload,
  permission_request: permissionRequestPayload,
  install_request: installRequestPayload,
  upload_request: uploadRequestPayload,
  plan_review: planReviewPayload,
  connection_test: connectionTestPayload,
  command_preview: commandPreviewPayload,
  setup_progress: setupProgressPayload,
  handoff: handoffPayload,
} as const satisfies Record<UiActionKind, z.ZodType>;

export type UiActionPayloadByKind = { [K in UiActionKind]: z.infer<(typeof uiActionPayloadSchemas)[K]> };

const envelopeBase = {
  schema: z.literal(UI_ACTION_SCHEMA_V1),
  id: uuid,
  status: z.enum(uiActionStatuses),
  title: text(120).min(1),
  body: text(1000).optional(),
  created_at: rfc3339,
  expires_at: rfc3339,
};

function envelopeOf<K extends UiActionKind>(kind: K) {
  return z.strictObject({ ...envelopeBase, kind: z.literal(kind), payload: uiActionPayloadSchemas[kind] });
}

export const uiActionEnvelope = z
  .discriminatedUnion('kind', [
    envelopeOf('choice_request'),
    envelopeOf('secret_request'),
    envelopeOf('oauth_request'),
    envelopeOf('permission_request'),
    envelopeOf('install_request'),
    envelopeOf('upload_request'),
    envelopeOf('plan_review'),
    envelopeOf('connection_test'),
    envelopeOf('command_preview'),
    envelopeOf('setup_progress'),
    envelopeOf('handoff'),
  ])
  .refine((e) => Date.parse(e.expires_at) > Date.parse(e.created_at), 'expires_at must be after created_at')
  .refine((e) => JSON.stringify(e.payload).length <= 16 * 1024, 'payload exceeds 16 KiB');

export type UiActionEnvelope = z.infer<typeof uiActionEnvelope>;
export type SecretRequestEnvelope = Extract<UiActionEnvelope, { kind: 'secret_request' }>;

/** The validated envelope, or null when the value is not a card this client may render. */
export function parseUiAction(value: unknown): UiActionEnvelope | null {
  const result = uiActionEnvelope.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * A card as the actions/respond routes return it: the envelope plus stored-state fields
 * (`session_key`, `result`, …). Those fields are split off before the strict envelope check;
 * only `result` (non-secret outcome such as `credential_ref` or `error_code`) is kept.
 */
export type UiActionCard = UiActionEnvelope & { result?: Record<string, unknown> };

const viewOnlyKeys = ['session_key', 'step_id', 'agent_id', 'attempt_count', 'result', 'resolved_at'] as const;

export function parseUiActionView(value: unknown): UiActionCard | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = { ...(value as Record<string, unknown>) };
  const result = record.result;
  for (const key of viewOnlyKeys) delete record[key];
  const envelope = parseUiAction(record);
  if (!envelope) return null;
  const isRecord = result !== null && typeof result === 'object' && !Array.isArray(result);
  return isRecord ? { ...envelope, result: result as Record<string, unknown> } : envelope;
}

/** True when the card can still be answered (pending and not past its expiry). */
export function isUiActionOpen(envelope: UiActionEnvelope, now = Date.now()): boolean {
  return envelope.status === 'pending' && Date.parse(envelope.expires_at) > now;
}
