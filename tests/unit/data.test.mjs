// Unit tests for js/core/data.js (question bank loader). Run: node --test tests/unit/*.test.mjs
//
// globalThis.fetch is replaced by a stub that serves either the real files in
// data/ (read from disk) or small in-memory fixtures with placeholder text.
import { test, describe, beforeEach, afterEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  loadIndex,
  studyChapters,
  getChapter,
  loadChapter,
  loadAll,
  loadStudyBank,
  getQuestion,
  getQuestions,
  chapterIdFromQid,
  questionPlainText,
  blockPlainText,
  clearDataCache,
  DataError,
  DEMO_ID,
} from '../../js/core/data.js';

/** The app folder; data.js resolves data paths against the same folder. */
const ROOT = new URL('../../', import.meta.url);
const realFetch = globalThis.fetch;

/** Route value: serve the file with the same path from disk. */
const DISK = Symbol('disk');

/**
 * Routes of the fetch stub, by app-relative path (`data/index.json`). A value
 * is DISK, a JSON-able object, a raw string, or a function returning a Response.
 * @type {Record<string, any>}
 */
let routes = {};
/** App-relative paths fetched since the last reset, in order. @type {string[]} */
let calls = [];

/** @param {string | URL} url */
function relOf(url) {
  const href = String(url);
  return href.startsWith(ROOT.href) ? href.slice(ROOT.href.length) : href;
}

/** @param {string | URL} url */
async function stubFetch(url) {
  const rel = relOf(url);
  calls.push(rel);
  if (!Object.hasOwn(routes, rel)) return new Response('Not found', { status: 404, statusText: 'Not Found' });
  const route = routes[rel];
  if (route === DISK) return new Response(await readFile(new URL(rel, ROOT), 'utf8'), { status: 200 });
  if (typeof route === 'function') return route();
  return new Response(typeof route === 'string' ? route : JSON.stringify(route), { status: 200 });
}

/** Serves the real data/index.json, data/demo.json and data/ch01–ch55.json from disk. */
function serveRealData() {
  routes = { 'data/index.json': DISK, 'data/demo.json': DISK };
  for (let n = 1; n <= 55; n++) routes[`data/ch${String(n).padStart(2, '0')}.json`] = DISK;
}

/** @param {string} rel */
function fetched(rel) {
  return calls.includes(rel);
}

/** Silences and records data.js warnings. */
function muteWarnings() {
  return mock.method(console, 'warn', () => {});
}

// ---------------------------------------------------------------------------
// Fixtures (neutral placeholder text only)
// ---------------------------------------------------------------------------

const PARTS = Object.freeze([
  { id: 'p1', number: 'I', title: 'Part one', volume: 1 },
  { id: 'p2', number: 'II', title: 'Part two', volume: 1 },
  { id: 'p3', number: 'III', title: 'Part three', volume: 2 },
]);

const DEMO_ENTRY = Object.freeze({ id: 'demo', prefix: 'DEMO', title: 'Demo title', short: 'Demo', file: 'data/demo.json', count: 1 });

/**
 * @param {number} n
 * @param {string} part
 * @param {boolean} published
 * @param {object} [extra]
 */
function chapterEntry(n, part, published, extra = {}) {
  const nn = String(n).padStart(2, '0');
  return {
    id: `ch${nn}`,
    number: n,
    part,
    prefix: `CH${nn}`,
    title: `Chapter title ${nn}`,
    short: `Short ${nn}`,
    file: `data/ch${nn}.json`,
    page: n * 10,
    published,
    count: 0,
    ...extra,
  };
}

/**
 * @param {string} id
 * @param {string} label
 */
function question(id, label) {
  return {
    id,
    version: 1,
    topic: 'Topic A',
    difficulty: 1,
    reviewed: false,
    stem: `Sample stem ${label}`,
    choices: [
      { id: 'a', text: 'Choice A text' },
      { id: 'b', text: 'Choice B text' },
      { id: 'c', text: 'Choice C text' },
      { id: 'd', text: 'Choice D text' },
    ],
    answer: 'a',
    explanation: [{ id: 'b1', type: 'p', text: `Sample explanation ${label}` }],
    source: [{ ref: 'Sample source', loc: 'p. 1' }],
  };
}

/**
 * @param {string} chapter
 * @param {object[]} questions
 */
function chapterFile(chapter, questions) {
  return { schemaVersion: 1, chapter, questions };
}

/**
 * One published chapter (ch01, two questions) between unpublished ones, a
 * part without chapters (p3) and the demo. Array order is deliberately not
 * chapter order.
 * @param {{ demo?: any }} [opts] The demo entry to use; an explicit
 *   `demo: undefined` leaves the entry out.
 */
function serveOnePublished(opts = {}) {
  const demo = Object.hasOwn(opts, 'demo') ? opts.demo : DEMO_ENTRY;
  const index = {
    schemaVersion: 1,
    parts: PARTS,
    chapters: [chapterEntry(3, 'p2', false), chapterEntry(1, 'p1', true, { count: 2 }), chapterEntry(2, 'p1', false)],
  };
  if (demo !== undefined) index.demo = demo;
  routes = {
    'data/index.json': index,
    'data/ch01.json': chapterFile('ch01', [question('CH01-0001', 'one'), question('CH01-0002', 'two')]),
    'data/ch02.json': chapterFile('ch02', [question('CH02-0001', 'three')]),
    'data/ch03.json': chapterFile('ch03', [question('CH03-0001', 'four')]),
    'data/demo.json': chapterFile('demo', [{ ...question('DEMO-0001', 'demo'), demo: true }]),
  };
}

/**
 * Asserts that a promise rejects with a DataError of the given code.
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof DataError, `expected DataError, got ${err}`);
    assert.equal(err.code, code);
    assert.equal(err.userMessage, err.message);
    assert.ok(err.message.length > 10);
    return true;
  });
}

beforeEach(() => {
  clearDataCache();
  routes = {};
  calls = [];
  globalThis.fetch = stubFetch;
});

afterEach(() => {
  mock.restoreAll();
});

after(() => {
  globalThis.fetch = realFetch;
  clearDataCache();
});

// ---------------------------------------------------------------------------
// Real data files
// ---------------------------------------------------------------------------

describe('real data files (55 chapters, none published yet)', () => {
  beforeEach(serveRealData);

  test('loadIndex lists no chapters and no parts and turns demo mode on', async () => {
    const warnings = muteWarnings();
    const index = await loadIndex();
    assert.equal(index.schemaVersion, 1);
    assert.deepEqual(index.chapters, []);
    assert.deepEqual(index.parts, []);
    assert.equal(index.demoMode, true);
    assert.equal(warnings.mock.callCount(), 0, 'the real index must load without warnings');
    assert.deepEqual(calls, ['data/index.json']);
  });

  test('the demo entry is normalized', async () => {
    const { demo } = await loadIndex();
    assert.equal(demo.id, DEMO_ID);
    assert.equal(demo.prefix, 'DEMO');
    assert.equal(demo.file, 'data/demo.json');
    assert.equal(demo.count, 10);
    assert.equal(demo.number, null);
    assert.equal(demo.part, null);
    assert.equal(demo.page, null);
    assert.equal(demo.published, true);
    assert.equal(demo.demo, true);
  });

  test('includeUnpublished lists all 55 chapters in 7 parts, sorted by number', async () => {
    const index = await loadIndex({ includeUnpublished: true });
    assert.equal(index.chapters.length, 55);
    index.chapters.forEach((c, i) => {
      const nn = String(i + 1).padStart(2, '0');
      assert.equal(c.number, i + 1);
      assert.equal(c.order, c.number);
      assert.equal(c.id, `ch${nn}`);
      assert.equal(c.prefix, `CH${nn}`);
      assert.equal(c.file, `data/ch${nn}.json`);
      assert.equal(c.published, false);
      assert.equal(c.demo, false);
      assert.ok(Number.isInteger(c.page) && c.page >= 1);
      assert.ok(c.short.length > 0 && c.short.length <= 16, `short label of ${c.id}`);
    });
    assert.deepEqual(
      index.parts.map((p) => [p.id, p.number, p.volume]),
      [['p1', 'I', 1], ['p2', 'II', 1], ['p3', 'III', 1], ['p4', 'IV', 1], ['p5', 'V', 1], ['p6', 'VI', 1], ['p7', 'VII', 2]],
    );
    const listed = index.parts.flatMap((p) => p.chapters);
    assert.deepEqual(listed, index.chapters.map((c) => c.id), 'every chapter listed once, in order');
    for (const p of index.parts) {
      for (const id of p.chapters) assert.equal(index.chapters.find((c) => c.id === id).part, p.id);
    }
    assert.equal(index.parts[6].chapters[0], 'ch26');
    assert.equal(index.parts[6].chapters.at(-1), 'ch55');
    assert.equal(index.demoMode, true, 'demo mode does not depend on the option');
  });

  test('studyChapters and loadStudyBank use only the demo, without fetching chapter files', async () => {
    const study = await studyChapters();
    assert.deepEqual(study.map((c) => c.id), [DEMO_ID]);
    const bank = await loadStudyBank();
    assert.equal(bank.length, 10);
    assert.deepEqual(
      bank.map((q) => q.id),
      Array.from({ length: 10 }, (_, i) => `DEMO-${String(i + 1).padStart(4, '0')}`),
    );
    for (const q of bank) assert.equal(q.chapterId, DEMO_ID);
    assert.deepEqual([...new Set(calls)].sort(), ['data/demo.json', 'data/index.json']);
  });

  test('getChapter returns null for unpublished and unknown chapters, and the demo', async () => {
    assert.equal(await getChapter('ch01'), null);
    assert.equal(await getChapter('ch55'), null);
    assert.equal(await getChapter('nope'), null);
    assert.equal(await getChapter(undefined), null);
    assert.equal((await getChapter(DEMO_ID))?.id, DEMO_ID);
  });

  test('loadChapter refuses an unpublished chapter without fetching its file', async () => {
    await rejectsWith(loadChapter('ch01'), 'unknown-chapter');
    assert.equal(fetched('data/ch01.json'), false);
  });

  test('loadChapter with includeUnpublished loads it; the memo does not leak to normal calls', async () => {
    const { chapter, questions } = await loadChapter('ch01', { includeUnpublished: true });
    assert.equal(chapter.id, 'ch01');
    assert.ok(Array.isArray(questions));
    assert.ok(questions.every((q) => q.id.startsWith('CH01-') && q.chapterId === 'ch01'));
    assert.equal(fetched('data/ch01.json'), true);
    await rejectsWith(loadChapter('ch01'), 'unknown-chapter');
    await rejectsWith(loadChapter('ch01', { includeUnpublished: 'yes' }), 'unknown-chapter');
  });

  test('loadChapter rejects unknown and invalid ids', async () => {
    await rejectsWith(loadChapter('nope'), 'unknown-chapter');
    await rejectsWith(loadChapter(''), 'unknown-chapter');
    await rejectsWith(loadChapter(42), 'unknown-chapter');
    await rejectsWith(loadChapter('nope', { includeUnpublished: true }), 'unknown-chapter');
  });

  test('getQuestion returns null for an unpublished chapter without fetching it', async () => {
    assert.equal(await getQuestion('CH01-0001'), null);
    assert.equal(fetched('data/ch01.json'), false);
    const q = await getQuestion('DEMO-0003');
    assert.equal(q?.id, 'DEMO-0003');
    assert.equal(q.chapterId, DEMO_ID);
    assert.equal(await getQuestion('DEMO-9999'), null);
    assert.equal(await getQuestion('ZZZ-0001'), null);
    assert.equal(await getQuestion('not an id'), null);
    assert.equal(await getQuestion(null), null);
  });

  test('loadAll returns the demo questions unless includeDemo is false', async () => {
    assert.equal((await loadAll()).length, 10);
    assert.deepEqual(await loadAll({ includeDemo: false }), []);
    assert.equal(calls.some((p) => /^data\/ch\d\d\.json$/.test(p)), false);
  });

  test('chapterIdFromQid is null before the index loads, then maps published + demo only', async () => {
    assert.equal(chapterIdFromQid('DEMO-0001'), null);
    await loadIndex();
    assert.equal(chapterIdFromQid('DEMO-0001'), DEMO_ID);
    assert.equal(chapterIdFromQid('CH01-0001'), null);
    assert.equal(chapterIdFromQid('junk'), null);
    assert.equal(chapterIdFromQid(undefined), null);
  });

  test('getQuestions keeps the requested order and skips unpublished or unknown ids', async () => {
    const qs = await getQuestions(['DEMO-0003', 'CH01-0001', 'DEMO-0001', 'junk', 'DEMO-9999', 'DEMO-0003']);
    assert.deepEqual(qs.map((q) => q.id), ['DEMO-0003', 'DEMO-0001', 'DEMO-0003']);
    assert.equal(fetched('data/ch01.json'), false);
  });

  test('every demo question has plain text', async () => {
    for (const q of await loadAll()) {
      const text = questionPlainText(q);
      assert.ok(text.length > q.choices.length * 2, q.id);
      assert.equal(/\*\*|==/.test(text), false, `${q.id}: markup removed`);
    }
  });
});

// ---------------------------------------------------------------------------
// One published chapter
// ---------------------------------------------------------------------------

describe('one published chapter', () => {
  beforeEach(() => serveOnePublished());

  test('loadIndex lists the published chapter and its part only, outside demo mode', async () => {
    const index = await loadIndex();
    assert.deepEqual(index.chapters.map((c) => c.id), ['ch01']);
    assert.deepEqual(index.parts, [{ id: 'p1', number: 'I', title: 'Part one', volume: 1, chapters: ['ch01'] }]);
    assert.equal(index.demoMode, false);
    assert.equal(index.demo?.id, DEMO_ID);
  });

  test('includeUnpublished lists every chapter by number; parts without chapters stay hidden', async () => {
    const index = await loadIndex({ includeUnpublished: true });
    assert.deepEqual(index.chapters.map((c) => c.id), ['ch01', 'ch02', 'ch03']);
    assert.deepEqual(index.parts.map((p) => [p.id, p.chapters]), [['p1', ['ch01', 'ch02']], ['p2', ['ch03']]]);
    assert.equal(index.demoMode, false);
  });

  test('chapter entries are normalized', async () => {
    const ch = await getChapter('ch01');
    assert.equal(ch.number, 1);
    assert.equal(ch.order, 1);
    assert.equal(ch.part, 'p1');
    assert.equal(ch.page, 10);
    assert.equal(ch.published, true);
    assert.equal(ch.demo, false);
    assert.equal(ch.count, 2);
    assert.equal(await getChapter('ch02'), null);
  });

  test('each call returns fresh arrays and part objects', async () => {
    const first = await loadIndex();
    first.chapters.push(first.chapters[0]);
    first.parts[0].chapters.push('ch99');
    first.parts.push(first.parts[0]);
    const second = await loadIndex();
    assert.equal(second.chapters.length, 1);
    assert.equal(second.parts.length, 1);
    assert.deepEqual(second.parts[0].chapters, ['ch01']);
    const study = await studyChapters();
    study.length = 0;
    assert.equal((await studyChapters()).length, 1);
  });

  test('studyChapters and loadStudyBank use the published chapters, not the demo', async () => {
    assert.deepEqual((await studyChapters()).map((c) => c.id), ['ch01']);
    const bank = await loadStudyBank();
    assert.deepEqual(bank.map((q) => [q.id, q.chapterId]), [['CH01-0001', 'ch01'], ['CH01-0002', 'ch01']]);
    assert.equal(fetched('data/demo.json'), false);
  });

  test('loadAll adds the demo last unless includeDemo is false; unpublished files are never fetched', async () => {
    assert.deepEqual((await loadAll()).map((q) => q.id), ['CH01-0001', 'CH01-0002', 'DEMO-0001']);
    assert.deepEqual((await loadAll({ includeDemo: false })).map((q) => q.id), ['CH01-0001', 'CH01-0002']);
    assert.equal(fetched('data/ch02.json'), false);
    assert.equal(fetched('data/ch03.json'), false);
  });

  test('the demo stays loadable outside demo mode', async () => {
    const { chapter, questions } = await loadChapter(DEMO_ID);
    assert.equal(chapter.demo, true);
    assert.deepEqual(questions.map((q) => q.id), ['DEMO-0001']);
    assert.equal(chapterIdFromQid('DEMO-0001'), DEMO_ID);
  });

  test('getQuestion finds published questions and hides unpublished ones', async () => {
    assert.equal((await getQuestion('CH01-0002'))?.stem, 'Sample stem two');
    assert.equal(await getQuestion('CH01-0099'), null);
    assert.equal(await getQuestion('CH02-0001'), null);
    assert.equal(fetched('data/ch02.json'), false);
  });

  test('getQuestions keeps order and duplicates, and skips unpublished and unknown ids', async () => {
    const qs = await getQuestions(['CH01-0002', 'DEMO-0001', 'CH02-0001', 'CH01-0001', 'CH01-0002', 'CH09-0001', 'nope']);
    assert.deepEqual(qs.map((q) => q.id), ['CH01-0002', 'DEMO-0001', 'CH01-0001', 'CH01-0002']);
    assert.equal(fetched('data/ch02.json'), false);
    assert.deepEqual(await getQuestions([]), []);
    assert.deepEqual(await getQuestions(null), []);
    assert.deepEqual((await getQuestions(new Set(['CH01-0001']))).map((q) => q.id), ['CH01-0001']);
  });

  test('chapterIdFromQid maps published chapters and the demo only', async () => {
    await loadIndex();
    assert.equal(chapterIdFromQid('CH01-0001'), 'ch01');
    assert.equal(chapterIdFromQid('CH02-0001'), null);
    assert.equal(chapterIdFromQid('DEMO-0001'), DEMO_ID);
  });

  test('loads are memoized: concurrent callers share one request per file', async () => {
    await Promise.all([loadIndex(), loadIndex({ includeUnpublished: true }), studyChapters(), getChapter('ch01')]);
    await Promise.all([loadChapter('ch01'), loadChapter('ch01'), getQuestion('CH01-0001'), loadAll()]);
    assert.deepEqual(calls.filter((p) => p === 'data/index.json'), ['data/index.json']);
    assert.deepEqual(calls.filter((p) => p === 'data/ch01.json'), ['data/ch01.json']);
    const a = await loadChapter('ch01');
    const b = await loadChapter('ch01');
    assert.notEqual(a.questions, b.questions, 'fresh arrays');
    assert.equal(a.questions[0], b.questions[0], 'shared question objects');
  });

  test('includeUnpublished must be exactly true', async () => {
    await rejectsWith(loadChapter('ch02', { includeUnpublished: 1 }), 'unknown-chapter');
    assert.equal((await loadIndex({ includeUnpublished: 'true' })).chapters.length, 1);
    assert.equal((await loadIndex(null)).chapters.length, 1);
    assert.equal((await loadChapter('ch02', { includeUnpublished: true })).questions.length, 1);
    assert.equal(await getQuestion('CH02-0001'), null, 'a dev load never publishes the chapter');
  });

  test('clearDataCache forgets the index and the chapters', async () => {
    await loadChapter('ch01');
    assert.equal(chapterIdFromQid('CH01-0001'), 'ch01');
    clearDataCache();
    assert.equal(chapterIdFromQid('CH01-0001'), null);
    await loadChapter('ch01');
    assert.deepEqual(calls, ['data/index.json', 'data/ch01.json', 'data/index.json', 'data/ch01.json']);
  });

  test('publishing a second chapter shows it after the cache is cleared', async () => {
    assert.equal((await loadIndex()).chapters.length, 1);
    routes['data/index.json'].chapters[2].published = true;
    clearDataCache();
    const index = await loadIndex();
    assert.deepEqual(index.chapters.map((c) => c.id), ['ch01', 'ch02']);
    assert.deepEqual(index.parts.map((p) => p.chapters), [['ch01', 'ch02']]);
    assert.equal((await getQuestion('CH02-0001'))?.chapterId, 'ch02');
  });
});

// ---------------------------------------------------------------------------
// Malformed data
// ---------------------------------------------------------------------------

describe('malformed index entries', () => {
  beforeEach(() => {
    routes = {
      'data/index.json': {
        schemaVersion: 1,
        parts: [
          { id: 'p1', number: 'I', title: 'Part one', volume: 1 },
          'not an object',
          { number: 'II', title: 'No id' },
          { id: 'p1', title: 'Duplicate part' },
          { id: 'p2' },
        ],
        chapters: [
          chapterEntry(1, 'p1', true),
          'not an object',
          chapterEntry(5, 'p1', true, { prefix: undefined }),
          chapterEntry(6, 'p1', true, { prefix: 'ch06' }),
          chapterEntry(7, 'p9', true),
          chapterEntry(8, 'p1', true, { id: 'demo' }),
          chapterEntry(9, 'p1', true, { file: '../outside.json' }),
          chapterEntry(10, 'p1', true, { file: '/data/ch10.json' }),
          chapterEntry(11, 'p1', true, { file: 'https://example.com/ch11.json' }),
          chapterEntry(12, 'p1', true, { number: 0 }),
          chapterEntry(13, 'p1', true, { number: '13' }),
          chapterEntry(14, 'p1', true, { id: 'ch01' }),
          chapterEntry(15, 'p1', true, { prefix: 'CH01' }),
          chapterEntry(16, 'p1', true, { number: 1 }),
          chapterEntry(17, 'p1', true, { file: 'data/%2e%2e/%2E%2e/outside.json' }),
          chapterEntry(4, 'p2', 'true', { title: '', short: undefined, page: undefined, count: -1, demo: true }),
        ],
        demo: DEMO_ENTRY,
      },
    };
  });

  test('bad entries are skipped with a warning; good ones are normalized', async () => {
    const warnings = muteWarnings();
    const index = await loadIndex({ includeUnpublished: true });
    assert.deepEqual(index.chapters.map((c) => c.id), ['ch01', 'ch04']);
    assert.deepEqual(
      index.parts.map((p) => ({ ...p })),
      [
        { id: 'p1', number: 'I', title: 'Part one', volume: 1, chapters: ['ch01'] },
        { id: 'p2', number: '', title: 'p2', volume: null, chapters: ['ch04'] },
      ],
    );
    const ch04 = index.chapters[1];
    assert.equal(ch04.published, false, 'only the boolean true publishes');
    assert.equal(ch04.title, 'ch04');
    assert.equal(ch04.short, 'ch04');
    assert.equal(ch04.page, null);
    assert.equal(ch04.count, 0);
    assert.equal(ch04.demo, false);
    assert.equal(warnings.mock.callCount(), 17);
    for (const call of warnings.mock.calls) assert.equal(call.arguments[0], '[data]');

    const published = await loadIndex();
    assert.deepEqual(published.chapters.map((c) => c.id), ['ch01']);
    assert.deepEqual(published.parts.map((p) => p.id), ['p1']);
    assert.equal(published.demoMode, false);
  });

  test('malformed questions are skipped; the rest of the chapter still loads', async () => {
    const warnings = muteWarnings();
    const valid = question('CH01-0001', 'one');
    const noExplanation = question('CH01-0002', 'two');
    delete noExplanation.explanation;
    routes['data/ch01.json'] = chapterFile('ch01', [
      valid,
      'not an object',
      question('CH01-1', 'short id'),
      question('CH02-0003', 'wrong prefix'),
      { ...question('CH01-0004', 'x'), stem: '  ' },
      { ...question('CH01-0005', 'x'), choices: [{ id: 'a', text: 'Choice A text' }] },
      { ...question('CH01-0006', 'x'), choices: [{ id: 'a', text: 'Choice A text' }, { id: 'a', text: 'Choice B text' }] },
      { ...question('CH01-0007', 'x'), answer: 'z' },
      { ...question('CH01-0008', 'x'), explanation: 'not a list' },
      { ...question('CH01-0001', 'duplicate') },
      noExplanation,
    ]);
    const { questions } = await loadChapter('ch01');
    assert.deepEqual(questions.map((q) => q.id), ['CH01-0001', 'CH01-0002']);
    assert.equal(questions[0].stem, 'Sample stem one', 'the first of two duplicates wins');
    assert.deepEqual(questions[1].explanation, []);
    assert.ok(warnings.mock.callCount() >= 9 + 16);
  });
});

describe('missing or invalid demo entry', () => {
  test('no demo and nothing published: empty study set, index still loads', async () => {
    serveRealData();
    const index = JSON.parse(await readFile(new URL('data/index.json', ROOT), 'utf8'));
    delete index.demo;
    routes['data/index.json'] = index;
    const warnings = muteWarnings();

    const loaded = await loadIndex();
    assert.equal(loaded.demo, null);
    assert.equal(loaded.demoMode, true);
    assert.deepEqual(loaded.chapters, []);
    assert.equal(warnings.mock.callCount(), 1);
    assert.deepEqual(await studyChapters(), []);
    assert.deepEqual(await loadStudyBank(), []);
    assert.deepEqual(await loadAll(), []);
    assert.equal(await getChapter(DEMO_ID), null);
    assert.equal(await getQuestion('DEMO-0001'), null);
    assert.equal(chapterIdFromQid('DEMO-0001'), null);
    await rejectsWith(loadChapter(DEMO_ID), 'unknown-chapter');
    assert.equal(fetched('data/demo.json'), false);
  });

  test('no demo and one published chapter: normal mode', async () => {
    serveOnePublished({ demo: undefined });
    muteWarnings();
    const index = await loadIndex();
    assert.equal(index.demo, null);
    assert.equal(index.demoMode, false);
    assert.deepEqual((await studyChapters()).map((c) => c.id), ['ch01']);
    assert.deepEqual((await loadAll()).map((q) => q.id), ['CH01-0001', 'CH01-0002']);
  });

  const invalidDemos = [
    ['null', null],
    ['a string', 'demo'],
    ['another id', { ...DEMO_ENTRY, id: 'other' }],
    ['a lowercase prefix', { ...DEMO_ENTRY, prefix: 'demo' }],
    ['no file', { ...DEMO_ENTRY, file: undefined }],
    ['a chapter prefix', { ...DEMO_ENTRY, prefix: 'CH01' }],
    ['an unsafe file', { ...DEMO_ENTRY, file: '../demo.json' }],
  ];
  for (const [label, demo] of invalidDemos) {
    test(`a demo entry with ${label} is ignored with a warning`, async () => {
      serveOnePublished({ demo });
      const warnings = muteWarnings();
      const index = await loadIndex();
      assert.equal(index.demo, null);
      assert.equal(index.demoMode, false);
      assert.deepEqual(index.chapters.map((c) => c.id), ['ch01']);
      assert.equal(warnings.mock.callCount(), 1);
      assert.equal(await getQuestion('DEMO-0001'), null);
    });
  }

  test('an index with no usable chapter and no demo is rejected', async () => {
    routes = { 'data/index.json': { schemaVersion: 1, parts: PARTS, chapters: ['bad'] } };
    muteWarnings();
    await rejectsWith(loadIndex(), 'schema');
  });
});

// ---------------------------------------------------------------------------
// Load errors
// ---------------------------------------------------------------------------

describe('load errors', () => {
  test('a missing index is "not-found"', async () => {
    await rejectsWith(loadIndex(), 'not-found');
  });

  test('a server error is "http"', async () => {
    routes = { 'data/index.json': () => new Response('Oops', { status: 500, statusText: 'Server Error' }) };
    await rejectsWith(loadIndex(), 'http');
  });

  test('a network failure is "network" online and "offline" offline', async () => {
    routes = {
      'data/index.json': () => {
        throw new TypeError('Failed to fetch');
      },
    };
    await rejectsWith(loadIndex(), 'network');

    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
    try {
      await rejectsWith(loadIndex(), 'offline');
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete globalThis.navigator;
    }
  });

  test('invalid JSON is "parse"; a byte order mark is accepted', async () => {
    routes = { 'data/index.json': '{ "schemaVersion": 1, ' };
    await rejectsWith(loadIndex(), 'parse');
    routes = { 'data/index.json': '﻿' + JSON.stringify({ schemaVersion: 1, parts: PARTS, chapters: [], demo: DEMO_ENTRY }) };
    assert.equal((await loadIndex()).demoMode, true);
  });

  const badIndexes = [
    ['a top-level array', [], 'schema'],
    ['no schemaVersion', { parts: PARTS, chapters: [] }, 'schema'],
    ['a newer schemaVersion', { schemaVersion: 2, parts: PARTS, chapters: [] }, 'version'],
    ['no parts list', { schemaVersion: 1, chapters: [chapterEntry(1, 'p1', true)], demo: DEMO_ENTRY }, 'schema'],
    ['no chapters list', { schemaVersion: 1, parts: PARTS, demo: DEMO_ENTRY }, 'schema'],
  ];
  for (const [label, body, code] of badIndexes) {
    test(`an index with ${label} is "${code}"`, async () => {
      routes = { 'data/index.json': body };
      await rejectsWith(loadIndex(), code);
    });
  }

  test('a failed index load is forgotten, so the next call retries', async () => {
    routes = { 'data/index.json': () => new Response('Oops', { status: 503 }) };
    await rejectsWith(studyChapters(), 'http');
    serveOnePublished();
    assert.deepEqual((await studyChapters()).map((c) => c.id), ['ch01']);
    assert.deepEqual(calls, ['data/index.json', 'data/index.json']);
  });

  test('a chapter file of another chapter is "schema"; the failure is forgotten', async () => {
    serveOnePublished();
    routes['data/ch01.json'] = chapterFile('ch02', []);
    await rejectsWith(loadChapter('ch01'), 'schema');
    await rejectsWith(getQuestion('CH01-0001'), 'schema');
    routes['data/ch01.json'] = chapterFile('ch01', [question('CH01-0001', 'one')]);
    assert.equal((await getQuestion('CH01-0001'))?.id, 'CH01-0001');
  });

  test('a chapter file without a questions list is "schema"', async () => {
    serveOnePublished();
    routes['data/ch01.json'] = { schemaVersion: 1, chapter: 'ch01' };
    await rejectsWith(loadAll(), 'schema');
  });
});

// ---------------------------------------------------------------------------
// Plain text helpers
// ---------------------------------------------------------------------------

describe('plain text helpers', () => {
  test('blockPlainText reads every block type in order', () => {
    assert.equal(blockPlainText({ id: 'h', type: 'heading', text: 'Heading text' }), 'Heading text');
    assert.equal(
      blockPlainText({ id: 'l', type: 'list', items: ['Item one', { text: 'Item two', items: ['Sub item'] }] }),
      'Item one\nItem two\nSub item',
    );
    assert.equal(
      blockPlainText({ id: 't', type: 'table', caption: 'Caption', head: ['Col A', 'Col B'], rows: [['Cell 1', 'Cell 2']] }),
      'Caption\nCol A\nCol B\nCell 1\nCell 2',
    );
    assert.equal(
      blockPlainText({
        id: 'f',
        type: 'flow',
        title: 'Flow title',
        steps: [{ text: 'Step one' }, { label: 'then', text: 'Step two' }, { branches: [{ label: 'if A', text: 'Branch A' }, { text: 'Branch B' }] }],
      }),
      'Flow title\nStep one\nthen\nStep two\nif A\nBranch A\nBranch B',
    );
    assert.equal(
      blockPlainText({ id: 'm', type: 'mindmap', center: 'Center', branches: [{ text: 'Branch one', children: ['Leaf'] }] }),
      'Center\nBranch one\nLeaf',
    );
    assert.equal(
      blockPlainText({ id: 'c', type: 'callout', kind: 'key', title: 'Key point', text: 'Body', items: ['Point'] }),
      'Key point\nBody\nPoint',
    );
    assert.equal(blockPlainText({ id: 'q', type: 'quote', text: 'Quoted words', ref: 'Sample source' }), 'Quoted words\nSample source');
    assert.equal(blockPlainText({ id: 'i', type: 'image', src: 'data/img/x.webp', alt: 'Alt text', caption: 'Caption' }), 'Alt text\nCaption');
    assert.equal(blockPlainText({ id: 'u', type: 'future', kind: 'x', label: 'Label', nested: { text: 'Nested' } }), 'Label\nNested');
    assert.equal(blockPlainText(null), '');
  });

  test('inline markup is removed and whitespace collapsed', () => {
    assert.equal(blockPlainText({ id: 'p', type: 'p', text: '**Bold**   word\nand ==key== text' }), 'Bold word and key text');
  });

  test('questionPlainText joins stem, choices, notes in choice order and explanation', () => {
    const q = {
      ...question('CH01-0001', 'one'),
      choiceNotes: { b: 'Note B', a: 'Note A', z: 'Note Z' },
    };
    assert.equal(
      questionPlainText(q),
      [
        'Sample stem one',
        'Choice A text',
        'Choice B text',
        'Choice C text',
        'Choice D text',
        'Note A',
        'Note B',
        'Note Z',
        'Sample explanation one',
      ].join('\n'),
    );
    assert.equal(questionPlainText(q), questionPlainText(q), 'cached result is stable');
    assert.equal(questionPlainText(null), '');
  });
});
