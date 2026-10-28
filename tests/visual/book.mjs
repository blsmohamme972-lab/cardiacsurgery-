#!/usr/bin/env node
/**
 * Browser check for the Book tab, the PDF reader and its annotations
 * (docs/ARCHITECTURE.md §7.17; dev-only, never loaded by the app).
 *
 * Boots the real app from tests/serve.mjs (random port, service workers
 * blocked; Chromium with a fake microphone) and checks:
 *
 * - the Book tab: visible in the tab bar (6 tabs, ≥ 44 px, no overflow at 360 and
 *   390 px; side rail on iPad), marked current on /book; library with 7 parts and
 *   55 chapters, filter, no horizontal scroll;
 * - import: the owner's two chapter PDFs from disk (setInputFiles; when they are
 *   missing, two PDFs generated here with pdf-lib, named the same way) → results
 *   sheet → matched to ch01 / ch02; sections expand;
 * - reader: a section opens the reader at its page; the first page renders;
 *   search a word (count + next); go to page; thumbnails; Edit → pen stroke,
 *   picture (file chooser), sticky note, text highlight (selection → colour bar),
 *   2 s voice note (fake microphone); everything is saved in pdfnotes / media /
 *   voice; reload → it all comes back and the reader resumes on the same page;
 * - Export annotated copy → a download that starts with %PDF and has the same
 *   number of pages (checked with the vendored pdf-lib in Node);
 * - screenshots at 390×844 and 834×1194 (+ 1194×834 for the reader), light and
 *   dark; edit tool bar targets ≥ 44 px; no console errors.
 *
 * Usage: node tests/visual/book.mjs [--out <dir>] [--pdf1 <file>] [--pdf2 <file>]
 * (exit code 1 on any failure)
 *
 * @module tests/visual/book
 */

import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { startServer, ROOT } from '../serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const { PDFDocument, StandardFonts, rgb } = await import(path.join(ROOT, 'vendor/pdf-lib/pdf-lib.esm.min.js'));

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'book-shots')));
const UPLOADS = '/root/.claude/uploads/42c09485-4d71-50ae-95c5-8da4e09afaba';
const PDF1 = arg('--pdf1', path.join(UPLOADS, '9a47a464-Chapter-01-Anatomy-and-Dimensions.pdf'));
const PDF2 = arg('--pdf2', path.join(UPLOADS, '99ff6cbb-Chapter-02-Hypothermia-Circulatory-Arrest-CPB.pdf'));
const TIMEOUT = 30000;

/** @type {string[]} */
const failures = [];
let checks = 0;
/**
 * @param {unknown} cond
 * @param {string} message
 */
function check(cond, message) {
  checks++;
  if (!cond) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

/* ---------------- test files ---------------- */

/**
 * A PDF with neutral placeholder text on every page (text layer + search work).
 * @param {number} pages
 * @param {string} label
 * @returns {Promise<Buffer>}
 */
async function makePdf(pages, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`${label}: placeholder page ${i}`, { x: 72, y: 720, size: 22, font, color: rgb(0.1, 0.1, 0.1) });
    for (let l = 0; l < 30; l++) {
      p.drawText(`Line ${l + 1} of neutral sample text for the reader checks, atrium word here.`, { x: 72, y: 680 - l * 20, size: 11, font });
    }
  }
  return Buffer.from(await doc.save());
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** An opaque RGBA PNG with a gradient. @param {number} w @param {number} h */
function makePng(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = Math.round((x / w) * 255);
      raw[o + 1] = Math.round((y / h) * 200);
      raw[o + 2] = 160;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

await mkdir(OUT, { recursive: true });
const realPdfs = existsSync(PDF1) && existsSync(PDF2);
/** @type {{ name: string, mimeType: string, buffer: Buffer }[]} */
const FILES = realPdfs
  ? [
      { name: 'Chapter-01-Anatomy-and-Dimensions.pdf', mimeType: 'application/pdf', buffer: await readFile(PDF1) },
      { name: 'Chapter-02-Hypothermia-Circulatory-Arrest-CPB.pdf', mimeType: 'application/pdf', buffer: await readFile(PDF2) },
    ]
  : [
      { name: 'Chapter-01-Placeholder.pdf', mimeType: 'application/pdf', buffer: await makePdf(12, 'Chapter one') },
      { name: 'Chapter-02-Placeholder.pdf', mimeType: 'application/pdf', buffer: await makePdf(8, 'Chapter two') },
    ];
if (!realPdfs) console.log('(owner PDFs not found: using generated placeholder PDFs)');
const ORIGINAL_PAGES = (await PDFDocument.load(FILES[0].buffer, { ignoreEncryption: true })).getPageCount();

/* ---------------- helpers ---------------- */

const server = await startServer({ port: 0 });
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

/**
 * @param {{ width: number, height: number }} vp
 * @param {'light' | 'dark'} scheme
 * @param {string} label
 */
async function openApp(vp, scheme, label) {
  const context = await browser.newContext({
    viewport: vp,
    colorScheme: scheme,
    serviceWorkers: 'block',
    deviceScaleFactor: 2,
    permissions: ['microphone'],
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/^Unrecognized feature/.test(msg.text())) failures.push(`[${label}] console error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => failures.push(`[${label}] page error: ${String(err)}`));
  await page.goto(server.url);
  await page.waitForSelector('#main > *');
  await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    await r.settingsRepo.set('tourDone', true);
  });
  await page.reload();
  await page.waitForSelector('#main > *');
  return { context, page };
}

/** @param {import('playwright').Page} page */
async function gotoBook(page) {
  await page.locator('#tabbar a[data-route="/book"]').click();
  await page.waitForSelector('.book .book-ch');
}

/**
 * Imports files through the Add PDFs picker and closes the results sheet.
 * @param {import('playwright').Page} page
 * @param {typeof FILES} files
 * @param {boolean} [shoot]
 * @param {string} [tag]
 */
async function importFiles(page, files, shoot = false, tag = '') {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.book-add').click()]);
  await chooser.setFiles(files);
  if (files.length > 1) {
    const sheetEl = page.locator('.book-results-sheet');
    await sheetEl.waitFor({ timeout: 90000 });
    if (shoot) await page.screenshot({ path: path.join(OUT, `results-${tag}.png`) });
    const titles = await sheetEl.locator('.book-result-title').allInnerTexts();
    check(/^Chapter 1 ·/.test(titles[0] || '') && /^Chapter 2 ·/.test(titles[1] || ''), `files matched to chapters 1 and 2 (${titles.join(' | ')})`);
    await sheetEl.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.sheet-root'));
  }
  await page.waitForFunction((n) => document.querySelectorAll('.book-ch.has-pdf').length >= n, files.length, { timeout: 90000 });
}

/** @param {import('playwright').Page} page */
const notesOf = (page, id = 'ch01') =>
  page.evaluate(async (bookId) => {
    const r = await import('./js/core/store/repo.js');
    return r.pdfNotesRepo.byBook(bookId);
  }, id);

/** @param {import('playwright').Page} page */
const pageLabel = (page) => page.locator('.reader-page').innerText();

/** @param {import('playwright').Page} page */
async function waitReader(page) {
  await page.waitForSelector('.reader[data-ready="true"]', { timeout: 90000 });
  await page.waitForSelector('.pdfv-page.is-rendered', { timeout: 60000 });
}

/**
 * Draws with the mouse inside a page box (fractions of the box).
 * @param {import('playwright').Page} page
 * @param {number} n Page number.
 * @param {[number, number][]} pts
 */
async function drawOnPage(page, n, pts) {
  const box = await page.locator(`.pdfv-page[data-page="${n}"]`).boundingBox();
  await page.mouse.move(box.x + box.width * pts[0][0], box.y + box.height * pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 3 });
  await page.mouse.up();
}

/**
 * Taps a point inside a page box.
 * @param {import('playwright').Page} page
 * @param {number} n
 * @param {number} fx
 * @param {number} fy
 */
async function tapPage(page, n, fx, fy) {
  const box = await page.locator(`.pdfv-page[data-page="${n}"]`).boundingBox();
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

/** @param {import('playwright').Page} page @param {RegExp} name */
async function addTool(page, name) {
  await page.locator('.bk-toolbar').getByRole('button', { name: /^Add a text box/ }).click();
  await page.locator('.bk-pop-add').getByRole('button', { name }).click();
}

/** @param {import('playwright').Page} page @param {string} label */
async function targetsAndOverflow(page, label, selector) {
  const info = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const small = [...(root ? root.querySelectorAll('button, a') : [])]
      .filter((b) => b.offsetParent !== null && !b.closest('[hidden]'))
      // Small buttons (.btn-s) keep a 44 px hit area with a pseudo-element (css/components.css).
      .filter((b) => b.getBoundingClientRect().width < 43.5 || (b.getBoundingClientRect().height < 43.5 && !b.classList.contains('btn-s')))
      .map((b) => `${b.getAttribute('aria-label') || b.textContent?.trim()} ${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`);
    return {
      small,
      overflow: root ? root.scrollWidth > root.clientWidth + 1 : false,
      page: document.documentElement.scrollWidth > innerWidth + 1,
    };
  }, selector);
  check(info.small.length === 0, `${label}: every target in ${selector} ≥ 44 px (${info.small.join(', ')})`);
  check(!info.overflow && !info.page, `${label}: no horizontal overflow in ${selector} ${JSON.stringify({ o: info.overflow, p: info.page })}`);
}

/** @param {import('playwright').Page} page @param {string} label */
async function tabbarChecks(page, label) {
  const info = await page.evaluate(() => {
    const bar = document.getElementById('tabbar');
    const tabs = [...bar.querySelectorAll('a.tab')];
    const rects = tabs.map((t) => t.getBoundingClientRect());
    return {
      n: tabs.length,
      labels: tabs.map((t) => t.textContent.trim()),
      small: rects.filter((r) => r.width < 44 || r.height < 44).length,
      overflow: bar.scrollWidth > bar.clientWidth + 1,
      offscreen: rects.filter((r) => r.right > innerWidth + 0.5 || r.left < -0.5).length,
      current: bar.querySelector('[aria-current="page"]')?.textContent.trim(),
    };
  });
  check(info.n === 6 && info.labels.join(',') === 'Home,Library,Book,Stats,Search,Settings', `${label}: six tabs with Book after Library (${info.labels.join(',')})`);
  check(info.small === 0 && !info.overflow && info.offscreen === 0, `${label}: tab bar fits with 44 px targets ${JSON.stringify(info)}`);
  check(info.current === 'Book', `${label}: Book tab is current (${info.current})`);
}

/* ---------------- main flow (phone, light) ---------------- */

try {
  console.log('Main flow (390×844 light)');
  const { context, page } = await openApp({ width: 390, height: 844 }, 'light', 'phone-light');
  await gotoBook(page);
  await tabbarChecks(page, 'phone');
  const counts = await page.evaluate(() => ({ parts: document.querySelectorAll('.book-part').length, chapters: document.querySelectorAll('.book-ch').length }));
  check(counts.parts === 7 && counts.chapters === 55, `library lists 7 parts and 55 chapters (${JSON.stringify(counts)})`);
  check(await page.locator('.book-empty-note').isVisible(), 'empty note explains how to add PDFs');
  await page.screenshot({ path: path.join(OUT, 'library-empty-phone-light.png') });

  // Filter.
  await page.locator('#book-filter').fill('valve');
  const shown = await page.evaluate(() => [...document.querySelectorAll('.book-ch')].filter((li) => !li.hidden).length);
  check(shown >= 3 && shown < 55, `filter narrows the list (${shown})`);
  await page.locator('#book-filter').fill('');

  // Import both chapters.
  await importFiles(page, FILES, true, 'phone-light');
  check(!(await page.locator('.book-empty-note').isVisible()), 'empty note hides once PDFs are added');
  const meta = await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    return (await r.bookRepo.all()).map((b) => ({ id: b.id, pages: b.pages }));
  });
  check(meta.map((m) => m.id).join(',') === 'ch01,ch02', `stored as ch01 and ch02 (${JSON.stringify(meta)})`);
  await page.screenshot({ path: path.join(OUT, 'library-phone-light.png') });

  // Expand sections of chapter 1 and open one.
  await page.locator('.book-ch[data-id="ch01"] .book-ch-toggle').click();
  await page.waitForSelector('#book-sec-ch01 .book-sec-btn', { timeout: 60000 });
  await page.screenshot({ path: path.join(OUT, 'library-expanded-phone-light.png') });
  const secButtons = page.locator('#book-sec-ch01 .book-sec-btn');
  const nSec = await secButtons.count();
  let target = 0;
  for (let i = 0; i < nSec; i++) {
    const txt = await secButtons.nth(i).locator('.book-sec-page').innerText();
    const p = Number((/(\d+)/.exec(txt) || [])[1]);
    if (p >= 3) {
      target = i;
      break;
    }
  }
  const secPageText = await secButtons.nth(target).locator('.book-sec-page').innerText();
  const secPdfPage = Number((/(\d+)/.exec(secPageText) || [])[1]);
  await secButtons.nth(target).click();
  await waitReader(page);
  await page.waitForTimeout(400);
  const label1 = await pageLabel(page);
  check(label1.startsWith(`${secPdfPage} /`), `section opens the reader at its page (${secPageText} → ${label1})`);
  check(!/page=/.test(page.url()), `the ?page= link is dropped after opening (${page.url()})`);
  await page.screenshot({ path: path.join(OUT, 'reader-section-phone-light.png') });

  // Go to page 1 with the page indicator.
  await page.locator('.reader-page').click();
  await page.locator('.reader-jump-input').fill('1');
  await page.locator('.reader-jump-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('.reader-page')?.textContent.startsWith('1 /'));
  await page.waitForSelector('.pdfv-page[data-page="1"].is-rendered');
  await page.screenshot({ path: path.join(OUT, 'reader-page1-phone-light.png') });

  // Search a word.
  await page.getByRole('button', { name: 'Find in this chapter' }).click();
  await page.locator('.reader-search-input').fill('atrium');
  await page.waitForFunction(() => /^\d+ of \d+/.test(document.querySelector('.reader-search-status')?.textContent || ''), null, { timeout: 60000 });
  await page.waitForFunction(() => !/…$/.test(document.querySelector('.reader-search-status')?.textContent || ''), null, { timeout: 60000 });
  const s1 = await page.locator('.reader-search-status').innerText();
  await page.locator('.reader-search-input').press('Enter');
  const s2 = await page.locator('.reader-search-status').innerText();
  check(/^1 of \d+/.test(s1) && /^2 of \d+/.test(s2), `search counts matches and steps with Enter (${s1} → ${s2})`);
  check((await page.locator('.pdfv-hit.is-current').count()) > 0, 'current match is highlighted');
  await page.screenshot({ path: path.join(OUT, 'reader-search-phone-light.png') });
  await page.getByRole('button', { name: 'Close search' }).click();

  // Sections sheet.
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.waitForSelector('.reader-sections-sheet');
  await page.screenshot({ path: path.join(OUT, 'reader-sections-phone-light.png') });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.sheet-root'));

  // Thumbnails.
  await page.getByRole('button', { name: /^Pages/ }).click();
  await page.waitForSelector('.reader-thumb-img', { timeout: 30000 });
  await page.screenshot({ path: path.join(OUT, 'reader-thumbs-phone-light.png') });
  await page.locator('.reader-thumb[data-page="1"]').click();
  await page.waitForFunction(() => !document.querySelector('.sheet-root'));

  // Edit.
  await page.locator('.reader-edit-fab').click();
  await page.waitForSelector('.bk-toolbar');
  await targetsAndOverflow(page, 'phone edit', '.bk-toolbar');
  await page.locator('.bk-toolbar').getByRole('button', { name: 'Pen', exact: true }).click();
  await drawOnPage(page, 1, [[0.12, 0.2], [0.2, 0.24], [0.3, 0.2], [0.4, 0.25], [0.5, 0.21]]);
  await page.waitForFunction(async () => {
    const r = await import('./js/core/store/repo.js');
    const n = await r.pdfNotesRepo.get('ch01', 1);
    return n && n.scene.items.some((i) => i.type === 'stroke');
  });
  check(true, 'pen stroke saved');

  // Picture.
  await page.locator('.bk-toolbar').getByRole('button', { name: /^Add a text box/ }).click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.bk-pop-add').getByRole('button', { name: /Picture/ }).click()]);
  await chooser.setFiles({ name: 'figure.png', mimeType: 'image/png', buffer: makePng(320, 200) });
  await page.waitForFunction(() => !document.querySelector('.bk-selbar')?.hidden, null, { timeout: 15000 });
  await page.screenshot({ path: path.join(OUT, 'reader-image-phone-light.png') });
  const media = await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    return (await r.mediaRepo.byQid('book:ch01')).length;
  });
  check(media === 1, `picture stored in mediaRepo with qid book:ch01 (${media})`);
  await page.locator('.bk-toolbar').getByRole('button', { name: 'Select', exact: true }).click();

  // Sticky note.
  await addTool(page, /Sticky note/);
  await tapPage(page, 1, 0.8, 0.12);
  await page.waitForSelector('.bk-note-text');
  await page.keyboard.type('Neutral placeholder note');
  await page.locator('.bk-note-sheet').getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForSelector('.bk-pin-note');

  // Text highlight.
  await page.locator('.bk-toolbar').getByRole('button', { name: /^Highlight text/ }).click();
  await page.waitForSelector('.pdfv-page[data-page="1"] .textLayer span');
  const selected = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.pdfv-page[data-page="1"] .textLayer span')].filter((s) => (s.textContent || '').trim().length > 10);
    const sp = spans[Math.min(4, spans.length - 1)];
    const r = document.createRange();
    r.selectNodeContents(sp);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    return sp.textContent;
  });
  await page.waitForSelector('.bk-hlbar:not([hidden])', { timeout: 10000 });
  await page.screenshot({ path: path.join(OUT, 'reader-hlbar-phone-light.png') });
  await page.locator('.bk-hlbar').getByRole('button', { name: 'Highlight yellow' }).click();
  await page.waitForSelector('.pdfv-page[data-page="1"] .bk-thl');
  check(Boolean(selected), 'text selected for highlighting');

  // Voice note (2 s with the fake microphone).
  await addTool(page, /Voice note/);
  await tapPage(page, 1, 0.15, 0.45);
  await page.waitForSelector('.bk-rec-dot.is-live', { timeout: 15000 });
  await page.waitForTimeout(2100);
  await page.screenshot({ path: path.join(OUT, 'reader-record-phone-light.png') });
  await page.getByRole('button', { name: 'Stop and save' }).click();
  await page.waitForSelector('.bk-pin-audio', { timeout: 15000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'reader-annotated-phone-light.png') });

  const notes = await notesOf(page);
  const p1 = notes.find((n) => n.page === 1);
  const types = p1 ? p1.scene.items.map((i) => i.type).sort().join(',') : '';
  check(types === 'audio,image,note,stroke', `page 1 holds stroke, image, note and voice pin (${types})`);
  check(p1 && p1.highlights.length === 1 && p1.highlights[0].rects.length >= 1, `text highlight saved as page fractions (${JSON.stringify(p1?.highlights)})`);
  const voice = await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    return (await r.voiceRepo.byQid('book:ch01|1')).map((v) => v.durationMs);
  });
  check(voice.length === 1 && voice[0] >= 1500, `voice note stored for book:ch01|1 (${voice.join(',')})`);

  // Leave editing, move to page 2 and reload.
  await page.locator('.bk-toolbar').getByRole('button', { name: 'Done' }).click();
  await page.waitForSelector('.reader-bar:not([hidden])');
  await page.locator('.reader-page').click();
  await page.locator('.reader-jump-input').fill('2');
  await page.locator('.reader-jump-input').press('Enter');
  await page.waitForFunction(() => document.querySelector('.reader-page')?.textContent.startsWith('2 /'));
  await page.waitForTimeout(900);
  await page.reload();
  await waitReader(page);
  await page.waitForTimeout(500);
  check((await pageLabel(page)).startsWith('2 /'), `reader resumes on page 2 after reload (${await pageLabel(page)})`);
  await page.locator('.reader-page').click();
  await page.locator('.reader-jump-input').fill('1');
  await page.locator('.reader-jump-input').press('Enter');
  await page.waitForSelector('.pdfv-page[data-page="1"] .bk-pin-note');
  await page.waitForSelector('.pdfv-page[data-page="1"] .bk-pin-audio');
  await page.waitForSelector('.pdfv-page[data-page="1"] .bk-thl');
  await page.waitForSelector('.pdfv-page[data-page="1"] canvas.bk-canvas');
  const ink = await page.evaluate(() => {
    const cv = /** @type {HTMLCanvasElement} */ (document.querySelector('.pdfv-page[data-page="1"] canvas.bk-canvas'));
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  check(ink > 200, `ink and picture painted again after reload (${ink} px)`);
  await page.screenshot({ path: path.join(OUT, 'reader-reloaded-phone-light.png') });

  // Tap the note pin (read mode): the note opens.
  await page.locator('.pdfv-page[data-page="1"] .bk-pin-note').click();
  await page.waitForSelector('.bk-note-text');
  check((await page.locator('.bk-note-text').inputValue()) === 'Neutral placeholder note', 'note text comes back');
  await page.locator('.bk-note-sheet').getByRole('button', { name: 'Done', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.sheet-root'));

  // Export annotated copy.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.getByRole('button', { name: /Export annotated copy/ }).click(),
  ]);
  const file = await download.path();
  const bytes = await readFile(file);
  await writeFile(path.join(OUT, 'exported.pdf'), bytes);
  const exported = await PDFDocument.load(bytes, { ignoreEncryption: true });
  check(bytes.subarray(0, 5).toString() === '%PDF-', 'export starts with %PDF');
  check(exported.getPageCount() === ORIGINAL_PAGES, `export keeps the page count (${exported.getPageCount()} / ${ORIGINAL_PAGES})`);
  check(/\(annotated\)\.pdf$/.test(download.suggestedFilename()), `export file name (${download.suggestedFilename()})`);
  const stored = await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    return (await r.bookRepo.get('ch01')).blob.size;
  });
  check(stored === FILES[0].buffer.length, 'the stored original is unchanged');
  await context.close();

  /* ---------------- screenshots + layout at every size ---------------- */
  for (const [name, vp] of [
    ['phone360', { width: 360, height: 760 }],
    ['phone', { width: 390, height: 844 }],
    ['ipad', { width: 834, height: 1194 }],
  ]) {
    for (const scheme of name === 'phone360' ? ['light'] : ['light', 'dark']) {
      console.log(`Layout ${name} ${scheme}`);
      const { context: ctx, page: pg } = await openApp(vp, scheme, `${name}-${scheme}`);
      await gotoBook(pg);
      await tabbarChecks(pg, `${name}/${scheme}`);
      await targetsAndOverflow(pg, `${name}/${scheme} library`, '.book');
      await pg.screenshot({ path: path.join(OUT, `library-empty-${name}-${scheme}.png`) });
      if (name === 'phone360') {
        await ctx.close();
        continue;
      }
      await importFiles(pg, [FILES[1]]);
      await pg.locator('.book-ch[data-id="ch02"] .book-ch-toggle').click();
      await pg.waitForSelector('#book-sec-ch02 .book-sec-btn, #book-sec-ch02 .book-sections-none', { timeout: 60000 });
      await pg.locator('.book-ch[data-id="ch02"]').scrollIntoViewIfNeeded();
      await pg.screenshot({ path: path.join(OUT, `library-${name}-${scheme}.png`) });
      await pg.locator('.book-ch[data-id="ch02"] .book-ch-more').click();
      await pg.waitForSelector('.book-menu-sheet');
      await pg.screenshot({ path: path.join(OUT, `menu-${name}-${scheme}.png`) });
      await pg.keyboard.press('Escape');
      await pg.waitForFunction(() => !document.querySelector('.sheet-root'));
      await pg.locator('.book-ch[data-id="ch02"] .book-ch-main').click();
      await waitReader(pg);
      await targetsAndOverflow(pg, `${name}/${scheme} reader bar`, '.reader-bar');
      await pg.screenshot({ path: path.join(OUT, `reader-${name}-${scheme}.png`) });
      await pg.locator('.reader-edit-fab').click();
      await pg.waitForSelector('.bk-toolbar');
      await targetsAndOverflow(pg, `${name}/${scheme} edit`, '.bk-toolbar');
      await drawOnPage(pg, 1, [[0.1, 0.3], [0.25, 0.35], [0.4, 0.3], [0.55, 0.36]]);
      await pg.locator('.bk-toolbar').getByRole('button', { name: /^Marker/ }).click();
      await drawOnPage(pg, 1, [[0.1, 0.45], [0.6, 0.45]]);
      await addTool(pg, /Sticky note/);
      await tapPage(pg, 1, 0.75, 0.3);
      await pg.waitForSelector('.bk-note-text');
      await pg.keyboard.type('Placeholder');
      await pg.screenshot({ path: path.join(OUT, `note-${name}-${scheme}.png`) });
      await pg.locator('.bk-note-sheet').getByRole('button', { name: 'Done', exact: true }).click();
      await pg.waitForFunction(() => !document.querySelector('.sheet-root'));
      await pg.locator('.bk-toolbar').getByRole('button', { name: 'Colour and size' }).click();
      await pg.waitForTimeout(250);
      const pop = await pg.locator('.bk-toolbar .scratch-pop-style').boundingBox();
      check(pop && pop.x >= 0 && pop.x + pop.width <= vp.width + 0.5, `${name}/${scheme}: colour popover fits`);
      await pg.screenshot({ path: path.join(OUT, `edit-style-${name}-${scheme}.png`) });
      await pg.keyboard.press('Escape');
      await pg.locator('.bk-toolbar').getByRole('button', { name: /^Add a text box/ }).click();
      await pg.waitForTimeout(250);
      await pg.screenshot({ path: path.join(OUT, `edit-add-${name}-${scheme}.png`) });
      await pg.keyboard.press('Escape');
      await pg.screenshot({ path: path.join(OUT, `edit-${name}-${scheme}.png`) });
      if (name === 'ipad') {
        await pg.setViewportSize({ width: 1194, height: 834 });
        await pg.waitForTimeout(800);
        await targetsAndOverflow(pg, `landscape/${scheme} edit`, '.bk-toolbar');
        await pg.screenshot({ path: path.join(OUT, `edit-ipad-landscape-${scheme}.png`) });
        await pg.locator('.bk-toolbar').getByRole('button', { name: 'Done' }).click();
        await pg.waitForTimeout(300);
        await pg.screenshot({ path: path.join(OUT, `reader-ipad-landscape-${scheme}.png`) });
      }
      await ctx.close();
    }
  }
} catch (err) {
  failures.push(`crashed: ${err?.stack || err}`);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\n${checks} checks, ${failures.length} failure(s). Screenshots: ${OUT}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
