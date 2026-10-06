import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { GECKO_ID, HOST_NAME } from '../shared/protocol';
import { getPort, getToken, dataDir } from './config';

const WIN = platform() === 'win32';
const MAC = platform() === 'darwin';

const WIN_KEYS = {
  chromium: [
    'Software\\Google\\Chrome',
    'Software\\Microsoft\\Edge',
    'Software\\Chromium',
    'Software\\BraveSoftware\\Brave-Browser',
  ],
  firefox: ['Software\\Mozilla'],
};

const UNIX_DIRS = {
  chromium: MAC
    ? ['Google/Chrome', 'Microsoft Edge', 'Chromium', 'BraveSoftware/Brave-Browser'].map(
        (d) => `Library/Application Support/${d}/NativeMessagingHosts`,
      )
    : ['google-chrome', 'microsoft-edge', 'chromium', 'BraveSoftware/Brave-Browser'].map(
        (d) => `.config/${d}/NativeMessagingHosts`,
      ),
  firefox: [MAC ? 'Library/Application Support/Mozilla/NativeMessagingHosts' : '.mozilla/native-messaging-hosts'],
};

function extIds(): { chrome?: string; edge?: string } {
  const p = join(dirname(__filename), 'ext-id.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

export function install(opts: Record<string, string>) {
  const ids = extIds();
  const chromiumIds = [...new Set([opts['chrome-id'] ?? ids.chrome, opts['edge-id'] ?? ids.edge].filter(Boolean))];
  if (!chromiumIds.length) throw new Error('Unknown extension id. Run the build first or pass --chrome-id <id>.');

  mkdirSync(dataDir, { recursive: true });
  const token = getToken();

  // The browser launches this script, which starts the bridge in native-host mode.
  let launcher: string;
  if (WIN) {
    launcher = join(dataDir, 'browserbridge-host.bat');
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${__filename}" native %*\r\n`);
  } else {
    launcher = join(dataDir, 'browserbridge-host.sh');
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${__filename}" native "$@"\n`, { mode: 0o755 });
  }

  const base = { name: HOST_NAME, description: 'Browser Bridge Ext', path: launcher, type: 'stdio' };
  const manifests = {
    chromium: { ...base, allowed_origins: chromiumIds.map((id) => `chrome-extension://${id}/`) },
    firefox: { ...base, allowed_extensions: [GECKO_ID] },
  };

  for (const kind of ['chromium', 'firefox'] as const) {
    const json = JSON.stringify(manifests[kind], null, 2);
    if (WIN) {
      const file = join(dataDir, `${HOST_NAME}.${kind}.json`);
      writeFileSync(file, json);
      for (const k of WIN_KEYS[kind])
        execFileSync('reg', ['add', `HKCU\\${k}\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], {
          stdio: 'ignore',
        });
    } else {
      for (const d of UNIX_DIRS[kind]) {
        const dir = join(homedir(), d);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${HOST_NAME}.json`), json);
      }
    }
  }

  console.log(`Native host registered for Chrome, Edge, Chromium, Brave and Firefox.
  launcher:      ${launcher}
  extension ids: ${chromiumIds.join(', ')} (Chromium), ${GECKO_ID} (Firefox)
  hub:           ws://127.0.0.1:${getPort()}
  token:         ${token}   (only needed for the extension's WebSocket transport)

Next: load the extension (see README), then add this MCP server to your agent:
  command: "${process.execPath}"   args: ["${__filename}"]`);
}

export function uninstall() {
  for (const kind of ['chromium', 'firefox'] as const) {
    if (WIN) {
      for (const k of WIN_KEYS[kind]) {
        try {
          execFileSync('reg', ['delete', `HKCU\\${k}\\NativeMessagingHosts\\${HOST_NAME}`, '/f'], { stdio: 'ignore' });
        } catch {
          /* not registered */
        }
      }
      rmSync(join(dataDir, `${HOST_NAME}.${kind}.json`), { force: true });
    } else {
      for (const d of UNIX_DIRS[kind]) rmSync(join(homedir(), d, `${HOST_NAME}.json`), { force: true });
    }
  }
  rmSync(join(dataDir, WIN ? 'browserbridge-host.bat' : 'browserbridge-host.sh'), { force: true });
  console.log('Native host unregistered. Token kept in ' + dataDir);
}
