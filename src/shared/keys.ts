export interface KeySpec {
  key: string;
  code: string;
  vk: number;
  text: string;
  /** Bitmask: Alt=1 Ctrl=2 Meta=4 Shift=8 (same as CDP). */
  mods: number;
}

const NAMED: Record<string, [string, string, number, string?]> = {
  enter: ['Enter', 'Enter', 13, '\r'],
  return: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9],
  escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27],
  backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46],
  del: ['Delete', 'Delete', 46],
  space: [' ', 'Space', 32, ' '],
  arrowup: ['ArrowUp', 'ArrowUp', 38],
  up: ['ArrowUp', 'ArrowUp', 38],
  arrowdown: ['ArrowDown', 'ArrowDown', 40],
  down: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  left: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39],
  right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36],
  end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34],
  insert: ['Insert', 'Insert', 45],
};

const MODS: Record<string, number> = {
  alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8,
};

/** Parse "ctrl+a Backspace Enter" into key specs (space separates presses). */
export function parseKeys(s: string): KeySpec[] {
  const combos = s.trim().split(/\s+/).filter(Boolean);
  if (!combos.length) throw new Error('key needs text, e.g. "Enter" or "ctrl+a"');
  return combos.map(parseCombo);
}

function parseCombo(c: string): KeySpec {
  const parts = c.split('+');
  let k = parts.pop() ?? '';
  if (k === '' && parts.length) {
    parts.pop();
    k = '+';
  }
  let mods = 0;
  for (const p of parts) {
    const m = MODS[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}"`);
    mods |= m;
  }
  const cmd = (mods & 7) !== 0;
  const named = NAMED[k.toLowerCase()];
  if (named) return { key: named[0], code: named[1], vk: named[2], text: cmd ? '' : named[3] ?? '', mods };
  const f = /^f([1-9]|1[0-2])$/i.exec(k);
  if (f) return { key: 'F' + f[1], code: 'F' + f[1], vk: 111 + Number(f[1]), text: '', mods };
  if (k.length === 1) {
    const up = k.toUpperCase();
    const code = /[a-z]/i.test(k) ? 'Key' + up : /\d/.test(k) ? 'Digit' + k : '';
    const vk = /[a-z0-9]/i.test(k) ? up.charCodeAt(0) : 0;
    const key = mods & 8 ? up : k;
    return { key, code, vk, text: cmd ? '' : key, mods };
  }
  throw new Error(`Unknown key "${k}"`);
}
