// Unit tests for js/features/quiz/start.js. Run: node --test tests/unit/*.test.mjs
//
// sessionTitle, normalizeCount, noQuestionsMessage and NoQuestionsError are
// pure. startQuiz is exercised on its explicit-`qids` path through the
// engine's setTestBackend (in-memory repo/data stubs), so no IndexedDB,
// network or settings are needed. Neutral placeholder text only.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  sessionTitle,
  normalizeCount,
  noQuestionsMessage,
  NoQuestionsError,
  startQuiz,
  MAX_COUNT,
  TITLE_SEPARATOR,
} = await import('../../js/features/quiz/start.js');
const engine = await import('../../js/features/quiz/engine.js');

describe('sessionTitle', () => {
  test('mode only', () => {
    assert.equal(sessionTitle({ mode: 'tutor' }), 'Practice');
    assert.equal(sessionTitle({ mode: 'exam' }), 'Exam');
    assert.equal(sessionTitle({ mode: 'weird' }), 'Practice');
    assert.equal(sessionTitle(), 'Practice');
  });

  test('one chapter with a known name, plus a filter label', () => {
    assert.equal(
      sessionTitle({ mode: 'tutor', chapters: ['ch11'], filter: 'incorrect', chapterTitles: { ch11: 'Chapter A' } }),
      ['Practice', 'Chapter A', 'Mistakes'].join(TITLE_SEPARATOR),
    );
  });

  test('chapter titles from a Map, a single string id, trimmed', () => {
    const titles = new Map([['ch02', '  Chapter B  ']]);
    assert.equal(sessionTitle({ mode: 'exam', chapters: 'ch02', chapterTitles: titles }), 'Exam · Chapter B');
  });

  test('unknown chapter name is omitted; several chapters are counted', () => {
    assert.equal(sessionTitle({ chapters: ['ch01'] }), 'Practice');
    assert.equal(sessionTitle({ chapters: ['ch01', 'ch02', 'ch02', '', 3] }), 'Practice · 2 chapters');
    assert.equal(sessionTitle({ chapters: 'all', filter: 'all' }), 'Practice');
  });

  test('every non-all filter has a label; unknown filters are ignored', () => {
    assert.equal(sessionTitle({ filter: 'due' }), 'Practice · Due review');
    assert.equal(sessionTitle({ filter: 'bookmarked' }), 'Practice · Bookmarks');
    assert.equal(sessionTitle({ filter: 'nope' }), 'Practice');
  });

  test('ignores prototype keys in chapterTitles', () => {
    assert.equal(sessionTitle({ chapters: ['toString'], chapterTitles: {} }), 'Practice');
  });
});

describe('normalizeCount', () => {
  test('valid values', () => {
    assert.equal(normalizeCount(20, 10), 20);
    assert.equal(normalizeCount('15', 10), 15);
    assert.equal(normalizeCount(7.9, 10), 7);
    assert.equal(normalizeCount('all', 10), 'all');
    assert.equal(normalizeCount(MAX_COUNT + 50, 10), MAX_COUNT);
  });
  test('invalid values give the fallback', () => {
    for (const v of [0, -3, NaN, Infinity, '', null, undefined, 'abc', {}]) assert.equal(normalizeCount(v, 12), 12, String(v));
  });
});

describe('NoQuestionsError', () => {
  test('carries a plain-language userMessage per filter', () => {
    const e = new NoQuestionsError('incorrect');
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'NoQuestionsError');
    assert.equal(e.filter, 'incorrect');
    assert.equal(e.userMessage, noQuestionsMessage('incorrect'));
    assert.equal(e.message, e.userMessage);
    assert.match(e.userMessage, /mistakes/i);
  });
  test('defaults and unknown filters fall back to the general message', () => {
    assert.equal(new NoQuestionsError().userMessage, noQuestionsMessage('all'));
    assert.equal(new NoQuestionsError('zzz').userMessage, noQuestionsMessage('all'));
    assert.equal(noQuestionsMessage('constructor'), noQuestionsMessage('all'));
    assert.equal(new NoQuestionsError(42).filter, 'all');
  });
  test('keeps a cause', () => {
    const cause = new Error('x');
    assert.equal(new NoQuestionsError('explicit', { cause }).cause, cause);
  });
  test('every message is a non-empty sentence', () => {
    for (const f of ['all', 'new', 'incorrect', 'bookmarked', 'due', 'unreviewed', 'flagged', 'notes', 'explicit']) {
      const m = noQuestionsMessage(f);
      assert.ok(typeof m === 'string' && m.length > 10 && /[.]$/.test(m), f);
    }
  });
});

// ---------------------------------------------------------------------------
// startQuiz with explicit qids (engine backend stubbed)
// ---------------------------------------------------------------------------

/** @param {string} id */
function question(id) {
  return {
    id,
    chapterId: 'demo',
    stem: `Placeholder stem ${id}`,
    choices: ['a', 'b', 'c', 'd', 'e'].map((c) => ({ id: c, text: `Option ${c}` })),
    answer: 'a',
  };
}

function backend(known) {
  const sessions = new Map();
  const bank = new Map(known.map((id) => [id, question(id)]));
  return {
    sessions,
    value: {
      data: { getQuestions: async (qids) => qids.map((q) => bank.get(q)).filter(Boolean) },
      repo: {
        sessionsRepo: {
          get: async (id) => sessions.get(id) ?? null,
          put: async (s) => {
            sessions.set(s.id, structuredClone(s));
            return s;
          },
          remove: async (id) => void sessions.delete(id),
          all: async () => [...sessions.values()],
          latestUnfinished: async () => null,
        },
        qstateRepo: { get: async () => null, put: async (s) => s, update: async () => null, all: async () => [] },
        attemptsRepo: { add: async (a) => a, byQid: async () => [], all: async () => [] },
        emptyQState: (qid) => ({ qid, seen: 0, correct: 0, incorrect: 0, totalMs: 0, bookmarked: false, srs: null }),
      },
    },
  };
}

describe('startQuiz (explicit qids)', () => {
  afterEach(() => engine.setTestBackend(null));

  test('stores a session with exactly the given questions, in order when sequential', async () => {
    const b = backend(['DEMO-0001', 'DEMO-0002', 'DEMO-0003']);
    engine.setTestBackend(b.value);
    const id = await startQuiz({ qids: ['DEMO-0002', 'DEMO-0001', 'DEMO-0002', ''], order: 'sequential', mode: 'exam' });
    assert.equal(typeof id, 'string');
    const s = b.sessions.get(id);
    assert.ok(s, 'session stored');
    assert.deepEqual(s.qids, ['DEMO-0002', 'DEMO-0001']);
    assert.equal(s.mode, 'exam');
    assert.equal(s.title, 'Exam');
    assert.ok(s.timeLimitMs > 0);
  });

  test('count limits an explicit list; a custom title wins', async () => {
    const b = backend(['DEMO-0001', 'DEMO-0002', 'DEMO-0003']);
    engine.setTestBackend(b.value);
    const id = await startQuiz({ qids: ['DEMO-0001', 'DEMO-0002', 'DEMO-0003'], count: 2, title: '  My list  ' });
    const s = b.sessions.get(id);
    assert.equal(s.qids.length, 2);
    assert.equal(s.title, 'My list');
    assert.equal(s.mode, 'tutor');
  });

  test('random order keeps the same set', async () => {
    const ids = ['DEMO-0001', 'DEMO-0002', 'DEMO-0003', 'DEMO-0004'];
    const b = backend(ids);
    engine.setTestBackend(b.value);
    const id = await startQuiz({ qids: ids });
    assert.deepEqual([...b.sessions.get(id).qids].sort(), ids);
  });

  test('an empty list throws NoQuestionsError("explicit")', async () => {
    engine.setTestBackend(backend([]).value);
    await assert.rejects(startQuiz({ qids: [] }), (e) => e instanceof NoQuestionsError && e.filter === 'explicit');
  });

  test('ids that no longer exist → NoQuestionsError (engine "empty" mapped)', async () => {
    const b = backend([]);
    engine.setTestBackend(b.value);
    await assert.rejects(startQuiz({ qids: ['DEMO-9999'] }), (e) => e instanceof NoQuestionsError && e.cause instanceof engine.SessionError);
    assert.equal(b.sessions.size, 0);
  });

  test('storage failures propagate unchanged', async () => {
    const b = backend(['DEMO-0001']);
    b.value.repo.sessionsRepo.put = async () => {
      throw new Error('disk full');
    };
    engine.setTestBackend(b.value);
    await assert.rejects(startQuiz({ qids: ['DEMO-0001'] }), /disk full/);
  });
});
