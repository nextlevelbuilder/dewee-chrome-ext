/**
 * What the service worker shows the side panel about browser control, pushed over a runtime port
 * named `browser-control`. It holds no secret and no page content: connection state, the device,
 * grants, Pause/Stop state, the current action (agent, channel, domain, action name), the tabs
 * agents control, a short timeline of finished actions, the debugger choice (Advanced build) and
 * the approval cards waiting for the person.
 */
import { z } from 'zod';
import { grantSchema } from './protocol';

export const BROWSER_PORT = 'browser-control';

export const panelStateSchema = z.object({
  /** off: the preference is off or no profile; cloud: not available for Dewee Cloud yet; signed_out: no API key. */
  mode: z.enum(['off', 'cloud', 'signed_out', 'ready']),
  connection: z.enum(['offline', 'connecting', 'connected', 'reconnecting']),
  error: z.string().optional(),
  device: z.object({ device_id: z.string(), name: z.string() }).nullable(),
  grants: z.array(grantSchema),
  control: z.enum(['active', 'paused', 'stopped']),
  /** Why control is paused, when the extension paused it by itself (the person used an agent's tab). */
  pauseReason: z.enum(['takeover']).optional(),
  activity: z
    .object({
      agentName: z.string(),
      channel: z.string(),
      domain: z.string(),
      action: z.string(),
      /** Sites in the grant the command runs under, and when that grant ends (ISO time). */
      origins: z.array(z.string()),
      expiresAt: z.string().nullable(),
    })
    .nullable(),
  /** Advanced build only: the person's debugger choice for this device session, and the tabs attached right now. */
  advanced: z.object({ available: z.boolean(), enabled: z.boolean(), fallback: z.boolean(), attached: z.number().int().nonnegative() }),
  /** Tabs agents opened and still control. */
  tabs: z.array(z.object({ handle: z.string(), agentName: z.string(), domain: z.string(), expiresAt: z.string().nullable() })),
  /** The last commands that ended here, newest first: what, where and how it ended. No page content. */
  timeline: z.array(
    z.object({ id: z.string(), at: z.number(), agentName: z.string(), action: z.string(), domain: z.string(), ok: z.boolean(), code: z.string().optional() }),
  ),
  approvals: z.array(
    z.object({
      id: z.string(),
      agentName: z.string(),
      channel: z.string(),
      action: z.enum(['click', 'type', 'press']),
      domain: z.string(),
      target: z.string(),
      submit: z.boolean(),
      preview: z.string().max(200).optional(),
    }),
  ),
});
export type PanelState = z.infer<typeof panelStateSchema>;

export const panelMessageSchema = z.object({ type: z.literal('browser.state'), state: panelStateSchema });

export function emptyPanelState(): PanelState {
  return {
    mode: 'off',
    connection: 'offline',
    device: null,
    grants: [],
    control: 'active',
    activity: null,
    advanced: { available: false, enabled: false, fallback: true, attached: 0 },
    tabs: [],
    timeline: [],
    approvals: [],
  };
}
