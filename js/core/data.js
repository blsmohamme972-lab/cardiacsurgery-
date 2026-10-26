/**
 * Question bank loader (docs/ARCHITECTURE.md §3, §5.6).
 *
 * - `data/index.json` lists the chapters; each chapter lives in its own JSON
 *   file and is fetched only when first needed (lazy), then kept in memory.
 * - Every load is memoized as a promise, so concurrent callers share one
 *   request. A failed load is forgotten, so the next call retries.
 * - URLs are resolved relative to the app folder (derived from this module's
 *   own URL), so the app works under any sub-path (`/cardiacsurgery-/`) and
 *   inside a Capacitor wrapper. The service worker serves them offline.
 * - Data is checked on arrival (schema version, chapter id, question shape).
 *   A malformed question is skipped with a console warning instead of
 *   breaking the whole chapter; `scripts/validate.mjs` catches these before
 *   release.
 * - Failures throw {@link DataError} with a plain-language `message`.
 *
 * Returned objects are shared, in-memory data: treat them as read-only.
 * Arrays returned to callers are fresh copies, so sorting them is safe.
 *
 * Importing this module does not touch `document` or `window`.
 *
 * @module core/data
 */

import { inlineToPlain } from '../features/explain/inline.js';

/**
 * @typedef {object} Chapter
 * @property {string} id         Stable chapter id, e.g. `"cpb"`.
 * @property {string} prefix     Question id prefix, e.g. `"CPB"`.
 * @property {string} title      Full title.
 * @property {string} short      Short title for tight spaces.
 * @property {string} file       Relative path of the chapter file, e.g. `"data/ch01-cpb.json"`.
 * @property {number} order      Sort order (demo is 99).
 * @property {number} count      Number of questions in the file.
 * @property {boolean} demo      True for the "App tour (demo)" chapter.
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
 * @typedef {'offline'|'network'|'timeout'|'not-found'|'http'|'parse'|'schema'|'version'|'unknown-chapter'} DataErrorCode
 */

/** Highest data schema version this app understands. */
export const SCHEMA_VERSION = 1;

/** Question id: `PREFIX-NNNN` (4+ digits). Group 1 is the prefix. */
export const QID_RE = /^([A-Z][A-Z0-9]*)-(\d{4,})$/;

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
 * @typedef {object} IndexState
 * @property {number} schemaVersion
 * @property {Chapter[]} chapters          Sorted by `order`.
 * @property {Map<string, Chapter>} byId
 * @property {Map<string, Chapter>} byPrefix
 */

/**
 * @typedef {object} ChapterState
 * @property {Chapter} chapter
 * @property {Question[]} questions
 * @property {Map<string, Question>} byId
 */

/** @type {Promise<IndexState> | null} */
let indexPromise = null;
/** Resolved index, for the synchronous {@link chapterIdFromQid}. @type {IndexState | null} */
let indexState = null;
/** @type {Map<string, Promise<ChapterState>>} */
const chapterPromises = new Map();
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
 * Resolves an app-relative data path (`data/…`) to an absolute URL.
 * Rejects absolute, protocol-relative, parent-escaping or scheme URLs: data
 * files must stay inside the app folder.
 * @param {unknown} relPath
 * @returns {string}
 */
function resolveDataUrl(relPath) {
  const p = typeof relPath === 'string' ? relPath.trim() : '';
  const unsafe =
    p === '' ||
    p.startsWith('/') ||
    p.includes('\\') ||
    /^[a-z][a-z0-9+.-]*:/i.test(p) ||
    p.split('/').some((seg) => seg === '..');
  if (unsafe) {
    throw new DataError(MESSAGES.schema, { code: 'schema', detail: `Unsafe data path: ${JSON.stringify(relPath)}` });
  }
  return new URL(p, APP_ROOT).href;
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
 * @param {string} relPath App-relative path, e.g. `data/ch01-cpb.json`.
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
 * Validates and normalizes `data/index.json`. Bad chapter entries are skipped.
 * @param {Record<string, any>} raw
 * @param {string} url
 * @returns {IndexState}
 */
function normalizeIndex(raw, url) {
  checkSchemaVersion(raw, url);
  if (!Array.isArray(raw.chapters)) {
    throw new DataError(MESSAGES.schema, { code: 'schema', url, detail: '"chapters" must be an array' });
  }

  /** @type {Chapter[]} */
  const chapters = [];
  const byId = new Map();
  const byPrefix = new Map();

  raw.chapters.forEach((entry, i) => {
    if (!isPlainObject(entry)) {
      warn(`index.json: chapters[${i}] is not an object; skipped.`);
      return;
    }
    const { id, prefix, file } = entry;
    if (!isNonEmptyString(id) || typeof prefix !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(prefix) || !isNonEmptyString(file)) {
      warn(`index.json: chapters[${i}] needs "id", an uppercase "prefix" and "file"; skipped.`);
      return;
    }
    if (byId.has(id) || byPrefix.has(prefix)) {
      warn(`index.json: duplicate chapter id "${id}" or prefix "${prefix}"; skipped.`);
      return;
    }
    const title = isNonEmptyString(entry.title) ? entry.title : id;
    /** @type {Chapter} */
    const chapter = {
      ...entry,
      id,
      prefix,
      title,
      short: isNonEmptyString(entry.short) ? entry.short : title,
      file: file.trim(),
      order: Number.isFinite(entry.order) ? entry.order : 1000 + i,
      count: Number.isInteger(entry.count) && entry.count >= 0 ? entry.count : 0,
      demo: entry.demo === true || id === 'demo',
    };
    chapters.push(chapter);
    byId.set(id, chapter);
    byPrefix.set(prefix, chapter);
  });

  if (chapters.length === 0) {
    throw new DataError(MESSAGES.schema, { code: 'schema', url, detail: 'No valid chapters in index' });
  }
  chapters.sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { schemaVersion: raw.schemaVersion, chapters, byId, byPrefix };
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

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

/**
 * Light runtime check so one malformed question can't break a screen.
 * Full validation happens before release (`scripts/validate.mjs`).
 * @param {any} q
 * @param {Chapter} chapter
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
 * @param {Chapter} chapter
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
 * Memoized chapter load by id (shared promise; forgotten on failure).
 * @param {string} id
 * @returns {Promise<ChapterState>}
 */
function ensureChapter(id) {
  let p = chapterPromises.get(id);
  if (p) return p;
  p = (async () => {
    const index = await ensureIndex();
    const chapter = index.byId.get(id);
    if (!chapter) {
      throw new DataError(MESSAGES.unknownChapter, { code: 'unknown-chapter', detail: `No chapter "${id}" in ${INDEX_PATH}` });
    }
    const { data, url } = await fetchJson(chapter.file);
    return normalizeChapter(data, chapter, url);
  })();
  const pending = p;
  chapterPromises.set(id, pending);
  pending.catch(() => {
    if (chapterPromises.get(id) === pending) chapterPromises.delete(id);
  });
  return pending;
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
 * Loads the chapter list (`data/index.json`). Memoized: concurrent and later
 * calls share one request. Chapters are sorted by `order`.
 *
 * @returns {Promise<{ schemaVersion: number, chapters: Chapter[] }>} A fresh
 *   wrapper and array on every call (chapter objects are shared; read-only).
 * @throws {DataError} When the list can't be loaded or is invalid.
 * @example
 * const { chapters } = await loadIndex();
 * chapters.filter((c) => !c.demo).map((c) => c.title);
 */
export async function loadIndex() {
  const state = await ensureIndex();
  return { schemaVersion: state.schemaVersion, chapters: state.chapters.slice() };
}

/**
 * Loads one chapter and its questions. Memoized per chapter id. Each question
 * gets a `chapterId` field.
 *
 * @param {string} id Chapter id, e.g. `"cpb"` or `"demo"`.
 * @returns {Promise<{ chapter: Chapter, questions: Question[] }>} `questions`
 *   is a fresh array in file order (question objects are shared; read-only).
 * @throws {DataError} `unknown-chapter` for an unknown id, or a load/format error.
 */
export async function loadChapter(id) {
  if (!isNonEmptyString(id)) {
    throw new DataError(MESSAGES.unknownChapter, { code: 'unknown-chapter', detail: `Invalid chapter id: ${JSON.stringify(id)}` });
  }
  const state = await ensureChapter(id);
  return { chapter: state.chapter, questions: state.questions.slice() };
}

/**
 * Loads every chapter (in parallel) and returns all questions in chapter
 * order, then file order.
 *
 * @param {{ includeDemo?: boolean }} [options] `includeDemo` (default true)
 *   includes the "App tour (demo)" chapter.
 * @returns {Promise<Question[]>} A fresh array.
 * @throws {DataError} When any chapter can't be loaded.
 */
export async function loadAll({ includeDemo = true } = {}) {
  const index = await ensureIndex();
  const wanted = index.chapters.filter((c) => includeDemo || !c.demo);
  const states = await Promise.all(wanted.map((c) => ensureChapter(c.id)));
  return states.flatMap((s) => s.questions);
}

/**
 * Finds one question by id. The chapter is found from the id prefix and
 * loaded on demand.
 *
 * @param {string} qid e.g. `"CPB-0001"`.
 * @returns {Promise<Question | null>} Null when the id is malformed, its
 *   prefix is unknown, or the chapter has no such question.
 * @throws {DataError} When the chapter file can't be loaded.
 */
export async function getQuestion(qid) {
  const prefix = prefixOf(qid);
  if (!prefix) return null;
  const index = await ensureIndex();
  const chapter = index.byPrefix.get(prefix);
  if (!chapter) return null;
  const state = await ensureChapter(chapter.id);
  return state.byId.get(/** @type {string} */ (qid)) ?? null;
}

/**
 * Finds many questions at once, loading the chapters they need in parallel.
 *
 * @param {Iterable<string>} qids
 * @returns {Promise<Question[]>} In the same order as `qids`; ids that don't
 *   exist (malformed, unknown prefix, retired or deleted) are skipped.
 * @throws {DataError} When a needed chapter file can't be loaded.
 */
export async function getQuestions(qids) {
  const list = qids == null ? [] : Array.from(qids);
  if (list.length === 0) return [];
  const index = await ensureIndex();

  /** @type {Set<string>} */
  const chapterIds = new Set();
  for (const qid of list) {
    const chapter = index.byPrefix.get(prefixOf(qid) ?? '');
    if (chapter) chapterIds.add(chapter.id);
  }
  const states = new Map(
    await Promise.all([...chapterIds].map(async (id) => /** @type {const} */ ([id, await ensureChapter(id)]))),
  );

  /** @type {Question[]} */
  const out = [];
  for (const qid of list) {
    const chapter = index.byPrefix.get(prefixOf(qid) ?? '');
    const q = chapter ? states.get(chapter.id)?.byId.get(qid) : undefined;
    if (q) out.push(q);
  }
  return out;
}

/**
 * Maps a question id to its chapter id using the id prefix. Synchronous:
 * returns null until {@link loadIndex} has resolved once.
 *
 * @param {string} qid e.g. `"VALV-0012"`.
 * @returns {string | null} e.g. `"valves"`, or null when unknown.
 */
export function chapterIdFromQid(qid) {
  if (!indexState) return null;
  const prefix = prefixOf(qid);
  if (!prefix) return null;
  return indexState.byPrefix.get(prefix)?.id ?? null;
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
  chapterPromises.clear();
}
