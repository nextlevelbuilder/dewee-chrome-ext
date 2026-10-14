/**
 * What the service worker shows the side panel about browser control, pushed over a runtime port
 * named `browser-control`. It holds no secret and no page content: connection state, the device,
 * grants, Pause/Stop state, the current action (agent, channel, domain, action name) and the
 * approval cards waiting for the person.
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
  activity: z.object({ agentName: z.string(), channel: z.string(), domain: z.string(), action: z.string() }).nullable(),
  approvals: z.array(
    z.object({ id: z.string(), agentName: z.string(), channel: z.string(), action: z.enum(['click', 'type']), domain: z.string(), target: z.string(), submit: z.boolean() }),
  ),
});
export type PanelState = z.infer<typeof panelStateSchema>;

export const panelMessageSchema = z.object({ type: z.literal('browser.state'), state: panelStateSchema });

export function emptyPanelState(): PanelState {
  return { mode: 'off', connection: 'offline', device: null, grants: [], control: 'active', activity: null, approvals: [] };
}
