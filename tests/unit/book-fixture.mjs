/**
 * Synthetic whole-book PDF for tests (dev-only; never loaded by the app).
 *
 * The owner's real book must never be opened in tests (its first pages hold
 * personal information), so tests build a book with the vendored pdf-lib:
 * chapter titles and first pages from data/index.json, neutral placeholder
 * text only, a front matter (pages marked with {@link PRIVATE_MARKER} so tests
 * can prove they are never shown or searched), and a second volume with its own
 * front matter (a different page offset). Chapter openers carry
 * "CHAPTER n" + the title and no page number; other pages a running head
 * (chapter number + title) and the printed page number at the bottom.
 *
 * {@link padPdfFile} writes a copy padded to any size (comment lines after the
 * header, cross-reference offsets shifted), to prove that big files are never
 * read whole.
 *
 * @module tests/unit/book-fixture
 */

import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Text on every front-matter page; must never appear anywhere in the app. */
export const PRIVATE_MARKER = 'PRIVATEFRONTMATTER';

/**
 * Chapters of data/index.json in book order with their volume.
 * @returns {{ id: string, number: number, title: string, page: number, volume: number }[]}
 */
export function bookChapters() {
  const index = JSON.parse(readFileSync(path.join(ROOT, 'data/index.json'), 'utf8'));
  const vol = new Map(index.parts.map((p) => [p.id, p.volume]));
  return index.chapters.map((c) => ({ id: c.id, number: c.number, title: c.title, page: c.page, volume: vol.get(c.part) })).sort((a, b) => a.page - b.page);
}

/**
 * Builds the synthetic book.
 * @param {{ front1?: number, front2?: number, lastBookPage?: number, objectStreams?: boolean }} [opt]
 *   `front1` pages of front matter before chapter 1, `front2` before the first Volume 2 chapter,
 *   `objectStreams: false` writes a classic cross-reference table (needed by padPdfFile).
 * @returns {Promise<{ bytes: Uint8Array, numPages: number, pdfOf: (bookPage: number) => number,
 *   chapters: ReturnType<typeof bookChapters>, front1: number, front2: number }>}
 */
export async function makeSyntheticBook({ front1 = 6, front2 = 4, lastBookPage = 1975, objectStreams = true } = {}) {
  const { PDFDocument, StandardFonts, rgb } = await import(path.join(ROOT, 'vendor/pdf-lib/pdf-lib.esm.min.js'));
  const chapters = bookChapters();
  const v2 = chapters.find((c) => c.volume === 2);
  /** @param {number} b */
  const pdfOf = (b) => (v2 && b >= v2.page ? b + front1 + front2 : b + front1);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 432;
  const H = 648;
  const grey = rgb(0.35, 0.35, 0.35);
  /** @param {number} i @param {string} vol */
  const front = (i, vol) => {
    const p = doc.addPage([W, H]);
    p.drawText(`${vol} front matter ${i}`, { x: 60, y: H - 150, size: 16, font: bold });
    p.drawText(`${PRIVATE_MARKER} placeholder owner details ${i}`, { x: 60, y: H - 190, size: 11, font });
  };
  for (let i = 1; i <= front1; i++) front(i, 'Volume 1');
  let chIdx = 0;
  for (let b = 1; b <= lastBookPage; b++) {
    if (v2 && b === v2.page) for (let i = 1; i <= front2; i++) front(i, 'Volume 2');
    while (chIdx + 1 < chapters.length && chapters[chIdx + 1].page <= b) chIdx++;
    const ch = chapters[chIdx];
    const p = doc.addPage([W, H]);
    if (ch.page === b) {
      p.drawText(`CHAPTER ${ch.number}`, { x: 48, y: H - 120, size: 14, font: bold, color: grey });
      // Long titles wrap over two lines.
      const words = ch.title.split(' ');
      const lines = [''];
      for (const w of words) {
        if (font.widthOfTextAtSize(`${lines.at(-1)} ${w}`, 20) > W - 96) lines.push(w);
        else lines[lines.length - 1] = `${lines.at(-1)} ${w}`.trim();
      }
      lines.forEach((l, i) => p.drawText(l, { x: 48, y: H - 160 - i * 26, size: 20, font: bold }));
      p.drawText('Neutral placeholder opening paragraph of the chapter.', { x: 48, y: H - 260, size: 11, font });
    } else {
      p.drawText(`${ch.number}  ${ch.title}`.slice(0, 70), { x: 48, y: H - 36, size: 8, font, color: grey });
      for (let l = 0; l < 6; l++) {
        p.drawText(`Placeholder body line ${l + 1} of page ${b}; atrium sample word.`, { x: 48, y: H - 90 - l * 18, size: 11, font });
      }
      p.drawText(String(b), { x: W / 2 - 8, y: 30, size: 9, font });
    }
  }
  const bytes = await doc.save({ useObjectStreams: objectStreams });
  return { bytes, numPages: doc.getPageCount(), pdfOf, chapters, front1, front2 };
}

/**
 * Writes `bytes` (a PDF with a classic xref table) to `file`, padded to about
 * `targetBytes` with comment lines right after the header; every xref offset
 * and `startxref` are shifted, so the file stays a valid PDF.
 * @param {Uint8Array} bytes
 * @param {string} file
 * @param {number} targetBytes
 * @returns {Promise<number>} The padded file size.
 */
export async function padPdfFile(bytes, file, targetBytes) {
  const buf = Buffer.from(bytes);
  const text = buf.toString('latin1');
  // Header = "%PDF-x.y\n" plus the binary comment line.
  const firstNl = text.indexOf('\n');
  const headerEnd = text.indexOf('\n', firstNl + 1) + 1;
  const sx = text.lastIndexOf('startxref');
  const xrefAt = Number(/startxref\s+(\d+)/.exec(text.slice(sx))[1]);
  if (text.slice(xrefAt, xrefAt + 4) !== 'xref') throw new Error('padPdfFile needs a classic xref table (objectStreams: false)');
  const line = Buffer.from(`%${'x'.repeat(1022)}\n`, 'latin1');
  const lines = Math.max(0, Math.floor((targetBytes - buf.length) / line.length));
  const pad = lines * line.length;
  // Shift every in-use entry of the table and startxref.
  const trailerAt = text.indexOf('trailer', xrefAt);
  const table = text.slice(xrefAt, trailerAt).replace(/(\d{10}) (\d{5}) n/g, (_, off, gen) => `${String(Number(off) + pad).padStart(10, '0')} ${gen} n`);
  const tail = text.slice(trailerAt, sx) + `startxref\n${xrefAt + pad}\n%%EOF\n`;
  const fh = await open(file, 'w');
  try {
    await fh.write(buf.subarray(0, headerEnd));
    const block = Buffer.concat(Array.from({ length: 1024 }, () => line));
    let left = lines;
    while (left > 0) {
      const n = Math.min(1024, left);
      await fh.write(n === 1024 ? block : block.subarray(0, n * line.length));
      left -= n;
    }
    await fh.write(buf.subarray(headerEnd, xrefAt));
    await fh.write(Buffer.from(table + tail, 'latin1'));
  } finally {
    await fh.close();
  }
  return headerEnd + pad + (xrefAt - headerEnd) + Buffer.byteLength(table + tail, 'latin1');
}
