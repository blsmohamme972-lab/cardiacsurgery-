/**
 * Hash router with lazily imported screen modules.
 *
 * URLs look like `index.html#/quiz/abc?x=1` (relative, so the app works under
 * any base path and inside Capacitor). A hash that does not start with `#/`
 * (e.g. a `#main` skip link) is treated as an in-page anchor and ignored.
 *
 * Screen module contract (default export):
 * ```js
 * export default {
 *   async render(ctx) // ctx: { params, query, path, fullPath, signal }
 *     → HTMLElement | { el, destroy?(), keepScroll? }
 * }
 * ```
 * On every navigation the router: tears down the previous screen (awaits a
 * returned promise, max 2 s, so pending saves flush before the next screen
 * reads data), lazily imports and renders the new screen, clears the mount,
 * mounts the new element, scrolls to top (or restores the position on
 * back/forward; `keepScroll: true` leaves it alone), moves focus to the first
 * `[autofocus]` element or `h1` (made `tabindex="-1"`), saves `lastRoute`
 * (except `/settings`), and emits `route:change`.
 *
 * Unknown routes go home. A failed import or render shows a friendly error
 * state with "Reload". If a newer navigation starts while an older screen is
 * still loading, the older result is discarded (and destroyed), never shown.
 *
 * @module core/router
 */

import { bus } from './events.js';
import { h, clear } from './dom.js';
import { setSetting } from './settings.js';
import { uid } from './util.js';

/** Paths that are not remembered as `lastRoute`. */
const NO_SAVE_PATHS = new Set(['/settings']);
/** Show a loading indicator only when a screen takes longer than this. */
const LOADING_DELAY_MS = 300;
/** Max time to wait for a screen's async `destroy()`. */
const DESTROY_TIMEOUT_MS = 2000;
/** Marker for history.state entries owned by the router. */
const STATE_MARK = 'cmcqRouter';

/**
 * @typedef {{ path: string, params: Record<string, string>, query: Record<string, string>,
 *   pattern: string | null, fullPath: string }} Route
 * @typedef {{ params: Record<string, string>, query: Record<string, string>, path: string,
 *   fullPath: string, signal: AbortSignal }} ScreenContext
 * @typedef {{ render(ctx: ScreenContext): (Node | { el: Node, destroy?: () => any, keepScroll?: boolean }
 *   | Promise<Node | { el: Node, destroy?: () => any, keepScroll?: boolean }>) }} Screen
 * @typedef {() => Promise<{ default?: Screen } | Screen>} Loader
 * @typedef {{ pattern: string, segs: string[], loader: Loader, statics: number }} CompiledRoute
 * @typedef {{ el: Node, destroy: (() => any) | null, keepScroll: boolean }} View
 * @typedef {{ destroy: (() => any) | null, controller: AbortController }} ActiveScreen
 */

let started = false;
/** @type {CompiledRoute[]} */
let table = [];
/** @type {HTMLElement | null} */
let mountEl = null;
/** @type {((route: Route, info: { ok: boolean, error?: unknown }) => void) | null} */
let onRouteCb = null;

/** Navigation sequence number; only the latest may mount. */
let seq = 0;
/** Token of the last navigation that mounted something (screen or error). */
let mountedToken = 0;
/** @type {ActiveScreen | null} */
let active = null;
/** @type {AbortController | null} */
let inflight = null;
/** @type {Route | null} */
let current = null;
/** Full path of the latest requested navigation (dedupes popstate + hashchange). */
let requested = '';
/** @type {Promise<void>} */
let pendingDestroy = Promise.resolve();
let firstRender = true;

/** History bookkeeping for back() and scroll restoration. */
let depth = 0;
let entryKey = '';
/** @type {Map<string, { x: number, y: number, main: number }>} */
const scrollPositions = new Map();

// ---------------------------------------------------------------------------
// Parsing and matching (pure)
// ---------------------------------------------------------------------------

/**
 * @param {string} s
 * @returns {string}
 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Parses `'/quiz/abc?x=1'`, `'#/quiz/abc'` or `'quiz/abc'`.
 * @param {string} input
 * @returns {{ path: string, segs: string[], query: Record<string, string>, fullPath: string }}
 */
function parse(input) {
  let s = String(input ?? '').trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.startsWith('!')) s = s.slice(1);
  const qi = s.indexOf('?');
  const pathPart = qi === -1 ? s : s.slice(0, qi);
  // Canonical form, so '/q/A B' and '/q/A%20B' (as location.hash reports it) are equal.
  const segs = pathPart
    .split('/')
    .filter(Boolean)
    .map((seg) => (seg.startsWith(':') ? seg : encodeURIComponent(safeDecode(seg))));
  const path = `/${segs.join('/')}`;
  const params = new URLSearchParams(qi === -1 ? '' : s.slice(qi + 1));
  /** @type {Record<string, string>} */
  const query = {};
  for (const [k, v] of params) query[k] = v;
  const queryString = params.toString();
  return { path, segs, query, fullPath: queryString ? `${path}?${queryString}` : path };
}

/**
 * Current route path from the address bar, or null for an in-page anchor hash.
 * @returns {string | null}
 */
function readLocation() {
  const raw = location.hash || '';
  if (raw === '' || raw === '#' || raw === '#!') return '/';
  if (raw.startsWith('#/') || raw.startsWith('#!/')) return raw;
  return null;
}

/**
 * @param {string} pattern
 * @param {Loader} loader
 * @returns {CompiledRoute}
 */
function compile(pattern, loader) {
  if (typeof loader !== 'function') throw new TypeError(`startRouter: route "${pattern}" needs a loader function`);
  const segs = parse(pattern).segs;
  return { pattern, segs, loader, statics: segs.filter((s) => !s.startsWith(':')).length };
}

/**
 * @param {ReturnType<typeof parse>} target
 * @returns {{ route: CompiledRoute, params: Record<string, string> } | null}
 */
function match(target) {
  outer: for (const route of table) {
    if (route.segs.length !== target.segs.length) continue;
    /** @type {Record<string, string>} */
    const params = {};
    for (let i = 0; i < route.segs.length; i++) {
      const p = route.segs[i];
      if (p.startsWith(':')) {
        const value = safeDecode(target.segs[i]);
        if (!value) continue outer;
        params[p.slice(1)] = value;
      } else if (p !== target.segs[i]) {
        continue outer;
      }
    }
    return { route, params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// History bookkeeping
// ---------------------------------------------------------------------------

/**
 * @param {number} d
 * @param {string} key
 */
function makeState(d, key) {
  return { [STATE_MARK]: true, depth: d, key };
}

/**
 * @param {any} st
 * @returns {boolean}
 */
function isOurState(st) {
  return Boolean(st && typeof st === 'object' && st[STATE_MARK] === true && typeof st.key === 'string');
}

/** @param {string} key */
function saveScroll(key) {
  if (!key) return;
  const se = document.scrollingElement || document.documentElement;
  scrollPositions.set(key, { x: se.scrollLeft, y: se.scrollTop, main: mountEl ? mountEl.scrollTop : 0 });
  if (scrollPositions.size > 100) scrollPositions.delete(scrollPositions.keys().next().value);
}

/**
 * @param {{ x: number, y: number, main: number } | null} pos
 */
function applyScroll(pos) {
  const x = pos?.x ?? 0;
  const y = pos?.y ?? 0;
  try {
    window.scrollTo({ left: x, top: y, behavior: /** @type {ScrollBehavior} */ ('instant') });
  } catch {
    window.scrollTo(x, y);
  }
  if (mountEl) mountEl.scrollTop = pos?.main ?? 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * @param {any} out
 * @returns {View | null}
 */
function normalizeView(out) {
  if (out instanceof Node) return { el: out, destroy: null, keepScroll: false };
  if (out && typeof out === 'object' && out.el instanceof Node) {
    return {
      el: out.el,
      destroy: typeof out.destroy === 'function' ? () => out.destroy() : null,
      keepScroll: Boolean(out.keepScroll),
    };
  }
  return null;
}

/**
 * @param {ActiveScreen} screen
 * @returns {Promise<void>}
 */
async function destroyScreen(screen) {
  try {
    screen.controller.abort();
  } catch {
    /* ignore */
  }
  if (!screen.destroy) return;
  try {
    const result = screen.destroy();
    if (result && typeof result.then === 'function') {
      await Promise.race([
        Promise.resolve(result).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[router] Screen destroy failed:', err);
        }),
        new Promise((r) => setTimeout(r, DESTROY_TIMEOUT_MS)),
      ]);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[router] Screen destroy failed:', err);
  }
}

/** True while the router (not e.g. an open sheet) made the mount inert. */
let routerMadeInert = false;

/** @param {boolean} busy */
function setBusy(busy) {
  if (!mountEl) return;
  mountEl.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (!('inert' in mountEl)) return;
  const el = /** @type {HTMLElement & { inert: boolean }} */ (mountEl);
  // Stop taps on a torn-down screen while the next one loads. Only undo what
  // we did, so an open sheet's inert background is never clobbered.
  if (busy && !el.inert) {
    el.inert = true;
    routerMadeInert = true;
  } else if (!busy && routerMadeInert) {
    el.inert = false;
    routerMadeInert = false;
  }
}

/**
 * Moves focus for screen readers / keyboards: `[autofocus]`, else the first h1, else the mount.
 */
function moveFocus() {
  if (!mountEl) return;
  const auto = /** @type {HTMLElement | null} */ (mountEl.querySelector('[autofocus]'));
  const heading = /** @type {HTMLElement | null} */ (mountEl.querySelector('h1'));
  const target = auto || heading || mountEl;
  if (target !== auto && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus();
  }
}

/**
 * @param {number} token
 */
async function showLoading(token) {
  /** @type {Node | null} */
  let node = null;
  try {
    const ui = await import('../ui/components.js');
    if (typeof ui.spinner === 'function') node = ui.spinner({ label: 'Loading…' });
  } catch {
    /* fall back below */
  }
  if (token !== seq || mountedToken === token || !mountEl) return;
  node ??= h('p', { class: 'route-loading', role: 'status' }, 'Loading…');
  clear(mountEl);
  mountEl.append(
    h(
      'div',
      { class: 'route-loading-wrap', style: { display: 'grid', placeItems: 'center', minHeight: '40vh' } },
      node,
    ),
  );
}

/**
 * @param {Route} route
 * @param {{ ok: boolean, error?: unknown }} info
 */
function announce(route, info) {
  bus.emit('route:change', info.ok ? { ...route } : { ...route, error: true });
  if (onRouteCb) {
    try {
      onRouteCb({ ...route }, info);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[router] onRoute callback failed:', err);
    }
  }
}

/**
 * Friendly error state with Reload (and Try again / Go home where useful).
 * @param {Route} route
 * @param {'load' | 'render'} kind
 * @param {unknown} error
 * @param {number} token
 */
async function renderError(route, kind, error, token) {
  // eslint-disable-next-line no-console
  console.error(`[router] Could not ${kind === 'load' ? 'load' : 'show'} "${route.fullPath}":`, error);
  if (active) {
    const prev = active;
    active = null;
    pendingDestroy = destroyScreen(prev);
  }
  /** @type {any} */
  let ui = null;
  try {
    ui = await import('../ui/components.js');
  } catch {
    /* plain buttons below */
  }
  if (token !== seq || !mountEl) return;

  /**
   * @param {string} label
   * @param {'primary' | 'secondary'} variant
   * @param {() => void} onClick
   * @param {string} iconName
   */
  const makeButton = (label, variant, onClick, iconName) => {
    if (ui && typeof ui.button === 'function') {
      try {
        return ui.button({ label, variant, onClick, icon: iconName });
      } catch {
        /* fall through */
      }
    }
    return h('button', { type: 'button', class: ['btn', `btn-${variant}`], onClick }, label);
  };

  const isHome = route.path === '/';
  const title = kind === 'load' ? "This screen couldn't load" : 'Something went wrong';
  const message =
    kind === 'load'
      ? 'Please reload the app. Your progress is safe.'
      : 'Please try again. Your progress is safe.';
  const actions = [makeButton('Reload', 'primary', () => location.reload(), 'refresh')];
  if (kind === 'render') {
    actions.push(makeButton('Try again', 'secondary', () => navigate(route.fullPath, { replace: true }), 'undo'));
  }
  if (!isHome) actions.push(makeButton('Go home', 'secondary', () => navigate('/'), 'home'));

  const view = h(
    'section',
    {
      class: 'route-error',
      role: 'alert',
      style: { textAlign: 'center', padding: '48px 16px', maxWidth: '36rem', margin: '0 auto' },
    },
    h('h1', { tabindex: '-1' }, title),
    h('p', {}, message),
    h(
      'div',
      {
        class: 'route-error-actions',
        style: { display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap', marginTop: '24px' },
      },
      actions,
    ),
  );

  clear(mountEl);
  mountEl.append(view);
  mountedToken = token;
  inflight = null;
  active = null;
  current = route;
  setBusy(false);
  applyScroll(null);
  moveFocus();
  firstRender = false;
  try {
    const shell = await import('../ui/shell.js');
    if (token === seq) shell.setHeader?.({ title: 'KirKlin', back: isHome ? null : true });
  } catch {
    /* header is cosmetic here */
  }
  announce(route, { ok: false, error });
}

/**
 * Handles one navigation. Only the newest navigation may mount.
 * @param {string} input
 * @param {{ restoreScroll?: boolean }} [opts]
 */
async function handle(input, { restoreScroll = false } = {}) {
  if (!mountEl) return;
  const target = parse(input);
  const token = ++seq;
  requested = target.fullPath;

  const found = match(target);
  if (!found) {
    if (target.path !== '/') {
      navigate('/', { replace: true });
      return;
    }
  }
  /** @type {Route} */
  const route = {
    path: target.path,
    params: found ? found.params : {},
    query: target.query,
    pattern: found ? found.route.pattern : null,
    fullPath: target.fullPath,
  };
  if (!found) {
    await renderError(route, 'load', new Error('No route is registered for "/"'), token);
    return;
  }

  if (inflight) {
    try {
      inflight.abort();
    } catch {
      /* ignore */
    }
  }
  const controller = new AbortController();
  inflight = controller;

  setBusy(true);
  const loadingTimer = setTimeout(() => {
    if (token === seq && mountedToken !== token) void showLoading(token);
  }, LOADING_DELAY_MS);

  try {
    // 1. Tear down the current screen exactly once, and let any teardown finish.
    if (active) {
      const prev = active;
      active = null;
      pendingDestroy = destroyScreen(prev);
    }
    await pendingDestroy;
    if (token !== seq) return;

    // 2. Load the screen module.
    /** @type {any} */
    let mod;
    try {
      mod = await found.route.loader();
    } catch (err) {
      if (token === seq) await renderError(route, 'load', err, token);
      return;
    }
    if (token !== seq) return;
    /** @type {Screen | undefined} */
    const screen = mod && (mod.default ?? mod);
    if (!screen || typeof screen.render !== 'function') {
      await renderError(route, 'load', new TypeError(`Screen for "${route.pattern}" has no render()`), token);
      return;
    }

    // 3. Render.
    /** @type {View | null} */
    let view;
    try {
      const out = await screen.render({
        params: { ...route.params },
        query: { ...route.query },
        path: route.path,
        fullPath: route.fullPath,
        signal: controller.signal,
      });
      view = normalizeView(out);
      if (!view) throw new TypeError(`Screen for "${route.pattern}" returned no element`);
    } catch (err) {
      if (token !== seq) return;
      await renderError(route, 'render', err, token);
      return;
    }
    if (token !== seq) {
      // Superseded while rendering: discard without ever showing it.
      void destroyScreen({ destroy: view.destroy, controller });
      return;
    }

    // 4. Mount.
    clear(mountEl);
    mountEl.append(view.el);
    mountedToken = token;
    inflight = null;
    active = { destroy: view.destroy, controller };
    current = route;
    setBusy(false);

    if (restoreScroll && scrollPositions.has(entryKey)) {
      const pos = scrollPositions.get(entryKey) ?? null;
      requestAnimationFrame(() => {
        if (token === seq) applyScroll(pos);
      });
    } else if (!view.keepScroll) {
      applyScroll(null);
    }
    if (!firstRender) moveFocus();
    firstRender = false;

    if (!NO_SAVE_PATHS.has(route.path)) {
      setSetting('lastRoute', route.fullPath).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[router] Could not remember the last screen:', err);
      });
    }
    announce(route, { ok: true });
  } finally {
    clearTimeout(loadingTimer);
    if (token === seq && mountedToken === token) setBusy(false);
  }
}

/**
 * popstate / hashchange: back, forward, typed URLs and plain `<a href="#/...">` links.
 * @param {PopStateEvent | HashChangeEvent} event
 */
function onLocationChange(event) {
  const raw = readLocation();
  if (raw === null) return; // In-page anchor such as a skip link.
  const target = parse(raw);
  const st = event.type === 'popstate' ? /** @type {PopStateEvent} */ (event).state : history.state;
  if (target.fullPath === requested) {
    // Same screen (e.g. a sheet's own history entry, or the hashchange after a popstate).
    if (isOurState(st)) {
      depth = st.depth;
      entryKey = st.key;
    }
    return;
  }
  saveScroll(entryKey);
  let restore = false;
  if (isOurState(st)) {
    depth = st.depth;
    entryKey = st.key;
    restore = true;
  } else {
    // A new entry the browser created (typed URL or plain link).
    depth += 1;
    entryKey = uid();
    try {
      history.replaceState(makeState(depth, entryKey), '');
    } catch {
      /* ignore */
    }
  }
  void handle(raw, { restoreScroll: restore });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Starts the router and renders the current location. Call once.
 * @param {{
 *   routes: Record<string, Loader>,
 *   mount?: HTMLElement | string,
 *   onRoute?: (route: Route, info: { ok: boolean, error?: unknown }) => void,
 * }} options `routes` maps patterns (`'/chapter/:id'`) to lazy loaders
 *   (`() => import('./screens/chapter.js')`). `mount` defaults to `#main`.
 *   `onRoute` runs after every navigation (also for error states, with `ok: false`).
 * @returns {void}
 */
export function startRouter({ routes, mount, onRoute } = /** @type {any} */ ({})) {
  if (started) {
    // eslint-disable-next-line no-console
    console.warn('[router] startRouter() called twice; ignored.');
    return;
  }
  if (!routes || typeof routes !== 'object') throw new TypeError('startRouter: routes are required');
  const el = typeof mount === 'string' ? document.querySelector(mount) : mount ?? document.getElementById('main');
  if (!(el instanceof HTMLElement)) throw new Error('startRouter: mount element not found');

  started = true;
  mountEl = el;
  onRouteCb = typeof onRoute === 'function' ? onRoute : null;
  // Most specific first: more static segments win over params.
  table = Object.entries(routes)
    .map(([pattern, loader]) => compile(pattern, loader))
    .sort((a, b) => b.statics - a.statics);

  try {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  } catch {
    /* ignore */
  }
  const st = history.state;
  if (isOurState(st)) {
    depth = st.depth;
    entryKey = st.key;
  } else {
    depth = 0;
    entryKey = uid();
    try {
      history.replaceState(makeState(depth, entryKey), '');
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('popstate', onLocationChange);
  window.addEventListener('hashchange', onLocationChange);
  void handle(readLocation() ?? '/');
}

/**
 * Navigates to an app path such as `'/quiz/abc?x=1'` (a leading `#` is fine).
 * Navigating to the current path re-renders it without adding history.
 * @param {string} path
 * @param {{ replace?: boolean, silent?: boolean }} [options]
 *   `replace`: replace the current history entry instead of pushing.
 *   `silent`: only update the URL (no re-render), e.g. to reflect a search query.
 * @returns {void}
 */
export function navigate(path, { replace = false, silent = false } = {}) {
  const target = parse(path);
  const url = `#${target.fullPath}`;
  if (!started) {
    try {
      history.replaceState(history.state, '', url);
    } catch {
      location.hash = target.fullPath;
    }
    return;
  }
  const sameEntry = current !== null && target.fullPath === current.fullPath;
  try {
    if (replace || sameEntry) {
      scrollPositions.delete(entryKey);
      history.replaceState(makeState(depth, entryKey), '', url);
    } else {
      saveScroll(entryKey);
      depth += 1;
      entryKey = uid();
      history.pushState(makeState(depth, entryKey), '', url);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[router] History update failed:', err);
  }
  if (silent) {
    requested = target.fullPath;
    const found = match(target);
    if (found) {
      current = {
        path: target.path,
        params: found.params,
        query: target.query,
        pattern: found.route.pattern,
        fullPath: target.fullPath,
      };
    }
    return;
  }
  void handle(target.fullPath);
}

/**
 * Goes back in app history, or to `fallback` (replacing) when there is none
 * (e.g. the app was opened directly on this screen).
 * @param {string} [fallback]
 * @returns {void}
 */
export function back(fallback = '/') {
  if (started && depth > 0) history.back();
  else navigate(fallback, { replace: true });
}

/**
 * The current route (the last one rendered, or the address bar before the first render).
 * @returns {Route}
 */
export function currentRoute() {
  if (current) return { ...current, params: { ...current.params }, query: { ...current.query } };
  const raw = typeof location !== 'undefined' ? readLocation() ?? '/' : '/';
  const target = parse(raw);
  const found = table.length ? match(target) : null;
  return {
    path: target.path,
    params: found ? found.params : {},
    query: target.query,
    pattern: found ? found.route.pattern : null,
    fullPath: target.fullPath,
  };
}

/**
 * An `href` for an app path: `href('/q/CPB-0001')` → `'#/q/CPB-0001'`.
 * @param {string} path
 * @returns {string}
 */
export function href(path) {
  return `#${parse(path).fullPath}`;
}
