// Script of the page's own world (MAIN), injected at the start of the document on the C411 site only.
// It never talks to the server and keeps nothing but a few references to the blobs the page makes. While the isolated
// script has armed a download, it turns the file the site tries to save into a DOM event for that script (the bytes
// themselves when the file is a blob: the policy of the site may forbid the isolated script from fetching it); the rest
// of the time every function it wraps behaves as before. It also keeps blob URLs alive a little longer and flags <html>
// once the Nuxt page is hydrated.
(() => {
  'use strict';
  const CFG = __ARR411_CONFIG__;

  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

  // Same rules as server/c411/hosts.js: lower-case DNS name, no IP literal (even in disguise: 2130706433, 0x7f.1, 127.1).
  function normalizeHost(input) {
    const h = String(input == null ? '' : input).trim().toLowerCase().replace(/\.$/, '');
    if (!h || h.length > 253 || h.startsWith('[')) return '';
    const labels = h.split('.');
    if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(labels[labels.length - 1])) return '';
    return labels.every((l) => LABEL.test(l)) ? h : '';
  }

  function hostAllowed(host, patterns) {
    const h = normalizeHost(host);
    if (!h || !Array.isArray(patterns)) return false;
    return patterns.some((p) => p === '*' || p === h || (typeof p === 'string' && p.startsWith('*.') && h.endsWith(p.slice(1)) && h.length > p.length - 1));
  }

  function allowedHere() {
    try {
      if (window !== window.top) return false;
      const loc = window.location;
      const secure = loc.protocol === 'https:' || (CFG.allowHttp === true && loc.protocol === 'http:');
      return secure && hostAllowed(loc.hostname, CFG.hosts);
    } catch (e) {
      return false;
    }
  }

  if (!allowedHere()) return;

  const MAX_ARM_MS = 30000;
  const REVOKE_DELAY_MS = 120000;
  const HYDRATION_TIMEOUT_MS = 15000;
  const HYDRATION_GIVE_UP_MS = 60000;
  const MAX_BLOBS = 8;
  // Same ceiling as torrentLimit() in the isolated script: what one request carries through the DevTools connection.
  const MAX_BLOB_BYTES = Math.min(CFG.maxTorrentBytes, Math.floor((20 * 1024 * 1024 - 16384) / 4) * 3);

  // The page may change these later: keep the originals.
  const apply = Reflect.apply;
  const dateNow = Date.now;
  const setTimer = window.setTimeout;
  const addListener = EventTarget.prototype.addEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const toJSON = JSON.stringify;
  const Custom = window.CustomEvent;
  const Address = window.URL;
  const revoke = Address.revokeObjectURL;
  const Reader = window.FileReader;
  const readAsDataURL = Reader && Reader.prototype.readAsDataURL;
  const blobSize = (() => {
    try {
      return Object.getOwnPropertyDescriptor(window.Blob.prototype, 'size').get;
    } catch (e) {
      return null;
    }
  })();

  const now = () => apply(dateNow, Date, []);
  const later = (fn, ms) => apply(setTimer, window, [fn, ms]);

  // The isolated script says for how long a download may be taken over; anything else disarms.
  let armedUntil = 0;
  const armed = () => armedUntil > now();

  apply(addListener, document, [`${CFG.topic}:arm`, (e) => {
    try {
      const d = e.detail;
      const ms = typeof d === 'string' && /^\d{1,6}$/.test(d) ? Number(d) : 0;
      armedUntil = ms > 0 ? now() + Math.min(ms, MAX_ARM_MS) : 0;
    } catch (err) {
      armedUntil = 0;
    }
  }, false]);

  const isFile = (a) => a.hasAttribute('download') || a.href.startsWith('blob:') || /\.torrent(\?|$)/i.test(a.href);

  // The last few blobs the page made, by address. The isolated script cannot always fetch a blob of the site (a strict
  // connect-src forbids it there as well), so the bytes of the one that is taken over travel in the hand-off itself.
  const blobs = new Map();

  function remember(blob, url) {
    if (!Reader || !readAsDataURL || !blobSize || typeof url !== 'string' || !url.startsWith('blob:')) return;
    const size = apply(blobSize, blob, []);
    if (!(size >= 0 && size <= MAX_BLOB_BYTES)) return;
    blobs.set(url, blob);
    if (blobs.size > MAX_BLOBS) blobs.delete(blobs.keys().next().value);
  }

  // The bytes of a blob in base64 (no prefix), or '' when they cannot be read.
  function readBlob(blob, done) {
    let over = false;
    const finish = (data) => {
      if (over) return;
      over = true;
      done(data);
    };
    try {
      const reader = new Reader();
      apply(addListener, reader, ['load', () => {
        try {
          const text = reader.result;
          const prefix = typeof text === 'string' ? /^data:[^,]*;base64,/.exec(text) : null;
          finish(prefix ? text.slice(prefix[0].length) : '');
        } catch (e) {
          finish('');
        }
      }, false]);
      apply(addListener, reader, ['error', () => finish(''), false]);
      apply(addListener, reader, ['abort', () => finish(''), false]);
      apply(readAsDataURL, reader, [blob]);
    } catch (e) {
      finish('');
    }
  }

  function notify(url, filename, data) {
    try {
      const detail = data ? { url, filename: filename || '', data } : { url, filename: filename || '' };
      apply(dispatch, document, [new Custom(`${CFG.topic}:dl`, { detail: toJSON(detail) })]);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Disarms, then tells the isolated script. False if that failed: the browser then saves the file as usual.
  function handOff(url, filename) {
    armedUntil = 0;
    try {
      const blob = blobs.get(url);
      if (!blob) return notify(url, filename, '');
      // From here the click is ours: whatever happens, the isolated script is told (without the bytes if they could not be read).
      readBlob(blob, (data) => notify(url, filename, data));
      return true;
    } catch (e) {
      return false;
    }
  }

  function grab(a) {
    try {
      const href = a.href;
      if (typeof href !== 'string' || !href || !armed() || !isFile(a)) return false;
      return handOff(href, a.getAttribute('download'));
    } catch (e) {
      return false;
    }
  }

  // handler(thisArg, args) returns { value } to answer in place of the original, anything else lets it run.
  function wrap(owner, name, handler) {
    try {
      const original = owner[name];
      if (typeof original !== 'function') return;
      owner[name] = new Proxy(original, {
        apply(fn, thisArg, args) {
          try {
            const taken = handler(thisArg, args);
            if (taken) return taken.value;
          } catch (e) {
            // the original runs
          }
          return apply(fn, thisArg, args);
        }
      });
    } catch (e) {
      // not hooked: the page keeps working
    }
  }

  // Runs the original, then lets seen(args, result) look at its outcome; the page gets that outcome untouched.
  function observe(owner, name, seen) {
    try {
      const original = owner[name];
      if (typeof original !== 'function') return;
      owner[name] = new Proxy(original, {
        apply(fn, thisArg, args) {
          const result = apply(fn, thisArg, args);
          try {
            seen(args, result);
          } catch (e) {
            // not remembered: the file is then fetched by its address
          }
          return result;
        }
      });
    } catch (e) {
      // not hooked: the page keeps working
    }
  }

  wrap(HTMLAnchorElement.prototype, 'click', (a) => (grab(a) ? { value: undefined } : null));

  wrap(window, 'open', (self, args) => {
    if (!armed() || !args[0]) return null;
    return handOff(new Address(String(args[0]), window.location.href).href, '') ? { value: null } : null;
  });

  observe(Address, 'createObjectURL', (args, url) => remember(args[0], url));

  // Blob URLs stay readable long enough for the isolated script to get the file.
  wrap(Address, 'revokeObjectURL', (self, args) => {
    if (!args.length) return null;
    later(() => {
      try {
        blobs.delete(args[0]);
        apply(revoke, Address, [args[0]]);
      } catch (e) {
        // nothing left to revoke
      }
    }, REVOKE_DELAY_MS);
    return { value: undefined };
  });

  apply(addListener, document, ['click', (e) => {
    if (!armed()) return;
    try {
      const t = e.target;
      const a = t && typeof t.closest === 'function' ? t.closest('a[href]') : null;
      if (a && grab(a)) {
        e.preventDefault();
        e.stopPropagation();
      }
    } catch (err) {
      // the click goes on
    }
  }, true]);

  // C411 (Nuxt) is rendered by the server, then hydrated by Vue, which drops or reuses any node added before it is done.
  const t0 = now();

  function hydrated() {
    const root = document.getElementById('__nuxt');
    const app = root && root.__vue_app__;
    const nuxt = app && app.$nuxt;
    return app ? !nuxt || nuxt.isHydrating === false : !root && document.readyState !== 'loading';
  }

  (function check() {
    let done;
    try {
      done = now() - t0 > HYDRATION_TIMEOUT_MS || hydrated();
    } catch (e) {
      done = now() - t0 > HYDRATION_TIMEOUT_MS;
    }
    const html = document.documentElement;
    if (done && html) {
      try {
        html.setAttribute('data-qbt-hydrated', '1');
      } catch (e) {
        // the isolated script gives up waiting by itself
      }
      return;
    }
    if (now() - t0 < HYDRATION_GIVE_UP_MS) later(check, 100);
  })();
})();
