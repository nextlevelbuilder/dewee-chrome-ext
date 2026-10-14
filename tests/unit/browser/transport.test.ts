import { backoffDelay, HEARTBEAT_MS, RelayError, RelayTransport, relayUrl, type TransportOptions } from '@/browser/transport';
import { DEVICE_ID } from './fixtures';
import { FakeSocket, flush } from './fake-socket';

function setup(overrides: Partial<TransportOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const events: unknown[] = [];
  const onReady = vi.fn(async () => undefined);
  const heartbeat = vi.fn((): Promise<void> | undefined => transport.request('browser.device.heartbeat', { device_id: DEVICE_ID }).then(() => undefined));
  const transport: RelayTransport = new RelayTransport({
    url: 'wss://gw.example.test/ws',
    token: async () => 'personal-key',
    version: '0.1.0',
    onReady,
    heartbeat,
    onEvent: (frame) => events.push(frame),
    onState: (state, detail) => states.push(detail?.code ? `${state}:${detail.code}` : state),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: () => 0.5,
    ...overrides,
  });
  const socket = (): FakeSocket => {
    const current = sockets.at(-1);
    if (!current) throw new Error('no socket was created');
    return current;
  };
  /** Opens the current socket and answers `connect`. */
  const connect = async () => {
    socket().open();
    await flush();
    socket().reply(socket().last('connect'), { protocol: 3 });
    await flush();
  };
  return { transport, sockets, socket, states, events, onReady, heartbeat, connect };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('relayUrl and backoff', () => {
  it('maps the gateway origin to its /ws endpoint', () => {
    expect(relayUrl('https://gw.example.test')).toBe('wss://gw.example.test/ws');
    expect(relayUrl('http://127.0.0.1:18790')).toBe('ws://127.0.0.1:18790/ws');
  });

  it('backs off from 1 s to 30 s with jitter', () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 1)).toBe(1_000);
    expect(backoffDelay(3, () => 1)).toBe(8_000);
    expect(backoffDelay(20, () => 1)).toBe(30_000);
    expect(backoffDelay(20, () => 0)).toBe(15_000);
  });
});

describe('RelayTransport', () => {
  it('connects with the personal API key, then attaches', async () => {
    const t = setup();
    t.transport.start();
    expect(t.socket().url).toBe('wss://gw.example.test/ws');
    t.socket().open();
    await flush();
    expect(t.socket().last('connect').params).toEqual({ token: 'personal-key', client: 'dewee-chrome-ext', version: '0.1.0' });
    expect(t.onReady).not.toHaveBeenCalled();
    t.socket().reply(t.socket().last('connect'));
    await flush();
    expect(t.onReady).toHaveBeenCalledTimes(1);
    expect(t.transport.isReady).toBe(true);
    expect(t.states).toEqual(['connecting', 'connected']);
  });

  it('sends a heartbeat every 20 s and reconnects when it fails', async () => {
    const t = setup();
    t.transport.start();
    await t.connect();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(t.heartbeat).toHaveBeenCalledTimes(1);
    const beat = t.socket().last('browser.device.heartbeat');
    expect(beat.params).toEqual({ device_id: DEVICE_ID });
    t.socket().reply(beat);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(t.heartbeat).toHaveBeenCalledTimes(2);
    t.socket().refuse(t.socket().last('browser.device.heartbeat'), 'NOT_FOUND');
    await flush();
    expect(t.sockets[0]?.closed).toBe(true);
    expect(t.states.at(-1)).toBe('reconnecting');
  });

  it('reconnects with backoff and attaches again, without replaying requests', async () => {
    const t = setup();
    t.transport.start();
    await t.connect();
    const inFlight = t.transport.request('browser.grant.list', { device_id: DEVICE_ID });
    t.socket().drop();
    await expect(inFlight).rejects.toMatchObject({ code: 'device_offline' });
    expect(t.states.at(-1)).toBe('reconnecting');
    expect(t.sockets).toHaveLength(1);
    vi.advanceTimersByTime(749);
    expect(t.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.sockets).toHaveLength(2);
    await t.connect();
    expect(t.onReady).toHaveBeenCalledTimes(2);
    expect(t.socket().methods()).toEqual(['connect']);
    expect(t.states.at(-1)).toBe('connected');
  });

  it('grows the delay while the gateway stays unreachable', async () => {
    const t = setup();
    t.transport.start();
    t.socket().drop();
    vi.advanceTimersByTime(750);
    expect(t.sockets).toHaveLength(2);
    t.socket().drop();
    vi.advanceTimersByTime(1_499);
    expect(t.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(t.sockets).toHaveLength(3);
  });

  it('stops for good when the gateway refuses the key', async () => {
    const t = setup();
    t.transport.start();
    t.socket().open();
    await flush();
    t.socket().refuse(t.socket().last('connect'), 'UNAUTHORIZED');
    await flush();
    expect(t.states.at(-1)).toBe('stopped:permission_denied');
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
  });

  it('closes the socket and does not reconnect after stop', async () => {
    const t = setup();
    t.transport.start();
    await t.connect();
    t.transport.stop();
    expect(t.sockets[0]?.closed).toBe(true);
    expect(t.states.at(-1)).toBe('stopped');
    vi.advanceTimersByTime(60_000);
    expect(t.sockets).toHaveLength(1);
    await expect(t.transport.request('browser.device.list', {})).rejects.toBeInstanceOf(RelayError);
  });

  it('delivers events only after connect succeeded', async () => {
    const t = setup();
    t.transport.start();
    t.socket().open();
    t.socket().event('browser.command', { early: true });
    await flush();
    t.socket().reply(t.socket().last('connect'));
    await flush();
    t.socket().event('browser.command', { late: true });
    expect(t.events).toEqual([{ type: 'event', event: 'browser.command', payload: { late: true } }]);
  });

  it('validates request params before sending anything', async () => {
    const t = setup();
    t.transport.start();
    await t.connect();
    await expect(t.transport.request('browser.device.rename', { device_id: 'nope', name: 'x' })).rejects.toThrow();
    expect(t.socket().methods()).toEqual(['connect']);
  });

  it('times out a request the gateway never answers', async () => {
    const t = setup();
    t.transport.start();
    await t.connect();
    const pending = t.transport.request('browser.device.list', {}, 1_000);
    vi.advanceTimersByTime(1_000);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });
});
