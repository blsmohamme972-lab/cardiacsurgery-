// Unit tests for js/features/book/extract.js (range copy of a few pages of a huge PDF without
// reading it whole) and an end-to-end check of the whole-book chapter detection with real
// PDF.js text positions, both on the synthetic book of tests/unit/book-fixture.mjs (neutral
// placeholder text; the owner's real book is never opened in tests).
// Run: node --test tests/unit/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ExtractError,
  extractPageRange,
  findDictEnd,
  findStartXref,
  parseXrefStreamData,
  parseXrefTable,
  unpredict,
} from '../../js/features/book/extract.js';
import { detectBookMap } from '../../js/features/book/wholebook.js';
import { makeSyntheticBook, padPdfFile, PRIVATE_MARKER } from './book-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const lib = await import(path.join(ROOT, 'vendor/pdf-lib/pdf-lib.esm.min.js'));
const { PDFDocument, StandardFonts, PDFName, PDFArray } = lib;

// PDF.js prints harmless "no canvas in Node" warnings; keep the output clean.
const warn = console.warn;
const log = console.log;
console.warn = () => {};
console.log = (...a) => (/canvas|polyfill/i.test(String(a[0])) ? undefined : log(...a));
const pdfjs = await import(path.join(ROOT, 'vendor/pdfjs/pdf.min.mjs'));
pdfjs.GlobalWorkerOptions.workerSrc = path.join(ROOT, 'vendor/pdfjs/pdf.worker.min.mjs');
console.warn = warn;

/** @param {Uint8Array} data */
const openJs = (data) => pdfjs.getDocument({ data: new Uint8Array(data), verbosity: 0, isEvalSupported: false }).promise;
/** @param {any} doc @param {number} n */
const textOf = async (doc, n) => (await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ');

/** A Blob that counts the bytes read through slice(). */
function counting(blob) {
  const stats = { bytes: 0, slices: 0, whole: 0 };
  const wrap = (b) => ({
    size: b.size,
    type: b.type,
    slice(a, z) {
      const s = b.slice(a, z);
      stats.slices++;
      stats.bytes += s.size;
      return s;
    },
    arrayBuffer() {
      stats.whole++;
      return b.arrayBuffer();
    },
  });
  return { blob: wrap(blob), stats };
}

describe('pure parsers', () => {
  test('findStartXref takes the last startxref', () => {
    assert.equal(findStartXref('...startxref\n12\n%%EOF\nmore startxref\r\n345\r\n%%EOF'), 345);
    assert.equal(findStartXref('no keyword'), null);
  });

  test('parseXrefTable: several subsections, CRLF and single-space rows', () => {
    const t = 'xref\r\n0 2\r\n0000000000 65535 f\r\n0000000017 00000 n\r\n5 1\n0000000123 00002 n \ntrailer\n<< /Size 6 >>';
    const { entries, trailerAt } = parseXrefTable(t);
    assert.deepEqual(entries, [
      [0, { type: 0 }],
      [1, { type: 1, offset: 17, gen: 0 }],
      [5, { type: 1, offset: 123, gen: 2 }],
    ]);
    assert.equal(t.slice(trailerAt, trailerAt + 7), 'trailer');
    assert.throws(() => parseXrefTable('xref\n0 2\n0000000000 65535 f\n'), ExtractError);
  });

  test('parseXrefStreamData: types 0/1/2, default type, /Index subsections', () => {
    const data = Uint8Array.from([1, 0, 10, 0, 2, 0, 7, 3, 0, 0, 0, 0]);
    assert.deepEqual(parseXrefStreamData(data, [1, 2, 1], [4, 2, 9, 1]), [
      [4, { type: 1, offset: 10, gen: 0 }],
      [5, { type: 2, stream: 7, index: 3 }],
      [9, { type: 0 }],
    ]);
    assert.deepEqual(parseXrefStreamData(Uint8Array.from([0, 20, 0]), [0, 2, 1], [3, 1]), [[3, { type: 1, offset: 20, gen: 0 }]]);
    assert.throws(() => parseXrefStreamData(new Uint8Array(2), [1, 2, 1], [0, 1]), ExtractError);
  });

  test('unpredict undoes PNG Up/Sub/Paeth rows and TIFF 2', () => {
    // Two rows of 3 columns: Up filter on row 2.
    const png = Uint8Array.from([0, 1, 2, 3, 2, 1, 1, 1]);
    assert.deepEqual([...unpredict(png, { predictor: 12, columns: 3 })], [1, 2, 3, 2, 3, 4]);
    assert.deepEqual([...unpredict(Uint8Array.from([1, 5, 1, 1]), { predictor: 15, columns: 3 })], [5, 6, 7]);
    assert.deepEqual([...unpredict(Uint8Array.from([4, 9, 1, 1]), { predictor: 15, columns: 3 })], [9, 10, 11]);
    assert.deepEqual([...unpredict(Uint8Array.from([5, 1, 1]), { predictor: 2, columns: 3 })], [5, 6, 7]);
    assert.throws(() => unpredict(Uint8Array.from([9, 0]), { predictor: 12, columns: 1 }), ExtractError);
  });

  test('findDictEnd skips nested dicts, strings and hex strings', () => {
    const t = 'trailer << /A << /B (x>>y) >> /ID [<abcd><ef01>] /C <00ff>>> rest';
    const open = t.indexOf('<<');
    assert.equal(t.slice(findDictEnd(t, open)), ' rest');
    assert.equal(findDictEnd('<< /A 1', 0), -1);
  });
});

describe('extractPageRange', () => {
  /** @param {{ objectStreams: boolean }} o */
  async function sample({ objectStreams }) {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    for (let i = 1; i <= 12; i++) {
      const p = d.addPage([400, 500]);
      p.drawText(`Sample page ${i}`, { x: 40, y: 400, size: 18, font: f });
    }
    // Inherited attributes: MediaBox on the page-tree root only.
    const pages = d.catalog.Pages();
    pages.set(PDFName.of('MediaBox'), d.context.obj([0, 0, 400, 500]));
    for (const p of d.getPages()) p.node.delete(PDFName.of('MediaBox'));
    // A link from page 6 to page 1 (must not drag page 1 into the copy).
    const link = d.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50], Dest: [d.getPages()[0].ref, PDFName.of('Fit')] });
    d.getPages()[5].node.set(PDFName.of('Annots'), d.context.obj([d.context.register(link)]));
    return d.save({ useObjectStreams: objectStreams });
  }

  for (const objectStreams of [true, false]) {
    test(`copies pages 5–8 with inherited MediaBox, drops links out (${objectStreams ? 'xref stream + object streams' : 'classic xref'})`, async () => {
      const bytes = await sample({ objectStreams });
      const out = await extractPageRange(lib, new Blob([bytes]), 5, 8);
      const saved = await out.save();
      const back = await PDFDocument.load(saved);
      assert.equal(back.getPageCount(), 4);
      assert.deepEqual(back.getPage(0).getMediaBox(), { x: 0, y: 0, width: 400, height: 500 });
      const annots = back.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray);
      assert.equal(annots.size(), 1);
      assert.equal(annots.lookup(0).get(PDFName.of('Dest')), undefined, 'link destination outside the copy dropped');
      const js = await openJs(saved);
      assert.equal(js.numPages, 4);
      assert.match(await textOf(js, 1), /Sample page 5/);
      assert.match(await textOf(js, 4), /Sample page 8/);
      await js.destroy();
    });
  }

  test('follows incremental updates (/Prev): the newest object wins', async () => {
    const base = Buffer.from(await sample({ objectStreams: false }));
    const text = base.toString('latin1');
    const prev = Number(/startxref\s+(\d+)/.exec(text.slice(text.lastIndexOf('startxref')))[1]);
    const trailer = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(text.slice(prev))[1];
    const size = Number(/\/Size (\d+)/.exec(trailer)[1]);
    const root = /\/Root (\d+ \d+ R)/.exec(trailer)[1];
    // New content stream for page 5, written uncompressed in an update.
    const back = await PDFDocument.load(base);
    const page5 = back.getPage(4).node;
    const contentsRef = page5.get(PDFName.of('Contents'));
    const n = contentsRef.objectNumber ?? contentsRef.get?.(0)?.objectNumber;
    const content = 'BT /F1 12 Tf 40 300 Td (UPDATED) Tj ET';
    const obj = `${n} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
    const objAt = base.length + 1;
    const xrefAt = objAt + obj.length;
    const update = `\n${obj}xref\n0 1\n0000000000 65535 f \n${n} 1\n${String(objAt).padStart(10, '0')} 00000 n \ntrailer\n<< /Size ${size} /Root ${root} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    const bytes = Buffer.concat([base, Buffer.from(update, 'latin1')]);
    const out = await extractPageRange(lib, new Blob([bytes]), 5, 5);
    const saved = Buffer.from(await out.save({ useObjectStreams: false }));
    assert.ok(saved.toString('latin1').includes('(UPDATED) Tj'));
  });

  test('refuses encrypted files and bad ranges', async () => {
    const base = Buffer.from(await sample({ objectStreams: false }));
    const text = base.toString('latin1');
    const prev = Number(/startxref\s+(\d+)/.exec(text.slice(text.lastIndexOf('startxref')))[1]);
    const trailer = /trailer\s*<<([\s\S]*?)>>\s*startxref/.exec(text.slice(prev))[1];
    const xrefAt = base.length + 1;
    const enc = `\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< ${trailer} /Encrypt << /Filter /Standard >> /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    await assert.rejects(extractPageRange(lib, new Blob([Buffer.concat([base, Buffer.from(enc, 'latin1')])]), 1, 2), (e) => e instanceof ExtractError && e.code === 'encrypted');
    await assert.rejects(extractPageRange(lib, new Blob([base]), 10, 20), (e) => e instanceof ExtractError && e.code === 'range');
    await assert.rejects(extractPageRange(lib, new Blob([Buffer.from('not a pdf at all')]), 1, 1), ExtractError);
  });
});

describe('synthetic whole book (≈2000 pages, two volumes)', () => {
  /** @type {Awaited<ReturnType<typeof makeSyntheticBook>>} */
  let book;
  let dir = '';
  before(async () => {
    book = await makeSyntheticBook({ objectStreams: false });
    dir = await mkdtemp(path.join(os.tmpdir(), 'kirklin-book-'));
  });
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('detectBookMap with real PDF.js text finds all 55 chapters (front matter never read)', async (t) => {
    const js = await openJs(book.bytes);
    /** @type {number[]} */
    const pagesRead = [];
    const doc = {
      numPages: js.numPages,
      getPageLabels: () => js.getPageLabels(),
      getPage: (n) => {
        pagesRead.push(n);
        return js.getPage(n);
      },
    };
    const res = await detectBookMap(doc, book.chapters);
    assert.equal(res.found, 55);
    assert.deepEqual(res.missing, []);
    for (const c of book.chapters) assert.equal(res.map.chapters[c.id].from, book.pdfOf(c.page), c.id);
    const v2 = book.chapters.find((c) => c.volume === 2);
    const v1last = book.chapters.filter((c) => c.volume === 1).at(-1);
    assert.equal(res.map.chapters[v1last.id].to, book.pdfOf(v2.page - 1));
    assert.equal(res.map.chapters.ch55.to, book.numPages);
    assert.ok(pagesRead.every((p) => p > book.front1), 'Volume 1 front matter never read');
    t.diagnostic(`detection: ${res.reads} page reads of ${book.numPages}; how: ${[...new Set(Object.values(res.map.chapters).map((r) => r.how))].join(',')}`);
    await js.destroy();
  });

  test('a 300 MB padded copy: extracting one chapter reads < 2 MB and never the whole file', async (t) => {
    const file = path.join(dir, 'book-300mb.pdf');
    const size = await padPdfFile(book.bytes, file, 300 * 1024 * 1024);
    assert.ok(size > 299 * 1024 * 1024);
    const { blob, stats } = counting(await openAsBlob(file));
    const c = book.chapters.find((x) => x.id === 'ch27');
    const next = book.chapters.find((x) => x.id === 'ch28');
    const from = book.pdfOf(c.page);
    const to = book.pdfOf(next.page) - 1;
    const started = Date.now();
    const out = await extractPageRange(lib, /** @type {any} */ (blob), from, to);
    const saved = await out.save();
    const ms = Date.now() - started;
    assert.equal(stats.whole, 0, 'never arrayBuffer() on the whole file');
    assert.ok(stats.bytes < 2 * 1024 * 1024, `read ${stats.bytes} bytes`);
    const js = await openJs(saved);
    assert.equal(js.numPages, to - from + 1);
    assert.match(await textOf(js, 1), new RegExp(`CHAPTER ${c.number}`));
    for (let p = 1; p <= js.numPages; p++) assert.doesNotMatch(await textOf(js, p), new RegExp(PRIVATE_MARKER));
    t.diagnostic(`300 MB file: ${stats.slices} slices, ${(stats.bytes / 1024).toFixed(0)} KB read, ${ms} ms, copy ${(saved.length / 1024).toFixed(0)} KB`);
    await js.destroy();
  });
});
