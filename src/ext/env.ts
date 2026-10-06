// Firefox exposes promise-based `browser`; Chromium MV3 `chrome` also returns promises.
export const api: typeof chrome = (globalThis as any).browser ?? chrome;
export const isFirefox = navigator.userAgent.includes('Firefox/');
const base = isFirefox ? 'firefox' : navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
/** Headless instances get a distinct name so agents can target them with BROWSERBRIDGE_BROWSER=headless. */
export const isHeadless = navigator.userAgent.includes('Headless');
export const browserName = isHeadless ? base + '-headless' : base;
export const hasCdp = !isFirefox && typeof chrome !== 'undefined' && !!chrome.debugger;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
