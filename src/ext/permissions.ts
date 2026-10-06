import { api, isHeadless } from './env';
import { sessionAllowed, saveSettings, settings } from './state';

type Decision = 'once' | 'always' | 'deny';

const approvals = new Map<string, { done: (d: Decision) => void; win?: number }>();
const inflight = new Map<string, Promise<Decision>>();

const matches = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith('.' + d));

export async function ensureAllowed(url: string | undefined, tool: string) {
  if (!url || url === 'about:blank') return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol === 'data:') return;
  if (!['http:', 'https:', 'file:'].includes(u.protocol))
    throw new Error(`Browser page ${u.protocol}//${u.host} cannot be controlled; navigate to a website first.`);
  const host = u.hostname || 'file';
  if (matches(host, settings.blocked)) throw new Error(`${host} is blocked by the user.`);
  // A headless browser has no window to show the approval prompt in, so it can only run in allow mode.
  if (isHeadless || settings.mode === 'allow' || matches(host, settings.allowed) || sessionAllowed.has(host)) return;

  const d = await ask(host, tool);
  if (d === 'deny') throw new Error(`User denied access to ${host}.`);
  if (d === 'always') await saveSettings({ allowed: [...settings.allowed, host] });
  else sessionAllowed.add(host);
}

function ask(host: string, tool: string): Promise<Decision> {
  let p = inflight.get(host);
  if (p) return p;
  p = new Promise<Decision>((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const entry: { done: (d: Decision) => void; win?: number } = {
      done: (d) => {
        clearTimeout(timer);
        approvals.delete(id);
        inflight.delete(host);
        if (entry.win != null) api.windows.remove(entry.win).catch(() => {});
        resolve(d);
      },
    };
    const timer = setTimeout(() => entry.done('deny'), 120_000);
    approvals.set(id, entry);
    const q = new URLSearchParams({ id, host, tool });
    api.windows
      .create({ url: api.runtime.getURL(`approve.html?${q}`), type: 'popup', width: 440, height: 300, focused: true })
      .then((w) => (entry.win = w?.id))
      .catch(() => entry.done('deny'));
  });
  inflight.set(host, p);
  return p;
}

export function resolveApproval(id: string, d: Decision) {
  approvals.get(id)?.done(d);
}

api.windows.onRemoved.addListener((wid) => {
  for (const a of approvals.values()) if (a.win === wid) a.done('deny');
});
