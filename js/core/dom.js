/**
 * Tiny, safe DOM builders. Text is always inserted as text nodes, never as
 * HTML, so dynamic data can't inject markup.
 *
 * Props accepted by {@link h} and {@link svg}:
 * - `class` / `className`: string or (nested) array of strings; falsy entries skipped.
 * - `style`: object (camelCase or `--custom-prop` keys; null skipped) or a CSS string.
 * - `dataset`: object; values are stringified like `el.dataset.x = v`; null/undefined skipped.
 * - `on<Event>`: function, or `[function, options]` → `addEventListener('<event>')`
 *   (the name after `on` is lower-cased: `onClick` → `click`, `onPointerDown` → `pointerdown`).
 * - `true` → attribute set to `""`; `false` → attribute removed.
 *   Exception: `aria-*` and enumerated attributes (`spellcheck`, `draggable`,
 *   `contenteditable`, `translate`) get `"true"`/`"false"`, because their
 *   `"false"` value is meaningful.
 * - `null` / `undefined` → skipped.
 * - `value`, `checked`, `selected`, `indeterminate`, `muted`, `defaultValue`,
 *   `defaultChecked`, `textContent` → set as DOM properties after children are
 *   appended (so `<select value>` works).
 * - `htmlFor` → `for`; `ariaLabel` style camelCase → `aria-label`.
 * - Anything else → `setAttribute(name, String(value))`.
 * - `innerHTML` / `outerHTML` are refused (TypeError).
 *
 * Children: Node, string, number, arrays / NodeLists (flattened); `null`,
 * `undefined`, `true` and `false` are skipped.
 *
 * Importing this module does not touch `document`.
 *
 * @module core/dom
 */

/** SVG namespace. */
export const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/** Props applied as DOM properties (after children). */
const PROPERTY_KEYS = new Set([
  'value',
  'checked',
  'selected',
  'indeterminate',
  'muted',
  'defaultValue',
  'defaultChecked',
  'textContent',
]);

/** Attributes whose "false" value is meaningful (not boolean attributes). */
const ENUMERATED_BOOLEAN_ATTRS = new Set(['spellcheck', 'draggable', 'contenteditable', 'translate']);

const FORBIDDEN_KEYS = new Set(['innerHTML', 'outerHTML']);

/**
 * @typedef {Node | string | number | boolean | null | undefined | Child[] | NodeList | HTMLCollection} Child
 * @typedef {Record<string, any>} Props
 */

/**
 * True when `value` looks like a props object (not a child).
 * @param {unknown} value
 * @returns {value is Props}
 */
function isProps(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (typeof Node !== 'undefined' && value instanceof Node) return false;
  if (typeof (/** @type {any} */ (value))[Symbol.iterator] === 'function') return false;
  return true;
}

/**
 * Joins class values: strings, arrays (nested), falsy skipped.
 * @param {unknown} value
 * @returns {string}
 */
function classString(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.map(classString).filter(Boolean).join(' ');
  return String(value).trim();
}

/**
 * @param {Element & ElementCSSInlineStyle} el
 * @param {unknown} value
 */
function applyStyle(el, value) {
  if (typeof value === 'string') {
    el.style.cssText = value;
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (v == null || v === false) continue;
    if (key.startsWith('--') || key.includes('-')) {
      el.style.setProperty(key, String(v));
    } else {
      /** @type {any} */ (el.style)[key] = String(v);
    }
  }
}

/**
 * Normalises a prop key to an attribute name.
 * @param {string} key
 * @returns {string}
 */
function attrName(key) {
  if (key === 'htmlFor') return 'for';
  if (key === 'className') return 'class';
  // ariaLabel → aria-label, ariaDescribedBy → aria-describedby
  if (key.length > 4 && key.startsWith('aria') && key[4] >= 'A' && key[4] <= 'Z') {
    return `aria-${key.slice(4).toLowerCase()}`;
  }
  return key;
}

/**
 * Applies props to an element.
 * @param {Element} el
 * @param {Props} props
 * @param {boolean} isSvg
 * @returns {Array<[string, any]>} Deferred property assignments.
 */
function applyProps(el, props, isSvg) {
  /** @type {Array<[string, any]>} */
  const deferred = [];
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === undefined || value === null) continue;
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TypeError(`h(): "${key}" is not allowed. Pass children instead.`);
    }
    if (key === 'class' || key === 'className') {
      const cls = classString(value);
      if (cls) el.setAttribute('class', cls);
      continue;
    }
    if (key === 'style') {
      applyStyle(/** @type {any} */ (el), value);
      continue;
    }
    if (key === 'dataset') {
      if (value && typeof value === 'object') {
        const ds = /** @type {HTMLElement} */ (el).dataset;
        for (const [k, v] of Object.entries(value)) {
          if (v != null) ds[k] = String(v);
        }
      }
      continue;
    }
    if (key.length > 2 && (key[0] === 'o' || key[0] === 'O') && key.slice(0, 2).toLowerCase() === 'on') {
      // Every HTML/SVG attribute starting with "on" is an event handler.
      const type = key.slice(2).toLowerCase();
      if (typeof value === 'function') {
        el.addEventListener(type, value);
      } else if (Array.isArray(value) && typeof value[0] === 'function') {
        el.addEventListener(type, value[0], value[1]);
      } else if (value && typeof value.handleEvent === 'function') {
        el.addEventListener(type, value);
      }
      // Strings are ignored on purpose: no inline handlers.
      continue;
    }
    if (!isSvg && PROPERTY_KEYS.has(key)) {
      deferred.push([key, value]);
      continue;
    }
    const name = attrName(key);
    if (typeof value === 'boolean') {
      if (name.startsWith('aria-') || ENUMERATED_BOOLEAN_ATTRS.has(name.toLowerCase())) {
        el.setAttribute(name, String(value));
      } else if (value) {
        el.setAttribute(name, '');
      } else {
        el.removeAttribute(name);
      }
      continue;
    }
    if (isSvg && name.startsWith('xlink:')) {
      el.setAttributeNS(XLINK_NS, name, String(value));
      continue;
    }
    el.setAttribute(name, String(value));
  }
  return deferred;
}

/**
 * Flattens children into DOM nodes and appends them.
 * @param {ParentNode} parent
 * @param {Child[]} children
 */
function appendChildren(parent, children) {
  /** @type {Node[]} */
  const nodes = [];
  /** @param {Child} child */
  const visit = (child) => {
    if (child === null || child === undefined || typeof child === 'boolean') return;
    if (typeof child === 'string' || typeof child === 'number' || typeof child === 'bigint') {
      nodes.push(document.createTextNode(String(child)));
      return;
    }
    if (typeof Node !== 'undefined' && child instanceof Node) {
      nodes.push(child);
      return;
    }
    if (Array.isArray(child)) {
      for (const c of child) visit(c);
      return;
    }
    if (typeof (/** @type {any} */ (child))[Symbol.iterator] === 'function') {
      for (const c of Array.from(/** @type {Iterable<Child>} */ (child))) visit(c);
      return;
    }
    // Unknown object: render its text form, never as markup.
    nodes.push(document.createTextNode(String(child)));
  };
  for (const c of children) visit(c);
  if (nodes.length) parent.append(...nodes);
}

/**
 * Creates an HTML element. `props` may be omitted: `h('p', 'Hello')`.
 * `h('svg', ...)` delegates to {@link svg}.
 * @param {string} tag
 * @param {Props | Child} [props]
 * @param {...Child} children
 * @returns {HTMLElement}
 * @example
 * h('button', { class: ['btn', primary && 'btn-primary'], onClick: save, disabled: busy }, 'Save')
 */
export function h(tag, props, ...children) {
  if (tag === 'svg') return /** @type {any} */ (svg(tag, /** @type {any} */ (props), ...children));
  const el = document.createElement(tag);
  let deferred = null;
  if (isProps(props)) {
    deferred = applyProps(el, props, false);
  } else if (props !== undefined) {
    children.unshift(/** @type {Child} */ (props));
  }
  appendChildren(el, children);
  if (deferred) {
    for (const [key, value] of deferred) /** @type {any} */ (el)[key] = value;
  }
  return el;
}

/**
 * Creates an SVG element (same props semantics as {@link h}; attribute names
 * are kept case-sensitive, e.g. `viewBox`, `stroke-width`).
 * @param {string} tag
 * @param {Props | Child} [attrs]
 * @param {...Child} children
 * @returns {SVGElement}
 * @example svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': true }, svg('path', { d: 'M4 12h16' }))
 */
export function svg(tag, attrs, ...children) {
  const el = /** @type {SVGElement} */ (document.createElementNS(SVG_NS, tag));
  if (isProps(attrs)) {
    applyProps(el, attrs, true);
  } else if (attrs !== undefined) {
    children.unshift(/** @type {Child} */ (attrs));
  }
  appendChildren(el, children);
  return el;
}

/**
 * `querySelector` shorthand.
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {Element | null}
 */
export function $(sel, root = document) {
  return root.querySelector(sel);
}

/**
 * `querySelectorAll` shorthand returning a real array.
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {Element[]}
 */
export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/**
 * Removes every child of `el`.
 * @template {Element | DocumentFragment} E
 * @param {E} el
 * @returns {E}
 */
export function clear(el) {
  if (!el) return el;
  if (typeof el.replaceChildren === 'function') {
    el.replaceChildren();
  } else {
    while (el.firstChild) el.removeChild(el.firstChild);
  }
  return el;
}

/**
 * Builds a DocumentFragment from children (same rules as {@link h}).
 * @param {...Child} children
 * @returns {DocumentFragment}
 */
export function frag(...children) {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

/**
 * Creates a text node (null/undefined → empty).
 * @param {unknown} value
 * @returns {Text}
 */
export function text(value) {
  return document.createTextNode(value == null ? '' : String(value));
}

/**
 * Replaces the content of `el` with plain text.
 * @template {Node} E
 * @param {E} el
 * @param {unknown} value
 * @returns {E}
 */
export function setText(el, value) {
  el.textContent = value == null ? '' : String(value);
  return el;
}

/**
 * `addEventListener` that returns its own remover.
 * @param {EventTarget} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} fn
 * @param {boolean | AddEventListenerOptions} [options]
 * @returns {() => void}
 */
export function listen(target, type, fn, options) {
  target.addEventListener(type, fn, options);
  return () => target.removeEventListener(type, fn, options);
}

// ---------------------------------------------------------------------------
// Removal watching
// ---------------------------------------------------------------------------

/** Default grace period before a detached element counts as removed (it may just be moving). */
export const DISCONNECT_GRACE_MS = 500;

/**
 * @typedef {object} DisconnectWatch
 * @property {Element} el
 * @property {() => void} fn
 * @property {(() => void) | undefined} onDetach
 * @property {number} graceMs
 * @property {boolean} seen    The element has been in the document at least once.
 * @property {ReturnType<typeof setTimeout> | null} timer
 */

/** @type {Set<DisconnectWatch>} */
const disconnectWatches = new Set();
/** @type {MutationObserver | null} */
let disconnectObserver = null;

/** @param {DisconnectWatch} w */
function stopDisconnectWatch(w) {
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
  disconnectWatches.delete(w);
  if (!disconnectWatches.size && disconnectObserver) {
    disconnectObserver.disconnect();
    disconnectObserver = null;
  }
}

/** @param {DisconnectWatch} w */
function checkDisconnectWatch(w) {
  if (w.el.isConnected) {
    w.seen = true;
    if (w.timer) clearTimeout(w.timer);
    w.timer = null;
    return;
  }
  if (!w.seen || w.timer) return;
  try {
    w.onDetach?.();
  } catch (err) {
    console.error('[dom] onDetach failed.', err);
  }
  w.timer = setTimeout(() => {
    w.timer = null;
    if (w.el.isConnected || !disconnectWatches.has(w)) return;
    stopDisconnectWatch(w);
    w.fn();
  }, w.graceMs);
}

function onDocumentMutation() {
  for (const w of Array.from(disconnectWatches)) checkDisconnectWatch(w);
}

/**
 * Calls `fn` once `el` has been in the document and then stays out of it for
 * `graceMs` (a quick move between containers is not a removal). `onDetach`
 * runs right away on every detach (e.g. to flush a pending save).
 *
 * All watchers share one `MutationObserver` on `document` (subtree), which is
 * connected only while at least one watch is active. `fn` runs at most once;
 * the watch then ends by itself. An element that is never attached never
 * fires. Without `MutationObserver` (old browsers, Node) this is a no-op.
 * @param {Element} el
 * @param {() => void} fn
 * @param {{ graceMs?: number, onDetach?: () => void }} [options]
 *   graceMs: default {@link DISCONNECT_GRACE_MS} (500 ms).
 * @returns {() => void} Stops watching (idempotent; cancels a pending call).
 * @example const off = onDisconnect(panel, () => player.stop());
 */
export function onDisconnect(el, fn, { graceMs = DISCONNECT_GRACE_MS, onDetach } = {}) {
  if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return () => {};
  /** @type {DisconnectWatch} */
  const w = { el, fn, onDetach, graceMs, seen: el.isConnected, timer: null };
  disconnectWatches.add(w);
  if (!disconnectObserver) {
    disconnectObserver = new MutationObserver(onDocumentMutation);
    disconnectObserver.observe(document, { childList: true, subtree: true });
  }
  return () => stopDisconnectWatch(w);
}
