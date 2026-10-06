import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { NO_BROWSER, type Msg, type ToolResult } from '../shared/protocol';
import { getPort } from './config';
import { Link } from './link';

const CALL_TIMEOUT = 150_000; // covers a user approving a site in the browser
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.html': 'text/html', '.zip': 'application/zip', '.mp4': 'video/mp4',
};

/** Agent-side caller: sends tool calls to the hub and handles local file I/O around them. */
export class AgentClient {
  private seq = 0;
  private pending = new Map<number, { res: (r: ToolResult) => void; rej: (e: Error) => void }>();
  private sid = randomBytes(6).toString('hex');

  constructor(private link: Link, private prefer = process.env.BROWSERBRIDGE_BROWSER) {
    link.on('msg', (m: Msg) => {
      if (m.t !== 'res') return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.res(m.result);
      else p.rej(new Error(m.error));
    });
    link.on('down', () => {
      for (const p of this.pending.values()) p.rej(new Error('Bridge reconnecting; retry the call.'));
      this.pending.clear();
    });
  }

  async call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    args = prepare(tool, args);
    const deadline = Date.now() + 6000;
    for (;;) {
      await this.waitUp(deadline);
      try {
        return finish(tool, args, await this.send(tool, args));
      } catch (e) {
        if ((e as Error).message !== NO_BROWSER) throw e;
        if (Date.now() > deadline)
          throw new Error(
            'No browser connected. Open Chrome, Edge or Firefox with the Browser Bridge Ext extension enabled (one-time setup: browser-bridge install).',
          );
        await sleep(500);
      }
    }
  }

  private send(tool: string, args: Record<string, unknown>) {
    const id = ++this.seq;
    return new Promise<ToolResult>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${tool} timed out`));
      }, CALL_TIMEOUT);
      this.pending.set(id, {
        res: (r) => (clearTimeout(timer), res(r)),
        rej: (e) => (clearTimeout(timer), rej(e)),
      });
      this.link.send({ t: 'call', id, tool, args, sid: this.sid, prefer: this.prefer });
    });
  }

  private async waitUp(deadline: number) {
    while (!this.link.up) {
      if (Date.now() > deadline) throw new Error(`Bridge hub not reachable on 127.0.0.1:${getPort()}.`);
      await sleep(100);
    }
  }
}

/** Read local files the browser needs (uploads). */
function prepare(tool: string, args: Record<string, unknown>) {
  if (tool === 'act' && args.a === 'upload') {
    const files = args.files;
    if (!Array.isArray(files) || !files.length) throw new Error('upload needs files: [paths]');
    args = {
      ...args,
      files: files.map((f) => {
        const p = resolve(String(f));
        return {
          name: basename(p),
          mime: MIME[extname(p).toLowerCase()] ?? 'application/octet-stream',
          data: readFileSync(p).toString('base64'),
        };
      }),
    };
  }
  return args;
}

/** Write binary results to disk so they never enter the model context. */
function finish(tool: string, args: Record<string, unknown>, r: ToolResult): ToolResult {
  if (r.file) {
    const p = resolve(String(args.path || `browserbridge-${Date.now()}.${r.file.ext}`));
    const buf = Buffer.from(r.file.data, 'base64');
    writeFileSync(p, buf);
    return { text: `saved ${p} (${Math.round(buf.length / 1024)} KB${r.text ? ', ' + r.text : ''})` };
  }
  if (tool === 'shot' && args.save && r.image) {
    const p = resolve(String(args.save));
    writeFileSync(p, Buffer.from(r.image.data, 'base64'));
    return { text: `saved ${p}${r.text ? ' ' + r.text : ''}` };
  }
  return r;
}
