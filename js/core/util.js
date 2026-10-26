/**
 * Pure helpers: ids, hashing, seeded randomness, shuffling, timing and formatting.
 *
 * No DOM access and no side effects at import time, so this module runs
 * unchanged in the browser and in Node unit tests.
 *
 * @module core/util
 */

/** One second in milliseconds. */
export const SECOND_MS = 1000;
/** One minute in milliseconds. */
export const MINUTE_MS = 60 * SECOND_MS;
/** One hour in milliseconds. */
export const HOUR_MS = 60 * MINUTE_MS;
/** One (nominal, 24 h) day in milliseconds. Use {@link addDays} for calendar math. */
export const DAY_MS = 24 * HOUR_MS;

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Returns `n` random characters from [0-9a-z]. Uses the Web Crypto API when
 * available (rejection sampling, no modulo bias), else Math.random.
 * @param {number} n
 * @returns {string}
 */
function randomChars(n) {
  const cryptoObj = globalThis.crypto;
  let out = '';
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buf = new Uint8Array(n * 2);
    while (out.length < n) {
      cryptoObj.getRandomValues(buf);
      for (let i = 0; i < buf.length && out.length < n; i++) {
        // 252 = 36 * 7: discard the top 4 values so every char is equally likely.
        if (buf[i] < 252) out += ID_ALPHABET[buf[i] % 36];
      }
    }
    return out;
  }
  for (let i = 0; i < n; i++) out += ID_ALPHABET[Math.floor(Math.random() * 36)];
  return out;
}

/**
 * Creates a unique, URL-safe, roughly time-ordered id (lowercase [0-9a-z], 19 chars).
 * The first 9 chars encode the creation time, so ids sort by creation.
 * @returns {string}
 * @example uid() // "0mh4k2x9a7f3kq1z0b2"
 */
export function uid() {
  return Date.now().toString(36).padStart(9, '0') + randomChars(10);
}

/**
 * 32-bit FNV-1a hash of the UTF-8 bytes of a string (lone surrogates are
 * hashed as U+FFFD, like TextEncoder does).
 * @param {string} input
 * @returns {number} Unsigned 32-bit integer.
 * @example hashString('a') // 0xe40c292c
 */
export function hashString(input) {
  const s = String(input ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      h = Math.imul(h ^ cp, 0x01000193);
    } else if (cp < 0x800) {
      h = Math.imul(h ^ (0xc0 | (cp >> 6)), 0x01000193);
      h = Math.imul(h ^ (0x80 | (cp & 0x3f)), 0x01000193);
    } else if (cp < 0x10000) {
      h = Math.imul(h ^ (0xe0 | (cp >> 12)), 0x01000193);
      h = Math.imul(h ^ (0x80 | ((cp >> 6) & 0x3f)), 0x01000193);
      h = Math.imul(h ^ (0x80 | (cp & 0x3f)), 0x01000193);
    } else {
      h = Math.imul(h ^ (0xf0 | (cp >> 18)), 0x01000193);
      h = Math.imul(h ^ (0x80 | ((cp >> 12) & 0x3f)), 0x01000193);
      h = Math.imul(h ^ (0x80 | ((cp >> 6) & 0x3f)), 0x01000193);
      h = Math.imul(h ^ (0x80 | (cp & 0x3f)), 0x01000193);
    }
  }
  return h >>> 0;
}

/**
 * Deterministic pseudo-random generator (mulberry32).
 * Integer seeds are used as-is (mod 2^32); any other seed (string, float,
 * object) is hashed with {@link hashString} first.
 * @param {number | string} [seed]
 * @returns {() => number} Function returning floats in [0, 1).
 * @example const rand = seededRandom('session-1'); rand(); // same value every time
 */
export function seededRandom(seed = Date.now()) {
  let a = Number.isInteger(seed) ? Number(seed) >>> 0 : hashString(String(seed));
  return function mulberry32() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates shuffle. Never mutates the input.
 * @template T
 * @param {Iterable<T> | ArrayLike<T>} array
 * @param {() => number} [rand] Generator of floats in [0, 1).
 * @returns {T[]} A new, shuffled array.
 */
export function shuffle(array, rand = Math.random) {
  const out = Array.from(array ?? []);
  for (let i = out.length - 1; i > 0; i--) {
    let r = rand();
    if (!(r >= 0 && r < 1)) r = 0;
    const j = Math.floor(r * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/**
 * Restricts `n` to `[min, max]`. NaN becomes `min`.
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(n, min, max) {
  if (min > max) [min, max] = [max, min];
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * @template {(...args: any[]) => any} F
 * @typedef {((...args: Parameters<F>) => void) & {
 *   cancel: () => void,
 *   flush: () => (ReturnType<F> | undefined),
 *   pending: () => boolean,
 * }} Debounced
 */

/**
 * Delays calls until `ms` have passed without a new call (trailing edge).
 * The returned function has `cancel()`, `flush()` (run now if pending) and `pending()`.
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} [ms]
 * @returns {Debounced<F>}
 */
export function debounce(fn, ms = 0) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {any[] | undefined} */
  let lastArgs;
  /** @type {any} */
  let lastThis;

  function invoke() {
    timer = null;
    const args = lastArgs || [];
    const ctx = lastThis;
    lastArgs = undefined;
    lastThis = undefined;
    return fn.apply(ctx, args);
  }

  /** @this {any} */
  function debounced(...args) {
    lastArgs = args;
    // eslint-disable-next-line no-invalid-this
    lastThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(invoke, ms);
  }
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = undefined;
    lastThis = undefined;
  };
  debounced.flush = () => {
    if (timer === null) return undefined;
    clearTimeout(timer);
    return invoke();
  };
  debounced.pending = () => timer !== null;
  return /** @type {Debounced<F>} */ (debounced);
}

/**
 * @template {(...args: any[]) => any} F
 * @typedef {((...args: Parameters<F>) => void) & { cancel: () => void, flush: () => void }} Throttled
 */

/**
 * Runs `fn` at most once per `ms`: immediately on the first call, then once
 * more at the end of the window with the latest arguments (leading + trailing).
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} [ms]
 * @returns {Throttled<F>}
 */
export function throttle(fn, ms = 0) {
  let last = -Infinity;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {any[] | null} */
  let pendingArgs = null;
  /** @type {any} */
  let pendingThis;

  function trailing() {
    timer = null;
    if (!pendingArgs) return;
    const args = pendingArgs;
    const ctx = pendingThis;
    pendingArgs = null;
    pendingThis = undefined;
    last = Date.now();
    fn.apply(ctx, args);
  }

  /** @this {any} */
  function throttled(...args) {
    const now = Date.now();
    const remaining = ms - (now - last);
    if (remaining <= 0 || remaining > ms) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingArgs = null;
      last = now;
      // eslint-disable-next-line no-invalid-this
      fn.apply(this, args);
      return;
    }
    pendingArgs = args;
    // eslint-disable-next-line no-invalid-this
    pendingThis = this;
    if (timer === null) timer = setTimeout(trailing, remaining);
  }
  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingArgs = null;
    pendingThis = undefined;
    last = -Infinity;
  };
  throttled.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    trailing();
  };
  return /** @type {Throttled<F>} */ (throttled);
}

/**
 * Resolves after `ms`. Rejects with the signal's reason if `signal` aborts first.
 * @param {number} ms
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<void>}
 */
export function sleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, Number(ms) || 0));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Formats a duration as a clock: `m:ss` under an hour, `h:mm:ss` above.
 * Partial seconds are dropped. Negative or invalid input gives `"0:00"`.
 * @param {number} ms
 * @returns {string}
 * @example formatDuration(65000) // "1:05"
 * @example formatDuration(3723000) // "1:02:03"
 */
export function formatDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / SECOND_MS) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * @param {number | Date} ts
 * @returns {Date}
 */
function toDate(ts) {
  return ts instanceof Date ? new Date(ts.getTime()) : new Date(Number(ts));
}

/**
 * Local calendar day of a timestamp as `YYYY-MM-DD`.
 * @param {number | Date} [ts]
 * @returns {string}
 */
export function dayKey(ts = Date.now()) {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return '';
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Local midnight at the start of the day containing `ts`.
 * @param {number | Date} [ts]
 * @returns {number}
 */
export function startOfDay(ts = Date.now()) {
  const d = toDate(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Adds whole calendar days in local time (DST-safe; keeps the wall-clock time).
 * @param {number | Date} ts
 * @param {number} days May be negative.
 * @returns {number}
 */
export function addDays(ts, days) {
  const d = toDate(ts);
  d.setDate(d.getDate() + Math.trunc(days));
  return d.getTime();
}

/**
 * Short date such as `"12 Mar"`, with the year added when it differs from `now`'s year.
 * @param {number | Date} ts
 * @param {number | Date} [now]
 * @returns {string}
 */
export function formatDate(ts, now = Date.now()) {
  const d = toDate(ts);
  if (Number.isNaN(d.getTime())) return '';
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === toDate(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/**
 * Friendly relative time.
 * Past: "just now", "5 min ago", "3 h ago", "yesterday", "12 Mar" (or "12 Mar 2025").
 * Future: "just now", "in 5 min", "in 3 h", "tomorrow", "14 Mar".
 * @param {number | Date} ts
 * @param {number | Date} [now]
 * @returns {string} Empty string for an invalid timestamp.
 */
export function formatRelative(ts, now = Date.now()) {
  const t = toDate(ts).getTime();
  const n = toDate(now).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(n)) return '';
  const diff = n - t;
  const sameDay = dayKey(t) === dayKey(n);
  if (Math.abs(diff) < MINUTE_MS) return 'just now';
  if (diff > 0) {
    if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} min ago`;
    if (sameDay || diff < 6 * HOUR_MS) return `${Math.floor(diff / HOUR_MS)} h ago`;
    if (dayKey(t) === dayKey(addDays(n, -1))) return 'yesterday';
    return formatDate(t, n);
  }
  const ahead = -diff;
  if (ahead < HOUR_MS) return `in ${Math.ceil(ahead / MINUTE_MS)} min`;
  if (sameDay) return `in ${Math.max(1, Math.round(ahead / HOUR_MS))} h`;
  if (dayKey(t) === dayKey(addDays(n, 1))) return 'tomorrow';
  return formatDate(t, n);
}

/** @type {Intl.NumberFormat | null} */
let numberFormat = null;

/**
 * Formats a number with English digit grouping: `5000` → `"5,000"`.
 * @param {number} n
 * @returns {string}
 */
export function formatNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  try {
    numberFormat ??= new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
    return numberFormat.format(v);
  } catch {
    return String(Math.round(v * 10) / 10).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}

/**
 * Count with the right word form: `plural(1, 'question')` → `"1 question"`,
 * `plural(5000, 'question')` → `"5,000 questions"`, `plural(2, 'child', 'children')` → `"2 children"`.
 * @param {number} n
 * @param {string} word Singular form.
 * @param {string} [pluralWord] Plural form (default: `word + 's'`).
 * @returns {string}
 */
export function plural(n, word, pluralWord) {
  const count = Number(n) || 0;
  const form = Math.abs(count) === 1 ? word : (pluralWord ?? `${word}s`);
  return `${formatNumber(count)} ${form}`;
}

/**
 * Integer percentage of `a` over `b`, clamped to 0..100. Returns 0 when `b` ≤ 0.
 * Never shows 100 unless `a >= b`, and never 0 when `a > 0`, so it stays honest.
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
export function pct(a, b) {
  const num = Number(a);
  const den = Number(b);
  if (!(den > 0) || !Number.isFinite(num) || !Number.isFinite(den) || num <= 0) return 0;
  const p = Math.round(clamp(num / den, 0, 1) * 100);
  if (p === 100 && num < den) return 99;
  if (p === 0) return 1;
  return p;
}

/**
 * Escapes a string for literal use inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
