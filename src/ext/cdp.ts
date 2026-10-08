import type { KeySpec } from '../shared/keys';
import { hasCdp, sleep } from './env';
import { settings } from './state';

const attached = new Set<number>();

if (hasCdp) {
  chrome.debugger.onDetach.addListener((src) => {
    if (src.tabId != null) attached.delete(src.tabId);
  });
}

export const cdpEnabled = () => hasCdp && settings.debugger;

export async function cdp<T = any>(tabId: number, method: string, params?: object): Promise<T> {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
  }
  return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
}

export async function detachAll() {
  for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.clear();
}

type Pt = { x: number; y: number };

export async function cdpMouse(tabId: number, kind: string, p: Pt) {
  const send = (type: string, extra: object = {}) =>
    cdp(tabId, 'Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'none', ...extra });
  await send('mouseMoved');
  if (kind === 'hover') return;
  const button = kind === 'rclick' ? 'right' : 'left';
  const buttons = button === 'left' ? 1 : 2;
  for (let i = 1; i <= (kind === 'dblclick' ? 2 : 1); i++) {
    await send('mousePressed', { button, buttons, clickCount: i });
    await send('mouseReleased', { button, buttons: 0, clickCount: i });
  }
}

export async function cdpWheel(tabId: number, p: Pt, dx: number, dy: number) {
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: dx, deltaY: dy });
}

export async function cdpDrag(tabId: number, a: Pt, b: Pt) {
  const send = (type: string, p: Pt, extra: object = {}) =>
    cdp(tabId, 'Input.dispatchMouseEvent', { type, x: p.x, y: p.y, ...extra });
  await send('mouseMoved', a);
  await send('mousePressed', a, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) {
    await send('mouseMoved', { x: a.x + ((b.x - a.x) * i) / 10, y: a.y + ((b.y - a.y) * i) / 10 }, { button: 'left', buttons: 1 });
    await sleep(16);
  }
  await send('mouseReleased', b, { button: 'left', buttons: 0, clickCount: 1 });
}

const MAC_CMDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };
const isMac = navigator.userAgent.includes('Mac');

export async function cdpKeys(tabId: number, keys: KeySpec[]) {
  for (const k of keys) {
    const base = {
      modifiers: k.mods,
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
    };
    const cmd = isMac && k.mods === 4 ? MAC_CMDS[k.key.toLowerCase()] : undefined;
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      ...base,
      type: k.text ? 'keyDown' : 'rawKeyDown',
      text: k.text || undefined,
      unmodifiedText: k.text || undefined,
      commands: cmd ? [cmd] : undefined,
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }
}
