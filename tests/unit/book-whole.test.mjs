// Unit tests for js/features/book/wholebook.js ("Add the whole book once", §7.17):
// folio/title helpers, page labels, chapter-start detection on a simulated two-volume book
// (front matter + a second volume with its own front matter, so two different offsets),
// estimates, page ranges, manual adjustment, and the page-range view of the viewer.
// The simulated book uses the chapter titles and first pages of data/index.json and neutral
// placeholder body text only. No real PDF is opened here.
// Run: node --test tests/unit/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  adjustRanges,
  chapterRefsOf,
  computeRanges,
  detectChapterStarts,
  estimateMissing,
  isShareId,
  labelStarts,
  outlineFor,
  pageFacts,
  rangeOf,
  titleScore,
  titleWords,
} from '../../js/features/book/wholebook.js';
import { pageRangeDoc } from '../../js/features/book/viewer.js';

console.warn = () => {};

const INDEX = JSON.parse(readFileSync(new URL('../../data/index.json', import.meta.url), 'utf8'));
const CHAPTERS = chapterRefsOf(INDEX);

/** Front matter of Volume 1 and of Volume 2 (PDF pages). */
const F1 = 24;
const F2 = 18;
const LAST_BOOK_PAGE = 1975;

/**
 * A simulated book: PDF page → { text, folios } like pageFacts() would return.
 * Chapter openers carry "CHAPTER n" + the title and no folio; other pages carry a
 * running head (chapter number + title, top band) and the folio (bottom band).
 * @param {{ folios?: boolean, titles?: boolean, drop?: string[] }} [opt]
 */
function makeBook({ folios = true, titles = true, drop = [] } = {}) {
  const v2 = CHAPTERS.find((c) => c.volume === 2);
  /** @type {Map<number, { text: string, folios: number[] }>} */
  const pages = new Map();
  /** @param {number} b */
  const pdfOf = (b) => (v2 && b >= v2.page ? b + F1 + F2 : b + F1);
  for (let p = 1; p <= F1; p++) pages.set(p, { text: `Front matter ${p} personal placeholder ${['iii', 'iv', 'v'][p % 3]}`, folios: [] });
  for (let p = 1; p <= F2; p++) pages.set(v2.page - 1 + F1 + p, { text: `Volume two front matter ${p}`, folios: [] });
  for (let b = 1; b <= LAST_BOOK_PAGE; b++) {
    const ch = [...CHAPTERS].reverse().find((c) => c.page <= b);
    const opener = ch.page === b;
    const head = titles ? `${ch.number} ${ch.title}` : `${ch.number}`;
    let text = opener ? `CHAPTER ${ch.number} ${titles ? ch.title : ''} placeholder opening text` : `${head} placeholder body text for page ${b} with 12 mg and 3.5 values`;
    // A dropped opener is a full-page picture: no text at all.
    if (opener && drop.includes(ch.id)) text = '';
    // Running heads hold the chapter number in the top band (a number that is not a folio).
    const f = opener || !folios ? [] : [b, ch.number];
    pages.set(pdfOf(b), { text, folios: f });
  }
  const numPages = Math.max(...pages.keys());
  return { pages, numPages, pdfOf };
}

describe('pure helpers', () => {
  test('pageFacts: numbers only in the top/bottom bands, whole tokens only', () => {
    const view = [0, 0, 600, 800];
    const items = [
      { str: 'Running head 12', transform: [1, 0, 0, 1, 50, 780] },
      { str: 'Body with 345 and 2.5 and 10–12', transform: [1, 0, 0, 1, 50, 400] },
      { str: '987', transform: [1, 0, 0, 1, 300, 20] },
      { str: '1.5 cm', transform: [1, 0, 0, 1, 300, 30] },
      { str: '3D 50%', transform: [1, 0, 0, 1, 300, 40] },
    ];
    const f = pageFacts(items, view);
    assert.deepEqual(f.folios.sort((a, b) => a - b), [12, 987]);
    assert.match(f.text, /Body with 345/);
  });

  test('titleWords / titleScore ignore small words and punctuation', () => {
    assert.deepEqual(titleWords('Anatomy and Dimensions'), ['anatomy', 'dimensions']);
    assert.equal(titleScore('CHAPTER 1 ANATOMY & DIMENSIONS', 'Anatomy and Dimensions'), 1);
    assert.equal(titleScore('anatomy only', 'Anatomy and Dimensions'), 0.5);
    assert.equal(titleScore('anything', ''), 0);
  });

  test('labelStarts maps printed first pages through page labels, in order', () => {
    const labels = ['i', 'ii', 'iii', '1', '2', '3', '4', 'x', '5', '6'];
    const ch = [
      { id: 'ch01', number: 1, title: 'A', page: 1 },
      { id: 'ch02', number: 2, title: 'B', page: 3 },
      { id: 'ch03', number: 3, title: 'C', page: 6 },
      { id: 'ch04', number: 4, title: 'D', page: 99 },
    ];
    const m = labelStarts(labels, ch);
    assert.deepEqual([...m], [['ch01', 4], ['ch02', 6], ['ch03', 10]]);
    assert.equal(labelStarts(null, ch).size, 0);
  });

  test('computeRanges: stops before the next chapter and before the next volume’s front matter', () => {
    const ch = [
      { id: 'ch01', number: 1, title: 'A', page: 1, volume: 1 },
      { id: 'ch02', number: 2, title: 'B', page: 11, volume: 1 },
      { id: 'ch03', number: 3, title: 'C', page: 21, volume: 2 },
    ];
    const starts = new Map([
      ['ch01', { from: 5, how: 'folio' }],
      ['ch02', { from: 15, how: 'folio' }],
      ['ch03', { from: 40, how: 'folio' }], // 15 pages of front matter before chapter 3
    ]);
    const r = computeRanges(ch, /** @type {any} */ (starts), 60);
    assert.deepEqual(r.ch01, { from: 5, to: 14, how: 'folio' });
    assert.deepEqual(r.ch02, { from: 15, to: 24, how: 'folio' }, 'printed length, not up to page 39');
    assert.deepEqual(r.ch03, { from: 40, to: 60, how: 'folio' }, 'last chapter runs to the end');
  });

  test('estimateMissing uses the nearest found chapter of the same volume', () => {
    const ch = [
      { id: 'ch01', number: 1, title: 'A', page: 1, volume: 1 },
      { id: 'ch02', number: 2, title: 'B', page: 11, volume: 1 },
      { id: 'ch03', number: 3, title: 'C', page: 21, volume: 2 },
      { id: 'ch04', number: 4, title: 'D', page: 31, volume: 2 },
    ];
    const starts = new Map([
      ['ch01', { from: 5, how: 'folio' }],
      ['ch04', { from: 50, how: 'folio' }],
    ]);
    const all = estimateMissing(ch, /** @type {any} */ (starts), 80);
    assert.deepEqual(all.get('ch02'), { from: 15, how: 'estimated' });
    assert.deepEqual(all.get('ch03'), { from: 40, how: 'estimated' });
  });

  test('rangeOf / outlineFor / isShareId', () => {
    const meta = { map: { chapters: { ch02: { from: 30, to: 40, how: 'folio' } } } };
    assert.deepEqual(rangeOf(meta, 'ch02'), { from: 30, to: 40, how: 'folio' });
    assert.equal(rangeOf(meta, 'ch01'), null);
    assert.equal(rangeOf(null, 'ch01'), null);
    const outline = [
      { title: 'Dedication', page: 3, level: 1 },
      { title: 'Part', page: 30, level: 1 },
      { title: 'Section', page: 33, level: 2 },
      { title: 'Next', page: 41, level: 1 },
    ];
    assert.deepEqual(outlineFor(outline, { from: 30, to: 40, how: 'x' }), [
      { title: 'Part', page: 1, level: 1 },
      { title: 'Section', page: 4, level: 2 },
    ]);
    assert.equal(isShareId('0mh5x2k1qa1b2c3d4'), true);
    assert.equal(isShareId('../x'), false);
    assert.equal(isShareId(''), false);
  });
});

describe('detectChapterStarts on a simulated two-volume book', () => {
  test('finds all 55 chapters with two different offsets, cheaply, never reading front matter of Volume 1', async (t) => {
    const book = makeBook();
    /** @type {number[]} */
    const read = [];
    const progress = [];
    const { starts, reads } = await detectChapterStarts({
      chapters: CHAPTERS,
      numPages: book.numPages,
      readPage: async (p) => {
        read.push(p);
        return book.pages.get(p) ?? { text: '', folios: [] };
      },
      getLabels: async () => null,
      onProgress: (done, total) => progress.push(`${done}/${total}`),
    });
    assert.equal(CHAPTERS.length, 55);
    assert.equal(starts.size, 55, `found ${starts.size}`);
    for (const c of CHAPTERS) assert.equal(starts.get(c.id)?.from, book.pdfOf(c.page), c.id);
    assert.ok([...starts.values()].every((s) => s.how === 'confirmed'), 'title + printed numbers agree everywhere');
    assert.ok(reads < 4 * 55 + 40, `cheap: ${reads} page reads for 55 chapters`);
    t.diagnostic(`detection: ${reads} page reads of ${book.numPages} pages`);
    assert.ok(read.every((p) => p > F1), `never reads Volume 1 front matter (min read ${Math.min(...read)})`);
    assert.equal(progress.at(-1), '55/55');
    const ranges = computeRanges(CHAPTERS, starts, book.numPages);
    const v1last = CHAPTERS.filter((c) => c.volume === 1).at(-1);
    const v2first = CHAPTERS.find((c) => c.volume === 2);
    assert.equal(ranges[v1last.id].to, book.pdfOf(v2first.page - 1), 'Volume 1 ends before Volume 2 front matter');
    assert.equal(ranges.ch55.to, book.numPages);
  });

  test('uses page labels when the PDF has them (no page text needed)', async () => {
    const book = makeBook();
    const labels = Array.from({ length: book.numPages }, (_, i) => {
      const f = book.pages.get(i + 1);
      return f && f.folios.length ? String(f.folios[0]) : `x${i}`;
    });
    // Openers have no folio in the text; give them their label too.
    for (const c of CHAPTERS) labels[book.pdfOf(c.page) - 1] = String(c.page);
    let reads = 0;
    const { starts } = await detectChapterStarts({
      chapters: CHAPTERS,
      numPages: book.numPages,
      readPage: async () => {
        reads++;
        return { text: '', folios: [] };
      },
      getLabels: async () => labels,
    });
    assert.equal(starts.size, 55);
    assert.ok([...starts.values()].every((s) => s.how === 'labels'));
    assert.equal(reads, 0);
  });

  test('without printed numbers, titles on the first pages still find the chapters near the offset', async () => {
    const book = makeBook({ folios: false });
    // With no numbers there is no offset to start from: a manual start for chapter 1 gives it.
    const { starts } = await detectChapterStarts({
      chapters: CHAPTERS.slice(0, 5),
      numPages: book.numPages,
      readPage: async (p) => book.pages.get(p) ?? { text: '', folios: [] },
    });
    assert.equal(starts.size, 0, 'nothing confirmed without numbers and without a known offset');
    const ranges = adjustRanges(CHAPTERS, {}, 'ch01', book.pdfOf(1), book.numPages);
    assert.equal(ranges.ch01.from, book.pdfOf(1));
    assert.equal(ranges.ch01.how, 'manual');
    assert.equal(ranges.ch02.from, book.pdfOf(CHAPTERS[1].page));
    assert.equal(ranges.ch02.how, 'estimated');
  });

  test('a chapter whose opener can’t be confirmed is still found from its printed numbers', async () => {
    const book = makeBook({ drop: ['ch10'] });
    const { starts } = await detectChapterStarts({
      chapters: CHAPTERS,
      numPages: book.numPages,
      readPage: async (p) => book.pages.get(p) ?? { text: '', folios: [] },
    });
    assert.equal(starts.size, 55);
    assert.equal(starts.get('ch10').from, book.pdfOf(CHAPTERS[9].page));
    assert.equal(starts.get('ch10').how, 'folio');
  });

  test('missing pages → estimates from neighbours; the map stays ordered', async () => {
    const book = makeBook();
    // Chapter 30's pages are unreadable (e.g. scanned without text).
    const c30 = CHAPTERS.find((c) => c.id === 'ch30');
    const c31 = CHAPTERS.find((c) => c.id === 'ch31');
    const { starts } = await detectChapterStarts({
      chapters: CHAPTERS,
      numPages: book.numPages,
      readPage: async (p) => (p >= book.pdfOf(c30.page) && p < book.pdfOf(c31.page) ? { text: '', folios: [] } : book.pages.get(p) ?? { text: '', folios: [] }),
    });
    assert.equal(starts.has('ch30'), false);
    const all = estimateMissing(CHAPTERS, starts, book.numPages);
    assert.deepEqual(all.get('ch30'), { from: book.pdfOf(c30.page), how: 'estimated' });
    const ranges = computeRanges(CHAPTERS, all, book.numPages);
    let prev = 0;
    for (const c of CHAPTERS) {
      assert.ok(ranges[c.id].from > prev, c.id);
      prev = ranges[c.id].to;
    }
  });

  test('stops when aborted', async () => {
    const book = makeBook();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      detectChapterStarts({ chapters: CHAPTERS, numPages: book.numPages, readPage: async (p) => book.pages.get(p), signal: ac.signal }),
      (err) => err.name === 'AbortError',
    );
  });
});

describe('adjustRanges', () => {
  test('a manual start re-estimates the estimated chapters around it, keeps detected ones', () => {
    const ch = CHAPTERS.slice(0, 4);
    const ranges = {
      ch01: { from: 25, to: 51, how: 'confirmed' },
      ch02: { from: 52, to: 107, how: 'estimated' },
      ch03: { from: 108, to: 128, how: 'estimated' },
    };
    const next = adjustRanges(ch, ranges, 'ch03', 120, 400);
    assert.deepEqual(next.ch01, { from: 25, to: 51, how: 'confirmed' });
    assert.equal(next.ch03.from, 120);
    assert.equal(next.ch03.how, 'manual');
    assert.equal(next.ch04.how, 'estimated');
    assert.equal(next.ch04.from, 120 + (ch[3].page - ch[2].page));
    const cleared = adjustRanges(ch, next, 'ch03', null, 400);
    assert.equal(cleared.ch03.how, 'estimated');
  });

  test('a manual start before a detected later chapter drops the conflicting one', () => {
    const ch = CHAPTERS.slice(0, 3);
    const ranges = { ch01: { from: 25, to: 51, how: 'confirmed' }, ch02: { from: 52, to: 107, how: 'folio' } };
    const next = adjustRanges(ch, ranges, 'ch01', 60, 400);
    assert.equal(next.ch01.from, 60);
    assert.ok(!next.ch02 || next.ch02.from > 60);
  });
});

describe('pageRangeDoc (viewer pages option)', () => {
  const fake = {
    numPages: 100,
    getPage: async (n) => ({ n }),
    getPageIndex: async (ref) => ref.i,
    getPageLabels: async () => Array.from({ length: 100 }, (_, i) => String(i + 1)),
    getOutline: async () => [],
    getDestination: async () => null,
  };

  test('renumbers pages within the range and refuses pages outside it', async () => {
    const d = pageRangeDoc(fake, { from: 30, to: 40 });
    assert.equal(d.numPages, 11);
    assert.equal(d.offset, 29);
    assert.deepEqual(await d.getPage(1), { n: 30 });
    assert.deepEqual(await d.getPage(11), { n: 40 });
    await assert.rejects(d.getPage(12));
    await assert.rejects(d.getPage(0));
    assert.equal(await d.getPageIndex({ i: 29 }), 0);
    assert.equal(await d.getPageIndex({ i: 5 }), null, 'outside the range (e.g. front matter)');
    assert.deepEqual(await d.getPageLabels(), Array.from({ length: 11 }, (_, i) => String(i + 30)));
  });

  test('rejects ranges outside the document', () => {
    assert.throws(() => pageRangeDoc(fake, { from: 0, to: 3 }), RangeError);
    assert.throws(() => pageRangeDoc(fake, { from: 5, to: 4 }), RangeError);
    assert.throws(() => pageRangeDoc(fake, { from: 90, to: 101 }), RangeError);
  });
});
