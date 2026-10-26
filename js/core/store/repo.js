/**
 * Repositories: the only code that talks to `store/db.js`.
 *
 * Every successful write emits `bus.emit('store:change', { store, key })`
 * after the transaction commits. Bulk operations emit once with `key: null`.
 * Missing records read as `null` (single gets) or `[]` (lists).
 *
 * @module core/store/repo
 */

import { bus } from '../events.js';
import { uid } from '../util.js';
import * as db from './db.js';

/**
 * @typedef {{ due: number, interval: number, ease: number, reps: number, lapses: number }} Srs
 * @typedef {{ qid: string, seen: number, correct: number, incorrect: number, totalMs: number,
 *   lastChoice: string | null, lastCorrect: boolean | null, lastTs: number | null,
 *   bookmarked: boolean, srs: Srs | null, updated?: number }} QState
 * @typedef {{ id?: number, qid: string, choice: string | null, correct: boolean, ms: number,
 *   ts: number, mode: string, sessionId: string | null }} Attempt
 * @typedef {{ qid: string, text: string, updated: number }} Note
 * @typedef {{ id: string, qid: string, qversion: number, block: string, quote: string,
 *   prefix: string, suffix: string, start: number, color: string, ts: number, updated?: number }} Highlight
 * @typedef {{ tool: 'pen' | 'hl', color: string, size: number, pts: number[] }} Stroke
 * @typedef {{ id: string, qid: string, block: string, qversion: number, strokes: Stroke[], updated: number }} InkRecord
 * @typedef {{ id: string, qid: string, blob: Blob | null, mime: string, durationMs: number, ts: number }} VoiceNote
 * @typedef {{ id: string, qid: string, qversion: number, reason: string, text: string, ts: number }} Report
 * @typedef {{ qid: string, qversion: number, status: 'ok' | 'fix', comment: string, ts: number }} Review
 * @typedef {Record<string, any> & { id: string, updatedAt: number, finishedAt: number | null }} Session
 */

/** Every object store, in a stable order (used by backup). */
export const ALL_STORES = Object.freeze([
  'settings',
  'qstate',
  'attempts',
  'notes',
  'highlights',
  'ink',
  'voice',
  'reports',
  'reviews',
  'sessions',
]);

/** Settings keys that a backup import must never overwrite. */
const IMPORT_PROTECTED_SETTINGS = new Set(['lastRoute']);

/**
 * @param {string} store
 * @param {IDBValidKey | null} key
 */
function changed(store, key) {
  bus.emit('store:change', { store, key });
}

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {string}
 */
function requireId(v, what) {
  if (typeof v !== 'string' || v === '') throw new TypeError(`${what} must be a non-empty string`);
  return v;
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {any[]} list
 * @param {string} field
 * @param {1 | -1} [dir]
 */
function sortBy(list, field, dir = 1) {
  return list.sort((a, b) => (num(a?.[field]) - num(b?.[field])) * dir);
}

/** Serialises async work per key so read-modify-write updates never interleave. */
const locks = new Map();

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function withLock(key, task) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/**
 * Time used to decide which copy of a record is newer during a merge.
 * @param {any} r
 * @returns {number}
 */
function recordTime(r) {
  if (!r || typeof r !== 'object') return 0;
  return num(r.updated ?? r.updatedAt ?? r.ts ?? r.lastTs ?? r.createdAt ?? 0);
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/** Key/value settings (`{key, value}` records). */
export const settingsRepo = Object.freeze({
  /**
   * @param {string} key
   * @returns {Promise<any>} The stored value, or `undefined` when never set.
   */
  async get(key) {
    const rec = await db.get('settings', requireId(key, 'settings key'));
    return rec ? rec.value : undefined;
  },

  /**
   * @param {string} key
   * @param {any} value Any structured-cloneable value.
   * @returns {Promise<void>}
   */
  async set(key, value) {
    requireId(key, 'settings key');
    await db.put('settings', { key, value });
    changed('settings', key);
  },

  /**
   * @returns {Promise<Record<string, any>>} `{ key: value }` for every stored setting.
   */
  async all() {
    const rows = await db.getAll('settings');
    /** @type {Record<string, any>} */
    const out = {};
    for (const row of rows) if (row && typeof row.key === 'string') out[row.key] = row.value;
    return out;
  },
});

// ---------------------------------------------------------------------------
// qstate
// ---------------------------------------------------------------------------

/**
 * A fresh per-question state (not yet stored).
 * @param {string} qid
 * @returns {QState}
 */
export function emptyQState(qid) {
  return {
    qid,
    seen: 0,
    correct: 0,
    incorrect: 0,
    totalMs: 0,
    lastChoice: null,
    lastCorrect: null,
    lastTs: null,
    bookmarked: false,
    srs: null,
  };
}

/**
 * @param {QState} state
 * @returns {QState}
 */
function normalizeQState(state) {
  if (!state || typeof state !== 'object') throw new TypeError('qstate must be an object');
  const qid = requireId(state.qid, 'qstate.qid');
  return { ...emptyQState(qid), ...state, qid, updated: Date.now() };
}

/** Per-question progress (seen, correct, bookmark, SRS). */
export const qstateRepo = Object.freeze({
  /**
   * @param {string} qid
   * @returns {Promise<QState | null>}
   */
  get(qid) {
    return db.get('qstate', requireId(qid, 'qid'));
  },

  /** @returns {Promise<QState[]>} */
  all() {
    return db.getAll('qstate');
  },

  /**
   * Stores a full state (missing fields get defaults).
   * @param {QState} state
   * @returns {Promise<QState>} The stored record.
   */
  put(state) {
    const rec = normalizeQState(state);
    return withLock(`qstate:${rec.qid}`, async () => {
      await db.put('qstate', rec);
      changed('qstate', rec.qid);
      return rec;
    });
  },

  /**
   * Atomic read-modify-write for one question (serialised per qid).
   * `fn` receives the stored state (a copy) or `null`, and returns the next
   * state (sync or async). Returning `null`/`undefined` leaves it unchanged.
   * @param {string} qid
   * @param {(prev: QState | null) => QState | null | undefined | Promise<QState | null | undefined>} fn
   * @returns {Promise<QState | null>} The stored state after the update.
   */
  update(qid, fn) {
    requireId(qid, 'qid');
    if (typeof fn !== 'function') throw new TypeError('qstateRepo.update needs a function');
    return withLock(`qstate:${qid}`, async () => {
      const prev = await db.get('qstate', qid);
      const next = await fn(prev ? structuredCloneSafe(prev) : null);
      if (next === null || next === undefined) return prev;
      const rec = normalizeQState({ ...next, qid });
      await db.put('qstate', rec);
      changed('qstate', qid);
      return rec;
    });
  },
});

/**
 * Deep copy for plain records (so callers can't mutate what `update` compares).
 * @template T
 * @param {T} value
 * @returns {T}
 */
function structuredCloneSafe(value) {
  try {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// attempts
// ---------------------------------------------------------------------------

/** Answer history (append-only). */
export const attemptsRepo = Object.freeze({
  /**
   * Appends an attempt. `ts` defaults to now; `id` is assigned by the database.
   * @param {Omit<Attempt, 'id'> & { id?: number }} a
   * @returns {Promise<Attempt>} The stored attempt with its id.
   */
  async add(a) {
    if (!a || typeof a !== 'object') throw new TypeError('attempt must be an object');
    /** @type {Attempt} */
    const rec = {
      ...a,
      qid: requireId(a.qid, 'attempt.qid'),
      choice: a.choice ?? null,
      correct: Boolean(a.correct),
      ms: Math.max(0, Math.round(num(a.ms))),
      ts: Number.isFinite(a.ts) ? a.ts : Date.now(),
      mode: a.mode ?? 'tutor',
      sessionId: a.sessionId ?? null,
    };
    delete rec.id;
    const id = await db.put('attempts', rec);
    rec.id = /** @type {number} */ (id);
    changed('attempts', id);
    return rec;
  },

  /**
   * @param {string} qid
   * @returns {Promise<Attempt[]>} Oldest first.
   */
  async byQid(qid) {
    return sortBy(await db.getAllByIndex('attempts', 'qid', requireId(qid, 'qid')), 'ts');
  },

  /** @returns {Promise<Attempt[]>} In id (insertion) order. */
  all() {
    return db.getAll('attempts');
  },

  /**
   * Attempts with `ts >= since`, oldest first.
   * @param {number} ts
   * @returns {Promise<Attempt[]>}
   */
  since(ts) {
    return db.getAll('attempts', { index: 'ts', query: IDBKeyRange.lowerBound(num(ts)) });
  },
});

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

/** One text note per question. */
export const notesRepo = Object.freeze({
  /**
   * @param {string} qid
   * @returns {Promise<Note | null>}
   */
  get(qid) {
    return db.get('notes', requireId(qid, 'qid'));
  },

  /**
   * Saves the note, or deletes it when `text` is empty/whitespace.
   * @param {string} qid
   * @param {string} text
   * @returns {Promise<Note | null>} The stored note, or null when deleted.
   */
  set(qid, text) {
    requireId(qid, 'qid');
    const value = text == null ? '' : String(text);
    return withLock(`notes:${qid}`, async () => {
      if (value.trim() === '') {
        await db.del('notes', qid);
        changed('notes', qid);
        return null;
      }
      /** @type {Note} */
      const rec = { qid, text: value, updated: Date.now() };
      await db.put('notes', rec);
      changed('notes', qid);
      return rec;
    });
  },

  /** @returns {Promise<Note[]>} Most recently updated first. */
  async all() {
    return sortBy(await db.getAll('notes'), 'updated', -1);
  },
});

// ---------------------------------------------------------------------------
// highlights
// ---------------------------------------------------------------------------

/** Text highlights anchored to blocks. */
export const highlightsRepo = Object.freeze({
  /**
   * @param {string} qid
   * @returns {Promise<Highlight[]>} Oldest first.
   */
  async byQid(qid) {
    return sortBy(await db.getAllByIndex('highlights', 'qid', requireId(qid, 'qid')), 'ts');
  },

  /**
   * Stores a new highlight and assigns its `id` (and `ts` when missing).
   * @param {Omit<Highlight, 'id' | 'ts'> & { id?: string, ts?: number }} hl
   * @returns {Promise<Highlight>}
   */
  async add(hl) {
    if (!hl || typeof hl !== 'object') throw new TypeError('highlight must be an object');
    requireId(hl.qid, 'highlight.qid');
    /** @type {Highlight} */
    const rec = { ...hl, id: uid(), ts: Number.isFinite(hl.ts) ? /** @type {number} */ (hl.ts) : Date.now() };
    await db.put('highlights', rec);
    changed('highlights', rec.id);
    return rec;
  },

  /**
   * Replaces an existing highlight (e.g. new color). Sets `updated`.
   * @param {Highlight} hl
   * @returns {Promise<Highlight>}
   */
  async update(hl) {
    if (!hl || typeof hl !== 'object') throw new TypeError('highlight must be an object');
    requireId(hl.id, 'highlight.id');
    requireId(hl.qid, 'highlight.qid');
    const rec = { ...hl, updated: Date.now() };
    await db.put('highlights', rec);
    changed('highlights', rec.id);
    return rec;
  },

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    await db.del('highlights', requireId(id, 'highlight id'));
    changed('highlights', id);
  },

  /** @returns {Promise<Highlight[]>} Newest first. */
  async all() {
    return sortBy(await db.getAll('highlights'), 'ts', -1);
  },
});

// ---------------------------------------------------------------------------
// ink
// ---------------------------------------------------------------------------

/**
 * @param {string} qid
 * @param {string} block
 * @returns {string}
 */
export function inkId(qid, block) {
  return `${qid}|${block}`;
}

/** Hand-drawn ink, one record per question block. */
export const inkRepo = Object.freeze({
  /**
   * @param {string} qid
   * @param {string} block
   * @returns {Promise<InkRecord | null>}
   */
  get(qid, block) {
    return db.get('ink', inkId(requireId(qid, 'qid'), requireId(block, 'block')));
  },

  /**
   * @param {string} qid
   * @returns {Promise<InkRecord[]>}
   */
  byQid(qid) {
    return db.getAllByIndex('ink', 'qid', requireId(qid, 'qid'));
  },

  /**
   * Saves the strokes of one block, or deletes the record when there are none.
   * @param {string} qid
   * @param {string} block
   * @param {{ qversion: number, strokes: Stroke[] }} data
   * @returns {Promise<InkRecord | null>} The stored record, or null when deleted.
   */
  set(qid, block, { qversion, strokes } = /** @type {any} */ ({})) {
    requireId(qid, 'qid');
    requireId(block, 'block');
    const id = inkId(qid, block);
    return withLock(`ink:${id}`, async () => {
      if (!Array.isArray(strokes) || strokes.length === 0) {
        await db.del('ink', id);
        changed('ink', id);
        return null;
      }
      /** @type {InkRecord} */
      const rec = { id, qid, block, qversion: num(qversion) || 1, strokes, updated: Date.now() };
      await db.put('ink', rec);
      changed('ink', id);
      return rec;
    });
  },

  /** @returns {Promise<InkRecord[]>} */
  all() {
    return db.getAll('ink');
  },
});

// ---------------------------------------------------------------------------
// voice
// ---------------------------------------------------------------------------

/** Recorded voice notes (audio blobs). */
export const voiceRepo = Object.freeze({
  /**
   * @param {string} qid
   * @returns {Promise<VoiceNote[]>} Oldest first.
   */
  async byQid(qid) {
    return sortBy(await db.getAllByIndex('voice', 'qid', requireId(qid, 'qid')), 'ts');
  },

  /**
   * Stores a recording; assigns `id` and `ts`.
   * @param {{ qid: string, blob: Blob, mime?: string, durationMs?: number }} v
   * @returns {Promise<VoiceNote>}
   */
  async add({ qid, blob, mime, durationMs } = /** @type {any} */ ({})) {
    requireId(qid, 'voice.qid');
    if (!blob) throw new TypeError('voice note needs a blob');
    /** @type {VoiceNote} */
    const rec = {
      id: uid(),
      qid,
      blob,
      mime: mime || blob.type || 'audio/webm',
      durationMs: Math.max(0, Math.round(num(durationMs))),
      ts: Date.now(),
    };
    await db.put('voice', rec);
    changed('voice', rec.id);
    return rec;
  },

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    await db.del('voice', requireId(id, 'voice id'));
    changed('voice', id);
  },

  /** @returns {Promise<VoiceNote[]>} Newest first. */
  async all() {
    return sortBy(await db.getAll('voice'), 'ts', -1);
  },
});

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

/** "Report a problem" entries. */
export const reportsRepo = Object.freeze({
  /**
   * Stores a report; assigns `id` and `ts` when missing.
   * @param {Omit<Report, 'id' | 'ts'> & { id?: string, ts?: number }} r
   * @returns {Promise<Report>}
   */
  async add(r) {
    if (!r || typeof r !== 'object') throw new TypeError('report must be an object');
    requireId(r.qid, 'report.qid');
    /** @type {Report} */
    const rec = {
      ...r,
      id: typeof r.id === 'string' && r.id ? r.id : uid(),
      text: r.text == null ? '' : String(r.text),
      ts: Number.isFinite(r.ts) ? /** @type {number} */ (r.ts) : Date.now(),
    };
    await db.put('reports', rec);
    changed('reports', rec.id);
    return rec;
  },

  /**
   * @param {string} qid
   * @returns {Promise<Report[]>} Oldest first.
   */
  async byQid(qid) {
    return sortBy(await db.getAllByIndex('reports', 'qid', requireId(qid, 'qid')), 'ts');
  },

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    await db.del('reports', requireId(id, 'report id'));
    changed('reports', id);
  },

  /** @returns {Promise<Report[]>} Newest first. */
  async all() {
    return sortBy(await db.getAll('reports'), 'ts', -1);
  },
});

// ---------------------------------------------------------------------------
// reviews
// ---------------------------------------------------------------------------

const REVIEW_STATUSES = new Set(['ok', 'fix']);

/** Specialist reviewer verdicts, one per question. */
export const reviewsRepo = Object.freeze({
  /**
   * @param {string} qid
   * @returns {Promise<Review | null>}
   */
  get(qid) {
    return db.get('reviews', requireId(qid, 'qid'));
  },

  /**
   * @param {string} qid
   * @param {{ qversion: number, status: 'ok' | 'fix', comment?: string }} data
   * @returns {Promise<Review>}
   */
  async set(qid, { qversion, status, comment } = /** @type {any} */ ({})) {
    requireId(qid, 'qid');
    if (!REVIEW_STATUSES.has(status)) throw new TypeError("review status must be 'ok' or 'fix'");
    /** @type {Review} */
    const rec = { qid, qversion: num(qversion) || 1, status, comment: comment == null ? '' : String(comment), ts: Date.now() };
    await db.put('reviews', rec);
    changed('reviews', qid);
    return rec;
  },

  /**
   * @param {string} qid
   * @returns {Promise<void>}
   */
  async remove(qid) {
    await db.del('reviews', requireId(qid, 'qid'));
    changed('reviews', qid);
  },

  /** @returns {Promise<Review[]>} */
  all() {
    return db.getAll('reviews');
  },
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/**
 * @param {Session} s
 * @returns {Session}
 */
function normalizeSession(s) {
  if (!s || typeof s !== 'object') throw new TypeError('session must be an object');
  requireId(s.id, 'session.id');
  const updatedAt = Number.isFinite(s.updatedAt) ? s.updatedAt : Number.isFinite(s.createdAt) ? s.createdAt : Date.now();
  return { ...s, updatedAt, finishedAt: s.finishedAt ?? null };
}

/** Quiz sessions (practice and exam). */
export const sessionsRepo = Object.freeze({
  /**
   * @param {string} id
   * @returns {Promise<Session | null>}
   */
  get(id) {
    return db.get('sessions', requireId(id, 'session id'));
  },

  /**
   * Stores a session. Keeps the caller's `updatedAt` (sets it when missing).
   * @param {Session} s
   * @returns {Promise<Session>}
   */
  async put(s) {
    const rec = normalizeSession(s);
    await db.put('sessions', rec);
    changed('sessions', rec.id);
    return rec;
  },

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async remove(id) {
    await db.del('sessions', requireId(id, 'session id'));
    changed('sessions', id);
  },

  /** @returns {Promise<Session[]>} Most recently updated first. */
  async all() {
    return sortBy(await db.getAll('sessions'), 'updatedAt', -1);
  },

  /**
   * The most recently updated session that is not finished (`finishedAt` null).
   * @returns {Promise<Session | null>}
   */
  async latestUnfinished() {
    const found = await db.tx('sessions', 'readonly', (s) => {
      return new Promise((resolve, reject) => {
        const req = s.sessions.index('updatedAt').openCursor(null, 'prev');
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(null);
            return;
          }
          if (cursor.value && cursor.value.finishedAt == null) {
            resolve(cursor.value);
            return;
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    });
    return found ?? null;
  },
});

// ---------------------------------------------------------------------------
// Bulk (backup)
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 */
function assertStore(name) {
  if (!ALL_STORES.includes(name)) throw new TypeError(`Unknown store "${name}"`);
}

/**
 * Prepares one imported record, or returns null to skip it.
 * @param {string} name
 * @param {any} rec
 * @returns {any | null}
 */
function importable(name, rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const { keyPath, autoIncrement } = db.SCHEMA[name];
  const copy = { ...rec };
  if (autoIncrement) {
    if (!Number.isInteger(copy[keyPath]) || copy[keyPath] <= 0) delete copy[keyPath];
  } else {
    const key = copy[keyPath];
    if (typeof key !== 'string' || key === '') return null;
  }
  if (name === 'settings' && IMPORT_PROTECTED_SETTINGS.has(copy.key)) return null;
  if (name === 'attempts' && (typeof copy.qid !== 'string' || !Number.isFinite(copy.ts))) return null;
  if (name === 'sessions') {
    if (!Number.isFinite(copy.updatedAt)) copy.updatedAt = Number.isFinite(copy.createdAt) ? copy.createdAt : 0;
    if (copy.finishedAt === undefined) copy.finishedAt = null;
  }
  if (name === 'ink' && (!Array.isArray(copy.strokes) || copy.strokes.length === 0)) return null;
  return copy;
}

/**
 * Every record of a store, as stored (voice records keep their Blob).
 * @param {string} name
 * @returns {Promise<any[]>}
 */
export async function dumpStore(name) {
  assertStore(name);
  return db.getAll(name);
}

/**
 * Replaces the whole content of a store in one transaction.
 * Invalid records are skipped. For `settings`, the device's `lastRoute` is kept.
 * @param {string} name
 * @param {any[]} records
 * @returns {Promise<{ written: number, skipped: number }>}
 */
export async function replaceStore(name, records) {
  assertStore(name);
  const list = Array.isArray(records) ? records : [];
  const result = await db.tx(name, 'readwrite', async (s) => {
    const store = s[name];
    /** @type {any[]} */
    const keep = [];
    if (name === 'settings') {
      for (const key of IMPORT_PROTECTED_SETTINGS) {
        const existing = await db.reqP(store.get(key));
        if (existing) keep.push(existing);
      }
    }
    store.clear();
    let written = 0;
    let skipped = 0;
    for (const rec of list) {
      const copy = importable(name, rec);
      if (!copy) {
        skipped++;
        continue;
      }
      store.put(copy);
      written++;
    }
    for (const rec of keep) store.put(rec);
    return { written, skipped };
  });
  changed(name, null);
  return result;
}

/**
 * Merges records into a store in one transaction:
 * - `attempts`: added unless one with the same `(qid, ts)` exists (new ids assigned).
 * - `settings`: only keys the device doesn't have yet (never `lastRoute`).
 * - others: added when missing; replaced when the incoming copy is newer
 *   (`updated` / `updatedAt` / `ts` / `lastTs`).
 * @param {string} name
 * @param {any[]} records
 * @returns {Promise<{ added: number, updated: number, skipped: number }>}
 */
export async function mergeStore(name, records) {
  assertStore(name);
  const list = Array.isArray(records) ? records : [];
  const { keyPath } = db.SCHEMA[name];
  const result = await db.tx(name, 'readwrite', async (s) => {
    const store = s[name];
    const existing = /** @type {any[]} */ (await db.reqP(store.getAll()));
    let added = 0;
    let updated = 0;
    let skipped = 0;

    if (name === 'attempts') {
      const seen = new Set(existing.map((a) => `${a.qid}|${a.ts}`));
      for (const rec of list) {
        const copy = importable(name, rec);
        const sig = copy ? `${copy.qid}|${copy.ts}` : '';
        if (!copy || typeof copy.qid !== 'string' || seen.has(sig)) {
          skipped++;
          continue;
        }
        delete copy.id;
        seen.add(sig);
        store.put(copy);
        added++;
      }
      return { added, updated, skipped };
    }

    const byKey = new Map(existing.map((r) => [r[keyPath], r]));
    for (const rec of list) {
      const copy = importable(name, rec);
      if (!copy) {
        skipped++;
        continue;
      }
      const current = byKey.get(copy[keyPath]);
      if (!current) {
        store.put(copy);
        byKey.set(copy[keyPath], copy);
        added++;
      } else if (name !== 'settings' && recordTime(copy) > recordTime(current)) {
        store.put(copy);
        byKey.set(copy[keyPath], copy);
        updated++;
      } else {
        skipped++;
      }
    }
    return { added, updated, skipped };
  });
  changed(name, null);
  return result;
}
