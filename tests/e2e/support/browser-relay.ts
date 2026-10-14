/**
 * Test-only stand-in for a self-hosted Dewee Gateway, enough for the connected-browser e2e:
 * the Extension API endpoints the side panel needs (me, workspaces, agents, sessions, actions)
 * and the `/ws` relay (connect, device enroll/attach/list/rename/revoke, grants, command
 * ack/result, control state). It listens on 127.0.0.1 only, on a random port.
 *
 * The WebSocket side is a minimal RFC 6455 server (text frames, ping/pong, close), written here so
 * the test needs no extra dependency. It is not a general-purpose implementation.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export const RELAY_API_KEY = 'e2e-personal-key-not-a-secret';
export const AGENT = { id: '0f6b6d55-1b36-4e2e-9a39-5a1f6a0c0a01', key: 'researcher', name: 'Researcher' };
const WORKSPACE = { id: 'ws-e2e', name: 'E2E workspace', status: 'active' };

interface Grant {
  grant_id: string;
  device_id: string;
  agent_ids: string[];
  origins: string[];
  capabilities: string[];
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

interface Device {
  device_id: string;
  name: string;
  platform: string;
  online: boolean;
  revoked_at: string | null;
}

export interface CommandOutcome {
  command_id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface Connection {
  socket: Socket;
  ready: boolean;
  deviceId: string | null;
  send(frame: unknown): void;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** `Sec-WebSocket-Accept` for a client key (RFC 6455 section 4.2.2). */
function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

// The RFC's own example: a wrong accept value makes Chrome drop every socket with code 1006.
if (acceptKey('dGhlIHNhbXBsZSBub25jZQ==') !== 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=') throw new Error('browser-relay: WebSocket accept key is wrong');

function encodeFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Splits buffered client frames (always masked); returns complete frames and the unread rest. */
function decodeFrames(buffer: Buffer): { frames: Array<{ opcode: number; data: Buffer }>; rest: Buffer } {
  const frames: Array<{ opcode: number; data: Buffer }> = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer.readUInt8(offset) & 0x0f;
    let length = buffer.readUInt8(offset + 1) & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (buffer.length - cursor < 2) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break;
      length = Number(buffer.readBigUInt64BE(cursor));
      cursor += 8;
    }
    if (buffer.length - cursor < 4 + length) break;
    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    const data = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) data[i] = buffer.readUInt8(cursor + i) ^ mask.readUInt8(i % 4);
    frames.push({ opcode, data });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export class BrowserRelay {
  readonly devices = new Map<string, Device>();
  readonly grants = new Map<string, Grant>();
  readonly acks: string[] = [];
  readonly outcomes = new Map<string, CommandOutcome>();
  readonly controlStates: string[] = [];
  readonly methods: string[] = [];
  /** Capabilities the device announced, per enroll or attach, in order. */
  readonly capabilities: string[][] = [];
  private readonly connections = new Set<Connection>();
  private readonly waiters = new Map<string, (outcome: CommandOutcome) => void>();
  private server: Server | null = null;
  origin = '';

  async start(): Promise<void> {
    const server = createServer((req, res) => this.http(req, res));
    server.on('upgrade', (req, socket) => this.upgrade(req, socket as Socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.server = server;
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The attached device connection, once the extension enrolled or attached. */
  get attached(): Connection | undefined {
    return [...this.connections].find((c) => c.ready && c.deviceId);
  }

  activeGrant(): Grant | undefined {
    return [...this.grants.values()].find((g) => !g.revoked_at);
  }

  /** Sends a `browser.command` like the Gateway would after its own grant check. */
  command(action: string, params: Record<string, unknown>, options: { deadlineMs?: number; agentId?: string; grantId?: string } = {}): { commandId: string; outcome: Promise<CommandOutcome> } {
    const connection = this.attached;
    const grantId = options.grantId ?? this.activeGrant()?.grant_id;
    if (!connection?.deviceId || !grantId) throw new Error('no attached device or grant');
    const commandId = randomUUID();
    const interact = ['open', 'navigate', 'click', 'type', 'press', 'close'].includes(action);
    const outcome = new Promise<CommandOutcome>((resolve) => this.waiters.set(commandId, resolve));
    connection.send({
      type: 'event',
      event: 'browser.command',
      payload: {
        command_id: commandId,
        device_id: connection.deviceId,
        grant_id: grantId,
        agent_id: options.agentId ?? AGENT.id,
        agent_name: AGENT.name,
        channel: 'telegram',
        action,
        params,
        class: interact ? 'interact' : 'read',
        deadline: new Date(Date.now() + (options.deadlineMs ?? 30_000)).toISOString(),
      },
    });
    return { commandId, outcome };
  }

  cancel(commandId: string): void {
    this.attached?.send({ type: 'event', event: 'browser.command.cancel', payload: { command_id: commandId } });
  }

  /** Revocation from the Gateway side (another device or the web UI). */
  revokeGrant(grantId: string): void {
    const grant = this.grants.get(grantId);
    if (grant) grant.revoked_at = new Date().toISOString();
    for (const connection of this.connections) if (connection.ready) connection.send({ type: 'event', event: 'browser.grant.revoked', payload: { grant_id: grantId } });
  }

  // ---------- HTTP ----------

  private http(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', this.origin);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${RELAY_API_KEY}`) return send(401, { error: { code: 'unauthorized', message: 'bad key' } });
    const base = '/v1/extension';
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : url.pathname;
    if (path === '/me') return send(200, { user: { id: 'u1', email: 'e2e@example.test', display_name: 'E2E' }, auth: { mode: 'api_key', scopes: ['operator.read', 'operator.write'] } });
    if (path === '/workspaces') return send(200, { workspaces: [WORKSPACE] });
    if (path === `/workspaces/${WORKSPACE.id}/agents`) return send(200, { agents: [{ key: AGENT.key, id: AGENT.id, name: AGENT.name, is_super: true }], super_agent_key: AGENT.key });
    if (path === `/workspaces/${WORKSPACE.id}/sessions`) return send(200, { sessions: [], total: 0 });
    if (path === `/workspaces/${WORKSPACE.id}/actions`) return send(200, { actions: [] });
    send(404, { error: { code: 'not_found', message: 'not found' } });
  }

  // ---------- WebSocket ----------

  private upgrade(req: IncomingMessage, socket: Socket): void {
    const key = req.headers['sec-websocket-key'];
    if (new URL(req.url ?? '/', this.origin).pathname !== '/ws' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = acceptKey(key);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const connection: Connection = {
      socket,
      ready: false,
      deviceId: null,
      send: (frame) => {
        if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(frame)));
      },
    };
    this.connections.add(connection);
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame('', 0x8));
          return;
        }
        if (frame.opcode === 0x9) socket.write(encodeFrame(frame.data.toString('utf8'), 0xa));
        if (frame.opcode === 0x1) this.onFrame(connection, frame.data.toString('utf8'));
      }
    });
    const drop = () => {
      this.connections.delete(connection);
      if (connection.deviceId) {
        const device = this.devices.get(connection.deviceId);
        if (device) device.online = false;
      }
    };
    socket.on('close', drop);
    socket.on('error', drop);
  }

  private onFrame(connection: Connection, text: string): void {
    let frame: { type?: string; id?: string; method?: string; params?: Record<string, unknown> };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return;
    }
    if (frame.type !== 'req' || typeof frame.id !== 'string' || typeof frame.method !== 'string') return;
    const { id, method } = frame;
    const params = frame.params ?? {};
    this.methods.push(method);
    const ok = (payload: unknown = {}) => connection.send({ type: 'res', id, ok: true, payload });
    const fail = (code: string, message: string) => connection.send({ type: 'res', id, ok: false, error: { code, message } });

    if (method === 'connect') {
      if (params.token !== RELAY_API_KEY || params.client !== 'dewee-chrome-ext') return fail('UNAUTHORIZED', 'bad key');
      connection.ready = true;
      return ok({ protocol: 3 });
    }
    if (!connection.ready) return fail('UNAUTHORIZED', 'connect first');
    const deviceId = typeof params.device_id === 'string' ? params.device_id : '';
    if ((method === 'browser.device.enroll' || method === 'browser.device.attach') && Array.isArray(params.capabilities)) this.capabilities.push(params.capabilities.map(String));
    switch (method) {
      case 'browser.device.enroll': {
        const device: Device = { device_id: randomUUID(), name: String(params.name), platform: String(params.platform), online: true, revoked_at: null };
        this.devices.set(device.device_id, device);
        connection.deviceId = device.device_id;
        return ok({ device_id: device.device_id });
      }
      case 'browser.device.attach': {
        const device = this.devices.get(deviceId);
        if (!device || device.revoked_at) return fail('NOT_FOUND', 'unknown device');
        device.online = true;
        connection.deviceId = deviceId;
        return ok({ device_id: deviceId, grants: this.grantsFor(deviceId) });
      }
      case 'browser.device.heartbeat':
        return this.devices.has(deviceId) ? ok({}) : fail('NOT_FOUND', 'unknown device');
      case 'browser.device.list':
        return ok({ devices: [...this.devices.values()] });
      case 'browser.device.rename': {
        const device = this.devices.get(deviceId);
        if (!device) return fail('NOT_FOUND', 'unknown device');
        device.name = String(params.name);
        return ok({ device });
      }
      case 'browser.device.revoke': {
        const device = this.devices.get(deviceId);
        if (!device) return fail('NOT_FOUND', 'unknown device');
        device.revoked_at = new Date().toISOString();
        for (const grant of this.grants.values()) if (grant.device_id === deviceId) grant.revoked_at = device.revoked_at;
        return ok({});
      }
      case 'browser.grant.create': {
        const grant: Grant = {
          grant_id: randomUUID(),
          device_id: deviceId,
          agent_ids: params.agent_ids as string[],
          origins: params.origins as string[],
          capabilities: params.capabilities as string[],
          expires_at: new Date(Date.now() + Number(params.ttl_seconds) * 1000).toISOString(),
          created_at: new Date().toISOString(),
          revoked_at: null,
        };
        this.grants.set(grant.grant_id, grant);
        return ok({ grant });
      }
      case 'browser.grant.list':
        return ok({ grants: this.grantsFor(deviceId) });
      case 'browser.grant.revoke': {
        const grant = this.grants.get(String(params.grant_id));
        if (!grant) return fail('NOT_FOUND', 'unknown grant');
        grant.revoked_at = new Date().toISOString();
        return ok({});
      }
      case 'browser.command.ack':
        this.acks.push(String(params.command_id));
        return ok({});
      case 'browser.command.result': {
        const outcome = params as unknown as CommandOutcome;
        this.outcomes.set(outcome.command_id, outcome);
        this.waiters.get(outcome.command_id)?.(outcome);
        this.waiters.delete(outcome.command_id);
        return ok({});
      }
      case 'browser.control.state':
        this.controlStates.push(String(params.state));
        return ok({});
      default:
        return fail('METHOD_NOT_FOUND', method);
    }
  }

  private grantsFor(deviceId: string): Grant[] {
    return [...this.grants.values()].filter((g) => g.device_id === deviceId && !g.revoked_at);
  }
}

/** A loopback site with a sign-in form, used as the page the agent drives. */
export async function startPageServer(): Promise<{ port: number; stop(): Promise<void> }> {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>E2E Shop</title></head>
<body>
  <h1>Account</h1>
  <form id="login" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'Submitted ' + document.getElementById('email').value;">
    <label for="email">Email</label> <input id="email" type="email" autocomplete="off">
    <label for="pw">Password</label> <input id="pw" type="password" value="hunter2-e2e-secret">
    <input type="hidden" name="csrf" value="hidden-token-e2e">
    <button type="button" id="next" onclick="document.getElementById('status').textContent = 'Clicked next'">Next</button>
    <button type="button" id="delete" onclick="document.getElementById('status').textContent = 'Account deleted'">Delete account</button>
  </form>
  <div style="display:none">Hidden text e2e</div>
  <p id="status">Ready</p>
</body></html>`;
  // `/frames` embeds a same-origin frame and a cross-site one (localhost is another site than 127.0.0.1).
  const frames = (port: number) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>E2E Frames</title></head>
<body>
  <h1>Frames</h1>
  <iframe title="Same site" src="/inner" width="400" height="120"></iframe>
  <iframe title="Other site" src="http://localhost:${port}/foreign" width="400" height="120"></iframe>
</body></html>`;
  const inner = `<!doctype html><html lang="en"><body><button type="button" onclick="this.textContent = 'Inner clicked'">Inner button</button></body></html>`;
  const foreign = `<!doctype html><html lang="en"><body><p>Foreign text e2e</p><button type="button">Foreign button</button></body></html>`;
  // `/slow` has a button whose mousedown handler keeps the page busy longer than one debugger
  // command may wait, so the input reaches the page but its outcome is never confirmed.
  const slow = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>E2E Slow</title></head>
<body>
  <h1>Slow</h1>
  <button type="button" onmousedown="const end = Date.now() + 12000; while (Date.now() < end) {} this.textContent = 'Slow done'">Slow button</button>
</body></html>`;
  let port = 0;
  const server = createServer((req, res) => {
    const html = (body: string) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(body);
    if (req.url === '/favicon.ico') return void res.writeHead(404).end();
    if (req.url === '/frames') return void html(frames(port));
    if (req.url === '/inner') return void html(inner);
    if (req.url === '/foreign') return void html(foreign);
    if (req.url === '/slow') return void html(slow);
    html(page);
  });
  // Loopback only; Chrome tries 127.0.0.1 for `localhost` when ::1 refuses, so the cross-site frame loads too.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
