// Unit tests for js/features/quiz/engine.js. Run: node --test tests/unit/*.test.mjs
//
// The reducers and helpers are pure and tested directly. The async API is
// tested against an in-memory fake of the repo/data modules installed with
// setTestBackend() (no IndexedDB in Node). Fixtures use neutral placeholder
// text only.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODES,
  DEFAULT_SECONDS_PER_QUESTION,
  DEFAULT_TITLES,
  SAVE_DELAY_MS,
  SessionError,
  createSessionObject,
  applyAnswer,
  toggleStrike,
  toggleMark,
  goTo,
  addTime,
  finishSession,
  summarize,
  isAnswerLocked,
  remainingMs,
  isTimeUp,
  answeredCount,
  unansweredCount,
  firstUnansweredIndex,
  currentQid,
  answerOf,
  isFinished,
  isCorrectChoice,
  choiceOrderFor,
  nextQState,
  mergeForWrite,
  repairSession,
  createSession,
  loadSession,
  saveSession,
  flushSessions,
  recordAnswer,
  completeSession,
  deleteSession,
  restoreSession,
  latestUnfinished,
  toggleBookmark,
  setTestBackend,
} from '../../js/features/quiz/engine.js';
import { hashString, seededRandom, shuffle } from '../../js/core/util.js';
import { bus } from '../../js/core/events.js';
import { RELEARN_DELAY_MS } from '../../js/features/srs.js';

const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const LETTERS = ['a', 'b', 'c', 'd', 'e'];

/**
 * A placeholder question (no medical content).
 * @param {number} n
 * @param {{ chapterId?: string, topic?: string, answer?: string, choices?: number }} [opts]
 */
function makeQuestion(n, { chapterId = 'ch01', topic = 'Topic A', answer = 'c', choices = 5 } = {}) {
  const prefix = chapterId.toUpperCase();
  return {
    id: `${prefix}-${String(n).padStart(4, '0')}`,
    version: 1,
    topic,
    difficulty: 2,
    reviewed: false,
    stem: `Sample stem ${n}`,
    choices: LETTERS.slice(0, choices).map((l) => ({ id: l, text: `Choice ${l.toUpperCase()} text` })),
    answer,
    explanation: [],
    chapterId,
  };
}

/** Three questions in two chapters and two topics. */
const QUESTIONS = Object.freeze([
  makeQuestion(1, { topic: 'Topic A', answer: 'c' }),
  makeQuestion(2, { topic: 'Topic B', answer: 'a' }),
  makeQuestion(3, { chapterId: 'ch02', topic: 'Topic A', answer: 'e', choices: 5 }),
]);
const [Q1, Q2, Q3] = QUESTIONS;

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** @param {object} [opts] */
function tutor(opts = {}) {
  return createSessionObject({ mode: 'tutor', shuffleChoices: false, ...opts }, QUESTIONS, NOW, 1);
}

/** @param {object} [opts] */
function exam(opts = {}) {
  return createSessionObject({ mode: 'exam', shuffleChoices: false, ...opts }, QUESTIONS, NOW, 1);
}

/** Lets queued promise callbacks run. */
function tickMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// createSessionObject
// ---------------------------------------------------------------------------

describe('createSessionObject', () => {
  test('builds a complete tutor session with defaults', () => {
    const s = createSessionObject({}, QUESTIONS, NOW, 7);
    assert.equal(typeof s.id, 'string');
    assert.ok(s.id.length > 0);
    assert.equal(s.mode, 'tutor');
    assert.equal(s.title, DEFAULT_TITLES.tutor);
    assert.equal(s.createdAt, NOW);
    assert.equal(s.updatedAt, NOW);
    assert.equal(s.finishedAt, null);
    assert.equal(s.graded, false);
    assert.deepEqual(s.qids, [Q1.id, Q2.id, Q3.id]);
    assert.equal(s.index, 0);
    assert.deepEqual(s.answers, {});
    assert.deepEqual(s.struck, {});
    assert.deepEqual(s.marked, {});
    assert.equal(s.timeLimitMs, null);
    assert.equal(s.elapsedMs, 0);
    assert.deepEqual(s.perQuestionMs, {});
    assert.deepEqual(s.options, {
      shuffleChoices: true,
      chapters: 'all',
      filter: 'all',
      secondsPerQuestion: DEFAULT_SECONDS_PER_QUESTION,
    });
  });

  test('exam time limit = seconds per question × questions', () => {
    const s = createSessionObject({ mode: 'exam', secondsPerQuestion: 60 }, QUESTIONS, NOW, 1);
    assert.equal(s.mode, 'exam');
    assert.equal(s.title, DEFAULT_TITLES.exam);
    assert.equal(s.timeLimitMs, 60 * 1000 * 3);
    assert.equal(s.options.secondsPerQuestion, 60);
  });

  test('invalid seconds per question falls back to the default', () => {
    for (const bad of [0, -5, NaN, Infinity, '60', null]) {
      const s = createSessionObject({ mode: 'exam', secondsPerQuestion: bad }, QUESTIONS, NOW, 1);
      assert.equal(s.timeLimitMs, DEFAULT_SECONDS_PER_QUESTION * 1000 * 3, String(bad));
    }
  });

  test('keeps options (chapters copied, filter, shuffle) and a trimmed title', () => {
    const chapters = ['ch01', 'ch02', 'ch01'];
    const s = createSessionObject(
      { title: '  My   quiz  ', chapters, filter: 'incorrect', shuffleChoices: false },
      QUESTIONS,
      NOW,
      1,
    );
    assert.equal(s.title, 'My quiz');
    assert.deepEqual(s.options.chapters, ['ch01', 'ch02']);
    assert.notEqual(s.options.chapters, chapters);
    assert.equal(s.options.filter, 'incorrect');
    assert.equal(s.options.shuffleChoices, false);
  });

  test('empty title uses the default; very long titles are cut', () => {
    assert.equal(createSessionObject({ title: '   ' }, QUESTIONS, NOW, 1).title, 'Practice');
    assert.equal(createSessionObject({ title: 'x'.repeat(500) }, QUESTIONS, NOW, 1).title.length, 120);
  });

  test('skips malformed and duplicate questions, keeps the given order', () => {
    const s = createSessionObject({}, [Q3, null, { stem: 'no id' }, Q1, Q3, { id: '' }, Q2], NOW, 1);
    assert.deepEqual(s.qids, [Q3.id, Q1.id, Q2.id]);
  });

  test('unknown mode throws RangeError', () => {
    assert.throws(() => createSessionObject({ mode: 'speed' }, QUESTIONS, NOW, 1), RangeError);
  });

  test('without shuffle, choices keep file order', () => {
    const s = tutor();
    for (const q of QUESTIONS) assert.deepEqual(s.choiceOrder[q.id], q.choices.map((c) => c.id));
  });

  test('shuffle is a permutation, deterministic for a seed, and follows the documented formula', () => {
    const a = createSessionObject({ shuffleChoices: true }, QUESTIONS, NOW, 42);
    const b = createSessionObject({ shuffleChoices: true }, QUESTIONS, NOW, 42);
    assert.notEqual(a.id, b.id);
    for (const q of QUESTIONS) {
      const ids = q.choices.map((c) => c.id);
      assert.deepEqual([...a.choiceOrder[q.id]].sort(), [...ids].sort());
      assert.deepEqual(a.choiceOrder[q.id], b.choiceOrder[q.id]);
      assert.deepEqual(a.choiceOrder[q.id], shuffle(ids, seededRandom(hashString(`42|${q.id}`))));
    }
  });

  test('different seeds give different orders', () => {
    const orders = new Set();
    for (let seed = 1; seed <= 20; seed++) {
      orders.add(createSessionObject({}, QUESTIONS, NOW, seed).choiceOrder[Q1.id].join(''));
    }
    assert.ok(orders.size > 1);
  });

  test('without a seed every choice order is still a permutation', () => {
    const s = createSessionObject({}, QUESTIONS, NOW);
    for (const q of QUESTIONS) assert.deepEqual([...s.choiceOrder[q.id]].sort(), LETTERS.slice(0, q.choices.length));
  });

  test('never mutates its inputs', () => {
    const opts = deepFreeze({ mode: 'exam', chapters: ['ch01'], filter: 'all' });
    const qs = deepFreeze(QUESTIONS.map((q) => structuredClone(q)));
    assert.doesNotThrow(() => createSessionObject(opts, qs, NOW, 3));
  });

  test('MODES is frozen and complete', () => {
    assert.deepEqual([...MODES], ['tutor', 'exam']);
    assert.ok(Object.isFrozen(MODES));
  });
});

// ---------------------------------------------------------------------------
// applyAnswer
// ---------------------------------------------------------------------------

describe('applyAnswer', () => {
  test('tutor: records the first answer and returns a new object', () => {
    const s = deepFreeze(tutor());
    const next = applyAnswer(s, Q1.id, 'c', true, 1234.4, NOW + 5);
    assert.notEqual(next, s);
    assert.deepEqual(next.answers[Q1.id], { choice: 'c', correct: true, ms: 1234, at: NOW + 5 });
    assert.equal(next.updatedAt, NOW + 5);
    assert.deepEqual(s.answers, {});
  });

  test('tutor: an answered question is locked', () => {
    const s = applyAnswer(tutor(), Q1.id, 'b', false, 1000, NOW);
    assert.equal(applyAnswer(s, Q1.id, 'c', true, 1000, NOW + 1), s);
    assert.equal(applyAnswer(s, Q1.id, 'b', false, 1000, NOW + 1), s);
  });

  test('exam: answers can change until finish', () => {
    let s = applyAnswer(exam(), Q1.id, 'b', false, 1000, NOW);
    s = applyAnswer(s, Q1.id, 'c', true, 2000, NOW + 10);
    assert.deepEqual(s.answers[Q1.id], { choice: 'c', correct: true, ms: 2000, at: NOW + 10 });
    const same = applyAnswer(s, Q1.id, 'c', true, 9999, NOW + 20);
    assert.equal(same, s, 're-tapping the same choice changes nothing');
    const finished = finishSession(s, NOW + 30);
    assert.equal(applyAnswer(finished, Q1.id, 'a', false, 1, NOW + 40), finished);
  });

  test('tutor: ignored after finish', () => {
    const s = finishSession(tutor(), NOW);
    assert.equal(applyAnswer(s, Q1.id, 'c', true, 1, NOW), s);
  });

  test('ignores unknown questions and invalid choices', () => {
    const s = tutor();
    assert.equal(applyAnswer(s, 'CH09-0001', 'a', true, 1, NOW), s);
    assert.equal(applyAnswer(s, Q1.id, 'z', true, 1, NOW), s);
    assert.equal(applyAnswer(s, Q1.id, '', true, 1, NOW), s);
    assert.equal(applyAnswer(s, Q1.id, null, true, 1, NOW), s);
    assert.equal(applyAnswer(s, '__proto__', 'a', true, 1, NOW), s);
  });

  test('sanitizes time and correctness', () => {
    const s = tutor();
    assert.equal(applyAnswer(s, Q1.id, 'a', 'yes', -5, NOW).answers[Q1.id].ms, 0);
    assert.equal(applyAnswer(s, Q1.id, 'a', 'yes', NaN, NOW).answers[Q1.id].correct, false);
    assert.equal(applyAnswer(s, Q1.id, 'a', true, Infinity, NOW).answers[Q1.id].ms, 0);
  });

  test('choosing a struck choice removes its strike', () => {
    let s = exam();
    s = toggleStrike(s, Q1.id, 'a');
    s = toggleStrike(s, Q1.id, 'b');
    s = applyAnswer(s, Q1.id, 'a', false, 1, NOW);
    assert.deepEqual(s.struck[Q1.id], ['b']);
    s = toggleStrike(s, Q2.id, 'd');
    s = applyAnswer(s, Q2.id, 'd', false, 1, NOW);
    assert.equal(Object.hasOwn(s.struck, Q2.id), false);
  });

  test('throws for something that is not a session', () => {
    assert.throws(() => applyAnswer(null, Q1.id, 'a', true, 1, NOW), TypeError);
    assert.throws(() => applyAnswer({ id: 'x' }, Q1.id, 'a', true, 1, NOW), TypeError);
  });
});

// ---------------------------------------------------------------------------
// toggleStrike / toggleMark / goTo
// ---------------------------------------------------------------------------

describe('toggleStrike', () => {
  test('adds and removes a strike without mutating', () => {
    const s0 = deepFreeze(exam());
    const s1 = toggleStrike(s0, Q1.id, 'b');
    assert.deepEqual(s1.struck[Q1.id], ['b']);
    const s2 = deepFreeze(toggleStrike(s1, Q1.id, 'd'));
    assert.deepEqual(s2.struck[Q1.id], ['b', 'd']);
    const s3 = toggleStrike(toggleStrike(s2, Q1.id, 'b'), Q1.id, 'd');
    assert.equal(Object.hasOwn(s3.struck, Q1.id), false, 'empty lists are removed');
    assert.deepEqual(s0.struck, {});
    assert.deepEqual(s2.struck[Q1.id], ['b', 'd']);
  });

  test('ignored for invalid choices, unknown questions, locked answers and finished sessions', () => {
    const s = tutor();
    assert.equal(toggleStrike(s, Q1.id, 'x'), s);
    assert.equal(toggleStrike(s, 'CH09-0001', 'a'), s);
    const answered = applyAnswer(s, Q1.id, 'c', true, 1, NOW);
    assert.equal(toggleStrike(answered, Q1.id, 'a'), answered);
    assert.notEqual(toggleStrike(answered, Q2.id, 'a'), answered);
    const fin = finishSession(exam(), NOW);
    assert.equal(toggleStrike(fin, Q1.id, 'a'), fin);
  });
});

describe('toggleMark', () => {
  test('marks and unmarks', () => {
    const s0 = deepFreeze(exam());
    const s1 = toggleMark(s0, Q2.id);
    assert.deepEqual(s1.marked, { [Q2.id]: true });
    const s2 = toggleMark(s1, Q2.id);
    assert.deepEqual(s2.marked, {});
    assert.deepEqual(s0.marked, {});
  });

  test('ignored for unknown questions and after finish', () => {
    const s = exam();
    assert.equal(toggleMark(s, 'CH09-0001'), s);
    const fin = finishSession(s, NOW);
    assert.equal(toggleMark(fin, Q1.id), fin);
  });
});

describe('goTo', () => {
  test('moves and clamps', () => {
    const s = deepFreeze(tutor());
    assert.equal(goTo(s, 2).index, 2);
    assert.equal(goTo(s, 99).index, 2);
    assert.equal(goTo(s, -4).index, 0);
    assert.equal(goTo(s, 1.9).index, 1);
    assert.equal(goTo(s, Infinity).index, 2);
    assert.equal(s.index, 0);
  });

  test('returns the same object when nothing changes or the index is not a number', () => {
    const s = tutor();
    assert.equal(goTo(s, 0), s);
    assert.equal(goTo(s, NaN), s);
    assert.equal(goTo(s, '2'), s);
    assert.equal(goTo(s, undefined), s);
  });

  test('works after finish (review) and on an empty session', () => {
    const fin = finishSession(tutor(), NOW);
    assert.equal(goTo(fin, 1).index, 1);
    const empty = createSessionObject({}, [], NOW, 1);
    assert.equal(goTo(empty, 5), empty);
  });
});

// ---------------------------------------------------------------------------
// addTime / finishSession / time helpers
// ---------------------------------------------------------------------------

describe('addTime', () => {
  test('adds to the question and the session', () => {
    const s0 = deepFreeze(exam());
    const s1 = addTime(addTime(s0, Q1.id, 1500), Q1.id, 500.4);
    const s2 = addTime(s1, Q2.id, 1000);
    assert.equal(s2.elapsedMs, 3000);
    assert.deepEqual(s2.perQuestionMs, { [Q1.id]: 2000, [Q2.id]: 1000 });
    assert.equal(s0.elapsedMs, 0);
  });

  test('ignores zero, negative, NaN and infinite amounts', () => {
    const s = exam();
    for (const bad of [0, -100, NaN, Infinity, -Infinity, '100', null, 0.2]) assert.equal(addTime(s, Q1.id, bad), s, String(bad));
  });

  test('ignores unknown questions and finished sessions', () => {
    const s = exam();
    assert.equal(addTime(s, 'CH09-0001', 100), s);
    const fin = finishSession(s, NOW);
    assert.equal(addTime(fin, Q1.id, 100), fin);
  });
});

describe('finishSession', () => {
  test('sets finishedAt once', () => {
    const s = deepFreeze(tutor());
    const fin = finishSession(s, NOW + 100);
    assert.equal(fin.finishedAt, NOW + 100);
    assert.equal(fin.updatedAt, NOW + 100);
    assert.equal(isFinished(fin), true);
    assert.equal(isFinished(s), false);
    assert.equal(finishSession(fin, NOW + 200), fin);
  });
});

describe('remainingMs / isTimeUp', () => {
  test('tutor has no time limit', () => {
    const s = tutor();
    assert.equal(remainingMs(s), null);
    assert.equal(isTimeUp(addTime(s, Q1.id, 1e9)), false);
  });

  test('exam counts down and never goes negative', () => {
    let s = exam({ secondsPerQuestion: 10 });
    assert.equal(remainingMs(s), 30000);
    assert.equal(isTimeUp(s), false);
    s = addTime(s, Q1.id, 29999);
    assert.equal(remainingMs(s), 1);
    s = addTime(s, Q2.id, 1);
    assert.equal(remainingMs(s), 0);
    assert.equal(isTimeUp(s), true);
    s = addTime(s, Q3.id, 5000);
    assert.equal(remainingMs(s), 0);
  });
});

describe('isAnswerLocked', () => {
  test('tutor: locked once answered', () => {
    const s = tutor();
    assert.equal(isAnswerLocked(s, Q1.id), false);
    assert.equal(isAnswerLocked(applyAnswer(s, Q1.id, 'a', false, 1, NOW), Q1.id), true);
  });

  test('exam: locked only after finish', () => {
    const s = applyAnswer(exam(), Q1.id, 'a', false, 1, NOW);
    assert.equal(isAnswerLocked(s, Q1.id), false);
    assert.equal(isAnswerLocked(s, Q2.id), false);
    const fin = finishSession(s, NOW);
    assert.equal(isAnswerLocked(fin, Q1.id), true);
    assert.equal(isAnswerLocked(fin, Q2.id), true);
  });

  test('unknown questions are locked', () => {
    assert.equal(isAnswerLocked(exam(), 'CH09-0001'), true);
  });
});

describe('progress helpers', () => {
  test('answered / unanswered counts and first unanswered index', () => {
    let s = exam();
    assert.equal(answeredCount(s), 0);
    assert.equal(unansweredCount(s), 3);
    assert.equal(firstUnansweredIndex(s), 0);
    s = applyAnswer(s, Q1.id, 'a', false, 1, NOW);
    s = applyAnswer(s, Q3.id, 'e', true, 1, NOW);
    assert.equal(answeredCount(s), 2);
    assert.equal(unansweredCount(s), 1);
    assert.equal(firstUnansweredIndex(s), 1);
    assert.equal(firstUnansweredIndex(s, 2), 1, 'wraps around');
    s = applyAnswer(s, Q2.id, 'b', false, 1, NOW);
    assert.equal(firstUnansweredIndex(s), -1);
    assert.equal(unansweredCount(s), 0);
  });

  test('first unanswered index on an empty session is -1', () => {
    assert.equal(firstUnansweredIndex(createSessionObject({}, [], NOW, 1)), -1);
  });

  test('currentQid follows the index', () => {
    const s = tutor();
    assert.equal(currentQid(s), Q1.id);
    assert.equal(currentQid(goTo(s, 2)), Q3.id);
    assert.equal(currentQid(createSessionObject({}, [], NOW, 1)), null);
  });

  test('answerOf returns null for unanswered and unknown questions', () => {
    const s = applyAnswer(tutor(), Q1.id, 'a', false, 1, NOW);
    assert.equal(answerOf(s, Q1.id).choice, 'a');
    assert.equal(answerOf(s, Q2.id), null);
    assert.equal(answerOf(s, 'toString'), null);
  });

  test('isCorrectChoice compares with question.answer', () => {
    assert.equal(isCorrectChoice(Q1, 'c'), true);
    assert.equal(isCorrectChoice(Q1, 'a'), false);
    assert.equal(isCorrectChoice(Q1, ''), false);
    assert.equal(isCorrectChoice(null, 'c'), false);
  });
});

// ---------------------------------------------------------------------------
// choiceOrderFor / nextQState / mergeForWrite / repairSession
// ---------------------------------------------------------------------------

describe('choiceOrderFor', () => {
  test('uses the stored order', () => {
    const s = { ...tutor(), choiceOrder: { [Q1.id]: ['e', 'd', 'c', 'b', 'a'] } };
    assert.deepEqual(choiceOrderFor(s, Q1), ['e', 'd', 'c', 'b', 'a']);
  });

  test('drops removed choices and appends new ones', () => {
    const s = { ...tutor(), choiceOrder: { [Q1.id]: ['x', 'c', 'a'] } };
    assert.deepEqual(choiceOrderFor(s, Q1), ['c', 'a', 'b', 'd', 'e']);
  });

  test('falls back to file order when nothing is stored', () => {
    assert.deepEqual(choiceOrderFor({ choiceOrder: {} }, Q2), ['a', 'b', 'c', 'd', 'e']);
    assert.deepEqual(choiceOrderFor(null, Q2), ['a', 'b', 'c', 'd', 'e']);
  });
});

describe('nextQState', () => {
  test('from no state', () => {
    const st = nextQState(null, { qid: Q1.id, choice: 'c', correct: true, ms: 5000, ts: NOW });
    assert.equal(st.qid, Q1.id);
    assert.equal(st.seen, 1);
    assert.equal(st.correct, 1);
    assert.equal(st.incorrect, 0);
    assert.equal(st.totalMs, 5000);
    assert.equal(st.lastChoice, 'c');
    assert.equal(st.lastCorrect, true);
    assert.equal(st.lastTs, NOW);
    assert.equal(st.bookmarked, false);
    assert.equal(st.srs.reps, 1);
    assert.equal(st.srs.interval, 1);
  });

  test('adds to an existing state and keeps other fields', () => {
    const prev = deepFreeze({
      qid: Q1.id,
      seen: 2,
      correct: 2,
      incorrect: 0,
      totalMs: 1000,
      lastChoice: 'c',
      lastCorrect: true,
      lastTs: NOW - 1,
      bookmarked: true,
      srs: { due: NOW, interval: 3, ease: 2.5, reps: 2, lapses: 0 },
      updated: 5,
    });
    const st = nextQState(prev, { qid: Q1.id, choice: 'a', correct: false, ms: 2000, ts: NOW });
    assert.equal(st.seen, 3);
    assert.equal(st.correct, 2);
    assert.equal(st.incorrect, 1);
    assert.equal(st.totalMs, 3000);
    assert.equal(st.lastChoice, 'a');
    assert.equal(st.lastCorrect, false);
    assert.equal(st.bookmarked, true);
    assert.equal(st.updated, 5);
    assert.equal(st.srs.reps, 0);
    assert.equal(st.srs.lapses, 1);
    assert.equal(st.srs.due, NOW + RELEARN_DELAY_MS);
  });

  test('tolerates corrupted counters', () => {
    const st = nextQState({ seen: 'x', correct: -3, totalMs: NaN, srs: 'bad' }, { qid: 'A-0001', choice: 'a', correct: true, ms: -1, ts: NOW });
    assert.equal(st.seen, 1);
    assert.equal(st.correct, 1);
    assert.equal(st.totalMs, 0);
    assert.equal(st.srs.reps, 1);
  });
});

describe('mergeForWrite', () => {
  test('stamps updatedAt with the save time', () => {
    const s = tutor();
    assert.equal(mergeForWrite(null, s, NOW + 50).updatedAt, NOW + 50);
    assert.equal(mergeForWrite(null, { ...s, updatedAt: NOW + 99 }, NOW + 50).updatedAt, NOW + 99);
  });

  test('never turns a finished session back into an unfinished one', () => {
    const stored = finishSession(exam(), NOW);
    assert.equal(mergeForWrite(stored, exam(), NOW + 1), null);
  });

  test('keeps the first finish time and a true graded flag', () => {
    const s = exam();
    const stored = { ...finishSession(s, NOW), graded: true };
    const rec = mergeForWrite(stored, { ...finishSession(s, NOW + 500), graded: false }, NOW + 600);
    assert.equal(rec.finishedAt, NOW);
    assert.equal(rec.graded, true);
  });
});

describe('repairSession', () => {
  test('rejects unusable records', () => {
    for (const bad of [null, undefined, 3, 'x', [], {}, { id: '' , qids: [] }, { id: 'a' }, { id: 'a', qids: 'x' }]) {
      assert.equal(repairSession(bad), null, JSON.stringify(bad));
    }
  });

  test('a valid session comes back equal', () => {
    let s = exam();
    s = applyAnswer(s, Q1.id, 'a', false, 100, NOW);
    s = toggleStrike(s, Q2.id, 'b');
    s = toggleMark(s, Q3.id);
    s = addTime(s, Q1.id, 100);
    s = goTo(s, 2);
    assert.deepEqual(repairSession(structuredClone(s)), s);
  });

  test('fills defaults and drops foreign or broken entries', () => {
    const raw = {
      id: 'sess-1',
      qids: [Q1.id, Q1.id, 7, Q2.id, '__proto__'],
      mode: 'weird',
      choiceOrder: { [Q1.id]: ['a', 'b', 'c'], [Q2.id]: 'bad' },
      answers: {
        [Q1.id]: { choice: 'z', correct: true },
        [Q2.id]: { choice: 'b', correct: 'yes', ms: -3 },
        'CH09-0001': { choice: 'a', correct: true },
      },
      struck: { [Q1.id]: ['a', 'x', 'a'], 'CH09-0001': ['a'] },
      marked: { [Q2.id]: 'yes', [Q1.id]: true },
      perQuestionMs: { [Q1.id]: 500, [Q2.id]: -5 },
      index: 99,
      elapsedMs: 'x',
      updatedAt: NOW,
    };
    const s = repairSession(raw);
    assert.deepEqual(s.qids, [Q1.id, Q2.id]);
    assert.equal(s.mode, 'tutor');
    assert.equal(s.title, 'Practice');
    assert.equal(s.createdAt, NOW);
    assert.equal(s.updatedAt, NOW);
    assert.equal(s.finishedAt, null);
    assert.equal(s.graded, false);
    assert.deepEqual(s.choiceOrder, { [Q1.id]: ['a', 'b', 'c'] });
    assert.deepEqual(s.answers, { [Q2.id]: { choice: 'b', correct: false, ms: 0, at: null } });
    assert.deepEqual(s.struck, { [Q1.id]: ['a'] });
    assert.deepEqual(s.marked, { [Q1.id]: true });
    assert.deepEqual(s.perQuestionMs, { [Q1.id]: 500 });
    assert.equal(s.index, 1);
    assert.equal(s.elapsedMs, 0);
    assert.equal(s.timeLimitMs, null);
    assert.deepEqual(s.options, { shuffleChoices: true, chapters: 'all', filter: 'all', secondsPerQuestion: 90 });
  });

  test('exam without a time limit gets one; finished without graded counts as graded', () => {
    const s = repairSession({ id: 'e', qids: [Q1.id, Q2.id], mode: 'exam', options: { secondsPerQuestion: 30 }, finishedAt: NOW });
    assert.equal(s.timeLimitMs, 60000);
    assert.equal(s.graded, true);
  });
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

describe('summarize', () => {
  test('empty answers', () => {
    const sum = summarize(tutor(), QUESTIONS);
    assert.equal(sum.total, 3);
    assert.equal(sum.answered, 0);
    assert.equal(sum.correct, 0);
    assert.equal(sum.incorrect, 0);
    assert.equal(sum.unanswered, 3);
    assert.equal(sum.pct, 0);
    assert.equal(sum.timeMs, 0);
    assert.equal(sum.avgMs, 0);
    assert.deepEqual(
      sum.items.map((i) => i.status),
      ['unanswered', 'unanswered', 'unanswered'],
    );
  });

  test('tutor: counts, time, chapters and topics', () => {
    let s = tutor();
    s = applyAnswer(s, Q1.id, 'c', true, 1000, NOW);
    s = applyAnswer(s, Q2.id, 'b', false, 3000, NOW);
    s = addTime(addTime(s, Q1.id, 1000), Q2.id, 3000);
    s = toggleMark(s, Q2.id);
    const sum = summarize(deepFreeze(s), QUESTIONS);
    assert.equal(sum.total, 3);
    assert.equal(sum.answered, 2);
    assert.equal(sum.correct, 1);
    assert.equal(sum.incorrect, 1);
    assert.equal(sum.unanswered, 1);
    assert.equal(sum.pct, 33);
    assert.equal(sum.timeMs, 4000);
    assert.equal(sum.avgMs, 2000);
    assert.deepEqual(sum.byChapter, [
      { chapterId: 'ch01', total: 2, answered: 2, correct: 1, pct: 50 },
      { chapterId: 'ch02', total: 1, answered: 0, correct: 0, pct: 0 },
    ]);
    assert.deepEqual(sum.byTopic, [
      { topic: 'Topic A', total: 2, answered: 1, correct: 1, pct: 50 },
      { topic: 'Topic B', total: 1, answered: 1, correct: 0, pct: 0 },
    ]);
    assert.deepEqual(sum.items, [
      { qid: Q1.id, status: 'correct', choice: 'c', ms: 1000, marked: false },
      { qid: Q2.id, status: 'incorrect', choice: 'b', ms: 3000, marked: true },
      { qid: Q3.id, status: 'unanswered', choice: null, ms: 0, marked: false },
    ]);
  });

  test('tutor keeps the correctness recorded when answered', () => {
    const s = applyAnswer(tutor(), Q1.id, 'a', true, 1, NOW);
    assert.equal(summarize(s, QUESTIONS).correct, 1);
  });

  test('exam: correctness is checked against question.answer at summarize time', () => {
    let s = exam();
    s = applyAnswer(s, Q1.id, 'c', false, 1, NOW);
    s = applyAnswer(s, Q2.id, 'b', true, 1, NOW);
    s = applyAnswer(s, Q3.id, 'e', false, 1, NOW);
    const sum = summarize(s, QUESTIONS);
    assert.equal(sum.correct, 2);
    assert.equal(sum.incorrect, 1);
    assert.equal(sum.pct, 67);
    assert.deepEqual(
      sum.items.map((i) => i.status),
      ['correct', 'incorrect', 'correct'],
    );
  });

  test('exam: missing questions fall back to the recorded correctness and the id prefix', () => {
    let s = exam();
    s = applyAnswer(s, Q3.id, 'a', true, 1, NOW);
    const sum = summarize(s, [Q1]);
    assert.equal(sum.correct, 1);
    assert.deepEqual(
      sum.byChapter.map((c) => c.chapterId),
      ['ch01', 'ch02'],
    );
    assert.deepEqual(
      sum.byTopic.map((t) => t.topic),
      ['Topic A'],
    );
  });

  test('accepts a Map of questions, and no questions at all', () => {
    const s = applyAnswer(exam(), Q1.id, 'c', false, 1, NOW);
    assert.equal(summarize(s, new Map(QUESTIONS.map((q) => [q.id, q]))).correct, 1);
    assert.equal(summarize(s).correct, 0);
  });

  test('time falls back to answer times when no time was tracked', () => {
    let s = tutor();
    s = applyAnswer(s, Q1.id, 'c', true, 1500, NOW);
    s = applyAnswer(s, Q2.id, 'a', true, 2500, NOW);
    const sum = summarize(s, QUESTIONS);
    assert.equal(sum.timeMs, 4000);
    assert.equal(sum.avgMs, 2000);
    assert.equal(sum.pct, 67);
  });

  test('unknown chapter sorts last', () => {
    const s = createSessionObject({}, [{ id: 'weird id', choices: [{ id: 'a' }] }, Q1], NOW, 1);
    const sum = summarize(s, [{ id: 'weird id', choices: [{ id: 'a' }] }, Q1]);
    assert.deepEqual(
      sum.byChapter.map((c) => c.chapterId),
      ['ch01', null],
    );
  });
});

// ---------------------------------------------------------------------------
// Async API (in-memory backend)
// ---------------------------------------------------------------------------

/**
 * In-memory stand-in for repo.js + data.js.
 * @param {object[]} [questions]
 */
function makeBackend(questions = QUESTIONS) {
  const sessions = new Map();
  const qstates = new Map();
  /** @type {any[]} */
  const attempts = [];
  const calls = { sessionPut: 0, sessionGet: 0 };
  /** @type {null | ((op: string, arg: any) => boolean)} */
  let failWhen = null;
  let nextId = 1;
  const clone = (v) => (v == null ? null : structuredClone(v));
  const maybeFail = (op, arg) => {
    if (failWhen && failWhen(op, arg)) {
      const err = new Error('Your device storage is full. Free up some space or export a backup, then try again.');
      err.name = 'StorageError';
      throw err;
    }
  };
  const emptyQState = (qid) => ({
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
  });
  const repo = {
    emptyQState,
    sessionsRepo: {
      async get(id) {
        calls.sessionGet++;
        return clone(sessions.get(id));
      },
      async put(s) {
        maybeFail('sessions.put', s);
        calls.sessionPut++;
        const rec = { ...structuredClone(s), finishedAt: s.finishedAt ?? null };
        sessions.set(rec.id, rec);
        return clone(rec);
      },
      async remove(id) {
        maybeFail('sessions.remove', id);
        sessions.delete(id);
      },
      async latestUnfinished() {
        const list = [...sessions.values()].filter((s) => s.finishedAt == null).sort((a, b) => b.updatedAt - a.updatedAt);
        return clone(list[0]);
      },
    },
    qstateRepo: {
      async update(qid, fn) {
        maybeFail('qstate.update', qid);
        const prev = qstates.get(qid);
        const next = await fn(prev ? clone(prev) : null);
        if (next == null) return clone(prev);
        const rec = { ...emptyQState(qid), ...next, qid };
        qstates.set(qid, rec);
        return clone(rec);
      },
    },
    attemptsRepo: {
      async add(a) {
        maybeFail('attempts.add', a);
        const rec = { ...a, id: nextId++ };
        attempts.push(rec);
        return clone(rec);
      },
      async byQid(qid) {
        return attempts.filter((a) => a.qid === qid).map(clone);
      },
    },
  };
  const data = {
    async getQuestions(qids) {
      const byId = new Map(questions.map((q) => [q.id, q]));
      return [...qids].map((id) => byId.get(id)).filter(Boolean);
    },
  };
  return {
    backend: { repo, data },
    sessions,
    qstates,
    attempts,
    calls,
    /** @param {null | ((op: string, arg: any) => boolean)} fn */
    failWhen(fn) {
      failWhen = fn;
    },
  };
}

/** Collects qstate:change events. */
function watchQState() {
  /** @type {string[]} */
  const seen = [];
  const off = bus.on('qstate:change', ({ qid }) => seen.push(qid));
  return { seen, off };
}

describe('async API', () => {
  /** @type {ReturnType<typeof makeBackend>} */
  let mem;

  beforeEach(() => {
    mem = makeBackend();
    setTestBackend(mem.backend);
  });

  afterEach(() => {
    setTestBackend(null);
  });

  describe('createSession', () => {
    test('loads the questions, keeps the order, drops missing ids and stores the session', async () => {
      const s = await createSession({
        qids: [Q3.id, 'CH09-0001', Q1.id, Q3.id],
        mode: 'exam',
        title: 'Mock exam',
        secondsPerQuestion: 30,
        chapters: ['ch01', 'ch02'],
        filter: 'all',
        seed: 5,
      });
      assert.deepEqual(s.qids, [Q3.id, Q1.id]);
      assert.equal(s.mode, 'exam');
      assert.equal(s.title, 'Mock exam');
      assert.equal(s.timeLimitMs, 60000);
      assert.deepEqual(s.options.chapters, ['ch01', 'ch02']);
      assert.ok(mem.sessions.has(s.id), 'stored immediately');
      assert.deepEqual(mem.sessions.get(s.id).qids, s.qids);
    });

    test('throws a plain-language SessionError when no question is left', async () => {
      await assert.rejects(createSession({ qids: [] }), (err) => err instanceof SessionError && err.code === 'empty');
      await assert.rejects(createSession({ qids: ['CH09-0001'] }), (err) => {
        assert.ok(err instanceof SessionError);
        assert.match(err.message, /no questions/i);
        assert.equal(err.userMessage, err.message);
        return true;
      });
      await assert.rejects(createSession(undefined), SessionError);
      assert.equal(mem.sessions.size, 0);
    });

    test('unknown mode throws RangeError', async () => {
      await assert.rejects(createSession({ qids: [Q1.id], mode: 'x' }), RangeError);
    });
  });

  describe('recordAnswer (tutor)', () => {
    test('writes qstate, srs, one attempt and the session, then emits qstate:change', async () => {
      const w = watchQState();
      try {
        const s = await createSession({ qids: [Q1.id, Q2.id], mode: 'tutor' });
        const out = await recordAnswer(s, Q1, 'c', 4200);
        assert.equal(out.correct, true);
        assert.equal(out.applied, true);
        assert.equal(out.session.answers[Q1.id].choice, 'c');
        const st = mem.qstates.get(Q1.id);
        assert.equal(st.seen, 1);
        assert.equal(st.correct, 1);
        assert.equal(st.incorrect, 0);
        assert.equal(st.totalMs, 4200);
        assert.equal(st.lastChoice, 'c');
        assert.equal(st.lastCorrect, true);
        assert.equal(st.srs.reps, 1);
        assert.equal(mem.attempts.length, 1);
        assert.deepEqual(
          { ...mem.attempts[0], id: undefined, ts: undefined },
          { qid: Q1.id, choice: 'c', correct: true, ms: 4200, mode: 'tutor', sessionId: s.id, id: undefined, ts: undefined },
        );
        assert.equal(mem.sessions.get(s.id).answers[Q1.id].choice, 'c');
        assert.deepEqual(w.seen, [Q1.id]);
      } finally {
        w.off();
      }
    });

    test('a wrong answer counts as incorrect and schedules a relearn', async () => {
      const s = await createSession({ qids: [Q2.id] });
      const out = await recordAnswer(s, Q2, 'e', 1000);
      assert.equal(out.correct, false);
      const st = mem.qstates.get(Q2.id);
      assert.equal(st.incorrect, 1);
      assert.equal(st.srs.lapses, 1);
      assert.equal(st.lastCorrect, false);
    });

    test('a locked answer is not recorded twice', async () => {
      const s = await createSession({ qids: [Q1.id] });
      const first = await recordAnswer(s, Q1, 'a', 1000);
      const again = await recordAnswer(first.session, Q1, 'c', 1000);
      assert.equal(again.applied, false);
      assert.equal(again.session, first.session);
      assert.equal(again.correct, false, 'reports the stored answer');
      assert.equal(mem.attempts.length, 1);
      assert.equal(mem.qstates.get(Q1.id).seen, 1);
    });

    test('keeps the bookmark', async () => {
      await toggleBookmark(Q1.id);
      const s = await createSession({ qids: [Q1.id] });
      await recordAnswer(s, Q1, 'c', 1000);
      assert.equal(mem.qstates.get(Q1.id).bookmarked, true);
    });

    test('storage failures propagate', async () => {
      const s = await createSession({ qids: [Q1.id] });
      mem.failWhen((op) => op === 'qstate.update');
      await assert.rejects(recordAnswer(s, Q1, 'c', 1000), /storage is full/);
    });

    test('rejects a missing question', async () => {
      const s = await createSession({ qids: [Q1.id] });
      await assert.rejects(recordAnswer(s, null, 'c', 1), TypeError);
    });
  });

  describe('recordAnswer (exam) and completeSession', () => {
    test('exam answers only touch the session', async () => {
      const w = watchQState();
      try {
        const s = await createSession({ qids: [Q1.id, Q2.id, Q3.id], mode: 'exam' });
        let r = await recordAnswer(s, Q1, 'a', 1000);
        r = await recordAnswer(r.session, Q1, 'c', 2000);
        assert.equal(r.applied, true);
        assert.equal(mem.qstates.size, 0);
        assert.equal(mem.attempts.length, 0);
        assert.equal(mem.sessions.get(s.id).answers[Q1.id].choice, 'c');
        assert.deepEqual(w.seen, []);
      } finally {
        w.off();
      }
    });

    test('completeSession grades answered questions once; unanswered create no attempt', async () => {
      const w = watchQState();
      try {
        let s = await createSession({ qids: [Q1.id, Q2.id, Q3.id], mode: 'exam' });
        s = (await recordAnswer(s, Q1, 'c', 1000)).session;
        s = (await recordAnswer(s, Q2, 'd', 1000)).session;
        s = addTime(s, Q1.id, 7000);
        const done = await completeSession(s, QUESTIONS);
        assert.ok(done.finishedAt !== null);
        assert.equal(done.graded, true);
        assert.equal(mem.attempts.length, 2);
        assert.ok(mem.attempts.every((a) => a.mode === 'exam' && a.sessionId === s.id));
        assert.equal(mem.attempts.find((a) => a.qid === Q1.id).ms, 7000, 'tracked time wins');
        assert.equal(mem.qstates.get(Q1.id).correct, 1);
        assert.equal(mem.qstates.get(Q2.id).incorrect, 1);
        assert.equal(mem.qstates.has(Q3.id), false);
        assert.deepEqual([...w.seen].sort(), [Q1.id, Q2.id].sort());
        const stored = mem.sessions.get(s.id);
        assert.equal(stored.graded, true);
        assert.ok(stored.finishedAt !== null);

        const again = await completeSession(done, QUESTIONS);
        assert.equal(again.graded, true);
        const stale = await completeSession(s, QUESTIONS);
        assert.equal(stale.graded, true);
        assert.equal(mem.attempts.length, 2, 'never counted twice');
        assert.equal(mem.qstates.get(Q1.id).seen, 1);
      } finally {
        w.off();
      }
    });

    test('grades against the current answer key', async () => {
      let s = await createSession({ qids: [Q1.id], mode: 'exam' });
      s = (await recordAnswer(s, Q1, 'a', 1000)).session;
      const fixed = { ...Q1, answer: 'a' };
      const done = await completeSession(s, [fixed]);
      assert.equal(done.answers[Q1.id].correct, true);
      assert.equal(mem.attempts[0].correct, true);
    });

    test('concurrent calls grade once', async () => {
      let s = await createSession({ qids: [Q1.id, Q2.id], mode: 'exam' });
      s = (await recordAnswer(s, Q1, 'c', 1000)).session;
      s = (await recordAnswer(s, Q2, 'a', 1000)).session;
      const [a, b] = await Promise.all([completeSession(s, QUESTIONS), completeSession(s, QUESTIONS)]);
      assert.equal(a.graded, true);
      assert.equal(b.graded, true);
      assert.equal(mem.attempts.length, 2);
    });

    test('a retry after a failure never double-counts', async () => {
      let s = await createSession({ qids: [Q1.id, Q2.id], mode: 'exam' });
      s = (await recordAnswer(s, Q1, 'c', 1000)).session;
      s = (await recordAnswer(s, Q2, 'a', 1000)).session;
      mem.failWhen((op, arg) => op === 'attempts.add' && arg.qid === Q2.id);
      await assert.rejects(completeSession(s, QUESTIONS), /storage is full/);
      assert.equal(mem.attempts.length, 1);
      const stored = mem.sessions.get(s.id);
      assert.ok(stored.finishedAt !== null, 'stored as finished before grading');
      assert.equal(stored.graded, false);
      assert.equal(await latestUnfinished(), null, 'no longer offered as "Continue"');

      mem.failWhen(null);
      const done = await completeSession(s, QUESTIONS);
      assert.equal(done.graded, true);
      assert.equal(mem.attempts.length, 2);
      assert.deepEqual(mem.attempts.map((a) => a.qid).sort(), [Q1.id, Q2.id].sort());
      assert.equal(mem.qstates.get(Q1.id).seen, 1);
      assert.equal(mem.qstates.get(Q2.id).seen, 1);
    });

    test('without questions, the recorded correctness is used', async () => {
      let s = await createSession({ qids: [Q1.id], mode: 'exam' });
      s = (await recordAnswer(s, Q1, 'c', 1000)).session;
      const done = await completeSession(s);
      assert.equal(done.answers[Q1.id].correct, true);
      assert.equal(mem.qstates.get(Q1.id).correct, 1);
    });

    test('tutor completion only finishes the session', async () => {
      let s = await createSession({ qids: [Q1.id, Q2.id] });
      s = (await recordAnswer(s, Q1, 'c', 1000)).session;
      const done = await completeSession(s, QUESTIONS);
      assert.ok(done.finishedAt !== null);
      assert.equal(done.graded, true);
      assert.equal(mem.attempts.length, 1);
      assert.equal(mem.qstates.get(Q1.id).seen, 1);
    });
  });

  describe('saving', () => {
    test('saveSession is debounced per session and resolves when written', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const s = createSessionObject({}, QUESTIONS, NOW, 1);
      const p1 = saveSession(s);
      const s2 = goTo(s, 2);
      const p2 = saveSession(s2);
      assert.equal(p1, p2, 'callers in one window share the promise');
      t.mock.timers.tick(SAVE_DELAY_MS - 1);
      await tickMicrotasks();
      assert.equal(mem.calls.sessionPut, 0);
      t.mock.timers.tick(1);
      const rec = await p1;
      assert.equal(mem.calls.sessionPut, 1);
      assert.equal(rec.index, 2, 'latest snapshot wins');
      assert.equal(mem.sessions.get(s.id).index, 2);
    });

    test('flushSessions writes pending saves at once', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const a = createSessionObject({}, QUESTIONS, NOW, 1);
      const b = createSessionObject({}, QUESTIONS, NOW, 2);
      saveSession(a);
      saveSession(b);
      await flushSessions();
      assert.ok(mem.sessions.has(a.id));
      assert.ok(mem.sessions.has(b.id));
      assert.equal(mem.calls.sessionPut, 2);
    });

    test('saveSession rejects on storage failure (and for non-sessions)', async () => {
      const s = createSessionObject({}, QUESTIONS, NOW, 1);
      mem.failWhen((op) => op === 'sessions.put');
      const errors = [];
      const original = console.error;
      console.error = (...args) => errors.push(args);
      try {
        await assert.rejects(saveSession(s), /storage is full/);
        await tickMicrotasks();
      } finally {
        console.error = original;
      }
      assert.ok(errors.length >= 1, 'failure is logged too');
      await assert.rejects(saveSession(null), TypeError);
    });

    test('a stale unfinished snapshot never un-finishes a stored session', async () => {
      let s = await createSession({ qids: [Q1.id], mode: 'exam' });
      s = (await recordAnswer(s, Q1, 'c', 1000)).session;
      const done = await completeSession(s, QUESTIONS);
      const kept = await saveSession(goTo(s, 0));
      assert.ok(kept.finishedAt !== null);
      assert.equal(mem.sessions.get(s.id).finishedAt, done.finishedAt);
      assert.equal(mem.sessions.get(s.id).graded, true);
    });

    test('flushes on visibilitychange → hidden', async (t) => {
      /** @type {Record<string, Function>} */
      const listeners = {};
      const fakeDoc = {
        visibilityState: 'visible',
        addEventListener(name, fn) {
          listeners[name] = fn;
        },
      };
      globalThis.document = fakeDoc;
      try {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const s = createSessionObject({}, QUESTIONS, NOW, 1);
        const p = saveSession(s);
        assert.equal(typeof listeners.visibilitychange, 'function');
        fakeDoc.visibilityState = 'hidden';
        listeners.visibilitychange();
        await p;
        assert.ok(mem.sessions.has(s.id));
      } finally {
        delete globalThis.document;
      }
    });
  });

  describe('loading and deleting', () => {
    test('loadSession returns the latest pending snapshot, repaired', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const s = await createSession({ qids: [Q1.id, Q2.id] });
      saveSession(toggleMark(goTo(s, 1), Q2.id));
      const loaded = await loadSession(s.id);
      assert.equal(loaded.index, 1);
      assert.deepEqual(loaded.marked, { [Q2.id]: true });
    });

    test('loadSession repairs damaged records and returns null for missing ones', async () => {
      mem.sessions.set('old', { id: 'old', qids: [Q1.id], index: 9, answers: 'x' });
      const s = await loadSession('old');
      assert.equal(s.index, 0);
      assert.deepEqual(s.answers, {});
      assert.equal(s.mode, 'tutor');
      mem.sessions.set('broken', { id: 'broken' });
      assert.equal(await loadSession('broken'), null);
      assert.equal(await loadSession('nope'), null);
      assert.equal(await loadSession(''), null);
      assert.equal(await loadSession(undefined), null);
    });

    test('deleteSession drops pending saves; restoreSession undoes it', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const s = await createSession({ qids: [Q1.id] });
      const pendingSave = saveSession(goTo(s, 0));
      await deleteSession(s.id);
      assert.equal(await pendingSave, null);
      assert.equal(mem.sessions.has(s.id), false);
      const late = saveSession(s);
      t.mock.timers.tick(SAVE_DELAY_MS);
      assert.equal(await late, null);
      await flushSessions();
      assert.equal(mem.sessions.has(s.id), false, 'a late save never brings it back');
      assert.equal(await loadSession(s.id), null);

      await restoreSession(s);
      assert.ok(mem.sessions.has(s.id));
      assert.equal((await loadSession(s.id)).id, s.id);
    });

    test('latestUnfinished returns the most recent unfinished session', async (t) => {
      const older = await createSession({ qids: [Q1.id], title: 'Older' });
      await new Promise((r) => setTimeout(r, 5));
      const newer = await createSession({ qids: [Q2.id], title: 'Newer' });
      assert.equal((await latestUnfinished()).id, newer.id);
      await completeSession(newer);
      assert.equal((await latestUnfinished()).id, older.id);
      t.mock.timers.enable({ apis: ['setTimeout'] });
      saveSession(goTo(older, 0));
      assert.equal((await latestUnfinished()).id, older.id);
      await completeSession(older);
      assert.equal(await latestUnfinished(), null);
    });
  });

  describe('toggleBookmark', () => {
    test('toggles, keeps progress and emits qstate:change', async () => {
      const w = watchQState();
      try {
        const s = await createSession({ qids: [Q1.id] });
        await recordAnswer(s, Q1, 'c', 1000);
        assert.equal(await toggleBookmark(Q1.id), true);
        assert.equal(mem.qstates.get(Q1.id).bookmarked, true);
        assert.equal(mem.qstates.get(Q1.id).seen, 1);
        assert.equal(await toggleBookmark(Q1.id), false);
        assert.equal(await toggleBookmark(Q2.id), true);
        assert.deepEqual(w.seen, [Q1.id, Q1.id, Q1.id, Q2.id]);
      } finally {
        w.off();
      }
    });

    test('rejects an invalid id', async () => {
      await assert.rejects(toggleBookmark(''), TypeError);
    });
  });
});
