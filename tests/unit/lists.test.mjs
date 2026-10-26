// Unit tests for js/features/lists.js. Run: node --test tests/unit/*.test.mjs
//
// parseListKey, searchListKey, listTitle, collectQids, listHref and qidNumber
// are pure. getList is exercised through setTestBackend with in-memory
// data/repo/search stubs. Neutral placeholder ids and text only.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { LIST_KINDS, parseListKey, searchListKey, listTitle, collectQids, listHref, qidNumber, getList, setTestBackend } =
  await import('../../js/features/lists.js');

describe('parseListKey', () => {
  test('simple kinds', () => {
    for (const k of ['bookmarks', 'notes', 'voice', 'highlights', 'flagged', 'mistakes']) {
      assert.deepEqual(parseListKey(k), { kind: k, arg: null });
    }
  });
  test('kinds with an argument', () => {
    assert.deepEqual(parseListKey('session:abc'), { kind: 'session', arg: 'abc' });
    assert.deepEqual(parseListKey('chapter:ch03'), { kind: 'chapter', arg: 'ch03' });
    assert.deepEqual(parseListKey('session:a:b'), { kind: 'session', arg: 'a:b' });
  });
  test('search arguments are decoded and trimmed', () => {
    assert.deepEqual(parseListKey('search:word%20two'), { kind: 'search', arg: 'word two' });
    assert.deepEqual(parseListKey('search:%E2%80%9Cq%E2%80%9D'), { kind: 'search', arg: '“q”' });
    assert.deepEqual(parseListKey('search:%E0%A4%A'), { kind: 'search', arg: '%E0%A4%A' }, 'malformed escape kept raw');
    assert.equal(parseListKey('search:%20%20'), null);
  });
  test('malformed keys → null', () => {
    for (const k of [undefined, null, 1, '', 'nope', 'bookmarks:x', 'session', 'session:', 'chapter:', 'search', ':x', 'Bookmarks']) {
      assert.equal(parseListKey(k), null, String(k));
    }
  });
  test('LIST_KINDS is frozen and complete', () => {
    assert.ok(Object.isFrozen(LIST_KINDS));
    assert.deepEqual([...LIST_KINDS].sort(), ['bookmarks', 'chapter', 'flagged', 'highlights', 'mistakes', 'notes', 'search', 'session', 'voice']);
  });
});

describe('searchListKey / listTitle / qidNumber', () => {
  test('searchListKey round-trips through parseListKey', () => {
    const key = searchListKey('  a b&c?d  ');
    assert.equal(key, 'search:a%20b%26c%3Fd');
    assert.deepEqual(parseListKey(key), { kind: 'search', arg: 'a b&c?d' });
  });
  test('titles', () => {
    assert.equal(listTitle('bookmarks'), 'Bookmarks');
    assert.equal(listTitle('voice'), 'Voice notes');
    assert.equal(listTitle('search', 'x'), 'Search: “x”');
    assert.equal(listTitle('search'), 'Search');
    assert.equal(listTitle('session', 's1', ' My quiz '), 'My quiz');
    assert.equal(listTitle('session', 's1'), 'Quiz');
    assert.equal(listTitle('chapter', 'ch01', 'Chapter A'), 'Chapter A');
    assert.equal(listTitle('unknown'), 'Questions');
  });
  test('qidNumber', () => {
    assert.equal(qidNumber('CH03-0012'), 12);
    assert.equal(qidNumber('DEMO-0001'), 1);
    assert.equal(qidNumber('bad'), Infinity);
    assert.equal(qidNumber(5), Infinity);
  });
});

describe('listHref', () => {
  test('relative hash links, key encoded', () => {
    assert.equal(listHref('CH03-0001', 'bookmarks'), '#/q/CH03-0001?list=bookmarks');
    assert.equal(listHref('CH03-0001', 'session:a b'), '#/q/CH03-0001?list=session%3Aa%20b');
    assert.equal(listHref('CH03-0001', 'search:x%20y'), '#/q/CH03-0001?list=search%3Ax%2520y');
    assert.equal(listHref('CH03-0001'), '#/q/CH03-0001');
    assert.equal(listHref('CH03-0001', ''), '#/q/CH03-0001');
    assert.ok(!listHref('A/B', 'notes').startsWith('/'));
    assert.equal(listHref('A/B'), '#/q/A%2FB');
  });
  test('the key survives decoding as a query value', () => {
    const key = searchListKey('a&b');
    const href = listHref('DEMO-0001', key);
    const q = new URLSearchParams(href.split('?')[1]);
    assert.equal(q.get('list'), key);
    assert.deepEqual(parseListKey(q.get('list')), { kind: 'search', arg: 'a&b' });
  });
});

describe('collectQids', () => {
  const study = ['A-0001', 'A-0002', 'A-0003', 'B-0001'];

  test('bookmarks: bank order, study only, deduplicated', () => {
    const recs = [
      { qid: 'B-0001', bookmarked: true },
      { qid: 'A-0003', bookmarked: true },
      { qid: 'A-0002', bookmarked: false },
      { qid: 'X-0001', bookmarked: true },
      { qid: 'A-0001', bookmarked: true },
      null,
      { qid: 7, bookmarked: true },
    ];
    assert.deepEqual(collectQids('bookmarks', recs, study), ['A-0001', 'A-0003', 'B-0001']);
  });

  test('mistakes: lastCorrect === false, most recent first', () => {
    const recs = [
      { qid: 'A-0001', lastCorrect: false, lastTs: 10 },
      { qid: 'A-0002', lastCorrect: true, lastTs: 99 },
      { qid: 'A-0003', lastCorrect: false, lastTs: 30 },
      { qid: 'B-0001', lastCorrect: null, lastTs: 50 },
    ];
    assert.deepEqual(collectQids('mistakes', recs, study), ['A-0003', 'A-0001']);
  });

  test('notes: non-blank only, last edited first', () => {
    const recs = [
      { qid: 'A-0001', text: 'one', updated: 1 },
      { qid: 'A-0002', text: '   ', updated: 9 },
      { qid: 'A-0003', text: 'three', updated: 5 },
    ];
    assert.deepEqual(collectQids('notes', recs, study), ['A-0003', 'A-0001']);
  });

  test('voice / highlights / flagged: newest first, one row per question', () => {
    const recs = [
      { qid: 'A-0001', ts: 1 },
      { qid: 'A-0002', ts: 5 },
      { qid: 'A-0001', ts: 9 },
      { qid: 'Z-0001', ts: 99 },
    ];
    for (const kind of ['voice', 'highlights', 'flagged']) assert.deepEqual(collectQids(kind, recs, study), ['A-0001', 'A-0002'], kind);
  });

  test('a StudyScope object works without the question list', () => {
    const scope = { has: (q) => q.startsWith('A-'), rank: (q) => -qidNumber(q) };
    const recs = [{ qid: 'A-0001', bookmarked: true }, { qid: 'A-0002', bookmarked: true }, { qid: 'B-0001', bookmarked: true }];
    assert.deepEqual(collectQids('bookmarks', recs, scope), ['A-0002', 'A-0001']);
  });

  test('unknown kind, bad records or no scope → []', () => {
    assert.deepEqual(collectQids('session', [{ qid: 'A-0001' }], study), []);
    assert.deepEqual(collectQids('notes', null, study), []);
    assert.deepEqual(collectQids('voice', [{ qid: 'A-0001', ts: 1 }], null), []);
  });
});

// ---------------------------------------------------------------------------
// getList (stubbed backend)
// ---------------------------------------------------------------------------

function makeBackend() {
  const chapters = [
    { id: 'ch01', prefix: 'CH01', title: 'Chapter One', short: 'One' },
    { id: 'ch02', prefix: 'CH02', title: 'Chapter Two', short: 'Two' },
  ];
  const questions = { ch01: [{ id: 'CH01-0001' }, { id: 'CH01-0002' }], ch02: [{ id: 'CH02-0001' }] };
  const prefixes = new Map(chapters.map((c) => [c.prefix, c.id]));
  return {
    data: {
      studyChapters: async () => chapters,
      getChapter: async (id) => chapters.find((c) => c.id === id) ?? null,
      loadChapter: async (id) => ({ chapter: chapters.find((c) => c.id === id), questions: questions[id] }),
      chapterIdFromQid: (qid) => prefixes.get(String(qid).split('-')[0]) ?? null,
    },
    repo: {
      qstateRepo: {
        all: async () => [
          { qid: 'CH02-0001', bookmarked: true, lastCorrect: false, lastTs: 5 },
          { qid: 'CH01-0002', bookmarked: true, lastCorrect: false, lastTs: 9 },
          { qid: 'CH09-0001', bookmarked: true, lastCorrect: false, lastTs: 99 },
        ],
      },
      notesRepo: { all: async () => [{ qid: 'CH01-0001', text: 'n', updated: 1 }] },
      voiceRepo: { all: async () => [{ qid: 'CH02-0001', ts: 3, blob: {} }, { qid: 'CH01-0001', ts: 4, blob: {} }] },
      highlightsRepo: { all: async () => [{ qid: 'CH01-0002', ts: 1 }] },
      reportsRepo: { all: async () => [{ qid: 'CH09-0001', ts: 1 }] },
      sessionsRepo: { get: async (id) => (id === 's1' ? { id: 's1', title: 'Quiz one', qids: ['CH09-0001', 'CH01-0001', 'CH09-0001'] } : null) },
    },
    search: {
      search: async (q) => (q === 'word two' ? [{ qid: 'CH02-0001' }, { qid: 'CH09-0002' }, { qid: 'CH01-0001' }, { qid: 'CH02-0001' }] : []),
    },
  };
}

describe('getList', () => {
  afterEach(() => setTestBackend(null));

  test('bookmarks in bank order, outside-study ids dropped', async () => {
    setTestBackend(makeBackend());
    assert.deepEqual(await getList('bookmarks'), { key: 'bookmarks', title: 'Bookmarks', qids: ['CH01-0002', 'CH02-0001'] });
  });

  test('mistakes, notes, voice, highlights, flagged', async () => {
    setTestBackend(makeBackend());
    assert.deepEqual((await getList('mistakes')).qids, ['CH01-0002', 'CH02-0001']);
    assert.deepEqual((await getList('notes')).qids, ['CH01-0001']);
    assert.deepEqual((await getList('voice')).qids, ['CH01-0001', 'CH02-0001']);
    assert.deepEqual((await getList('highlights')).qids, ['CH01-0002']);
    assert.deepEqual((await getList('flagged')).qids, []);
  });

  test('session keeps its own questions (even outside the study bank), deduplicated', async () => {
    setTestBackend(makeBackend());
    assert.deepEqual(await getList('session:s1'), { key: 'session:s1', title: 'Quiz one', qids: ['CH09-0001', 'CH01-0001'] });
    assert.deepEqual(await getList('session:missing'), { key: 'session:missing', title: 'Quiz', qids: [] });
  });

  test('chapter in file order; unknown chapter empty', async () => {
    setTestBackend(makeBackend());
    assert.deepEqual(await getList('chapter:ch01'), { key: 'chapter:ch01', title: 'Chapter One', qids: ['CH01-0001', 'CH01-0002'] });
    assert.deepEqual((await getList('chapter:ch55')).qids, []);
  });

  test('search: decoded query, study only, deduplicated', async () => {
    setTestBackend(makeBackend());
    const key = searchListKey('word two');
    assert.deepEqual(await getList(key), { key, title: 'Search: “word two”', qids: ['CH02-0001', 'CH01-0001'] });
  });

  test('unknown key → empty list, never throws', async () => {
    setTestBackend(makeBackend());
    assert.deepEqual(await getList('nope'), { key: 'nope', title: 'Questions', qids: [] });
    assert.deepEqual(await getList(undefined), { key: '', title: 'Questions', qids: [] });
  });

  test('storage failures reject', async () => {
    const b = makeBackend();
    b.repo.notesRepo.all = async () => {
      throw new Error('read failed');
    };
    setTestBackend(b);
    await assert.rejects(getList('notes'), /read failed/);
  });

  test('an incomplete backend is ignored by the seam', () => {
    setTestBackend({ data: {} });
    setTestBackend(null);
  });
});
