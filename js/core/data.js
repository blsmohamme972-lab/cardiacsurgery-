/**
 * Question bank loader (docs/ARCHITECTURE.md §3, §5.6).
 *
 * - `data/index.json` describes the book: its parts, its chapters and the
 *   "App tour (demo)" chapter. Each chapter lives in its own JSON file and is
 *   fetched only when first needed (lazy), then kept in memory.
 * - **Published rule.** A chapter is completely hidden until its index entry
 *   says `"published": true`: it is not listed, its questions are not found
 *   and its file is never fetched. Dev tools can opt in with
 *   `{ includeUnpublished: true }` on {@link loadIndex} and {@link loadChapter}.
 *   A part is hidden while it lists no visible chapter.
 * - **Demo mode.** While no chapter is published, the demo chapter stands in
 *   for the whole bank: {@link studyChapters} returns `[demo]` and
 *   {@link loadIndex} reports `demoMode: true`. Other modules ask this module
 *   instead of deciding on their own. The demo itself is always loadable.
 * - Every load is memoized as a promise, so concurrent callers share one
 *   request. A failed load is forgotten, so the next call retries.
 * - URLs are resolved relative to the app folder (derived from this module's
 *   own URL), so the app works under any sub-path (`/cardiacsurgery-/`) and
 *   inside a Capacitor wrapper. The service worker serves them offline.
 * - Data is checked on arrival (schema version, chapter id, question shape).
 *   A malformed index entry or question is skipped with a console warning
 *   instead of breaking the whole bank; `scripts/validate.mjs` catches these
 *   before release.
 * - Failures throw {@link DataError} with a plain-language `message`.
 *
 * Returned objects are shared, in-memory data: treat them as read-only.
 * Arrays (and part wrappers) returned to callers are fresh copies, so sorting
 * or filtering them is safe.
 *
 * Importing this module does not touch `document` or `window`.
 *
 * @module core/data
 */

import { inlineToPlain } from '../features/explain/inline.js';

/**
 * A part of the book (a group of chapters). Returned by {@link loadIndex}.
 * @typedef {object} Part
 * @property {string} id               Stable part id, e.g. `"p3"`.
 * @property {string} number           Roman numeral, e.g. `"III"` (`''` when missing).
 * @property {string} title            Full title.
 * @property {number | null} volume    Book volume (1 or 2), null when missing.
 * @property {string[]} chapters       Ids of the part's chapters that are listed in the same
 *                                     {@link loadIndex} result, sorted by chapter number.
 */

/**
 * A book chapter from `data/index.json`.
 * @typedef {object} Chapter
 * @property {string} id               Stable chapter id, e.g. `"ch12"`.
 * @property {number} number           Chapter number in the book (1, 2, …).
 * @property {string} part             Id of the owning {@link Part}, e.g. `"p3"`.
 * @property {string} prefix           Question id prefix, e.g. `"CH12"`.
 * @property {string} title            Full title.
 * @property {string} short            Short title for chips and tight spaces.
 * @property {string} file             Relative path of the chapter file, e.g. `"data/ch12.json"`.
 * @property {number | null} page      First page of the chapter in the owner's book.
 * @property {boolean} published       False = hidden everywhere in the app.
 * @property {number} count            Number of questions in the file.
 * @property {number} order            Sort order (equals `number`).
 * @property {false} demo
 */

/**
 * The "App tour (demo)" chapter: questions about using the app.
 * @typedef {object} Demo
 * @property {'demo'} id
 * @property {null} number
 * @property {null} part
 * @property {string} prefix           Question id prefix, e.g. `"DEMO"`.
 * @property {string} title
 * @property {string} short
 * @property {string} file             e.g. `"data/demo.json"`.
 * @property {null} page
 * @property {true} published          The demo is always loadable.
 * @property {number} count
 * @property {number} order            Sorts after every chapter.
 * @property {true} demo
 */

/**
 * @typedef {Chapter | Demo} AnyChapter
 */

/**
 * @typedef {{ id: string, text: string }} Choice
 * @typedef {{ ref: string, loc?: string }} SourceRef
 * @typedef {{ src: string, alt: string, caption?: string }} QuestionImage
 * @typedef {{ id: string, type: string, [field: string]: any }} Block  Explanation block (§3.4).
 */

/**
 * @typedef {object} Question
 * @property {string} id
 * @property {number} version
 * @property {string} topic
 * @property {string[]} [tags]
 * @property {1|2|3} difficulty
 * @property {boolean} reviewed
 * @property {boolean} [demo]
 * @property {string} stem
 * @property {QuestionImage} [image]
 * @property {Choice[]} choices
 * @property {string} answer             A choice id.
 * @property {Block[]} explanation
 * @property {Record<string, string>} [choiceNotes]
 * @property {SourceRef[]} [source]
 * @property {string} chapterId          Added by this loader: the owning chapter's id.
 */

/**
 * @typedef {object} BankIndex
 * @property {number} schemaVersion
 * @property {Part[]} parts            Parts with at least one listed chapter, in index order.
 * @property {Chapter[]} chapters      Published chapters (all with `includeUnpublished`), by number.
 * @property {Demo | null} demo        Null only when the index has no valid demo entry.
 * @property {boolean} demoMode        True while no chapter is published.
 */

/**
 * @typedef {'offline'|'network'|'timeout'|'not-found'|'http'|'parse'|'schema'|'version'|'unknown-chapter'} DataErrorCode
 */

/** Highest data schema version this app understands. */
export const SCHEMA_VERSION = 1;

/** Question id: `PREFIX-NNNN` (4+ digits). Group 1 is the prefix. */
export const QID_RE = /^([A-Z][A-Z0-9]*)-(\d{4,})$/;

/** Chapter id of the "App tour (demo)" chapter. */
export const DEMO_ID = 'demo';

/** Question id prefix: uppercase letter, then uppercase letters/digits. */
const PREFIX_RE = /^[A-Z][A-Z0-9]*$/;

/** Sort order of the demo: after every chapter. */
const DEMO_ORDER = Number.MAX_SAFE_INTEGER;

/** Path of the chapter list, relative to the app folder. */
const INDEX_PATH = 'data/index.json';

/** Give up on a request that hangs this long (a slow but alive download keeps going until then). */
const FETCH_TIMEOUT_MS = 30000;

/** The app folder (`…/cardiacsurgery-/`): this file lives in `js/core/`. */
const APP_ROOT = new URL('../../', import.meta.url);

/** Plain-language messages (shown to the user as-is). */
const MESSAGES = Object.freeze({
  offline:
    "You're offline, and this part of the question bank isn't saved on this device yet. Connect to the internet once, then try again.",
  network: "Couldn't load the questions. Check your connection and try again.",
  timeout: 'Loading the questions is taking too long. Check your connection and try again.',
  notFound: 'Some question files are missing. Please reload the app.',
  http: "Couldn't load the questions right now. Please try again in a moment.",
  parse: 'A question file is damaged. Please reload the app to download it again.',
  schema: 'The question bank looks damaged. Please reload the app.',
  version: 'These questions need a newer version of the app. Please reload to update.',
  unknownChapter: "That chapter doesn't exist. It may have been renamed in an update.",
  unpublishedChapter: "That chapter isn't available yet. Pick another chapter from Home.",
});

/**
 * Error thrown by every loader in this module. `message` (and `userMessage`)
 * is plain language, safe to show as-is; `detail` is a technical note for
 * the console; `cause` keeps the original error.
 */
export class DataError extends Error {
  /**
   * @param {string} message User-facing message.
   * @param {{ code?: DataErrorCode, url?: string | null, detail?: string, cause?: unknown }} [info]
   */
  constructor(message, { code = 'schema', url = null, detail = '', cause } = {}) {
    super(message);
    this.name = 'DataError';
    /** @type {DataErrorCode} */
    this.code = code;
    /** @type {string} */
    this.userMessage = message;
    /** @type {string | null} Absolute URL of the file involved, when known. */
    this.url = url;
    /** @type {string} Technical detail for developers (never shown to users). */
    this.detail = detail;
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * A part as read from the index, before its chapter list is attached.
 * @typedef {Omit<Part, 'chapters'>} PartInfo
 */

/**
 * One way of looking at the book: a chapter list and the parts it fills.
 * @typedef {object} IndexView
 * @property {Chapter[]} chapters          Sorted by number.
 * @property {Part[]} parts                Only parts with ≥1 chapter in `chapters`.
 */

/**
 * @typedef {object} ChapterState
 * @property {AnyChapter} chapter
 * @property {Question[]} questions
 * @property {Map<string, Question>} byId
 */

/**
 * @typedef {object} IndexState
 * @property {number} schemaVersion
 * @property {IndexView} published         What the app shows.
 * @property {IndexView} all               Every valid chapter (dev tools only).
 * @property {Demo | null} demo
 * @property {boolean} demoMode            No chapter is published.
 * @property {Map<string, AnyChapter>} byId      Every valid chapter (published or not) and the demo.
 * @property {Map<string, AnyChapter>} byPrefix  Same, keyed by question id prefix.
 * @property {Map<string, Promise<ChapterState>>} loads  Chapter loads of this index (memoized).
 */

/** @type {Promise<IndexState> | null} */
let indexPromise = null;
/** Resolved index, for the synchronous {@link chapterIdFromQid}. @type {IndexState | null} */
let indexState = null;
/** Plain text per question object (questions are memoized, so this stays valid). @type {WeakMap<object, string>} */
const plainTextCache = new WeakMap();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isPositiveInt(v) {
  return Number.isInteger(v) && /** @type {number} */ (v) >= 1;
}

/** @param {...any} args */
function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn('[data]', ...args);
}

/** @returns {boolean} True when the browser reports no network. */
function isOffline() {
  const nav = globalThis.navigator;
  return Boolean(nav) && nav.onLine === false;
}

/**
 * True when `relPath` is a relative path that stays inside the app folder:
 * not empty, no leading `/`, no backslash, no scheme (`https:`, `data:` …)
 * and no `..` segment.
 * @param {unknown} relPath
 * @returns {relPath is string}
 */
function isSafeDataPath(relPath) {
  const p = typeof relPath === 'string' ? relPath.trim() : '';
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(p) &&
    !p.split('/').some((seg) => seg === '..')
  );
}

/**
 * Resolves an app-relative data path (`data/…`) to an absolute URL.
 * Rejects paths that could leave the app folder (see {@link isSafeDataPath}).
 * @param {unknown} relPath
 * @returns {string}
 * @throws {DataError} `schema` for an unsafe path.
 */
function resolveDataUrl(relPath) {
  if (!isSafeDataPath(relPath)) {
    throw new DataError(MESSAGES.schema, { code: 'schema', detail: `Unsafe data path: ${JSON.stringify(relPath)}` });
  }
  return new URL(relPath.trim(), APP_ROOT).href;
}

/**
 * Checks `schemaVersion` of a parsed data file.
 * @param {Record<string, any>} raw
 * @param {string} url
 */
function checkSchemaVersion(raw, url) {
  const v = raw.schemaVersion;
  if (!Number.isInteger(v) || v < 1) {
    throw new DataError(MESSAGES.schema, { code: 'schema', url, detail: `Missing or invalid schemaVersion: ${JSON.stringify(v)}` });
  }
  if (v > SCHEMA_VERSION) {
    throw new DataError(MESSAGES.version, {
      code: 'version',
      url,
      detail: `schemaVersion ${v} is newer than supported (${SCHEMA_VERSION})`,
    });
  }
}

/**
 * Fetches and parses one JSON file of the question bank.
 * @param {string} relPath App-relative path, e.g. `data/ch01.json`.
 * @returns {Promise<{ data: any, url: string }>}
 * @throws {DataError}
 */
async function fetchJson(relPath) {
  const url = resolveDataUrl(relPath);
  if (typeof globalThis.fetch !== 'function') {
    throw new DataError(MESSAGES.network, { code: 'network', url, detail: 'fetch() is not available' });
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, FETCH_TIMEOUT_MS)
    : null;

  let text;
  try {
    let res;
    try {
      res = await fetch(url, { credentials: 'same-origin', signal: controller ? controller.signal : undefined });
    } catch (err) {
      if (timedOut) throw new DataError(MESSAGES.timeout, { code: 'timeout', url, cause: err, detail: 'Request timed out' });
      if (isOffline()) throw new DataError(MESSAGES.offline, { code: 'offline', url, cause: err, detail: 'Offline and not cached' });
      throw new DataError(MESSAGES.network, { code: 'network', url, cause: err, detail: String(err?.message ?? err) });
    }
    if (!res.ok) {
      const notFound = res.status === 404 || res.status === 410;
      throw new DataError(notFound ? MESSAGES.notFound : MESSAGES.http, {
        code: notFound ? 'not-found' : 'http',
        url,
        detail: `HTTP ${res.status} ${res.statusText || ''}`.trim(),
      });
    }
    try {
      text = await res.text();
    } catch (err) {
      if (timedOut) throw new DataError(MESSAGES.timeout, { code: 'timeout', url, cause: err, detail: 'Download timed out' });
      throw new DataError(isOffline() ? MESSAGES.offline : MESSAGES.network, {
        code: isOffline() ? 'offline' : 'network',
        url,
        cause: err,
        detail: `Download interrupted: ${String(err?.message ?? err)}`,
      });
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new DataError(MESSAGES.parse, { code: 'parse', url, cause: err, detail: `Invalid JSON: ${String(err?.message ?? err)}` });
  }
  if (!isPlainObject(data)) {
    throw new DataError(MESSAGES.schema, { code: 'schema', url, detail: 'Top level is not a JSON object' });
  }
  return { data, url };
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

/**
 * Validates the `parts` list. Bad entries are skipped with a warning.
 * @param {unknown[]} list
 * @returns {Map<string, PartInfo>} By id, in index order.
 */
function normalizeParts(list) {
  /** @type {Map<string, PartInfo>} */
  const parts = new Map();
  list.forEach((entry, i) => {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.id)) {
      warn(`index.json: parts[${i}] needs an "id"; skipped.`);
      return;
    }
    if (parts.has(entry.id)) {
      warn(`index.json: duplicate part id "${entry.id}"; skipped.`);
      return;
    }
    const number = isNonEmptyString(entry.number) ? entry.number.trim() : '';
    // A stray `chapters` field is harmless: buildView() always replaces it.
    parts.set(entry.id, {
      ...entry,
      id: entry.id,
      number,
      title: isNonEmptyString(entry.title) ? entry.title : number ? `Part ${number}` : entry.id,
      volume: isPositiveInt(entry.volume) ? entry.volume : null,
    });
  });
  return parts;
}

/**
 * Validates and normalizes one entry of the `chapters` list.
 * @param {unknown} entry
 * @param {number} i Position in the list (for warnings).
 * @param {Map<string, PartInfo>} parts
 * @returns {Chapter | null} Null (after a warning) when the entry is unusable.
 */
function normalizeChapterEntry(entry, i, parts) {
  const at = `index.json: chapters[${i}]`;
  if (!isPlainObject(entry)) {
    warn(`${at} is not an object; skipped.`);
    return null;
  }
  const { id, prefix, file, number, part } = entry;
  if (!isNonEmptyString(id) || typeof prefix !== 'string' || !PREFIX_RE.test(prefix) || !isNonEmptyString(file)) {
    warn(`${at} needs "id", an uppercase "prefix" and "file"; skipped.`);
    return null;
  }
  const skip = (/** @type {string} */ why) => {
    warn(`${at} ("${id}") ${why}; skipped.`);
    return null;
  };
  if (id === DEMO_ID) return skip(`uses the id reserved for the "demo" entry`);
  if (!isSafeDataPath(file)) return skip('has a "file" outside the app folder');
  if (!isPositiveInt(number)) return skip('needs a whole "number" of 1 or more');
  if (typeof part !== 'string' || !parts.has(part)) return skip(`belongs to an unknown part ${JSON.stringify(part)}`);

  const title = isNonEmptyString(entry.title) ? entry.title : id;
  return {
    ...entry,
    id,
    number,
    part,
    prefix,
    title,
    short: isNonEmptyString(entry.short) ? entry.short : title,
    file: file.trim(),
    page: isPositiveInt(entry.page) ? entry.page : null,
    published: entry.published === true,
    count: Number.isInteger(entry.count) && entry.count >= 0 ? entry.count : 0,
    order: number,
    demo: false,
  };
}

/**
 * Validates the `demo` entry. A missing or bad entry never breaks the index:
 * it only makes the demo unavailable (with a warning).
 * @param {unknown} entry
 * @param {Map<string, AnyChapter>} byPrefix Prefixes already used by chapters.
 * @returns {Demo | null}
 */
function normalizeDemo(entry, byPrefix) {
  const unavailable = (/** @type {string} */ why) => {
    warn(`index.json: ${why}; the demo chapter is unavailable.`);
    return null;
  };
  if (entry === undefined) return unavailable('no "demo" entry');
  if (!isPlainObject(entry)) return unavailable('"demo" is not an object');
  const { id, prefix, file } = entry;
  if (id !== DEMO_ID || typeof prefix !== 'string' || !PREFIX_RE.test(prefix) || !isNonEmptyString(file)) {
    return unavailable(`"demo" needs the id "${DEMO_ID}", an uppercase "prefix" and "file"`);
  }
  if (byPrefix.has(prefix)) return unavailable(`"demo" uses the prefix "${prefix}" of a chapter`);
  if (!isSafeDataPath(file)) return unavailable('"demo" has a "file" outside the app folder');

  const title = isNonEmptyString(entry.title) ? entry.title : 'Demo';
  return {
    ...entry,
    id: DEMO_ID,
    number: null,
    part: null,
    prefix,
    title,
    short: isNonEmptyString(entry.short) ? entry.short : title,
    file: file.trim(),
    page: null,
    published: true,
    count: Number.isInteger(entry.count) && entry.count >= 0 ? entry.count : 0,
    order: DEMO_ORDER,
    demo: true,
  };
}

/**
 * Groups a sorted chapter list into its parts (parts without a chapter in
 * the list are left out; part order follows the index).
 * @param {Chapter[]} chapters Sorted by number.
 * @param {Map<string, PartInfo>} parts
 * @returns {IndexView}
 */
function buildView(chapters, parts) {
  /** @type {Map<string, string[]>} */
  const idsByPart = new Map();
  for (const c of chapters) {
    const ids = idsByPart.get(c.part);
    if (ids) ids.push(c.id);
    else idsByPart.set(c.part, [c.id]);
  }
  /** @type {Part[]} */
  const list = [];
  for (const p of parts.values()) {
    const ids = idsByPart.get(p.id);
    if (ids) list.push({ ...p, chapters: ids });
  }
  return { chapters, parts: list };
}

/**
 * Validates and normalizes `data/index.json`. Bad part, chapter and demo
 * entries are skipped with a warning; a broken overall shape throws.
 * @param {Record<string, any>} raw
 * @param {string} url
 * @returns {IndexState}
 * @throws {DataError} `schema`/`version` when the index can't be used at all.
 */
function normalizeIndex(raw, url) {
  checkSchemaVersion(raw, url);
  if (!Array.isArray(raw.parts)) {
    throw new DataError(MESSAGES.schema, { code: 'schema', url, detail: '"parts" must be an array' });
  }
  if (!Array.isArray(raw.chapters)) {
    throw new DataError(MESSAGES.schema, { code: 'schema', url, detail: '"chapters" must be an array' });
  }

  const parts = normalizeParts(raw.parts);
  /** @type {Chapter[]} */
  const chapters = [];
  /** @type {Map<string, AnyChapter>} */
  const byId = new Map();
  /** @type {Map<string, AnyChapter>} */
  const byPrefix = new Map();
  /** @type {Set<number>} */
  const numbers = new Set();

  raw.chapters.forEach((entry, i) => {
    const chapter = normalizeChapterEntry(entry, i, parts);
    if (!chapter) return;
    if (byId.has(chapter.id) || byPrefix.has(chapter.prefix) || numbers.has(chapter.number)) {
      warn(
        `index.json: chapters[${i}] repeats the id "${chapter.id}", prefix "${chapter.prefix}" or number ${chapter.number}; skipped.`,
      );
      return;
    }
    chapters.push(chapter);
    byId.set(chapter.id, chapter);
    byPrefix.set(chapter.prefix, chapter);
    numbers.add(chapter.number);
  });
  chapters.sort((a, b) => a.number - b.number);

  const demo = normalizeDemo(raw.demo, byPrefix);
  if (demo) {
    byId.set(demo.id, demo);
    byPrefix.set(demo.prefix, demo);
  }
  if (chapters.length === 0 && !demo) {
    throw new DataError(MESSAGES.schema, { code: 'schema', url, detail: 'No valid chapters and no demo in index' });
  }

  const published = chapters.filter((c) => c.published);
  return {
    schemaVersion: raw.schemaVersion,
    published: buildView(published, parts),
    all: buildView(chapters, parts),
    demo,
    demoMode: published.length === 0,
    byId,
    byPrefix,
    loads: new Map(),
  };
}

/**
 * Memoized index load (shared promise; forgotten on failure so callers can retry).
 * @returns {Promise<IndexState>}
 */
function ensureIndex() {
  if (!indexPromise) {
    const p = fetchJson(INDEX_PATH).then(({ data, url }) => {
      const state = normalizeIndex(data, url);
      if (indexPromise === p) indexState = state;
      return state;
    });
    indexPromise = p;
    p.catch(() => {
      if (indexPromise === p) indexPromise = null;
    });
  }
  return indexPromise;
}

/**
 * The chapters the learner studies: published chapters, or the demo alone
 * in demo mode (nothing when the demo is unavailable too).
 * @param {IndexState} index
 * @returns {AnyChapter[]} A fresh array.
 */
function studyList(index) {
  if (!index.demoMode) return index.published.chapters.slice();
  return index.demo ? [index.demo] : [];
}

/**
 * The visible (published or demo) chapter that owns a question id.
 * @param {IndexState} index
 * @param {unknown} qid
 * @returns {AnyChapter | null}
 */
function visibleChapterOfQid(index, qid) {
  const prefix = prefixOf(qid);
  const chapter = prefix ? index.byPrefix.get(prefix) : undefined;
  return chapter && chapter.published ? chapter : null;
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

/**
 * Light runtime check so one malformed question can't break a screen.
 * Full validation happens before release (`scripts/validate.mjs`).
 * @param {any} q
 * @param {AnyChapter} chapter
 * @returns {string | null} Why the question is unusable, or null when fine.
 */
function questionProblem(q, chapter) {
  if (!isPlainObject(q)) return 'not an object';
  const m = typeof q.id === 'string' ? QID_RE.exec(q.id) : null;
  if (!m) return 'invalid id';
  if (m[1] !== chapter.prefix) return `id prefix is not ${chapter.prefix}`;
  if (!isNonEmptyString(q.stem)) return 'empty stem';
  if (!Array.isArray(q.choices) || q.choices.length < 2) return 'needs at least 2 choices';
  const ids = new Set();
  for (const c of q.choices) {
    if (!isPlainObject(c) || !isNonEmptyString(c.id) || typeof c.text !== 'string' || ids.has(c.id)) return 'invalid choice';
    ids.add(c.id);
  }
  if (!ids.has(q.answer)) return 'answer is not one of the choices';
  if (q.explanation !== undefined && !Array.isArray(q.explanation)) return 'explanation is not a list';
  return null;
}

/**
 * Validates a parsed chapter file and prepares its questions.
 * @param {Record<string, any>} raw
 * @param {AnyChapter} chapter
 * @param {string} url
 * @returns {ChapterState}
 */
function normalizeChapter(raw, chapter, url) {
  checkSchemaVersion(raw, url);
  if (raw.chapter !== chapter.id) {
    throw new DataError(MESSAGES.schema, {
      code: 'schema',
      url,
      detail: `File belongs to chapter ${JSON.stringify(raw.chapter)}, expected "${chapter.id}"`,
    });
  }
  if (!Array.isArray(raw.questions)) {
    throw new DataError(MESSAGES.schema, { code: 'schema', url, detail: '"questions" must be an array' });
  }

  /** @type {Question[]} */
  const questions = [];
  /** @type {Map<string, Question>} */
  const byId = new Map();
  raw.questions.forEach((q, i) => {
    const problem = questionProblem(q, chapter);
    if (problem) {
      warn(`${chapter.file}: question #${i + 1}${typeof q?.id === 'string' ? ` (${q.id})` : ''} skipped: ${problem}.`);
      return;
    }
    if (byId.has(q.id)) {
      warn(`${chapter.file}: duplicate question id ${q.id}; kept the first one.`);
      return;
    }
    if (q.explanation === undefined) q.explanation = [];
    q.chapterId = chapter.id;
    questions.push(/** @type {Question} */ (q));
    byId.set(q.id, q);
  });

  return { chapter, questions, byId };
}

/**
 * Finds a chapter that the caller may load.
 * @param {IndexState} index
 * @param {unknown} id
 * @param {boolean} includeUnpublished
 * @returns {AnyChapter}
 * @throws {DataError} `unknown-chapter` for an unknown id, or an unpublished
 *   chapter without `includeUnpublished`.
 */
function requireChapter(index, id, includeUnpublished) {
  const chapter = typeof id === 'string' ? index.byId.get(id) : undefined;
  if (!chapter) {
    throw new DataError(MESSAGES.unknownChapter, { code: 'unknown-chapter', detail: `No chapter ${JSON.stringify(id)} in ${INDEX_PATH}` });
  }
  if (!chapter.published && !includeUnpublished) {
    throw new DataError(MESSAGES.unpublishedChapter, { code: 'unknown-chapter', detail: `Chapter "${chapter.id}" is not published` });
  }
  return chapter;
}

/**
 * Memoized chapter file load (shared promise per chapter; forgotten on
 * failure). The memo lives on the index it was loaded with, so
 * {@link clearDataCache} drops both together. Callers must have checked
 * access with {@link requireChapter} (or the published flag) first.
 * @param {IndexState} index
 * @param {AnyChapter} chapter
 * @returns {Promise<ChapterState>}
 */
function chapterLoad(index, chapter) {
  const memo = index.loads;
  const existing = memo.get(chapter.id);
  if (existing) return existing;
  const p = fetchJson(chapter.file).then(({ data, url }) => normalizeChapter(data, chapter, url));
  memo.set(chapter.id, p);
  p.catch(() => {
    if (memo.get(chapter.id) === p) memo.delete(chapter.id);
  });
  return p;
}

/**
 * Loads several chapters in parallel and returns their questions in the
 * given chapter order, then file order.
 * @param {IndexState} index
 * @param {AnyChapter[]} chapters
 * @returns {Promise<Question[]>}
 */
async function questionsOf(index, chapters) {
  const states = await Promise.all(chapters.map((c) => chapterLoad(index, c)));
  return states.flatMap((s) => s.questions);
}

/**
 * Splits a question id into its prefix.
 * @param {unknown} qid
 * @returns {string | null}
 */
function prefixOf(qid) {
  if (typeof qid !== 'string') return null;
  const m = QID_RE.exec(qid);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads the book structure (`data/index.json`). Memoized: concurrent and
 * later calls share one request.
 *
 * @param {{ includeUnpublished?: boolean }} [options] `includeUnpublished`
 *   (dev tools only; only `true` counts) lists every valid chapter instead of
 *   the published ones.
 * @returns {Promise<BankIndex>} A fresh wrapper, fresh arrays and fresh part
 *   objects on every call (chapter and demo objects are shared; read-only).
 *   `chapters` holds the published chapters sorted by number; `parts` only
 *   the parts with at least one listed chapter, each with the ids of those
 *   chapters; `demoMode` is true while no chapter is published (whatever the
 *   option).
 * @throws {DataError} When the index can't be loaded or is unusable.
 * @example
 * const { parts, chapters, demoMode } = await loadIndex();
 * const byId = new Map(chapters.map((c) => [c.id, c]));
 * parts.map((p) => [p.title, p.chapters.map((id) => byId.get(id).short)]);
 */
export async function loadIndex(options = {}) {
  const { includeUnpublished = false } = options ?? {};
  const index = await ensureIndex();
  const view = includeUnpublished === true ? index.all : index.published;
  return {
    schemaVersion: index.schemaVersion,
    parts: view.parts.map((p) => ({ ...p, chapters: p.chapters.slice() })),
    chapters: view.chapters.slice(),
    demo: index.demo,
    demoMode: index.demoMode,
  };
}

/**
 * The chapters the learner studies (Home quick actions, builder "All",
 * stats, search, library): the published chapters sorted by number, or
 * `[demo]` in demo mode. Empty only when nothing is published and the demo
 * is unavailable.
 *
 * @returns {Promise<AnyChapter[]>} A fresh array.
 * @throws {DataError} When the index can't be loaded.
 */
export async function studyChapters() {
  return studyList(await ensureIndex());
}

/**
 * Looks up one chapter (or the demo) by id.
 *
 * @param {string} id e.g. `"ch12"` or `"demo"`.
 * @returns {Promise<AnyChapter | null>} Null for an unknown or unpublished chapter.
 * @throws {DataError} When the index can't be loaded.
 */
export async function getChapter(id) {
  const index = await ensureIndex();
  const chapter = typeof id === 'string' ? index.byId.get(id) : undefined;
  return chapter && chapter.published ? chapter : null;
}

/**
 * Loads one chapter and its questions. Memoized per chapter id. Each question
 * gets a `chapterId` field. The demo is always allowed.
 *
 * @param {string} id Chapter id, e.g. `"ch12"` or `"demo"`.
 * @param {{ includeUnpublished?: boolean }} [options] `includeUnpublished`
 *   (dev tools only; only `true` counts) allows an unpublished chapter.
 * @returns {Promise<{ chapter: AnyChapter, questions: Question[] }>}
 *   `questions` is a fresh array in file order (question objects are shared; read-only).
 * @throws {DataError} `unknown-chapter` for an unknown id or an unpublished
 *   chapter (without the option; its file is not fetched), or a load/format error.
 */
export async function loadChapter(id, options = {}) {
  const { includeUnpublished = false } = options ?? {};
  if (!isNonEmptyString(id)) {
    throw new DataError(MESSAGES.unknownChapter, { code: 'unknown-chapter', detail: `Invalid chapter id: ${JSON.stringify(id)}` });
  }
  const index = await ensureIndex();
  const chapter = requireChapter(index, id, includeUnpublished === true);
  const state = await chapterLoad(index, chapter);
  return { chapter: state.chapter, questions: state.questions.slice() };
}

/**
 * Loads every published chapter (in parallel) and returns all questions in
 * chapter order, then file order; the demo's questions come last.
 *
 * @param {{ includeDemo?: boolean }} [options] `includeDemo` (default true)
 *   adds the demo chapter, in demo mode and outside it.
 * @returns {Promise<Question[]>} A fresh array.
 * @throws {DataError} When any chapter can't be loaded.
 */
export async function loadAll(options = {}) {
  const { includeDemo = true } = options ?? {};
  const index = await ensureIndex();
  const chapters = /** @type {AnyChapter[]} */ (index.published.chapters.slice());
  if (includeDemo && index.demo) chapters.push(index.demo);
  return questionsOf(index, chapters);
}

/**
 * Loads the questions of {@link studyChapters}: every published chapter, or
 * the demo in demo mode.
 *
 * @returns {Promise<Question[]>} A fresh array, in chapter order, then file order.
 * @throws {DataError} When any chapter can't be loaded.
 */
export async function loadStudyBank() {
  const index = await ensureIndex();
  return questionsOf(index, studyList(index));
}

/**
 * Finds one question by id. The chapter is found from the id prefix and
 * loaded on demand.
 *
 * @param {string} qid e.g. `"CH12-0001"`.
 * @returns {Promise<Question | null>} Null when the id is malformed, its
 *   prefix is unknown, its chapter is unpublished (nothing is fetched then),
 *   or the chapter has no such question.
 * @throws {DataError} When the chapter file can't be loaded.
 */
export async function getQuestion(qid) {
  if (!prefixOf(qid)) return null;
  const index = await ensureIndex();
  const chapter = visibleChapterOfQid(index, qid);
  if (!chapter) return null;
  const state = await chapterLoad(index, chapter);
  return state.byId.get(/** @type {string} */ (qid)) ?? null;
}

/**
 * Finds many questions at once, loading the chapters they need in parallel.
 *
 * @param {Iterable<string>} qids
 * @returns {Promise<Question[]>} In the same order as `qids` (duplicates
 *   kept); ids that don't exist (malformed, unknown prefix, unpublished
 *   chapter, retired or deleted) are skipped.
 * @throws {DataError} When a needed chapter file can't be loaded.
 */
export async function getQuestions(qids) {
  const list = qids == null ? [] : Array.from(qids);
  if (list.length === 0) return [];
  const index = await ensureIndex();

  /** @type {Map<string, AnyChapter>} */
  const needed = new Map();
  for (const qid of list) {
    const chapter = visibleChapterOfQid(index, qid);
    if (chapter) needed.set(chapter.id, chapter);
  }
  const states = new Map(
    await Promise.all([...needed.values()].map(async (c) => /** @type {const} */ ([c.id, await chapterLoad(index, c)]))),
  );

  /** @type {Question[]} */
  const out = [];
  for (const qid of list) {
    const chapter = visibleChapterOfQid(index, qid);
    const q = chapter ? states.get(chapter.id)?.byId.get(qid) : undefined;
    if (q) out.push(q);
  }
  return out;
}

/**
 * Maps a question id to its chapter id using the id prefix. Synchronous:
 * returns null until {@link loadIndex} (or any other loader) has resolved once.
 *
 * @param {string} qid e.g. `"CH12-0012"`.
 * @returns {string | null} e.g. `"ch12"` or `"demo"`; null when the prefix is
 *   unknown or the chapter is unpublished.
 */
export function chapterIdFromQid(qid) {
  if (!indexState) return null;
  return visibleChapterOfQid(indexState, qid)?.id ?? null;
}

/**
 * Visible text of an inline mini-markup string (never throws).
 * @param {unknown} s
 * @returns {string}
 */
function plain(s) {
  if (typeof s !== 'string' || s === '') return '';
  let out;
  try {
    out = inlineToPlain(s);
  } catch {
    out = s;
  }
  return String(out ?? '').replace(/\s+/g, ' ').trim();
}

/** Fields of unknown block types that never hold readable text. */
const NON_TEXT_KEYS = new Set(['id', 'type', 'kind', 'src', 'ordered', 'emphasis']);

/**
 * Collects the visible strings of any value (fallback for unknown block types).
 * @param {unknown} value
 * @param {(s: unknown) => void} add
 * @param {number} depth
 */
function collectAnyText(value, add, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') add(value);
  else if (Array.isArray(value)) value.forEach((v) => collectAnyText(v, add, depth + 1));
  else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) if (!NON_TEXT_KEYS.has(k)) collectAnyText(v, add, depth + 1);
  }
}

/**
 * Collects the visible strings of one explanation block, in reading order.
 * @param {any} block
 * @param {(s: unknown) => void} add
 */
function collectBlockText(block, add) {
  if (!isPlainObject(block)) return;
  const arr = (/** @type {unknown} */ v) => (Array.isArray(v) ? v : []);
  switch (block.type) {
    case 'heading':
    case 'p':
      add(block.text);
      break;
    case 'list':
      for (const item of arr(block.items)) {
        if (isPlainObject(item)) {
          add(item.text);
          for (const sub of arr(item.items)) add(isPlainObject(sub) ? sub.text : sub);
        } else add(item);
      }
      break;
    case 'table':
      add(block.caption);
      arr(block.head).forEach(add);
      for (const row of arr(block.rows)) arr(row).forEach(add);
      break;
    case 'flow':
      add(block.title);
      for (const step of arr(block.steps)) {
        if (!isPlainObject(step)) continue;
        if (Array.isArray(step.branches)) {
          add(step.label);
          for (const br of step.branches) {
            if (!isPlainObject(br)) continue;
            add(br.label);
            add(br.text);
          }
        } else {
          add(step.label);
          add(step.text);
        }
      }
      break;
    case 'mindmap':
      add(block.center);
      for (const br of arr(block.branches)) {
        if (!isPlainObject(br)) continue;
        add(br.text);
        arr(br.children).forEach(add);
      }
      break;
    case 'callout':
      add(block.title);
      add(block.text);
      arr(block.items).forEach(add);
      break;
    case 'quote':
      add(block.text);
      add(block.ref);
      break;
    case 'image':
      add(block.alt);
      add(block.caption);
      break;
    default:
      collectAnyText(block, add);
  }
}

/**
 * Plain visible text of an explanation block (inline markup removed).
 *
 * @param {Block} block
 * @returns {string} Its strings joined by newlines, in reading order.
 */
export function blockPlainText(block) {
  /** @type {string[]} */
  const parts = [];
  collectBlockText(block, (s) => {
    const t = plain(s);
    if (t) parts.push(t);
  });
  return parts.join('\n');
}

/**
 * Plain visible text of a whole question, for search, the Ask GPT prompt and
 * text matching: stem, choices, choice notes and every string in the
 * explanation blocks (inline markup removed). Cached per question object.
 *
 * @param {Question} q
 * @returns {string} Parts joined by newlines; '' for a non-object.
 */
export function questionPlainText(q) {
  if (!isPlainObject(q)) return '';
  const cached = plainTextCache.get(q);
  if (cached !== undefined) return cached;

  /** @type {string[]} */
  const parts = [];
  const add = (/** @type {unknown} */ s) => {
    const t = plain(s);
    if (t) parts.push(t);
  };

  add(q.stem);
  const choices = Array.isArray(q.choices) ? q.choices : [];
  for (const c of choices) if (isPlainObject(c)) add(c.text);

  if (isPlainObject(q.choiceNotes)) {
    const notes = /** @type {Record<string, unknown>} */ (q.choiceNotes);
    const done = new Set();
    for (const c of choices) {
      if (isPlainObject(c) && typeof c.id === 'string' && Object.hasOwn(notes, c.id)) {
        add(notes[c.id]);
        done.add(c.id);
      }
    }
    for (const [k, v] of Object.entries(notes)) if (!done.has(k)) add(v);
  }

  if (Array.isArray(q.explanation)) for (const b of q.explanation) collectBlockText(b, add);

  const text = parts.join('\n');
  plainTextCache.set(q, text);
  return text;
}

/**
 * Forgets every loaded file (index and chapters), so the next call fetches
 * again. For tests and for a manual "reload questions" action.
 * @returns {void}
 */
export function clearDataCache() {
  indexPromise = null;
  indexState = null;
}
