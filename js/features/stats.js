/**
 * Aggregated statistics over the learner's progress (docs/ARCHITECTURE.md §7.4).
 *
 * Two layers:
 *
 * 1. {@link aggregateStats} is pure: it gets the study bank and the stored
 *    records and does all the math, so it runs in Node unit tests.
 * 2. {@link computeStats} is a thin I/O wrapper: it loads the study bank
 *    (`core/data.js`) and the learner's records (`core/store/repo.js`), both
 *    imported lazily on first use, and calls {@link aggregateStats}.
 *
 * Only records whose `qid` belongs to the study bank count (the published
 * chapters, or the demo in demo mode), so progress on hidden chapters and on
 * the demo outside demo mode never shows up. Days are local calendar days
 * (`util.dayKey`), so "today" follows the device's clock and time zone.
 *
 * @module features/stats
 */

import { addDays, dayKey, HOUR_MS, pct, startOfDay } from '../core/util.js';
import { isDue } from './srs.js';

/**
 * @typedef {import('../core/data.js').Question} Question
 * @typedef {import('../core/data.js').AnyChapter} AnyChapter
 * @typedef {import('../core/store/repo.js').QState} QState
 * @typedef {import('../core/store/repo.js').Attempt} Attempt
 */

/**
 * @typedef {object} ChapterStats
 * @property {string} id
 * @property {string} title
 * @property {string} short       Short label for tight spaces (falls back to the title).
 * @property {number} total       Questions in the chapter.
 * @property {number} answered    Questions answered at least once.
 * @property {number} correct     Questions whose last answer was right.
 * @property {number} pct         correct / answered, 0..100 (util.pct).
 */

/**
 * @typedef {object} TopicStats
 * @property {string} topic
 * @property {string | null} chapterId
 * @property {number} n           Attempts on the topic's questions.
 * @property {number} correct     Right attempts among them.
 * @property {number} pct         correct / n, 0..100 (util.pct).
 */

/**
 * @typedef {{ day: string, n: number, correct: number }} DayStats  `day` is a local `YYYY-MM-DD`.
 */

/**
 * @typedef {object} Stats
 * @property {number} totalQuestions   Questions in the study bank.
 * @property {number} answeredUnique   Questions answered at least once (`seen > 0`).
 * @property {number} attempts         Answers given (every attempt counts).
 * @property {number} correctPct       Right attempts over all attempts, 0..100.
 * @property {number} avgMs            Mean answer time per attempt (ms, rounded; 0 without attempts).
 * @property {number} dueCount         Questions whose spaced-repetition review is due now.
 * @property {number} bookmarks        Bookmarked questions.
 * @property {number} notes            Questions with a (non-empty) text note.
 * @property {number} voice            Voice notes.
 * @property {number} highlights       Highlights.
 * @property {ChapterStats[]} byChapter   One per study chapter, in chapter order.
 * @property {TopicStats[]} weakTopics    Topics with ≥ {@link WEAK_TOPIC_MIN_ATTEMPTS} attempts, weakest first,
 *                                        at most {@link WEAK_TOPIC_LIMIT}.
 * @property {DayStats[]} daily        The last {@link DAILY_DAYS} local days, oldest first, today last
 *                                     (days without answers included, with zeros).
 * @property {number} streak           Days in a row with ≥ 1 answer, ending today (or yesterday when
 *                                     nothing was answered yet today); 0 otherwise.
 * @property {number} bestStreak       Longest such run ever (≥ streak).
 * @property {boolean} demoMode        True while no chapter is published (the demo is the bank).
 */

/**
 * @typedef {object} StatsInput
 * @property {Iterable<AnyChapter | { id: string, title?: string, short?: string }>} [chapters]
 *   The study chapters, in order (`data.studyChapters()`).
 * @property {Iterable<Question | { id: string, chapterId?: string, topic?: string }>} [questions]
 *   The study bank (`data.loadStudyBank()`); defines which records count.
 * @property {Iterable<QState> | Map<string, QState>} [states]
 * @property {Iterable<Attempt>} [attempts]
 * @property {Iterable<{ qid: string, text?: string }>} [notes]
 * @property {Iterable<{ qid: string }>} [voice]        Voice note records (only `qid` is read).
 * @property {Iterable<{ qid: string }>} [highlights]   Highlight records (only `qid` is read).
 * @property {number} [now]                              Defaults to `Date.now()`.
 * @property {boolean} [demoMode]
 */

/**
 * @typedef {object} StatsBackend  Test seam (see {@link setTestBackend}).
 * @property {Pick<typeof import('../core/data.js'), 'loadIndex' | 'studyChapters' | 'loadStudyBank'>} data
 * @property {Pick<typeof import('../core/store/repo.js'),
 *   'qstateRepo' | 'attemptsRepo' | 'notesRepo' | 'voiceRepo' | 'highlightsRepo'>} repo
 */

/** Days in the activity chart. */
export const DAILY_DAYS = 30;

/** Attempts a topic needs before it can be called weak. */
export const WEAK_TOPIC_MIN_ATTEMPTS = 3;

/** Longest weak-topics list. */
export const WEAK_TOPIC_LIMIT = 8;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Turns an optional list (array, Map → its values, any iterable) into an array.
 * @param {unknown} v
 * @returns {any[]}
 */
function listOf(v) {
  if (Array.isArray(v)) return v;
  if (v instanceof Map) return [...v.values()];
  if (typeof v === 'object' && v !== null && typeof (/** @type {any} */ (v)[Symbol.iterator]) === 'function') {
    return Array.from(/** @type {Iterable<any>} */ (v));
  }
  return [];
}

/**
 * Qid of a record, when it is a usable string.
 * @param {unknown} r
 * @returns {string | null}
 */
function qidOf(r) {
  return isObj(r) && typeof r.qid === 'string' && r.qid !== '' ? r.qid : null;
}

/**
 * Noon of the local day of `ts`: safely inside the day, whatever DST does.
 * @param {number} ts
 * @returns {number}
 */
function noonOf(ts) {
  return startOfDay(ts) + 12 * HOUR_MS;
}

/**
 * Noon (local) of a `YYYY-MM-DD` day key.
 * @param {string} key
 * @returns {number}
 */
function noonOfKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(y, m - 1, d);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
}

/**
 * The local day after `key`.
 * @param {string} key
 * @returns {string}
 */
function nextDayKey(key) {
  return dayKey(addDays(noonOfKey(key), 1));
}

/**
 * Current and best runs of consecutive local days.
 * @param {Set<string>} days Day keys with at least one answer.
 * @param {number} now
 * @returns {{ streak: number, bestStreak: number }}
 */
function streaks(days, now) {
  const today = noonOf(now);
  let cursor = days.has(dayKey(today)) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak++;
    cursor = addDays(cursor, -1);
  }

  let best = 0;
  let run = 0;
  /** @type {string | null} */
  let prev = null;
  for (const key of [...days].sort()) {
    run = prev !== null && nextDayKey(prev) === key ? run + 1 : 1;
    if (run > best) best = run;
    prev = key;
  }
  return { streak, bestStreak: Math.max(best, streak) };
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

/**
 * Computes every statistic from the study bank and the learner's records.
 * Pure: no I/O, never mutates its input. Records whose `qid` is not in
 * `questions` are ignored; malformed records are skipped.
 *
 * @param {StatsInput} [input]
 * @returns {Stats}
 */
export function aggregateStats(input = {}) {
  const src = isObj(input) ? input : {};
  const now = typeof src.now === 'number' && Number.isFinite(src.now) ? src.now : Date.now();

  /** @type {Map<string, { chapterId: string | null, topic: string }>} */
  const bank = new Map();
  /** @type {Map<string, number>} questions per chapter */
  const totals = new Map();
  for (const q of listOf(src.questions)) {
    if (!isObj(q) || typeof q.id !== 'string' || q.id === '' || bank.has(q.id)) continue;
    const chapterId = typeof q.chapterId === 'string' ? q.chapterId : null;
    bank.set(q.id, { chapterId, topic: typeof q.topic === 'string' ? q.topic.trim() : '' });
    if (chapterId !== null) totals.set(chapterId, (totals.get(chapterId) ?? 0) + 1);
  }

  /** @type {ChapterStats[]} */
  const byChapter = [];
  /** @type {Map<string, ChapterStats>} */
  const chapterRows = new Map();
  /** @type {Map<string, number>} */
  const chapterOrder = new Map();
  for (const c of listOf(src.chapters)) {
    if (!isObj(c) || typeof c.id !== 'string' || chapterRows.has(c.id)) continue;
    const title = typeof c.title === 'string' ? c.title : c.id;
    /** @type {ChapterStats} */
    const row = {
      id: c.id,
      title,
      short: typeof c.short === 'string' && c.short ? c.short : title,
      total: totals.get(c.id) ?? 0,
      answered: 0,
      correct: 0,
      pct: 0,
    };
    chapterOrder.set(c.id, byChapter.length);
    chapterRows.set(c.id, row);
    byChapter.push(row);
  }

  // Per-question state: answered, last result, bookmarks, due reviews.
  let answeredUnique = 0;
  let bookmarks = 0;
  let dueCount = 0;
  const statesSeen = new Set();
  for (const st of listOf(src.states)) {
    const qid = qidOf(st);
    if (qid === null || !bank.has(qid) || statesSeen.has(qid)) continue;
    statesSeen.add(qid);
    const chapterId = bank.get(qid)?.chapterId ?? null;
    const row = chapterId === null ? undefined : chapterRows.get(chapterId);
    if (Number(st.seen) > 0) {
      answeredUnique++;
      if (row) {
        row.answered++;
        if (st.lastCorrect === true) row.correct++;
      }
    }
    if (st.bookmarked === true) bookmarks++;
    if (isDue(st.srs, now)) dueCount++;
  }
  for (const row of byChapter) row.pct = pct(row.correct, row.answered);

  // Attempts: totals, time, topics, days.
  let attempts = 0;
  let correctAttempts = 0;
  let msSum = 0;
  let msCount = 0;
  /** @type {Map<string, { topic: string, chapterId: string | null, n: number, correct: number }>} */
  const topics = new Map();
  /** @type {Map<string, { n: number, correct: number }>} */
  const perDay = new Map();
  for (const a of listOf(src.attempts)) {
    const qid = qidOf(a);
    const info = qid === null ? undefined : bank.get(qid);
    if (!info) continue;
    const right = a.correct === true;
    attempts++;
    if (right) correctAttempts++;
    if (typeof a.ms === 'number' && Number.isFinite(a.ms) && a.ms >= 0) {
      msSum += a.ms;
      msCount++;
    }
    if (info.topic) {
      const key = `${info.chapterId ?? ''}\u0000${info.topic}`;
      let t = topics.get(key);
      if (!t) {
        t = { topic: info.topic, chapterId: info.chapterId, n: 0, correct: 0 };
        topics.set(key, t);
      }
      t.n++;
      if (right) t.correct++;
    }
    const day = typeof a.ts === 'number' && Number.isFinite(a.ts) ? dayKey(a.ts) : '';
    if (day) {
      let d = perDay.get(day);
      if (!d) {
        d = { n: 0, correct: 0 };
        perDay.set(day, d);
      }
      d.n++;
      if (right) d.correct++;
    }
  }

  /** @param {string | null} id */
  const orderOf = (id) => (id === null ? Infinity : (chapterOrder.get(id) ?? Infinity));
  const weakTopics = [...topics.values()]
    .filter((t) => t.n >= WEAK_TOPIC_MIN_ATTEMPTS)
    .sort(
      (a, b) =>
        a.correct / a.n - b.correct / b.n ||
        b.n - a.n ||
        orderOf(a.chapterId) - orderOf(b.chapterId) ||
        (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0),
    )
    .slice(0, WEAK_TOPIC_LIMIT)
    .map((t) => ({ topic: t.topic, chapterId: t.chapterId, n: t.n, correct: t.correct, pct: pct(t.correct, t.n) }));

  /** @type {DayStats[]} */
  const daily = [];
  const today = noonOf(now);
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const day = dayKey(addDays(today, -i));
    const d = perDay.get(day);
    daily.push({ day, n: d ? d.n : 0, correct: d ? d.correct : 0 });
  }

  // Notes, voice notes, highlights (only on study questions).
  const notesSeen = new Set();
  for (const n of listOf(src.notes)) {
    const qid = qidOf(n);
    if (qid === null || !bank.has(qid) || notesSeen.has(qid)) continue;
    // Only a real, non-blank note counts (a record without text is not a note).
    if (typeof n.text !== 'string' || n.text.trim() === '') continue;
    notesSeen.add(qid);
  }
  const countInBank = (/** @type {unknown} */ list) => {
    let count = 0;
    for (const r of listOf(list)) {
      const qid = qidOf(r);
      if (qid !== null && bank.has(qid)) count++;
    }
    return count;
  };

  return {
    totalQuestions: bank.size,
    answeredUnique,
    attempts,
    correctPct: pct(correctAttempts, attempts),
    avgMs: msCount > 0 ? Math.round(msSum / msCount) : 0,
    dueCount,
    bookmarks,
    notes: notesSeen.size,
    voice: countInBank(src.voice),
    highlights: countInBank(src.highlights),
    byChapter,
    weakTopics,
    daily,
    ...streaks(new Set(perDay.keys()), now),
    demoMode: src.demoMode === true,
  };
}

// ---------------------------------------------------------------------------
// I/O wrapper (lazy modules)
// ---------------------------------------------------------------------------

/** @type {StatsBackend | null} */
let testBackend = null;
/** @type {Promise<typeof import('../core/data.js')> | null} */
let dataModule = null;
/** @type {Promise<typeof import('../core/store/repo.js')> | null} */
let repoModule = null;

/** @returns {Promise<StatsBackend['data']>} */
function dataApi() {
  if (testBackend) return Promise.resolve(testBackend.data);
  if (!dataModule) {
    dataModule = import('../core/data.js');
    dataModule.catch(() => {
      dataModule = null;
    });
  }
  return dataModule;
}

/** @returns {Promise<StatsBackend['repo']>} */
function repoApi() {
  if (testBackend) return Promise.resolve(testBackend.repo);
  if (!repoModule) {
    repoModule = import('../core/store/repo.js');
    repoModule.catch(() => {
      repoModule = null;
    });
  }
  return repoModule;
}

/**
 * Loads the study bank and the learner's records, then returns
 * {@link aggregateStats} of them. Voice notes are reduced to their `qid`
 * right away, so no audio stays in memory.
 *
 * @param {number} [now] Defaults to `Date.now()`.
 * @returns {Promise<Stats>}
 * @throws {import('../core/data.js').DataError} When the question bank can't be loaded.
 * @throws {import('../core/store/db.js').StorageError} When the device storage can't be read.
 * @example
 * const s = await computeStats();
 * s.answeredUnique; // 120
 * s.daily.at(-1);   // { day: '2026-10-26', n: 14, correct: 11 }
 */
export async function computeStats(now = Date.now()) {
  const [data, repo] = await Promise.all([dataApi(), repoApi()]);
  const [index, chapters, questions] = await Promise.all([data.loadIndex(), data.studyChapters(), data.loadStudyBank()]);
  const [states, attempts, notes, voice, highlights] = await Promise.all([
    repo.qstateRepo.all(),
    repo.attemptsRepo.all(),
    repo.notesRepo.all(),
    repo.voiceRepo.all().then((list) => listOf(list).map((v) => ({ qid: qidOf(v) }))),
    repo.highlightsRepo.all(),
  ]);
  return aggregateStats({
    chapters,
    questions,
    states,
    attempts,
    notes,
    voice,
    highlights,
    now,
    demoMode: Boolean(index && index.demoMode),
  });
}

/**
 * Unit-test seam: replaces the data and repo modules (`{ data, repo }`), or
 * restores the real ones with `null`.
 * @param {StatsBackend | null} backend
 * @returns {void}
 */
export function setTestBackend(backend) {
  testBackend = isObj(backend) && isObj(backend.data) && isObj(backend.repo) ? /** @type {StatsBackend} */ (backend) : null;
}
