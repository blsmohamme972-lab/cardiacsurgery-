/**
 * IndexedDB connection, schema, migrations and promise helpers.
 *
 * Only `store/repo.js` should import this module.
 *
 * Resilience:
 * - The connection is a lazily opened singleton; a failed or hung open is
 *   retried once (Safari can fail or stall the first open after a resume).
 * - A connection that closes unexpectedly (Safari, user cleared data) is
 *   reopened on the next call; transaction creation on a closing connection
 *   is retried once on a fresh connection.
 * - `onversionchange` (another tab upgraded the schema) closes the connection
 *   and emits `db:versionchange` so the shell can ask for a reload.
 * - Quota errors emit `storage:error` with a plain-language message.
 *
 * Importing this module does not touch `indexedDB` or `window`.
 *
 * @module core/store/db
 */

import { bus } from '../events.js';

export const DB_NAME = 'cardiac-mcq';
export const DB_VERSION = 4;

/** Time allowed for one open attempt before it is treated as hung. */
const OPEN_TIMEOUT_MS = 8000;
/** Pause before the single retry. */
const RETRY_DELAY_MS = 150;

/**
 * Current schema (keyPath, autoIncrement, index names). Index names equal
 * their key paths. Migrations below are the source of truth for creation;
 * this map describes the latest version for other modules (repo key paths).
 * @type {Readonly<Record<string, Readonly<{ keyPath: string, autoIncrement?: boolean, indexes: readonly string[] }>>>}
 */
export const SCHEMA = Object.freeze({
  settings: Object.freeze({ keyPath: 'key', indexes: Object.freeze([]) }),
  qstate: Object.freeze({ keyPath: 'qid', indexes: Object.freeze([]) }),
  attempts: Object.freeze({ keyPath: 'id', autoIncrement: true, indexes: Object.freeze(['qid', 'ts', 'sessionId']) }),
  notes: Object.freeze({ keyPath: 'qid', indexes: Object.freeze(['updated']) }),
  highlights: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['qid']) }),
  ink: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['qid']) }),
  voice: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['qid', 'ts']) }),
  reports: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['qid']) }),
  reviews: Object.freeze({ keyPath: 'qid', indexes: Object.freeze([]) }),
  sessions: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['updatedAt']) }),
  media: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['qid', 'ts']) }),
  books: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['updated']) }),
  bookfiles: Object.freeze({ keyPath: 'id', indexes: Object.freeze([]) }),
  pdfnotes: Object.freeze({ keyPath: 'id', indexes: Object.freeze(['bookId']) }),
  wholebook: Object.freeze({ keyPath: 'id', indexes: Object.freeze([]) }),
});

/**
 * Error with a plain-language `message` safe to show to the user.
 * `code` keeps the original DOMException name; `cause` keeps the original error.
 */
export class StorageError extends Error {
  /**
   * @param {string} message User-facing message.
   * @param {{ code?: string, cause?: unknown }} [info]
   */
  constructor(message, { code = 'StorageError', cause } = {}) {
    super(message);
    this.name = 'StorageError';
    /** @type {string} */
    this.code = code;
    /** @type {string} */
    this.userMessage = message;
    if (cause !== undefined) this.cause = cause;
  }
}

const MESSAGES = Object.freeze({
  unsupported: "This browser can't save your progress here. Try Safari or Chrome outside private browsing.",
  quota: 'Your device storage is full. Free up some space or export a backup, then try again.',
  version: 'A newer version of the app is open. Please reload.',
  blocked: 'Please close other open copies of this app to finish the update.',
  open: "Couldn't open your saved data. Please reload the app.",
});

/**
 * @param {IDBDatabase} db
 * @param {IDBTransaction} tx
 * @param {string} name
 * @param {{ keyPath: string, autoIncrement?: boolean }} options
 * @param {string[]} indexes
 */
function ensureStore(db, tx, name, options, indexes) {
  const store = db.objectStoreNames.contains(name)
    ? tx.objectStore(name)
    : db.createObjectStore(name, options);
  for (const index of indexes) {
    if (!store.indexNames.contains(index)) store.createIndex(index, index, { unique: false });
  }
}

/**
 * Schema migrations, indexed by the version they upgrade TO.
 * Each receives `(db, tx, oldVersion)` inside the versionchange transaction.
 * Never edit a shipped migration; append a new one and bump DB_VERSION.
 * @type {Array<null | ((db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void)>}
 */
export const migrations = [
  null,
  // v1: initial schema (docs/ARCHITECTURE.md §4). Idempotent.
  (db, tx) => {
    ensureStore(db, tx, 'settings', { keyPath: 'key' }, []);
    ensureStore(db, tx, 'qstate', { keyPath: 'qid' }, []);
    ensureStore(db, tx, 'attempts', { keyPath: 'id', autoIncrement: true }, ['qid', 'ts', 'sessionId']);
    ensureStore(db, tx, 'notes', { keyPath: 'qid' }, ['updated']);
    ensureStore(db, tx, 'highlights', { keyPath: 'id' }, ['qid']);
    ensureStore(db, tx, 'ink', { keyPath: 'id' }, ['qid']);
    ensureStore(db, tx, 'voice', { keyPath: 'id' }, ['qid', 'ts']);
    ensureStore(db, tx, 'reports', { keyPath: 'id' }, ['qid']);
    ensureStore(db, tx, 'reviews', { keyPath: 'qid' }, []);
    ensureStore(db, tx, 'sessions', { keyPath: 'id' }, ['updatedAt']);
  },
  // v2: `media` store for images the user adds in the scratchpad (§4, §7.16).
  // Additive only: every v1 store and record is left untouched. Idempotent.
  (db, tx) => {
    ensureStore(db, tx, 'media', { keyPath: 'id' }, ['qid', 'ts']);
  },
  // v3: the Book tab (§7.17). `books` holds each imported chapter PDF's small
  // metadata record (reading position included), `bookfiles` its PDF blob
  // (`{id, blob}`, same id) so saving the position never rewrites the large
  // file, and `pdfnotes` the per-page annotations. Additive only: every v1/v2
  // store and record is left untouched. Idempotent.
  (db, tx) => {
    ensureStore(db, tx, 'books', { keyPath: 'id' }, ['updated']);
    ensureStore(db, tx, 'bookfiles', { keyPath: 'id' }, []);
    ensureStore(db, tx, 'pdfnotes', { keyPath: 'id' }, ['bookId']);
  },
  // v4: "Add the whole book once" (§7.17). `wholebook` holds two records: `meta`
  // (file name, size, page count, the detected chapter → page-range map and the
  // reading position per chapter) and `file` (`{id: 'file', blob}`, the one big
  // PDF), so saving a position or the map never rewrites the large file.
  // Additive only: every v1–v3 store and record is left untouched. Idempotent.
  (db, tx) => {
    ensureStore(db, tx, 'wholebook', { keyPath: 'id' }, []);
  },
];

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;
/** Set once another tab upgraded the schema; this tab must reload. */
let versionChanged = false;
let blockedReported = false;

/**
 * True for quota / out-of-space errors across browsers.
 * @param {any} err
 * @returns {boolean}
 */
export function isQuotaError(err) {
  if (!err) return false;
  const name = String(err.name || err.code || '');
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22) return true;
  if (err instanceof StorageError && err.code === 'QuotaExceededError') return true;
  return /quota|disk is full|not enough space|storage.*full/i.test(String(err.message || ''));
}

/**
 * Emits `storage:error` for quota errors and returns a friendly error to throw.
 * Other errors are returned unchanged.
 * @param {any} err
 * @returns {any}
 */
function handleError(err) {
  if (err instanceof StorageError) return err;
  if (isQuotaError(err)) {
    const friendly = new StorageError(MESSAGES.quota, { code: 'QuotaExceededError', cause: err });
    bus.emit('storage:error', { name: 'QuotaExceededError', message: MESSAGES.quota });
    return friendly;
  }
  return err;
}

/**
 * @param {IDBDatabase} db
 * @param {IDBTransaction} tx
 * @param {number} oldVersion
 * @param {number} newVersion
 */
function runMigrations(db, tx, oldVersion, newVersion) {
  for (let v = oldVersion + 1; v <= newVersion; v++) {
    const migrate = migrations[v];
    if (typeof migrate === 'function') migrate(db, tx, oldVersion);
  }
}

/**
 * One open attempt with a hang timeout.
 * @returns {Promise<IDBDatabase>}
 */
function openOnce() {
  return new Promise((resolve, reject) => {
    /** @type {IDBOpenDBRequest} */
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new StorageError(MESSAGES.open, { code: 'TimeoutError' }));
    }, OPEN_TIMEOUT_MS);
    const stopTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    req.onupgradeneeded = (event) => {
      const db = req.result;
      const upgradeTx = /** @type {IDBTransaction} */ (req.transaction);
      try {
        runMigrations(db, upgradeTx, event.oldVersion, event.newVersion ?? DB_VERSION);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[db] Migration failed:', err);
        try {
          upgradeTx.abort();
        } catch {
          /* already aborted */
        }
      }
    };
    req.onblocked = () => {
      // Another tab still holds an older connection. Keep waiting (it gets a
      // versionchange and closes), but tell the user what is going on.
      stopTimer();
      if (!blockedReported) {
        blockedReported = true;
        bus.emit('storage:error', { name: 'VersionBlocked', message: MESSAGES.blocked });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      stopTimer();
      if (settled) {
        // A late success after a timeout: the retry owns the connection.
        db.close();
        return;
      }
      settled = true;
      resolve(db);
    };
    req.onerror = (event) => {
      stopTimer();
      event.preventDefault?.();
      if (settled) return;
      settled = true;
      reject(req.error || new StorageError(MESSAGES.open));
    };
  });
}

/**
 * Wires lifecycle handlers on a fresh connection.
 * @param {IDBDatabase} db
 */
function wire(db) {
  db.onversionchange = () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    versionChanged = true;
    dbPromise = null;
    bus.emit('db:versionchange', { name: DB_NAME });
  };
  // Fired only on abnormal closes (e.g. storage cleared, Safari connection loss).
  /** @type {any} */ (db).onclose = () => {
    dbPromise = null;
  };
}

/**
 * Opens (once) and returns the database connection. Runs migrations.
 * Rejects with a {@link StorageError} carrying a user-facing message.
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (versionChanged) {
    return Promise.reject(new StorageError(MESSAGES.version, { code: 'VersionError' }));
  }
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined' || !indexedDB) {
    return Promise.reject(new StorageError(MESSAGES.unsupported, { code: 'NotSupportedError' }));
  }
  const attempt = (async () => {
    try {
      return await openOnce();
    } catch (first) {
      // VersionError: the stored DB is newer than this code. Retrying can't help.
      if (/** @type {any} */ (first)?.name === 'VersionError') throw first;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return openOnce();
    }
  })();
  dbPromise = attempt.then(
    (db) => {
      wire(db);
      return db;
    },
    (err) => {
      dbPromise = null;
      // eslint-disable-next-line no-console
      console.error('[db] Could not open the database:', err);
      if (err instanceof StorageError) throw err;
      if (err?.name === 'VersionError') {
        throw new StorageError(MESSAGES.version, { code: 'VersionError', cause: err });
      }
      if (isQuotaError(err)) throw handleError(err);
      const code = err?.name || 'UnknownError';
      // Firefox private mode reports InvalidStateError; treat as unsupported.
      const message = code === 'InvalidStateError' || code === 'SecurityError' ? MESSAGES.unsupported : MESSAGES.open;
      throw new StorageError(message, { code, cause: err });
    },
  );
  return dbPromise;
}

/**
 * Closes the connection (used by tests and before deleting data). Safe to call any time.
 * @returns {Promise<void>}
 */
export async function closeDB() {
  const p = dbPromise;
  dbPromise = null;
  if (!p) return;
  try {
    (await p).close();
  } catch {
    /* ignore */
  }
}

/**
 * Wraps an IDBRequest in a promise.
 * @param {IDBRequest} request
 * @returns {Promise<any>} Resolves with `request.result`, rejects with `request.error`.
 */
export function reqP(request) {
  return new Promise((resolve, reject) => {
    if (request.readyState === 'done') {
      if (request.error) reject(request.error);
      else resolve(request.result);
      return;
    }
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

/**
 * @param {unknown} v
 * @returns {v is IDBRequest}
 */
function isRequest(v) {
  return typeof IDBRequest !== 'undefined' && v instanceof IDBRequest;
}

/**
 * Runs `fn` inside one transaction and resolves with its (awaited) result
 * only after the transaction COMPLETES (so writes are durable).
 *
 * `fn` receives `{ [storeName]: IDBObjectStore }`. It may return a value, an
 * IDBRequest, an array of IDBRequests, or a promise (e.g. an async function
 * that awaits `reqP(...)`). Only await IndexedDB requests inside `fn`;
 * awaiting anything else lets the transaction auto-commit.
 *
 * @template T
 * @param {string | string[]} stores
 * @param {IDBTransactionMode} mode `'readonly'` or `'readwrite'`.
 * @param {(stores: Record<string, IDBObjectStore>) => T | Promise<T>} fn
 * @returns {Promise<any>}
 */
export async function tx(stores, mode, fn) {
  const names = Array.isArray(stores) ? stores : [stores];
  if (names.length === 0) throw new TypeError('tx(): at least one store name is required');
  let db = await openDB();
  /** @type {IDBTransaction} */
  let t;
  try {
    t = db.transaction(names, mode);
  } catch (err) {
    if (/** @type {any} */ (err)?.name !== 'InvalidStateError') throw err;
    // The connection is closing (Safari after a long background). Reconnect once.
    dbPromise = null;
    db = await openDB();
    t = db.transaction(names, mode);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {any} */
    let result;
    /** @type {any} */
    let lastRequestError = null;
    /** @param {any} err */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      const e = handleError(err ?? new DOMException('Transaction aborted', 'AbortError'));
      if (e?.name === 'UnknownError' || e?.name === 'InvalidStateError') dbPromise = null;
      reject(e);
    };
    t.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    // Request errors bubble here. They abort the transaction unless a caller
    // called preventDefault(), so only remember them; `abort` decides.
    t.onerror = (event) => {
      lastRequestError = /** @type {any} */ (event.target)?.error ?? lastRequestError;
    };
    t.onabort = () => fail(t.error ?? lastRequestError);

    /** @type {Record<string, IDBObjectStore>} */
    const map = {};
    try {
      for (const name of names) map[name] = t.objectStore(name);
      let out = fn(map);
      if (isRequest(out)) out = reqP(out);
      else if (Array.isArray(out) && out.length && out.every(isRequest)) out = Promise.all(out.map(reqP));
      Promise.resolve(out).then(
        (value) => {
          result = value;
        },
        (err) => {
          if (settled) {
            // fn kept running after the transaction finished (it awaited a
            // non-IndexedDB promise). Nothing to roll back; make it visible.
            // eslint-disable-next-line no-console
            console.error('[db] Transaction callback failed after the transaction finished:', err);
            return;
          }
          try {
            t.abort();
          } catch {
            /* already finished */
          }
          fail(err);
        },
      );
    } catch (err) {
      try {
        t.abort();
      } catch {
        /* already finished */
      }
      fail(err);
    }
  });
}

/**
 * @typedef {{ index?: string, query?: IDBValidKey | IDBKeyRange | null, count?: number }} QueryOptions
 */

/**
 * Reads one record by key.
 * @param {string} store
 * @param {IDBValidKey} key
 * @returns {Promise<any | null>} The record, or null when missing.
 */
export async function get(store, key) {
  const value = await tx(store, 'readonly', (s) => s[store].get(key));
  return value === undefined ? null : value;
}

/**
 * Reads all records of a store, optionally through an index and key/range.
 * @param {string} store
 * @param {QueryOptions} [options]
 * @returns {Promise<any[]>}
 */
export async function getAll(store, { index, query, count } = {}) {
  const value = await tx(store, 'readonly', (s) => {
    const source = index ? s[store].index(index) : s[store];
    if (count !== undefined) return source.getAll(query ?? null, count);
    if (query !== undefined && query !== null) return source.getAll(query);
    return source.getAll();
  });
  return Array.isArray(value) ? value : [];
}

/**
 * All records whose `index` matches `query` (a key or IDBKeyRange).
 * @param {string} store
 * @param {string} index
 * @param {IDBValidKey | IDBKeyRange} query
 * @returns {Promise<any[]>}
 */
export function getAllByIndex(store, index, query) {
  return getAll(store, { index, query });
}

/**
 * Inserts or replaces a record.
 * @param {string} store
 * @param {any} value
 * @returns {Promise<IDBValidKey>} The record's key.
 */
export function put(store, value) {
  return tx(store, 'readwrite', (s) => s[store].put(value));
}

/**
 * Deletes one record (no error when missing).
 * @param {string} store
 * @param {IDBValidKey | IDBKeyRange} key
 * @returns {Promise<void>}
 */
export async function del(store, key) {
  await tx(store, 'readwrite', (s) => s[store].delete(key));
}

/**
 * Deletes every record of a store.
 * @param {string} store
 * @returns {Promise<void>}
 */
export async function clear(store) {
  await tx(store, 'readwrite', (s) => s[store].clear());
}

/**
 * Counts records, optionally through an index and key/range.
 * @param {string} store
 * @param {QueryOptions} [options]
 * @returns {Promise<number>}
 */
export async function count(store, { index, query } = {}) {
  const n = await tx(store, 'readonly', (s) => {
    const source = index ? s[store].index(index) : s[store];
    return query !== undefined && query !== null ? source.count(query) : source.count();
  });
  return Number(n) || 0;
}
