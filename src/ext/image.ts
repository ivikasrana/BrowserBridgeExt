import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { api, sleep } from './env';

export function b64(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function bitmapOf(dataUrl: string) {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

/** captureVisibleTab is rate-limited (2/s in Chromium): space calls out and retry on the quota error. */
let lastCapture = 0;
let captureQueue: Promise<unknown> = Promise.resolve();

export function captureVisible(windowId: number): Promise<string> {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = lastCapture + 600 - Date.now();
      if (wait > 0) await sleep(wait);
      lastCapture = Date.now();
      try {
        return await api.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
      } catch (e) {
        if (attempt >= 3 || !/MAX_CAPTURE|quota/i.test(String(e))) throw e;
      }
    }
  };
  const p = captureQueue.then(run, run);
  captureQueue = p.catch(() => {});
  return p;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function encodeJpeg(src: ImageBitmap, crop: Rect, outW: number, outH: number, quality = 0.6) {
  const c = new OffscreenCanvas(outW, outH);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return b64(await blob.arrayBuffer());
}

// ---- GIF recording: frames are quantized as they arrive so memory stays small.

interface Rec {
  enc: ReturnType<typeof GIFEncoder>;
  w: number;
  h: number;
  n: number;
  on: boolean;
  prev?: { idx: Uint8Array; pal: number[][]; t: number };
}
const recs = new Map<number, Rec>();
const MAX_FRAMES = 300;

export const isRecording = (tabId: number) => !!recs.get(tabId)?.on;

export function gifStart(tabId: number) {
  recs.set(tabId, { enc: GIFEncoder(), w: 0, h: 0, n: 0, on: true });
}

export function gifStop(tabId: number) {
  const r = recs.get(tabId);
  if (!r) throw new Error('Not recording; use a=start.');
  r.on = false;
  return r.n;
}

/** Add a frame; `mark` is a click point in bitmap pixels. */
export function gifFrame(tabId: number, bmp: ImageBitmap, mark?: { x: number; y: number }) {
  const r = recs.get(tabId);
  if (!r?.on || r.n >= MAX_FRAMES) return;
  if (!r.w) {
    r.w = Math.min(800, bmp.width);
    r.h = Math.round((bmp.height * r.w) / bmp.width);
  }
  const c = new OffscreenCanvas(r.w, r.h);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, r.w, r.h);
  if (mark) {
    ctx.strokeStyle = '#ff4d2e';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc((mark.x * r.w) / bmp.width, (mark.y * r.h) / bmp.height, 14, 0, Math.PI * 2);
    ctx.stroke();
  }
  const { data } = ctx.getImageData(0, 0, r.w, r.h);
  const pal = quantize(data, 256);
  const idx = applyPalette(data, pal);
  const now = Date.now();
  flush(r, Math.min(Math.max(now - (r.prev?.t ?? now), 400), 2000));
  r.prev = { idx, pal, t: now };
  r.n++;
}

function flush(r: Rec, delay: number) {
  if (!r.prev) return;
  r.enc.writeFrame(r.prev.idx, r.w, r.h, { palette: r.prev.pal, delay, repeat: 0 });
  r.prev = undefined;
}

export function gifSave(tabId: number) {
  const r = recs.get(tabId);
  if (!r?.n) throw new Error('No frames recorded; use a=start, then act.');
  flush(r, 1500);
  r.enc.finish();
  recs.delete(tabId);
  return { bytes: r.enc.bytes(), n: r.n };
}
