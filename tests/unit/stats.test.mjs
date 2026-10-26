// Unit tests for js/features/stats.js. Run: node --test tests/unit/*.test.mjs
//
// aggregateStats is pure and gets every input directly. computeStats is
// exercised through setTestBackend with in-memory data and repo stubs.
// Neutral placeholder text only (no medical content).
//
// Days are local calendar days, so this file runs in a fixed time zone with
// daylight saving time (America/New_York) to cover DST edges; it restores the
// previous zone at the end. Timestamps are built from local wall-clock times.
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const PREVIOUS_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

const {
  aggregateStats,
  computeStats,
  setTestBackend,
  DAILY_DAYS,
  WEAK_TOPIC_MIN_ATTEMPTS,
  WEAK_TOPIC_LIMIT,
} = await import('../../js/features/stats.js');

after(() => {
  if (PREVIOUS_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREVIOUS_TZ;
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Local wall-clock time → timestamp.
 * @param {number} y
 * @param {number} m 1-based month.
 * @param {number} d
 * @param {number} [hh]
 * @param {number} [mm]
 * @param {number} [ss]
 * @param {number} [ms]
 */
function at(y, m, d, hh = 12, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms).getTime();
}

/** "Now" for most tests: 26 Oct 2026, 15:00 local. */
const NOW = at(2026, 10, 26, 15);

const CHAPTERS = Object.freeze([
  { id: 'ch01', title: 'Chapter One Title', short: 'One' },
  { id: 'ch02', title: 'Chapter Two Title' },
]);

/** Study bank: 3 questions in ch01, 2 in ch02. */
const QUESTIONS = Object.freeze([
  { id: 'CH01-0001', chapterId: 'ch01', topic: 'Topic A' },
  { id: 'CH01-0002', chapterId: 'ch01', topic: 'Topic A' },
  { id: 'CH01-0003', chapterId: 'ch01', topic: 'Topic B' },
  { id: 'CH02-0001', chapterId: 'ch02', topic: 'Topic A' },
  { id: 'CH02-0002', chapterId: 'ch02', topic: '' },
]);

/**
 * @param {string} qid
 * @param {object} [extra]
 */
function state(qid, extra = {}) {
  return {
    qid,
    seen: 1,
    correct: 0,
    incorrect: 0,
    totalMs: 0,
    lastChoice: 'a',
    lastCorrect: false,
    lastTs: NOW - HOUR,
    bookmarked: false,
    srs: null,
    ...extra,
  };
}

let nextAttemptId = 1;
/**
 * @param {string} qid
 * @param {boolean} correct
 * @param {number} ts
 * @param {number} [ms]
 */
function attempt(qid, correct, ts, ms = 10000) {
  return { id: nextAttemptId++, qid, choice: 'a', correct, ms, ts, mode: 'tutor', sessionId: 's1' };
}

/**
 * Attempts on one question, one per given timestamp.
 * @param {number[]} times
 * @param {string} [qid]
 */
function attemptsAt(times, qid = 'CH01-0001') {
  return times.map((ts) => attempt(qid, true, ts));
}

/** @param {{ day: string, n: number }[]} daily */
function activeDays(daily) {
  return daily.filter((d) => d.n > 0).map((d) => d.day);
}

describe('aggregateStats: empty and defaults', () => {
  test('the DST cases below really run in a zone with daylight saving time', () => {
    assert.notEqual(new Date(2026, 0, 15).getTimezoneOffset(), new Date(2026, 6, 15).getTimezoneOffset());
  });

  test('no input gives zeros and 30 empty days ending today', () => {
    const s = aggregateStats({ now: NOW });
    assert.equal(s.totalQuestions, 0);
    assert.equal(s.answeredUnique, 0);
    assert.equal(s.attempts, 0);
    assert.equal(s.correctPct, 0);
    assert.equal(s.avgMs, 0);
    assert.equal(s.dueCount, 0);
    assert.equal(s.bookmarks, 0);
    assert.equal(s.notes, 0);
    assert.equal(s.voice, 0);
    assert.equal(s.highlights, 0);
    assert.deepEqual(s.byChapter, []);
    assert.deepEqual(s.weakTopics, []);
    assert.equal(s.streak, 0);
    assert.equal(s.bestStreak, 0);
    assert.equal(s.demoMode, false);
    assert.equal(s.daily.length, DAILY_DAYS);
    assert.equal(s.daily.at(-1).day, '2026-10-26');
    assert.equal(s.daily[0].day, '2026-09-27');
    assert.ok(s.daily.every((d) => d.n === 0 && d.correct === 0));
  });

  test('tolerates a missing or broken input object', () => {
    for (const input of [undefined, null, 42, 'x', []]) {
      const s = aggregateStats(/** @type {any} */ (input));
      assert.equal(s.totalQuestions, 0);
      assert.equal(s.daily.length, DAILY_DAYS);
    }
  });

  test('an invalid now falls back to the current time', () => {
    const s = aggregateStats({ now: Number.NaN });
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    assert.equal(s.daily.at(-1).day, key);
  });
});

describe('aggregateStats: totals', () => {
  const input = {
    chapters: CHAPTERS,
    questions: QUESTIONS,
    states: [
      state('CH01-0001', { lastCorrect: true, bookmarked: true, srs: { due: NOW - 1, interval: 1, ease: 2.5, reps: 1, lapses: 0 } }),
      state('CH01-0002', { lastCorrect: false, srs: { due: NOW + DAY, interval: 1, ease: 2.5, reps: 1, lapses: 0 } }),
      state('CH01-0003', { seen: 0, lastCorrect: null, bookmarked: true }),
      state('CH02-0001', { lastCorrect: true, srs: { due: NOW, interval: 0, ease: 2.3, reps: 0, lapses: 1 } }),
      // Not in the study bank (unpublished chapter, demo): ignored everywhere.
      state('CH09-0001', { lastCorrect: true, bookmarked: true, srs: { due: 0, interval: 1, ease: 2.5, reps: 1, lapses: 0 } }),
      state('DEMO-0001', { lastCorrect: true, bookmarked: true }),
    ],
    attempts: [
      attempt('CH01-0001', true, NOW - HOUR, 10000),
      attempt('CH01-0002', false, NOW - 2 * HOUR, 20000),
      attempt('CH02-0001', true, NOW - 3 * HOUR, 30001),
      attempt('CH09-0001', true, NOW - HOUR, 1),
      attempt('DEMO-0001', false, NOW - HOUR, 1),
    ],
    notes: [
      { qid: 'CH01-0001', text: 'Note text', updated: NOW },
      { qid: 'CH01-0002', text: '   ', updated: NOW },
      { qid: 'DEMO-0001', text: 'Note text', updated: NOW },
    ],
    voice: [{ qid: 'CH01-0001' }, { qid: 'CH01-0001' }, { qid: 'CH09-0001' }],
    highlights: [{ id: 'h1', qid: 'CH02-0002' }, { id: 'h2', qid: 'DEMO-0001' }, { id: 'h3', qid: 'CH01-0003' }],
    now: NOW,
  };
  const s = aggregateStats(input);

  test('counts only study-bank questions', () => {
    assert.equal(s.totalQuestions, 5);
    assert.equal(s.answeredUnique, 3);
    assert.equal(s.attempts, 3);
    assert.equal(s.correctPct, 67);
    assert.equal(s.avgMs, 20000); // (10000 + 20000 + 30001) / 3 = 20000.33 → 20000
    assert.equal(s.dueCount, 2); // due in the past and due exactly now
    assert.equal(s.bookmarks, 2);
    assert.equal(s.notes, 1); // blank note ignored
    assert.equal(s.voice, 2);
    assert.equal(s.highlights, 2);
  });

  test('byChapter follows the chapter order with totals, answered, correct and pct', () => {
    assert.deepEqual(s.byChapter, [
      { id: 'ch01', title: 'Chapter One Title', short: 'One', total: 3, answered: 2, correct: 1, pct: 50 },
      { id: 'ch02', title: 'Chapter Two Title', short: 'Chapter Two Title', total: 2, answered: 1, correct: 1, pct: 100 },
    ]);
  });

  test('never mutates the input', () => {
    const copy = structuredClone(input);
    aggregateStats(input);
    assert.deepEqual(input, copy);
  });

  test('states may come as a Map; duplicate and malformed records are skipped', () => {
    const map = new Map([
      ['CH01-0001', state('CH01-0001', { lastCorrect: true })],
      ['CH01-0002', state('CH01-0002')],
    ]);
    const r = aggregateStats({ chapters: CHAPTERS, questions: QUESTIONS, states: map, now: NOW });
    assert.equal(r.answeredUnique, 2);
    const dup = aggregateStats({
      chapters: CHAPTERS,
      questions: QUESTIONS,
      states: [state('CH01-0001'), state('CH01-0001', { bookmarked: true }), null, { qid: 7 }, 'x', { seen: 3 }],
      now: NOW,
    });
    assert.equal(dup.answeredUnique, 1);
    assert.equal(dup.bookmarks, 0); // first record of a qid wins
  });

  test('a state with lastCorrect true but never seen does not count as correct', () => {
    const r = aggregateStats({
      chapters: CHAPTERS,
      questions: QUESTIONS,
      states: [state('CH01-0001', { seen: 0, lastCorrect: true })],
      now: NOW,
    });
    assert.equal(r.byChapter[0].answered, 0);
    assert.equal(r.byChapter[0].correct, 0);
    assert.equal(r.byChapter[0].pct, 0);
  });

  test('avgMs ignores missing or invalid times; correctPct stays honest', () => {
    const r = aggregateStats({
      questions: QUESTIONS,
      attempts: [
        attempt('CH01-0001', true, NOW, 1000),
        { qid: 'CH01-0001', correct: false, ts: NOW, ms: Number.NaN },
        { qid: 'CH01-0001', correct: false, ts: NOW, ms: -5 },
        { qid: 'CH01-0001', correct: false, ts: NOW },
      ],
      now: NOW,
    });
    assert.equal(r.attempts, 4);
    assert.equal(r.avgMs, 1000);
    assert.equal(r.correctPct, 25);
    const allRight = aggregateStats({ questions: QUESTIONS, attempts: [attempt('CH01-0001', true, NOW)], now: NOW });
    assert.equal(allRight.correctPct, 100);
  });

  test('records with a malformed qid or timestamp are skipped safely', () => {
    const r = aggregateStats({
      questions: QUESTIONS,
      attempts: [null, 3, { qid: '' }, { qid: 'CH01-0001', correct: true, ts: 'yesterday', ms: 5 }],
      notes: [null, { text: 'x' }],
      voice: [null, {}],
      highlights: 'not a list',
      now: NOW,
    });
    assert.equal(r.attempts, 1);
    assert.equal(r.avgMs, 5);
    assert.ok(r.daily.every((d) => d.n === 0), 'no day for a non-numeric ts');
    assert.equal(r.streak, 0);
    assert.equal(r.notes, 0);
    assert.equal(r.voice, 0);
    assert.equal(r.highlights, 0);
  });

  test('questions with a repeated id count once; questions of unknown chapters count only in totals', () => {
    const r = aggregateStats({
      chapters: CHAPTERS,
      questions: [...QUESTIONS, { id: 'CH01-0001', chapterId: 'ch01' }, { id: 'X-0001', chapterId: 'zz' }, { id: 'X-0002' }],
      states: [state('X-0001'), state('X-0002')],
      now: NOW,
    });
    assert.equal(r.totalQuestions, 7);
    assert.equal(r.byChapter[0].total, 3);
    assert.equal(r.answeredUnique, 2);
    assert.equal(r.byChapter[0].answered + r.byChapter[1].answered, 0);
  });
});

describe('aggregateStats: demo and unpublished chapters are excluded by input', () => {
  const records = {
    states: [state('CH01-0001', { lastCorrect: true }), state('DEMO-0001', { lastCorrect: true, bookmarked: true })],
    attempts: [attempt('CH01-0001', true, NOW), attempt('DEMO-0001', true, NOW), attempt('DEMO-0002', false, NOW)],
    notes: [{ qid: 'DEMO-0001', text: 'Note text' }],
    voice: [{ qid: 'DEMO-0001' }],
    highlights: [{ qid: 'DEMO-0002' }],
    now: NOW,
  };

  test('outside demo mode the demo records do not count', () => {
    const s = aggregateStats({ ...records, chapters: CHAPTERS, questions: QUESTIONS, demoMode: false });
    assert.equal(s.attempts, 1);
    assert.equal(s.answeredUnique, 1);
    assert.equal(s.bookmarks, 0);
    assert.equal(s.notes + s.voice + s.highlights, 0);
    assert.equal(s.demoMode, false);
  });

  test('in demo mode only the demo records count', () => {
    const s = aggregateStats({
      ...records,
      chapters: [{ id: 'demo', title: 'App tour (demo)', short: 'Demo' }],
      questions: [
        { id: 'DEMO-0001', chapterId: 'demo', topic: 'Topic A' },
        { id: 'DEMO-0002', chapterId: 'demo', topic: 'Topic A' },
      ],
      demoMode: true,
    });
    assert.equal(s.totalQuestions, 2);
    assert.equal(s.attempts, 2);
    assert.equal(s.answeredUnique, 1);
    assert.equal(s.bookmarks, 1);
    assert.equal(s.notes, 1);
    assert.equal(s.voice, 1);
    assert.equal(s.highlights, 1);
    assert.equal(s.demoMode, true);
    assert.deepEqual(s.byChapter, [
      { id: 'demo', title: 'App tour (demo)', short: 'Demo', total: 2, answered: 1, correct: 1, pct: 100 },
    ]);
  });

  test('demoMode is true only for exactly true', () => {
    assert.equal(aggregateStats({ demoMode: 1 }).demoMode, false);
    assert.equal(aggregateStats({ demoMode: 'true' }).demoMode, false);
  });
});

describe('aggregateStats: weak topics', () => {
  /** Questions: one per (chapter, topic) pair below. */
  const questions = [
    { id: 'Q-0001', chapterId: 'ch01', topic: 'Topic A' },
    { id: 'Q-0002', chapterId: 'ch01', topic: 'Topic B' },
    { id: 'Q-0003', chapterId: 'ch01', topic: 'Topic C' },
    { id: 'Q-0004', chapterId: 'ch02', topic: 'Topic A' }, // same name, other chapter: its own topic
    { id: 'Q-0005', chapterId: 'ch01', topic: '   ' }, // no topic: never listed
    { id: 'Q-0006', chapterId: 'ch01', topic: 'Topic D' },
  ];
  /**
   * @param {string} qid
   * @param {number} right
   * @param {number} wrong
   */
  const many = (qid, right, wrong) => [
    ...Array.from({ length: right }, () => attempt(qid, true, NOW)),
    ...Array.from({ length: wrong }, () => attempt(qid, false, NOW)),
  ];

  test(`needs ${WEAK_TOPIC_MIN_ATTEMPTS}+ attempts; weakest first, then more attempts first`, () => {
    const s = aggregateStats({
      chapters: CHAPTERS,
      questions,
      attempts: [
        ...many('Q-0001', 1, 1), // 2 attempts: below the threshold
        ...many('Q-0002', 1, 2), // 33%, n 3
        ...many('Q-0003', 2, 4), // 33%, n 6 → before Q-0002 (same pct, more attempts)
        ...many('Q-0004', 0, 3), // 0% → first
        ...many('Q-0005', 0, 9), // no topic
        ...many('Q-0006', 3, 0), // 100% → last (still listed: the screen decides what to show)
      ],
      now: NOW,
    });
    assert.deepEqual(s.weakTopics, [
      { topic: 'Topic A', chapterId: 'ch02', n: 3, correct: 0, pct: 0 },
      { topic: 'Topic C', chapterId: 'ch01', n: 6, correct: 2, pct: 33 },
      { topic: 'Topic B', chapterId: 'ch01', n: 3, correct: 1, pct: 33 },
      { topic: 'Topic D', chapterId: 'ch01', n: 3, correct: 3, pct: 100 },
    ]);
  });

  test('aggregates every question of a topic and keeps exact ratios for ordering', () => {
    const s = aggregateStats({
      chapters: CHAPTERS,
      questions: [
        { id: 'Q-0001', chapterId: 'ch01', topic: 'Topic A' },
        { id: 'Q-0002', chapterId: 'ch01', topic: 'Topic A' },
        { id: 'Q-0003', chapterId: 'ch01', topic: 'Topic B' },
      ],
      attempts: [
        ...many('Q-0001', 1, 0),
        ...many('Q-0002', 0, 2), // Topic A: 1/3 = 0.333…
        ...many('Q-0003', 33, 67), // Topic B: 0.33 (rounds to the same pct, but is lower)
      ],
      now: NOW,
    });
    assert.deepEqual(
      s.weakTopics.map((t) => [t.topic, t.n, t.pct]),
      [
        ['Topic B', 100, 33],
        ['Topic A', 3, 33],
      ],
    );
  });

  test(`lists at most ${WEAK_TOPIC_LIMIT}; full ties fall back to chapter order, then topic name`, () => {
    const qs = [];
    const attempts = [];
    for (let i = 0; i < 12; i++) {
      const qid = `Q-${String(i + 1).padStart(4, '0')}`;
      qs.push({ id: qid, chapterId: i % 2 ? 'ch01' : 'ch02', topic: `Topic ${String.fromCharCode(76 - i)}` });
      attempts.push(...many(qid, 1, 2));
    }
    const s = aggregateStats({ chapters: CHAPTERS, questions: qs, attempts, now: NOW });
    assert.equal(s.weakTopics.length, WEAK_TOPIC_LIMIT);
    const chapters = s.weakTopics.map((t) => t.chapterId);
    assert.deepEqual(chapters, ['ch01', 'ch01', 'ch01', 'ch01', 'ch01', 'ch01', 'ch02', 'ch02']);
    const ch01Topics = s.weakTopics.filter((t) => t.chapterId === 'ch01').map((t) => t.topic);
    assert.deepEqual(ch01Topics, [...ch01Topics].sort());
  });
});

describe('aggregateStats: daily activity', () => {
  test('30 local days, oldest first, zero days filled in', () => {
    const s = aggregateStats({
      questions: QUESTIONS,
      attempts: [
        attempt('CH01-0001', true, at(2026, 10, 26, 0, 0, 0, 0)), // today, first instant
        attempt('CH01-0001', false, at(2026, 10, 26, 14, 59)),
        attempt('CH01-0002', true, at(2026, 10, 25, 23, 59, 59, 999)), // yesterday, last instant
        attempt('CH01-0002', true, at(2026, 9, 27, 0, 1)), // oldest day in range
        attempt('CH01-0002', true, at(2026, 9, 26, 23, 59)), // one day too old
        attempt('CH01-0002', true, at(2026, 10, 27, 9)), // tomorrow (clock change): not a chart day
      ],
      now: NOW,
    });
    assert.equal(s.daily.length, 30);
    for (let i = 1; i < s.daily.length; i++) assert.ok(s.daily[i - 1].day < s.daily[i].day, 'ascending days');
    assert.deepEqual(s.daily.at(-1), { day: '2026-10-26', n: 2, correct: 1 });
    assert.deepEqual(s.daily.at(-2), { day: '2026-10-25', n: 1, correct: 1 });
    assert.deepEqual(s.daily[0], { day: '2026-09-27', n: 1, correct: 1 });
    assert.equal(s.daily.reduce((sum, d) => sum + d.n, 0), 4);
    assert.equal(s.attempts, 6, 'attempts outside the chart still count');
    assert.deepEqual(activeDays(s.daily), ['2026-09-27', '2026-10-25', '2026-10-26']);
  });

  test('crosses a month and a year boundary', () => {
    const s = aggregateStats({ now: at(2027, 1, 3, 8) });
    assert.equal(s.daily[0].day, '2026-12-05');
    assert.equal(s.daily.at(-1).day, '2027-01-03');
    const keys = s.daily.map((d) => d.day);
    assert.ok(keys.includes('2026-12-31') && keys.includes('2027-01-01'));
    assert.equal(new Set(keys).size, 30);
  });

  test('daylight saving changes never skip or repeat a day', () => {
    for (const now of [at(2026, 3, 20, 0, 30), at(2026, 3, 8, 23, 30), at(2026, 11, 1, 0, 30), at(2026, 11, 15, 23, 59)]) {
      const keys = aggregateStats({ now }).daily.map((d) => d.day);
      assert.equal(new Set(keys).size, 30, `30 distinct days for ${new Date(now).toString()}`);
      for (let i = 1; i < keys.length; i++) {
        const prev = new Date(`${keys[i - 1]}T12:00:00`);
        const next = new Date(`${keys[i]}T12:00:00`);
        assert.equal(Math.round((next - prev) / DAY), 1, `${keys[i - 1]} → ${keys[i]}`);
      }
    }
  });

  test('an attempt at local midnight belongs to the new day', () => {
    const s = aggregateStats({
      questions: QUESTIONS,
      attempts: [attempt('CH01-0001', true, at(2026, 10, 26, 0, 0, 0, 0)), attempt('CH01-0001', true, at(2026, 10, 26, 0, 0, 0, 0) - 1)],
      now: NOW,
    });
    assert.deepEqual(activeDays(s.daily), ['2026-10-25', '2026-10-26']);
  });
});

describe('aggregateStats: streaks', () => {
  /** @param {number[]} times @param {number} [now] */
  const streakOf = (times, now = NOW) => {
    const s = aggregateStats({ questions: QUESTIONS, attempts: attemptsAt(times), now });
    return [s.streak, s.bestStreak];
  };

  test('no attempts → 0 / 0', () => {
    assert.deepEqual(streakOf([]), [0, 0]);
  });

  test('ends today when today has an answer', () => {
    assert.deepEqual(streakOf([at(2026, 10, 24), at(2026, 10, 25), at(2026, 10, 26, 9)]), [3, 3]);
  });

  test('still alive (ends yesterday) when nothing was answered yet today', () => {
    assert.deepEqual(streakOf([at(2026, 10, 23), at(2026, 10, 24), at(2026, 10, 25, 22)]), [3, 3]);
  });

  test('broken after a missed day', () => {
    assert.deepEqual(streakOf([at(2026, 10, 22), at(2026, 10, 23), at(2026, 10, 24)]), [0, 3]);
  });

  test('several answers on one day count as one day', () => {
    assert.deepEqual(streakOf([at(2026, 10, 26, 8), at(2026, 10, 26, 9), at(2026, 10, 26, 10)]), [1, 1]);
  });

  test('midnight: 23:59:59.999 and 00:00:00.000 are two days', () => {
    const now = at(2026, 10, 26, 0, 0, 30);
    assert.deepEqual(streakOf([at(2026, 10, 25, 23, 59, 59, 999), at(2026, 10, 26, 0, 0, 0, 0)], now), [2, 2]);
  });

  test('midnight: just after midnight, yesterday keeps the streak alive', () => {
    const now = at(2026, 10, 26, 0, 0, 0, 1);
    assert.deepEqual(streakOf([at(2026, 10, 24, 20), at(2026, 10, 25, 23, 59, 59, 999)], now), [2, 2]);
  });

  test('midnight: one millisecond before midnight, today still counts as today', () => {
    const now = at(2026, 10, 25, 23, 59, 59, 999);
    assert.deepEqual(streakOf([at(2026, 10, 24, 12), at(2026, 10, 25, 0, 0, 0, 0)], now), [2, 2]);
    // The same answers seen from two days later: the run is over.
    assert.deepEqual(streakOf([at(2026, 10, 24, 12), at(2026, 10, 25, 0, 0, 0, 0)], at(2026, 10, 27, 0, 0, 0, 1)), [0, 2]);
  });

  test('bestStreak is the longest run ever, even when the current run is shorter', () => {
    const old = [at(2026, 9, 1), at(2026, 9, 2), at(2026, 9, 3), at(2026, 9, 4)];
    assert.deepEqual(streakOf([...old, at(2026, 10, 25), at(2026, 10, 26)]), [2, 4]);
  });

  test('runs cross month and year boundaries', () => {
    const times = [at(2026, 12, 30), at(2026, 12, 31), at(2027, 1, 1), at(2027, 1, 2)];
    assert.deepEqual(streakOf(times, at(2027, 1, 2, 18)), [4, 4]);
  });

  test('runs cross daylight saving changes (23 h and 25 h days)', () => {
    // Spring forward: 8 Mar 2026; fall back: 1 Nov 2026 (America/New_York).
    const spring = [at(2026, 3, 7, 23, 30), at(2026, 3, 8, 3, 30), at(2026, 3, 9, 0, 15)];
    assert.deepEqual(streakOf(spring, at(2026, 3, 9, 23, 59)), [3, 3]);
    const fall = [at(2026, 10, 31, 23, 59), at(2026, 11, 1, 1, 30), at(2026, 11, 2, 0, 1)];
    assert.deepEqual(streakOf(fall, at(2026, 11, 2, 0, 2)), [3, 3]);
    // now inside the repeated 01:00–02:00 hour of the fall-back day
    assert.deepEqual(streakOf([at(2026, 10, 31, 12), at(2026, 11, 1, 1, 10)], at(2026, 11, 1, 1, 30)), [2, 2]);
  });

  test('a long current run is counted fully', () => {
    const times = Array.from({ length: 400 }, (_, i) => at(2026, 10, 26 - i, 12));
    assert.deepEqual(streakOf(times), [400, 400]);
  });
});

describe('computeStats (I/O wrapper)', () => {
  afterEach(() => setTestBackend(null));

  /**
   * @param {object} [overrides]
   */
  function backend(overrides = {}) {
    const calls = [];
    const data = {
      loadIndex: async () => {
        calls.push('loadIndex');
        return { demoMode: false };
      },
      studyChapters: async () => {
        calls.push('studyChapters');
        return CHAPTERS.map((c) => ({ ...c }));
      },
      loadStudyBank: async () => {
        calls.push('loadStudyBank');
        return QUESTIONS.map((q) => ({ ...q }));
      },
      ...overrides.data,
    };
    const list = (/** @type {any[]} */ rows) => ({ all: async () => rows });
    const repo = {
      qstateRepo: list([state('CH01-0001', { lastCorrect: true }), state('DEMO-0001')]),
      attemptsRepo: list([attempt('CH01-0001', true, NOW - HOUR), attempt('DEMO-0001', true, NOW)]),
      notesRepo: list([{ qid: 'CH01-0002', text: 'Note text', updated: NOW }]),
      voiceRepo: list([
        { id: 'v1', qid: 'CH01-0001', blob: { size: 3 }, mime: 'audio/webm', durationMs: 1000, ts: NOW },
        { id: 'v2', qid: 'DEMO-0001', blob: { size: 3 }, mime: 'audio/webm', durationMs: 1000, ts: NOW },
      ]),
      highlightsRepo: list([{ id: 'h1', qid: 'CH02-0001' }]),
      ...overrides.repo,
    };
    return { data, repo, calls };
  }

  test('loads the study bank and the records, then aggregates them', async () => {
    const b = backend();
    setTestBackend(b);
    const s = await computeStats(NOW);
    assert.equal(s.totalQuestions, 5);
    assert.equal(s.answeredUnique, 1);
    assert.equal(s.attempts, 1);
    assert.equal(s.correctPct, 100);
    assert.equal(s.notes, 1);
    assert.equal(s.voice, 1);
    assert.equal(s.highlights, 1);
    assert.equal(s.byChapter.length, 2);
    assert.equal(s.streak, 1);
    assert.equal(s.demoMode, false);
    assert.equal(s.daily.at(-1).day, '2026-10-26');
    assert.deepEqual([...b.calls].sort(), ['loadIndex', 'loadStudyBank', 'studyChapters']);
  });

  test('reports demo mode from data.loadIndex()', async () => {
    setTestBackend(backend({ data: { loadIndex: async () => ({ demoMode: true }) } }));
    assert.equal((await computeStats(NOW)).demoMode, true);
  });

  test('defaults now to the current time', async () => {
    setTestBackend(backend());
    const s = await computeStats();
    assert.equal(s.daily.length, DAILY_DAYS);
  });

  test('a data failure rejects with the original error', async () => {
    const err = Object.assign(new Error('Could not load the questions.'), { code: 'offline' });
    setTestBackend(backend({ data: { loadStudyBank: async () => Promise.reject(err) } }));
    await assert.rejects(computeStats(NOW), (e) => e === err);
  });

  test('a storage failure rejects with the original error', async () => {
    const err = new Error('Storage is not available.');
    setTestBackend(backend({ repo: { attemptsRepo: { all: async () => Promise.reject(err) } } }));
    await assert.rejects(computeStats(NOW), (e) => e === err);
  });

  test('setTestBackend ignores an incomplete backend', () => {
    assert.doesNotThrow(() => setTestBackend({ data: {} }));
    assert.doesNotThrow(() => setTestBackend(null));
  });
});
