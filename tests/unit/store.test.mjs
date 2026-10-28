// Unit tests for the pure parts of js/core/store/db.js and js/core/store/repo.js:
// migration list shape, the v2 and v3 migrations on a mock database (additive only),
// schema ↔ ALL_STORES, the ink keep rule, media and book input checks, the PDF note
// keep rule and import preparation.
// Run: node --test tests/unit/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DB_VERSION, SCHEMA, migrations } from '../../js/core/store/db.js';
import {
  ALL_STORES,
  BOOK_MAX_BYTES,
  MEDIA_MAX_BYTES,
  PDF_HEADER_WINDOW,
  checkBookInput,
  checkMediaInput,
  hasPdfMagic,
  importable,
  inkHasContent,
  isBookId,
  isPdfBlob,
  isPdfType,
  pdfNoteHasContent,
  pdfNoteId,
} from '../../js/core/store/repo.js';

/** Stores that exist in IndexedDB but are not listed in ALL_STORES (joined into `books`). */
const INTERNAL_STORES = ['bookfiles'];

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
  test('one migration per version, index 0 unused, v3 is current', () => {
    assert.equal(DB_VERSION, 3);
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
    migrate(v1, 1, 2);
    assert.deepEqual(v1.log, [
      ['createObjectStore', 'media', { keyPath: 'id' }],
      ['createIndex', 'media', 'qid', 'qid', false],
      ['createIndex', 'media', 'ts', 'ts', false],
    ]);
    assert.deepEqual([...v1.stores.keys()].sort(), [...before, 'media'].sort());
  });

  test('v2 → v3 only adds books (updated), bookfiles and pdfnotes (bookId); never deletes', () => {
    const v2 = mockDb();
    migrate(v2, 0, 2);
    const before = [...v2.stores.keys()].sort();
    assert.deepEqual(before, ['attempts', 'highlights', 'ink', 'media', 'notes', 'qstate', 'reports', 'reviews', 'sessions', 'settings', 'voice']);
    v2.log.length = 0;
    migrate(v2, 2);
    assert.deepEqual(v2.log, [
      ['createObjectStore', 'books', { keyPath: 'id' }],
      ['createIndex', 'books', 'updated', 'updated', false],
      ['createObjectStore', 'bookfiles', { keyPath: 'id' }],
      ['createObjectStore', 'pdfnotes', { keyPath: 'id' }],
      ['createIndex', 'pdfnotes', 'bookId', 'bookId', false],
    ]);
    assert.deepEqual([...v2.stores.keys()].sort(), [...before, 'bookfiles', 'books', 'pdfnotes'].sort());
    assert.equal(v2.log.some(([op]) => op === 'deleteObjectStore'), false);
  });

  test('v1 → v3 in one upgrade runs v2 and v3 (fresh-enough schema)', () => {
    const v1 = mockDb();
    migrate(v1, 0, 1);
    migrate(v1, 1);
    assert.deepEqual([...v1.stores.keys()].sort(), Object.keys(SCHEMA).sort());
  });

  test('migrations are idempotent (re-running changes nothing)', () => {
    const mock = mockDb();
    migrate(mock, 0);
    mock.log.length = 0;
    migrate(mock, 0);
    assert.deepEqual(mock.log, []);
  });

  test('ALL_STORES + internal stores match SCHEMA; books and pdfnotes come last', () => {
    assert.deepEqual([...ALL_STORES, ...INTERNAL_STORES].sort(), Object.keys(SCHEMA).sort());
    for (const name of INTERNAL_STORES) assert.equal(ALL_STORES.includes(name), false, name);
    assert.deepEqual(ALL_STORES.slice(-3), ['media', 'books', 'pdfnotes']);
    assert.deepEqual(SCHEMA.media, { keyPath: 'id', indexes: ['qid', 'ts'] });
    assert.deepEqual(SCHEMA.books, { keyPath: 'id', indexes: ['updated'] });
    assert.deepEqual(SCHEMA.bookfiles, { keyPath: 'id', indexes: [] });
    assert.deepEqual(SCHEMA.pdfnotes, { keyPath: 'id', indexes: ['bookId'] });
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

describe('book input checks (bookRepo.put validation)', () => {
  const bytes = (text) => new TextEncoder().encode(text);
  const pdf = (text = '%PDF-1.7\nbody', type = 'application/pdf') => new Blob([text], { type });

  test('hasPdfMagic finds "%PDF-" within the first 1024 bytes only', () => {
    assert.equal(hasPdfMagic(bytes('%PDF-1.4')), true);
    assert.equal(hasPdfMagic(bytes('junk\r\n%PDF-2.0')), true);
    assert.equal(hasPdfMagic(bytes(`${' '.repeat(PDF_HEADER_WINDOW - 5)}%PDF-`)), true);
    assert.equal(hasPdfMagic(bytes(`${' '.repeat(PDF_HEADER_WINDOW - 4)}%PDF-`)), false);
    assert.equal(hasPdfMagic(bytes('%PDF')), false);
    assert.equal(hasPdfMagic(bytes('%pdf-1.4')), false);
    assert.equal(hasPdfMagic(new Uint8Array(0)), false);
    assert.equal(hasPdfMagic(null), false);
  });

  test('isPdfType accepts PDF MIME types only', () => {
    assert.equal(isPdfType('application/pdf'), true);
    assert.equal(isPdfType('Application/PDF; charset=binary'), true);
    assert.equal(isPdfType('application/x-pdf'), true);
    assert.equal(isPdfType('image/png'), false);
    assert.equal(isPdfType(''), false);
    assert.equal(isPdfType(undefined), false);
  });

  test('isPdfBlob: header wins; otherwise the declared type decides', async () => {
    assert.equal(await isPdfBlob(pdf('%PDF-1.7', '')), true);
    assert.equal(await isPdfBlob(pdf('%PDF-1.7', 'application/octet-stream')), true);
    assert.equal(await isPdfBlob(pdf('no header', 'application/pdf')), true);
    assert.equal(await isPdfBlob(pdf('no header', 'text/plain')), false);
    assert.equal(await isPdfBlob(pdf('no header', '')), false);
    const unreadable = { size: 10, type: 'application/pdf', slice: () => ({ arrayBuffer: async () => { throw new Error('gone'); } }), arrayBuffer: async () => { throw new Error('gone'); } };
    assert.equal(await isPdfBlob(unreadable), true);
    assert.equal(await isPdfBlob({ ...unreadable, type: '' }), false);
    assert.equal(await isPdfBlob('not a blob'), false);
    assert.equal(await isPdfBlob(null), false);
  });

  test('isBookId: chapter-like ids only (no "|" or ":")', () => {
    for (const id of ['ch01', 'ch55', 'demo', 'ch-1_x']) assert.equal(isBookId(id), true, id);
    for (const id of ['', 'ch|1', 'book:ch01', 'a b', 'x'.repeat(41), 1, null]) assert.equal(isBookId(id), false, String(id));
  });

  test('checkBookInput normalises metadata and keeps the blob', async () => {
    const blob = pdf();
    const { meta, blob: out } = await checkBookInput(
      { id: 'ch01', blob, title: '  Anatomy \n and  Dimensions ', fileName: ' Chapter-01.pdf ', pages: 27, lastPage: 40, lastScale: 1.23456 },
      1000,
    );
    assert.equal(out, blob);
    assert.deepEqual(meta, {
      id: 'ch01',
      title: 'Anatomy and Dimensions',
      fileName: 'Chapter-01.pdf',
      bytes: blob.size,
      pages: 27,
      added: 1000,
      updated: 1000,
      lastPage: 27,
      lastScale: 1.235,
    });
    assert.equal('blob' in meta, false, 'metadata never carries the blob');
  });

  test('checkBookInput defaults: page 1, scale null, pages null, added kept', async () => {
    const { meta } = await checkBookInput({ id: 'ch02', blob: pdf(), pages: 0, lastPage: -3, lastScale: 'zoom', added: 5 }, 9);
    assert.equal(meta.pages, null);
    assert.equal(meta.lastPage, 1);
    assert.equal(meta.lastScale, null);
    assert.equal(meta.added, 5);
    assert.equal(meta.updated, 9);
    assert.equal(meta.title, '');
    assert.equal(meta.fileName, '');
    for (const named of ['fit-width', 'fit-page']) {
      assert.equal((await checkBookInput({ id: 'ch02', blob: pdf(), lastScale: named })).meta.lastScale, named);
    }
    assert.equal((await checkBookInput({ id: 'ch02', blob: pdf(), lastScale: 99 })).meta.lastScale, 20);
    assert.equal((await checkBookInput({ id: 'ch02', blob: pdf(), lastPage: 500 })).meta.lastPage, 500, 'no clamp without a page count');
  });

  test('checkBookInput rejects bad input with plain-language errors', async () => {
    await assert.rejects(checkBookInput(null), TypeError);
    await assert.rejects(checkBookInput({ id: 'ch|1', blob: pdf() }), /chapter id/);
    await assert.rejects(checkBookInput({ id: 'ch01', blob: 'x' }), (e) => e instanceof TypeError && e.code === 'bad-input' && /choose it again/.test(e.userMessage));
    await assert.rejects(checkBookInput({ id: 'ch01', blob: new Blob([], { type: 'application/pdf' }) }), (e) => e.code === 'empty');
    await assert.rejects(checkBookInput({ id: 'ch01', blob: pdf('hello', 'text/plain') }), (e) => e instanceof TypeError && e.code === 'not-pdf' && e.userMessage === e.message);
    const huge = { size: BOOK_MAX_BYTES + 1, type: 'application/pdf', slice: () => pdf(), arrayBuffer: async () => new ArrayBuffer(0) };
    await assert.rejects(checkBookInput({ id: 'ch01', blob: huge }), (e) => e instanceof RangeError && e.code === 'too-large' && /300 MB/.test(e.message));
    const max = { ...huge, size: BOOK_MAX_BYTES };
    assert.equal((await checkBookInput({ id: 'ch01', blob: max })).meta.bytes, BOOK_MAX_BYTES);
  });
});

describe('PDF notes keep rule and ids', () => {
  test('pdfNoteId', () => {
    assert.equal(pdfNoteId('ch01', 3), 'ch01|3');
  });
  test('kept while there are scene items OR highlights', () => {
    assert.equal(pdfNoteHasContent({ scene: { items: [{ id: 'a' }] }, highlights: [] }), true);
    assert.equal(pdfNoteHasContent({ scene: null, highlights: [{ id: 'h' }] }), true);
    assert.equal(pdfNoteHasContent({ scene: { items: [] }, highlights: [] }), false);
    assert.equal(pdfNoteHasContent({ scene: null }), false);
    assert.equal(pdfNoteHasContent({ highlights: 'x', scene: { items: 'y' } }), false);
    assert.equal(pdfNoteHasContent(null), false);
  });
});

describe('importable: books and pdfnotes', () => {
  const pdf = new Blob(['%PDF-1.7'], { type: 'application/pdf' });

  test('books: needs a chapter id and a non-empty PDF blob; metadata normalised, updated kept', () => {
    const rec = importable('books', { id: 'ch01', blob: pdf, bytes: 999, pages: 27, lastPage: 30, updated: 77, extra: 1 });
    assert.equal(rec.blob, pdf);
    assert.equal(rec.bytes, pdf.size);
    assert.equal(rec.lastPage, 27);
    assert.equal(rec.updated, 77);
    assert.equal(rec.added, 77);
    assert.equal('extra' in rec, false);
    assert.equal(importable('books', { id: 'ch01', blob: pdf }).updated, 0);
    assert.ok(importable('books', { id: 'ch01', blob: new Blob(['%PDF-'], { type: '' }) }), 'untyped blob is accepted');
    assert.equal(importable('books', { id: 'ch01', blob: new Blob(['x'], { type: 'image/png' }) }), null);
    assert.equal(importable('books', { id: 'ch01', blob: new Blob([], { type: 'application/pdf' }) }), null);
    assert.equal(importable('books', { id: 'ch01', blob: null, data: 'JVBERi0=' }), null);
    assert.equal(importable('books', { id: 'a|b', blob: pdf }), null);
    assert.equal(importable('books', { blob: pdf }), null);
  });

  test('pdfnotes: id re-derived from bookId and page; empty pages skipped', () => {
    const rec = importable('pdfnotes', { id: 'wrong', bookId: 'ch01', page: 4, highlights: [{ id: 'h' }] });
    assert.equal(rec.id, 'ch01|4');
    assert.equal(rec.scene, null);
    assert.equal(rec.updated, 0);
    assert.ok(importable('pdfnotes', { id: 'x', bookId: 'ch01', page: 1, scene: { items: [{ id: 'a' }] } }).highlights.length === 0);
    assert.equal(importable('pdfnotes', { id: 'x', bookId: 'ch01', page: 1, scene: { items: [] }, highlights: [] }), null);
    assert.equal(importable('pdfnotes', { id: 'x', bookId: 'ch01', page: 0, highlights: [{}] }), null);
    assert.equal(importable('pdfnotes', { id: 'x', bookId: 'ch01', page: 1.5, highlights: [{}] }), null);
    assert.equal(importable('pdfnotes', { id: 'x', bookId: 'c|1', page: 1, highlights: [{}] }), null);
    assert.equal(importable('pdfnotes', { bookId: 'ch01', page: 1, highlights: [{}] }), null, 'needs a key');
  });
});
