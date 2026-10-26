/**
 * Reusable UI components (docs/ARCHITECTURE.md §6.3).
 *
 * Every component returns real DOM built with `h()`; no markup strings.
 * Styles live in css/components.css. Components that need a host element
 * (toasts, sheets) use `#toast-slot` / `#sheet-slot` from index.html and
 * create them on demand when missing.
 *
 * Importing this module has no side effects (no DOM access at import time).
 *
 * @module ui/components
 */

import { h, svg } from '../core/dom.js';
import { icon as makeIcon } from './icons.js';

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Joins truthy class names.
 * @param {...(string | false | null | undefined)} parts
 * @returns {string}
 */
function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

let idSeq = 0;
/**
 * Returns a document-unique id with the given prefix.
 * @param {string} prefix
 * @returns {string}
 */
function nextId(prefix) {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

/**
 * Turns an icon spec (name or Node) into a node.
 * @param {string | Node | null | undefined} spec
 * @param {number} size
 * @returns {Node | null}
 */
function iconNode(spec, size) {
  if (!spec) return null;
  if (typeof spec === 'string') return makeIcon(spec, { size });
  return spec;
}

/**
 * Clamps a percentage to an integer in 0..100 (NaN → 0).
 * @param {unknown} value
 * @returns {number}
 */
function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)));
}

/**
 * Returns the host element with this id, creating it when absent.
 * @param {string} id
 * @param {Record<string, string>} [attrs]
 * @returns {HTMLElement}
 */
function slot(id, attrs = {}) {
  let el = document.getElementById(id);
  if (!el) {
    el = h('div', { id, ...attrs });
    document.body.append(el);
  }
  return el;
}

/** @returns {boolean} Whether motion should be minimised right now. */
function reducedMotion() {
  const pref = document.documentElement.dataset.reduceMotion;
  if (pref === 'true') return true;
  if (pref === 'false') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Resolves after `el` finishes a transition or animation, or after `maxMs`
 * (whichever comes first). Never hangs, even when durations are 0.
 * @param {Element} el
 * @param {number} maxMs
 * @returns {Promise<void>}
 */
function afterMotion(el, maxMs) {
  if (reducedMotion() || maxMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('transitionend', onEnd);
      el.removeEventListener('animationend', onEnd);
      clearTimeout(timer);
      resolve();
    };
    /** @param {Event} e */
    const onEnd = (e) => {
      if (e.target === el) finish();
    };
    el.addEventListener('transitionend', onEnd);
    el.addEventListener('animationend', onEnd);
    const timer = setTimeout(finish, maxMs);
  });
}

/**
 * Pointer capture that never throws (it fails for pointers that already ended).
 * @param {Element} el
 * @param {number} pointerId
 */
function capturePointer(el, pointerId) {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* the gesture still works without capture */
  }
}

/** @returns {boolean} Phone layout (bottom sheets, bottom tab bar). */
function isPhoneLayout() {
  return typeof matchMedia === 'function' && matchMedia('(max-width: 699.98px)').matches;
}

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keyboard-focusable, visible elements inside `root`, in DOM order.
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
function focusablesIn(root) {
  return /** @type {HTMLElement[]} */ ([...root.querySelectorAll(FOCUSABLE)]).filter(
    (el) => !el.closest('[inert]') && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0),
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

/**
 * A text (and optional icon) button.
 *
 * @param {object} opts
 * @param {string | Node} [opts.label] Visible text. Omit for an icon-only button (then pass `ariaLabel`).
 * @param {string | Node} [opts.icon] Icon name (see ui/icons.js) or a node, shown before the label.
 * @param {'primary'|'secondary'|'ghost'|'danger'} [opts.variant='secondary']
 * @param {'s'|'m'|'l'} [opts.size='m'] All sizes keep a 44px touch target.
 * @param {(e: MouseEvent) => void} [opts.onClick]
 * @param {string} [opts.ariaLabel] Accessible name when it should differ from the label.
 * @param {boolean} [opts.disabled]
 * @param {'button'|'submit'|'reset'} [opts.type='button']
 * @param {boolean} [opts.block=false] Full width.
 * @returns {HTMLButtonElement}
 */
export function button({
  label,
  icon,
  variant = 'secondary',
  size = 'm',
  onClick,
  ariaLabel,
  disabled,
  type = 'button',
  block = false,
} = {}) {
  const hasLabel = label !== undefined && label !== null && label !== '';
  const el = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      {
        type,
        class: cx('btn', `btn-${variant}`, `btn-${size}`, block && 'btn-block', !hasLabel && 'btn-icon-only'),
        'aria-label': ariaLabel || undefined,
      },
      iconNode(icon, size === 'l' ? 22 : 20),
      hasLabel ? h('span', { class: 'btn-label' }, label) : null,
    )
  );
  el.disabled = Boolean(disabled);
  if (typeof onClick === 'function') el.addEventListener('click', onClick);
  return el;
}

/**
 * A round, icon-only button with a required accessible label (also its tooltip).
 *
 * @param {object} opts
 * @param {string | Node} opts.icon Icon name or node.
 * @param {string} opts.label Accessible name and tooltip.
 * @param {(e: MouseEvent) => void} [opts.onClick]
 * @param {boolean} [opts.pressed] When boolean, renders a toggle button (`aria-pressed`).
 *   Update later with `el.setAttribute('aria-pressed', 'true' | 'false')`.
 * @param {'ghost'|'secondary'|'primary'} [opts.variant='ghost']
 * @returns {HTMLButtonElement}
 */
export function iconButton({ icon, label, onClick, pressed, variant = 'ghost' } = /** @type {any} */ ({})) {
  if (!label) {
    // eslint-disable-next-line no-console
    console.warn('[components] iconButton needs a label for accessibility.');
  }
  const el = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      {
        type: 'button',
        class: cx('icon-btn', `icon-btn-${variant}`),
        'aria-label': label || undefined,
        title: label || undefined,
      },
      iconNode(icon, 22),
    )
  );
  if (typeof pressed === 'boolean') el.setAttribute('aria-pressed', String(pressed));
  if (typeof onClick === 'function') el.addEventListener('click', onClick);
  return el;
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

const MAX_TOASTS = 3;
/** @type {{ el: HTMLElement, close: () => void }[]} */
const liveToasts = [];

/**
 * Shows a short message at the bottom of the screen.
 *
 * Toasts stack in `#toast-slot` (an `aria-live="polite"` region), pause their
 * timer while hovered, focused or while the app is in the background, can be
 * swiped sideways or tapped to dismiss, and never pile up beyond three.
 *
 * @param {string | Node} message
 * @param {object} [opts]
 * @param {{ label: string, onClick: () => void }} [opts.action] One action button (closes the toast).
 * @param {number} [opts.duration=4000] Milliseconds; `0` or `Infinity` keeps it until closed.
 * @param {'info'|'success'|'danger'} [opts.kind='info']
 * @returns {{ close: () => void }}
 */
export function toast(message, { action, duration = 4000, kind = 'info' } = {}) {
  const host = slot('toast-slot', { 'aria-live': 'polite', class: 'toast-slot' });
  const persistent = !duration || duration === Infinity;
  const kindIcon = kind === 'success' ? 'check' : kind === 'danger' ? 'alert' : null;

  /** @type {HTMLButtonElement | null} */
  let actionBtn = null;
  if (action && action.label) {
    actionBtn = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'toast-action' }, action.label));
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        action.onClick?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[toast] action failed', err);
      }
      close();
    });
  }

  /** @type {HTMLButtonElement | null} */
  let closeBtn = null;
  if (persistent || kind === 'danger') {
    closeBtn = /** @type {HTMLButtonElement} */ (
      h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', title: 'Dismiss' }, makeIcon('close', { size: 18 }))
    );
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      close();
    });
  }

  const el = h(
    'div',
    { class: cx('toast', `toast-${kind}`) },
    kindIcon ? h('span', { class: 'toast-icon' }, makeIcon(kindIcon, { size: 20 })) : null,
    h('p', { class: 'toast-msg' }, message),
    actionBtn,
    closeBtn,
  );

  let closed = false;
  let remaining = persistent ? Infinity : duration;
  let startedAt = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let hovered = false;
  let focused = false;

  const run = () => {
    if (closed || persistent || timer !== undefined) return;
    if (hovered || focused || document.hidden) return;
    startedAt = Date.now();
    timer = setTimeout(close, Math.max(0, remaining));
  };
  const pause = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining -= Date.now() - startedAt;
    // Give people a moment after they come back.
    remaining = Math.max(remaining, 1500);
  };
  const onVisibility = () => (document.hidden ? pause() : run());

  el.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse') {
      hovered = true;
      pause();
    }
  });
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') {
      hovered = false;
      run();
    }
  });
  el.addEventListener('focusin', () => {
    focused = true;
    pause();
  });
  el.addEventListener('focusout', (e) => {
    if (!el.contains(/** @type {Node | null} */ (e.relatedTarget))) {
      focused = false;
      run();
    }
  });
  // Tap on the message (not a button) dismisses plain toasts.
  el.addEventListener('click', () => {
    if (!actionBtn) close();
  });
  enableSwipeDismiss(el, () => close());
  document.addEventListener('visibilitychange', onVisibility);

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    const i = liveToasts.findIndex((t) => t.el === el);
    if (i !== -1) liveToasts.splice(i, 1);
    el.classList.add('is-leaving');
    afterMotion(el, 320).then(() => el.remove());
  }

  host.append(el);
  liveToasts.push({ el, close });
  while (liveToasts.length > MAX_TOASTS) liveToasts[0].close();
  run();
  return { close };
}

/**
 * Horizontal swipe-to-dismiss for touch/pen (vertical scroll stays native).
 * @param {HTMLElement} el
 * @param {() => void} onDismiss
 */
function enableSwipeDismiss(el, onDismiss) {
  /** @type {{ id: number, x: number, y: number, dx: number, active: boolean } | null} */
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || /** @type {Element} */ (e.target).closest('button')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, active: false };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        drag.active = true;
        capturePointer(el, e.pointerId);
        el.classList.add('is-dragging');
      } else if (Math.abs(dy) > 10) {
        drag = null;
        return;
      } else return;
    }
    drag.dx = dx;
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / 240));
  });
  const end = () => {
    if (!drag) return;
    const { dx, active } = drag;
    drag = null;
    if (!active) return;
    el.classList.remove('is-dragging');
    if (Math.abs(dx) > 90) {
      el.classList.add('is-swiped');
      el.style.transform = `translateX(${dx > 0 ? 120 : -120}%)`;
      el.style.opacity = '0';
      onDismiss();
    } else {
      el.style.transform = '';
      el.style.opacity = '';
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/**
 * A toast with an "Undo" action that stays for 6 seconds.
 * @param {string | Node} message e.g. "Note deleted"
 * @param {() => void} onUndo Called when the user taps Undo.
 * @returns {{ close: () => void }}
 */
export function undoToast(message, onUndo) {
  return toast(message, { action: { label: 'Undo', onClick: onUndo }, duration: 6000 });
}

/* ------------------------------------------------------------------ */
/* Sheets (bottom sheet on phones, dialog on tablets)                  */
/* ------------------------------------------------------------------ */

/**
 * @typedef {object} SheetRecord
 * @property {HTMLElement} root
 * @property {HTMLElement} panel
 * @property {HTMLElement[]} inerted Elements this sheet made inert (restored on close).
 * @property {(reason?: string) => Promise<void>} close
 */

/** @type {SheetRecord[]} */
const openSheets = [];
let scrollLocks = 0;
let docListeners = false;

function lockScroll() {
  scrollLocks += 1;
  if (scrollLocks === 1) document.documentElement.classList.add('is-scroll-locked');
}

function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks === 0) document.documentElement.classList.remove('is-scroll-locked');
}

/**
 * Makes everything except the sheet host, the toast host and `keep` inert.
 * Only elements that were not inert already are recorded, so other modules'
 * inert state is never clobbered.
 * @param {HTMLElement} host
 * @param {HTMLElement} keep
 * @returns {HTMLElement[]}
 */
function inertBackground(host, keep) {
  /** @type {HTMLElement[]} */
  const changed = [];
  const consider = (/** @type {Element} */ el) => {
    if (!(el instanceof HTMLElement) || el === host || el === keep) return;
    if (el.id === 'toast-slot' || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK)$/.test(el.tagName)) return;
    if (!el.inert) {
      el.inert = true;
      changed.push(el);
    }
  };
  [...document.body.children].forEach(consider);
  [...host.children].forEach(consider);
  return changed;
}

/** Keeps the open sheet above an on-screen keyboard (iOS/Android visual viewport). */
function onViewportChange() {
  const vv = window.visualViewport;
  if (!vv) return;
  // Pinch zoom also shrinks the visual viewport; only a keyboard counts.
  const kb = Math.abs(vv.scale - 1) > 0.01 ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  for (const s of openSheets) {
    s.root.style.setProperty('--kb', `${kb}px`);
    s.root.classList.toggle('has-kb', kb > 0);
  }
}

/** @param {KeyboardEvent} e */
function onDocKeydown(e) {
  const top = openSheets[openSheets.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    if (e.defaultPrevented || e.isComposing) return;
    e.preventDefault();
    top.close('escape');
    return;
  }
  if (e.key !== 'Tab') return;
  const active = /** @type {HTMLElement | null} */ (document.activeElement);
  // Focus inside a toast (e.g. "Undo") may move freely.
  if (active && active.closest('#toast-slot')) return;
  const items = focusablesIn(top.panel);
  if (items.length === 0) {
    e.preventDefault();
    top.panel.focus({ preventScroll: true });
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const inside = active && top.panel.contains(active);
  if (e.shiftKey && (!inside || active === first || active === top.panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (!inside || active === last)) {
    e.preventDefault();
    first.focus();
  }
}

function setDocListeners(on) {
  if (on === docListeners) return;
  docListeners = on;
  const method = on ? 'addEventListener' : 'removeEventListener';
  document[method]('keydown', onDocKeydown);
  window.visualViewport?.[method]('resize', onViewportChange);
  window.visualViewport?.[method]('scroll', onViewportChange);
}

/**
 * Opens a modal sheet: a bottom sheet on phones (drag handle, swipe down to
 * close) and a centered dialog on screens ≥ 700px.
 *
 * Focus moves into the sheet (to an element with `autofocus` or
 * `data-autofocus`, else the panel) and is trapped there; Esc, the backdrop,
 * the close button, swipe-down and Android Back (CloseWatcher) all close it;
 * focus then returns to where it was. The page behind becomes inert and stops
 * scrolling. Sheets stack.
 *
 * @param {object} opts
 * @param {string | Node} [opts.title] Heading; also the dialog's accessible name.
 * @param {Node} [opts.content] Body content (scrolls when long).
 * @param {Node[]} [opts.actions] Footer buttons, e.g. `[button({label:'Cancel'}), button({label:'Save', variant:'primary'})]`.
 * @param {(reason: string) => void} [opts.onClose] Called once when the sheet starts closing
 *   (reason: 'button' | 'backdrop' | 'escape' | 'swipe' | 'back' | 'api' | other strings passed to close()).
 * @param {'s'|'m'|'l'|'full'} [opts.size='m'] `full` fills the screen (e.g. scratchpad).
 * @returns {{ close: (reason?: string) => Promise<void>, el: HTMLElement }} `el` is the dialog panel.
 */
export function sheet({ title, content, actions, onClose, size = 'm' } = {}) {
  const host = slot('sheet-slot');
  const hasTitle = title !== undefined && title !== null && title !== '';
  const titleId = nextId('sheet-title');

  const closeBtn = iconButton({ icon: 'close', label: 'Close', onClick: () => close('button') });
  closeBtn.classList.add('sheet-close');

  const handle = h('div', { class: 'sheet-handle', 'aria-hidden': 'true' });
  const header = h(
    'div',
    { class: 'sheet-header' },
    hasTitle ? h('h2', { class: 'sheet-title', id: titleId }, title) : h('div', { class: 'sheet-title-spacer' }),
    closeBtn,
  );
  const body = h('div', { class: 'sheet-body' }, content ?? null);
  const actionNodes = (actions || []).filter(Boolean);
  const footer = actionNodes.length ? h('div', { class: 'sheet-footer' }, ...actionNodes) : null;

  const panel = h(
    'div',
    {
      class: cx('sheet', `sheet-${size}`, !footer && 'sheet-no-footer'),
      role: 'dialog',
      'aria-modal': 'true',
      tabindex: '-1',
      'aria-labelledby': hasTitle ? titleId : undefined,
      'aria-label': hasTitle ? undefined : 'Dialog',
    },
    handle,
    header,
    body,
    footer,
  );
  const backdrop = h('div', { class: 'sheet-backdrop', 'aria-hidden': 'true' });
  const root = h('div', { class: cx('sheet-root', `sheet-root-${size}`) }, backdrop, panel);

  const prevFocus = /** @type {HTMLElement | null} */ (document.activeElement);
  /** @type {any} */
  let watcher = null;
  let closing = false;
  /** @type {Promise<void> | null} */
  let closedPromise = null;

  /** @type {SheetRecord} */
  const record = { root, panel, inerted: [], close };

  backdrop.addEventListener('click', () => close('backdrop'));

  /**
   * Closes the sheet. Safe to call more than once.
   * @param {string} [reason='api']
   * @returns {Promise<void>}
   */
  function close(reason = 'api') {
    if (closing) return /** @type {Promise<void>} */ (closedPromise);
    closing = true;
    try {
      watcher?.destroy();
    } catch {
      /* ignore */
    }
    const index = openSheets.indexOf(record);
    const wasTop = index === openSheets.length - 1;
    if (index !== -1) openSheets.splice(index, 1);
    if (!wasTop && index !== -1 && openSheets[index]) {
      // A sheet above this one is still open: it inherits our inert set.
      openSheets[index].inerted.push(...record.inerted);
    } else {
      for (const el of record.inerted) el.inert = false;
    }
    record.inerted = [];
    unlockScroll();
    if (openSheets.length === 0) setDocListeners(false);

    root.classList.remove('is-open');
    root.classList.add('is-closing');
    panel.style.transform = '';
    backdrop.style.opacity = '';

    if (wasTop) {
      const target =
        prevFocus && prevFocus.isConnected && !prevFocus.closest('[inert]')
          ? prevFocus
          : openSheets.length
            ? openSheets[openSheets.length - 1].panel
            : document.getElementById('main');
      target?.focus?.({ preventScroll: true });
    }

    closedPromise = afterMotion(panel, 420).then(() => root.remove());

    try {
      onClose?.(reason);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[sheet] onClose failed', err);
    }
    return closedPromise;
  }

  // Mount.
  record.inerted = inertBackground(host, root);
  host.append(root);
  openSheets.push(record);
  lockScroll();
  setDocListeners(true);
  onViewportChange();

  // Android Back gesture / button closes the top sheet (Chromium).
  const CW = /** @type {any} */ (globalThis).CloseWatcher;
  if (typeof CW === 'function') {
    try {
      watcher = new CW();
      watcher.onclose = () => close('back');
    } catch {
      watcher = null;
    }
  }

  enableSheetDrag(record, handle, header, backdrop, () => close('swipe'));

  // Start the enter transition from the initial state.
  void panel.offsetHeight;
  root.classList.add('is-open');

  const auto = /** @type {HTMLElement | null} */ (panel.querySelector('[autofocus], [data-autofocus]'));
  (auto || panel).focus({ preventScroll: true });

  return { close, el: panel };
}

/**
 * Swipe-down-to-close for phone bottom sheets (handle and header only, so
 * scrolling and drawing inside the body are never hijacked).
 * @param {SheetRecord} record
 * @param {HTMLElement} handle
 * @param {HTMLElement} header
 * @param {HTMLElement} backdrop
 * @param {() => void} onDismiss
 */
function enableSheetDrag(record, handle, header, backdrop, onDismiss) {
  const { panel } = record;
  /** @type {{ id: number, y0: number, y: number, t: number, v: number, dy: number, h: number } | null} */
  let drag = null;

  /** @param {PointerEvent} e */
  const down = (e) => {
    if (!isPhoneLayout() || e.button > 0 || !panel.isConnected) return;
    if (/** @type {Element} */ (e.target).closest('button, a, input, textarea, select, [data-no-drag]')) return;
    drag = { id: e.pointerId, y0: e.clientY, y: e.clientY, t: performance.now(), v: 0, dy: 0, h: panel.offsetHeight };
    capturePointer(/** @type {HTMLElement} */ (e.currentTarget), e.pointerId);
    panel.classList.add('is-dragging');
  };
  /** @param {PointerEvent} e */
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const now = performance.now();
    const dt = Math.max(1, now - drag.t);
    drag.v = 0.8 * ((e.clientY - drag.y) / dt) + 0.2 * drag.v;
    drag.y = e.clientY;
    drag.t = now;
    const raw = e.clientY - drag.y0;
    drag.dy = raw >= 0 ? raw : -Math.min(24, Math.sqrt(-raw) * 2);
    panel.style.transform = `translateY(${drag.dy}px)`;
    backdrop.style.opacity = String(Math.max(0, 1 - Math.max(0, drag.dy) / (drag.h * 1.2)));
  };
  /** @param {PointerEvent} e */
  const up = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dy, v, h: height } = drag;
    drag = null;
    panel.classList.remove('is-dragging');
    if (e.type !== 'pointercancel' && (dy > Math.min(160, height * 0.3) || (v > 0.55 && dy > 12))) {
      onDismiss();
    } else {
      panel.style.transform = '';
      backdrop.style.opacity = '';
    }
  };
  for (const zone of [handle, header]) {
    zone.addEventListener('pointerdown', down);
    zone.addEventListener('pointermove', move);
    zone.addEventListener('pointerup', up);
    zone.addEventListener('pointercancel', up);
  }
}

/**
 * Asks the user to confirm an irreversible action. Prefer Undo for anything
 * reversible.
 *
 * @param {object} opts
 * @param {string} [opts.title='Are you sure?']
 * @param {string | Node} [opts.text]
 * @param {string} [opts.confirmLabel='Confirm']
 * @param {boolean} [opts.danger=false] Red confirm button; Cancel gets initial focus.
 * @returns {Promise<boolean>} `true` only when the confirm button was pressed.
 */
export function confirmSheet({ title = 'Are you sure?', text, confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (/** @type {boolean} */ value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    /** @type {{ close: (reason?: string) => Promise<void> } | null} */
    let ref = null;
    const cancel = button({
      label: 'Cancel',
      variant: 'secondary',
      onClick: () => {
        settle(false);
        ref?.close('cancel');
      },
    });
    const ok = button({
      label: confirmLabel,
      variant: danger ? 'danger' : 'primary',
      onClick: () => {
        settle(true);
        ref?.close('confirm');
      },
    });
    (danger ? cancel : ok).setAttribute('data-autofocus', '');
    const content = text ? h('p', { class: 'confirm-text' }, text) : null;
    ref = sheet({ title, content: content ?? undefined, actions: [cancel, ok], size: 's', onClose: () => settle(false) });
  });
}

/* ------------------------------------------------------------------ */
/* Display components                                                  */
/* ------------------------------------------------------------------ */

/**
 * A friendly empty state that teaches what will appear here. The icon sits in
 * a soft badge with a faint, decorative heartbeat trace behind it (aria-hidden).
 * @param {object} opts
 * @param {string | Node} [opts.icon]
 * @param {string | Node} [opts.title]
 * @param {string | Node} [opts.text]
 * @param {Node} [opts.action] Usually a `button()`.
 * @returns {HTMLElement}
 */
export function emptyState({ icon, title, text, action } = {}) {
  return h(
    'div',
    { class: 'empty-state' },
    icon
      ? h(
          'div',
          { class: 'empty-icon' },
          iconNode(icon, 28),
          h('span', { class: 'empty-ecg', 'aria-hidden': 'true' }, h('span', { class: 'ecg-line' })),
        )
      : null,
    title ? h('h2', { class: 'empty-title' }, title) : null,
    text ? h('p', { class: 'empty-text' }, text) : null,
    action ? h('div', { class: 'empty-action' }, action) : null,
  );
}

/**
 * A horizontal progress bar (`role="progressbar"`).
 * @param {number} value 0..100 (clamped).
 * @param {object} [opts]
 * @param {string} [opts.label] Accessible name, e.g. "Chapter progress".
 * @returns {HTMLElement}
 */
export function progressBar(value, { label } = {}) {
  const v = clampPct(value);
  const fill = h('div', { class: 'progress-fill' });
  fill.style.width = `${v}%`;
  const el = h(
    'div',
    {
      class: 'progress',
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(v),
      'aria-valuetext': `${v}%`,
      'aria-label': label || undefined,
    },
    fill,
  );
  el.style.setProperty('--value', String(v));
  return el;
}

/**
 * A circular progress ring with the percentage in the middle (hidden below 36px).
 * Color follows `--ring-color` (default `--primary`).
 * @param {number} value 0..100 (clamped).
 * @param {object} [opts]
 * @param {number} [opts.size=48] Diameter in px.
 * @param {string} [opts.label] Accessible name; defaults to "NN%".
 * @returns {HTMLElement}
 */
export function ring(value, { size = 48, label } = {}) {
  const v = clampPct(value);
  const d = Math.max(16, Number(size) || 48);
  const stroke = Math.max(3, Math.round(d / 10));
  const r = (d - stroke) / 2;
  const c = 2 * Math.PI * r;
  const mid = d / 2;
  const track = svg('circle', { class: 'ring-track', cx: mid, cy: mid, r, fill: 'none', 'stroke-width': stroke });
  const bar = svg('circle', {
    class: 'ring-value',
    cx: mid,
    cy: mid,
    r,
    fill: 'none',
    'stroke-width': stroke,
    'stroke-linecap': v > 0 && v < 100 ? 'round' : 'butt',
    'stroke-dasharray': `${((c * v) / 100).toFixed(2)} ${c.toFixed(2)}`,
    transform: `rotate(-90 ${mid} ${mid})`,
  });
  const graphic = svg(
    'svg',
    { class: 'ring-svg', viewBox: `0 0 ${d} ${d}`, width: d, height: d, 'aria-hidden': 'true', focusable: 'false' },
    track,
    bar,
  );
  const text = d >= 36 ? h('span', { class: 'ring-text', 'aria-hidden': 'true' }, String(v), h('span', { class: 'ring-pct' }, '%')) : null;
  const el = h('span', { class: 'ring', role: 'img', 'aria-label': label || `${v}%` }, graphic, text);
  el.style.setProperty('--ring-size', `${d}px`);
  return el;
}

/**
 * A small status label.
 * @param {string | Node} label
 * @param {object} [opts]
 * @param {'neutral'|'success'|'danger'|'warning'|'info'|'primary'|'teal'} [opts.kind='neutral']
 *   `teal` (scrub teal) is the secondary accent, e.g. for exam/timer labels.
 * @param {string | Node} [opts.icon]
 * @returns {HTMLElement}
 */
export function chip(label, { kind = 'neutral', icon } = {}) {
  return h('span', { class: cx('chip', `chip-${kind}`) }, iconNode(icon, 14), h('span', { class: 'chip-label' }, label));
}

/**
 * A single-choice control (ARIA radiogroup with roving focus and arrow keys).
 * Up to 4 options render as a classic segmented control with a sliding
 * indicator; more options wrap as pills so labels never truncate.
 *
 * The returned element also exposes a `value` property (get/set; setting does
 * not call `onChange`).
 *
 * @param {object} opts
 * @param {{ value: any, label: string | Node, disabled?: boolean }[]} opts.options
 * @param {any} [opts.value] Selected value (defaults to the first option).
 * @param {(value: any) => void} [opts.onChange]
 * @param {string} [opts.ariaLabel]
 * @returns {HTMLElement & { value: any }}
 */
export function segmented({ options = [], value, onChange, ariaLabel } = /** @type {any} */ ({})) {
  const many = options.length > 4;
  const group = /** @type {HTMLElement & { value: any }} */ (
    h('div', { class: cx('segmented', many && 'segmented-wrap'), role: 'radiogroup', 'aria-label': ariaLabel || undefined })
  );
  let current = options.some((o) => o.value === value) ? value : options[0]?.value;

  const buttons = options.map((opt, i) => {
    const b = /** @type {HTMLButtonElement} */ (
      h('button', { type: 'button', class: 'seg-option', role: 'radio' }, h('span', { class: 'seg-label' }, opt.label))
    );
    b.disabled = Boolean(opt.disabled);
    b.addEventListener('click', () => select(i, false));
    return b;
  });

  if (!many) group.append(h('span', { class: 'seg-indicator', 'aria-hidden': 'true' }));
  group.append(...buttons);
  group.style.setProperty('--seg-count', String(Math.max(1, options.length)));

  function render() {
    let any = false;
    buttons.forEach((b, i) => {
      const on = options[i].value === current;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on) {
        any = true;
        group.style.setProperty('--seg-index', String(i));
      }
    });
    if (!any && buttons[0]) buttons[0].tabIndex = 0;
    group.classList.toggle('has-value', any);
  }

  /**
   * @param {number} i
   * @param {boolean} focus
   */
  function select(i, focus) {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    const changed = opt.value !== current;
    current = opt.value;
    render();
    if (focus) buttons[i].focus();
    if (changed) {
      try {
        onChange?.(opt.value);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[segmented] onChange failed', err);
      }
    }
  }

  group.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key) || buttons.length === 0) return;
    e.preventDefault();
    const enabled = buttons.map((b, i) => (b.disabled ? -1 : i)).filter((i) => i !== -1);
    if (enabled.length === 0) return;
    const pos = Math.max(0, enabled.indexOf(options.findIndex((o) => o.value === current)));
    let next = pos;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (pos + 1) % enabled.length;
    else next = (pos - 1 + enabled.length) % enabled.length;
    select(enabled[next], true);
  });

  Object.defineProperty(group, 'value', {
    get: () => current,
    set: (v) => {
      if (options.some((o) => o.value === v)) {
        current = v;
        render();
      }
    },
  });

  render();
  return group;
}

/**
 * A labelled on/off switch (a real checkbox with `role="switch"`); the whole
 * row is the touch target.
 * @param {object} opts
 * @param {boolean} [opts.checked=false]
 * @param {(checked: boolean) => void} [opts.onChange]
 * @param {string | Node} opts.label
 * @param {string | Node} [opts.description]
 * @returns {HTMLLabelElement}
 */
export function toggle({ checked = false, onChange, label, description } = /** @type {any} */ ({})) {
  const descId = description ? nextId('toggle-desc') : undefined;
  const input = /** @type {HTMLInputElement} */ (
    h('input', { type: 'checkbox', role: 'switch', class: 'toggle-input', 'aria-describedby': descId })
  );
  input.checked = Boolean(checked);
  input.addEventListener('change', () => {
    try {
      onChange?.(input.checked);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[toggle] onChange failed', err);
    }
  });
  return /** @type {HTMLLabelElement} */ (
    h(
      'label',
      { class: 'toggle' },
      h(
        'span',
        { class: 'toggle-text' },
        h('span', { class: 'toggle-label' }, label),
        description ? h('span', { class: 'toggle-desc', id: descId }, description) : null,
      ),
      input,
      h('span', { class: 'toggle-track', 'aria-hidden': 'true' }, h('span', { class: 'toggle-thumb' })),
    )
  );
}

/**
 * A list row. Renders a link (`href`), a button (`onClick`) or a plain row.
 * Interactive rows get a chevron. Put rows in a `.list` container for the
 * grouped look. `trailing` must not be interactive when the row is.
 * @param {object} opts
 * @param {string | Node} opts.title
 * @param {string | Node} [opts.subtitle]
 * @param {string | Node} [opts.icon] Icon name or node (shown in a soft circle when a name).
 * @param {string | number | Node} [opts.trailing] Count, chip, ring…
 * @param {(e: MouseEvent) => void} [opts.onClick]
 * @param {string} [opts.href] Relative link, e.g. `#/q/CPB-0001`.
 * @returns {HTMLElement}
 */
export function listItem({ title, subtitle, icon, trailing, onClick, href } = /** @type {any} */ ({})) {
  const tag = href ? 'a' : onClick ? 'button' : 'div';
  const interactive = tag !== 'div';
  const el = h(
    tag,
    {
      class: cx('list-item', interactive && 'is-interactive'),
      href: href || undefined,
      type: tag === 'button' ? 'button' : undefined,
    },
    icon ? h('span', { class: cx('li-icon', typeof icon !== 'string' && 'li-icon-custom') }, iconNode(icon, 20)) : null,
    h(
      'span',
      { class: 'li-text' },
      h('span', { class: 'li-title' }, title ?? ''),
      subtitle ? h('span', { class: 'li-subtitle' }, subtitle) : null,
    ),
    trailing !== undefined && trailing !== null && trailing !== false
      ? h('span', { class: 'li-trailing' }, typeof trailing === 'number' ? String(trailing) : trailing)
      : null,
    interactive ? h('span', { class: 'li-chevron', 'aria-hidden': 'true' }, makeIcon('chevron-right', { size: 18 })) : null,
  );
  if (typeof onClick === 'function') el.addEventListener('click', onClick);
  return el;
}

/**
 * A loading indicator (`role="status"`).
 * @param {object} [opts]
 * @param {string} [opts.label] Shown next to the spinner; defaults to a hidden "Loading…".
 * @returns {HTMLElement}
 */
export function spinner({ label } = {}) {
  return h(
    'span',
    { class: 'spinner', role: 'status' },
    h('span', { class: 'spinner-ring', 'aria-hidden': 'true' }),
    h('span', { class: label ? 'spinner-label' : 'visually-hidden' }, label || 'Loading…'),
  );
}

/**
 * Placeholder text lines shown while content loads (hidden from screen readers;
 * pair with `spinner()` or `aria-busy` on the container).
 * @param {number} [lines=3]
 * @returns {HTMLElement}
 */
export function skeleton(lines = 3) {
  const n = Math.min(40, Math.max(1, Math.floor(Number(lines)) || 3));
  const widths = [100, 94, 86, 97, 78, 90];
  const el = h('div', { class: 'skeleton', 'aria-hidden': 'true' });
  for (let i = 0; i < n; i += 1) {
    const line = h('span', { class: 'skeleton-line' });
    line.style.width = `${n > 1 && i === n - 1 ? 62 : widths[i % widths.length]}%`;
    el.append(line);
  }
  return el;
}
