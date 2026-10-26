/**
 * App-wide publish/subscribe bus.
 *
 * Synchronous delivery, in subscription order. A listener that throws (or
 * returns a rejected promise) is logged and never stops the other listeners.
 * Safe to import in Node (no DOM access).
 *
 * Known event names (see docs/ARCHITECTURE.md §5.2):
 * `route:change`, `settings:change` ({key, value}), `store:change` ({store, key}),
 * `sw:update-ready`, `net:change` ({online}), `storage:error` ({name, message}),
 * `db:versionchange`, `qstate:change` ({qid}).
 *
 * @module core/events
 */

/**
 * Event name constants, so typos fail loudly instead of silently.
 * @type {Readonly<Record<string, string>>}
 */
export const EVENTS = Object.freeze({
  ROUTE_CHANGE: 'route:change',
  SETTINGS_CHANGE: 'settings:change',
  STORE_CHANGE: 'store:change',
  SW_UPDATE_READY: 'sw:update-ready',
  NET_CHANGE: 'net:change',
  STORAGE_ERROR: 'storage:error',
  DB_VERSIONCHANGE: 'db:versionchange',
  QSTATE_CHANGE: 'qstate:change',
});

/** Listeners registered with this name receive every event as `(payload, name)`. */
const WILDCARD = '*';

/**
 * @typedef {(payload: any, name: string) => any} Listener
 * @typedef {{ fn: Listener, once: boolean, removed: boolean }} Entry
 */

/** @type {Map<string, Entry[]>} */
const registry = new Map();

/**
 * @param {unknown} name
 * @param {unknown} fn
 */
function assertArgs(name, fn) {
  if (typeof name !== 'string' || name === '') {
    throw new TypeError('bus: event name must be a non-empty string');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`bus: listener for "${name}" must be a function`);
  }
}

/**
 * @param {string} name
 * @param {Listener} fn
 * @param {boolean} once
 * @returns {() => void}
 */
function add(name, fn, once) {
  assertArgs(name, fn);
  const entry = { fn, once, removed: false };
  const list = registry.get(name);
  if (list) list.push(entry);
  else registry.set(name, [entry]);
  return () => removeEntry(name, entry);
}

/**
 * @param {string} name
 * @param {Entry} entry
 */
function removeEntry(name, entry) {
  if (entry.removed) return;
  entry.removed = true;
  const list = registry.get(name);
  if (!list) return;
  const i = list.indexOf(entry);
  if (i !== -1) list.splice(i, 1);
  if (list.length === 0) registry.delete(name);
}

/**
 * @param {string} name
 * @param {unknown} err
 */
function report(name, err) {
  // eslint-disable-next-line no-console
  console.error(`[bus] A listener for "${name}" failed:`, err);
}

/**
 * Calls every listener of `list` (a snapshot) with isolation.
 * @param {Entry[] | undefined} list
 * @param {string} registeredAs
 * @param {string} name
 * @param {any} payload
 */
function dispatch(list, registeredAs, name, payload) {
  if (!list || list.length === 0) return;
  for (const entry of list.slice()) {
    if (entry.removed) continue;
    if (entry.once) removeEntry(registeredAs, entry);
    try {
      const out = entry.fn(payload, name);
      if (out && typeof out.then === 'function') {
        out.then(undefined, (err) => report(name, err));
      }
    } catch (err) {
      report(name, err);
    }
  }
}

/**
 * The app bus.
 *
 * @example
 * const off = bus.on('settings:change', ({ key, value }) => { ... });
 * off(); // unsubscribe
 */
export const bus = Object.freeze({
  /**
   * Subscribes to an event. Use `'*'` to receive every event as `(payload, name)`.
   * @param {string} name
   * @param {Listener} fn
   * @returns {() => void} Unsubscribe function (idempotent).
   */
  on(name, fn) {
    return add(name, fn, false);
  },

  /**
   * Subscribes for a single delivery.
   * @param {string} name
   * @param {Listener} fn
   * @returns {() => void} Unsubscribe function (idempotent).
   */
  once(name, fn) {
    return add(name, fn, true);
  },

  /**
   * Removes every registration of `fn` for `name` (including `once` ones).
   * Without `fn`, removes all listeners of `name`.
   * @param {string} name
   * @param {Listener} [fn]
   * @returns {void}
   */
  off(name, fn) {
    const list = registry.get(name);
    if (!list) return;
    for (const entry of list.slice()) {
      if (fn === undefined || entry.fn === fn) removeEntry(name, entry);
    }
  },

  /**
   * Delivers `payload` synchronously to every listener of `name`, then to `'*'` listeners.
   * Listener errors are logged and isolated.
   * @param {string} name
   * @param {any} [payload]
   * @returns {void}
   */
  emit(name, payload) {
    if (typeof name !== 'string' || name === '') {
      throw new TypeError('bus: event name must be a non-empty string');
    }
    dispatch(registry.get(name), name, name, payload);
    if (name !== WILDCARD) dispatch(registry.get(WILDCARD), WILDCARD, name, payload);
  },

  /**
   * Number of listeners currently registered for `name` (diagnostics and tests).
   * @param {string} name
   * @returns {number}
   */
  listenerCount(name) {
    return registry.get(name)?.length ?? 0;
  },

  /**
   * Removes every listener of every event. Intended for tests only.
   * @returns {void}
   */
  clear() {
    for (const [name, list] of [...registry]) {
      for (const entry of list.slice()) removeEntry(name, entry);
    }
  },
});
