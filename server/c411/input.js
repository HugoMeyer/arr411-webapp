'use strict';
// Turns viewer messages (untrusted JSON from a browser) into Input.* parameters. Anything unexpected is dropped:
// only plain typing, editing keys, left clicks and scrolling reach the remote browser, never browser shortcuts.
const MOD_ALT = 1;
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

const LIMITS = { minW: 320, maxW: 1920, minH: 240, maxH: 1080 };
const NAMED_KEYS = {
  Enter: { kc: 13, text: '\r' },
  Tab: { kc: 9 },
  Backspace: { kc: 8 },
  Delete: { kc: 46 },
  Escape: { kc: 27 },
  ArrowLeft: { kc: 37 },
  ArrowUp: { kc: 38 },
  ArrowRight: { kc: 39 },
  ArrowDown: { kc: 40 },
  Home: { kc: 36 },
  End: { kc: 35 },
  PageUp: { kc: 33 },
  PageDown: { kc: 34 },
  Insert: { kc: 45 }
};
// Select all, undo, redo. Copy, cut and paste are left out on purpose: the clipboard of the remote browser is shared by
// everybody who uses it, and the pasted text of the person in front of the screen travels as 'text' messages.
const SHORTCUT_LETTERS = new Set(['a', 'z', 'y']);

function num(v, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

function size(w, h) {
  const cw = num(w, 0, 100000);
  const ch = num(h, 0, 100000);
  if (cw === null || ch === null) return null;
  return {
    w: Math.round(Math.min(LIMITS.maxW, Math.max(LIMITS.minW, cw))),
    h: Math.round(Math.min(LIMITS.maxH, Math.max(LIMITS.minH, ch)))
  };
}

function mouse(msg, view) {
  const x = num(msg.x, 0, view.w - 1);
  const y = num(msg.y, 0, view.h - 1);
  if (x === null || y === null) return null;
  const mods = (num(msg.m, 0, 15) | 0) & MOD_SHIFT;
  const base = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, modifiers: mods, pointerType: 'mouse' };
  const pressed = (num(msg.bs, 0, 7) | 0) & 1;
  switch (msg.a) {
    case 'move':
      return { type: 'mouseMoved', ...base, button: pressed ? 'left' : 'none', buttons: pressed };
    case 'down':
      if ((num(msg.b, 0, 5) | 0) !== 0) return null;
      return { type: 'mousePressed', ...base, button: 'left', buttons: 1, clickCount: num(msg.n, 1, 3) | 0 || 1 };
    case 'up':
      if ((num(msg.b, 0, 5) | 0) !== 0) return null;
      return { type: 'mouseReleased', ...base, button: 'left', buttons: 0, clickCount: num(msg.n, 1, 3) | 0 || 1 };
    case 'wheel': {
      const dx = num(msg.dx, -1000, 1000);
      const dy = num(msg.dy, -1000, 1000);
      if (dx === null || dy === null) return null;
      return { type: 'mouseWheel', ...base, modifiers: 0, deltaX: dx, deltaY: dy };
    }
    default:
      return null;
  }
}

function printableKeyCode(key) {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  if (key === ' ') return 32;
  return 0;
}

function key(msg) {
  if (msg.a !== 'down' && msg.a !== 'up') return null;
  if (typeof msg.key !== 'string' || msg.key.length === 0 || msg.key.length > 32) return null;
  const k = msg.key;
  const code = typeof msg.code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(msg.code) ? msg.code : '';
  const m = (num(msg.m, 0, 15) | 0) & (MOD_ALT | MOD_CTRL | MOD_META | MOD_SHIFT);
  const repeat = msg.r === true;
  const named = Object.hasOwn(NAMED_KEYS, k) ? NAMED_KEYS[k] : null;
  const printable = !named && [...k].length === 1 && !/[\u0000-\u001f\u007f]/.test(k);
  if (!named && !printable) return null;

  let modifiers = m;
  let text;
  let kc;
  if (printable) {
    const shortcut = ((m & MOD_CTRL) && !(m & MOD_ALT)) || (m & MOD_META);
    if (shortcut) {
      if (!SHORTCUT_LETTERS.has(k.toLowerCase())) return null;
      // The remote browser runs on Linux, where the editing shortcuts use Ctrl: Cmd on a Mac becomes Ctrl.
      modifiers = (m & MOD_SHIFT) | MOD_CTRL;
    } else {
      // AltGr and Option produce characters: send them as plain typing.
      modifiers = m & MOD_SHIFT;
      text = k;
    }
    kc = printableKeyCode(k) || (num(msg.kc, 0, 255) | 0);
  } else {
    if (m & MOD_ALT) return null;
    modifiers = m & (MOD_CTRL | MOD_META | MOD_SHIFT);
    kc = named.kc;
    text = named.text;
  }
  const out = {
    type: msg.a === 'up' ? 'keyUp' : text !== undefined ? 'keyDown' : 'rawKeyDown',
    key: k,
    code,
    modifiers,
    windowsVirtualKeyCode: kc,
    nativeVirtualKeyCode: kc,
    autoRepeat: repeat
  };
  if (msg.a === 'down' && text !== undefined) {
    out.text = text;
    out.unmodifiedText = text;
  }
  return out;
}

function text(msg) {
  if (typeof msg.s !== 'string' || msg.s.length === 0) return null;
  const s = msg.s.slice(0, 5000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return s ? { text: s } : null;
}

const NAV_ACTIONS = new Set(['back', 'forward', 'reload', 'home']);

module.exports = { LIMITS, size, mouse, key, text, NAV_ACTIONS };
