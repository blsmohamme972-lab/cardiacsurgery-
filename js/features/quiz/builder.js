/**
 * Quiz builder: selects the question ids of a new quiz from chapters and a
 * filter (docs/ARCHITECTURE.md §7.2).
 *
 * - {@link filterQids} and {@link pickQids} are pure (no I/O, no DOM), so they
 *   run in Node unit tests.
 * - {@link buildQuestionSet} and {@link countAvailable} load the question bank
 *   (`core/data.js`) and the learner's progress (`core/store/repo.js`). Those
 *   modules are imported lazily, on first use, so importing this file never
 *   opens IndexedDB or fetches data.
 *
 * Filters:
 * | filter       | questions                                                     | natural order               |
 * |--------------|---------------------------------------------------------------|-----------------------------|
 * | `all`        | every question                                                | bank order                  |
 * | `new`        | never answered                                                | bank order                  |
 * | `incorrect`  | last answer was wrong (the "Mistakes" list)                   | most recent mistake first   |
 * | `bookmarked` | bookmarked                                                    | bank order                  |
 * | `due`        | spaced-repetition review is due                               | most overdue first          |
 * | `unreviewed` | not yet checked by a specialist (`reviewed === false`)        | bank order                  |
 * | `flagged`    | has a "report a problem" entry                                | bank order                  |
 * | `notes`      | has a text note                                               | bank order                  |
 *
 * Chapters: `'all'` means the chapters the learner studies
 * (`data.studyChapters()`: the published chapters, or the demo alone in demo
 * mode). Explicit chapter ids are limited to published chapters and the demo;
 * unknown and unpublished ids are ignored, so an unpublished chapter's file is
 * never fetched.
 *
 * Bank order = published chapters by number, then the demo; inside a chapter,
 * file order.
 *
 * @module features/quiz/builder
 */

import { seededRandom, shuffle } from '../../core/util.js';
import { isDue } from '../srs.js';

/**
 * @typedef {import('../../core/data.js').Question} Question
 * @typedef {import('../../core/store/repo.js').QState} QState
 * @typedef {'all'|'new'|'incorrect'|'bookmarked'|'due'|'unreviewed'|'flagged'|'notes'} Filter
 * @typedef {{ flagged?: Set<string> | Iterable<string>, notes?: Set<string> | Iterable<string> }} Extras
 */

/** Every filter, in the order the builder shows them. */
export const FILTERS = Object.freeze(['all', 'new', 'incorrect', 'bookmarked', 'due', 'unreviewed', 'flagged', 'notes']);

/** Short English labels for the filters (UI and session titles). */
export const FILTER_LABELS = Object.freeze({
  all: 'All',
  new: 'New',
  incorrect: 'Mistakes',
  bookmarked: 'Bookmarks',
  due: 'Due review',
  unreviewed: 'Unreviewed',
  flagged: 'Flagged',
  notes: 'With notes',
});

/** Filters whose natural order is a priority (kept first when `count` limits the set). */
const PRIORITY_FILTERS = new Set(['due', 'incorrect']);

/** Filters that need the learner's per-question state. */
const STATE_FILTERS = new Set(['new', 'incorrect', 'bookmarked', 'due']);

const FILTER_SET = new Set(FILTERS);

/**
 * True when `f` is one of {@link FILTERS}.
 * @param {unknown} f
 * @returns {f is Filter}
 */
export function isFilter(f) {
  return typeof f === 'string' && FILTER_SET.has(f);
}

/**
 * @param {unknown} filter
 * @returns {Filter}
 */
function checkFilter(filter) {
  const f = filter === undefined || filter === null ? 'all' : filter;
  if (!isFilter(f)) throw new RangeError(`Unknown quiz filter: ${JSON.stringify(filter)}`);
  return f;
}

/**
 * Normalizes the `states` argument to a lookup function.
 * Accepts a Map (qid → QState), a plain object, or an array of QState records.
 * @param {Map<string, QState> | Record<string, QState> | QState[] | null | undefined} states
 * @returns {(qid: string) => QState | undefined}
 */
function stateLookup(states) {
  if (!states) return () => undefined;
  if (states instanceof Map) return (qid) => states.get(qid);
  if (Array.isArray(states)) {
    const m = new Map();
    for (const s of states) if (s && typeof s.qid === 'string') m.set(s.qid, s);
    return (qid) => m.get(qid);
  }
  if (typeof states === 'object') {
    const obj = /** @type {Record<string, QState>} */ (states);
    return (qid) => (Object.hasOwn(obj, qid) ? obj[qid] : undefined);
  }
  return () => undefined;
}

/**
 * @param {Set<string> | Iterable<string> | null | undefined} v
 * @returns {Set<string>}
 */
function toSet(v) {
  if (v instanceof Set) return v;
  if (v && typeof (/** @type {any} */ (v)[Symbol.iterator]) === 'function') return new Set(v);
  return new Set();
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * True when the question has never been answered.
 * @param {QState | undefined} st
 * @returns {boolean}
 */
function isNew(st) {
  if (!st) return true;
  return !(num(st.seen) > 0 || num(st.correct) + num(st.incorrect) > 0 || st.lastChoice != null);
}

/**
 * True when the last answer was wrong. Older records without `lastCorrect`
 * fall back to the counters (wrong at least once, never right).
 * @param {QState | undefined} st
 * @returns {boolean}
 */
function isMistake(st) {
  if (!st) return false;
  if (st.lastCorrect === false) return true;
  if (st.lastCorrect === true) return false;
  return num(st.incorrect) > 0 && num(st.correct) === 0;
}

/**
 * Selects the ids of the questions that match a filter. Pure.
 *
 * Duplicates and malformed questions are skipped. The result keeps the input
 * (bank) order, except:
 * - `due`: most overdue first (`srs.due` ascending),
 * - `incorrect`: most recent mistake first (`lastTs` descending).
 * Ties keep the input order.
 *
 * @param {Question[]} questions Candidate questions, in bank order.
 * @param {Map<string, QState> | Record<string, QState> | QState[] | null} [states] Learner state per qid.
 * @param {Extras | null} [extras] `flagged`: qids with a report; `notes`: qids with a note.
 * @param {Filter} [filter] One of {@link FILTERS} (default `'all'`).
 * @param {number} [now] Used by `due`. Defaults to `Date.now()`.
 * @returns {string[]} Matching question ids.
 * @throws {RangeError} For an unknown filter.
 */
export function filterQids(questions, states, extras, filter = 'all', now = Date.now()) {
  const f = checkFilter(filter);
  const list = Array.isArray(questions) ? questions : [];
  const getState = stateLookup(states);
  const flagged = f === 'flagged' ? toSet(extras?.flagged) : null;
  const notes = f === 'notes' ? toSet(extras?.notes) : null;

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {{ qid: string, key: number, i: number }[]} */
  const out = [];

  for (const q of list) {
    const qid = q && typeof q.id === 'string' ? q.id : null;
    if (!qid || seen.has(qid)) continue;
    seen.add(qid);

    let keep = false;
    let key = 0;
    switch (f) {
      case 'all':
        keep = true;
        break;
      case 'new':
        keep = isNew(getState(qid));
        break;
      case 'incorrect': {
        const st = getState(qid);
        keep = isMistake(st);
        key = -num(st?.lastTs);
        break;
      }
      case 'bookmarked':
        keep = getState(qid)?.bookmarked === true;
        break;
      case 'due': {
        const srs = getState(qid)?.srs;
        keep = isDue(srs, now);
        key = keep ? num(srs?.due) : 0;
        break;
      }
      case 'unreviewed':
        keep = q.reviewed === false;
        break;
      case 'flagged':
        keep = /** @type {Set<string>} */ (flagged).has(qid);
        break;
      case 'notes':
        keep = /** @type {Set<string>} */ (notes).has(qid);
        break;
      default:
        keep = false;
    }
    if (keep) out.push({ qid, key, i: out.length });
  }

  if (PRIORITY_FILTERS.has(f)) out.sort((a, b) => a.key - b.key || a.i - b.i);
  return out.map((x) => x.qid);
}

/**
 * Turns a `count` option into a whole number of questions.
 * `'all'`, `undefined`, `null`, `Infinity` and invalid values mean "all".
 * @param {number | 'all' | string | null | undefined} count
 * @param {number} available
 * @returns {number}
 */
export function resolveCount(count, available) {
  const max = Math.max(0, Math.floor(num(available)));
  if (count === undefined || count === null || count === 'all' || count === '') return max;
  const n = Number(count);
  if (Number.isNaN(n) || n === Infinity) return max;
  return Math.min(max, Math.max(0, Math.floor(n)));
}

/**
 * Limits and orders filtered ids. Pure (deterministic for a given `seed`).
 *
 * - `count` limits the set. For `due` and `incorrect` the first ids (most
 *   overdue / most recent mistakes) are kept; otherwise a random sample
 *   (order `random`) or the first ids (order `sequential`) are kept.
 * - `random` shuffles the kept ids with `seededRandom(seed)`; `sequential`
 *   keeps the filter's natural order.
 *
 * @param {string[]} qids Output of {@link filterQids}.
 * @param {{ filter?: Filter, count?: number | 'all', order?: 'random' | 'sequential', seed?: number | string }} [options]
 * @returns {string[]} A new array.
 */
export function pickQids(qids, { filter = 'all', count = 'all', order = 'random', seed } = {}) {
  const list = Array.isArray(qids) ? qids.slice() : [];
  const limit = resolveCount(count, list.length);
  if (limit === 0) return [];
  if (order === 'sequential') return list.slice(0, limit);

  const rand = seededRandom(seed ?? Date.now());
  let kept = list;
  if (limit < list.length) {
    kept = PRIORITY_FILTERS.has(/** @type {string} */ (filter)) ? list.slice(0, limit) : shuffle(list, rand).slice(0, limit);
  }
  return shuffle(kept, rand);
}

// ---------------------------------------------------------------------------
// Loading (lazy imports keep this module import-safe in Node)
// ---------------------------------------------------------------------------

/** @type {Promise<typeof import('../../core/data.js')> | null} */
let dataModule = null;
/** @type {Promise<typeof import('../../core/store/repo.js')> | null} */
let repoModule = null;

/** @returns {Promise<typeof import('../../core/data.js')>} */
function loadDataModule() {
  if (!dataModule) {
    dataModule = import('../../core/data.js');
    dataModule.catch(() => {
      dataModule = null;
    });
  }
  return dataModule;
}

/** @returns {Promise<typeof import('../../core/store/repo.js')>} */
function loadRepoModule() {
  if (!repoModule) {
    repoModule = import('../../core/store/repo.js');
    repoModule.catch(() => {
      repoModule = null;
    });
  }
  return repoModule;
}

/**
 * Resolves the `chapters` option to the ids of the chapters to load, in bank
 * order. Only chapters the learner can see are ever returned, so the file of
 * an unpublished chapter is never fetched.
 *
 * - `'all'` (or a missing value): `data.studyChapters()`, i.e. the published
 *   chapters, or the demo alone in demo mode. `includeDemo` adds the demo
 *   outside demo mode too.
 * - Explicit ids (an array, a Set or another iterable, or one id string):
 *   limited to the published chapters and the demo. Unknown and unpublished
 *   ids are ignored; duplicates count once.
 *
 * @param {typeof import('../../core/data.js')} data
 * @param {Iterable<string> | 'all' | string | null | undefined} chapters
 * @param {boolean} includeDemo
 * @returns {Promise<string[]>}
 */
async function resolveChapterIds(data, chapters, includeDemo) {
  if (chapters === undefined || chapters === null || chapters === 'all') {
    const ids = (await data.studyChapters()).map((c) => c.id);
    if (includeDemo) {
      const { demo } = await data.loadIndex();
      if (demo && !ids.includes(demo.id)) ids.push(demo.id);
    }
    return ids;
  }
  // A Set (or any other iterable of ids) works like an array; a single id string like a one-item list.
  const iterable = typeof chapters !== 'string' && typeof (/** @type {any} */ (chapters)[Symbol.iterator]) === 'function';
  const wanted = new Set(iterable ? /** @type {Iterable<string>} */ (chapters) : [chapters]);
  if (wanted.size === 0) return [];
  const { chapters: published, demo } = await data.loadIndex();
  const visible = demo ? [...published, demo] : published;
  return visible.filter((c) => wanted.has(c.id)).map((c) => c.id);
}

/**
 * Loads the candidate questions of the chosen chapters, in bank order
 * (see {@link resolveChapterIds} for which chapters count).
 * @param {Iterable<string> | 'all' | string | null | undefined} chapters
 * @param {boolean} includeDemo
 * @returns {Promise<Question[]>}
 */
async function loadPool(chapters, includeDemo) {
  const data = await loadDataModule();
  const ids = await resolveChapterIds(data, chapters, Boolean(includeDemo));
  const loaded = await Promise.all(ids.map((id) => data.loadChapter(id)));
  return loaded.flatMap((c) => c.questions);
}

/**
 * Loads only the learner data the filter needs.
 * @param {Filter} filter
 * @returns {Promise<{ states: Map<string, QState> | null, extras: { flagged: Set<string>, notes: Set<string> } }>}
 */
async function loadContext(filter) {
  const extras = { flagged: new Set(), notes: new Set() };
  if (!STATE_FILTERS.has(filter) && filter !== 'flagged' && filter !== 'notes') return { states: null, extras };
  const repo = await loadRepoModule();
  /** @type {Map<string, QState> | null} */
  let states = null;
  if (STATE_FILTERS.has(filter)) {
    const rows = await repo.qstateRepo.all();
    states = new Map();
    for (const st of rows || []) if (st && typeof st.qid === 'string') states.set(st.qid, st);
  }
  if (filter === 'flagged') {
    for (const r of (await repo.reportsRepo.all()) || []) if (r && typeof r.qid === 'string') extras.flagged.add(r.qid);
  }
  if (filter === 'notes') {
    for (const n of (await repo.notesRepo.all()) || []) {
      if (n && typeof n.qid === 'string' && typeof n.text === 'string' && n.text.trim() !== '') extras.notes.add(n.qid);
    }
  }
  return { states, extras };
}

/**
 * Builds the question id list of a new quiz.
 *
 * @param {object} [options]
 * @param {Iterable<string> | 'all'} [options.chapters] Chapter ids (published chapters and `'demo'`;
 *   others are ignored), or `'all'` (default) for the study chapters (published, or the demo in demo mode).
 * @param {Filter} [options.filter] Default `'all'`.
 * @param {number | 'all'} [options.count] How many questions (default all that match).
 * @param {'random' | 'sequential'} [options.order] Default `'random'`.
 * @param {boolean} [options.includeDemo] With `chapters: 'all'`, also include the demo outside
 *   demo mode (dev/tests only; default false).
 * @param {number | string} [options.seed] Seed for the random order (default `Date.now()`).
 * @param {number} [options.now] Reference time for `due` (default `Date.now()`).
 * @returns {Promise<string[]>} Question ids (empty when nothing matches).
 * @throws {RangeError} For an unknown filter.
 * @throws {Error} `DataError` / `StorageError` with a plain-language message when loading fails.
 */
export async function buildQuestionSet({
  chapters = 'all',
  filter = 'all',
  count,
  order = 'random',
  includeDemo = false,
  seed,
  now,
} = {}) {
  const f = checkFilter(filter);
  const [pool, ctx] = await Promise.all([loadPool(chapters, includeDemo), loadContext(f)]);
  const matched = filterQids(pool, ctx.states, ctx.extras, f, now ?? Date.now());
  return pickQids(matched, { filter: f, count, order: order === 'sequential' ? 'sequential' : 'random', seed: seed ?? Date.now() });
}

/**
 * Counts the questions a quiz with these options could use (for the live
 * "N questions available" line).
 *
 * @param {object} [options]
 * @param {Iterable<string> | 'all'} [options.chapters] Default `'all'` (same rules as {@link buildQuestionSet}).
 * @param {Filter} [options.filter] Default `'all'`.
 * @param {boolean} [options.includeDemo] Default false (same rules as {@link buildQuestionSet}).
 * @param {number} [options.now] Reference time for `due` (default `Date.now()`).
 * @returns {Promise<number>}
 * @throws {RangeError} For an unknown filter.
 * @throws {Error} `DataError` / `StorageError` with a plain-language message when loading fails.
 */
export async function countAvailable({ chapters = 'all', filter = 'all', includeDemo = false, now } = {}) {
  const f = checkFilter(filter);
  const [pool, ctx] = await Promise.all([loadPool(chapters, includeDemo), loadContext(f)]);
  return filterQids(pool, ctx.states, ctx.extras, f, now ?? Date.now()).length;
}
