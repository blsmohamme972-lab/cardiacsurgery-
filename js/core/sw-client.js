/**
 * Service worker client (docs/ARCHITECTURE.md §5.7).
 *
 * - Registers `sw.js` (the app root, resolved relative to this module) with
 *   scope `./`. Skips quietly where service workers can't run (old browsers,
 *   `file://`, insecure origins, the native Capacitor shell).
 * - Checks for a new version on launch and whenever the app becomes visible
 *   again (at most every 30 min), only while online.
 * - A new worker that finished installing while an older one is active →
 *   `bus.emit('sw:update-ready')`; the shell shows "Update available".
 * - `applyUpdate()` tells the waiting worker to take over, then reloads once.
 * - Online/offline → `bus.emit('net:change', {online})` (initial state too).
 * - Never touches IndexedDB: user progress survives every update.
 *
 * Importing this module has no side effects (safe in Node).
 *
 * @module core/sw-client
 */

import { bus } from './events.js';
import { APP_VERSION } from '../version.js';

/** Minimum time between automatic update checks. */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** After a failed check, wait at least this long before an automatic retry. */
const RETRY_AFTER_FAILURE_MS = 2 * 60 * 1000;
/** How long a manual check waits for a found update to finish installing. */
const MANUAL_CHECK_WAIT_MS = 8000;
/** How long to wait for the worker to answer GET_VERSION. */
const VERSION_TIMEOUT_MS = 2000;
/** Reload anyway if `controllerchange` never fires after the new worker activated (old Safari). */
const ACTIVATED_RELOAD_FALLBACK_MS = 1500;

/**
 * @typedef {'update-ready'|'downloading'|'up-to-date'|'offline'|'unsupported'|'error'} UpdateStatus
 */

/** @type {ServiceWorkerRegistration | null} */
let registration = null;
/** @type {Promise<ServiceWorkerRegistration | null> | null} */
let registering = null;
let initialized = false;
/** The page was controlled by a worker (so a controller change means a new version). */
let hadController = false;
/** The user asked this page to apply the update. */
let updateRequested = false;
let reloading = false;
let lastCheckOkAt = 0;
let lastAttemptAt = 0;
/** @type {Promise<UpdateStatus> | null} */
let checkInFlight = null;
/** Workers already announced with `sw:update-ready` (once each per page). */
const announced = new WeakSet();
/** @type {boolean | undefined} */
let lastOnline;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** @returns {boolean} */
function isOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * True inside the native Capacitor app (files are bundled; updates come with the APK).
 * @returns {boolean}
 */
function isNativeShell() {
  try {
    const cap = /** @type {any} */ (globalThis).Capacitor;
    return Boolean(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  } catch {
    return false;
  }
}

/**
 * Whether a service worker can be used here.
 * @returns {boolean}
 */
function isSupported() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker) return false;
  if (window.location.protocol === 'file:') return false;
  if (window.isSecureContext === false) return false;
  return !isNativeShell();
}

/** App root and worker script URL, resolved from this module (js/core/) so a deep page URL can't break them. */
function scriptUrls() {
  return {
    script: new URL('../../sw.js', import.meta.url).href,
    scope: new URL('../../', import.meta.url).href,
  };
}

/** Resolves once the page finished loading, so installing never competes with the first screen. */
function whenLoaded() {
  if (document.readyState === 'complete') return Promise.resolve();
  return new Promise((resolve) => window.addEventListener('load', () => resolve(), { once: true }));
}

/**
 * True when an older worker is (or was) serving the app, so a new one is an update.
 * @param {ServiceWorkerRegistration} reg
 * @returns {boolean}
 */
function hasActiveWorker(reg) {
  return Boolean(reg.active || navigator.serviceWorker.controller);
}

// ---------------------------------------------------------------------------
// Update detection
// ---------------------------------------------------------------------------

/**
 * Announces a worker that is ready to take over (once per worker).
 * @param {ServiceWorker} worker
 */
function announce(worker) {
  if (announced.has(worker)) return;
  announced.add(worker);
  bus.emit('sw:update-ready');
}

/**
 * Follows an installing worker until it is installed (or fails).
 * @param {ServiceWorkerRegistration} reg
 * @param {ServiceWorker} worker
 */
function trackInstalling(reg, worker) {
  const onState = () => {
    if (worker.state === 'installed') {
      worker.removeEventListener('statechange', onState);
      // With no active worker this is the first install: the app is now offline-ready.
      if (hasActiveWorker(reg) && reg.waiting === worker) announce(worker);
    } else if (worker.state === 'redundant' || worker.state === 'activated') {
      worker.removeEventListener('statechange', onState);
    }
  };
  worker.addEventListener('statechange', onState);
  onState();
}

/** @param {ServiceWorkerRegistration} reg */
function watchRegistration(reg) {
  if (reg.waiting && hasActiveWorker(reg)) announce(reg.waiting);
  if (reg.installing) trackInstalling(reg, reg.installing);
  reg.addEventListener('updatefound', () => {
    if (reg.installing) trackInstalling(reg, reg.installing);
  });
}

/**
 * @param {ServiceWorkerRegistration} reg
 * @returns {UpdateStatus}
 */
function statusOf(reg) {
  if (reg.waiting && hasActiveWorker(reg)) return 'update-ready';
  if (reg.installing && hasActiveWorker(reg)) return 'downloading';
  return 'up-to-date';
}

/**
 * The registration, once registered (or the existing one, before init).
 * @returns {Promise<ServiceWorkerRegistration | null>}
 */
async function getRegistration() {
  if (registration) return registration;
  if (registering) return registering;
  if (!isSupported()) return null;
  try {
    return (await navigator.serviceWorker.getRegistration(scriptUrls().scope)) || null;
  } catch {
    return null;
  }
}

/**
 * Asks the browser to look for a new sw.js.
 * @param {{ force?: boolean, reannounce?: boolean }} options
 *   force: ignore the 30-min throttle; reannounce: emit `sw:update-ready`
 *   again for an update that was already announced (manual checks).
 * @returns {Promise<UpdateStatus>}
 */
function runUpdateCheck({ force = false, reannounce = false } = {}) {
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    if (!isSupported()) return 'unsupported';
    const reg = await getRegistration();
    if (!reg) return 'unsupported';
    if (!isOnline()) return 'offline';
    const now = Date.now();
    if (!force && (now - lastCheckOkAt < UPDATE_CHECK_INTERVAL_MS || now - lastAttemptAt < RETRY_AFTER_FAILURE_MS)) {
      return statusOf(reg);
    }
    lastAttemptAt = now;
    try {
      await reg.update();
      lastCheckOkAt = Date.now();
    } catch (err) {
      // Offline, captive portal or server error: try again later, quietly.
      // eslint-disable-next-line no-console
      console.info('[sw-client] Update check failed.', err);
      return isOnline() ? 'error' : 'offline';
    }
    const status = statusOf(reg);
    if (status === 'update-ready' && reannounce && reg.waiting) bus.emit('sw:update-ready');
    return status;
  })().finally(() => {
    checkInFlight = null;
  });
  return checkInFlight;
}

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

function reloadOnce() {
  if (reloading) return;
  reloading = true;
  try {
    window.location.reload();
  } catch (err) {
    reloading = false;
    // eslint-disable-next-line no-console
    console.error('[sw-client] Reload failed.', err);
  }
}

function onControllerChange() {
  const controller = navigator.serviceWorker.controller;
  if (updateRequested) {
    reloadOnce();
    return;
  }
  if (!hadController) {
    // First install claimed this page: nothing changed for the user.
    hadController = Boolean(controller);
    return;
  }
  // Another tab applied an update: offer a reload here instead of forcing it.
  if (controller) announce(controller);
}

// ---------------------------------------------------------------------------
// Network status
// ---------------------------------------------------------------------------

/** @param {boolean} force Emit even when unchanged (initial state). */
function emitNetState(force) {
  const online = isOnline();
  if (!force && online === lastOnline) return;
  lastOnline = online;
  bus.emit('net:change', { online });
}

function watchNetwork() {
  window.addEventListener('online', () => {
    emitNetState(false);
    void runUpdateCheck();
  });
  window.addEventListener('offline', () => emitNetState(false));
  emitNetState(true);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the service worker client: network status events, worker
 * registration (after the page has loaded), update checks on launch and on
 * return to the app. Idempotent; never throws.
 * @returns {void}
 */
export function initServiceWorker() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;
  try {
    watchNetwork();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[sw-client] Network status unavailable.', err);
  }
  if (!isSupported()) return;

  const container = navigator.serviceWorker;
  hadController = Boolean(container.controller);
  container.addEventListener('controllerchange', onControllerChange);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void runUpdateCheck();
  });

  registering = (async () => {
    await whenLoaded();
    const { script, scope } = scriptUrls();
    try {
      const reg = await container.register(script, { scope, updateViaCache: 'none' });
      registration = reg;
      watchRegistration(reg);
      // A first install (or one register() just started) needs no extra check.
      if (!reg.installing) void runUpdateCheck({ force: true });
      return reg;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[sw-client] Service worker registration failed; the app still works online.', err);
      return null;
    } finally {
      registering = null;
    }
  })();
}

/**
 * Applies a downloaded update: tells the waiting worker to take over, then
 * the page reloads once (on `controllerchange`). If no worker is waiting
 * (for example another tab already applied it), reloads right away.
 * Resolves as soon as the request is sent; the reload follows.
 * @returns {Promise<void>}
 */
export async function applyUpdate() {
  const reg = await getRegistration();
  const waiting = reg && reg.waiting;
  if (!waiting) {
    reloadOnce();
    return;
  }
  updateRequested = true;
  waiting.addEventListener('statechange', () => {
    if (waiting.state === 'activated') setTimeout(reloadOnce, ACTIVATED_RELOAD_FALLBACK_MS);
  });
  waiting.postMessage({ type: 'SKIP_WAITING' });
}

/**
 * Waits until `worker` leaves the installing state.
 * @param {ServiceWorker} worker
 * @param {number} timeoutMs
 * @returns {Promise<'installed'|'redundant'|'timeout'>}
 */
function waitInstalled(worker, timeoutMs) {
  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @param {'installed'|'redundant'|'timeout'} result */
    const finish = (result) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', onState);
      resolve(result);
    };
    const onState = () => {
      if (worker.state === 'redundant') finish('redundant');
      else if (worker.state !== 'installing') finish('installed');
    };
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    worker.addEventListener('statechange', onState);
    onState();
  });
}

/**
 * Checks for a new version now (Settings → About → "Check for update").
 * Ignores the automatic-check throttle, asks the browser for a new `sw.js`
 * and, when one is found, waits (up to `timeoutMs`) for it to finish
 * installing. A ready update is (re)announced with `sw:update-ready`, so the
 * "Update available" banner shows. Reuses the registration and listeners set
 * up by {@link initServiceWorker}; never throws.
 * @param {{ timeoutMs?: number }} [options] timeoutMs: default 8000.
 * @returns {Promise<UpdateStatus>}
 *   'update-ready' (a new version is installed and waiting; banner shown),
 *   'up-to-date', 'offline', 'unsupported' (no service worker here),
 *   'error' (the check or the download failed), or — only when the download
 *   is still running after `timeoutMs` — 'downloading' (the banner shows
 *   by itself when it finishes).
 */
export async function checkForUpdate({ timeoutMs = MANUAL_CHECK_WAIT_MS } = {}) {
  try {
    const status = await runUpdateCheck({ force: true, reannounce: true });
    if (status !== 'downloading' && status !== 'update-ready') return status;
    const reg = await getRegistration();
    if (!reg) return 'error';
    // A newer version may be installing even while an older update waits: wait for the newest.
    const worker = reg.installing;
    if (!worker || !hasActiveWorker(reg)) return settled(reg);
    const outcome = await waitInstalled(worker, timeoutMs);
    if (outcome === 'installed') return settled(reg);
    if (reg.waiting && hasActiveWorker(reg)) return readyNow(reg);
    return outcome === 'timeout' ? 'downloading' : 'error';
  } catch (err) {
    console.warn('[sw-client] Manual update check failed.', err);
    return 'error';
  }
}

/**
 * Final status once nothing is installing any more.
 * @param {ServiceWorkerRegistration} reg
 * @returns {UpdateStatus}
 */
function settled(reg) {
  if (reg.waiting && hasActiveWorker(reg)) return readyNow(reg);
  return reg.installing && hasActiveWorker(reg) ? 'downloading' : 'up-to-date';
}

/**
 * Makes sure the waiting worker was announced (the normal flow usually did it already).
 * @param {ServiceWorkerRegistration} reg
 * @returns {'update-ready'}
 */
function readyNow(reg) {
  if (reg.waiting) announce(reg.waiting);
  return 'update-ready';
}

/**
 * Asks a worker for its version over a MessageChannel.
 * @param {ServiceWorker | null | undefined} worker
 * @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
function askVersion(worker, timeoutMs) {
  if (!worker || typeof MessageChannel !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    let done = false;
    /** @param {string | null} value */
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      const version = event.data && event.data.version;
      finish(typeof version === 'string' ? version : null);
    };
    try {
      worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

/**
 * Versions for Settings → About.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ app: string, sw: string | null, waiting: string | null }>}
 *   app: this page's files; sw: the worker serving the app (null without one);
 *   waiting: a downloaded update that is not applied yet (null when none).
 */
export async function getVersionInfo({ timeoutMs = VERSION_TIMEOUT_MS } = {}) {
  if (!isSupported()) return { app: APP_VERSION, sw: null, waiting: null };
  const reg = await getRegistration();
  const active = navigator.serviceWorker.controller || (reg && reg.active) || null;
  const [sw, waiting] = await Promise.all([
    askVersion(active, timeoutMs),
    askVersion(reg && reg.waiting, timeoutMs),
  ]);
  return { app: APP_VERSION, sw, waiting };
}
