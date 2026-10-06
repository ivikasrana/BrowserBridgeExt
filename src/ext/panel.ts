import { api, isFirefox } from './env';
import type { Activity, Settings } from './state';

interface State {
  settings: Settings;
  conn: { via: string; up: boolean; err: string };
  activity: Activity[];
  browser: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let state: State | undefined;

const set = (patch: Partial<Settings>) => api.runtime.sendMessage({ t: 'setSettings', patch }).then(render);

function chips(id: string, hosts: string[], key: 'allowed' | 'blocked') {
  const ul = $(id);
  ul.replaceChildren(
    ...hosts.map((h) => {
      const li = document.createElement('li');
      li.textContent = h;
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = 'Remove';
      x.onclick = () => set({ [key]: state!.settings[key].filter((v) => v !== h) });
      li.append(x);
      return li;
    }),
  );
  if (!hosts.length) ul.innerHTML = '<li class="muted" style="background:none">none</li>';
}

function render(s: State) {
  state = s;
  const { settings: st, conn } = s;
  $('dot').classList.toggle('on', conn.up && !st.paused);
  $('status').textContent = st.paused
    ? 'paused'
    : conn.up
      ? `connected via ${conn.via === 'ws' ? 'WebSocket' : 'native host'}`
      : 'not connected';
  $('err').hidden = conn.up || !conn.err;
  $('err').textContent = conn.err;
  $('pause').textContent = st.paused ? 'Resume agent' : 'Pause agent';

  const log = $('log');
  if (s.activity.length) {
    log.replaceChildren(
      ...s.activity
        .slice()
        .reverse()
        .map((a) => {
          const li = document.createElement('li');
          const time = new Date(a.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          li.textContent = `${time} ${a.tool} ${a.info} (${a.ms}ms)`;
          if (!a.ok) li.className = 'bad';
          return li;
        }),
    );
  }

  const active = document.activeElement;
  for (const k of ['mode', 'transport', 'port', 'token'] as const) {
    const el = $<HTMLInputElement>(k);
    if (el !== active) el.value = String(st[k]);
  }
  $<HTMLInputElement>('debugger').checked = st.debugger;
  chips('allowed', st.allowed, 'allowed');
  chips('blocked', st.blocked, 'blocked');
}

$('pause').onclick = () => set({ paused: !state?.settings.paused });
$<HTMLSelectElement>('mode').onchange = (e) => set({ mode: (e.target as HTMLSelectElement).value as Settings['mode'] });
$<HTMLInputElement>('debugger').onchange = (e) => set({ debugger: (e.target as HTMLInputElement).checked });
$('save').onclick = () =>
  set({
    transport: $<HTMLSelectElement>('transport').value as Settings['transport'],
    port: Number($<HTMLInputElement>('port').value) || 47821,
    token: $<HTMLInputElement>('token').value.trim(),
  });
$('reconnect').onclick = () => api.runtime.sendMessage({ t: 'reconnect' });
$('blockForm').onsubmit = (e) => {
  e.preventDefault();
  const h = $<HTMLInputElement>('blockHost').value.trim().replace(/^https?:\/\//, '').split('/')[0];
  if (h && state) set({ blocked: [...new Set([...state.settings.blocked, h])] });
  $<HTMLInputElement>('blockHost').value = '';
};

// Side panel (Chromium) / sidebar (Firefox).
$('side').onclick = async () => {
  try {
    if (isFirefox) await (globalThis as any).browser.sidebarAction.open();
    else {
      const w = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: w.id! });
    }
    window.close();
  } catch {
    $('side').hidden = true;
  }
};
if (new URLSearchParams(location.search).has('side') || location.pathname.endsWith('side.html')) $('side').hidden = true;

// Firefox MV3 treats host permissions as optional until the user grants them.
if (isFirefox) {
  const all = { origins: ['<all_urls>'] };
  api.permissions.contains(all).then((ok) => ($('grant').hidden = ok));
  $('grant').onclick = () => api.permissions.request(all).then((ok) => ($('grant').hidden = ok));
}
if (isFirefox) $('dbgRow').hidden = true;

api.runtime.sendMessage({ t: 'getState' }).then(render);
api.runtime.onMessage.addListener((m: any) => {
  if (m?.t === 'state') render(m.s);
});
