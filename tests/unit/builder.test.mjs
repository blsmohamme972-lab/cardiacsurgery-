// Unit tests for js/features/quiz/builder.js. Run: node --test tests/unit/*.test.mjs
//
// filterQids / pickQids / resolveCount are pure. buildQuestionSet and
// countAvailable are exercised with a stubbed globalThis.fetch that serves a
// small synthetic bank (neutral placeholder text only); only filters that
// need no IndexedDB ('all', 'unreviewed') are used there.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILTERS,
  FILTER_LABELS,
  isFilter,
  filterQids,
  resolveCount,
  pickQids,
  buildQuestionSet,
  countAvailable,
} from '../../js/features/quiz/builder.js';

const NOW = Date.UTC(2026, 0, 15, 10, 0, 0);
const HOUR = 60 * 60 * 1000;

/**
 * Minimal question for the pure filters (only `id` and `reviewed` matter).
 * @param {string} id
 * @param {object} [extra]
 */
function q(id, extra = {}) {
  return { id, reviewed: false, ...extra };
}

/** Five questions in bank order. */
const BANK = Object.freeze([q('T-0001'), q('T-0002'), q('T-0003'), q('T-0004'), q('T-0005')]);
const BANK_IDS = BANK.map((x) => x.id);

/**
 * @param {Record<string, object>} byQid
 * @returns {Map<string, object>}
 */
function states(byQid) {
  return new Map(Object.entries(byQid).map(([qid, s]) => [qid, { qid, ...s }]));
}

// ---------------------------------------------------------------------------
// FILTERS / isFilter
// ---------------------------------------------------------------------------

describe('FILTERS and isFilter', () => {
  test('FILTERS matches the contract and is frozen', () => {
    assert.deepEqual([...FILTERS], ['all', 'new', 'incorrect', 'bookmarked', 'due', 'unreviewed', 'flagged', 'notes']);
    assert.ok(Object.isFrozen(FILTERS));
  });

  test('every filter has a non-empty label', () => {
    assert.ok(Object.isFrozen(FILTER_LABELS));
    for (const f of FILTERS) assert.ok(typeof FILTER_LABELS[f] === 'string' && FILTER_LABELS[f].length > 0, f);
    assert.deepEqual(Object.keys(FILTER_LABELS).sort(), [...FILTERS].sort());
  });

  test('isFilter accepts exactly the known filters', () => {
    for (const f of FILTERS) assert.equal(isFilter(f), true, f);
    for (const v of ['ALL', 'All', ' all', 'mistakes', '', null, undefined, 0, {}, ['all']]) {
      assert.equal(isFilter(v), false, String(v));
    }
  });
});

// ---------------------------------------------------------------------------
// filterQids
// ---------------------------------------------------------------------------

describe('filterQids: general', () => {
  test("'all' keeps every question in bank order", () => {
    assert.deepEqual(filterQids(BANK, null, null, 'all', NOW), BANK_IDS);
  });

  test("the filter defaults to 'all' (undefined or null)", () => {
    assert.deepEqual(filterQids(BANK), BANK_IDS);
    assert.deepEqual(filterQids(BANK, null, null, undefined, NOW), BANK_IDS);
    assert.deepEqual(filterQids(BANK, null, null, /** @type {any} */ (null), NOW), BANK_IDS);
  });

  test('an unknown filter throws a RangeError', () => {
    assert.throws(() => filterQids(BANK, null, null, /** @type {any} */ ('bogus'), NOW), RangeError);
    assert.throws(() => filterQids(BANK, null, null, /** @type {any} */ ('ALL'), NOW), RangeError);
  });

  test('skips duplicates (first wins) and malformed questions', () => {
    const list = [q('T-0001'), null, {}, { id: 7 }, q('T-0002'), q('T-0001'), 'T-0003', q('T-0003')];
    assert.deepEqual(filterQids(/** @type {any} */ (list), null, null, 'all', NOW), ['T-0001', 'T-0002', 'T-0003']);
  });

  test('a non-array question list gives no ids', () => {
    assert.deepEqual(filterQids(/** @type {any} */ (null), null, null, 'all', NOW), []);
    assert.deepEqual(filterQids(/** @type {any} */ ({ id: 'T-0001' }), null, null, 'all', NOW), []);
  });

  test('never changes its inputs', () => {
    const list = BANK.map((x) => ({ ...x }));
    const copy = structuredClone(list);
    const st = states({ 'T-0002': { lastCorrect: false, lastTs: 5 } });
    filterQids(list, st, null, 'incorrect', NOW);
    assert.deepEqual(list, copy);
    assert.equal(st.get('T-0002').lastTs, 5);
  });

  test('states may be a Map, a plain object or an array of records', () => {
    const rec = { 'T-0002': { bookmarked: true }, 'T-0004': { bookmarked: true } };
    const asMap = states(rec);
    const asObject = Object.fromEntries(asMap);
    const asArray = [...asMap.values(), null, { bookmarked: true }];
    for (const s of [asMap, asObject, asArray]) {
      assert.deepEqual(filterQids(BANK, /** @type {any} */ (s), null, 'bookmarked', NOW), ['T-0002', 'T-0004']);
    }
  });

  test('a plain-object state map ignores inherited keys', () => {
    const list = [q('toString'), q('constructor'), q('T-0001')];
    assert.deepEqual(filterQids(list, {}, null, 'new', NOW), ['toString', 'constructor', 'T-0001']);
    assert.deepEqual(filterQids(list, {}, null, 'bookmarked', NOW), []);
  });
});

describe("filterQids: 'new'", () => {
  test('keeps questions never answered', () => {
    const st = states({
      'T-0001': { seen: 1 },
      'T-0002': { seen: 0, correct: 0, incorrect: 0, lastChoice: null, bookmarked: true },
      'T-0003': { correct: 1 },
      'T-0004': { lastChoice: 'b' },
      // T-0005: no state at all
    });
    assert.deepEqual(filterQids(BANK, st, null, 'new', NOW), ['T-0002', 'T-0005']);
  });

  test('a wrong answer also makes a question not new', () => {
    assert.deepEqual(filterQids(BANK, states({ 'T-0001': { incorrect: 2 } }), null, 'new', NOW), BANK_IDS.slice(1));
  });

  test('with no states every question is new', () => {
    assert.deepEqual(filterQids(BANK, null, null, 'new', NOW), BANK_IDS);
    assert.deepEqual(filterQids(BANK, new Map(), null, 'new', NOW), BANK_IDS);
  });
});

describe("filterQids: 'incorrect'", () => {
  test('keeps questions whose last answer was wrong', () => {
    const st = states({
      'T-0001': { lastCorrect: false, correct: 3, incorrect: 1, lastTs: 100 },
      'T-0002': { lastCorrect: true, correct: 1, incorrect: 5, lastTs: 200 },
      'T-0003': { lastCorrect: false, lastTs: 300 },
    });
    assert.deepEqual(filterQids(BANK, st, null, 'incorrect', NOW), ['T-0003', 'T-0001']);
  });

  test('older records without lastCorrect: wrong at least once and never right', () => {
    const st = states({
      'T-0001': { incorrect: 2, correct: 0, lastTs: 10 },
      'T-0002': { incorrect: 2, correct: 1, lastTs: 20 },
      'T-0003': { incorrect: 0, correct: 0, lastTs: 30 },
    });
    assert.deepEqual(filterQids(BANK, st, null, 'incorrect', NOW), ['T-0001']);
  });

  test('orders the most recent mistake first; unknown time last; ties keep bank order', () => {
    const st = states({
      'T-0001': { lastCorrect: false }, // no lastTs
      'T-0002': { lastCorrect: false, lastTs: 50 },
      'T-0003': { lastCorrect: false, lastTs: 900 },
      'T-0004': { lastCorrect: false, lastTs: 50 },
      'T-0005': { lastCorrect: false, lastTs: 400 },
    });
    assert.deepEqual(filterQids(BANK, st, null, 'incorrect', NOW), ['T-0003', 'T-0005', 'T-0002', 'T-0004', 'T-0001']);
  });

  test('no state means no mistake', () => {
    assert.deepEqual(filterQids(BANK, null, null, 'incorrect', NOW), []);
  });
});

describe("filterQids: 'bookmarked'", () => {
  test('keeps only bookmarked === true, in bank order', () => {
    const st = states({
      'T-0004': { bookmarked: true },
      'T-0001': { bookmarked: true },
      'T-0002': { bookmarked: false },
      'T-0003': { bookmarked: 1 },
    });
    assert.deepEqual(filterQids(BANK, st, null, 'bookmarked', NOW), ['T-0001', 'T-0004']);
  });
});

describe("filterQids: 'due'", () => {
  test('keeps questions whose review is due at `now`', () => {
    const st = states({
      'T-0001': { srs: { due: NOW - HOUR, interval: 1, ease: 2.5, reps: 1, lapses: 0 } },
      'T-0002': { srs: { due: NOW + HOUR, interval: 1, ease: 2.5, reps: 1, lapses: 0 } },
      'T-0003': { srs: null },
      'T-0004': { srs: { due: NOW, interval: 3, ease: 2.5, reps: 2, lapses: 0 } },
      // T-0005: never answered
    });
    assert.deepEqual(filterQids(BANK, st, null, 'due', NOW), ['T-0001', 'T-0004']);
    // Later, the second one is due too (most overdue first).
    assert.deepEqual(filterQids(BANK, st, null, 'due', NOW + 2 * HOUR), ['T-0001', 'T-0004', 'T-0002']);
  });

  test('orders the most overdue first; ties keep bank order', () => {
    const st = states({
      'T-0001': { srs: { due: NOW - 1 * HOUR } },
      'T-0002': { srs: { due: NOW - 5 * HOUR } },
      'T-0003': { srs: { due: NOW - 3 * HOUR } },
      'T-0004': { srs: { due: NOW - 5 * HOUR } },
      'T-0005': { srs: { due: NOW + 1 * HOUR } },
    });
    assert.deepEqual(filterQids(BANK, st, null, 'due', NOW), ['T-0002', 'T-0004', 'T-0003', 'T-0001']);
  });

  test('a missing or invalid due time is never due', () => {
    const st = states({ 'T-0001': { srs: {} }, 'T-0002': { srs: { due: 'soon' } }, 'T-0003': { srs: { due: NaN } } });
    assert.deepEqual(filterQids(BANK, st, null, 'due', NOW), []);
  });
});

describe("filterQids: 'unreviewed'", () => {
  test('keeps reviewed === false only', () => {
    const list = [q('T-0001'), q('T-0002', { reviewed: true }), q('T-0003', { reviewed: undefined }), q('T-0004')];
    delete list[2].reviewed;
    assert.deepEqual(filterQids(list, null, null, 'unreviewed', NOW), ['T-0001', 'T-0004']);
  });
});

describe("filterQids: 'flagged' and 'notes'", () => {
  test("'flagged' keeps questions in extras.flagged (Set or iterable), in bank order", () => {
    assert.deepEqual(filterQids(BANK, null, { flagged: new Set(['T-0005', 'T-0002', 'X-9999']) }, 'flagged', NOW), [
      'T-0002',
      'T-0005',
    ]);
    assert.deepEqual(filterQids(BANK, null, { flagged: ['T-0003'] }, 'flagged', NOW), ['T-0003']);
  });

  test("'notes' keeps questions in extras.notes (Set or iterable), in bank order", () => {
    assert.deepEqual(filterQids(BANK, null, { notes: new Set(['T-0004', 'T-0001']) }, 'notes', NOW), ['T-0001', 'T-0004']);
    assert.deepEqual(filterQids(BANK, null, { notes: ['T-0002'] }, 'notes', NOW), ['T-0002']);
  });

  test('missing extras give no ids', () => {
    for (const f of /** @type {const} */ (['flagged', 'notes'])) {
      assert.deepEqual(filterQids(BANK, null, null, f, NOW), []);
      assert.deepEqual(filterQids(BANK, null, {}, f, NOW), []);
    }
  });

  test('each filter reads only its own set', () => {
    const extras = { flagged: new Set(['T-0001']), notes: new Set(['T-0002']) };
    assert.deepEqual(filterQids(BANK, null, extras, 'flagged', NOW), ['T-0001']);
    assert.deepEqual(filterQids(BANK, null, extras, 'notes', NOW), ['T-0002']);
  });
});

// ---------------------------------------------------------------------------
// resolveCount
// ---------------------------------------------------------------------------

describe('resolveCount', () => {
  test("'all', missing and invalid values mean every available question", () => {
    for (const c of ['all', undefined, null, '', Infinity, NaN, 'abc']) {
      assert.equal(resolveCount(/** @type {any} */ (c), 12), 12, String(c));
    }
  });

  test('limits to the available number', () => {
    assert.equal(resolveCount(20, 12), 12);
    assert.equal(resolveCount(10, 12), 10);
    assert.equal(resolveCount(12, 12), 12);
  });

  test('rounds down and never goes below 0', () => {
    assert.equal(resolveCount(7.9, 12), 7);
    assert.equal(resolveCount(0, 12), 0);
    assert.equal(resolveCount(-3, 12), 0);
    assert.equal(resolveCount(-Infinity, 12), 0);
  });

  test('accepts numeric strings (from a URL query)', () => {
    assert.equal(resolveCount('5', 12), 5);
    assert.equal(resolveCount('40', 12), 12);
  });

  test('a bad available count counts as 0; fractions round down', () => {
    assert.equal(resolveCount(5, /** @type {any} */ (undefined)), 0);
    assert.equal(resolveCount(5, NaN), 0);
    assert.equal(resolveCount(5, -2), 0);
    assert.equal(resolveCount('all', 3.9), 3);
  });
});

// ---------------------------------------------------------------------------
// pickQids
// ---------------------------------------------------------------------------

const MANY = Array.from({ length: 30 }, (_, i) => `T-${String(i + 1).padStart(4, '0')}`);

describe('pickQids', () => {
  test("'sequential' keeps the filter order and takes the first ids", () => {
    assert.deepEqual(pickQids(MANY, { order: 'sequential' }), MANY);
    assert.deepEqual(pickQids(MANY, { order: 'sequential', count: 4 }), MANY.slice(0, 4));
    assert.deepEqual(pickQids(MANY, { order: 'sequential', count: 4, filter: 'due' }), MANY.slice(0, 4));
  });

  test("'random' (default) returns a permutation of every id when count is 'all'", () => {
    const out = pickQids(MANY, { seed: 42 });
    assert.equal(out.length, MANY.length);
    assert.deepEqual([...out].sort(), [...MANY].sort());
    assert.notDeepEqual(out, MANY);
  });

  test('the same seed gives the same result; different seeds differ', () => {
    for (const seed of [1, 42, 'seed-a', 0]) {
      assert.deepEqual(pickQids(MANY, { seed, count: 10 }), pickQids(MANY, { seed, count: 10 }), String(seed));
      assert.deepEqual(pickQids(MANY, { seed }), pickQids(MANY, { seed }), String(seed));
    }
    const results = new Set([1, 2, 3, 4, 5].map((seed) => pickQids(MANY, { seed, count: 10 }).join(',')));
    assert.ok(results.size > 1);
  });

  test('a limited random pick is a sample of unique input ids', () => {
    const out = pickQids(MANY, { seed: 7, count: 8 });
    assert.equal(out.length, 8);
    assert.equal(new Set(out).size, 8);
    for (const id of out) assert.ok(MANY.includes(id));
  });

  test('a limited random pick of a plain filter samples the whole list, not just the first ids', () => {
    const firstFive = new Set(MANY.slice(0, 5));
    const someOutside = [1, 2, 3, 4, 5, 6, 7, 8].some((seed) =>
      pickQids(MANY, { seed, count: 5, filter: 'all' }).some((id) => !firstFive.has(id)),
    );
    assert.ok(someOutside);
  });

  test("'due' and 'incorrect' keep their first (highest-priority) ids, shuffled", () => {
    for (const filter of /** @type {const} */ (['due', 'incorrect'])) {
      for (const seed of [1, 2, 3]) {
        const out = pickQids(MANY, { filter, seed, count: 6 });
        assert.deepEqual([...out].sort(), MANY.slice(0, 6).sort(), `${filter} seed ${seed}`);
      }
    }
  });

  test('count 0, an empty list or a non-array give no ids', () => {
    assert.deepEqual(pickQids(MANY, { count: 0, seed: 1 }), []);
    assert.deepEqual(pickQids([], { seed: 1 }), []);
    assert.deepEqual(pickQids(/** @type {any} */ (null)), []);
  });

  test('a count above the available number returns every id', () => {
    assert.equal(pickQids(MANY.slice(0, 3), { count: 20, seed: 9 }).length, 3);
  });

  test('never changes its input and returns a new array', () => {
    const input = MANY.slice();
    const out = pickQids(input, { order: 'sequential' });
    assert.notEqual(out, input);
    pickQids(input, { seed: 3, count: 5 });
    assert.deepEqual(input, MANY);
  });

  test('works without options (random order, every id)', () => {
    const out = pickQids(MANY);
    assert.deepEqual([...out].sort(), [...MANY].sort());
  });
});

// ---------------------------------------------------------------------------
// buildQuestionSet / countAvailable (stubbed fetch, synthetic bank)
// ---------------------------------------------------------------------------

/** The app folder; data.js resolves data paths against the same folder. */
const ROOT = new URL('../../', import.meta.url);
const realFetch = globalThis.fetch;

/** Served files by app-relative path. A value is a JSON-able object or a () => Response. @type {Record<string, any>} */
let routes = {};
/** App-relative paths fetched since the last reset. @type {string[]} */
let calls = [];

globalThis.fetch = async (url) => {
  const href = String(url);
  const rel = href.startsWith(ROOT.href) ? href.slice(ROOT.href.length) : href;
  calls.push(rel);
  if (!Object.hasOwn(routes, rel)) return new Response('Not found', { status: 404, statusText: 'Not Found' });
  const route = routes[rel];
  if (typeof route === 'function') return route();
  return new Response(JSON.stringify(route), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

/**
 * js/core/data.js (the same instance builder.js loads lazily). Imported on
 * first use, so the pure tests above never depend on it.
 * @type {typeof import('../../js/core/data.js') | null}
 */
let dataApi = null;

/** Imports data.js, forgets every loaded file and resets the fetch log. */
async function resetData() {
  dataApi ??= await import('../../js/core/data.js');
  dataApi.clearDataCache();
  calls = [];
}

after(() => {
  globalThis.fetch = realFetch;
  dataApi?.clearDataCache();
});

/**
 * A placeholder question (no medical content).
 * @param {string} id
 * @param {boolean} reviewed
 * @param {boolean} [demo]
 */
function bankQuestion(id, reviewed, demo = false) {
  const base = {
    id,
    version: 1,
    topic: 'Topic A',
    difficulty: 1,
    reviewed,
    stem: `Sample stem ${id}`,
    choices: [
      { id: 'a', text: 'Choice A text' },
      { id: 'b', text: 'Choice B text' },
      { id: 'c', text: 'Choice C text' },
      { id: 'd', text: 'Choice D text' },
    ],
    answer: 'a',
    explanation: [{ id: 'p1', type: 'p', text: 'Sample explanation text' }],
  };
  return demo ? { ...base, demo: true } : { ...base, source: [{ ref: 'Source A', loc: 'p. 1' }] };
}

/**
 * @param {number} n
 * @param {boolean} published
 * @param {number} count
 */
function chapterEntry(n, published, count) {
  const nn = String(n).padStart(2, '0');
  return {
    id: `ch${nn}`,
    number: n,
    part: 'p1',
    prefix: `CH${nn}`,
    title: `Chapter title ${nn}`,
    short: `Short ${nn}`,
    file: `data/ch${nn}.json`,
    page: n,
    published,
    count,
  };
}

const CH01_IDS = ['CH01-0001', 'CH01-0002'];
const CH02_IDS = ['CH02-0001', 'CH02-0002', 'CH02-0003', 'CH02-0004'];
const CH03_IDS = ['CH03-0001', 'CH03-0002'];
const DEMO_IDS = ['DEMO-0001', 'DEMO-0002', 'DEMO-0003'];

/**
 * Serves a bank: ch01 (never published here), ch02, ch03 and the demo.
 * ch02 has two reviewed questions (0002, 0004); everything else is unreviewed.
 * @param {{ published?: string[] }} [options] Ids of the published chapters
 *   (default: ch02 only; [] = demo mode). Chapters are listed out of number order on purpose.
 */
function serveBank({ published = ['ch02'] } = {}) {
  const pub = new Set(published);
  routes = {
    'data/index.json': {
      schemaVersion: 1,
      parts: [{ id: 'p1', number: 'I', title: 'Part one', volume: 1 }],
      chapters: [chapterEntry(3, pub.has('ch03'), 2), chapterEntry(1, pub.has('ch01'), 2), chapterEntry(2, pub.has('ch02'), 4)],
      demo: { id: 'demo', prefix: 'DEMO', title: 'Demo title', short: 'Demo', file: 'data/demo.json', count: 3 },
    },
    'data/ch01.json': { schemaVersion: 1, chapter: 'ch01', questions: CH01_IDS.map((id) => bankQuestion(id, false)) },
    'data/ch02.json': {
      schemaVersion: 1,
      chapter: 'ch02',
      questions: CH02_IDS.map((id, i) => bankQuestion(id, i % 2 === 1)),
    },
    'data/ch03.json': { schemaVersion: 1, chapter: 'ch03', questions: CH03_IDS.map((id) => bankQuestion(id, false)) },
    'data/demo.json': { schemaVersion: 1, chapter: 'demo', questions: DEMO_IDS.map((id) => bankQuestion(id, false, true)) },
  };
}

/** @param {string} rel */
const fetched = (rel) => calls.includes(rel);

/** Sequential order so results are in bank order. */
const SEQ = Object.freeze({ order: 'sequential' });

describe('buildQuestionSet / countAvailable: chapters', () => {
  beforeEach(async () => {
    await resetData();
    serveBank();
  });

  test("'all' means the published chapters only (no demo, no unpublished)", async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: 'all' }), CH02_IDS);
    assert.equal(await countAvailable({ chapters: 'all' }), 4);
    assert.equal(fetched('data/ch01.json'), false);
    assert.equal(fetched('data/ch03.json'), false);
    assert.equal(fetched('data/demo.json'), false);
  });

  test("missing chapters, null and no options at all mean 'all'", async () => {
    assert.deepEqual(await buildQuestionSet(SEQ), CH02_IDS);
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: /** @type {any} */ (null) }), CH02_IDS);
    assert.equal(await countAvailable(), 4);
    assert.deepEqual([...(await buildQuestionSet())].sort(), CH02_IDS);
  });

  test('includeDemo adds the demo after the published chapters', async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, includeDemo: true }), [...CH02_IDS, ...DEMO_IDS]);
    assert.equal(await countAvailable({ includeDemo: true }), 7);
    assert.equal(fetched('data/ch01.json'), false);
  });

  test('explicit unpublished or unknown ids are ignored and never fetched', async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: ['ch01'] }), []);
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: ['ch03', 'nope'] }), []);
    assert.equal(await countAvailable({ chapters: ['ch01', 'ch03'] }), 0);
    assert.equal(fetched('data/ch01.json'), false);
    assert.equal(fetched('data/ch03.json'), false);
  });

  test('an empty chapter list gives no questions', async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: [] }), []);
    assert.equal(await countAvailable({ chapters: [] }), 0);
  });

  test('explicit ids keep bank order (published chapters, then the demo); duplicates count once', async () => {
    const chapters = ['demo', 'ch01', 'ch02', 'zzz', 'ch02'];
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters }), [...CH02_IDS, ...DEMO_IDS]);
    assert.equal(await countAvailable({ chapters }), 7);
    assert.equal(fetched('data/ch01.json'), false);
  });

  test('the demo can be chosen explicitly outside demo mode', async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: ['demo'] }), DEMO_IDS);
    assert.equal(await countAvailable({ chapters: ['demo'] }), 3);
  });

  test('a single chapter id string works like a one-item list', async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: /** @type {any} */ ('ch02') }), CH02_IDS);
  });

  test('includeDemo does not widen an explicit chapter list', async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: ['ch02'], includeDemo: true }), CH02_IDS);
  });

  test('several published chapters load in chapter-number order', async () => {
    await resetData();
    serveBank({ published: ['ch02', 'ch03'] });
    assert.deepEqual(await buildQuestionSet(SEQ), [...CH02_IDS, ...CH03_IDS]);
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: ['ch03', 'ch02'] }), [...CH02_IDS, ...CH03_IDS]);
    assert.equal(fetched('data/ch01.json'), false);
  });
});

describe('buildQuestionSet / countAvailable: demo mode (nothing published)', () => {
  beforeEach(async () => {
    await resetData();
    serveBank({ published: [] });
  });

  test("'all' is the demo", async () => {
    assert.deepEqual(await buildQuestionSet(SEQ), DEMO_IDS);
    assert.equal(await countAvailable(), 3);
    assert.ok(!calls.some((rel) => /^data\/ch\d+\.json$/.test(rel)), `fetched: ${calls.join(', ')}`);
  });

  test('includeDemo does not add the demo twice', async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, includeDemo: true }), DEMO_IDS);
    assert.equal(await countAvailable({ includeDemo: true }), 3);
  });

  test('explicit chapter ids other than the demo give nothing', async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: ['ch01', 'ch02', 'ch03'] }), []);
    assert.deepEqual(await buildQuestionSet({ ...SEQ, chapters: ['ch02', 'demo'] }), DEMO_IDS);
    assert.ok(!calls.some((rel) => /^data\/ch\d+\.json$/.test(rel)), `fetched: ${calls.join(', ')}`);
  });
});

describe('buildQuestionSet / countAvailable: filter, count, order', () => {
  beforeEach(async () => {
    await resetData();
    serveBank();
  });

  test("'unreviewed' keeps reviewed === false", async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, filter: 'unreviewed' }), ['CH02-0001', 'CH02-0003']);
    assert.equal(await countAvailable({ filter: 'unreviewed' }), 2);
    assert.equal(await countAvailable({ filter: 'unreviewed', includeDemo: true }), 5);
  });

  test('count limits the set; sequential takes the first ids', async () => {
    assert.deepEqual(await buildQuestionSet({ ...SEQ, count: 2 }), CH02_IDS.slice(0, 2));
    assert.deepEqual(await buildQuestionSet({ ...SEQ, count: 'all' }), CH02_IDS);
    assert.deepEqual(await buildQuestionSet({ ...SEQ, count: 99 }), CH02_IDS);
    assert.deepEqual(await buildQuestionSet({ ...SEQ, count: 0 }), []);
  });

  test('random order is deterministic for a seed and samples the pool', async () => {
    const opts = { includeDemo: true, count: 4, seed: 'seed-a' };
    const a = await buildQuestionSet(opts);
    const b = await buildQuestionSet(opts);
    assert.deepEqual(a, b);
    assert.equal(a.length, 4);
    assert.equal(new Set(a).size, 4);
    for (const id of a) assert.ok([...CH02_IDS, ...DEMO_IDS].includes(id));
    const all = await buildQuestionSet({ includeDemo: true, seed: 5 });
    assert.deepEqual([...all].sort(), [...CH02_IDS, ...DEMO_IDS].sort());
  });

  test('matches pickQids over the same pool and seed', async () => {
    const seed = 1234;
    const out = await buildQuestionSet({ includeDemo: true, count: 5, seed });
    assert.deepEqual(out, pickQids([...CH02_IDS, ...DEMO_IDS], { filter: 'all', count: 5, order: 'random', seed }));
  });

  test('an unknown order falls back to random', async () => {
    const seed = 77;
    const out = await buildQuestionSet({ order: /** @type {any} */ ('shuffled'), seed });
    assert.deepEqual(out, await buildQuestionSet({ order: 'random', seed }));
  });

  test('an unknown filter rejects with a RangeError', async () => {
    await assert.rejects(buildQuestionSet({ filter: /** @type {any} */ ('bogus') }), RangeError);
    await assert.rejects(countAvailable({ filter: /** @type {any} */ ('bogus') }), RangeError);
  });
});

describe('buildQuestionSet / countAvailable: load failures', () => {
  beforeEach(async () => {
    await resetData();
    serveBank();
  });

  test('a chapter that fails to load rejects with a DataError, and a later call retries', async () => {
    routes['data/ch02.json'] = () => new Response('Server error', { status: 500, statusText: 'Server Error' });
    await assert.rejects(buildQuestionSet(SEQ), (err) => {
      assert.ok(err instanceof dataApi.DataError);
      assert.equal(err.code, 'http');
      assert.ok(err.message.length > 0);
      return true;
    });
    serveBank();
    assert.deepEqual(await buildQuestionSet(SEQ), CH02_IDS);
  });

  test('a damaged chapter file rejects with a DataError', async () => {
    routes['data/ch02.json'] = () => new Response('{ not json', { status: 200 });
    await assert.rejects(countAvailable(), (err) => err instanceof dataApi.DataError && err.code === 'parse');
  });

  test('a missing index rejects with a DataError', async () => {
    delete routes['data/index.json'];
    await assert.rejects(buildQuestionSet(), (err) => err instanceof dataApi.DataError && err.code === 'not-found');
  });
});
