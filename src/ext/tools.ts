import { parseKeys } from '../shared/keys';
import type { ToolResult } from '../shared/protocol';
import { cdp, cdpDrag, cdpEnabled, cdpKeys, cdpMouse } from './cdp';
import { api, clip, isFirefox, sleep } from './env';
import { b64, bitmapOf, captureVisible, encodeJpeg, gifFrame, gifSave, gifStart, gifStop, isRecording, type Rect } from './image';
import { netLines } from './net';
import { ensureAllowed } from './permissions';
import { agentTabs, ready, settings } from './state';

type Args = Record<string, any>;
type Tab = chrome.tabs.Tab & { id: number };
type Pt = { x: number; y: number; cover?: string };

/** Selected tab per agent session. */
const sessionTab = new Map<string, number>();
/** Maps last screenshot pixels to document CSS px: doc = o + px * k. */
const shotMap = new Map<number, { ox: number; oy: number; k: number }>();
let agentGroup: number | undefined;

export async function runTool(tool: string, a: Args, sid: string): Promise<ToolResult> {
  await ready;
  if (settings.paused) throw new Error('Paused by the user in the browser panel.');
  switch (tool) {
    case 'tabs':
      return tabsTool(a, sid);
    case 'nav':
      return navTool(a, sid);
    case 'read':
      return readTool(a, sid);
    case 'act':
      return actTool(a, sid);
    case 'shot':
      return shotTool(a, sid);
    case 'js':
      return jsTool(a, sid);
    case 'logs':
      return logsTool(a, sid);
    case 'gif':
      return gifTool(a, sid);
  }
  throw new Error(`Unknown tool ${tool}`);
}

// ---------- helpers

async function getTab(a: Args, sid: string): Promise<Tab> {
  const id: number | undefined = a.tab ?? sessionTab.get(sid);
  if (id != null) {
    try {
      return (await api.tabs.get(id)) as Tab;
    } catch {
      if (a.tab != null) throw new Error(`No tab ${id}`);
      sessionTab.delete(sid);
    }
  }
  const [t] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (t?.id == null) throw new Error('No active tab');
  sessionTab.set(sid, t.id);
  return t as Tab;
}

async function target(a: Args, sid: string, tool: string): Promise<Tab> {
  const tab = await getTab(a, sid);
  await ensureAllowed(tab.url, tool);
  agentTabs.add(tab.id);
  return tab;
}

/** Message the tab's content script, injecting it if the tab predates the extension. */
async function cs<T = any>(tabId: number, msg: Args): Promise<T> {
  let r: any;
  try {
    r = await api.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch (e) {
    if (!/Receiving end|Could not establish/i.test(String(e))) throw e;
    await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await api.scripting.executeScript({ target: { tabId }, files: ['hook.js'], world: 'MAIN' } as any).catch(() => {});
    r = await api.tabs.sendMessage(tabId, msg, { frameId: 0 });
  }
  if (r?.error) throw new Error(r.error);
  return r?.value as T;
}

async function waitLoad(tabId: number, ms = 20_000) {
  await sleep(150);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = await api.tabs.get(tabId).catch(() => null);
    if (!t || t.status === 'complete') return;
    await sleep(150);
  }
}

function normUrl(u: string) {
  if (/^[a-z][\w+.-]*:/i.test(u)) return u;
  if (/^(localhost|127\.|\[?::1|\d+\.\d+\.\d+\.\d+)/.test(u)) return 'http://' + u;
  return 'https://' + u;
}

const tabLine = (t: chrome.tabs.Tab) => `${t.id} ${clip(t.title, 60)} | ${clip(t.url, 100)}`;

async function addToGroup(tabId: number) {
  if (isFirefox || !chrome.tabGroups) return;
  try {
    if (agentGroup != null) await chrome.tabGroups.get(agentGroup).catch(() => (agentGroup = undefined));
    agentGroup = await chrome.tabs.group({ tabIds: [tabId], ...(agentGroup != null ? { groupId: agentGroup } : {}) });
    await chrome.tabGroups.update(agentGroup, { title: 'Agent', color: 'orange' });
  } catch {
    /* tab groups are cosmetic */
  }
}

async function frame(tab: Tab, mark?: Pt) {
  if (!isRecording(tab.id)) return;
  try {
    const t = await api.tabs.get(tab.id);
    if (!t.active) return;
    const bmp = await bitmapOf(await captureVisible(t.windowId));
    const k = bmp.width / (t.width || bmp.width);
    gifFrame(tab.id, bmp, mark && { x: mark.x * k, y: mark.y * k });
  } catch {
    /* a missed frame is fine */
  }
}

async function tryCdp(run: () => Promise<unknown>, fallback: () => Promise<unknown>) {
  if (!cdpEnabled()) return fallback();
  try {
    return await run();
  } catch {
    return fallback();
  }
}

/** Resolve a target point in viewport CSS px from a ref or screenshot pixels. */
async function point(tabId: number, a: Args): Promise<Pt> {
  if (a.ref) return cs(tabId, { op: 'locate', ref: a.ref });
  if (a.x == null || a.y == null) throw new Error('Give ref or x,y');
  const m = shotMap.get(tabId);
  const doc = m ? { x: m.ox + a.x * m.k, y: m.oy + a.y * m.k } : null;
  return cs(tabId, { op: 'ensurePoint', x: a.x, y: a.y, doc });
}

// ---------- tools

async function tabsTool(a: Args, sid: string): Promise<ToolResult> {
  switch (a.a ?? 'list') {
    case 'list': {
      const cur = sessionTab.get(sid);
      const tabs = await api.tabs.query(a.all ? {} : { lastFocusedWindow: true });
      return {
        text: tabs
          .map((t) => `${t.id}${t.id === cur ? '>' : ''}${t.active ? '*' : ''} ${clip(t.title, 60)} | ${clip(t.url, 100)}`)
          .join('\n'),
      };
    }
    case 'new': {
      const url = a.url ? normUrl(a.url) : undefined;
      if (url) await ensureAllowed(url, 'nav');
      const t = (await api.tabs.create({ url, active: true })) as Tab;
      await addToGroup(t.id);
      sessionTab.set(sid, t.id);
      agentTabs.add(t.id);
      if (url) await waitLoad(t.id);
      return { text: tabLine(await api.tabs.get(t.id)) };
    }
    case 'select': {
      if (a.tab == null) throw new Error('select needs tab');
      const t = await api.tabs.update(a.tab, { active: true });
      if (t?.windowId != null) await api.windows.update(t.windowId, { focused: true });
      sessionTab.set(sid, a.tab);
      return { text: tabLine(await api.tabs.get(a.tab)) };
    }
    case 'close': {
      const id = a.tab ?? (await getTab(a, sid)).id;
      await api.tabs.remove(id);
      if (sessionTab.get(sid) === id) sessionTab.delete(sid);
      return { text: 'ok' };
    }
    case 'resize': {
      const t = await getTab(a, sid);
      await api.windows.update(t.windowId, { state: 'normal', width: a.w, height: a.h });
      return { text: 'ok' };
    }
  }
  throw new Error('a must be list|new|select|close|resize');
}

async function navTool(a: Args, sid: string): Promise<ToolResult> {
  const tab = await getTab(a, sid);
  const u = String(a.url ?? '');
  if (u === 'back') await api.tabs.goBack(tab.id);
  else if (u === 'forward') await api.tabs.goForward(tab.id);
  else if (u === 'reload') await api.tabs.reload(tab.id);
  else {
    if (!u) throw new Error('nav needs url');
    const url = normUrl(u);
    await ensureAllowed(url, 'nav');
    await api.tabs.update(tab.id, { url });
  }
  agentTabs.add(tab.id);
  await waitLoad(tab.id);
  const t = (await api.tabs.get(tab.id)) as Tab;
  await frame(t);
  let text = `${t.title} | ${t.url}`;
  if (a.read) {
    await ensureAllowed(t.url, 'read');
    text += '\n' + (await cs(t.id, { op: 'read' }));
  }
  return { text };
}

async function readTool(a: Args, sid: string): Promise<ToolResult> {
  const tab = await target(a, sid, 'read');
  return { text: await cs(tab.id, { op: 'read', mode: a.mode, q: a.q, ref: a.ref, max: a.max, offset: a.offset }) };
}

async function actTool(a: Args, sid: string): Promise<ToolResult> {
  const tab = await target(a, sid, 'act');
  const id = tab.id;
  let note = '';
  let mark: Pt | undefined;

  switch (a.a) {
    case 'click':
    case 'dblclick':
    case 'rclick':
    case 'hover': {
      const p = (mark = await point(id, a));
      if (p.cover) note = ` (covered by ${p.cover})`;
      await tryCdp(
        () => cdpMouse(id, a.a, p),
        () => cs(id, { op: 'mouse', kind: a.a, ref: a.ref, x: p.x, y: p.y }),
      );
      break;
    }
    case 'type': {
      if (a.text == null) throw new Error('type needs text');
      if (a.ref) await focus(id, a.ref);
      await tryCdp(
        () => cdp(id, 'Input.insertText', { text: String(a.text) }),
        () => cs(id, { op: 'type', text: String(a.text) }),
      );
      break;
    }
    case 'key': {
      const keys = parseKeys(String(a.text ?? ''));
      if (a.ref) await focus(id, a.ref);
      await tryCdp(
        () => cdpKeys(id, keys),
        () => cs(id, { op: 'key', text: String(a.text) }),
      );
      break;
    }
    case 'fill':
      note = ' ' + (await cs(id, { op: 'fill', fields: a.fields }));
      break;
    case 'scroll':
      note = ' ' + (await cs(id, { op: 'scroll', ref: a.ref, at: a.x != null ? await point(id, a) : null, dx: a.dx, dy: a.dy }));
      break;
    case 'drag': {
      if (!a.to) throw new Error('drag needs to (ref or "x,y")');
      const from = await point(id, a);
      const [tx, ty] = String(a.to).split(',').map(Number);
      const to = await point(id, Number.isFinite(ty) ? { x: tx, y: ty } : { ref: a.to });
      mark = to;
      const how = await cs(id, { op: 'drag', ref: a.ref, from, to });
      if (how === 'mouse')
        await tryCdp(
          () => cdpDrag(id, from, to),
          () => cs(id, { op: 'mouseDrag', from, to }),
        );
      break;
    }
    case 'upload':
      note = ' ' + (await cs(id, { op: 'upload', ref: a.ref, files: a.files }));
      break;
    case 'wait':
      if (a.text) note = ' ' + (await cs(id, { op: 'wait', text: String(a.text), ms: a.ms }));
      else await sleep(Math.min(Number(a.ms) || 1000, 15_000));
      break;
    default:
      throw new Error(`Unknown a="${a.a}"`);
  }

  await sleep(250);
  await waitLoad(id, 8000);
  await frame(tab, mark);
  const t = await api.tabs.get(id);
  let text = 'ok' + note.trimEnd();
  if (t.url !== tab.url) text += `\n→ ${t.title} | ${t.url}`;
  if (a.read) {
    await ensureAllowed(t.url, 'read');
    text += '\n' + (await cs(id, { op: 'read' }));
  }
  return { text };
}

/** Inputs take programmatic focus; rich editors need a real click to place the caret. */
async function focus(tabId: number, ref: string) {
  const r = await cs<{ click?: Pt }>(tabId, { op: 'focus', ref });
  if (r?.click) {
    const p = r.click;
    await tryCdp(
      () => cdpMouse(tabId, 'click', p),
      () => cs(tabId, { op: 'mouse', kind: 'click', ref, x: p.x, y: p.y }),
    );
  }
}

async function shotTool(a: Args, sid: string): Promise<ToolResult> {
  const tab = await target(a, sid, 'shot');
  const id = tab.id;
  if (!tab.active) {
    await api.tabs.update(id, { active: true });
    await sleep(250);
  }
  const vp = await cs<{ w: number; h: number; sx: number; sy: number; sw: number; sh: number; rect?: Rect }>(id, {
    op: 'viewport',
    ref: a.ref,
  });

  let bmp: ImageBitmap;
  // Origin of the bitmap in document CSS px, and its width in CSS px.
  let base: { x: number; y: number; w: number };
  if (a.full) {
    const W = vp.sw;
    const H = Math.min(vp.sh, 12_000);
    let url: string;
    if (isFirefox) {
      url = await (api.tabs as any).captureTab(id, { format: 'jpeg', quality: 80, rect: { x: 0, y: 0, width: W, height: H }, scale: 1 });
    } else if (cdpEnabled()) {
      const r = await cdp<{ data: string }>(id, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 80,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: W, height: H, scale: 1 },
      });
      url = 'data:image/jpeg;base64,' + r.data;
    } else throw new Error('Full-page shots need the debugger option enabled in the panel.');
    bmp = await bitmapOf(url);
    base = { x: 0, y: 0, w: W };
  } else {
    bmp = await bitmapOf(await captureVisible(tab.windowId));
    base = { x: vp.sx, y: vp.sy, w: vp.w };
  }
  await cs(id, { op: 'glow' }).catch(() => {});

  const k = bmp.width / base.w; // bitmap px per CSS px
  // Crop in CSS px relative to the bitmap origin.
  let crop: Rect = { x: 0, y: 0, w: bmp.width / k, h: bmp.height / k };
  if (vp.rect) {
    const pad = 8;
    const r = vp.rect;
    const ox = a.full ? vp.sx : 0;
    const oy = a.full ? vp.sy : 0;
    crop = { x: r.x + ox - pad, y: r.y + oy - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
  } else if (Array.isArray(a.region) && a.region.length === 4) {
    const [rx, ry, rw, rh] = a.region.map(Number);
    const m = shotMap.get(id) ?? { ox: base.x, oy: base.y, k: 1 };
    crop = { x: m.ox + rx * m.k - base.x, y: m.oy + ry * m.k - base.y, w: rw * m.k, h: rh * m.k };
  }
  crop.x = Math.max(0, crop.x);
  crop.y = Math.max(0, crop.y);
  crop.w = Math.min(crop.w, bmp.width / k - crop.x);
  crop.h = Math.min(crop.h, bmp.height / k - crop.y);
  if (crop.w < 1 || crop.h < 1) throw new Error('Region is outside the captured area');

  const maxW = Math.min(Number(a.w) || 1024, 2000);
  let outW = Math.max(1, Math.round(Math.min(maxW, crop.w * k)));
  let outH = Math.max(1, Math.round((outW * crop.h) / crop.w));
  const MAX_PX = 1.6e6; // keeps image tokens bounded on tall pages
  if (outW * outH > MAX_PX) {
    const f = Math.sqrt(MAX_PX / (outW * outH));
    outW = Math.round(outW * f);
    outH = Math.round(outH * f);
  }
  const data = await encodeJpeg(bmp, { x: crop.x * k, y: crop.y * k, w: crop.w * k, h: crop.h * k }, outW, outH);
  shotMap.set(id, { ox: base.x + crop.x, oy: base.y + crop.y, k: crop.w / outW });
  return { image: { data, mime: 'image/jpeg' }, text: `${outW}x${outH}` };
}

async function jsTool(a: Args, sid: string): Promise<ToolResult> {
  const tab = await target(a, sid, 'js');
  const code = String(a.code ?? '');
  if (!code) throw new Error('js needs code');
  const fmt = (v: unknown) => {
    const s = typeof v === 'string' ? v : v === undefined ? 'undefined' : JSON.stringify(v) ?? String(v);
    return s.length > 4000 ? s.slice(0, 4000) + `…(${s.length} chars)` : s;
  };

  // Runtime.evaluate is immune to page CSP and supports top-level await.
  if (cdpEnabled()) {
    let r: any;
    try {
      r = await cdp(tab.id, 'Runtime.evaluate', {
        expression: code,
        awaitPromise: true,
        returnByValue: true,
        replMode: true,
        userGesture: true,
        timeout: 15_000,
      });
    } catch {
      r = null;
    }
    if (r) {
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text);
      return { text: fmt(r.result?.value ?? r.result?.description ?? r.result?.type) };
    }
  }

  const [res] = await api.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    args: [code],
    func: async (src: string) => {
      const ser = (v: unknown) => {
        if (v instanceof Element) return `<${v.tagName.toLowerCase()}>`;
        try {
          return JSON.parse(JSON.stringify(v) ?? 'null') ?? (v === undefined ? undefined : String(v));
        } catch {
          return String(v);
        }
      };
      try {
        let v: unknown;
        try {
          v = (0, eval)(src);
        } catch (e) {
          if (!(e instanceof SyntaxError) || !/await/.test(src)) throw e;
          v = (0, eval)(`(async()=>{${src}\n})()`);
        }
        return { ok: true, v: ser(await v) };
      } catch (e) {
        const m = String(e);
        return { ok: false, v: /EvalError|unsafe-eval|Content Security/i.test(m) ? 'Page CSP blocks eval: ' + m : m };
      }
    },
  } as any);
  const out = res?.result as { ok: boolean; v: unknown } | undefined;
  if (!out) throw new Error('Script did not run');
  if (!out.ok) throw new Error(String(out.v));
  return { text: fmt(out.v) };
}

async function logsTool(a: Args, sid: string): Promise<ToolResult> {
  const tab = await target(a, sid, 'logs');
  const n = Math.min(Number(a.n) || 30, 300);
  const kind = a.kind ?? 'console';
  if (kind === 'network') return { text: netLines(tab.id, { q: a.q, n, all: a.all, clear: a.clear }) || 'none' };
  const lines: string = await cs(tab.id, { op: 'logs', kind, q: a.q, n, clear: a.clear });
  if (kind !== 'errors') return { text: lines || 'none' };
  const failed = netLines(tab.id, { q: a.q, n, failed: true });
  return { text: [lines, failed && 'failed requests:\n' + failed].filter(Boolean).join('\n') || 'none' };
}

async function gifTool(a: Args, sid: string): Promise<ToolResult> {
  const tab = await target(a, sid, 'gif');
  switch (a.a) {
    case 'start':
      gifStart(tab.id);
      await frame(tab);
      return { text: 'recording' };
    case 'stop':
      return { text: `stopped, ${gifStop(tab.id)} frames` };
    case 'save': {
      const { bytes, n } = gifSave(tab.id);
      return { file: { data: b64(bytes), ext: 'gif' }, text: `${n} frames` };
    }
  }
  throw new Error('a must be start|stop|save');
}
