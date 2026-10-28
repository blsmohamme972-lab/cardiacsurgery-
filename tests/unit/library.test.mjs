// Unit tests for js/features/book/library.js: file name → chapter matching (many real-world
// shapes, and the names that must never match), book page ↔ PDF page, sizes, the
// data/book.json loader/normaliser, the storage estimate and the import paths that need no
// IndexedDB (unmatched, duplicate, invalid chapter choice).
// Run: node --test tests/unit/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAPTER_COUNT,
  bookPageFor,
  formatBytes,
  importPdfFiles,
  loadBookData,
  matchChapter,
  normalizeBookData,
  pdfPageFor,
  storageEstimate,
  undoImport,
} from '../../js/features/book/library.js';

// Expected warnings (no IndexedDB in Node, failed fixture fetches) stay quiet.
console.warn = () => {};

/** Neutral fixture chapters (numbers 1–6; titles are placeholders, not book content). */
const CHAPTERS = [
  { id: 'ch01', number: 1, title: 'Alpha Topic' },
  { id: 'ch02', number: 2, title: 'Beta Topic' },
  { id: 'ch03', number: 3, title: 'Gamma Topic Overview' },
  { id: 'ch04', number: 4, title: 'Advanced Gamma Topic Overview' },
  { id: 'ch05', number: 5, title: 'Delta & Epsilon' },
  { id: 'ch06', number: 6, title: 'Zeta Topic' },
];

describe('matchChapter: recognised names', () => {
  const cases = [
    ['Chapter-01-Anatomy-and-Dimensions.pdf', 'ch01'],
    ['Chapter-02-Hypothermia-Circulatory-Arrest-CPB.pdf', 'ch02'],
    ['9a47a464-Chapter-01-Anatomy-and-Dimensions.pdf', 'ch01'],
    ['99ff6cbb-Chapter-02-Something.pdf', 'ch02'],
    ['20261028-Chapter-12.pdf', 'ch12'],
    ['Chapter 1 Something.pdf', 'ch01'],
    ['Chapter 1.pdf', 'ch01'],
    ['chapter 9', 'ch09'],
    ['CHAPTER 55.PDF', 'ch55'],
    ['Chapter_33_Topic.pdf', 'ch33'],
    ['chapter-012.pdf', 'ch12'],
    ['Chapter12.pdf', 'ch12'],
    ['Chapter #7.pdf', 'ch07'],
    ['Chapter No. 8.pdf', 'ch08'],
    ['Chapter: 4.pdf', 'ch04'],
    ['Chapter 1.2 subsection.pdf', 'ch01'],
    ['Chapter 3 (1).pdf', 'ch03'],
    ['Chap. 3.pdf', 'ch03'],
    ['chap3.pdf', 'ch03'],
    ['Ch.12 Topic.pdf', 'ch12'],
    ['Ch 5.pdf', 'ch05'],
    ['ch01.pdf', 'ch01'],
    ['CH1.PDF', 'ch01'],
    ['Book_ch05.pdf', 'ch05'],
    ['Book-CH-22.pdf', 'ch22'],
    ['Kirklin 2013 Chapter 9.pdf', 'ch09'],
    ['Part 2 Chapter 9.pdf', 'ch09'],
    ['Vol 2 - Chapter 33.pdf', 'ch33'],
    ['01 - Anatomy.pdf', 'ch01'],
    ['01 – Anatomy.pdf', 'ch01'],
    ['01_Anatomy.pdf', 'ch01'],
    ['05_Topic.pdf', 'ch05'],
    ['1.pdf', 'ch01'],
    ['01.pdf', 'ch01'],
    ['55.pdf', 'ch55'],
    ['1. Intro.pdf', 'ch01'],
    ['3) Topic.pdf', 'ch03'],
    ['[4] Topic.pdf', null],
    ['7 Topic name.pdf', 'ch07'],
    ['  12  - spaced.pdf', 'ch12'],
    ['C:\\fakepath\\Chapter 7.pdf', 'ch07'],
    ['folder/sub/ch08.pdf', 'ch08'],
    ['Ｃｈａｐｔｅｒ ２.pdf', 'ch02'],
  ];
  for (const [name, expected] of cases) {
    test(`${JSON.stringify(name)} → ${expected}`, () => assert.equal(matchChapter(name), expected));
  }
});

describe('matchChapter: never a page count, size, year, decimal or unrelated word', () => {
  const nulls = [
    '27 pages.pdf',
    '27 Pages.pdf',
    '3 pp.pdf',
    '12 p.pdf',
    '2019.pdf',
    '2019 notes.pdf',
    'Notes 2019.pdf',
    '1999 Topic.pdf',
    '1.5 notes.pdf',
    '2 MB.pdf',
    'Book 2 MB.pdf',
    '50% done.pdf',
    '3D heart.pdf',
    '1st edition.pdf',
    '4th ed.pdf',
    '2 years.pdf',
    'Research 12.pdf',
    'Batch 3.pdf',
    'Approach 05.pdf',
    'Tech 5.pdf',
    'Chapter 56.pdf',
    'Chapter 0.pdf',
    'Chapter 100.pdf',
    'Chapter 2019.pdf',
    'ch 2 pages.pdf',
    'Chapter 5 and Chapter 6.pdf',
    'ch3-ch4.pdf',
    '0.pdf',
    '00.pdf',
    '123.pdf',
    '99.pdf',
    'Topic.pdf',
    'Chapters 1-3.pdf',
    'Volume 2.pdf',
    '.pdf',
    '',
    null,
    undefined,
    42,
  ];
  for (const name of nulls) {
    test(`${JSON.stringify(name)} → null`, () => assert.equal(matchChapter(name), null));
  }

  test('the same chapter named twice is not ambiguous', () => {
    assert.equal(matchChapter('Chapter 4 - ch04 copy.pdf'), 'ch04');
  });

  test('a number glued to letters inside a hash prefix is ignored', () => {
    assert.equal(matchChapter('9a47a464-Topic.pdf'), null);
    assert.equal(matchChapter('12345678-Topic.pdf'), null);
  });

  test(`numbers 1–${CHAPTER_COUNT} map to zero-padded ids`, () => {
    for (let n = 1; n <= CHAPTER_COUNT; n++) {
      const id = `ch${String(n).padStart(2, '0')}`;
      assert.equal(matchChapter(`Chapter ${n}.pdf`), id);
      assert.equal(matchChapter(`ch${String(n).padStart(2, '0')}.pdf`), id);
      assert.equal(matchChapter(`${n}.pdf`), id);
    }
  });
});

describe('matchChapter with a chapter list', () => {
  test('only listed numbers are valid', () => {
    assert.equal(matchChapter('Chapter 6.pdf', { chapters: CHAPTERS }), 'ch06');
    assert.equal(matchChapter('Chapter 7.pdf', { chapters: CHAPTERS }), null);
    assert.equal(matchChapter('Chapter 7.pdf'), 'ch07');
  });

  test('a name without a number may match a whole title (longest wins)', () => {
    assert.equal(matchChapter('Alpha Topic.pdf', { chapters: CHAPTERS }), 'ch01');
    assert.equal(matchChapter('alpha-topic.pdf', { chapters: CHAPTERS }), 'ch01');
    assert.equal(matchChapter('My notes - BETA_TOPIC (final).pdf', { chapters: CHAPTERS }), 'ch02');
    assert.equal(matchChapter('Gamma Topic Overview.pdf', { chapters: CHAPTERS }), 'ch03');
    assert.equal(matchChapter('Advanced Gamma Topic Overview.pdf', { chapters: CHAPTERS }), 'ch04');
    assert.equal(matchChapter('Delta and Epsilon.pdf', { chapters: CHAPTERS }), 'ch05');
    assert.equal(matchChapter('Delta & Epsilon.pdf', { chapters: CHAPTERS }), 'ch05');
  });

  test('partial titles, ties and missing titles never match', () => {
    assert.equal(matchChapter('Alpha.pdf', { chapters: CHAPTERS }), null);
    assert.equal(matchChapter('Topic.pdf', { chapters: CHAPTERS }), null);
    assert.equal(matchChapter('Alphabet Topical.pdf', { chapters: CHAPTERS }), null);
    const twins = [
      { id: 'ch01', number: 1, title: 'Same Name' },
      { id: 'ch02', number: 2, title: 'Same Name' },
    ];
    assert.equal(matchChapter('Same Name.pdf', { chapters: twins }), null);
    assert.equal(matchChapter('Alpha Topic.pdf', { chapters: [{ id: 'ch01', number: 1 }] }), null);
  });

  test('a number beats a title', () => {
    assert.equal(matchChapter('Chapter 2 Alpha Topic.pdf', { chapters: CHAPTERS }), 'ch02');
  });

  test('malformed chapter entries are ignored', () => {
    assert.equal(matchChapter('Chapter 1.pdf', { chapters: [null, { id: 'ch01' }, { number: 1 }] }), null);
    assert.equal(matchChapter('Chapter 1.pdf', { chapters: null }), 'ch01');
  });
});

describe('book page ↔ PDF page', () => {
  test('PDF page = book page − firstPage + 1 and back', () => {
    assert.equal(pdfPageFor(28, 28), 1);
    assert.equal(pdfPageFor(40, 28), 13);
    assert.equal(bookPageFor(13, 28), 40);
    assert.equal(bookPageFor(1, 1), 1);
    for (let p = 1; p < 60; p++) assert.equal(pdfPageFor(bookPageFor(p, 105), 105), p);
  });
  test('never below page 1; junk input is safe', () => {
    assert.equal(pdfPageFor(10, 28), 1);
    assert.equal(pdfPageFor('x', 28), 1);
    assert.equal(bookPageFor('x', 28), 1);
  });
});

describe('formatBytes', () => {
  test('KB, MB, GB with one decimal under 100', () => {
    assert.equal(formatBytes(0), '0 KB');
    assert.equal(formatBytes(-5), '0 KB');
    assert.equal(formatBytes(NaN), '0 KB');
    assert.equal(formatBytes(1), '1 KB');
    assert.equal(formatBytes(1024), '1 KB');
    assert.equal(formatBytes(820 * 1024), '820 KB');
    assert.equal(formatBytes(1.7 * 1024 * 1024), '1.7 MB');
    assert.equal(formatBytes(16.24 * 1024 * 1024), '16.2 MB');
    assert.equal(formatBytes(300 * 1024 * 1024), '300 MB');
    assert.equal(formatBytes(1.1 * 1024 ** 3), '1.1 GB');
  });
});

describe('data/book.json loading', () => {
  test('normalizeBookData keeps well-formed entries only', () => {
    const out = normalizeBookData({
      schemaVersion: 1,
      chapters: {
        ch01: { firstPage: 1, sections: [{ title: ' Part A ', page: 2, level: 1 }, { title: 'Sub', page: 3, level: 2 }, { title: '', page: 4, level: 1 }, { title: 'x', page: 0, level: 1 }] },
        ch02: { firstPage: 28, sections: 'nope', file: 'books/ch02.pdf' },
        ch03: { firstPage: 0, sections: [] },
        ch04: { firstPage: 9, sections: [], file: '../secret.pdf' },
        ch05: { firstPage: 9, sections: [], file: '/abs.pdf' },
        bad: { firstPage: 1, sections: [] },
        ch06: null,
      },
    });
    assert.deepEqual(out, {
      schemaVersion: 1,
      chapters: {
        ch01: { firstPage: 1, sections: [{ title: 'Part A', page: 2, level: 1 }, { title: 'Sub', page: 3, level: 2 }] },
        ch02: { firstPage: 28, sections: [], file: 'books/ch02.pdf' },
        ch04: { firstPage: 9, sections: [] },
        ch05: { firstPage: 9, sections: [] },
      },
    });
    assert.deepEqual(normalizeBookData(null), { schemaVersion: 1, chapters: {} });
    assert.deepEqual(normalizeBookData({ chapters: [] }), { schemaVersion: 1, chapters: {} });
  });

  test('loadBookData uses the given fetch and normalises', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ schemaVersion: 1, chapters: { ch01: { firstPage: 1, sections: [] } } }) };
    };
    const data = await loadBookData({ fetchImpl, url: 'data/book.json' });
    assert.deepEqual(data, { schemaVersion: 1, chapters: { ch01: { firstPage: 1, sections: [] } } });
    assert.deepEqual(calls, ['data/book.json']);
  });

  test('loadBookData never rejects (HTTP error, bad JSON, network)', async () => {
    const empty = { schemaVersion: 1, chapters: {} };
    assert.deepEqual(await loadBookData({ fetchImpl: async () => ({ ok: false, status: 404 }), url: 'x' }), empty);
    assert.deepEqual(await loadBookData({ fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }), url: 'x' }), empty);
    assert.deepEqual(await loadBookData({ fetchImpl: async () => { throw new TypeError('offline'); }, url: 'x' }), empty);
  });

  test('the default URL points at data/book.json next to index.html', async () => {
    let seen = '';
    await loadBookData({ fetchImpl: async (u) => { seen = u; return { ok: false, status: 500 }; } });
    assert.match(seen, /\/data\/book\.json$/);
    assert.doesNotMatch(seen, /\/js\//);
  });
});

describe('storageEstimate', () => {
  const realNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const withNavigator = async (nav, fn) => {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
    try {
      return await fn();
    } finally {
      if (realNav) Object.defineProperty(globalThis, 'navigator', realNav);
      else delete globalThis.navigator;
    }
  };

  test('usage, quota, available and persisted', async () => {
    const out = await withNavigator({ storage: { estimate: async () => ({ usage: 100, quota: 1000 }), persisted: async () => true } }, storageEstimate);
    assert.deepEqual(out, { usage: 100, quota: 1000, available: 900, persisted: true });
  });

  test('unknown values are null and nothing throws', async () => {
    assert.deepEqual(await withNavigator({}, storageEstimate), { usage: null, quota: null, available: null, persisted: null });
    const broken = { storage: { estimate: async () => { throw new Error('x'); }, persisted: async () => { throw new Error('y'); } } };
    assert.deepEqual(await withNavigator(broken, storageEstimate), { usage: null, quota: null, available: null, persisted: null });
    assert.equal((await withNavigator({ storage: { estimate: async () => ({ usage: 10, quota: 5 }) } }, storageEstimate)).available, 0);
  });
});

describe('importPdfFiles without storage (Node)', () => {
  const file = (name, text = '%PDF-1.7') => Object.assign(new Blob([text], { type: 'application/pdf' }), { name });

  test('unmatched files ask for a chapter; results keep input order', async () => {
    const files = [file('Topic.pdf'), file('27 pages.pdf')];
    const progress = [];
    const out = await importPdfFiles(files, { readPdfInfo: false, onProgress: (done, total, r) => progress.push([done, total, r.status]) });
    assert.deepEqual(out.map((r) => [r.name, r.chapterId, r.status]), [
      ['Topic.pdf', null, 'unmatched'],
      ['27 pages.pdf', null, 'unmatched'],
    ]);
    assert.equal(out[0].file, files[0]);
    assert.match(out[0].message, /Which chapter/);
    assert.deepEqual(progress, [[1, 2, 'unmatched'], [2, 2, 'unmatched']]);
  });

  test('a second file for the same chapter in one batch is a duplicate', async () => {
    const out = await importPdfFiles([file('Chapter 1.pdf'), file('ch01 copy.pdf')], { readPdfInfo: false });
    assert.equal(out[0].chapterId, 'ch01');
    // No IndexedDB in Node: the first fails with a storage error, never throws.
    assert.equal(out[0].status, 'error');
    assert.ok(out[0].message);
    assert.deepEqual([out[1].chapterId, out[1].status], ['ch01', 'duplicate']);
  });

  test('chapterFor overrides the name; invalid choices and unlisted chapters are unmatched', async () => {
    const out = await importPdfFiles([file('Topic.pdf'), file('Chapter 2.pdf'), file('Chapter 9.pdf'), file('x.pdf')], {
      readPdfInfo: false,
      chapters: CHAPTERS,
      chapterFor: (f) => ({ 'Topic.pdf': 'ch03', 'x.pdf': 'chapter three' })[f.name],
    });
    assert.deepEqual(out.map((r) => [r.chapterId, r.status]), [
      ['ch03', 'error'],
      ['ch02', 'error'],
      [null, 'unmatched'],
      [null, 'unmatched'],
    ]);
  });

  test('a throwing onProgress or chapterFor never breaks the batch', async () => {
    const out = await importPdfFiles([file('Topic.pdf')], {
      readPdfInfo: false,
      onProgress: () => {
        throw new Error('ui');
      },
      chapterFor: () => {
        throw new Error('ui');
      },
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].status, 'error');
  });

  test('empty input, FileList-like input', async () => {
    assert.deepEqual(await importPdfFiles(null), []);
    const out = await importPdfFiles({ length: 1, 0: file('Topic.pdf') }, { readPdfInfo: false });
    assert.equal(out[0].status, 'unmatched');
  });

  test('undoImport ignores results it cannot undo and never throws', async () => {
    assert.equal(await undoImport(null), 0);
    assert.equal(await undoImport([{ status: 'unmatched' }, { status: 'unchanged', chapterId: 'ch01' }, null]), 0);
    // Storage errors are swallowed (no IndexedDB in Node).
    assert.equal(await undoImport([{ status: 'added', chapterId: 'ch01' }]), 0);
  });
});
