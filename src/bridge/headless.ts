import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentClient } from './client';
import { dataDir } from './config';
import { Link } from './link';

const WIN = platform() === 'win32';
const MAC = platform() === 'darwin';
const cftDir = join(dataDir, 'chrome-for-testing');
const extDir = join(dirname(__filename), 'chrome');

/** Chromium-family executables, best choice for headless first. */
function candidates(): { kind: string; path: string }[] {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], join(homedir(), 'AppData/Local')].filter(Boolean) as string[];
  const list: { kind: string; path: string }[] = [];
  if (process.env.BROWSERBRIDGE_CHROME) list.push({ kind: 'custom', path: process.env.BROWSERBRIDGE_CHROME });
  if (existsSync(cftDir)) {
    const sub = readdirSync(cftDir).find((d) => d.startsWith('chrome-'));
    if (sub) list.push({ kind: 'testing', path: join(cftDir, sub, WIN ? 'chrome.exe' : MAC ? 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' : 'chrome') });
  }
  if (WIN) {
    for (const p of pf) list.push({ kind: 'chromium', path: join(p, 'Chromium/Application/chrome.exe') });
    for (const p of pf) list.push({ kind: 'chrome', path: join(p, 'Google/Chrome/Application/chrome.exe') });
    for (const p of pf) list.push({ kind: 'edge', path: join(p, 'Microsoft/Edge/Application/msedge.exe') });
  } else if (MAC) {
    list.push({ kind: 'chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' });
    list.push({ kind: 'chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  } else {
    for (const [kind, p] of [['chromium', '/usr/bin/chromium'], ['chromium', '/usr/bin/chromium-browser'], ['chrome', '/usr/bin/google-chrome']])
      list.push({ kind, path: p });
  }
  return list.filter((c) => existsSync(c.path));
}

/** Downloads Chrome for Testing (still honours --load-extension) into ~/.browserbridge. */
export async function getChromium() {
  const plat = WIN ? 'win64' : MAC ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : 'linux64';
  const meta: any = await (await fetch('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json')).json();
  const { version, downloads } = meta.channels.Stable;
  const url: string = downloads.chrome.find((d: any) => d.platform === plat).url;
  console.log(`Downloading Chrome for Testing ${version} (${plat})...`);
  mkdirSync(cftDir, { recursive: true });
  const zip = join(cftDir, 'cft.zip');
  writeFileSync(zip, Buffer.from(await (await fetch(url)).arrayBuffer()));
  if (WIN) execFileSync(join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', cftDir]);
  else execFileSync('unzip', ['-oq', zip, '-d', cftDir]);
  console.log('Installed to ' + cftDir);
}

const profileOf = (o: Record<string, string>) => o.profile || join(dataDir, 'headless-profile');

/**
 * Starts a Chromium browser with the extension. Chrome for Testing / Chromium take the extension
 * through --load-extension; branded Chrome 137+ ignores that flag, so it relies on the extension
 * having been loaded once in this profile (`headless --setup`).
 */
export async function headless(o: Record<string, string>) {
  const found = candidates();
  const pick = o.browser ? found.find((c) => c.kind === o.browser) : found[0];
  if (!pick) throw new Error('No Chromium browser found. Run: browser-bridge get-chromium (or set BROWSERBRIDGE_CHROME).');
  if (!existsSync(extDir)) throw new Error('Extension build missing next to bridge.cjs: ' + extDir);
  const setup = 'setup' in o;
  const args = [
    `--user-data-dir=${profileOf(o)}`,
    `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (setup) args.push('chrome://extensions');
  else args.push('--headless=new', 'about:blank');
  spawn(pick.path, args, { detached: true, stdio: 'ignore' }).unref();
  console.log(`${setup ? 'Opened' : 'Started headless'} ${pick.kind}: ${pick.path}\n  profile: ${profileOf(o)}`);
  if (setup) {
    console.log('Enable Developer mode, click "Load unpacked" and choose:\n  ' + extDir + '\nThen close that window.');
    return;
  }
  const link = new Link('agent', 'cli');
  const client = new AgentClient(link);
  link.start();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = (await client.call('__status', {}).catch(() => ({ text: '' }))).text ?? '';
    if (/headless/.test(s)) {
      console.log('Connected:\n' + s);
      process.exit(0);
    }
  }
  console.error('Browser started but the extension did not connect (branded Chrome needs `headless --setup` once).');
  process.exit(1);
}
