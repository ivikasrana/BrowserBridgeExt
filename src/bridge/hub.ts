import { NO_BROWSER, type Msg, type Role } from '../shared/protocol';

export interface Peer {
  id: string;
  role: Role;
  name: string;
  send(m: Msg): void;
}

/** Routes tool calls from agents to a browser and results back. One hub per machine. */
export class Hub {
  private browsers = new Map<string, Peer>();
  private agents = new Map<string, Peer>();
  private pending = new Map<number, { agent: Peer; id: number; browser: string }>();
  private seq = 0;

  add(p: Peer) {
    this.of(p.role).set(p.id, p);
  }

  remove(p: Peer) {
    this.of(p.role).delete(p.id);
    for (const [k, q] of this.pending) {
      if (q.browser === p.id) {
        q.agent.send({ t: 'res', id: q.id, ok: false, error: 'Browser disconnected during the call.' });
        this.pending.delete(k);
      } else if (q.agent === p) this.pending.delete(k);
    }
  }

  peers(role: Role) {
    return [...this.of(role).values()];
  }

  handle(p: Peer, m: Msg) {
    switch (m.t) {
      case 'hello':
        p.name = m.name;
        return;
      case 'call': {
        if (p.role !== 'agent') return;
        if (m.tool === '__status') {
          p.send({ t: 'res', id: m.id, ok: true, result: { text: this.status() } });
          return;
        }
        const b = this.pick(m.prefer);
        if (!b) {
          p.send({ t: 'res', id: m.id, ok: false, error: NO_BROWSER });
          return;
        }
        const hid = ++this.seq;
        this.pending.set(hid, { agent: p, id: m.id, browser: b.id });
        b.send({ ...m, id: hid, sid: m.sid ?? p.id });
        return;
      }
      case 'res': {
        if (p.role !== 'browser') return;
        const q = this.pending.get(m.id);
        if (!q) return;
        this.pending.delete(m.id);
        q.agent.send({ ...m, id: q.id });
        return;
      }
    }
  }

  /** Most recently connected browser, or the latest whose name matches `prefer`. */
  private pick(prefer?: string): Peer | undefined {
    const list = this.peers('browser');
    const want = prefer?.toLowerCase();
    return (want && list.findLast((b) => b.name.includes(want))) || list.at(-1);
  }

  private status() {
    const names = (r: Role) => this.peers(r).map((p) => p.name).join(', ') || 'none';
    return `hub pid ${process.pid}\nbrowsers: ${names('browser')}\nagents: ${names('agent')}`;
  }

  private of(role: Role) {
    return role === 'browser' ? this.browsers : this.agents;
  }
}
