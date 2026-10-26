/**
 * App bootstrap (entry module, loaded by index.html).
 *
 * Order: settings (opens the database) → shell → resume check → router
 * (first screen) → service worker → remove boot splash → first-run tour →
 * quiet persistent-storage request.
 *
 * Also installs global error handlers (friendly toast, the shell never
 * crashes) and turns browser online/offline events into `net:change`.
 *
 * Shell, service-worker client and tour are imported dynamically (started in
 * parallel right away) so a failure in one of them shows a friendly
 * "Reload" screen instead of a blank page.
 *
 * @module app
 */

import { bus } from './core/events.js';
import { h } from './core/dom.js';
import { initSettings, getSetting, setSetting } from './core/settings.js';
import { startRouter, navigate } from './core/router.js';
import { sessionsRepo } from './core/store/repo.js';
import { DAY_MS } from './core/util.js';

/**
 * Route table (docs/ARCHITECTURE.md §5.4). Screens load on first visit.
 * @type {Readonly<Record<string, () => Promise<any>>>}
 */
export const ROUTES = Object.freeze({
  '/': () => import('./screens/home.js'),
  '/chapter/:id': () => import('./screens/chapter.js'),
  '/new': () => import('./screens/builder.js'),
  '/quiz/:id': () => import('./screens/player.js'),
  '/results/:id': () => import('./screens/results.js'),
  '/q/:qid': () => import('./screens/question.js'),
  '/library': () => import('./screens/library.js'),
  '/stats': () => import('./screens/stats.js'),
  '/search': () => import('./screens/search.js'),
  '/settings': () => import('./screens/settings.js'),
  '/reviewer': () => import('./screens/reviewer.js'),
});

/** Remove the splash even if the first screen never reports back. */
const SPLASH_FAILSAFE_MS = 10000;
/** Don't let a slow database delay the first screen for the resume check. */
const RESUME_CHECK_TIMEOUT_MS = 2000;
/** Ask for persistent storage again at most this often (until granted). */
const PERSIST_RETRY_MS = 7 * DAY_MS;
/** Wait after the first screen before low-priority work. */
const IDLE_DELAY_MS = 2500;

// ---------------------------------------------------------------------------
// Global error handling
// ---------------------------------------------------------------------------

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const LOAD_ERROR = "Part of the app didn't load. Please reload.";
const MODULE_LOAD_RE = /dynamically imported module|importing a module script failed|error loading dynamically|failed to fetch/i;
const IGNORED_RE = /ResizeObserver loop|^Script error\.?$/i;

let lastToastAt = 0;
let lastToastText = '';

/**
 * @param {any} err
 * @returns {boolean}
 */
function isIgnorable(err) {
  if (!err) return true;
  if (err.name === 'AbortError') return true; // user cancelled (share sheet, navigation)
  return IGNORED_RE.test(String(err.message ?? err));
}

/**
 * Plain-language message for an unexpected error.
 * @param {any} err
 * @returns {{ text: string, reload: boolean }}
 */
function friendly(err) {
  if (err && typeof err.userMessage === 'string' && err.userMessage) return { text: err.userMessage, reload: false };
  const isDomException = typeof DOMException !== 'undefined' && err instanceof DOMException;
  if (err && !isDomException && /^(DataError|BackupError|StorageError)$/.test(err.name) && err.message) {
    return { text: String(err.message), reload: false };
  }
  if (MODULE_LOAD_RE.test(String(err?.message ?? ''))) return { text: LOAD_ERROR, reload: true };
  return { text: GENERIC_ERROR, reload: false };
}

/**
 * Logs an unexpected error and shows one calm toast (rate-limited).
 * @param {unknown} err
 * @param {string} source
 */
function reportError(err, source) {
  if (isIgnorable(err)) return;
  // eslint-disable-next-line no-console
  console.error(`[app] Unhandled ${source}:`, err);
  const { text, reload } = friendly(err);
  const now = Date.now();
  if (now - lastToastAt < 1500 || (text === lastToastText && now - lastToastAt < 8000)) return;
  lastToastAt = now;
  lastToastText = text;
  import('./ui/components.js')
    .then((ui) => {
      ui.toast(text, {
        kind: 'danger',
        action: reload ? { label: 'Reload', onClick: () => location.reload() } : undefined,
      });
    })
    .catch(() => {
      /* No toast available: the console entry above is all we can do. */
    });
}

function installGlobalErrorHandlers() {
  window.addEventListener('error', (event) => {
    // Resource load errors (img/script) don't bubble to window; this is a script error.
    reportError(event.error ?? new Error(event.message || 'Script error.'), 'error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault(); // we log it ourselves (with context)
    reportError(event.reason, 'promise rejection');
  });
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

/**
 * Starts a dynamic import now; resolves to the module, or null on failure (logged).
 * @param {() => Promise<any>} loader
 * @param {string} name
 * @returns {Promise<any | null>}
 */
function preload(loader, name) {
  return loader().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[app] Could not load ${name}:`, err);
    return null;
  });
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | undefined>}
 */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

/** @param {() => void} fn */
function whenIdle(fn) {
  const run = () => {
    try {
      fn();
    } catch (err) {
      reportError(err, 'idle task');
    }
  };
  setTimeout(() => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 });
    else run();
  }, IDLE_DELAY_MS);
}

/** Fades out and removes the boot splash (`#boot`). Idempotent. */
function removeSplash() {
  const el = document.getElementById('boot');
  document.body?.removeAttribute('aria-busy');
  if (!el || el.dataset.leaving === 'true') return;
  el.dataset.leaving = 'true';
  el.setAttribute('aria-hidden', 'true');
  const done = () => el.remove();
  if (document.documentElement.dataset.reduceMotion === 'true') {
    done();
    return;
  }
  el.style.transition = 'opacity 180ms ease-out';
  el.style.pointerEvents = 'none';
  el.style.opacity = '0';
  el.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 400);
}

/**
 * Last-resort screen when the app can't start.
 * @param {unknown} err
 */
function showFatal(err) {
  // eslint-disable-next-line no-console
  console.error('[app] Startup failed:', err);
  const message =
    err && typeof (/** @type {any} */ (err).userMessage) === 'string'
      ? /** @type {any} */ (err).userMessage
      : "Please reload. If this keeps happening, connect to the internet once so the app can finish updating. Your progress is stored on this device.";
  const view = h(
    'div',
    {
      class: 'boot-error',
      role: 'alert',
      style: {
        maxWidth: '28rem',
        margin: '0 auto',
        padding: 'calc(env(safe-area-inset-top, 0px) + 48px) 16px 48px',
        textAlign: 'center',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        lineHeight: '1.5',
      },
    },
    h('h1', { tabindex: '-1', style: { fontSize: '1.4rem', margin: '0 0 12px' } }, "The app couldn't start"),
    h('p', { style: { margin: '0 0 24px', opacity: '0.8' } }, message),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        style: {
          minHeight: '44px',
          minWidth: '120px',
          padding: '0 20px',
          borderRadius: '12px',
          border: '0',
          // Brand tokens; the fallbacks cover a page whose stylesheets did not load.
          background: 'var(--primary, #a6192e)',
          color: 'var(--primary-contrast, #fff)',
          fontSize: '1rem',
          fontWeight: '600',
        },
        onClick: () => location.reload(),
      },
      'Reload',
    ),
  );
  document.body?.removeAttribute('aria-busy');
  // Prefer the splash (it covers the page); else the main area.
  const boot = document.getElementById('boot');
  const host = boot && boot.dataset.leaving !== 'true' ? boot : document.getElementById('main') || document.body;
  host.replaceChildren(view);
  host.removeAttribute('aria-hidden');
  host.removeAttribute('inert');
  /** @type {HTMLElement | null} */ (view.querySelector('h1'))?.focus();
}

/**
 * On a cold launch at home, reopen the quiz the user was in (only when
 * `lastRoute` is `/quiz/<id>` and that session is still unfinished).
 * Runs before the router starts, so home never flashes first.
 * @param {string} launchHash `location.hash` at launch.
 */
async function resumeIfUnfinished(launchHash) {
  const atHome = launchHash === '' || launchHash === '#' || launchHash === '#/';
  if (!atHome) return;
  const last = getSetting('lastRoute');
  if (typeof last !== 'string') return;
  const m = /^\/quiz\/([^/?#]+)/.exec(last);
  if (!m) return;
  let id;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return;
  }
  try {
    const session = await withTimeout(sessionsRepo.get(id), RESUME_CHECK_TIMEOUT_MS);
    if (session && session.finishedAt == null) navigate(last, { replace: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[app] Resume check failed; starting at home.', err);
  }
}

/** Last online state announced on the bus (by us or by sw-client). */
let announcedOnline = /** @type {boolean | undefined} */ (undefined);

/** Records every `net:change`, so ours never duplicates one sw-client already sent. */
function trackNetState() {
  bus.on('net:change', (payload) => {
    if (payload && typeof payload.online === 'boolean') announcedOnline = payload.online;
  });
}

/** Turns browser online/offline events into `net:change` ({online}). */
function watchNetwork() {
  const announce = () => {
    const online = navigator.onLine !== false;
    if (announcedOnline === online) return;
    bus.emit('net:change', { online });
  };
  window.addEventListener('online', announce);
  window.addEventListener('offline', announce);
  if (navigator.onLine === false) announce();
}

/** Quietly asks the browser to keep our storage (no UI). Retries weekly until granted. */
async function requestPersistenceQuietly() {
  const storage = navigator.storage;
  if (!storage || typeof storage.persist !== 'function') return;
  try {
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return;
  } catch {
    /* ask anyway */
  }
  const lastAsked = getSetting('persistAskedAt');
  if (typeof lastAsked === 'number' && Date.now() - lastAsked < PERSIST_RETRY_MS) return;
  try {
    await storage.persist();
  } catch {
    /* not critical */
  }
  setSetting('persistAskedAt', Date.now()).catch(() => {});
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Starts the app.
 * @returns {Promise<void>}
 */
async function boot() {
  const launchHash = location.hash;

  // Fetch the big UI modules in parallel with opening the database.
  const shellReady = preload(() => import('./ui/shell.js'), 'the app shell');
  const swReady = preload(() => import('./core/sw-client.js'), 'the update checker');
  const tourReady = preload(() => import('./ui/tour.js'), 'the tour');

  await initSettings(); // never rejects; falls back to defaults

  const shell = await shellReady;
  if (!shell || typeof shell.initShell !== 'function') throw new Error('The app shell is missing.');
  shell.initShell();

  await resumeIfUnfinished(launchHash);

  const main = document.getElementById('main');
  if (!main) throw new Error('#main is missing from index.html.');

  let firstScreenShown = false;
  const failsafe = setTimeout(removeSplash, SPLASH_FAILSAFE_MS);
  startRouter({
    routes: ROUTES,
    mount: main,
    onRoute: () => {
      if (firstScreenShown) return;
      firstScreenShown = true;
      clearTimeout(failsafe);
      removeSplash();
      void afterFirstScreen(tourReady);
    },
  });

  trackNetState();
  const sw = await swReady;
  if (sw && typeof sw.initServiceWorker === 'function') {
    try {
      sw.initServiceWorker();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[app] Service worker setup failed:', err);
    }
  }
  watchNetwork();
}

/**
 * Work that waits for the first screen: tour, then low-priority tasks.
 * @param {Promise<any | null>} tourReady
 */
async function afterFirstScreen(tourReady) {
  try {
    const tour = await tourReady;
    if (tour && typeof tour.maybeShowTour === 'function') await tour.maybeShowTour();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[app] Tour failed:', err);
  }
  whenIdle(() => {
    void requestPersistenceQuietly();
  });
}

installGlobalErrorHandlers();
boot().catch(showFatal);
