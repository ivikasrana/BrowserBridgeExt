import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toolsReference } from '../shared/tools';
import { AgentClient } from './client';
import { getToken } from './config';
import { getChromium, headless } from './headless';
import { install, uninstall } from './install';
import { Link } from './link';
import { runMcp } from './mcp';
import { runNative } from './native';

const USAGE = `browser-bridge                  MCP server on stdio (default)
browser-bridge serve        headless hub for startup tasks (no stdin needed)
browser-bridge call <tool> [k=v ...|json]   one call, prints the result (for harnesses without MCP)
browser-bridge tools            compact tool reference
browser-bridge install [--chrome-id ID] [--edge-id ID]   register the native messaging host
browser-bridge get-chromium   download Chrome for Testing (supports --load-extension)
browser-bridge headless [--browser testing|chromium|chrome|edge] [--profile DIR] [--setup]
browser-bridge uninstall
browser-bridge status           show hub, connected browsers and agents
browser-bridge token            print the WebSocket token`;

const [cmd = 'mcp', ...rest] = process.argv.slice(2);

function flags(a: string[]) {
  const o: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) if (a[i].startsWith('--')) o[a[i].slice(2)] = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : '';
  return o;
}

/** `ref=e3 a=click fields={"e1":"x"}` -> object; values are JSON when they parse. */
function parseArgs(a: string[]): Record<string, unknown> {
  if (a.length === 1 && a[0].trim().startsWith('{')) return JSON.parse(a[0]);
  const o: Record<string, unknown> = {};
  for (const kv of a) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`Bad argument "${kv}", expected key=value`);
    const v = kv.slice(i + 1);
    try {
      o[kv.slice(0, i)] = JSON.parse(v);
    } catch {
      o[kv.slice(0, i)] = v;
    }
  }
  return o;
}

async function oneShot(tool: string, args: Record<string, unknown>) {
  const link = new Link('agent', 'cli');
  const client = new AgentClient(link);
  link.start();
  try {
    const r = await client.call(tool, args);
    if (r.image) {
      const p = join(tmpdir(), `browserbridge-shot-${Date.now()}.jpg`);
      writeFileSync(p, Buffer.from(r.image.data, 'base64'));
      console.log(`image ${p}${r.text ? ' ' + r.text : ''}`);
    } else console.log(r.text ?? 'ok');
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

switch (cmd) {
  case 'mcp':
    runMcp();
    break;
  case 'serve':
    // Long-lived headless hub (no stdio): MCP sessions and the native host attach to it.
    new Link('agent', 'daemon').start();
    setInterval(() => {}, 1 << 30);
    break;
  case 'headless':
    headless(flags(rest)).catch((e) => (console.error(e.message), process.exit(1)));
    break;
  case 'get-chromium':
    getChromium().catch((e) => (console.error(e.message), process.exit(1)));
    break;
  case 'native':
    runNative();
    break;
  case 'call':
    if (!rest[0]) {
      console.error('usage: browser-bridge call <tool> [k=v ...]');
      process.exit(2);
    }
    void oneShot(rest[0], parseArgs(rest.slice(1)));
    break;
  case 'status':
    void oneShot('__status', {});
    break;
  case 'tools':
    console.log(toolsReference());
    break;
  case 'install':
    install(flags(rest));
    break;
  case 'uninstall':
    uninstall();
    break;
  case 'token':
    console.log(getToken());
    break;
  default:
    // Chrome launches native hosts with the caller origin as the first argument,
    // Firefox with the manifest path; treat both as native mode.
    if (/^chrome-extension:|\.json$/i.test(cmd)) runNative();
    else {
      console.log(USAGE);
      process.exit(cmd === 'help' || cmd === '--help' ? 0 : 2);
    }
}
