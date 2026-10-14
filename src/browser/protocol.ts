/**
 * Connected browser relay contract v1 (docs/connected-browser-relay-contract.md) as Zod schemas.
 * Everything the extension sends is validated against a strict schema first; everything it
 * receives is validated before it is acted on. Objects the Gateway returns (grants, devices) are
 * lenient about extra keys so a newer Gateway does not break an older extension.
 */
import { z } from 'zod';

export const ERROR_CODES = [
  'permission_denied',
  'device_offline',
  'device_paused',
  'device_unresponsive',
  'no_grant',
  'grant_expired',
  'grant_revoked',
  'origin_not_granted',
  'capability_not_granted',
  'unsupported_capability',
  'restricted_page',
  'tab_not_owned',
  'tab_closed',
  'stale_ref',
  'element_not_found',
  'element_not_interactable',
  'sensitive_field',
  'approval_denied',
  'invalid_params',
  'timeout',
  'outcome_unknown',
  'cancelled',
  'busy',
  'debugger_unavailable',
  'internal',
] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);
export type BrowserErrorCode = (typeof ERROR_CODES)[number];

export const ACTIONS = ['tabs', 'open', 'navigate', 'snapshot', 'click', 'type', 'press', 'scroll', 'wait', 'close', 'screenshot'] as const;
export type BrowserAction = (typeof ACTIONS)[number];
export type ActionClass = 'read' | 'interact';

/** Class of every action, decided by the extension; the class the Gateway forwards must agree. */
export const ACTION_CLASS: Record<BrowserAction, ActionClass> = {
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

export const PRESS_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'PageUp', 'PageDown', 'Home', 'End'] as const;
export type PressKey = (typeof PRESS_KEYS)[number];

export const CAPABILITIES = ['browser.read', 'browser.control'] as const;
export type GrantCapability = (typeof CAPABILITIES)[number];

export const SNAPSHOT_DEFAULT_CHARS = 20_000;
export const SNAPSHOT_MAX_CHARS = 60_000;
export const WAIT_MAX_MS = 10_000;
export const TYPE_MAX_CHARS = 10_000;
export const GRANT_TTL = { min: 60, max: 28_800, default: 3_600 } as const;
export const GRANT_MAX_ORIGINS = 20;
export const GRANT_MAX_AGENTS = 20;

const tab = z.string().regex(/^t[1-9]\d{0,8}$/);
const ref = z.string().regex(/^e[1-9]\d{0,8}$/);
const generation = z.number().int().nonnegative();
const url = z.string().min(1).max(4096);

export const actionParamsSchemas = {
  tabs: z.object({}).strict(),
  open: z.object({ url }).strict(),
  navigate: z.object({ tab, url }).strict(),
  snapshot: z.object({ tab, max_chars: z.number().int().min(1).max(SNAPSHOT_MAX_CHARS).optional() }).strict(),
  click: z.object({ tab, ref, generation }).strict(),
  type: z.object({ tab, ref, generation, text: z.string().max(TYPE_MAX_CHARS), submit: z.boolean().optional() }).strict(),
  press: z.object({ tab, key: z.enum(PRESS_KEYS) }).strict(),
  scroll: z.object({ tab, direction: z.enum(['up', 'down']), amount: z.enum(['page', 'half']).optional() }).strict(),
  wait: z.union([z.object({ tab, ms: z.number().int().min(0).max(WAIT_MAX_MS) }).strict(), z.object({ tab, text: z.string().min(1).max(500) }).strict()]),
  close: z.object({ tab }).strict(),
  screenshot: z.object({ tab }).strict(),
} satisfies Record<BrowserAction, z.ZodType>;

export type ActionParams = { [A in BrowserAction]: z.infer<(typeof actionParamsSchemas)[A]> };

/** The `browser.command` event payload; `params` is checked per action in a second step. */
export const commandEnvelopeSchema = z
  .object({
    command_id: z.uuid(),
    device_id: z.uuid(),
    grant_id: z.uuid(),
    agent_id: z.uuid(),
    agent_name: z.string().max(200).optional(),
    channel: z.string().max(64).optional(),
    action: z.enum(ACTIONS),
    params: z.record(z.string(), z.unknown()),
    class: z.enum(['read', 'interact']),
    deadline: z.iso.datetime({ offset: true }),
  })
  .strict();
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** A command whose params passed the schema of its action. */
export type BrowserCommand = { [A in BrowserAction]: Omit<CommandEnvelope, 'action' | 'params'> & { action: A; params: ActionParams[A] } }[BrowserAction];

export type ParsedCommand = { ok: true; command: BrowserCommand } | { ok: false; commandId?: string; code: 'invalid_params' };

/** Validates a `browser.command` payload. The command id is kept when present so the refusal can be reported. */
export function parseCommand(payload: unknown): ParsedCommand {
  const envelope = commandEnvelopeSchema.safeParse(payload);
  const commandId = z.object({ command_id: z.uuid() }).safeParse(payload);
  if (!envelope.success) return { ok: false, commandId: commandId.success ? commandId.data.command_id : undefined, code: 'invalid_params' };
  const { action, params } = envelope.data;
  const parsedParams = actionParamsSchemas[action].safeParse(params);
  if (!parsedParams.success || envelope.data.class !== ACTION_CLASS[action]) return { ok: false, commandId: envelope.data.command_id, code: 'invalid_params' };
  return { ok: true, command: { ...envelope.data, action, params: parsedParams.data } as BrowserCommand };
}

// ---------- Objects returned by the Gateway ----------

/** Accepts `id` where the contract names `grant_id` / `device_id`, so either spelling works. */
function aliasId(key: string) {
  return (value: unknown) => (value && typeof value === 'object' && !(key in value) && 'id' in value ? { ...value, [key]: (value as { id: unknown }).id } : value);
}

export const grantSchema = z.preprocess(
  aliasId('grant_id'),
  z.object({
    grant_id: z.string().min(1),
    device_id: z.string().nullish(),
    agent_ids: z.array(z.string().min(1)).max(GRANT_MAX_AGENTS),
    origins: z.array(z.string().min(1)).max(GRANT_MAX_ORIGINS),
    capabilities: z.array(z.string()).transform((caps) => caps.filter((c): c is GrantCapability => (CAPABILITIES as readonly string[]).includes(c))),
    expires_at: z.iso.datetime({ offset: true }),
    revoked_at: z.string().nullish(),
    created_at: z.string().nullish(),
  }),
);
export type Grant = z.infer<typeof grantSchema>;

export const deviceSchema = z.preprocess(
  aliasId('device_id'),
  z.object({
    device_id: z.string().min(1),
    name: z.string().default(''),
    platform: z.string().nullish(),
    online: z.boolean().nullish(),
    last_seen_at: z.string().nullish(),
    revoked_at: z.string().nullish(),
  }),
);
export type Device = z.infer<typeof deviceSchema>;

// ---------- Methods (extension → Gateway) ----------

const uuid = z.uuid();
export const DEVICE_NAME_MAX_BYTES = 100;
/** No control or format characters (line breaks, bidi overrides, zero-width); at most 100 UTF-8 bytes. */
export function isValidDeviceName(name: string): boolean {
  return name.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(name) && new TextEncoder().encode(name).length <= DEVICE_NAME_MAX_BYTES;
}
const deviceName = z.string().trim().min(1).max(80).refine(isValidDeviceName, 'device name: no control characters, at most 100 bytes');
const deviceCapabilities = z.union([z.tuple([z.literal('standard')]), z.tuple([z.literal('standard'), z.literal('advanced')])]);
/**
 * `scheme://host[:port]` exactly as `URL.origin` writes it (so international hosts are punycode),
 * https (or http on loopback), no wildcard, no trailing dot, host at most 253 characters.
 */
export function isExactOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname;
    // The URL parser accepts `*` in a host name; v1 has no wildcards.
    if (parsed.origin !== value || host.includes('*') || host.endsWith('.') || host.length > 253) return false;
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(host));
  } catch {
    return false;
  }
}
const exactOrigin = z.string().refine(isExactOrigin, 'exact https origin, or http on loopback');

export const methodParamsSchemas = {
  connect: z.object({ token: z.string().min(1), client: z.literal('dewee-chrome-ext'), version: z.string().min(1) }).strict(),
  'browser.device.enroll': z.object({ name: deviceName, platform: z.string().min(1).max(40), capabilities: deviceCapabilities }).strict(),
  'browser.device.attach': z.object({ device_id: uuid, capabilities: deviceCapabilities }).strict(),
  'browser.device.heartbeat': z.object({ device_id: uuid }).strict(),
  'browser.device.list': z.object({}).strict(),
  'browser.device.rename': z.object({ device_id: uuid, name: deviceName }).strict(),
  'browser.device.revoke': z.object({ device_id: uuid }).strict(),
  'browser.grant.create': z
    .object({
      device_id: uuid,
      agent_ids: z.array(uuid).min(1).max(GRANT_MAX_AGENTS),
      origins: z.array(exactOrigin).min(1).max(GRANT_MAX_ORIGINS),
      capabilities: z.union([z.tuple([z.literal('browser.read')]), z.tuple([z.literal('browser.read'), z.literal('browser.control')])]),
      ttl_seconds: z.number().int().min(GRANT_TTL.min).max(GRANT_TTL.max),
    })
    .strict(),
  'browser.grant.list': z.object({ device_id: uuid }).strict(),
  'browser.grant.revoke': z.object({ grant_id: uuid }).strict(),
  'browser.command.ack': z.object({ command_id: uuid }).strict(),
  'browser.command.result': z.union([
    z.object({ command_id: uuid, ok: z.literal(true), result: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ command_id: uuid, ok: z.literal(false), error: z.object({ code: errorCodeSchema, message: z.string().max(500) }).strict() }).strict(),
  ]),
  'browser.control.state': z.object({ device_id: uuid, state: z.enum(['active', 'paused', 'stopped']) }).strict(),
} as const;
export type RelayMethod = keyof typeof methodParamsSchemas;
export type MethodParams<M extends RelayMethod> = z.input<(typeof methodParamsSchemas)[M]>;

const empty = z.object({}).passthrough();
export const methodResultSchemas = {
  connect: z.unknown(),
  'browser.device.enroll': z.object({ device_id: z.uuid() }),
  'browser.device.attach': z.object({ device_id: z.uuid(), grants: z.array(grantSchema).default([]) }),
  'browser.device.heartbeat': empty,
  'browser.device.list': z.object({ devices: z.array(deviceSchema) }),
  'browser.device.rename': z.object({ device: deviceSchema }),
  'browser.device.revoke': empty,
  'browser.grant.create': z.object({ grant: grantSchema }),
  'browser.grant.list': z.object({ grants: z.array(grantSchema) }),
  'browser.grant.revoke': empty,
  'browser.command.ack': empty,
  'browser.command.result': empty,
  'browser.control.state': empty,
} satisfies Record<RelayMethod, z.ZodType>;
export type MethodResult<M extends RelayMethod> = z.output<(typeof methodResultSchemas)[M]>;

// ---------- Action results (sent in `browser.command.result`) ----------

// The Gateway withholds a page result without its `url` (it checks it against the grant), so a
// result that has none is a bug here and is reported as `internal` instead.
const pageResult = z.object({ tab, url, title: z.string() }).strict();
export const actionResultSchemas = {
  tabs: z.object({ tabs: z.array(z.object({ tab, url: z.string(), title: z.string(), active: z.boolean() }).strict()) }).strict(),
  open: pageResult,
  navigate: pageResult,
  snapshot: z.object({ tab, url, title: z.string(), generation, text: z.string().max(SNAPSHOT_MAX_CHARS) }).strict(),
  click: pageResult,
  type: pageResult,
  press: z.object({ tab }).strict(),
  scroll: z.object({ tab }).strict(),
  wait: z.object({ tab }).strict(),
  close: z.object({}).strict(),
  screenshot: z.object({ tab, url, mime: z.literal('image/jpeg'), data_base64: z.string() }).strict(),
} satisfies Record<BrowserAction, z.ZodType>;
export type ActionResult = { [A in BrowserAction]: z.infer<(typeof actionResultSchemas)[A]> };

// ---------- Frames ----------

export const responseFrameSchema = z.object({
  type: z.literal('res'),
  id: z.string(),
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).passthrough().nullish(),
});
export const eventFrameSchema = z.object({ type: z.literal('event'), event: z.string(), payload: z.unknown().optional() });
export const inboundFrameSchema = z.discriminatedUnion('type', [responseFrameSchema, eventFrameSchema]);
export type ResponseFrame = z.infer<typeof responseFrameSchema>;
export type EventFrame = z.infer<typeof eventFrameSchema>;

export const commandCancelSchema = z.object({ command_id: z.uuid() });
export const grantRevokedSchema = z.object({ grant_id: z.string().min(1) });
export const deviceRevokedSchema = z.object({ device_id: z.string().min(1) });

export const RELAY_EVENTS = {
  command: 'browser.command',
  cancel: 'browser.command.cancel',
  grantRevoked: 'browser.grant.revoked',
  deviceRevoked: 'browser.device.revoked',
} as const;
