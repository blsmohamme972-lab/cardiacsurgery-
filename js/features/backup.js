/**
 * Backup export / import (docs/ARCHITECTURE.md §7.12).
 *
 * Backup file (JSON):
 * `{ type: 'cardiac-mcq-backup', formatVersion: 1, appVersion, exportedAt (ISO), includesMedia,
 *    stores: { [storeName]: records[] } }`
 * Voice records carry their audio as base64: `{ ...record, blob: null, data: '<base64>', mime }`.
 * Without media the `voice` store is omitted.
 *
 * Safety rules:
 * - A file is validated completely (shape of every record, per store, §4) before
 *   anything is written. A bad file throws {@link BackupError} with a plain-language
 *   `userMessage` and nothing on the device changes.
 * - Replace mode decodes every voice note first, takes a snapshot of every store it
 *   will replace, and puts the snapshot back if a write fails, so data is never
 *   left half-destroyed.
 * - Import never touches the device's `lastRoute` setting.
 * - Large backups: audio is converted to base64 in slices and the export JSON is
 *   assembled as Blob parts, so no single giant string is built.
 *
 * Pure parts (validation, merge planning, base64) are exported for unit tests.
 * Importing this module has no side effects (no DOM / IndexedDB access at import time).
 *
 * @module features/backup
 */

import { h } from '../core/dom.js';
import { ALL_STORES, dumpStore, mergeStore, replaceStore } from '../core/store/repo.js';
import { dayKey, formatNumber, plural } from '../core/util.js';
import { APP_VERSION } from '../version.js';
import { button, chip, confirmSheet, sheet, spinner, toast } from '../ui/components.js';
import { icon } from '../ui/icons.js';

/** `type` field of a backup file. */
export const BACKUP_TYPE = 'cardiac-mcq-backup';

/** Format version written by this app (and the newest it can read). */
export const BACKUP_FORMAT_VERSION = 1;

/** Largest backup file accepted (bytes). Bigger files can't be parsed safely on phones. */
export const MAX_BACKUP_BYTES = 300 * 1024 * 1024;

/** Most records accepted per store (guards against absurd or hostile files). */
export const MAX_RECORDS_PER_STORE = 2_000_000;

/** Settings that are device-specific: never exported, never imported. */
const DEVICE_SETTINGS = new Set(['lastRoute']);

/** Highlight colors (§4). */
const HL_COLORS = new Set(['yellow', 'green', 'blue', 'pink']);

/** Human labels for the stores (summary, toasts). */
export const STORE_LABELS = Object.freeze({
  qstate: 'Question progress',
  attempts: 'Answers',
  sessions: 'Quiz sessions',
  notes: 'Notes',
  highlights: 'Highlights',
  ink: 'Drawings',
  voice: 'Voice notes',
  reports: 'Problem reports',
  reviews: 'Reviews',
  settings: 'Settings',
});

const NOTHING_CHANGED = 'Nothing on this device was changed.';
const PICK_BACKUP = 'Choose a file named like cardiac-mcq-backup-2026-10-26.json.';

/**
 * Error with a plain-language `userMessage` (safe to show) and a stable `code`:
 * `empty` | `too-large` | `unreadable` | `not-json` | `wrong-type` | `newer-version` | `corrupt` |
 * `quota` | `import-failed` | `save-failed`. `details` lists problems for developers.
 */
export class BackupError extends Error {
  /**
   * @param {string} code
   * @param {string} userMessage
   * @param {{ details?: string[], cause?: unknown }} [info]
   */
  constructor(code, userMessage, { details = [], cause } = {}) {
    super(userMessage);
    this.name = 'BackupError';
    /** @type {string} */
    this.code = code;
    /** @type {string} */
    this.userMessage = userMessage;
    /** @type {string[]} */
    this.details = details;
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Base64 (chunked; no giant intermediate strings)
// ---------------------------------------------------------------------------

/** Bytes per btoa() call. A multiple of 3, so the pieces can simply be concatenated. */
const B64_ENCODE_CHUNK = 3 * 10240;
/** Characters per atob() call. A multiple of 4. */
const B64_DECODE_CHUNK = 4 * 16384;
/** Bytes read from a Blob at a time (multiple of 3). */
const BLOB_SLICE = 3 * 262144;

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Base64 of `bytes`, as a list of pieces whose concatenation is the full base64 text.
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
export function bytesToBase64Parts(bytes) {
  /** @type {string[]} */
  const parts = [];
  for (let i = 0; i < bytes.length; i += B64_ENCODE_CHUNK) {
    const slice = bytes.subarray(i, i + B64_ENCODE_CHUNK);
    let binary = '';
    // fromCharCode.apply with ≤ 8192 args per call stays well under engine limits.
    for (let j = 0; j < slice.length; j += 8192) {
      binary += String.fromCharCode.apply(null, /** @type {any} */ (slice.subarray(j, j + 8192)));
    }
    parts.push(btoa(binary));
  }
  return parts;
}

/**
 * Base64 text of `bytes`.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  return bytesToBase64Parts(bytes).join('');
}

/**
 * True for canonical base64 text (no whitespace, correct padding). Empty string → true.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isBase64(s) {
  return typeof s === 'string' && s.length % 4 === 0 && B64_RE.test(s);
}

/**
 * Decodes base64 text to bytes (chunked). Throws `TypeError` for invalid text.
 * @param {string} s
 * @returns {Uint8Array}
 */
export function base64ToBytes(s) {
  if (!isBase64(s)) throw new TypeError('invalid base64');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += B64_DECODE_CHUNK) {
    const binary = atob(s.slice(i, i + B64_DECODE_CHUNK));
    for (let j = 0; j < binary.length; j++) out[o++] = binary.charCodeAt(j);
  }
  return out;
}

/**
 * Base64 of a Blob, read in slices, as concatenable pieces.
 * @param {Blob} blob
 * @returns {Promise<string[]>}
 */
export async function blobToBase64Parts(blob) {
  /** @type {string[]} */
  const parts = [];
  for (let offset = 0; offset < blob.size; offset += BLOB_SLICE) {
    const buf = await blob.slice(offset, offset + BLOB_SLICE).arrayBuffer();
    parts.push(bytesToBase64Parts(new Uint8Array(buf)).join(''));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

/** @param {unknown} v */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v */
const isStr = (v) => typeof v === 'string';
/** @param {unknown} v */
const isId = (v) => typeof v === 'string' && v !== '' && v.length <= 300;
/** @param {unknown} v */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
/** @param {unknown} v */
const isCount = (v) => isNum(v) && /** @type {number} */ (v) >= 0;
/** @param {unknown} v */
const isVersion = (v) => Number.isInteger(v) && /** @type {number} */ (v) >= 1;
/** @param {unknown} v */
const isBool = (v) => typeof v === 'boolean';
/**
 * @param {unknown} v
 * @param {(x: unknown) => boolean} check
 */
const optional = (v, check) => v === undefined || check(v);
/**
 * @param {unknown} v
 * @param {(x: unknown) => boolean} check
 */
const nullable = (v, check) => v === null || v === undefined || check(v);

/**
 * @param {unknown} s
 * @returns {boolean}
 */
function isStroke(s) {
  if (!isObj(s)) return false;
  const st = /** @type {any} */ (s);
  return (
    (st.tool === 'pen' || st.tool === 'hl') &&
    isStr(st.color) &&
    /^#[0-9a-fA-F]{6}$/.test(st.color) &&
    isNum(st.size) &&
    st.size > 0 &&
    Array.isArray(st.pts) &&
    st.pts.length % 3 === 0 &&
    st.pts.every(isNum)
  );
}

/**
 * Per-store record checks (§4). Each returns `null` when the record is fine,
 * else a short reason (for developers; users get a summary).
 * @type {Readonly<Record<string, (r: any) => string | null>>}
 */
export const RECORD_CHECKS = Object.freeze({
  settings: (r) => (!isId(r.key) ? 'key' : !('value' in r) ? 'value' : null),
  qstate: (r) => {
    if (!isId(r.qid)) return 'qid';
    for (const f of ['seen', 'correct', 'incorrect', 'totalMs']) if (!optional(r[f], isCount)) return f;
    if (!nullable(r.lastChoice, isStr)) return 'lastChoice';
    if (!nullable(r.lastCorrect, isBool)) return 'lastCorrect';
    if (!nullable(r.lastTs, isNum)) return 'lastTs';
    if (!optional(r.bookmarked, isBool)) return 'bookmarked';
    if (!optional(r.updated, isNum)) return 'updated';
    if (r.srs != null) {
      if (!isObj(r.srs)) return 'srs';
      for (const f of ['due', 'interval', 'ease', 'reps', 'lapses']) if (!isNum(r.srs[f])) return `srs.${f}`;
    }
    return null;
  },
  attempts: (r) => {
    if (!optional(r.id, (v) => Number.isInteger(v) && /** @type {number} */ (v) > 0)) return 'id';
    if (!isId(r.qid)) return 'qid';
    if (!isNum(r.ts)) return 'ts';
    if (!isBool(r.correct)) return 'correct';
    if (!nullable(r.choice, isStr)) return 'choice';
    if (!optional(r.ms, isCount)) return 'ms';
    if (!optional(r.mode, isStr)) return 'mode';
    if (!nullable(r.sessionId, isStr)) return 'sessionId';
    return null;
  },
  notes: (r) => (!isId(r.qid) ? 'qid' : !isStr(r.text) ? 'text' : !isNum(r.updated) ? 'updated' : null),
  highlights: (r) => {
    if (!isId(r.id)) return 'id';
    if (!isId(r.qid)) return 'qid';
    if (!isId(r.block)) return 'block';
    if (!isStr(r.quote) || r.quote === '') return 'quote';
    if (!optional(r.prefix, isStr)) return 'prefix';
    if (!optional(r.suffix, isStr)) return 'suffix';
    if (!optional(r.start, isCount)) return 'start';
    if (!HL_COLORS.has(r.color)) return 'color';
    if (!optional(r.qversion, isVersion)) return 'qversion';
    if (!isNum(r.ts)) return 'ts';
    return null;
  },
  ink: (r) => {
    if (!isId(r.qid)) return 'qid';
    if (!isId(r.block)) return 'block';
    if (r.id !== `${r.qid}|${r.block}`) return 'id';
    if (!optional(r.qversion, isVersion)) return 'qversion';
    if (!Array.isArray(r.strokes) || r.strokes.length === 0 || !r.strokes.every(isStroke)) return 'strokes';
    if (!isNum(r.updated)) return 'updated';
    return null;
  },
  voice: (r) => {
    if (!isId(r.id)) return 'id';
    if (!isId(r.qid)) return 'qid';
    if (r.blob !== null && r.blob !== undefined) return 'blob';
    if (!isStr(r.data) || r.data === '' || !isBase64(r.data)) return 'data';
    if (!isStr(r.mime) || !/^[a-z]+\/[a-z0-9.+-]+/i.test(r.mime) || r.mime.length > 120) return 'mime';
    if (!optional(r.durationMs, isCount)) return 'durationMs';
    if (!isNum(r.ts)) return 'ts';
    return null;
  },
  reports: (r) => {
    if (!isId(r.id)) return 'id';
    if (!isId(r.qid)) return 'qid';
    if (!optional(r.qversion, isVersion)) return 'qversion';
    if (!isStr(r.reason) || r.reason === '') return 'reason';
    if (!optional(r.text, isStr)) return 'text';
    if (!isNum(r.ts)) return 'ts';
    return null;
  },
  reviews: (r) => {
    if (!isId(r.qid)) return 'qid';
    if (!optional(r.qversion, isVersion)) return 'qversion';
    if (r.status !== 'ok' && r.status !== 'fix') return 'status';
    if (!optional(r.comment, isStr)) return 'comment';
    if (!isNum(r.ts)) return 'ts';
    return null;
  },
  sessions: (r) => {
    if (!isId(r.id)) return 'id';
    if (!isNum(r.updatedAt) && !isNum(r.createdAt)) return 'updatedAt';
    if (!nullable(r.finishedAt, isNum)) return 'finishedAt';
    return null;
  },
});

/**
 * @typedef {{ counts: Record<string, number>, total: number, exportedAt: string, exportedAtMs: number,
 *   includesMedia: boolean, appVersion: string, formatVersion: number, ignoredStores: string[] }} BackupSummary
 * @typedef {{ type: string, formatVersion: number, appVersion: string, exportedAt: string,
 *   includesMedia: boolean, stores: Record<string, any[]> }} BackupData
 */

/** Objects that passed {@link validateBackup} (so import doesn't validate twice). */
const validated = new WeakSet();

/**
 * Strictly validates a parsed backup object. Throws {@link BackupError} with a
 * plain-language message for anything that isn't a usable backup.
 * Unknown stores (from a future app) are ignored and listed in `summary.ignoredStores`.
 *
 * @param {unknown} obj
 * @returns {{ data: BackupData, summary: BackupSummary }}
 */
export function validateBackup(obj) {
  if (!isObj(obj)) throw new BackupError('not-json', `This isn't a Cardiac MCQ backup file. ${PICK_BACKUP}`);
  const o = /** @type {any} */ (obj);
  if (o.type !== BACKUP_TYPE) {
    if (o.type === 'cardiac-mcq-review') {
      throw new BackupError('wrong-type', `This is a review file, not a backup. ${PICK_BACKUP}`);
    }
    throw new BackupError('wrong-type', `This isn't a Cardiac MCQ backup file. ${PICK_BACKUP}`);
  }
  if (!Number.isInteger(o.formatVersion) || o.formatVersion < 1) {
    throw corrupt(['formatVersion']);
  }
  if (o.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      'newer-version',
      'This backup was made by a newer version of the app. Update the app first (Settings > About > Check for update), then import it again.',
    );
  }
  const exportedAtMs = isStr(o.exportedAt) ? Date.parse(o.exportedAt) : NaN;
  /** @type {string[]} */
  const details = [];
  if (!Number.isFinite(exportedAtMs)) details.push('exportedAt');
  if (!optional(o.appVersion, isStr)) details.push('appVersion');
  if (!optional(o.includesMedia, isBool)) details.push('includesMedia');
  if (!isObj(o.stores)) details.push('stores');
  if (details.length) throw corrupt(details);

  /** @type {Record<string, any[]>} */
  const stores = {};
  /** @type {Record<string, number>} */
  const counts = {};
  const ignoredStores = [];
  let bad = 0;
  let total = 0;
  for (const [name, records] of Object.entries(o.stores)) {
    if (!ALL_STORES.includes(name)) {
      ignoredStores.push(name);
      continue;
    }
    if (!Array.isArray(records)) {
      throw corrupt([`stores.${name} is not a list`]);
    }
    if (records.length > MAX_RECORDS_PER_STORE) throw corrupt([`stores.${name} has too many records`]);
    const check = RECORD_CHECKS[name];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      const problem = isObj(rec) ? check(rec) : 'not an object';
      if (problem) {
        bad++;
        if (details.length < 20) details.push(`${name}[${i}]: ${problem}`);
      }
    }
    stores[name] = records;
    counts[name] = records.length;
    total += records.length;
  }
  if (bad) throw corrupt(details, bad);

  for (const name of ALL_STORES) counts[name] ??= 0;
  const includesMedia = Array.isArray(stores.voice);
  /** @type {BackupData} */
  const data = {
    type: BACKUP_TYPE,
    formatVersion: o.formatVersion,
    appVersion: isStr(o.appVersion) ? o.appVersion : '',
    exportedAt: o.exportedAt,
    includesMedia,
    stores,
  };
  validated.add(data);
  return {
    data,
    summary: {
      counts,
      total,
      exportedAt: o.exportedAt,
      exportedAtMs,
      includesMedia,
      appVersion: data.appVersion,
      formatVersion: o.formatVersion,
      ignoredStores,
    },
  };
}

/**
 * @param {string[]} details
 * @param {number} [badCount]
 * @returns {BackupError}
 */
function corrupt(details, badCount = 0) {
  const what = badCount ? ` (${plural(badCount, 'item')} can't be read)` : '';
  return new BackupError(
    'corrupt',
    `This backup file is damaged and can't be used${what}. ${NOTHING_CHANGED} Try another backup file.`,
    { details },
  );
}

// ---------------------------------------------------------------------------
// Merge planning (pure; mirrors repo.mergeStore so voice audio is decoded only when needed)
// ---------------------------------------------------------------------------

/**
 * Time used to decide which copy is newer (same rule as repo.mergeStore).
 * @param {any} r
 * @returns {number}
 */
export function recordTime(r) {
  if (!isObj(r)) return 0;
  const v = Number(r.updated ?? r.updatedAt ?? r.ts ?? r.lastTs ?? r.createdAt ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/** Key path per store (§4). */
const KEY_PATHS = Object.freeze({
  settings: 'key',
  qstate: 'qid',
  attempts: 'id',
  notes: 'qid',
  highlights: 'id',
  ink: 'id',
  voice: 'id',
  reports: 'id',
  reviews: 'qid',
  sessions: 'id',
});

/**
 * Decides which incoming records a merge writes:
 * - `attempts`: added unless the device (or an earlier incoming record) has the same `(qid, ts)`.
 * - `settings`: only keys the device doesn't have; never device-specific keys (`lastRoute`).
 * - others: added when missing, replaced when the incoming copy is newer (`updated`/`ts`…);
 *   duplicates inside the file resolve to the newest copy.
 *
 * @param {string} name Store name.
 * @param {any[]} existing Records on the device.
 * @param {any[]} incoming Validated records from the backup.
 * @returns {{ write: any[], added: number, updated: number, skipped: number }}
 */
export function planMerge(name, existing, incoming) {
  const keyPath = /** @type {Record<string, string>} */ (KEY_PATHS)[name];
  if (!keyPath) throw new TypeError(`Unknown store "${name}"`);
  /** @type {any[]} */
  const write = [];
  let added = 0;
  let updated = 0;
  let skipped = 0;

  if (name === 'attempts') {
    const seen = new Set(existing.map((a) => `${a.qid}|${a.ts}`));
    for (const rec of incoming) {
      const sig = `${rec.qid}|${rec.ts}`;
      if (seen.has(sig)) {
        skipped++;
        continue;
      }
      seen.add(sig);
      const { id, ...rest } = rec;
      write.push(rest);
      added++;
    }
    return { write, added, updated, skipped };
  }

  const current = new Map(existing.map((r) => [r[keyPath], r]));
  /** @type {Map<string, { rec: any, isNew: boolean }>} */
  const chosen = new Map();
  for (const rec of incoming) {
    const key = rec[keyPath];
    if (name === 'settings' && DEVICE_SETTINGS.has(key)) {
      skipped++;
      continue;
    }
    const prevChoice = chosen.get(key);
    if (prevChoice) {
      // Duplicate inside the file: keep the newer copy.
      if (name !== 'settings' && recordTime(rec) > recordTime(prevChoice.rec)) prevChoice.rec = rec;
      skipped++;
      continue;
    }
    const onDevice = current.get(key);
    if (!onDevice) chosen.set(key, { rec, isNew: true });
    else if (name !== 'settings' && recordTime(rec) > recordTime(onDevice)) chosen.set(key, { rec, isNew: false });
    else skipped++;
  }
  for (const { rec, isNew } of chosen.values()) {
    write.push(rec);
    if (isNew) added++;
    else updated++;
  }
  return { write, added, updated, skipped };
}

/**
 * Turns a backup voice record into a stored one (base64 → Blob).
 * @param {any} rec
 * @returns {any}
 */
export function decodeVoiceRecord(rec) {
  const { data, ...rest } = rec;
  const bytes = base64ToBytes(data);
  return { ...rest, blob: new Blob([bytes], { type: rec.mime }) };
}

/**
 * Records ready to store for one store (voice decoded, device settings removed).
 * Throws BackupError 'corrupt' when audio can't be decoded.
 * @param {string} name
 * @param {any[]} records
 * @returns {any[]}
 */
function prepareRecords(name, records) {
  if (name === 'settings') return records.filter((r) => !DEVICE_SETTINGS.has(r.key));
  if (name !== 'voice') return records;
  try {
    return records.map(decodeVoiceRecord);
  } catch (err) {
    throw new BackupError('corrupt', `A voice note in this backup is damaged. ${NOTHING_CHANGED} Try another backup file.`, {
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Target size of one text part of the export Blob. */
const PART_TARGET = 512 * 1024;

/**
 * Builds a backup of everything on this device.
 * Voice audio is base64-encoded in slices and the JSON is assembled as Blob parts.
 * A voice note whose audio can't be read is left out (counted in `skipped`).
 *
 * @param {{ includeMedia?: boolean, now?: number, dump?: (name: string) => Promise<any[]> }} [opts]
 *   `now` and `dump` are for tests.
 * @returns {Promise<{ blob: Blob, filename: string, counts: Record<string, number>, skipped: number }>}
 *   Rejects with the repo's StorageError (plain `userMessage`) when the data can't be read.
 */
export async function exportBackup({ includeMedia = true, now = Date.now(), dump = dumpStore } = {}) {
  /** @type {BlobPart[]} */
  const parts = [];
  let buffer = '';
  /** @param {string} s */
  const push = (s) => {
    buffer += s;
    if (buffer.length >= PART_TARGET) {
      parts.push(buffer);
      buffer = '';
    }
  };
  const flush = () => {
    if (buffer) parts.push(buffer);
    buffer = '';
  };

  push(
    `{"type":${JSON.stringify(BACKUP_TYPE)},"formatVersion":${BACKUP_FORMAT_VERSION},` +
      `"appVersion":${JSON.stringify(APP_VERSION)},"exportedAt":${JSON.stringify(new Date(now).toISOString())},` +
      `"includesMedia":${includeMedia ? 'true' : 'false'},"stores":{`,
  );

  /** @type {Record<string, number>} */
  const counts = {};
  let skipped = 0;
  let firstStore = true;
  for (const name of ALL_STORES) {
    if (name === 'voice' && !includeMedia) continue;
    let records = await dump(name);
    if (name === 'settings') records = records.filter((r) => r && !DEVICE_SETTINGS.has(r.key));
    push(`${firstStore ? '' : ','}${JSON.stringify(name)}:[`);
    firstStore = false;
    let n = 0;
    for (const rec of records) {
      if (name === 'voice') {
        const blob = rec?.blob;
        /** @type {string[] | null} */
        let b64 = null;
        if (blob && typeof blob.arrayBuffer === 'function' && blob.size > 0) {
          try {
            b64 = await blobToBase64Parts(blob);
          } catch (err) {
            console.warn('[backup] a voice note could not be read; left out', err);
          }
        }
        if (!b64) {
          skipped++;
          continue;
        }
        const { blob: _blob, data: _data, ...rest } = rec;
        const head = JSON.stringify({ ...rest, blob: null, mime: rec.mime || blob.type || 'audio/webm' });
        push(`${n ? ',' : ''}${head.slice(0, -1)},"data":"`);
        flush();
        parts.push(...b64);
        push('"}');
      } else {
        push(`${n ? ',' : ''}${JSON.stringify(rec)}`);
      }
      n++;
    }
    push(']');
    counts[name] = n;
  }
  push('}}');
  flush();

  return {
    blob: new Blob(parts, { type: 'application/json' }),
    filename: `cardiac-mcq-backup-${dayKey(now)}.json`,
    counts,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Save file
// ---------------------------------------------------------------------------

/**
 * True on phones/tablets, where the share sheet is the natural way to save a file.
 * @returns {boolean}
 */
function prefersShareSheet() {
  try {
    return globalThis.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

/**
 * Saves a file: the share sheet with the file on touch devices that can share
 * files (iPhone/iPad: "Save to Files"), otherwise a download.
 * Closing the share sheet is not an error.
 *
 * @param {Blob} blob
 * @param {string} filename
 * @returns {Promise<'shared' | 'downloaded' | 'cancelled'>}
 *   Rejects with BackupError 'save-failed' when neither way works.
 */
export async function saveFile(blob, filename) {
  const nav = /** @type {any} */ (globalThis.navigator);
  if (nav && typeof nav.share === 'function' && typeof nav.canShare === 'function' && prefersShareSheet()) {
    try {
      const file = new File([blob], filename, { type: blob.type || 'application/json' });
      if (nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: filename });
        return 'shared';
      }
    } catch (err) {
      const name = /** @type {any} */ (err)?.name;
      if (name === 'AbortError') return 'cancelled';
      // NotAllowedError (no recent tap) or anything else: fall back to a download.
      if (name !== 'NotAllowedError') console.warn('[backup] share failed; downloading instead', err);
    }
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename, rel: 'noopener', hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    // Safari needs the URL a little longer than the click.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'downloaded';
  } catch (err) {
    throw new BackupError('save-failed', "Couldn't save the file. Please try again, or try another browser.", {
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Read + import
// ---------------------------------------------------------------------------

/**
 * Reads and strictly validates a backup file the user picked.
 * @param {Blob} file
 * @returns {Promise<{ data: BackupData, summary: BackupSummary }>} Rejects with {@link BackupError}.
 */
export async function readBackupFile(file) {
  if (!file || typeof file.size !== 'number' || typeof file.text !== 'function') {
    throw new BackupError('unreadable', `Couldn't open this file. ${PICK_BACKUP}`);
  }
  if (file.size === 0) throw new BackupError('empty', `This file is empty. ${PICK_BACKUP}`);
  if (file.size > MAX_BACKUP_BYTES) {
    throw new BackupError(
      'too-large',
      `This file is too big to be a backup (${formatBytes(file.size)}). ${PICK_BACKUP}`,
    );
  }
  let text;
  try {
    text = await file.text();
  } catch (err) {
    throw new BackupError('unreadable', "Couldn't read this file. Save it to your device first, then choose it again.", {
      cause: err,
    });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const start = text.trimStart()[0];
  if (start !== '{') throw new BackupError('not-json', `This isn't a Cardiac MCQ backup file. ${PICK_BACKUP}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Looks like ours but cut off (incomplete download/copy).
    if (text.slice(0, 200).includes(BACKUP_TYPE)) {
      throw new BackupError(
        'corrupt',
        `This backup file is incomplete or damaged. ${NOTHING_CHANGED} Export a new backup, or try another copy of the file.`,
        { cause: err },
      );
    }
    throw new BackupError('not-json', `This isn't a Cardiac MCQ backup file. ${PICK_BACKUP}`, { cause: err });
  }
  text = '';
  return validateBackup(parsed);
}

/**
 * Storage operations used by {@link importBackup} (injectable for tests).
 * @typedef {{ dump: (name: string) => Promise<any[]>,
 *   replace: (name: string, records: any[]) => Promise<{ written: number, skipped: number }>,
 *   merge: (name: string, records: any[]) => Promise<{ added: number, updated: number, skipped: number }> }} StoreAdapter
 */

/** @type {StoreAdapter} */
const REPO_ADAPTER = Object.freeze({ dump: dumpStore, replace: replaceStore, merge: mergeStore });

/**
 * @typedef {{ mode: 'merge' | 'replace', stores: Record<string, { added: number, updated: number, skipped: number }>,
 *   added: number, updated: number, skipped: number, keptVoice: boolean }} ImportResult
 */

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isQuota(err) {
  const e = /** @type {any} */ (err);
  if (!e) return false;
  return (
    e.name === 'QuotaExceededError' ||
    e.code === 'QuotaExceededError' ||
    /quota|storage is full|disk is full/i.test(String(e.message || e.userMessage || ''))
  );
}

/**
 * Imports a validated backup.
 * - `merge`: per store, newer `updated`/`ts` wins; attempts deduplicated by `(qid, ts)`;
 *   settings only adds keys the device doesn't have. Nothing is deleted.
 * - `replace`: every store present in the backup — and every other store except `voice`
 *   when the backup has no media (those voice notes are kept) — is cleared and filled
 *   from the backup. Everything is decoded and a snapshot taken first; if a write fails
 *   the replaced stores are restored.
 * Never touches `lastRoute`. Every changed store emits `store:change` (via the repo).
 *
 * @param {BackupData} data From {@link readBackupFile} / {@link validateBackup}.
 * @param {{ mode: 'merge' | 'replace', adapter?: StoreAdapter }} opts `adapter` is for tests.
 * @returns {Promise<ImportResult>} Rejects with {@link BackupError}.
 */
export async function importBackup(data, { mode, adapter = REPO_ADAPTER } = /** @type {any} */ ({})) {
  if (mode !== 'merge' && mode !== 'replace') throw new TypeError("importBackup: mode must be 'merge' or 'replace'");
  const backup = validated.has(/** @type {object} */ (data)) ? data : validateBackup(data).data;
  const present = ALL_STORES.filter((name) => Array.isArray(backup.stores[name]));
  /** @type {ImportResult} */
  const result = { mode, stores: {}, added: 0, updated: 0, skipped: 0, keptVoice: !backup.includesMedia };

  if (mode === 'merge') {
    // 1. Plan every store and decode the audio that will be written — before any write.
    /** @type {Array<[string, any[], number]>} */
    const jobs = [];
    for (const name of present) {
      let existing;
      try {
        existing = await adapter.dump(name);
      } catch (err) {
        throw importError(err, false);
      }
      const plan = planMerge(name, existing, backup.stores[name]);
      jobs.push([name, prepareRecords(name, plan.write), plan.skipped]);
    }
    // 2. Write (each store in its own transaction; nothing is ever deleted).
    let wroteSomething = false;
    for (const [name, records, planSkipped] of jobs) {
      if (!records.length) {
        result.stores[name] = { added: 0, updated: 0, skipped: planSkipped };
        result.skipped += planSkipped;
        continue;
      }
      try {
        const r = await adapter.merge(name, records);
        const s = { added: r.added, updated: r.updated, skipped: r.skipped + planSkipped };
        result.stores[name] = s;
        result.added += s.added;
        result.updated += s.updated;
        result.skipped += s.skipped;
        wroteSomething = true;
      } catch (err) {
        throw importError(err, wroteSomething);
      }
    }
    return result;
  }

  // replace
  const targets = ALL_STORES.filter((name) => present.includes(name) || name !== 'voice' || backup.includesMedia);
  /** @type {Record<string, any[]>} */
  const prepared = {};
  for (const name of targets) prepared[name] = prepareRecords(name, backup.stores[name] ?? []);

  /** @type {Record<string, any[]>} */
  const snapshot = {};
  try {
    for (const name of targets) snapshot[name] = await adapter.dump(name);
  } catch (err) {
    throw importError(err, false);
  }

  /** @type {string[]} */
  const done = [];
  try {
    for (const name of targets) {
      const r = await adapter.replace(name, prepared[name]);
      done.push(name);
      result.stores[name] = { added: r.written, updated: 0, skipped: r.skipped };
      result.added += r.written;
      result.skipped += r.skipped;
    }
  } catch (err) {
    let restored = true;
    for (const name of done.reverse()) {
      try {
        await adapter.replace(name, snapshot[name]);
      } catch (restoreErr) {
        restored = false;
        console.error('[backup] could not restore store after a failed import', name, restoreErr);
      }
    }
    console.error('[backup] replace import failed', err);
    const reason = isQuota(err)
      ? "There isn't enough storage space to import this backup. Free up space on your device"
      : "The import couldn't finish. Please try again";
    throw new BackupError(
      isQuota(err) ? 'quota' : 'import-failed',
      restored
        ? `${reason}. Your data was put back as it was.`
        : `${reason}. Some data couldn't be put back — import your latest backup again to restore it.`,
      { cause: err },
    );
  }
  return result;
}

/**
 * @param {unknown} err
 * @param {boolean} partial Some stores were already merged.
 * @returns {BackupError}
 */
function importError(err, partial) {
  if (err instanceof BackupError) return err;
  console.error('[backup] import failed', err);
  const after = partial ? ' Some items were added before the problem; nothing was deleted.' : ` ${NOTHING_CHANGED}`;
  if (isQuota(err)) {
    return new BackupError(
      'quota',
      `There isn't enough storage space to import this backup.${after} Free up space, or import a backup made without voice notes.`,
      { cause: err },
    );
  }
  return new BackupError('import-failed', `The import couldn't finish.${after} Please try again.`, { cause: err });
}

// ---------------------------------------------------------------------------
// Storage info
// ---------------------------------------------------------------------------

/**
 * Storage used by the app and whether it is protected from automatic clean-up.
 * Missing APIs read as zeros / false.
 * @returns {Promise<{ usage: number, quota: number, persisted: boolean }>}
 */
export async function storageInfo() {
  const storage = /** @type {any} */ (globalThis.navigator)?.storage;
  let usage = 0;
  let quota = 0;
  let persisted = false;
  try {
    if (storage?.estimate) {
      const est = await storage.estimate();
      usage = Number(est?.usage) || 0;
      quota = Number(est?.quota) || 0;
    }
  } catch {
    /* unsupported or blocked */
  }
  try {
    if (storage?.persisted) persisted = Boolean(await storage.persisted());
  } catch {
    /* unsupported */
  }
  return { usage, quota, persisted };
}

/**
 * Asks the browser to keep the app's data even when the device runs low on space.
 * @returns {Promise<boolean>} `true` when storage is (now) persistent.
 */
export async function requestPersistence() {
  const storage = /** @type {any} */ (globalThis.navigator)?.storage;
  try {
    if (!storage?.persist) return false;
    if (storage.persisted && (await storage.persisted())) return true;
    return Boolean(await storage.persist());
  } catch {
    return false;
  }
}

/**
 * Human-readable size: `"512 KB"`, `"3.4 MB"`.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 ** 3) return `${formatNumber(Math.round((b / 1024 ** 2) * 10) / 10)} MB`;
  return `${formatNumber(Math.round((b / 1024 ** 3) * 10) / 10)} GB`;
}

/**
 * Plain-language one-line result of an import, e.g. "Backup merged: 120 items added, 4 updated."
 * @param {ImportResult} result
 * @returns {string}
 */
export function importResultMessage(result) {
  if (result.mode === 'replace') {
    return result.added ? `Backup restored: ${plural(result.added, 'item')}.` : 'Backup restored. It had no study data.';
  }
  if (!result.added && !result.updated) return 'Nothing new in this backup — your device already had everything.';
  const bits = [];
  if (result.added) bits.push(`${plural(result.added, 'item')} added`);
  if (result.updated) bits.push(`${formatNumber(result.updated)} updated`);
  return `Backup merged: ${bits.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Import dialog (UI)
// ---------------------------------------------------------------------------

let dialogSeq = 0;

/**
 * Formats the backup date for people: "26 Oct 2026, 14:05".
 * @param {number} ms
 * @returns {string}
 */
function formatBackupDate(ms) {
  try {
    return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * The flow Settings runs after the user picked a backup file: reads + validates
 * it (sheet with a spinner meanwhile), shows a summary (date, item counts, voice
 * notes or not) with the choice Merge (recommended, default) / Replace everything
 * (danger, confirmed), imports, and shows a result toast. A bad file shows a
 * plain-language explanation with "Choose another file".
 *
 * @param {Blob} file
 * @returns {Promise<ImportResult | null>} The result, or null when cancelled / failed.
 */
export function openImportDialog(file) {
  return new Promise((resolve) => {
    dialogSeq += 1;
    const uidBase = `bk-${dialogSeq}`;
    let settled = false;
    /** @param {ImportResult | null} v */
    const settle = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let busy = false;

    const body = h('div', { class: 'bk-dialog', 'aria-busy': 'true' }, spinner({ label: 'Checking the backup…' }));
    const cancelBtn = button({ label: 'Cancel', variant: 'secondary', onClick: () => ref.close('cancel') });
    const importBtn = button({ label: 'Import', icon: 'upload', variant: 'primary', disabled: true });
    importBtn.classList.add('bk-import-btn');
    const ref = sheet({
      title: 'Import backup',
      content: body,
      actions: [cancelBtn, importBtn],
      size: 's',
      onClose: () => {
        if (!busy) settle(null);
      },
    });

    readBackupFile(file).then(showSummary, showError);

    /** @param {unknown} err */
    function showError(err) {
      const message =
        err instanceof BackupError ? err.userMessage : `Couldn't open this file. ${PICK_BACKUP}`;
      if (!(err instanceof BackupError)) console.error('[backup] reading the file failed', err);
      const picker = /** @type {HTMLInputElement} */ (
        h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' })
      );
      picker.addEventListener('change', () => {
        const next = picker.files?.[0];
        if (!next) return;
        void ref.close('replaced');
        openImportDialog(next).then(settle);
      });
      body.replaceChildren(
        h(
          'div',
          { class: 'bk-error-state', role: 'alert' },
          h('span', { class: 'bk-error-icon', 'aria-hidden': 'true' }, icon('alert', { size: 28 })),
          h('p', { class: 'bk-error-title' }, "This file can't be imported"),
          h('p', { class: 'bk-error-text' }, message),
        ),
        picker,
      );
      body.setAttribute('aria-busy', 'false');
      cancelBtn.querySelector('.btn-label').textContent = 'Close';
      importBtn.replaceWith(
        button({ label: 'Choose another file', icon: 'upload', variant: 'primary', onClick: () => picker.click() }),
      );
    }

    /** @param {{ data: BackupData, summary: BackupSummary }} parsed */
    function showSummary({ data, summary }) {
      /** @type {'merge' | 'replace'} */
      let mode = 'merge';
      const groupName = `${uidBase}-mode`;
      const errorEl = h('p', { class: 'bk-error', role: 'alert', hidden: true });

      const rows = Object.entries(STORE_LABELS)
        .filter(([name]) => summary.counts[name] > 0)
        .map(([name, label]) =>
          h('div', { class: 'bk-count' }, h('dt', null, label), h('dd', null, formatNumber(summary.counts[name]))),
        );

      const option = (/** @type {'merge'|'replace'} */ value, title, text, extra) => {
        const input = /** @type {HTMLInputElement} */ (
          h('input', { type: 'radio', name: groupName, value, class: 'bk-option-input', checked: value === mode })
        );
        input.addEventListener('change', () => {
          if (!input.checked) return;
          mode = value;
          errorEl.hidden = true;
          renderButton();
        });
        return h(
          'label',
          { class: ['bk-option', `bk-option-${value}`] },
          input,
          h('span', { class: 'bk-option-mark', 'aria-hidden': 'true' }),
          h(
            'span',
            { class: 'bk-option-body' },
            h('span', { class: 'bk-option-title' }, title, extra),
            h('span', { class: 'bk-option-text' }, text),
          ),
        );
      };

      const replaceText = `Deletes the study data on this device and puts the backup in its place.${
        data.includesMedia ? '' : ' Voice notes on this device are kept (this backup has none).'
      }`;

      body.replaceChildren(
        h(
          'p',
          { class: 'bk-lead' },
          'Backup from ',
          h('strong', null, formatBackupDate(summary.exportedAtMs)),
          summary.appVersion ? h('span', { class: 'bk-version' }, ` · app ${summary.appVersion}`) : null,
        ),
        rows.length
          ? h('dl', { class: 'bk-counts', 'aria-label': 'What this backup contains' }, rows)
          : h('p', { class: 'bk-empty' }, 'This backup has no study data yet.'),
        h(
          'div',
          { class: 'bk-media' },
          data.includesMedia
            ? chip('Includes voice notes', { kind: 'info', icon: 'mic' })
            : chip('No voice notes in this backup', { kind: 'neutral', icon: 'mic' }),
        ),
        h(
          'fieldset',
          { class: 'bk-modes' },
          h('legend', { class: 'bk-legend' }, 'How to import'),
          option(
            'merge',
            'Merge',
            'Adds the backup to this device. When both have the same item, the newer one is kept. Nothing is deleted.',
            chip('Recommended', { kind: 'success' }),
          ),
          option('replace', 'Replace everything', replaceText),
        ),
        errorEl,
      );
      body.setAttribute('aria-busy', 'false');
      importBtn.disabled = false;
      importBtn.addEventListener('click', () => void run());
      renderButton();
      /** @type {HTMLElement | null} */ (body.querySelector('.bk-option-input'))?.focus({ preventScroll: true });

      function renderButton() {
        const danger = mode === 'replace';
        importBtn.classList.toggle('btn-primary', !danger);
        importBtn.classList.toggle('btn-danger', danger);
        /** @type {HTMLElement} */ (importBtn.querySelector('.btn-label')).textContent = danger
          ? 'Replace everything'
          : 'Merge';
      }

      async function run() {
        if (busy) return;
        if (mode === 'replace') {
          const ok = await confirmSheet({
            title: 'Replace everything?',
            text:
              "All progress, answers, notes, highlights, drawings and quiz sessions on this device will be deleted and replaced by the backup. This can't be undone. If you're unsure, choose Merge.",
            confirmLabel: 'Replace everything',
            danger: true,
          });
          if (!ok) return;
        }
        busy = true;
        importBtn.disabled = true;
        cancelBtn.disabled = true;
        importBtn.setAttribute('aria-busy', 'true');
        /** @type {HTMLElement} */ (importBtn.querySelector('.btn-label')).textContent = 'Importing…';
        errorEl.hidden = true;
        try {
          const result = await importBackup(data, { mode });
          busy = false;
          settle(result);
          void ref.close('done');
          toast(importResultMessage(result), { kind: 'success', duration: 6000 });
        } catch (err) {
          busy = false;
          const message =
            err instanceof BackupError ? err.userMessage : "The import couldn't finish. Nothing was deleted. Please try again.";
          if (!(err instanceof BackupError)) console.error('[backup] import failed', err);
          if (!ref.el.isConnected) {
            toast(message, { kind: 'danger', duration: 8000 });
            settle(null);
            return;
          }
          errorEl.textContent = message;
          errorEl.hidden = false;
          importBtn.disabled = false;
          cancelBtn.disabled = false;
          importBtn.removeAttribute('aria-busy');
          renderButton();
        }
      }
    }
  });
}
