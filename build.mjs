// Builds the bridge (dist/bridge.cjs) and the extension for chrome, edge and firefox (dist/<browser>/).
import * as esbuild from 'esbuild';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const GECKO_ID = 'browser-bridge-ext@browserbridge.local';
const define = { __VERSION__: JSON.stringify(pkg.version) };

// A fixed key gives the unpacked Chromium extension a stable id the native host can allow.
mkdirSync('keys', { recursive: true });
const keyPath = 'keys/extension.pem';
if (!existsSync(keyPath)) {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  writeFileSync(keyPath, privateKey);
}
const der = createPublicKey(readFileSync(keyPath)).export({ type: 'spki', format: 'der' });
const extId = [...createHash('sha256').update(der).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

rmSync('dist', { recursive: true, force: true });

await esbuild.build({
  entryPoints: ['src/bridge/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/bridge.cjs',
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: '#!/usr/bin/env node' },
  define,
  logLevel: 'warning',
});
writeFileSync('dist/ext-id.json', JSON.stringify({ chrome: extId, edge: extId, firefox: GECKO_ID }, null, 2));

// ---- icons: an orange ring, drawn into a PNG without image dependencies
function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / (size / 2);
      const ring = d < 0.95 && d > 0.62;
      const dotIn = d < 0.32;
      const a = ring || dotIn ? 255 : 0;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = 224; raw[o + 1] = 102; raw[o + 2] = 42; raw[o + 3] = a;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  const crc = (b) => {
    let x = 0xffffffff;
    for (const v of b) x = crcTable[(x ^ v) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const cr = Buffer.alloc(4);
    cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const icons = { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' };

// ---- extension
const common = {
  version: pkg.version,
  name: 'Browser Bridge Ext',
  description: 'Lets local coding agents read and control this browser.',
  icons,
  host_permissions: ['<all_urls>'],
  content_scripts: [
    { matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_start' },
    { matches: ['<all_urls>'], js: ['hook.js'], run_at: 'document_start', world: 'MAIN' },
  ],
  action: { default_title: 'Browser Bridge Ext', default_popup: 'panel.html', default_icon: icons },
};

const manifests = {
  chrome: {
    manifest_version: 3,
    ...common,
    key: der.toString('base64'),
    minimum_chrome_version: '116',
    permissions: ['tabs', 'scripting', 'storage', 'alarms', 'nativeMessaging', 'debugger', 'webRequest', 'sidePanel', 'tabGroups'],
    background: { service_worker: 'background.js' },
    side_panel: { default_path: 'side.html' },
  },
  firefox: {
    manifest_version: 3,
    ...common,
    permissions: ['tabs', 'scripting', 'storage', 'alarms', 'nativeMessaging', 'webRequest'],
    background: { scripts: ['background.js'] },
    sidebar_action: { default_panel: 'side.html', default_title: 'Browser Bridge', default_icon: icons },
    // The default MV3 policy upgrades ws:// to wss://, which would break the localhost hub.
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
    browser_specific_settings: {
      gecko: { id: GECKO_ID, strict_min_version: '128.0', data_collection_permissions: { required: ['none'] } },
    },
  },
};
manifests.edge = manifests.chrome;

for (const target of ['chrome', 'edge', 'firefox']) {
  const out = `dist/${target}`;
  await esbuild.build({
    entryPoints: {
      background: 'src/ext/background.ts',
      content: 'src/ext/content.ts',
      hook: 'src/ext/hook.ts',
      panel: 'src/ext/panel.ts',
      approve: 'src/ext/approve.ts',
    },
    bundle: true,
    format: 'iife',
    target: ['chrome116', 'firefox128'],
    outdir: out,
    define,
    logLevel: 'warning',
  });
  for (const f of readdirSync('src/ext/static')) copyFileSync(`src/ext/static/${f}`, `${out}/${f}`);
  copyFileSync(`${out}/panel.html`, `${out}/side.html`);
  mkdirSync(`${out}/icons`);
  for (const s of Object.keys(icons)) writeFileSync(`${out}/icons/${s}.png`, png(Number(s)));
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifests[target], null, 2));
}

// ---- agent skill / instructions file with this machine's absolute path filled in
const bridge = resolve('dist/bridge.cjs').replace(/\\/g, '/');
writeFileSync('dist/SKILL.md', readFileSync('skill/SKILL.md', 'utf8').replaceAll('{{BRIDGE}}', bridge));

console.log(`built dist/ (bridge.cjs, chrome, edge, firefox)  chromium extension id: ${extId}`);
