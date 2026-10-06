import { parseKeys, type KeySpec } from '../shared/keys';
import { api, clip, sleep } from './env';

type Pt = { x: number; y: number };
type Entry = { depth: number; line: string; hay: string; ref?: string; text?: boolean };

declare global {
  interface Window {
    __bbCs?: boolean;
  }
}

if (!window.__bbCs) {
  window.__bbCs = true;
  init();
}

function init() {
  // ---------- console / error buffer fed by hook.js (main world)
  const logs: { kind: string; level: string; text: string; n: number }[] = [];
  window.addEventListener('__bb_log', (e) => {
    try {
      const d = JSON.parse((e as CustomEvent).detail);
      const last = logs.at(-1);
      if (last && last.text === d.text && last.level === d.level) last.n++;
      else {
        logs.push({ ...d, n: 1 });
        if (logs.length > 500) logs.shift();
      }
    } catch {
      /* ignore */
    }
  });

  api.runtime.onMessage.addListener((m: any, _s, reply) => {
    Promise.resolve()
      .then(() => handle(m))
      .then(
        (value) => reply({ value }),
        (e) => reply({ error: String(e?.message ?? e) }),
      );
    return true;
  });

  // Re-arm agent mode after the agent's tab navigates.
  api.runtime
    .sendMessage({ t: 'isAgent' })
    .then((on: boolean) => on && markAgent())
    .catch(() => {});

  async function handle(m: any): Promise<unknown> {
    if (m.op !== 'viewport' && m.op !== 'logs') markAgent();
    switch (m.op) {
      case 'read':
        return read(m);
      case 'locate':
        return locate(m.ref);
      case 'ensurePoint':
        return ensurePoint(m);
      case 'focus':
        return focusRef(m.ref);
      case 'mouse':
        return mouse(m.kind, m.ref, m.x, m.y);
      case 'type':
        return typeText(m.text);
      case 'key':
        return pressKeys(parseKeys(m.text));
      case 'fill':
        return fill(m.fields);
      case 'scroll':
        return scroll(m);
      case 'drag':
        return drag(m.ref, m.from, m.to);
      case 'mouseDrag':
        return mouseDrag(m.from, m.to);
      case 'upload':
        return upload(m.ref, m.files);
      case 'wait':
        return waitFor(m.text, m.ms);
      case 'viewport':
        return viewport(m.ref);
      case 'glow':
        return glow(true);
      case 'logs':
        return readLogs(m);
    }
    throw new Error(`unknown op ${m.op}`);
  }

  function readLogs(m: { kind: string; q?: string; n: number; clear?: boolean }) {
    let list = m.kind === 'errors' ? logs.filter((l) => l.kind === 'error' || l.level === 'error') : logs;
    if (m.q) list = list.filter((l) => l.text.includes(m.q!));
    const out = list.slice(-m.n).map((l) => `[${l.level}] ${l.text}${l.n > 1 ? ` (x${l.n})` : ''}`);
    if (m.clear) logs.length = 0;
    return out.join('\n');
  }
}

// ---------- agent mode: glow border + dialog auto-accept (see hook.ts)

let glowHost: HTMLElement | null = null;
let glowTimer: ReturnType<typeof setTimeout> | undefined;

function markAgent() {
  document.documentElement?.setAttribute('data-bb-agent', '');
  glow(true);
}

function glow(on: boolean) {
  const root = document.documentElement;
  if (!root) return;
  if (!glowHost) {
    glowHost = document.createElement('bb-glow');
    const sr = glowHost.attachShadow({ mode: 'closed' });
    sr.innerHTML =
      '<div style="position:fixed;inset:0;pointer-events:none;z-index:2147483647;' +
      'box-shadow:inset 0 0 0 3px rgba(255,110,40,.9),inset 0 0 28px rgba(255,110,40,.45)"></div>';
  }
  if (!glowHost.isConnected) root.appendChild(glowHost);
  glowHost.style.display = on ? '' : 'none';
  clearTimeout(glowTimer);
  if (on) glowTimer = setTimeout(() => glowHost && (glowHost.style.display = 'none'), 6000);
}

// ---------- refs: stable per element for the page's lifetime, no DOM attributes added

let seq = 0;
const refOfEl = new WeakMap<Element, string>();
const elOfRef = new Map<string, WeakRef<Element>>();

function refOf(el: Element) {
  let r = refOfEl.get(el);
  if (!r) {
    r = 'e' + ++seq;
    refOfEl.set(el, r);
    elOfRef.set(r, new WeakRef(el));
  }
  return r;
}

function byRef(ref: string): Element {
  const el = elOfRef.get(String(ref))?.deref();
  if (!el || !el.isConnected) throw new Error(`ref ${ref} not found; page changed, read again`);
  return el;
}

// ---------- reading

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'bb-glow', 'br', 'wbr']);
const NO_DESCEND = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'img', 'svg', 'video', 'audio', 'canvas', 'option']);
const IN_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'switch', 'textbox', 'combobox', 'searchbox', 'slider', 'spinbutton', 'treeitem',
]);
const LANDMARKS = new Set(['nav', 'main', 'form', 'table', 'header', 'footer', 'aside', 'navigation', 'search']);
const MAX_ENTRIES = 6000;

function read(o: { mode?: string; q?: string; ref?: string; max?: number; offset?: number }) {
  const max = Math.min(Number(o.max) || 4000, 50_000);
  const off = Number(o.offset) || 0;
  let out: string;
  if (o.mode === 'text') {
    const root = (o.ref ? byRef(o.ref) : document.querySelector('main,[role=main],article') ?? document.body) as HTMLElement;
    out = (root?.innerText ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
  } else if (o.mode === 'find') {
    out = find(String(o.q ?? ''));
  } else {
    const ents = collect(o.ref ? byRef(o.ref) : document.body, o.mode === 'all');
    out = ents.map((e) => '  '.repeat(e.depth) + e.line).join('\n');
  }
  if (off === 0 && o.mode !== 'find') {
    const sh = document.documentElement.scrollHeight;
    const scroll = sh > innerHeight + 10 ? ` [scroll ${Math.round(scrollY)}/${sh - innerHeight}]` : '';
    out = `${clip(document.title, 80)} | ${clip(location.href, 100)}${scroll}\n` + out;
  }
  return paginate(out, off, max);
}

function paginate(s: string, off: number, max: number) {
  let chunk = s.slice(off, off + max);
  if (off + max < s.length) {
    const nl = chunk.lastIndexOf('\n');
    if (nl > max * 0.5) chunk = chunk.slice(0, nl);
    const next = off + chunk.length;
    return `${chunk}\n…${s.length - next} more chars (offset=${next})`;
  }
  return chunk || '(empty)';
}

function collect(root: Element | null, all: boolean): Entry[] {
  const out: Entry[] = [];
  if (!root) return out;
  const visit = (el: Element, depth: number, parentPointer: boolean, inText: boolean) => {
    if (out.length >= MAX_ENTRIES) return;
    const tag = el.localName;
    if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true') return;
    const st = getComputedStyle(el);
    if (st.display === 'none') return;
    const pointer = st.cursor === 'pointer';
    let e: Entry | null = null;
    if (st.visibility !== 'hidden' && st.visibility !== 'collapse' && st.display !== 'contents')
      e = describe(el, tag, all, pointer && !parentPointer, inText, depth);
    if (e) out.push(e);
    if (NO_DESCEND.has(tag)) return;
    if (tag === 'iframe') {
      try {
        const b = (el as HTMLIFrameElement).contentDocument?.body;
        if (b) visit(b, depth + 1, false, false);
      } catch {
        /* cross-origin */
      }
      return;
    }
    const d = e && all ? depth + 1 : depth;
    const kids = el.shadowRoot ? [...el.shadowRoot.children, ...el.children] : el.children;
    for (const c of kids) visit(c, d, pointer, inText || !!e?.text);
  };
  visit(root, 0, false, false);
  return out;
}

function describe(el: Element, tag: string, all: boolean, newPointer: boolean, inText: boolean, depth: number): Entry | null {
  const role = roleOf(el, tag);
  if (isInteractive(el, tag, role, newPointer)) {
    let target = el;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      // Visually hidden checkbox/radio: point at its label instead.
      const label = (el as HTMLInputElement).labels?.[0];
      if (!label || !label.getBoundingClientRect().width) return null;
      target = label;
    }
    const name = nameOf(el, tag) || (target !== el ? clip((target as HTMLElement).innerText, 80) : '');
    return {
      depth,
      line: `${refOf(target)} ${role}${name ? ` "${q(name)}"` : ''}${extras(el, tag, role)}`,
      hay: `${role} ${name} ${el.getAttribute('placeholder') ?? ''}`.toLowerCase(),
      ref: refOf(target),
    };
  }
  if (/^h[1-6]$/.test(tag)) {
    const lv = Number(tag[1]);
    if (!all && lv > 3) return null;
    const t = clip((el as HTMLElement).innerText, 100);
    return t ? { depth, line: `${'#'.repeat(lv)} ${t}`, hay: t.toLowerCase(), text: true } : null;
  }
  if (role === 'dialog' || role === 'alertdialog' || (tag === 'dialog' && (el as HTMLDialogElement).open)) {
    const n = nameOf(el, tag, false);
    return { depth, line: `dialog${n ? ` "${q(n)}"` : ''}`, hay: 'dialog ' + n.toLowerCase() };
  }
  if (role === 'alert' || role === 'status') {
    const t = clip((el as HTMLElement).innerText, 150);
    return t ? { depth, line: `${role} "${q(t)}"`, hay: t.toLowerCase(), text: true } : null;
  }
  if (!all) return null;
  if (tag === 'img') {
    const alt = clip(el.getAttribute('alt'), 80);
    return alt ? { depth, line: `img "${q(alt)}"`, hay: alt.toLowerCase() } : null;
  }
  if (LANDMARKS.has(role)) {
    const n = el.getAttribute('aria-label') ?? '';
    return { depth, line: role + (n ? ` "${q(clip(n, 60))}"` : ''), hay: role };
  }
  if (!inText && hasOwnText(el)) {
    const t = clip((el as HTMLElement).innerText ?? el.textContent, 200);
    return t ? { depth, line: t, hay: t.toLowerCase(), text: true } : null;
  }
  return null;
}

const q = (s: string) => s.replace(/"/g, "'");

function hasOwnText(el: Element) {
  for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent!.trim()) return true;
  return false;
}

function roleOf(el: Element, tag: string): string {
  const r = el.getAttribute('role');
  if (r) return r.split(/\s/)[0];
  switch (tag) {
    case 'a':
      return 'link';
    case 'button':
    case 'summary':
      return 'button';
    case 'select':
    case 'textarea':
    case 'img':
    case 'dialog':
    case 'nav':
    case 'main':
    case 'form':
    case 'table':
    case 'header':
    case 'footer':
    case 'aside':
      return tag;
    case 'input': {
      const t = (el as HTMLInputElement).type;
      if (t === 'checkbox' || t === 'radio' || t === 'file') return t;
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      return t === 'range' ? 'slider' : 'input';
    }
  }
  return (el as HTMLElement).isContentEditable ? 'textbox' : tag;
}

function isInteractive(el: Element, tag: string, role: string, newPointer: boolean) {
  switch (tag) {
    case 'a':
      return el.hasAttribute('href') || IN_ROLES.has(role);
    case 'button':
    case 'select':
    case 'textarea':
    case 'summary':
      return true;
    case 'input':
      return (el as HTMLInputElement).type !== 'hidden';
    case 'body':
    case 'html':
    case 'label':
      return false;
  }
  if (IN_ROLES.has(role)) return true;
  const h = el as HTMLElement;
  if (h.isContentEditable && !(h.parentElement as HTMLElement | null)?.isContentEditable) return true;
  if (el.hasAttribute('onclick')) return true;
  const ti = el.getAttribute('tabindex');
  if (ti !== null && Number(ti) >= 0) return true;
  return newPointer; // cursor:pointer that doesn't just inherit from a clickable parent
}

function nameOf(el: Element, tag: string, useText = true): string {
  const lb = el.getAttribute('aria-labelledby');
  if (lb) {
    const t = lb
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (t.trim()) return clip(t, 80);
  }
  const al = el.getAttribute('aria-label');
  if (al?.trim()) return clip(al, 80);
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const i = el as HTMLInputElement;
    const btn = ['button', 'submit', 'reset'].includes(i.type) ? i.value : '';
    return clip(
      i.labels?.[0]?.innerText || i.getAttribute('placeholder') || i.getAttribute('title') || btn || i.getAttribute('name'),
      80,
    );
  }
  const h = el as HTMLElement;
  if (h.isContentEditable) return clip(el.getAttribute('placeholder') ?? el.getAttribute('data-placeholder'), 80);
  if (tag === 'img') return clip(el.getAttribute('alt'), 80);
  if (useText) {
    const t = clip(h.innerText ?? el.textContent, 80);
    if (t) return t;
  }
  return clip(
    el.getAttribute('title') ??
      el.querySelector('img[alt]')?.getAttribute('alt') ??
      el.querySelector('svg title')?.textContent ??
      '',
    80,
  );
}

function extras(el: Element, tag: string, role: string): string {
  let s = '';
  if (tag === 'input') {
    const i = el as HTMLInputElement;
    const t = i.type;
    if (role === 'input' && t !== 'text') s += ` [${t}]`;
    if (t === 'checkbox' || t === 'radio') {
      if (i.checked) s += ' checked';
    } else if (t === 'file') {
      if (i.files?.length) s += ` =${i.files.length} file(s)`;
    } else if (i.value && role !== 'button') s += ` ="${t === 'password' ? '***' : q(clip(i.value, 40))}"`;
  } else if (tag === 'textarea') {
    const v = (el as HTMLTextAreaElement).value;
    if (v) s += ` ="${q(clip(v, 60))}"`;
  } else if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    const o = sel.selectedOptions[0];
    if (o) s += ` ="${q(clip(o.text, 30))}"`;
    const n = sel.options.length;
    s += n <= 8 ? ` {${[...sel.options].map((x) => q(clip(x.text, 20))).join('|')}}` : ` {${n} options}`;
  } else if ((el as HTMLElement).isContentEditable) {
    const t = clip((el as HTMLElement).innerText, 60);
    if (t) s += ` ="${q(t)}"`;
  }
  if (el.getAttribute('aria-checked') === 'true') s += ' checked';
  const cur = el.getAttribute('aria-current');
  if (el.getAttribute('aria-selected') === 'true' || (cur && cur !== 'false')) s += ' current';
  const ex = el.getAttribute('aria-expanded');
  if (ex) s += ex === 'true' ? ' expanded' : ' collapsed';
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') s += ' disabled';
  if (tag === 'a') {
    const h = shortHref(el.getAttribute('href'));
    if (h) s += ` →${h}`;
  }
  return s;
}

function shortHref(h: string | null) {
  if (!h || h.startsWith('#') || /^javascript:/i.test(h)) return '';
  try {
    const u = new URL(h, location.href);
    return clip(u.origin === location.origin ? u.pathname + u.search : u.host + u.pathname, 50);
  } catch {
    return '';
  }
}

function find(query: string) {
  if (!query) throw new Error('find needs q');
  if (query.startsWith('css:')) {
    const els = [...document.querySelectorAll(query.slice(4))].slice(0, 30);
    return (
      els
        .map((el) => {
          const tag = el.localName;
          const role = roleOf(el, tag);
          const n = nameOf(el, tag);
          return `${refOf(el)} ${role}${n ? ` "${q(n)}"` : ''}${extras(el, tag, role)}`;
        })
        .join('\n') || 'no match'
    );
  }
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (
    collect(document.body, true)
      .map((e) => ({ e, s: words.filter((w) => e.hay.includes(w)).length / words.length + (e.ref ? 0.01 : 0) }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .map((x) => x.e.line)
      .join('\n') || `no match for "${query}"`
  );
}

// ---------- geometry

/** Element rect in top-window viewport px, accounting for same-origin iframes. */
function rectTop(el: Element) {
  const r = el.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  let w: Window | null = el.ownerDocument.defaultView;
  while (w && w !== window && w.frameElement) {
    const f = w.frameElement as HTMLElement;
    const fr = f.getBoundingClientRect();
    x += fr.left + f.clientLeft;
    y += fr.top + f.clientTop;
    w = w.parent;
  }
  return { x, y, w: r.width, h: r.height };
}

function deepAt(x: number, y: number): Element | null {
  let e = document.elementFromPoint(x, y);
  while (e?.shadowRoot) {
    const inner = e.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === e) break;
    e = inner;
  }
  return e;
}

function within(node: Node | null, anc: Node) {
  for (let n: any = node; n; n = n.parentNode ?? n.host) if (n === anc) return true;
  return false;
}

function brief(el: Element) {
  const id = el.id ? '#' + el.id : '';
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : '';
  const t = clip((el as HTMLElement).innerText, 30);
  return `${el.localName}${id}${cls}${t ? ` "${q(t)}"` : ''}`;
}

function locate(ref: string): Pt & { cover?: string } {
  const el = byRef(ref);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = rectTop(el);
  if (!r.w && !r.h) throw new Error(`${ref} is not visible`);
  const x = r.x + r.w / 2;
  const y = r.y + r.h / 2;
  const top = deepAt(x, y);
  const inFrame = el.ownerDocument !== document;
  if (top && !inFrame && !within(top, el) && !within(el, top)) return { x, y, cover: brief(top) };
  return { x, y };
}

/** Convert a screenshot point to viewport px, scrolling it into view if needed. */
function ensurePoint(m: { x: number; y: number; doc: Pt | null }): Pt {
  if (!m.doc) return { x: m.x, y: m.y };
  const { x, y } = m.doc;
  let vx = x - scrollX;
  let vy = y - scrollY;
  if (vx < 0 || vy < 0 || vx >= innerWidth || vy >= innerHeight) {
    scrollTo({ left: x - innerWidth / 2, top: y - innerHeight / 2, behavior: 'instant' as ScrollBehavior });
    vx = x - scrollX;
    vy = y - scrollY;
  }
  return { x: vx, y: vy };
}

function viewport(ref?: string) {
  glow(false);
  const rect = ref ? (locate(ref), rectTop(byRef(ref))) : undefined;
  const de = document.documentElement;
  // Let the glow removal paint before the capture.
  return Promise.race([new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), sleep(80)]).then(() => ({
    w: innerWidth,
    h: innerHeight,
    sx: scrollX,
    sy: scrollY,
    sw: Math.max(de.scrollWidth, document.body?.scrollWidth ?? 0),
    sh: Math.max(de.scrollHeight, document.body?.scrollHeight ?? 0),
    rect,
  }));
}

// ---------- DOM fallbacks (Firefox, or with the debugger disabled)

function activeEl(): HTMLElement | null {
  let a = document.activeElement as HTMLElement | null;
  for (;;) {
    if (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement as HTMLElement;
    else if (a?.localName === 'iframe') {
      try {
        const inner = (a as HTMLIFrameElement).contentDocument?.activeElement as HTMLElement | null;
        if (!inner || inner === a) break;
        a = inner;
      } catch {
        break;
      }
    } else break;
  }
  return a;
}

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el.localName === 'textarea' || (el.localName === 'input' && !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'range', 'color'].includes((el as HTMLInputElement).type));
}

function focusRef(ref: string): { click?: Pt } {
  const el = byRef(ref) as HTMLElement;
  if (isTextField(el)) {
    el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    el.focus();
    try {
      const n = el.value.length;
      el.setSelectionRange(n, n);
    } catch {
      /* email/number inputs reject selection */
    }
    return {};
  }
  return { click: locate(ref) };
}

function fire(el: Element, type: string, init: MouseEventInit, C: typeof MouseEvent = MouseEvent) {
  return el.dispatchEvent(new C(type, { bubbles: true, cancelable: true, composed: true, view: window, ...init }));
}

function mouse(kind: string, ref: string | undefined, x: number, y: number) {
  const el = ref ? byRef(ref) : deepAt(x, y);
  if (!el) throw new Error('Nothing at that point');
  const right = kind === 'rclick';
  const o: PointerEventInit = { clientX: x, clientY: y, button: right ? 2 : 0, buttons: right ? 2 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  fire(el, 'pointerover', o, PointerEvent);
  fire(el, 'mouseover', o);
  fire(el, 'pointermove', o, PointerEvent);
  fire(el, 'mousemove', o);
  if (kind === 'hover') return 'ok';
  const press = () => {
    fire(el, 'pointerdown', o, PointerEvent);
    fire(el, 'mousedown', o);
    (el as HTMLElement).focus?.({ preventScroll: true });
    fire(el, 'pointerup', { ...o, buttons: 0 }, PointerEvent);
    fire(el, 'mouseup', { ...o, buttons: 0 });
    if (!right) fire(el, 'click', { ...o, buttons: 0, detail: 1 });
  };
  press();
  if (kind === 'dblclick') {
    press();
    fire(el, 'dblclick', { ...o, detail: 2 });
  }
  if (right) fire(el, 'contextmenu', o);
  return 'ok';
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string) {
  const view = el.ownerDocument.defaultView as any;
  const proto =
    el.localName === 'textarea'
      ? view.HTMLTextAreaElement.prototype
      : el.localName === 'select'
        ? view.HTMLSelectElement.prototype
        : view.HTMLInputElement.prototype;
  // The prototype setter bypasses framework value trackers so React & co see the change.
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function typeText(text: string) {
  const el = activeEl();
  if (!el || el === document.body) throw new Error('No focused field; pass ref');
  if (!el.ownerDocument.execCommand('insertText', false, text)) {
    if (isTextField(el)) setValue(el, el.value + text);
    else throw new Error('Focused element does not accept text');
  }
  return 'ok';
}

function pressKeys(keys: KeySpec[]) {
  for (const k of keys) {
    const el = activeEl() ?? document.body;
    const init: KeyboardEventInit & { keyCode: number; which: number } = {
      key: k.key,
      code: k.code,
      keyCode: k.vk,
      which: k.vk,
      altKey: !!(k.mods & 1),
      ctrlKey: !!(k.mods & 2),
      metaKey: !!(k.mods & 4),
      shiftKey: !!(k.mods & 8),
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    if (el.dispatchEvent(new KeyboardEvent('keydown', init))) defaultKey(el, k, init);
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }
  return 'ok';
}

/** Synthetic key events have no default action, so emulate the common ones. */
function defaultKey(el: HTMLElement, k: KeySpec, init: KeyboardEventInit) {
  const doc = el.ownerDocument;
  const cmd = (k.mods & 6) !== 0;
  if (k.text && k.key !== 'Enter') {
    if (el.dispatchEvent(new KeyboardEvent('keypress', init))) doc.execCommand('insertText', false, k.text);
    return;
  }
  switch (k.key) {
    case 'Enter':
      if (el.localName === 'textarea' || el.isContentEditable) doc.execCommand('insertText', false, '\n');
      else if ((el as HTMLInputElement).form) (el as HTMLInputElement).form!.requestSubmit();
      else if (el.localName === 'a' || el.localName === 'button') el.click();
      break;
    case 'Tab':
      moveFocus(k.mods & 8 ? -1 : 1);
      break;
    case 'Backspace':
      doc.execCommand('delete');
      break;
    case 'Delete':
      doc.execCommand('forwardDelete');
      break;
    case 'a':
    case 'A':
      if (cmd) isTextField(el) ? el.select() : doc.execCommand('selectAll');
      break;
  }
}

function moveFocus(dir: number) {
  const all = [...document.querySelectorAll<HTMLElement>(
    'a[href],button,input:not([type=hidden]),select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable=""],[contenteditable=true]',
  )].filter((e) => !(e as HTMLButtonElement).disabled && e.getClientRects().length);
  const i = all.indexOf(activeEl() as HTMLElement);
  all[(i + dir + all.length) % all.length]?.focus();
}

function fill(fields: Record<string, unknown>) {
  if (!fields || typeof fields !== 'object') throw new Error('fill needs fields: {ref: value}');
  const bad: string[] = [];
  let n = 0;
  for (const [ref, val] of Object.entries(fields)) {
    try {
      let el = byRef(ref) as HTMLElement;
      if (el.localName === 'label' && (el as HTMLLabelElement).control) el = (el as HTMLLabelElement).control!;
      if (el.localName === 'select') {
        const sel = el as HTMLSelectElement;
        const wants = (Array.isArray(val) ? val : [val]).map((v) => String(v).toLowerCase().trim());
        const opts = [...sel.options];
        const pick = (w: string) =>
          opts.find((o) => o.value.toLowerCase() === w) ??
          opts.find((o) => o.text.toLowerCase().trim() === w) ??
          opts.find((o) => o.text.toLowerCase().includes(w));
        const chosen = wants.map(pick);
        if (chosen.some((o) => !o)) throw new Error(`no option "${wants.join(',')}"`);
        if (sel.multiple) opts.forEach((o) => (o.selected = chosen.includes(o)));
        else setValue(sel, chosen[0]!.value);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      } else if ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio') {
        const want = val === true || ['true', 'on', '1', 'yes'].includes(String(val).toLowerCase());
        if ((el as HTMLInputElement).checked !== want) el.click();
      } else if (isTextField(el)) {
        el.focus();
        setValue(el, String(val));
      } else if (el.isContentEditable) {
        el.focus();
        el.ownerDocument.execCommand('selectAll');
        el.ownerDocument.execCommand('insertText', false, String(val));
      } else throw new Error(`not a form field (${el.localName})`);
      n++;
    } catch (e) {
      bad.push(`${ref}: ${(e as Error).message}`);
    }
  }
  return `filled ${n}` + (bad.length ? `; failed ${bad.join('; ')}` : '');
}

function scrollable(el: Element | null): Element | null {
  for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (/(auto|scroll|overlay)/.test(s.overflowY + s.overflowX) && (e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2))
      return e;
  }
  return null;
}

function scroll(m: { ref?: string; at?: Pt | null; dx?: number; dy?: number }) {
  if (m.ref) {
    byRef(m.ref).scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    return 'ok';
  }
  const dx = Number(m.dx) || 0;
  const dy = m.dy != null ? Number(m.dy) : dx ? 0 : Math.round(innerHeight * 0.8);
  const de = document.documentElement;
  const pageScrolls = de.scrollHeight > innerHeight + 2 || de.scrollWidth > innerWidth + 2;
  const at = m.at ?? { x: innerWidth / 2, y: innerHeight / 2 };
  // App shells often scroll an inner container instead of the window.
  const box = m.at || !pageScrolls ? scrollable(deepAt(at.x, at.y)) : null;
  if (box) {
    box.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
    return `box y=${Math.round(box.scrollTop)}/${box.scrollHeight - box.clientHeight}`;
  }
  scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
  return `y=${Math.round(scrollY)}/${de.scrollHeight - innerHeight}`;
}

function drag(ref: string | undefined, from: Pt, to: Pt) {
  const src = ref ? byRef(ref) : deepAt(from.x, from.y);
  const dst = deepAt(to.x, to.y);
  if (!src || !dst) throw new Error('Nothing to drag at that point');
  const draggable = (src as HTMLElement).closest?.('[draggable="true"]');
  if (!draggable) return 'mouse';
  const dt = new DataTransfer();
  const ev = (type: string, p: Pt) =>
    new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: p.x, clientY: p.y });
  draggable.dispatchEvent(ev('dragstart', from));
  dst.dispatchEvent(ev('dragenter', to));
  dst.dispatchEvent(ev('dragover', to));
  dst.dispatchEvent(ev('drop', to));
  draggable.dispatchEvent(ev('dragend', to));
  return 'html5';
}

async function mouseDrag(from: Pt, to: Pt) {
  const src = deepAt(from.x, from.y);
  if (!src) throw new Error('Nothing at drag start');
  const o = { button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true };
  fire(src, 'pointerdown', { ...o, clientX: from.x, clientY: from.y }, PointerEvent);
  fire(src, 'mousedown', { ...o, clientX: from.x, clientY: from.y });
  for (let i = 1; i <= 10; i++) {
    const p = { clientX: from.x + ((to.x - from.x) * i) / 10, clientY: from.y + ((to.y - from.y) * i) / 10 };
    const el = deepAt(p.clientX, p.clientY) ?? src;
    fire(el, 'pointermove', { ...o, ...p }, PointerEvent);
    fire(el, 'mousemove', { ...o, ...p });
    await sleep(16);
  }
  const dst = deepAt(to.x, to.y) ?? src;
  fire(dst, 'pointerup', { ...o, buttons: 0, clientX: to.x, clientY: to.y }, PointerEvent);
  fire(dst, 'mouseup', { ...o, buttons: 0, clientX: to.x, clientY: to.y });
  return 'ok';
}

function upload(ref: string, files: { name: string; mime: string; data: string }[]) {
  if (!ref) throw new Error('upload needs ref');
  const el = byRef(ref) as HTMLElement;
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.mime }));
  }
  const input = (
    el.localName === 'input' && (el as HTMLInputElement).type === 'file'
      ? el
      : el.localName === 'label'
        ? (el as HTMLLabelElement).control
        : el.querySelector('input[type=file]')
  ) as HTMLInputElement | null;
  if (input) {
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return `uploaded ${files.length}`;
  }
  // No file input: treat the element as a drop zone.
  for (const type of ['dragenter', 'dragover', 'drop'])
    el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
  return `dropped ${files.length}`;
}

async function waitFor(text: string, ms?: number) {
  const end = Date.now() + Math.min(Number(ms) || 10_000, 30_000);
  const css = text.startsWith('css:') ? text.slice(4) : null;
  const needle = text.toLowerCase();
  while (Date.now() < end) {
    if (css ? document.querySelector(css) : document.body?.innerText.toLowerCase().includes(needle)) return 'found';
    await sleep(200);
  }
  throw new Error(`Timed out waiting for "${text}"`);
}
