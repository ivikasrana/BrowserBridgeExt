import { api, clip } from './env';

interface Req {
  id: string;
  m: string;
  url: string;
  type: string;
  t: number;
  status?: number;
  ms?: number;
  err?: string;
}

const MAX = 300;
const byTab = new Map<number, Req[]>();
const STATIC = new Set(['image', 'font', 'stylesheet', 'media', 'imageset', 'object']);
const filter = { urls: ['<all_urls>'] };

function find(tabId: number, id: string) {
  return byTab.get(tabId)?.findLast((r) => r.id === id);
}

api.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;
  let list = byTab.get(d.tabId);
  if (!list) byTab.set(d.tabId, (list = []));
  list.push({ id: d.requestId, m: d.method, url: d.url, type: d.type, t: d.timeStamp });
  if (list.length > MAX) list.shift();
  return undefined;
}, filter);

api.webRequest.onCompleted.addListener((d) => {
  const r = find(d.tabId, d.requestId);
  if (r) {
    r.status = d.statusCode;
    r.ms = Math.round(d.timeStamp - r.t);
  }
}, filter);

api.webRequest.onErrorOccurred.addListener((d) => {
  const r = find(d.tabId, d.requestId);
  if (r) {
    r.err = d.error;
    r.ms = Math.round(d.timeStamp - r.t);
  }
}, filter);

api.tabs.onRemoved.addListener((id) => byTab.delete(id));

export function netLines(tabId: number, o: { q?: string; n: number; all?: boolean; failed?: boolean; clear?: boolean }) {
  let list = byTab.get(tabId) ?? [];
  if (o.failed) list = list.filter((r) => r.err || (r.status ?? 0) >= 400);
  else if (!o.all) list = list.filter((r) => !STATIC.has(r.type));
  if (o.q) list = list.filter((r) => r.url.includes(o.q!));
  const out = list
    .slice(-o.n)
    .map((r) => `${r.err ? 'ERR ' + r.err : r.status ?? '…'} ${r.m} ${r.ms ?? '?'}ms ${r.type} ${clip(r.url, 150)}`);
  if (o.clear) byTab.delete(tabId);
  return out.join('\n');
}
