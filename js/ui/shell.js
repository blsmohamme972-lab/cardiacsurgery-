/**
 * App shell controller (docs/ARCHITECTURE.md §6.4).
 *
 * Owns the persistent chrome around the screens:
 * - the sticky header (`#app-header`): back button, title/subtitle, actions;
 * - the tab bar (`#tabbar`): bottom bar on phones, side rail ≥ 700px;
 * - banners (`#banner-slot`): update available, offline, reload needed;
 * - reactions to bus events: `route:change`, `sw:update-ready`, `net:change`,
 *   `db:versionchange`, `storage:error`.
 *
 * Styles: css/shell.css (layout, brand mark, banner tints) and
 * css/components.css (banner base).
 * Importing this module has no side effects.
 *
 * @module ui/shell
 */

import { h, clear } from '../core/dom.js';
import { bus } from '../core/events.js';
import { navigate, back as routerBack } from '../core/router.js';
import { icon } from './icons.js';
import { button, iconButton, toast } from './components.js';

const APP_NAME = 'KirKlin';

/** Tab bar entries (paths match the router). */
const TABS = Object.freeze([
  { path: '/', label: 'Home', icon: 'home' },
  { path: '/library', label: 'Library', icon: 'library' },
  { path: '/book', label: 'Book', icon: 'book' },
  { path: '/stats', label: 'Stats', icon: 'stats' },
  { path: '/search', label: 'Search', icon: 'search' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
]);

/** Default banner icon per kind. */
const KIND_ICON = Object.freeze({
  info: 'info',
  success: 'check',
  warning: 'alert',
  danger: 'alert',
  neutral: 'info',
  update: 'sparkles',
});

/** If an update has not reloaded the app after this long, tell the user. */
const UPDATE_STALL_MS = 12000;
/** Minimum gap between two storage error toasts. */
const STORAGE_TOAST_GAP_MS = 5000;

/**
 * @typedef {object} ShellEls
 * @property {HTMLElement} header
 * @property {HTMLElement} tabbar
 * @property {HTMLElement} banners
 * @property {HTMLElement} main
 * @property {HTMLElement} start  Header slot for the back button.
 * @property {HTMLElement} titles Header slot for title + subtitle.
 * @property {HTMLElement} actions Header slot for action buttons.
 */

/** @type {ShellEls | null} */
let els = null;
let initialized = false;
/** @type {Map<string, HTMLElement>} */
const banners = new Map();
/** Path (without query) of the screen that hid the tab bar. */
let tabBarHiddenFor = /** @type {string | null} */ (null);
let offlineDismissed = false;
let lastStorageToast = 0;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Returns the element with `id`, creating it (with `tag`) when missing so the
 * shell also works on a bare page (tests, error recovery).
 * @param {string} id
 * @param {string} tag
 * @param {Record<string, string>} [attrs]
 * @returns {HTMLElement}
 */
function ensureEl(id, tag, attrs = {}) {
  let el = document.getElementById(id);
  if (!el) {
    el = h(tag, { id, ...attrs });
    document.body.append(el);
  }
  return el;
}

/** @returns {string} The current route path (no query), e.g. `/quiz/abc`. */
function currentPath() {
  const raw = location.hash.replace(/^#!?/, '');
  if (!raw.startsWith('/')) return '/';
  const path = raw.split('?')[0].split('#')[0];
  return path.replace(/\/+$/, '') || '/';
}

/**
 * Which tab a route belongs to; `null` keeps the current tab (e.g. a question
 * opened from Search stays under Search).
 * @param {string} path
 * @returns {string | null}
 */
function tabForPath(path) {
  const first = `/${(path || '/').split('/').filter(Boolean)[0] ?? ''}`;
  switch (first) {
    case '/library':
      return '/library';
    case '/book':
      return '/book';
    case '/stats':
      return '/stats';
    case '/search':
      return '/search';
    case '/settings':
    case '/reviewer':
      return '/settings';
    case '/q':
      return null;
    default:
      return '/';
  }
}

/**
 * Text of a string-or-node value (for document.title).
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof Node !== 'undefined' && value instanceof Node) return (value.textContent || '').trim();
  return '';
}

/** @returns {boolean} */
function prefersReducedMotion() {
  const v = document.documentElement.dataset.reduceMotion;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Shows a busy state on a button (spinner + label) and returns a restore function.
 * @param {HTMLButtonElement} btn
 * @param {string} label
 * @returns {() => void}
 */
function setButtonBusy(btn, label) {
  const before = [...btn.childNodes];
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.replaceChildren(h('span', { class: 'spinner-ring', 'aria-hidden': 'true' }), h('span', { class: 'btn-label' }, label));
  return () => {
    if (!btn.isConnected) return;
    btn.replaceChildren(...before);
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  };
}

/**
 * The brand badge: the white heart mark (with its ECG cut) on the crimson
 * tile. Purely decorative; drawn by CSS (css/shell.css `.brand-badge`).
 * @param {string} className Extra class for size/placement.
 * @returns {HTMLElement}
 */
function brandBadge(className) {
  return h('span', { class: `${className} brand-badge`, 'aria-hidden': 'true' }, h('span', { class: 'brand-mark' }));
}

/**
 * The app name as a wordmark: the second capital starts the accent
 * ("Kir" + "Klin"). Its text content stays exactly the app name.
 * @param {string} className
 * @returns {HTMLElement}
 */
function wordmark(className) {
  const m = /^(.[^A-Z]*)([A-Z].*)$/.exec(APP_NAME);
  return m
    ? h('span', { class: className }, m[1], h('span', { class: 'wordmark-accent' }, m[2]))
    : h('span', { class: className }, APP_NAME);
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

/** @returns {ShellEls} */
function ensure() {
  if (els) return els;
  const header = ensureEl('app-header', 'header');
  const tabbar = ensureEl('tabbar', 'nav', { 'aria-label': 'Main' });
  const bannerSlot = ensureEl('banner-slot', 'div');
  const main = ensureEl('main', 'main', { tabindex: '-1' });
  ensureEl('toast-slot', 'div', { 'aria-live': 'polite' });
  ensureEl('sheet-slot', 'div');

  header.classList.add('app-header');
  tabbar.classList.add('tabbar');
  bannerSlot.classList.add('banner-slot');
  if (!bannerSlot.hasAttribute('aria-live')) bannerSlot.setAttribute('aria-live', 'polite');

  const start = h('div', { class: 'hdr-start' });
  const titles = h('div', { class: 'hdr-titles' });
  const actions = h('div', { class: 'hdr-actions' });
  clear(header);
  header.append(h('div', { class: 'hdr' }, start, titles, actions));

  els = { header, tabbar, banners: bannerSlot, main, start, titles, actions };
  return els;
}

/** Fills tab icons (and builds the tabs when index.html has none). */
function setupTabbar() {
  const { tabbar } = ensure();
  let links = /** @type {HTMLAnchorElement[]} */ ([...tabbar.querySelectorAll('a[data-route]')]);
  if (links.length === 0) {
    links = TABS.map(
      (t) =>
        /** @type {HTMLAnchorElement} */ (
          h(
            'a',
            { class: 'tab', href: `#${t.path}`, 'data-route': t.path, 'data-icon': t.icon },
            h('span', { class: 'tab-icon', 'aria-hidden': 'true' }),
            h('span', { class: 'tab-label' }, t.label),
          )
        ),
    );
    tabbar.append(...links);
  }
  for (const link of links) {
    const slot = link.querySelector('.tab-icon');
    const name = link.dataset.icon || TABS.find((t) => t.path === link.dataset.route)?.icon || 'home';
    if (slot && !slot.querySelector('svg')) slot.append(icon(name, { size: 24 }));
    link.addEventListener('click', onTabClick);
  }
  if (!tabbar.querySelector('.rail-brand')) {
    tabbar.prepend(h('div', { class: 'rail-brand', 'aria-hidden': 'true' }, brandBadge('rail-logo'), wordmark('rail-brand-name')));
  }
}

/**
 * Tapping the active tab again scrolls to the top (like native apps).
 * @param {MouseEvent} e
 */
function onTabClick(e) {
  const link = /** @type {HTMLAnchorElement} */ (e.currentTarget);
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (link.dataset.route === currentPath()) {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    els?.main.focus({ preventScroll: true });
  }
}

/**
 * Marks the tab for `path` as current (`aria-current="page"`).
 * @param {string} path
 */
function setActiveTab(path) {
  const tab = tabForPath(path);
  if (tab === null || !els) return;
  for (const link of els.tabbar.querySelectorAll('a[data-route]')) {
    if (/** @type {HTMLElement} */ (link).dataset.route === tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/** Hairline under the header once the page scrolls. */
function watchScroll() {
  let ticking = false;
  const update = () => {
    ticking = false;
    els?.header.classList.toggle('is-scrolled', window.scrollY > 2);
  };
  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    },
    { passive: true },
  );
  update();
}

/** Wires the "Skip to content" button from index.html. */
function setupSkipLink() {
  const skip = document.querySelector('.skip-link');
  if (!skip) return;
  skip.addEventListener('click', (e) => {
    e.preventDefault();
    const target = els?.main.querySelector('h1') ?? els?.main;
    if (target instanceof HTMLElement) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Bus reactions                                                       */
/* ------------------------------------------------------------------ */

function showUpdateBanner() {
  if (banners.has('update')) return;
  const later = button({ label: 'Later', variant: 'ghost', size: 's', onClick: () => hideBanner('update') });
  const update = button({ label: 'Update', variant: 'primary', size: 's' });
  update.addEventListener('click', async () => {
    const restore = setButtonBusy(update, 'Updating…');
    later.disabled = true;
    const stall = setTimeout(() => {
      restore();
      later.disabled = false;
      toast('The update is taking a while. Close and reopen the app to finish it.', { duration: 8000 });
    }, UPDATE_STALL_MS);
    try {
      const mod = await import('../core/sw-client.js');
      if (typeof mod.applyUpdate === 'function') {
        await mod.applyUpdate();
      } else {
        location.reload();
      }
    } catch (err) {
      clearTimeout(stall);
      // eslint-disable-next-line no-console
      console.error('[shell] Update failed', err);
      restore();
      later.disabled = false;
      toast("Couldn't update right now. Please try again later.", { kind: 'danger' });
    }
  });
  showBanner('update', {
    text: h('span', {}, h('strong', {}, 'Update available'), h('span', { class: 'banner-sub' }, 'Your progress is kept.')),
    kind: 'update',
    actions: [later, update],
    dismissible: false,
  });
}

/** @param {boolean} online */
function onNetChange(online) {
  if (online) {
    offlineDismissed = false;
    hideBanner('offline');
    return;
  }
  if (banners.has('offline') || offlineDismissed) return;
  showBanner('offline', {
    text: 'Offline — everything still works',
    kind: 'neutral',
    icon: 'wifi-off',
    dismissible: true,
    onDismiss: () => {
      offlineDismissed = true;
    },
  });
}

function onDbVersionChange() {
  showBanner('reload', {
    text: h(
      'span',
      {},
      h('strong', {}, 'Please reload'),
      h('span', { class: 'banner-sub' }, 'A newer version was opened. Reload to keep saving your progress.'),
    ),
    kind: 'warning',
    actions: [button({ label: 'Reload', variant: 'primary', size: 's', onClick: () => location.reload() })],
    dismissible: false,
  });
}

/** @param {{ name?: string, message?: string } | undefined} payload */
function onStorageError(payload) {
  const now = Date.now();
  if (now - lastStorageToast < STORAGE_TOAST_GAP_MS) return;
  lastStorageToast = now;
  const name = payload?.name || '';
  const full = name === 'QuotaExceededError' || /quota|space|full/i.test(payload?.message || '');
  toast(
    full
      ? 'Storage is full, so changes may not save. Free up space on this device, or delete voice notes or images.'
      : "Couldn't save your last change. Please try again.",
    { kind: 'danger', duration: 8000 },
  );
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Wires the header, tab bar, slots and banners. Call once at startup (after
 * settings are applied, before the router starts). Safe to call again.
 * @returns {void}
 */
export function initShell() {
  if (initialized) return;
  initialized = true;
  const { header } = ensure();
  setupTabbar();
  setupSkipLink();
  setHeader({});
  watchScroll();

  setActiveTab(currentPath());
  // Instant tab feedback, before the next screen has loaded.
  window.addEventListener('hashchange', () => setActiveTab(currentPath()));

  bus.on('route:change', (route) => {
    const path = typeof route?.path === 'string' ? route.path : currentPath();
    setActiveTab(path);
    // Safety net: a screen that hid the tab bar and was left without restoring it.
    if (tabBarHiddenFor !== null && tabBarHiddenFor !== path) setTabBarVisible(true);
    header.classList.toggle('is-scrolled', window.scrollY > 2);
  });
  bus.on('sw:update-ready', () => showUpdateBanner());
  bus.on('net:change', (p) => onNetChange(typeof p?.online === 'boolean' ? p.online : navigator.onLine !== false));
  bus.on('db:versionchange', () => onDbVersionChange());
  bus.on('storage:error', (p) => onStorageError(p));

  if (navigator.onLine === false) onNetChange(false);
}

/**
 * Sets the header for the current screen. Call from each screen's `render()`.
 *
 * Without a title the header shows the app name and logo.
 *
 * @param {object} [opts]
 * @param {string | Node} [opts.title]
 * @param {string | true | null} [opts.back] A path (navigates there), `true`
 *   (goes back in history, or home when there is none) or `null` (no back button).
 * @param {Node[]} [opts.actions] Buttons on the right, e.g. `iconButton()`s.
 * @param {string | Node} [opts.subtitle] Small line under the title.
 * @returns {void}
 */
export function setHeader({ title, back, actions, subtitle } = {}) {
  const e = ensure();
  clear(e.start);
  clear(e.titles);
  clear(e.actions);

  if (back) {
    const backBtn = iconButton({
      icon: 'chevron-left',
      label: 'Back',
      onClick: () => {
        if (typeof back === 'string') navigate(back);
        else routerBack();
      },
    });
    backBtn.classList.add('hdr-back');
    e.start.append(backBtn);
  }
  e.header.classList.toggle('has-back', Boolean(back));

  const hasTitle = title !== undefined && title !== null && title !== '';
  if (hasTitle) {
    e.titles.append(h('div', { class: 'hdr-title' }, title));
    if (subtitle) e.titles.append(h('div', { class: 'hdr-subtitle' }, subtitle));
  } else {
    e.titles.append(h('div', { class: 'hdr-brand' }, brandBadge('hdr-logo'), wordmark('hdr-brand-name')));
  }
  e.header.classList.toggle('is-brand', !hasTitle);

  const list = (actions || []).filter(Boolean);
  if (list.length) e.actions.append(...list);

  const t = textOf(title);
  document.title = t && t !== APP_NAME ? `${t} · ${APP_NAME}` : APP_NAME;
}

/**
 * Shows (or replaces) a banner under the header.
 *
 * @param {string} id Stable id; showing the same id again replaces it in place.
 * @param {object} opts
 * @param {string | Node} opts.text
 * @param {'info'|'success'|'warning'|'danger'|'neutral'|'update'} [opts.kind='info']
 * @param {(Node | { label: string, onClick: () => void, variant?: string })[]} [opts.actions]
 *   Buttons (nodes) or `{label, onClick}` descriptions.
 * @param {boolean} [opts.dismissible=true] Shows a close button.
 * @param {string} [opts.icon] Icon name (defaults by kind).
 * @param {() => void} [opts.onDismiss] Called when the user closes it.
 * @returns {void}
 */
export function showBanner(id, { text, kind = 'info', actions, dismissible = true, icon: iconName, onDismiss } = /** @type {any} */ ({})) {
  const e = ensure();
  const actionNodes = (actions || []).filter(Boolean).map((a) => {
    if (typeof Node !== 'undefined' && a instanceof Node) return a;
    const desc = /** @type {{ label: string, onClick: () => void, variant?: any }} */ (a);
    return button({ label: desc.label, variant: desc.variant || 'secondary', size: 's', onClick: desc.onClick });
  });

  const closeBtn = dismissible
    ? iconButton({
        icon: 'close',
        label: 'Dismiss',
        onClick: () => {
          hideBanner(id);
          try {
            onDismiss?.();
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[shell] onDismiss failed', err);
          }
        },
      })
    : null;
  closeBtn?.classList.add('banner-close');

  const node = h(
    'div',
    {
      class: `banner banner-${kind}`,
      'data-banner': id,
      role: kind === 'warning' || kind === 'danger' ? 'alert' : undefined,
    },
    h('span', { class: 'banner-icon', 'aria-hidden': 'true' }, icon(iconName || KIND_ICON[kind] || 'info', { size: 18 })),
    h('div', { class: 'banner-text' }, text ?? ''),
    actionNodes.length ? h('div', { class: 'banner-actions' }, ...actionNodes) : null,
    closeBtn,
  );

  const existing = banners.get(id);
  if (existing && existing.isConnected && !existing.classList.contains('is-leaving')) {
    node.style.animation = 'none';
    existing.replaceWith(node);
  } else {
    existing?.remove();
    e.banners.append(node);
  }
  banners.set(id, node);
}

/**
 * Removes a banner (no-op when it is not shown).
 * @param {string} id
 * @returns {void}
 */
export function hideBanner(id) {
  const node = banners.get(id);
  if (!node) return;
  banners.delete(id);
  // If focus was inside, keep it somewhere sensible.
  const hadFocus = node.contains(document.activeElement);
  if (prefersReducedMotion()) {
    node.remove();
  } else {
    node.classList.add('is-leaving');
    const done = () => node.remove();
    node.addEventListener('animationend', done, { once: true });
    setTimeout(done, 400);
  }
  if (hadFocus) els?.main.focus({ preventScroll: true });
}

/**
 * Shows or hides the tab bar / side rail (the player hides it for focus).
 * It comes back automatically when the user leaves the screen that hid it.
 * @param {boolean} visible
 * @returns {void}
 */
export function setTabBarVisible(visible) {
  const e = ensure();
  const show = visible !== false;
  document.documentElement.dataset.tabbar = show ? 'shown' : 'hidden';
  e.tabbar.inert = !show;
  tabBarHiddenFor = show ? null : currentPath();
}
