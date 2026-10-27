// Unit tests for the pure parts of js/core/store/db.js and js/core/store/repo.js:
// migration list shape, the v2 migration on a mock database (additive only),
// schema ↔ ALL_STORES, the ink keep rule, media input checks and import preparation.
// Run: node --test tests/unit/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DB_VERSION, SCHEMA, migrations } from '../../js/core/store/db.js';
import { ALL_STORES, MEDIA_MAX_BYTES, checkMediaInput, importable, inkHasContent } from '../../js/core/store/repo.js';

/** Minimal mock of IDBDatabase / IDBTransaction for running migrations. */
function mockDb(existing = {}) {
  const stores = new Map();
  const log = [];
  const makeStore = (name, options, indexes = []) => {
    const idx = new Set(indexes);
    const store = {
      name,
      options,
      indexNames: { contains: (n) => idx.has(n) },
      createIndex(n, keyPath, opts) {
        log.push(['createIndex', name, n, keyPath, opts.unique]);
        idx.add(n);
      },
      indexes: idx,
    };
    stores.set(name, store);
    return store;
  };
  for (const [name, { options, indexes }] of Object.entries(existing)) makeStore(name, options, indexes);
  const db = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore(name, options) {
      log.push(['createObjectStore', name, options]);
      return makeStore(name, options);
    },
    deleteObjectStore(name) {
      log.push(['deleteObjectStore', name]);
      stores.delete(name);
    },
  };
  const tx = { objectStore: (n) => stores.get(n) };
  return { db, tx, stores, log };
}

/** Runs migrations (oldVersion, newVersion] like db.js does. */
function migrate(mock, oldVersion, newVersion = DB_VERSION) {
  for (let v = oldVersion + 1; v <= newVersion; v++) migrations[v]?.(mock.db, mock.tx, oldVersion);
}

describe('db migrations', () => {
  test('one migration per version, index 0 unused, v2 is current', () => {
    assert.equal(DB_VERSION, 2);
    assert.equal(migrations.length, DB_VERSION + 1);
    assert.equal(migrations[0], null);
    for (let v = 1; v <= DB_VERSION; v++) assert.equal(typeof migrations[v], 'function', `v${v}`);
  });

  test('fresh install creates exactly the current SCHEMA', () => {
    const mock = mockDb();
    migrate(mock, 0);
    assert.deepEqual([...mock.stores.keys()].sort(), Object.keys(SCHEMA).sort());
    for (const [name, def] of Object.entries(SCHEMA)) {
      const store = mock.stores.get(name);
      assert.equal(store.options.keyPath, def.keyPath, name);
      assert.equal(Boolean(store.options.autoIncrement), Boolean(def.autoIncrement), name);
      assert.deepEqual([...store.indexes].sort(), [...def.indexes].sort(), name);
    }
  });

  test('v1 → v2 only adds the media store (qid, ts indexes) and never deletes', () => {
    const v1 = mockDb();
    migrate(v1, 0, 1);
    const before = [...v1.stores.keys()].sort();
    assert.equal(before.includes('media'), false);
    v1.log.length = 0;
    migrate(v1, 1);
    assert.deepEqual(v1.log, [
      ['createObjectStore', 'media', { keyPath: 'id' }],
      ['createIndex', 'media', 'qid', 'qid', false],
      ['createIndex', 'media', 'ts', 'ts', false],
    ]);
    assert.deepEqual([...v1.stores.keys()].sort(), [...before, 'media'].sort());
  });

  test('migrations are idempotent (re-running changes nothing)', () => {
    const mock = mockDb();
    migrate(mock, 0);
    mock.log.length = 0;
    migrate(mock, 0);
    assert.deepEqual(mock.log, []);
  });

  test('ALL_STORES matches SCHEMA and ends with media', () => {
    assert.deepEqual([...ALL_STORES].sort(), Object.keys(SCHEMA).sort());
    assert.equal(ALL_STORES.at(-1), 'media');
    assert.deepEqual(SCHEMA.media, { keyPath: 'id', indexes: ['qid', 'ts'] });
  });
});

describe('inkHasContent (inkRepo.set keep rule)', () => {
  const stroke = { tool: 'pen', color: '#000000', size: 0.01, pts: [0, 0, 0.5] };
  test('keeps when strokes OR scene items are non-empty', () => {
    assert.equal(inkHasContent({ strokes: [stroke] }), true);
    assert.equal(inkHasContent({ strokes: [], scene: { v: 2, page: {}, items: [{ id: 'a', type: 'text' }] } }), true);
    assert.equal(inkHasContent({ scene: { items: [{}] } }), true);
  });
  test('deletes only when both are empty or missing', () => {
    assert.equal(inkHasContent({ strokes: [], scene: { items: [] } }), false);
    assert.equal(inkHasContent({ strokes: [] }), false);
    assert.equal(inkHasContent({ scene: null }), false);
    assert.equal(inkHasContent({ strokes: 'x', scene: { items: 'y' } }), false);
    assert.equal(inkHasContent(null), false);
    assert.equal(inkHasContent(undefined), false);
  });
});

describe('checkMediaInput (mediaRepo.add validation)', () => {
  const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
  test('normalises a valid image', () => {
    assert.deepEqual(checkMediaInput({ qid: 'Q', blob: png, width: 10.4, height: '20' }), {
      qid: 'Q',
      blob: png,
      mime: 'image/png',
      width: 10,
      height: 20,
      bytes: 4,
    });
    assert.equal(checkMediaInput({ qid: 'Q', blob: new Blob(['x']), mime: 'image/webp', width: 1, height: 1 }).mime, 'image/webp');
  });
  test('rejects bad input', () => {
    assert.throws(() => checkMediaInput(null), TypeError);
    assert.throws(() => checkMediaInput({ blob: png, width: 1, height: 1 }), /qid/);
    assert.throws(() => checkMediaInput({ qid: 'Q', blob: 'data', width: 1, height: 1 }), /blob/);
    assert.throws(() => checkMediaInput({ qid: 'Q', blob: new Blob(['x'], { type: 'audio/webm' }), width: 1, height: 1 }), /mime/);
    assert.throws(() => checkMediaInput({ qid: 'Q', blob: new Blob([]), mime: 'image/png', width: 1, height: 1 }), /empty/);
    assert.throws(() => checkMediaInput({ qid: 'Q', blob: png, width: 0, height: 1 }), /width/);
    const huge = { size: MEDIA_MAX_BYTES + 1, type: 'image/png', arrayBuffer: async () => new ArrayBuffer(0) };
    assert.throws(() => checkMediaInput({ qid: 'Q', blob: huge, width: 1, height: 1 }), RangeError);
  });
});

describe('importable (records a backup may write)', () => {
  test('ink: scene-only scratchpad records are kept; strokes default to []', () => {
    const rec = importable('ink', { id: 'Q|scratch', qid: 'Q', block: 'scratch', scene: { v: 2, page: {}, items: [{ id: 'a', type: 'text' }] } });
    assert.ok(rec);
    assert.deepEqual(rec.strokes, []);
    assert.equal(importable('ink', { id: 'Q|stem', qid: 'Q', block: 'stem', strokes: [] }), null);
  });
  test('media: needs a qid and a Blob; bytes and mime are derived', () => {
    const rec = importable('media', { id: 'm', qid: 'Q', blob: new Blob(['abc'], { type: 'image/jpeg' }), mime: 'nope', bytes: 99 });
    assert.equal(rec.bytes, 3);
    assert.equal(rec.mime, 'image/jpeg');
    assert.equal(rec.ts, 0);
    assert.equal(importable('media', { id: 'm', qid: 'Q', blob: null, data: 'AAAA' }), null);
    assert.equal(importable('media', { id: 'm', blob: new Blob(['a']) }), null);
    assert.equal(importable('media', { qid: 'Q', blob: new Blob(['a']) }), null);
  });
});
