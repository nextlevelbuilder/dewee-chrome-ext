/**
 * Response shapes of Extension API v1 (docs/api-contract.md). Objects are lenient about extra
 * keys (forward compatible) but strict about the fields the client reads.
 */
import { z } from 'zod';
import { parseUiActionView, type UiActionCard } from '@/protocol/ui-action';

const nullableString = z.string().nullish().transform((v) => v ?? undefined);

export const meResponse = z.object({
  user: z.object({ id: z.string(), email: nullableString, display_name: nullableString }),
  auth: z.object({
    mode: z.enum(['api_key', 'oauth']),
    scopes: z.array(z.string()).default([]),
    expires_at: nullableString,
  }),
});
export type Me = z.infer<typeof meResponse>;

export const workspace = z.object({
  id: z.string().min(1),
  name: z.string().default(''),
  role: nullableString,
  status: z.string().default('active'),
});
export type Workspace = z.infer<typeof workspace>;
export const workspacesResponse = z.object({ workspaces: z.array(workspace) });

export const agent = z.object({
  key: z.string().min(1),
  id: nullableString,
  name: z.string().default(''),
  status: z.string().default('active'),
  model: nullableString,
  provider: nullableString,
  is_super: z.boolean().default(false),
});
export type Agent = z.infer<typeof agent>;
export const agentsResponse = z.object({ agents: z.array(agent), super_agent_key: nullableString });

export const session = z.object({
  key: z.string().min(1),
  agent_key: nullableString,
  title: nullableString,
  updated_at: nullableString,
  message_count: z.number().int().nonnegative().optional(),
});
export type Session = z.infer<typeof session>;
export const sessionsResponse = z.object({
  sessions: z.array(session),
  total: z.number().int().nonnegative().default(0),
  limit: z.number().int().optional(),
  offset: z.number().int().optional(),
});

export const historyMessage = z.object({
  id: nullableString,
  role: z.enum(['user', 'assistant', 'tool', 'system']).catch('assistant'),
  content: z.string().default(''),
  created_at: nullableString,
  /** Written by the server, not the model (e.g. the marker of a run stopped before replying). */
  injected: z.boolean().optional(),
});
export type HistoryMessage = z.infer<typeof historyMessage>;
export const historyResponse = z.object({
  session_key: nullableString,
  cursor: nullableString,
  next_cursor: nullableString,
  reset: z.boolean().default(false),
  messages: z.array(historyMessage).default([]),
});
export type History = z.infer<typeof historyResponse>;

export const abortResponse = z.object({ aborted: z.boolean() });
export const statusResponse = z.object({ running: z.boolean(), run_id: nullableString });
export type RunStatus = z.infer<typeof statusResponse>;

/** Cards are validated one by one; an invalid or unknown card is dropped, not fatal. */
const uiActionList = z.array(z.unknown()).transform((items) =>
  items.map((item) => parseUiActionView(item)).filter((item): item is UiActionCard => item !== null),
);
export const actionsResponse = z.object({ actions: uiActionList });

export const continuation = z.object({
  session_key: z.string().min(1),
  agent_key: z.string().min(1),
  setup_action_id: z.string().min(1),
});
export type Continuation = z.infer<typeof continuation>;

export const respondResponse = z.object({
  action: z.unknown().transform((value, ctx) => {
    const parsed = parseUiActionView(value);
    if (!parsed) {
      ctx.addIssue({ code: 'custom', message: 'invalid ui action' });
      return z.NEVER;
    }
    return parsed;
  }),
  replayed: z.boolean().default(false),
  result: z
    .object({
      target_type: nullableString,
      name: nullableString,
      connected: z.boolean().optional(),
      credential_ref: nullableString,
      error_code: nullableString,
    })
    .passthrough()
    .nullish(),
  continuation: continuation.nullish(),
});
export type RespondResult = z.infer<typeof respondResponse>;

export const tokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().refine((v) => v.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponse>;
