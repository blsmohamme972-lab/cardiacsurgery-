/**
 * App settings: defaults, validation, persistence (settingsRepo) and
 * application to `<html>`:
 * - `data-theme="light|dark"` (theme `'system'` follows the OS live),
 * - `data-reduce-motion="true|false"` (`'system'` follows the OS live),
 * - `style="--font-scale: <n>"`,
 * plus `color-scheme` and `<meta name="theme-color">` to match.
 *
 * `getSetting()` is synchronous; before `initSettings()` resolves it returns
 * the defaults. If storage is unavailable the app keeps working with
 * in-memory settings.
 *
 * Importing this module does not touch `document` or `window`.
 *
 * @module core/settings
 */

import { bus } from './events.js';
import { settingsRepo } from './store/repo.js';

/**
 * Default value of every known setting.
 * @type {Readonly<Record<string, any>>}
 */
export const DEFAULTS = Object.freeze({
  theme: 'system', // 'system' | 'light' | 'dark'
  fontScale: 1, // 0.85 – 1.5
  reduceMotion: 'system', // 'system' | 'on' | 'off' (true / false also accepted)
  shuffleChoices: true,
  defaultCount: 20,
  examSecondsPerQuestion: 90,
  autoAdvance: false,
  showTimer: true,
  drawInput: 'auto', // 'auto' | 'finger' | 'pen'
  highlightColor: 'yellow',
  inkTool: 'pen',
  inkColor: '#1d4ed8',
  inkSize: 0.006,
  reviewerMode: false,
  tourDone: false,
  askGptNoticeSeen: false,
  lastRoute: null,
});

/** Font scale bounds. */
export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.5;

const INVALID = Symbol('invalid');

/**
 * @param {readonly any[]} allowed
 * @returns {(v: any) => any}
 */
const oneOf = (allowed) => (v) => (allowed.includes(v) ? v : INVALID);

/** @param {any} v */
const bool = (v) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return INVALID;
};

/**
 * @param {number} min
 * @param {number} max
 * @param {number} [decimals]
 * @returns {(v: any) => any}
 */
const numberIn = (min, max, decimals = 0) => (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return INVALID;
  const f = 10 ** decimals;
  return Math.round(Math.min(max, Math.max(min, n)) * f) / f;
};

/**
 * Validators/normalisers for known keys. Unknown keys are stored as given.
 * @type {Record<string, (v: any) => any>}
 */
const SANITIZERS = {
  theme: oneOf(['system', 'light', 'dark']),
  fontScale: numberIn(FONT_SCALE_MIN, FONT_SCALE_MAX, 2),
  reduceMotion: (v) => {
    if (v === 'system' || v === 'on' || v === 'off' || typeof v === 'boolean') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return INVALID;
  },
  shuffleChoices: bool,
  defaultCount: (v) => (v === 'all' ? 'all' : numberIn(1, 10000)(v)),
  examSecondsPerQuestion: numberIn(0, 3600),
  autoAdvance: bool,
  showTimer: bool,
  drawInput: oneOf(['auto', 'finger', 'pen']),
  highlightColor: oneOf(['yellow', 'green', 'blue', 'pink']),
  inkTool: oneOf(['pen', 'hl', 'eraser']),
  inkColor: (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : INVALID),
  inkSize: numberIn(0.001, 0.05, 4),
  reviewerMode: bool,
  tourDone: bool,
  askGptNoticeSeen: bool,
  lastRoute: (v) => (v === null || (typeof v === 'string' && v.startsWith('/') && v.length <= 2048) ? v : INVALID),
};

/** Keys that change what `applySettings()` writes to the document. */
const APPEARANCE_KEYS = new Set(['theme', 'fontScale', 'reduceMotion']);

/** @type {Record<string, any>} */
const values = { ...DEFAULTS };
/** @type {Promise<Record<string, any>> | null} */
let initPromise = null;
/** Max time the first screen waits for saved settings. */
const INIT_TIMEOUT_MS = 2500;
/** Keys set by setSetting() this session: a (late) stored copy must not overwrite them. */
const touched = new Set();
/** Keys currently being written by this module (to ignore our own store:change echo). */
const ownWrites = new Map();

/**
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Sanitises a stored value; invalid stored values fall back to the default.
 * @param {string} key
 * @param {any} value
 * @returns {any}
 */
function fromStorage(key, value) {
  const sanitize = SANITIZERS[key];
  if (!sanitize) return value;
  const out = sanitize(value);
  return out === INVALID ? DEFAULTS[key] : out;
}

/**
 * @param {string} query
 * @returns {MediaQueryList | null}
 */
function media(query) {
  try {
    return typeof matchMedia === 'function' ? matchMedia(query) : null;
  } catch {
    return null;
  }
}

/**
 * The theme actually shown: `'light'` or `'dark'` (resolves `'system'` via the OS).
 * @returns {'light' | 'dark'}
 */
export function resolvedTheme() {
  const theme = values.theme;
  if (theme === 'light' || theme === 'dark') return theme;
  return media('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}

/**
 * Whether motion should be reduced right now (resolves `'system'` via the OS).
 * @returns {boolean}
 */
export function resolvedReduceMotion() {
  const v = values.reduceMotion;
  if (v === true || v === 'on') return true;
  if (v === false || v === 'off') return false;
  return Boolean(media('(prefers-reduced-motion: reduce)')?.matches);
}

/**
 * Applies appearance settings to `<html>`:
 * `data-theme`, `data-reduce-motion`, `--font-scale`, `color-scheme`, and
 * `<meta name="theme-color">`. No-op outside a browser.
 * @returns {void}
 */
export function applySettings() {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  const theme = resolvedTheme();
  root.dataset.theme = theme;
  root.dataset.reduceMotion = String(resolvedReduceMotion());
  root.style.setProperty('--font-scale', String(values.fontScale));
  root.style.colorScheme = theme;
  syncThemeColor();
}

/** Matches the browser UI color (Android status bar, Safari tab bar) to the app theme. */
function syncThemeColor() {
  try {
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length === 0) return;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (!color) {
      // Stylesheets not applied yet: try again once the page has loaded.
      if (document.readyState !== 'complete' && typeof window !== 'undefined') {
        window.addEventListener('load', syncThemeColor, { once: true });
      }
      return;
    }
    for (const meta of metas) {
      meta.removeAttribute('media');
      meta.setAttribute('content', color);
    }
  } catch {
    /* cosmetic only */
  }
}

/** Follows OS theme / reduced-motion changes live while a setting is `'system'`. */
function watchSystem() {
  const dark = media('(prefers-color-scheme: dark)');
  const motion = media('(prefers-reduced-motion: reduce)');
  /**
   * @param {MediaQueryList | null} mq
   * @param {() => void} fn
   */
  const listen = (mq, fn) => {
    if (!mq) return;
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
    else if (typeof (/** @type {any} */ (mq).addListener) === 'function') /** @type {any} */ (mq).addListener(fn);
  };
  listen(dark, () => {
    if (values.theme !== 'system') return;
    applySettings();
    bus.emit('settings:change', { key: 'theme', value: values.theme, resolved: resolvedTheme(), source: 'system' });
  });
  listen(motion, () => {
    if (values.reduceMotion !== 'system') return;
    applySettings();
    bus.emit('settings:change', {
      key: 'reduceMotion',
      value: values.reduceMotion,
      resolved: resolvedReduceMotion(),
      source: 'system',
    });
  });
}

/**
 * Reloads settings after an outside write (e.g. a backup import replaced
 * the settings store) and announces each changed key.
 * @param {string | null} key `null` reloads every key.
 */
async function reloadFromStore(key) {
  try {
    /** @type {Record<string, any>} */
    let stored;
    /** @type {string[]} */
    let keys;
    if (key == null) {
      stored = await settingsRepo.all();
      keys = [...new Set([...Object.keys(DEFAULTS), ...Object.keys(values), ...Object.keys(stored)])];
    } else {
      const v = await settingsRepo.get(key);
      stored = v === undefined ? {} : { [key]: v };
      keys = [key];
    }
    /** @type {string[]} */
    const changedKeys = [];
    for (const k of keys) {
      if (ownWrites.has(k)) continue;
      const next = k in stored ? fromStorage(k, stored[k]) : DEFAULTS[k];
      if (!sameValue(values[k], next)) {
        if (next === undefined) delete values[k];
        else values[k] = next;
        changedKeys.push(k);
      }
    }
    if (changedKeys.some((k) => APPEARANCE_KEYS.has(k))) applySettings();
    for (const k of changedKeys) bus.emit('settings:change', { key: k, value: values[k], source: 'store' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[settings] Could not reload settings:', err);
  }
}

/**
 * Applies saved settings that arrived after init gave up waiting.
 * @param {Record<string, any>} stored
 */
function applyLateLoad(stored) {
  /** @type {string[]} */
  const changedKeys = [];
  for (const [key, value] of Object.entries(stored || {})) {
    if (touched.has(key)) continue;
    const next = fromStorage(key, value);
    if (!sameValue(values[key], next)) {
      values[key] = next;
      changedKeys.push(key);
    }
  }
  if (changedKeys.some((k) => APPEARANCE_KEYS.has(k))) applySettings();
  for (const k of changedKeys) bus.emit('settings:change', { key: k, value: values[k], source: 'store' });
}

/**
 * Loads saved settings (invalid values fall back to defaults), applies them,
 * and starts following OS theme / motion changes. Never rejects: if storage
 * is unavailable, defaults are used in memory. Safe to call more than once.
 * @returns {Promise<Record<string, any>>} A copy of all settings.
 */
export function initSettings() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const TIMED_OUT = Symbol('timeout');
    const load = settingsRepo.all();
    try {
      const stored = await Promise.race([
        load,
        new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), INIT_TIMEOUT_MS)),
      ]);
      if (stored === TIMED_OUT) {
        // A slow/hung database must not hold the first screen. Start with
        // defaults and apply the saved values when they arrive.
        // eslint-disable-next-line no-console
        console.warn('[settings] Saved settings are slow to load; starting with defaults.');
        load.then(applyLateLoad, () => {});
      } else {
        for (const [key, value] of Object.entries(/** @type {Record<string, any>} */ (stored))) {
          if (touched.has(key)) continue;
          values[key] = fromStorage(key, value);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[settings] Could not load saved settings; using defaults.', err);
    }
    watchSystem();
    bus.on('store:change', (payload) => {
      if (!payload || payload.store !== 'settings') return;
      if (payload.key != null && ownWrites.has(payload.key)) return;
      void reloadFromStore(payload.key ?? null);
    });
    applySettings();
    return getAllSettings();
  })();
  return initPromise;
}

/**
 * Current value of a setting (synchronous). Returns the default before init,
 * and `undefined` for unknown keys that were never set.
 * @param {string} key
 * @returns {any}
 */
export function getSetting(key) {
  return values[key];
}

/**
 * A shallow copy of every current setting.
 * @returns {Record<string, any>}
 */
export function getAllSettings() {
  return { ...values };
}

/**
 * Validates, stores in memory, applies, emits `settings:change` ({key, value})
 * and persists a setting. Known keys are validated (numeric strings and
 * "true"/"false" are coerced); unknown keys are stored as given.
 *
 * Resolves `true` when saved, `false` when it could only be kept in memory
 * (storage failure; already logged). Rejects only for invalid input.
 * @param {string} key
 * @param {any} value
 * @returns {Promise<boolean>}
 */
export async function setSetting(key, value) {
  if (typeof key !== 'string' || key === '') throw new TypeError('setSetting: key must be a non-empty string');
  let next = value;
  const sanitize = SANITIZERS[key];
  if (sanitize) {
    next = sanitize(value);
    if (next === INVALID) throw new TypeError(`setSetting: invalid value for "${key}": ${String(value)}`);
  } else if (next === undefined) {
    throw new TypeError(`setSetting: value for "${key}" is undefined`);
  }
  touched.add(key);
  if (sameValue(values[key], next)) return true;

  values[key] = next;
  if (APPEARANCE_KEYS.has(key)) applySettings();
  bus.emit('settings:change', { key, value: next });

  ownWrites.set(key, (ownWrites.get(key) || 0) + 1);
  try {
    await settingsRepo.set(key, next);
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[settings] Could not save "${key}"; kept for this session only.`, err);
    return false;
  } finally {
    const n = (ownWrites.get(key) || 1) - 1;
    if (n <= 0) ownWrites.delete(key);
    else ownWrites.set(key, n);
  }
}
