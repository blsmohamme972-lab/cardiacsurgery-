/**
 * One place that starts a quiz (docs/ARCHITECTURE.md §7.13): Home quick
 * actions, the Chapter screen, the Builder, Results "Retry mistakes" and
 * Settings "Try the demo" all call {@link startQuiz} and then navigate to
 * `/quiz/<id>`.
 *
 * - {@link sessionTitle} and {@link noQuestionsMessage} are pure.
 * - {@link startAndOpen} wraps it for buttons: busy state, navigation, toast on failure.
 * - {@link startQuiz} reads the study settings (`shuffleChoices`,
 *   `defaultCount`, `examSecondsPerQuestion`), selects the questions with
 *   `builder.buildQuestionSet()` (or uses an explicit `qids` list) and stores
 *   a new session with `engine.createSession()`.
 *
 * Importing this module opens no database and fetches nothing (the data
 * module is only imported when a default title needs chapter names).
 *
 * @module features/quiz/start
 */

import { getSetting } from '../../core/settings.js';
import { seededRandom, shuffle } from '../../core/util.js';
import { buildQuestionSet, FILTER_LABELS, isFilter } from './builder.js';
import { createSession, DEFAULT_TITLES, SessionError } from './engine.js';

/** Separator between the parts of a session title. */
export const TITLE_SEPARATOR = ' · ';

/** Upper bound for a custom question count (keeps one session a sane size). */
export const MAX_COUNT = 1000;

/**
 * Plain-language "nothing matched" messages, each with a next step.
 * @type {Readonly<Record<string, string>>}
 */
const EMPTY_MESSAGES = Object.freeze({
  all: 'There are no questions here yet. Try other chapters.',
  new: "You've answered every question here. Try Mistakes or Due for review.",
  incorrect: 'No mistakes to redo. Questions you get wrong will appear here.',
  bookmarked: 'No bookmarks yet. Tap the bookmark icon on any question to save it.',
  due: 'Nothing is due for review right now. Answered questions come back here when it is time.',
  unreviewed: 'Every question here has been reviewed. Try another filter.',
  flagged: "You haven't reported any question. Use “Report a problem” on a question to flag it.",
  notes: 'No questions with notes yet. Add a note to any question to find it here.',
  explicit: 'These questions are no longer available. Try another list.',
});

/**
 * The plain-language message for a quiz with no questions.
 * @param {string} [filter] A builder filter, or `'explicit'` for an explicit id list.
 * @returns {string}
 */
export function noQuestionsMessage(filter) {
  return (typeof filter === 'string' && Object.hasOwn(EMPTY_MESSAGES, filter) ? EMPTY_MESSAGES[filter] : null) ?? EMPTY_MESSAGES.all;
}

/**
 * Thrown by {@link startQuiz} when no question matches. `userMessage` is
 * safe to show in a toast and says what to do next.
 */
export class NoQuestionsError extends Error {
  /**
   * @param {string} [filter] The filter that matched nothing (`'explicit'` for an id list).
   * @param {{ cause?: unknown }} [info]
   */
  constructor(filter = 'all', { cause } = {}) {
    const message = noQuestionsMessage(filter);
    super(message);
    this.name = 'NoQuestionsError';
    /** @type {string} */
    this.filter = typeof filter === 'string' ? filter : 'all';
    /** @type {string} */
    this.userMessage = message;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * @param {unknown} map
 * @param {string} id
 * @returns {string | null}
 */
function titleFrom(map, id) {
  if (!map) return null;
  /** @type {unknown} */
  let v;
  if (map instanceof Map) v = map.get(id);
  else if (typeof map === 'object' && Object.hasOwn(/** @type {object} */ (map), id)) v = /** @type {any} */ (map)[id];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * A short, readable session title, e.g. `"Practice · Mitral valve · Mistakes"`.
 *
 * - mode → `"Practice"` / `"Exam"` (unknown → `"Practice"`);
 * - one chapter → its name from `chapterTitles` (omitted when unknown);
 *   several → `"3 chapters"`; `'all'` / none → omitted;
 * - filter other than `'all'` → its label (`incorrect` → `"Mistakes"`).
 *
 * Pure.
 * @param {object} [opts]
 * @param {'tutor' | 'exam' | string} [opts.mode]
 * @param {string[] | 'all' | string | null} [opts.chapters]
 * @param {string} [opts.filter]
 * @param {Record<string, string> | Map<string, string>} [opts.chapterTitles] Chapter id → display name (short label preferred).
 * @returns {string}
 */
export function sessionTitle({ mode, chapters, filter, chapterTitles } = {}) {
  const parts = [mode === 'exam' ? DEFAULT_TITLES.exam : DEFAULT_TITLES.tutor];
  /** @type {string[]} */
  let ids = [];
  if (Array.isArray(chapters)) ids = [...new Set(chapters.filter((c) => typeof c === 'string' && c !== ''))];
  else if (typeof chapters === 'string' && chapters !== '' && chapters !== 'all') ids = [chapters];
  if (ids.length === 1) {
    const name = titleFrom(chapterTitles, ids[0]);
    if (name) parts.push(name);
  } else if (ids.length > 1) {
    parts.push(`${ids.length} chapters`);
  }
  if (typeof filter === 'string' && filter !== 'all' && isFilter(filter)) {
    parts.push(/** @type {Record<string, string>} */ (FILTER_LABELS)[filter]);
  }
  return parts.join(TITLE_SEPARATOR);
}

/**
 * Normalizes a count option: a positive whole number (capped at
 * {@link MAX_COUNT}), or `'all'`. Invalid values give `fallback`.
 * Pure.
 * @param {unknown} count
 * @param {number | 'all'} fallback
 * @returns {number | 'all'}
 */
export function normalizeCount(count, fallback) {
  if (count === 'all') return 'all';
  const n = Math.floor(Number(count));
  if (count === null || count === undefined || count === '' || !Number.isFinite(n) || n < 1) return fallback;
  return Math.min(MAX_COUNT, n);
}

/**
 * @param {string} key
 * @param {any} fallback
 * @returns {any}
 */
function setting(key, fallback) {
  try {
    const v = getSetting(key);
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * Chapter id → short name, for the default title (best effort).
 * @param {string[]} ids
 * @returns {Promise<Record<string, string>>}
 */
async function chapterNames(ids) {
  /** @type {Record<string, string>} */
  const out = {};
  if (ids.length !== 1) return out;
  try {
    const data = await import('../../core/data.js');
    const c = await data.getChapter(ids[0]);
    if (c) out[c.id] = c.short || c.title;
  } catch {
    /* A missing name only shortens the title. */
  }
  return out;
}

/**
 * Starts a new quiz and returns its session id. The caller navigates to
 * `/quiz/<id>`.
 *
 * With `qids`, exactly those questions are used (duplicates and unavailable
 * ids dropped; shuffled unless `order` is `'sequential'`; limited only when
 * `count` is given). Otherwise `builder.buildQuestionSet()` picks them from
 * `chapters` + `filter` (count defaults to the `defaultCount` setting).
 *
 * @param {object} [opts]
 * @param {string[] | 'all'} [opts.chapters='all']
 * @param {string} [opts.filter='all'] A builder filter (`all new incorrect bookmarked due unreviewed flagged notes`).
 * @param {number | 'all'} [opts.count] Default: setting `defaultCount`.
 * @param {'tutor' | 'exam'} [opts.mode='tutor']
 * @param {'random' | 'sequential'} [opts.order='random']
 * @param {string} [opts.title] Default: {@link sessionTitle}.
 * @param {string[]} [opts.qids] Explicit question ids.
 * @param {boolean} [opts.shuffleChoices] Default: setting `shuffleChoices` (the Builder's toggle overrides it).
 * @returns {Promise<string>} The new session id.
 * @throws {NoQuestionsError} When no question matches (plain-language `userMessage`).
 * @throws {Error} `DataError` / `StorageError` (plain-language message) when loading or saving fails.
 */
export async function startQuiz({
  chapters = 'all',
  filter = 'all',
  count,
  mode = 'tutor',
  order = 'random',
  title,
  qids,
  shuffleChoices,
} = {}) {
  const m = mode === 'exam' ? 'exam' : 'tutor';
  const f = isFilter(filter) ? filter : 'all';
  const chapterList = Array.isArray(chapters) ? chapters.filter((c) => typeof c === 'string' && c !== '') : 'all';
  const shuffleOpt = typeof shuffleChoices === 'boolean' ? shuffleChoices : setting('shuffleChoices', true) !== false;
  const seconds = Number(setting('examSecondsPerQuestion', 90)) || 90;

  /** @type {string[]} */
  let ids;
  const explicit = Array.isArray(qids);
  if (explicit) {
    ids = [...new Set(qids.filter((q) => typeof q === 'string' && q !== ''))];
    if (order !== 'sequential') ids = shuffle(ids, seededRandom(Date.now()));
    const limit = count === undefined ? 'all' : normalizeCount(count, 'all');
    if (limit !== 'all') ids = ids.slice(0, limit);
  } else {
    const fallback = normalizeCount(setting('defaultCount', 20), 20);
    ids = await buildQuestionSet({
      chapters: chapterList,
      filter: /** @type {any} */ (f),
      count: normalizeCount(count, fallback),
      order: order === 'sequential' ? 'sequential' : 'random',
    });
  }
  const reason = explicit ? 'explicit' : f;
  if (ids.length === 0) throw new NoQuestionsError(reason);

  const chosenChapters = chapterList === 'all' ? 'all' : chapterList;
  let name = typeof title === 'string' && title.trim() !== '' ? title.trim() : '';
  if (!name) {
    const names = chosenChapters === 'all' ? {} : await chapterNames(chosenChapters);
    name = sessionTitle({ mode: m, chapters: chosenChapters, filter: explicit ? 'all' : f, chapterTitles: names });
  }

  try {
    const session = await createSession({
      qids: ids,
      title: name,
      mode: m,
      shuffleChoices: shuffleOpt,
      secondsPerQuestion: seconds,
      chapters: chosenChapters,
      filter: f,
    });
    return session.id;
  } catch (err) {
    if (err instanceof SessionError && err.code === 'empty') throw new NoQuestionsError(reason, { cause: err });
    throw err;
  }
}

/**
 * Starts a quiz and opens it: the one-tap path used by every screen button.
 * Shows a busy state on `trigger` while it works (and ignores repeat taps),
 * navigates to `/quiz/<id>` on success, and otherwise shows a toast with a
 * plain-language message and a next step (never a dead end). The router and
 * the UI kit are imported lazily, so this module stays importable in Node.
 *
 * @param {Parameters<typeof startQuiz>[0]} opts Same options as {@link startQuiz}.
 * @param {{ trigger?: HTMLButtonElement | null }} [ui]
 * @returns {Promise<string | null>} The new session id, or null when nothing was started.
 */
export async function startAndOpen(opts, { trigger } = {}) {
  if (trigger) {
    if (trigger.getAttribute('aria-busy') === 'true') return null;
    trigger.setAttribute('aria-busy', 'true');
  }
  try {
    const id = await startQuiz(opts);
    const { navigate } = await import('../../core/router.js');
    navigate(`/quiz/${encodeURIComponent(id)}`);
    return id;
  } catch (err) {
    const known = err instanceof NoQuestionsError;
    const e = /** @type {any} */ (err);
    if (!known) console.error('[start] Could not start the quiz:', err);
    const text = typeof e?.userMessage === 'string' && e.userMessage ? e.userMessage : "Couldn't start the quiz. Please try again.";
    try {
      const { toast } = await import('../../ui/components.js');
      toast(text, { kind: known ? 'info' : 'danger' });
    } catch {
      /* No UI kit: the console entry above is all we can do. */
    }
    return null;
  } finally {
    trigger?.removeAttribute('aria-busy');
  }
}
