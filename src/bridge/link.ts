import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Msg, Role } from '../shared/protocol';
import { getPort, getToken, warn } from './config';
import { Hub, type Peer } from './hub';

const MAX_PAYLOAD = 64 << 20;

/**
 * A process's connection to the hub. Whichever bridge process binds the port first hosts
 * the hub; the rest connect to it as clients. If the hub process exits, clients re-elect.
 * Events: 'msg' (Msg), 'up', 'down'.
 */
export class Link extends EventEmitter {
  up = false;
  isHub = false;
  private hub?: Hub;
  private local?: Peer;
  private ws?: WebSocket;
  private lastErr = '';
  private seq = 0;

  constructor(public role: Role, public name: string) {
    super();
  }

  start() {
    this.elect();
  }

  setName(name: string) {
    this.name = name;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'hello', name }));
  }

  send(m: Msg): boolean {
    const { hub, local } = this;
    if (hub && local) {
      queueMicrotask(() => hub.handle(local, m));
      return true;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
      return true;
    }
    return false;
  }

  private elect() {
    const token = getToken();
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: getPort(),
      maxPayload: MAX_PAYLOAD,
      verifyClient: (info, cb) => cb(verify(info, token), 401),
    });
    wss.once('listening', () => this.becomeHub(wss));
    wss.once('error', (e: NodeJS.ErrnoException) => {
      wss.close();
      if (e.code === 'EADDRINUSE') this.connect();
      else this.retry(e.message);
    });
  }

  private becomeHub(wss: WebSocketServer) {
    const hub = new Hub();
    this.hub = hub;
    this.isHub = true;
    wss.on('error', (e) => warn('hub error:', e.message));
    wss.on('connection', (ws, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const role = q.get('role') as Role;
      const peer: Peer = {
        id: `${role}-${++this.seq}`,
        role,
        name: q.get('name') || role,
        send: (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)),
      };
      hub.add(peer);
      ws.on('message', (d) => {
        try {
          hub.handle(peer, JSON.parse(String(d)));
        } catch {
          /* ignore malformed frames */
        }
      });
      ws.on('close', () => hub.remove(peer));
      ws.on('error', () => {});
    });

    const self = this;
    const local: Peer = {
      id: 'local',
      role: this.role,
      get name() {
        return self.name;
      },
      set name(v) {
        self.name = v;
      },
      send: (m) => this.emit('msg', m),
    };
    this.local = local;
    hub.add(local);

    // Direct-WebSocket extensions run in an MV3 service worker that sleeps unless traffic flows.
    setInterval(() => {
      for (const b of hub.peers('browser')) if (b !== local) b.send({ t: 'ping' });
    }, 20_000).unref();

    this.setUp(true);
  }

  private connect() {
    const q = new URLSearchParams({ token: getToken(), role: this.role, name: this.name });
    const ws = new WebSocket(`ws://127.0.0.1:${getPort()}/?${q}`, { maxPayload: MAX_PAYLOAD });
    this.ws = ws;
    ws.on('open', () => {
      // The name may have changed while connecting (native host gets it from the extension).
      ws.send(JSON.stringify({ t: 'hello', name: this.name }));
      this.setUp(true);
    });
    ws.on('message', (d) => {
      try {
        this.emit('msg', JSON.parse(String(d)));
      } catch {
        /* ignore */
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      this.note(`hub rejected connection (HTTP ${res.statusCode}); token mismatch?`);
      ws.terminate();
    });
    ws.on('error', (e) => this.note(e.message));
    ws.on('close', () => {
      this.ws = undefined;
      this.setUp(false);
      this.retry();
    });
  }

  private setUp(up: boolean) {
    if (this.up === up) return;
    this.up = up;
    if (up) this.lastErr = '';
    this.emit(up ? 'up' : 'down');
  }

  private note(err: string) {
    if (err !== this.lastErr) warn(err);
    this.lastErr = err;
  }

  private retry(err?: string) {
    if (err) this.note(err);
    setTimeout(() => this.elect(), 300 + Math.random() * 700).unref?.();
  }
}

function verify(info: { origin: string; req: IncomingMessage }, token: string): boolean {
  const q = new URL(info.req.url ?? '/', 'http://x').searchParams;
  const t = Buffer.from(q.get('token') ?? '');
  const want = Buffer.from(token);
  if (t.length !== want.length || !timingSafeEqual(t, want)) return false;
  const origin = info.origin;
  const role = q.get('role');
  // Web pages always send an Origin; only extensions and local processes may connect.
  if (role === 'agent') return !origin;
  if (role === 'browser') return !origin || /^(chrome|moz|ms-browser)-extension:\/\/|^extension:\/\//.test(origin);
  return false;
}
