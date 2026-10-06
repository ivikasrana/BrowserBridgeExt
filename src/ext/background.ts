import { HOST_NAME, type Msg } from '../shared/protocol';
import { detachAll } from './cdp';
import { api, browserName, clip } from './env';
import './net';
import { resolveApproval } from './permissions';
import { agentTabs, conn, logActivity, ready, saveSettings, settings, snapshot, broadcast, type Settings } from './state';
import { runTool } from './tools';

// ---------- connection to the bridge: native messaging first, WebSocket as fallback

let port: chrome.runtime.Port | null = null;
let ws: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let backoff = 1000;

function setConn(patch: Partial<typeof conn>) {
  Object.assign(conn, patch);
  broadcast();
}

function send(m: Msg) {
  if (port) port.postMessage(m);
  else if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function connect() {
  if (port || ws) return;
  clearTimeout(retryTimer);
  if (settings.transport === 'ws') connectWs();
  else connectNative();
}

function reconnect() {
  port?.disconnect();
  ws?.close();
  port = null;
  ws = null;
  backoff = 1000;
  setConn({ via: '', up: false, err: '' });
  connect();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 10_000);
}

function connectNative() {
  let p: chrome.runtime.Port;
  try {
    p = api.runtime.connectNative(HOST_NAME);
  } catch (e) {
    return nativeFailed(String(e));
  }
  port = p;
  setConn({ via: 'native', up: false, err: '' });
  p.onMessage.addListener((m: Msg) => {
    if (m.t === 'link') {
      if (m.up) backoff = 1000;
      setConn({ up: m.up, err: m.up ? '' : 'hub reconnecting' });
    } else onMessage(m);
  });
  p.onDisconnect.addListener(() => {
    const err = (p as any).error?.message ?? api.runtime.lastError?.message ?? 'native host exited';
    port = null;
    nativeFailed(err);
  });
  p.postMessage({ t: 'hello', name: browserName });
}

function nativeFailed(err: string) {
  setConn({ via: '', up: false, err });
  if (settings.transport === 'auto' && settings.token) connectWs();
  else scheduleRetry();
}

function connectWs() {
  if (!settings.token) {
    setConn({ via: '', up: false, err: 'WebSocket transport needs the token (browser-bridge token)' });
    return scheduleRetry();
  }
  const q = new URLSearchParams({ token: settings.token, role: 'browser', name: browserName });
  const s = new WebSocket(`ws://127.0.0.1:${settings.port}/?${q}`);
  ws = s;
  s.onopen = () => {
    backoff = 1000;
    setConn({ via: 'ws', up: true, err: '' });
  };
  s.onmessage = (e) => {
    try {
      onMessage(JSON.parse(String(e.data)));
    } catch {
      /* ignore */
    }
  };
  s.onclose = () => {
    if (ws === s) ws = null;
    setConn({ via: '', up: false, err: conn.err || 'no hub; start an agent with the MCP server' });
    scheduleRetry();
  };
  s.onerror = () => setConn({ err: 'no hub on port ' + settings.port });
}

function onMessage(m: Msg) {
  if (m.t === 'ping') return send({ t: 'pong' });
  if (m.t === 'call') void handleCall(m);
}

async function handleCall(m: Extract<Msg, { t: 'call' }>) {
  const t0 = Date.now();
  const info = clip(
    Object.entries(m.args ?? {})
      .filter(([k]) => k !== 'files')
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' '),
    80,
  );
  try {
    const result = await runTool(m.tool, m.args ?? {}, m.sid ?? 'default');
    send({ t: 'res', id: m.id, ok: true, result });
    logActivity({ t: t0, tool: m.tool, info, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    const error = (e as Error)?.message ?? String(e);
    send({ t: 'res', id: m.id, ok: false, error });
    logActivity({ t: t0, tool: m.tool, info: info + ' → ' + error, ok: false, ms: Date.now() - t0 });
  }
}

// ---------- messages from panel, approval window and content scripts

api.runtime.onMessage.addListener((m: any, sender, reply) => {
  switch (m?.t) {
    case 'getState':
      ready.then(() => reply(snapshot()));
      return true;
    case 'setSettings':
      ready.then(async () => {
        const patch = m.patch as Partial<Settings>;
        const relink = ['transport', 'port', 'token'].some((k) => k in patch);
        await saveSettings(patch);
        if (patch.paused || patch.debugger === false) await detachAll();
        if (relink) reconnect();
        reply(snapshot());
      });
      return true;
    case 'reconnect':
      reconnect();
      return false;
    case 'approve':
      resolveApproval(m.id, m.d);
      return false;
    case 'isAgent':
      reply(sender.tab?.id != null && agentTabs.has(sender.tab.id));
      return false;
  }
  return false;
});

api.tabs.onRemoved.addListener((id) => agentTabs.delete(id));

// Wake periodically so a sleeping service worker reconnects.
api.alarms.create('bb-keepalive', { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener(() => ready.then(connect));
api.runtime.onStartup.addListener(() => ready.then(connect));
api.runtime.onInstalled.addListener(() => ready.then(connect));
ready.then(connect);
