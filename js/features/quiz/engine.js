/**
 * Quiz session engine (docs/ARCHITECTURE.md §7.3).
 *
 * Two layers:
 *
 * 1. **Pure reducers and helpers** ({@link createSessionObject},
 *    {@link applyAnswer}, {@link toggleStrike}, {@link toggleMark},
 *    {@link goTo}, {@link addTime}, {@link finishSession}, {@link summarize},
 *    {@link repairSession}, ...). No I/O, no DOM, never mutate their input.
 *    A reducer returns `s` itself when nothing changes, so callers can test
 *    `next === s` to skip a re-render or a save.
 *
 * 2. **Async API** ({@link createSession}, {@link loadSession},
 *    {@link saveSession}, {@link recordAnswer}, {@link completeSession}, ...).
 *    `core/store/repo.js` and `core/data.js` are imported lazily on first use,
 *    so importing this module never opens IndexedDB or fetches data (it runs
 *    in Node unit tests).
 *
 * Modes:
 * - `tutor` (Practice): an answer is final (locked). Every answer is written
 *   to the learner's progress at once: qstate (+ spaced repetition), one
 *   attempt, the session; then `qstate:change` is emitted.
 * - `exam`: answers can change until the exam is finished; only the session
 *   is written. {@link completeSession} grades the exam once and writes
 *   qstate / attempts for every answered question. Unanswered questions
 *   create no attempt.
 *
 * Persistence rules (no data loss):
 * - {@link saveSession} is debounced ({@link SAVE_DELAY_MS}) per session id.
 *   Answers and completion are written immediately (they supersede a pending
 *   debounced save). Pending saves are flushed on `visibilitychange` → hidden
 *   and on `pagehide` (listeners added on the first save, browser only).
 * - Writes of one session are serialized, so an older snapshot never lands
 *   after a newer one.
 * - A stored finished session is never turned back into an unfinished one by
 *   a late (stale) save, and its `graded` flag never goes back to false.
 * - A deleted session is never brought back by a late save
 *   ({@link restoreSession} is the explicit "Undo").
 * - Exam grading is idempotent: calling {@link completeSession} twice (or
 *   again after a failure) never counts an answer twice.
 * - Storage failures propagate as the repo's `StorageError` (plain-language
 *   `message`); only the automatic flush on page hide logs instead.
 *
 * @module features/quiz/engine
 */

import { bus } from '../../core/events.js';
import { clamp, hashString, pct, seededRandom, shuffle, uid } from '../../core/util.js';
import { nextSrs } from '../srs.js';

/**
 * @typedef {import('../../core/data.js').Question} Question
 * @typedef {import('../../core/store/repo.js').QState} QState
 * @typedef {'tutor' | 'exam'} Mode
 */

/**
 * @typedef {object} Answer
 * @property {string} choice        The chosen choice id.
 * @property {boolean} correct      Correctness when answered (exam: re-checked when graded).
 * @property {number} ms            Time spent on the question when it was answered (ms).
 * @property {number | null} at     When it was answered (ms epoch); null when unknown.
 */

/**
 * @typedef {object} SessionOptions
 * @property {boolean} shuffleChoices
 * @property {string[] | string} chapters   Chapter ids, or `'all'` (kept for "Retry" / titles).
 * @property {string} filter                Builder filter (kept for "Retry" / titles).
 * @property {number} secondsPerQuestion    Exam time per question (s).
 */

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} title
 * @property {Mode} mode
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number | null} finishedAt
 * @property {boolean} graded        True once the answers of the finished session are in the
 *   learner's progress (tutor: at finish, they were written live; exam: after grading).
 * @property {string[]} qids
 * @property {Record<string, string[]>} choiceOrder   Displayed order of choice ids per question.
 * @property {number} index                           Current question (0-based).
 * @property {Record<string, Answer>} answers
 * @property {Record<string, string[]>} struck        Struck-through choice ids per question.
 * @property {Record<string, true>} marked            Questions marked for review (exam).
 * @property {number | null} timeLimitMs              Exam time limit; null in tutor mode.
 * @property {number} elapsedMs                       Time spent in the session (ms).
 * @property {Record<string, number>} perQuestionMs   Time spent per question (ms).
 * @property {SessionOptions} options
 */

/**
 * @typedef {object} CreateOptions
 * @property {string} [title]                 Default "Practice" / "Exam".
 * @property {Mode} [mode]                    Default `'tutor'`.
 * @property {boolean} [shuffleChoices]       Default true.
 * @property {number} [secondsPerQuestion]    Exam time per question (s). Default 90.
 * @property {string[] | 'all'} [chapters]    Stored in `options` (default `'all'`).
 * @property {string} [filter]                Stored in `options` (default `'all'`).
 */

/**
 * @typedef {object} GroupSummary
 * @property {number} total
 * @property {number} answered
 * @property {number} correct
 * @property {number} pct        Correct over total, 0..100.
 */

/**
 * @typedef {GroupSummary & { chapterId: string | null }} ChapterSummary
 * @typedef {GroupSummary & { topic: string }} TopicSummary
 * @typedef {{ qid: string, status: 'correct' | 'incorrect' | 'unanswered', choice: string | null,
 *   ms: number, marked: boolean }} ItemSummary
 */

/**
 * @typedef {object} SessionSummary
 * @property {number} total
 * @property {number} answered
 * @property {number} correct
 * @property {number} incorrect
 * @property {number} unanswered
 * @property {number} pct                  Correct over total, 0..100 (util.pct).
 * @property {number} timeMs               Time spent (elapsedMs; sum of answer times when no time was tracked).
 * @property {number} avgMs                timeMs per answered question (0 when none).
 * @property {ChapterSummary[]} byChapter  Sorted by chapter id (unknown last).
 * @property {TopicSummary[]} byTopic      Sorted by topic name.
 * @property {ItemSummary[]} items         One per question, in session order.
 */

/**
 * @typedef {object} EngineBackend  Test seam (see {@link setTestBackend}).
 * @property {Pick<typeof import('../../core/store/repo.js'), 'sessionsRepo' | 'qstateRepo' | 'attemptsRepo' | 'emptyQState'>} repo
 * @property {Pick<typeof import('../../core/data.js'), 'getQuestions'>} data
 */

/** Quiz modes. */
export const MODES = Object.freeze(['tutor', 'exam']);

/** Exam seconds per question when none (or an invalid value) is given. */
export const DEFAULT_SECONDS_PER_QUESTION = 90;

/** Debounce of {@link saveSession}, per session id (ms). */
export const SAVE_DELAY_MS = 300;

/** Default session titles per mode. */
export const DEFAULT_TITLES = Object.freeze({ tutor: 'Practice', exam: 'Exam' });

const MAX_TITLE_LENGTH = 120;

/** Question id → chapter prefix (`CH03-0001` → `CH03`). */
const QID_PREFIX_RE = /^([A-Za-z][A-Za-z0-9]*)-\d+$/;

const MESSAGES = Object.freeze({
  empty: 'There are no questions to show for this choice. Try other chapters or another filter.',
});

/**
 * Error with a plain-language `message` safe to show to the user.
 */
export class SessionError extends Error {
  /**
   * @param {string} message User-facing message.
   * @param {{ code?: 'empty' | 'invalid', cause?: unknown }} [info]
   */
  constructor(message, { code = 'invalid', cause } = {}) {
    super(message);
    this.name = 'SessionError';
    /** @type {string} */
    this.code = code;
    /** @type {string} */
    this.userMessage = message;
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Own property of a plain-object map (never an inherited one).
 * @param {unknown} obj
 * @param {unknown} key
 * @returns {any}
 */
function own(obj, key) {
  return isObj(obj) && typeof key === 'string' && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * @param {unknown} v
 * @returns {v is number}
 */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * A duration: finite and positive → rounded ms, anything else → 0.
 * @param {unknown} v
 * @returns {number}
 */
function toMs(v) {
  return isNum(v) && v > 0 ? Math.round(v) : 0;
}

/**
 * A counter: finite and positive → whole number, anything else → 0.
 * @param {unknown} v
 * @returns {number}
 */
function toCount(v) {
  return isNum(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * A usable question id (also safe as a plain-object key).
 * @param {unknown} qid
 * @returns {qid is string}
 */
function isQid(qid) {
  return typeof qid === 'string' && qid !== '' && qid !== '__proto__';
}

/**
 * Non-empty strings of `list`, first occurrence only, in order.
 * @param {unknown} list
 * @returns {string[]}
 */
function uniqueStrings(list) {
  /** @type {string[]} */
  const out = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set();
  for (const v of list) {
    if (typeof v !== 'string' || v === '' || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Copy of `obj` without `key`.
 * @template {Record<string, any>} T
 * @param {T} obj
 * @param {string} key
 * @returns {T}
 */
function withoutKey(obj, key) {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

/**
 * Sets (or, for an empty list, removes) a per-question list.
 * @param {Record<string, string[]>} map
 * @param {string} qid
 * @param {string[]} list
 * @returns {Record<string, string[]>}
 */
function withList(map, qid, list) {
  return list.length > 0 ? { ...map, [qid]: list } : withoutKey(map, qid);
}

/**
 * @param {unknown} s
 */
function assertSession(s) {
  if (!isObj(s) || typeof s.id !== 'string' || s.id === '' || !Array.isArray(s.qids)) {
    throw new TypeError('engine: expected a quiz session object');
  }
}

/**
 * @param {unknown} mode
 * @returns {Mode}
 */
function normalizeMode(mode) {
  if (mode === undefined || mode === null) return 'tutor';
  if (mode === 'tutor' || mode === 'exam') return mode;
  throw new RangeError(`Unknown quiz mode: ${JSON.stringify(mode)}`);
}

/**
 * @param {unknown} title
 * @param {Mode} mode
 * @returns {string}
 */
function normalizeTitle(title, mode) {
  const t = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH) : '';
  return t || DEFAULT_TITLES[mode];
}

/**
 * @param {unknown} o
 * @returns {SessionOptions}
 */
function normalizeOptions(o) {
  const src = isObj(o) ? o : {};
  let chapters = 'all';
  if (Array.isArray(src.chapters)) chapters = uniqueStrings(src.chapters);
  else if (typeof src.chapters === 'string' && src.chapters !== '') chapters = src.chapters;
  return {
    shuffleChoices: src.shuffleChoices !== false,
    chapters,
    filter: typeof src.filter === 'string' && src.filter !== '' ? src.filter : 'all',
    secondsPerQuestion:
      isNum(src.secondsPerQuestion) && src.secondsPerQuestion > 0 ? src.secondsPerQuestion : DEFAULT_SECONDS_PER_QUESTION,
  };
}

/**
 * Choice ids of a question, in file order.
 * @param {unknown} question
 * @returns {string[]}
 */
function choiceIdsOf(question) {
  if (!isObj(question) || !Array.isArray(question.choices)) return [];
  return uniqueStrings(question.choices.map((c) => (isObj(c) ? c.id : undefined)));
}

/**
 * Accepts an array/iterable of questions or a Map (qid → question).
 * @param {Iterable<Question> | Map<string, Question> | null | undefined} questions
 * @returns {Map<string, Question>}
 */
function questionMap(questions) {
  /** @type {Map<string, Question>} */
  const map = new Map();
  if (!questions) return map;
  if (questions instanceof Map) {
    for (const [qid, q] of questions) if (isObj(q)) map.set(qid, q);
    return map;
  }
  if (typeof (/** @type {any} */ (questions)[Symbol.iterator]) !== 'function') return map;
  for (const q of /** @type {Iterable<Question>} */ (questions)) {
    if (isObj(q) && isQid(q.id) && !map.has(q.id)) map.set(q.id, q);
  }
  return map;
}

/**
 * Chapter id from a question id prefix (`CH03-0001` → `ch03`, `DEMO-0001` → `demo`).
 * Used only when the question itself is not available.
 * @param {string} qid
 * @returns {string | null}
 */
function chapterIdOfQid(qid) {
  const m = QID_PREFIX_RE.exec(qid);
  return m ? m[1].toLowerCase() : null;
}

/**
 * @param {Session} s
 * @param {unknown} qid
 * @returns {boolean}
 */
function hasQid(s, qid) {
  return isQid(qid) && s.qids.includes(qid);
}

/**
 * @param {Session} s
 * @param {string} qid
 * @param {unknown} choice
 * @returns {choice is string}
 */
function isValidChoice(s, qid, choice) {
  if (typeof choice !== 'string' || choice === '') return false;
  const order = own(s.choiceOrder, qid);
  return !Array.isArray(order) || order.length === 0 || order.includes(choice);
}

/**
 * Time spent on a question: tracked time, else the time recorded with its answer.
 * @param {Session} s
 * @param {string} qid
 * @returns {number}
 */
function timeOn(s, qid) {
  const tracked = toMs(own(s.perQuestionMs, qid));
  if (tracked > 0) return tracked;
  return toMs(answerOf(s, qid)?.ms);
}

// ---------------------------------------------------------------------------
// Pure helpers (exported)
// ---------------------------------------------------------------------------

/**
 * The stored answer of a question, or null when unanswered.
 * @param {Session} s
 * @param {string} qid
 * @returns {Answer | null}
 */
export function answerOf(s, qid) {
  const a = own(s?.answers, qid);
  return isObj(a) && typeof a.choice === 'string' && a.choice !== '' ? /** @type {Answer} */ (a) : null;
}

/**
 * True once the session is finished.
 * @param {Session} s
 * @returns {boolean}
 */
export function isFinished(s) {
  return isObj(s) && s.finishedAt !== null && s.finishedAt !== undefined;
}

/**
 * True when the answer of `qid` can no longer change:
 * tutor → once answered; exam → only after the exam is finished.
 * Also true for a finished session and for a question that is not in the session.
 * @param {Session} s
 * @param {string} qid
 * @returns {boolean}
 */
export function isAnswerLocked(s, qid) {
  assertSession(s);
  if (isFinished(s) || !hasQid(s, qid)) return true;
  return s.mode === 'exam' ? false : answerOf(s, qid) !== null;
}

/**
 * Exam time left (ms), never negative; null when the session has no time limit.
 * @param {Session} s
 * @returns {number | null}
 */
export function remainingMs(s) {
  assertSession(s);
  if (!isNum(s.timeLimitMs)) return null;
  return Math.max(0, Math.round(s.timeLimitMs) - toMs(s.elapsedMs));
}

/**
 * True when a timed session has no time left.
 * @param {Session} s
 * @returns {boolean}
 */
export function isTimeUp(s) {
  const left = remainingMs(s);
  return left !== null && left <= 0;
}

/**
 * Number of answered questions.
 * @param {Session} s
 * @returns {number}
 */
export function answeredCount(s) {
  assertSession(s);
  let n = 0;
  for (const qid of s.qids) if (answerOf(s, qid)) n++;
  return n;
}

/**
 * Number of questions without an answer.
 * @param {Session} s
 * @returns {number}
 */
export function unansweredCount(s) {
  const answered = answeredCount(s);
  return s.qids.length - answered;
}

/**
 * Index of the first unanswered question, searching from `from` (default 0)
 * and wrapping around to the start.
 * @param {Session} s
 * @param {number} [from] Start index (e.g. `s.index + 1` for "next unanswered").
 * @returns {number} -1 when every question is answered (or the session is empty).
 */
export function firstUnansweredIndex(s, from = 0) {
  assertSession(s);
  const n = s.qids.length;
  if (n === 0) return -1;
  const start = isNum(from) ? ((Math.trunc(from) % n) + n) % n : 0;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    if (!answerOf(s, s.qids[i])) return i;
  }
  return -1;
}

/**
 * Id of the current question (null for an empty session).
 * @param {Session} s
 * @returns {string | null}
 */
export function currentQid(s) {
  assertSession(s);
  if (s.qids.length === 0) return null;
  const i = clamp(isNum(s.index) ? Math.trunc(s.index) : 0, 0, s.qids.length - 1);
  return s.qids[i];
}

/**
 * True when `choice` is the question's correct answer.
 * @param {Question} question
 * @param {unknown} choice
 * @returns {boolean}
 */
export function isCorrectChoice(question, choice) {
  return isObj(question) && typeof choice === 'string' && choice !== '' && choice === question.answer;
}

/**
 * The choice ids of `question` in the order this session shows them.
 * Robust to question edits: ids no longer in the question are dropped and
 * new ones are appended, so every current choice appears exactly once.
 * @param {Session} s
 * @param {Question} question
 * @returns {string[]}
 */
export function choiceOrderFor(s, question) {
  const ids = choiceIdsOf(question);
  const stored = isObj(question) ? own(s?.choiceOrder, question.id) : undefined;
  if (!Array.isArray(stored)) return ids;
  const valid = new Set(ids);
  const out = uniqueStrings(stored).filter((id) => valid.has(id));
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * The learner's per-question state after one graded answer. Pure.
 * Missing or corrupted counters count as 0; the schedule comes from
 * `srs.nextSrs`. Fields this function does not own (e.g. `bookmarked`) are kept.
 * @param {QState | null | undefined} prev
 * @param {{ qid: string, choice: string | null, correct: boolean, ms: number, ts: number }} result
 * @returns {QState}
 */
export function nextQState(prev, { qid, choice, correct, ms, ts }) {
  const p = isObj(prev) ? prev : {};
  const ok = correct === true;
  const time = toMs(ms);
  const at = isNum(ts) ? ts : Date.now();
  return {
    ...p,
    qid,
    seen: toCount(p.seen) + 1,
    correct: toCount(p.correct) + (ok ? 1 : 0),
    incorrect: toCount(p.incorrect) + (ok ? 0 : 1),
    totalMs: toMs(p.totalMs) + time,
    lastChoice: typeof choice === 'string' ? choice : null,
    lastCorrect: ok,
    lastTs: at,
    bookmarked: p.bookmarked === true,
    srs: nextSrs(isObj(p.srs) ? /** @type {any} */ (p.srs) : null, { correct: ok, ms: time }, at),
  };
}

/**
 * Decides what to store when a session snapshot is saved over the stored
 * record. Pure.
 * - A stored finished session is never replaced by an unfinished snapshot (→ null: skip).
 * - Once stored as finished, `finishedAt` keeps its first value and `graded` never goes back to false.
 * - `updatedAt` becomes the save time (or the snapshot's, when later).
 * @param {Session | null | undefined} stored
 * @param {Session} incoming
 * @param {number} [now]
 * @returns {Session | null} The record to store, or null to keep the stored one.
 */
export function mergeForWrite(stored, incoming, now = Date.now()) {
  const updatedAt = Math.max(isNum(incoming.updatedAt) ? incoming.updatedAt : 0, isNum(now) ? now : Date.now());
  if (!isObj(stored) || !isFinished(/** @type {Session} */ (stored))) return { ...incoming, updatedAt };
  if (!isFinished(incoming)) return null;
  return {
    ...incoming,
    finishedAt: stored.finishedAt,
    graded: stored.graded === true || incoming.graded === true,
    updatedAt,
  };
}

/**
 * Validates a stored session and repairs what can be repaired (old or
 * damaged records, backups). Pure. Unknown fields are dropped; answers,
 * strikes, marks and times of questions not in the session are dropped;
 * missing fields get safe defaults; `index` is clamped. A finished record
 * without a `graded` flag is treated as graded (never grade twice).
 * @param {unknown} raw
 * @returns {Session | null} A clean session, or null when `raw` has no usable `id` / `qids`.
 */
export function repairSession(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || raw.id === '' || !Array.isArray(raw.qids)) return null;
  const qids = uniqueStrings(raw.qids).filter(isQid);
  const mode = raw.mode === 'exam' ? 'exam' : 'tutor';
  const options = normalizeOptions(raw.options);

  /** @type {Record<string, string[]>} */
  const choiceOrder = {};
  /** @type {Record<string, Answer>} */
  const answers = {};
  /** @type {Record<string, string[]>} */
  const struck = {};
  /** @type {Record<string, true>} */
  const marked = {};
  /** @type {Record<string, number>} */
  const perQuestionMs = {};

  for (const qid of qids) {
    const order = own(raw.choiceOrder, qid);
    if (Array.isArray(order)) choiceOrder[qid] = uniqueStrings(order);
    const valid = choiceOrder[qid] && choiceOrder[qid].length > 0 ? new Set(choiceOrder[qid]) : null;

    const a = own(raw.answers, qid);
    if (isObj(a) && typeof a.choice === 'string' && a.choice !== '' && (!valid || valid.has(a.choice))) {
      answers[qid] = { choice: a.choice, correct: a.correct === true, ms: toMs(a.ms), at: isNum(a.at) ? a.at : null };
    }
    const st = uniqueStrings(own(raw.struck, qid)).filter((c) => !valid || valid.has(c));
    if (st.length > 0) struck[qid] = st;
    if (own(raw.marked, qid) === true) marked[qid] = true;
    const t = toMs(own(raw.perQuestionMs, qid));
    if (t > 0) perQuestionMs[qid] = t;
  }

  const createdAt = isNum(raw.createdAt) ? raw.createdAt : isNum(raw.updatedAt) ? raw.updatedAt : 0;
  const finishedAt = isNum(raw.finishedAt) ? raw.finishedAt : null;
  let timeLimitMs = null;
  if (mode === 'exam') {
    timeLimitMs =
      isNum(raw.timeLimitMs) && raw.timeLimitMs >= 0
        ? Math.round(raw.timeLimitMs)
        : Math.round(options.secondsPerQuestion * 1000 * qids.length);
  }
  return {
    id: raw.id,
    title: normalizeTitle(raw.title, mode),
    mode,
    createdAt,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : createdAt,
    finishedAt,
    graded: typeof raw.graded === 'boolean' ? raw.graded : finishedAt !== null,
    qids,
    choiceOrder,
    index: qids.length === 0 ? 0 : clamp(isNum(raw.index) ? Math.trunc(raw.index) : 0, 0, qids.length - 1),
    answers,
    struck,
    marked,
    timeLimitMs,
    elapsedMs: toMs(raw.elapsedMs),
    perQuestionMs,
    options,
  };
}

// ---------------------------------------------------------------------------
// Pure reducers
// ---------------------------------------------------------------------------

/**
 * Creates a new session object (not stored). Pure apart from the new id.
 *
 * - `qids` = the questions' ids in the given order (malformed entries and
 *   duplicates skipped).
 * - `choiceOrder[qid]` = the question's choice ids, shuffled with
 *   `seededRandom(hashString(seed + '|' + qid))` when `shuffleChoices`
 *   (same seed → same order), else in file order. Without a seed the new
 *   session id is used (a fresh random order per session).
 * - `timeLimitMs` = exam: `secondsPerQuestion × 1000 × questions`; tutor: null.
 *
 * @param {CreateOptions} [opts]
 * @param {Question[]} [questions]
 * @param {number} [now] Creation time. Defaults to `Date.now()`.
 * @param {number | string} [seed] Seed for the choice shuffle.
 * @returns {Session}
 * @throws {RangeError} For an unknown mode.
 */
export function createSessionObject(opts = {}, questions = [], now = Date.now(), seed) {
  const o = isObj(opts) ? opts : {};
  const mode = normalizeMode(o.mode);
  const options = normalizeOptions(o);
  const id = uid();
  const seedKey = String(seed ?? id);
  const t = isNum(now) ? now : Date.now();

  /** @type {string[]} */
  const qids = [];
  /** @type {Record<string, string[]>} */
  const choiceOrder = {};
  for (const q of Array.isArray(questions) ? questions : []) {
    const qid = isObj(q) && isQid(q.id) ? q.id : null;
    if (!qid || Object.hasOwn(choiceOrder, qid)) continue;
    const ids = choiceIdsOf(q);
    qids.push(qid);
    choiceOrder[qid] = options.shuffleChoices ? shuffle(ids, seededRandom(hashString(`${seedKey}|${qid}`))) : ids;
  }

  return {
    id,
    title: normalizeTitle(o.title, mode),
    mode,
    createdAt: t,
    updatedAt: t,
    finishedAt: null,
    graded: false,
    qids,
    choiceOrder,
    index: 0,
    answers: {},
    struck: {},
    marked: {},
    timeLimitMs: mode === 'exam' ? Math.round(options.secondsPerQuestion * 1000 * qids.length) : null,
    elapsedMs: 0,
    perQuestionMs: {},
    options,
  };
}

/**
 * Records an answer. Ignored (returns `s`) when the answer is locked
 * ({@link isAnswerLocked}: tutor already answered, finished session, unknown
 * question), when `choice` is not one of the question's choices, or when an
 * exam answer is re-tapped unchanged. Exam answers are overwritten while the
 * exam runs. Choosing a struck-through choice removes its strike.
 *
 * @param {Session} s
 * @param {string} qid
 * @param {string} choice Choice id.
 * @param {boolean} correct
 * @param {number} ms Time spent on the question (ms; invalid → 0).
 * @param {number} [now] Defaults to `Date.now()`.
 * @returns {Session}
 */
export function applyAnswer(s, qid, choice, correct, ms, now = Date.now()) {
  assertSession(s);
  if (isAnswerLocked(s, qid) || !isValidChoice(s, qid, choice)) return s;
  const prev = answerOf(s, qid);
  if (prev && prev.choice === choice) return s;
  const at = isNum(now) ? now : Date.now();
  /** @type {Answer} */
  const answer = { choice, correct: correct === true, ms: toMs(ms), at };
  /** @type {Session} */
  const next = { ...s, answers: { ...s.answers, [qid]: answer }, updatedAt: at };
  const struck = own(s.struck, qid);
  if (Array.isArray(struck) && struck.includes(choice)) {
    next.struck = withList(s.struck, qid, struck.filter((c) => c !== choice));
  }
  return next;
}

/**
 * Toggles the strike-through of one choice. Ignored when the answer is
 * locked or `choice` is not one of the question's choices.
 * @param {Session} s
 * @param {string} qid
 * @param {string} choice
 * @returns {Session}
 */
export function toggleStrike(s, qid, choice) {
  assertSession(s);
  if (isAnswerLocked(s, qid) || !isValidChoice(s, qid, choice)) return s;
  const current = own(s.struck, qid);
  const list = Array.isArray(current) ? current : [];
  const next = list.includes(choice) ? list.filter((c) => c !== choice) : [...list, choice];
  return { ...s, struck: withList(s.struck || {}, qid, next) };
}

/**
 * Toggles the "marked for review" flag of a question. Ignored after finish
 * and for questions not in the session.
 * @param {Session} s
 * @param {string} qid
 * @returns {Session}
 */
export function toggleMark(s, qid) {
  assertSession(s);
  if (isFinished(s) || !hasQid(s, qid)) return s;
  const marked = own(s.marked, qid) === true ? withoutKey(s.marked, qid) : { ...s.marked, [qid]: true };
  return { ...s, marked };
}

/**
 * Moves to a question. The index is truncated and clamped to the session;
 * a non-number or NaN is ignored. Allowed after finish (review).
 * @param {Session} s
 * @param {number} index
 * @returns {Session}
 */
export function goTo(s, index) {
  assertSession(s);
  if (typeof index !== 'number' || Number.isNaN(index)) return s;
  const i = clamp(Math.trunc(index), 0, Math.max(0, s.qids.length - 1));
  return i === s.index ? s : { ...s, index: i };
}

/**
 * Adds time spent on a question to `perQuestionMs[qid]` and `elapsedMs`.
 * Ignores zero, negative, NaN and infinite amounts, unknown questions and
 * finished sessions. Callers add only time the question was visible.
 * @param {Session} s
 * @param {string} qid
 * @param {number} ms
 * @returns {Session}
 */
export function addTime(s, qid, ms) {
  assertSession(s);
  const add = toMs(ms);
  if (add === 0 || isFinished(s) || !hasQid(s, qid)) return s;
  return {
    ...s,
    elapsedMs: toMs(s.elapsedMs) + add,
    perQuestionMs: { ...s.perQuestionMs, [qid]: toMs(own(s.perQuestionMs, qid)) + add },
  };
}

/**
 * Marks the session finished (idempotent: a finished session is returned as is).
 * @param {Session} s
 * @param {number} [now] Defaults to `Date.now()`.
 * @returns {Session}
 */
export function finishSession(s, now = Date.now()) {
  assertSession(s);
  if (isFinished(s)) return s;
  const t = isNum(now) ? now : Date.now();
  return { ...s, finishedAt: t, updatedAt: t };
}

/**
 * @param {Map<string | null, any>} groups
 * @param {string | null} key
 * @param {Record<string, any>} base
 * @param {boolean} answered
 * @param {boolean} correct
 */
function bump(groups, key, base, answered, correct) {
  const g = groups.get(key) ?? { ...base, total: 0, answered: 0, correct: 0 };
  g.total += 1;
  if (answered) g.answered += 1;
  if (correct) g.correct += 1;
  groups.set(key, g);
}

/**
 * @template {GroupSummary} T
 * @param {T} g
 * @returns {T}
 */
function withPct(g) {
  return { ...g, pct: pct(g.correct, g.total) };
}

/**
 * Score and breakdowns of a session. Pure.
 *
 * Correctness: tutor → as recorded when answered; exam → the chosen choice
 * against `question.answer` now (so it works before {@link completeSession}),
 * or the recorded value when the question is not in `questions`.
 * Chapter of a question: `question.chapterId`, else its id prefix
 * (`CH03-0001` → `ch03`), else null.
 *
 * @param {Session} s
 * @param {Question[] | Map<string, Question>} [questions] The session's questions.
 * @returns {SessionSummary}
 */
export function summarize(s, questions) {
  assertSession(s);
  const byId = questionMap(questions);
  /** @type {Map<string | null, ChapterSummary>} */
  const chapters = new Map();
  /** @type {Map<string, TopicSummary>} */
  const topics = new Map();
  /** @type {ItemSummary[]} */
  const items = [];
  let answered = 0;
  let correct = 0;
  let answerMs = 0;

  for (const qid of s.qids) {
    const q = byId.get(qid) ?? null;
    const a = answerOf(s, qid);
    let ok = false;
    if (a) {
      answered += 1;
      ok = s.mode === 'exam' && q ? isCorrectChoice(q, a.choice) : a.correct === true;
      if (ok) correct += 1;
      answerMs += toMs(a.ms);
    }
    const chapterId = q && typeof q.chapterId === 'string' && q.chapterId !== '' ? q.chapterId : chapterIdOfQid(qid);
    bump(chapters, chapterId, { chapterId }, Boolean(a), ok);
    const topic = q && typeof q.topic === 'string' ? q.topic.trim() : '';
    if (topic) bump(topics, topic, { topic }, Boolean(a), ok);
    items.push({
      qid,
      status: a ? (ok ? 'correct' : 'incorrect') : 'unanswered',
      choice: a ? a.choice : null,
      ms: timeOn(s, qid),
      marked: own(s.marked, qid) === true,
    });
  }

  const total = s.qids.length;
  const elapsed = toMs(s.elapsedMs);
  const timeMs = elapsed > 0 ? elapsed : answerMs;
  return {
    total,
    answered,
    correct,
    incorrect: answered - correct,
    unanswered: total - answered,
    pct: pct(correct, total),
    timeMs,
    avgMs: answered > 0 ? Math.round(timeMs / answered) : 0,
    byChapter: [...chapters.values()].map(withPct).sort((a, b) => {
      if (a.chapterId === b.chapterId) return 0;
      if (a.chapterId === null) return 1;
      if (b.chapterId === null) return -1;
      return a.chapterId < b.chapterId ? -1 : 1;
    }),
    byTopic: [...topics.values()].map(withPct).sort((a, b) => a.topic.localeCompare(b.topic, 'en', { sensitivity: 'base' })),
    items,
  };
}

// ---------------------------------------------------------------------------
// Lazy I/O modules (keep this module import-safe in Node)
// ---------------------------------------------------------------------------

/** @type {Promise<typeof import('../../core/data.js')> | null} */
let dataModule = null;
/** @type {Promise<typeof import('../../core/store/repo.js')> | null} */
let repoModule = null;
/** @type {EngineBackend | null} */
let testBackend = null;

/** @returns {Promise<EngineBackend['data']>} */
function dataApi() {
  if (testBackend) return Promise.resolve(testBackend.data);
  if (!dataModule) {
    dataModule = import('../../core/data.js');
    dataModule.catch(() => {
      dataModule = null;
    });
  }
  return dataModule;
}

/** @returns {Promise<EngineBackend['repo']>} */
function repoApi() {
  if (testBackend) return Promise.resolve(testBackend.repo);
  if (!repoModule) {
    repoModule = import('../../core/store/repo.js');
    repoModule.catch(() => {
      repoModule = null;
    });
  }
  return repoModule;
}

// ---------------------------------------------------------------------------
// Write queue: debounced saves, serialized writes, lifecycle flush
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PendingSave
 * @property {Session} session                 Latest snapshot to write.
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {Promise<Session | null>} promise Shared by every caller in the debounce window.
 * @property {(value: Session | null) => void} resolve
 * @property {(err: unknown) => void} reject
 */

/** @type {Map<string, PendingSave>} */
const pending = new Map();
/** Tail of the write chain per session id (never rejects). @type {Map<string, Promise<void>>} */
const chains = new Map();
/** Running completeSession() per session id. @type {Map<string, Promise<Session>>} */
const completing = new Map();
/** Ids deleted in this page's lifetime: late saves must not bring them back. @type {Set<string>} */
const deletedIds = new Set();
let lifecycleBound = false;

/**
 * @param {string} message
 * @param {unknown} err
 */
function logError(message, err) {
  // eslint-disable-next-line no-console
  console.error(`[engine] ${message}`, err);
}

/**
 * Runs `task` after every earlier write of the same session.
 * @template T
 * @param {string} id
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function serial(id, task) {
  const prev = chains.get(id) || Promise.resolve();
  const run = prev.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(id, tail);
  tail.then(() => {
    if (chains.get(id) === tail) chains.delete(id);
  });
  return run;
}

/**
 * Writes a snapshot now (in order with other writes of the same session),
 * applying {@link mergeForWrite} against the stored record.
 * @param {Session} s
 * @returns {Promise<Session | null>} The stored record (the kept one when the
 *   snapshot was stale), or null when the session was deleted.
 */
function persist(s) {
  return serial(s.id, async () => {
    if (deletedIds.has(s.id)) return null;
    const repo = await repoApi();
    const stored = await repo.sessionsRepo.get(s.id);
    const rec = mergeForWrite(stored, s, Date.now());
    if (!rec) return /** @type {Session} */ (stored);
    return /** @type {Promise<Session>} */ (repo.sessionsRepo.put(rec));
  });
}

/**
 * Writes the pending debounced save of `id` now.
 * @param {string} id
 * @returns {Promise<Session | null>}
 */
function flushOne(id) {
  const entry = pending.get(id);
  if (!entry) return Promise.resolve(null);
  if (entry.timer !== null) clearTimeout(entry.timer);
  pending.delete(id);
  const run = persist(entry.session);
  run.then(entry.resolve, entry.reject);
  return run;
}

/**
 * Writes `s` immediately; a pending debounced save of the same session is
 * superseded (its callers get this write's outcome).
 * @param {Session} s
 * @returns {Promise<Session | null>}
 */
function persistNow(s) {
  const entry = pending.get(s.id);
  if (entry) {
    if (entry.timer !== null) clearTimeout(entry.timer);
    pending.delete(s.id);
  }
  const run = persist(s);
  if (entry) run.then(entry.resolve, entry.reject);
  return run;
}

/**
 * Waits until every queued write of `id` (including a pending debounced one) is stored.
 * @param {string} id
 * @returns {Promise<void>}
 */
async function settle(id) {
  await flushOne(id);
  await chains.get(id);
}

/** Flushes pending saves when the page is hidden or unloaded (browser only, once). */
function bindLifecycle() {
  if (lifecycleBound) return;
  const doc = globalThis.document;
  if (!doc || typeof doc.addEventListener !== 'function') return;
  lifecycleBound = true;
  const flushQuietly = () => {
    flushSessions().catch((err) => logError('Could not save the quiz while the app was closing.', err));
  };
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'hidden') flushQuietly();
  });
  if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('pagehide', flushQuietly);
}

// ---------------------------------------------------------------------------
// Async API
// ---------------------------------------------------------------------------

/**
 * Creates and stores a new session.
 *
 * @param {CreateOptions & { qids: string[], seed?: number | string }} opts
 *   `qids` in quiz order (from `builder.buildQuestionSet`); missing,
 *   unpublished and duplicate ids are dropped.
 * @returns {Promise<Session>}
 * @throws {SessionError} `'empty'` (plain-language message) when no question is left.
 * @throws {RangeError} For an unknown mode.
 * @throws {Error} `DataError` / `StorageError` (plain-language message) when loading or saving fails.
 */
export async function createSession(opts) {
  const o = isObj(opts) ? opts : {};
  normalizeMode(o.mode);
  const qids = uniqueStrings(o.qids).filter(isQid);
  if (qids.length === 0) throw new SessionError(MESSAGES.empty, { code: 'empty' });
  const data = await dataApi();
  const questions = await data.getQuestions(qids);
  const session = createSessionObject(o, questions, Date.now(), o.seed);
  if (session.qids.length === 0) throw new SessionError(MESSAGES.empty, { code: 'empty' });
  await persistNow(session);
  return session;
}

/**
 * Loads a session (after any pending save of it is written), validated and
 * repaired with {@link repairSession}.
 * @param {string} id
 * @returns {Promise<Session | null>} Null when missing, deleted or unusable.
 * @throws {Error} `StorageError` when reading (or the pending save) fails.
 */
export async function loadSession(id) {
  if (typeof id !== 'string' || id === '' || deletedIds.has(id)) return null;
  await settle(id);
  const repo = await repoApi();
  return repairSession(await repo.sessionsRepo.get(id));
}

/**
 * Saves a session snapshot, debounced {@link SAVE_DELAY_MS} per session id
 * (the latest snapshot wins). Use it for navigation, strikes, marks and time.
 * @param {Session} s
 * @returns {Promise<Session | null>} Resolves when the snapshot (or a newer
 *   one) is stored; null when the session was deleted meanwhile. Rejects with
 *   `StorageError` when the write fails (failures are also logged).
 */
export function saveSession(s) {
  try {
    assertSession(s);
  } catch (err) {
    return Promise.reject(err);
  }
  bindLifecycle();
  let entry = pending.get(s.id);
  if (entry) {
    entry.session = s;
    if (entry.timer !== null) clearTimeout(entry.timer);
  } else {
    /** @type {(value: Session | null) => void} */
    let resolve = () => {};
    /** @type {(err: unknown) => void} */
    let reject = () => {};
    /** @type {Promise<Session | null>} */
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch((err) => logError('Could not save the quiz session.', err));
    entry = { session: s, timer: null, promise, resolve, reject };
    pending.set(s.id, entry);
  }
  const id = s.id;
  entry.timer = setTimeout(() => {
    flushOne(id);
  }, SAVE_DELAY_MS);
  return entry.promise;
}

/**
 * Writes every pending save now and waits for writes in flight. Runs
 * automatically when the page is hidden or unloaded.
 * @returns {Promise<void>}
 * @throws {Error} `StorageError` when a write fails.
 */
export async function flushSessions() {
  const runs = [...pending.keys()].map(flushOne);
  await Promise.all([...runs, ...chains.values()]);
}

/**
 * Records the learner's answer to the current question.
 *
 * - tutor: the answer is locked; qstate (seen, correct/incorrect, totalMs,
 *   lastChoice, lastCorrect, lastTs, srs) and one attempt are written, the
 *   session is stored, then `qstate:change` `{qid}` is emitted.
 * - exam: only the session is stored (the answer can still change).
 *
 * The session is written immediately (not debounced), so an answer is never lost.
 *
 * @param {Session} s
 * @param {Question} question
 * @param {string} choice Choice id.
 * @param {number} ms Time spent on the question (ms).
 * @returns {Promise<{ session: Session, correct: boolean, applied: boolean }>}
 *   `applied` is false when the answer was ignored (locked, unknown question
 *   or choice, unchanged exam answer); `session` is then `s` and `correct`
 *   describes the stored answer when there is one.
 * @throws {Error} `StorageError` when a write fails.
 */
export async function recordAnswer(s, question, choice, ms) {
  assertSession(s);
  if (!isObj(question) || !isQid(question.id)) throw new TypeError('recordAnswer: expected a question');
  const qid = question.id;
  const correct = isCorrectChoice(question, choice);
  const next = applyAnswer(s, qid, choice, correct, ms, Date.now());
  if (next === s) {
    const existing = answerOf(s, qid);
    return { session: s, correct: existing ? existing.correct === true : correct, applied: false };
  }
  if (next.mode === 'tutor') {
    const repo = await repoApi();
    const a = /** @type {Answer} */ (answerOf(next, qid));
    const result = { qid, choice: a.choice, correct: a.correct, ms: a.ms, ts: /** @type {number} */ (a.at) };
    await Promise.all([
      repo.qstateRepo.update(qid, (prev) => nextQState(prev ?? repo.emptyQState(qid), result)),
      repo.attemptsRepo.add({ ...result, mode: 'tutor', sessionId: next.id }),
      persistNow(next),
    ]);
    bus.emit('qstate:change', { qid });
  } else {
    await persistNow(next);
  }
  return { session: next, correct, applied: true };
}

/**
 * Writes one graded exam answer to the learner's progress, unless this
 * session already did (an attempt with its `sessionId` exists).
 * @param {EngineBackend['repo']} repo
 * @param {string} sessionId
 * @param {{ qid: string, choice: string, correct: boolean, ms: number, ts: number }} result
 * @returns {Promise<boolean>} True when written.
 */
async function gradeOne(repo, sessionId, result) {
  const prior = await repo.attemptsRepo.byQid(result.qid);
  if (Array.isArray(prior) && prior.some((a) => isObj(a) && a.sessionId === sessionId)) return false;
  await repo.attemptsRepo.add({ ...result, mode: 'exam', sessionId });
  await repo.qstateRepo.update(result.qid, (prev) => nextQState(prev ?? repo.emptyQState(result.qid), result));
  return true;
}

/**
 * @param {unknown} rec
 * @param {Session} fallback
 * @returns {Session}
 */
function sessionOr(rec, fallback) {
  return isObj(rec) ? /** @type {Session} */ (rec) : fallback;
}

/**
 * @param {Session} s
 * @param {Question[] | Map<string, Question> | undefined} questions
 * @returns {Promise<Session>}
 */
async function doComplete(s, questions) {
  const id = s.id;
  if (deletedIds.has(id)) return finishSession(s, Date.now());
  await settle(id);
  const repo = await repoApi();
  // Once stored as finished, the stored record is authoritative (a stale
  // in-memory copy must not replace its answers).
  const stored = repairSession(await repo.sessionsRepo.get(id));
  const base = stored && isFinished(stored) ? stored : s;
  if (isFinished(base) && base.graded === true) return base;
  const finished = finishSession(base, Date.now());

  if (finished.mode !== 'exam') {
    const done = { ...finished, graded: true };
    return sessionOr(await persistNow(done), done);
  }

  // Store "finished" first: the exam leaves "Continue" at once and survives
  // an interruption; grading below is idempotent, so a retry is safe.
  const first = await persistNow(finished);
  if (isObj(first) && first.graded === true) return /** @type {Session} */ (first);

  const byId = questionMap(questions);
  /** @type {Record<string, Answer>} */
  const answers = { ...finished.answers };
  /** @type {string[]} */
  const changedQids = [];
  /** @type {Promise<void>[]} */
  const jobs = [];
  for (const qid of finished.qids) {
    const a = answerOf(finished, qid);
    if (!a) continue;
    const q = byId.get(qid);
    const correct = q ? isCorrectChoice(q, a.choice) : a.correct === true;
    answers[qid] = { ...a, correct };
    const result = {
      qid,
      choice: a.choice,
      correct,
      ms: timeOn(finished, qid),
      ts: isNum(a.at) ? a.at : /** @type {number} */ (finished.finishedAt),
    };
    jobs.push(
      gradeOne(repo, id, result).then((wrote) => {
        if (wrote) changedQids.push(qid);
      }),
    );
  }
  const outcomes = await Promise.allSettled(jobs);
  for (const qid of changedQids) bus.emit('qstate:change', { qid });
  const failure = outcomes.find((r) => r.status === 'rejected');
  if (failure) throw /** @type {PromiseRejectedResult} */ (failure).reason;

  const done = { ...finished, answers, graded: true };
  return sessionOr(await persistNow(done), done);
}

/**
 * Finishes a session and stores it immediately.
 *
 * Exam: grades every answered question (against `questions` when given,
 * else the correctness recorded with the answer) and writes qstate, srs and
 * one attempt per answered question; unanswered questions create no attempt.
 * Emits `qstate:change` per graded question. Safe to call twice or to retry
 * after a failure: nothing is ever counted twice. Tutor: only marks it
 * finished (its answers were written live).
 *
 * @param {Session} s
 * @param {Question[] | Map<string, Question>} [questions] The session's questions.
 * @returns {Promise<Session>} The finished (and graded) session.
 * @throws {Error} `StorageError` when a write fails (call again to retry).
 */
export async function completeSession(s, questions) {
  assertSession(s);
  const running = completing.get(s.id);
  if (running) return running;
  const task = doComplete(s, questions);
  completing.set(s.id, task);
  try {
    return await task;
  } finally {
    if (completing.get(s.id) === task) completing.delete(s.id);
  }
}

/**
 * Deletes a session. A pending save of it is dropped and later saves of it
 * are ignored (use {@link restoreSession} for "Undo").
 * @param {string} id
 * @returns {Promise<void>}
 * @throws {Error} `StorageError` when the delete fails.
 */
export async function deleteSession(id) {
  if (typeof id !== 'string' || id === '') throw new TypeError('deleteSession: expected a session id');
  deletedIds.add(id);
  const entry = pending.get(id);
  if (entry) {
    if (entry.timer !== null) clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(null);
  }
  try {
    await serial(id, async () => {
      const repo = await repoApi();
      await repo.sessionsRepo.remove(id);
    });
  } catch (err) {
    deletedIds.delete(id);
    throw err;
  }
}

/**
 * Stores a deleted session again ("Undo" after {@link deleteSession}).
 * @param {Session} s
 * @returns {Promise<Session>}
 * @throws {Error} `StorageError` when the write fails.
 */
export async function restoreSession(s) {
  assertSession(s);
  deletedIds.delete(s.id);
  return sessionOr(await persistNow(s), s);
}

/**
 * The most recently updated unfinished session (for "Continue"), after
 * pending saves are written.
 * @returns {Promise<Session | null>}
 * @throws {Error} `StorageError` when reading or a pending save fails.
 */
export async function latestUnfinished() {
  await flushSessions();
  const repo = await repoApi();
  const raw = await repo.sessionsRepo.latestUnfinished();
  if (!isObj(raw) || deletedIds.has(raw.id)) return null;
  return repairSession(raw);
}

/**
 * Toggles the bookmark of a question and emits `qstate:change` `{qid}`.
 * @param {string} qid
 * @returns {Promise<boolean>} The new bookmarked state.
 * @throws {Error} `StorageError` when the write fails.
 */
export async function toggleBookmark(qid) {
  if (!isQid(qid)) throw new TypeError('toggleBookmark: expected a question id');
  const repo = await repoApi();
  const stored = await repo.qstateRepo.update(qid, (prev) => {
    const base = prev ?? repo.emptyQState(qid);
    return { ...base, bookmarked: base.bookmarked !== true };
  });
  bus.emit('qstate:change', { qid });
  return isObj(stored) && stored.bookmarked === true;
}

/**
 * Test seam: replaces the lazily imported repo/data modules with fakes and
 * resets the write queue (pending saves are dropped). Pass null to restore
 * the real modules. Never used by the app.
 * @param {EngineBackend | null} backend
 * @returns {void}
 */
export function setTestBackend(backend) {
  for (const entry of pending.values()) if (entry.timer !== null) clearTimeout(entry.timer);
  pending.clear();
  chains.clear();
  completing.clear();
  deletedIds.clear();
  testBackend = isObj(backend) ? /** @type {EngineBackend} */ (backend) : null;
}
