#!/usr/bin/env node
/**
 * Browser check for the PDF engine and viewer (docs/ARCHITECTURE.md §7.17;
 * dev-only, never loaded by the app).
 *
 * Serves an in-memory harness page (server.setOverride, nothing written to
 * disk) that imports js/features/book/{pdf,viewer}.js and opens:
 * - PDFs generated here in memory: a 6-page text PDF with an outline (named
 *   and explicit destinations, nested levels), a landscape and a rotated page;
 *   a password-protected PDF; a damaged file; an empty file;
 * - the owner's chapter PDFs, read from disk when present (never committed):
 *   ch01 (27 pages, 16 MB) and ch02 (56 pages, 1.7 MB). Pass other paths with
 *   --pdf1 / --pdf2. Without them those checks are skipped (with a notice).
 *
 * Checks (Chromium; phone 390×844 @3x and iPad 834×1194 @2x, light + dark; desktop 1280×800 for timing):
 * first page visible time, placeholders sized from the page viewports, only
 * visible ±1 pages mounted, ≤ 6 page canvases alive while scrolling, no long
 * tasks > 100 ms while scrolling, overlay hook mount/unmount pairing, text
 * layer alignment, zoom buttons / ctrl-wheel / two-finger pinch (CDP touch)
 * keeping the focal point, goTo, keyboard, search (+ current match),
 * text selection event, thumbnails, outline, errors, destroy. Screenshots → --out.
 *
 * Usage: node tests/visual/pdf-viewer.mjs [--out <dir>] [--pdf1 <file>] [--pdf2 <file>]
 * (exit code 1 on any failure; prints a JSON summary of the measured timings)
 *
 * @module tests/visual/pdf-viewer
 */

import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'pdf-viewer-shots')));
const UPLOADS = '/root/.claude/uploads/42c09485-4d71-50ae-95c5-8da4e09afaba';
const PDF1 = arg('--pdf1', path.join(UPLOADS, '9a47a464-Chapter-01-Anatomy-and-Dimensions.pdf'));
const PDF2 = arg('--pdf2', path.join(UPLOADS, '99ff6cbb-Chapter-02-Hypothermia-Circulatory-Arrest-CPB.pdf'));
const TIMEOUT = 20000;

/** @type {string[]} */
const failures = [];
let checks = 0;
/** @type {Record<string, unknown>} */
const perf = {};
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

/* ---------------- PDFs made in memory ---------------- */

/** @param {string} s PDF string literal escaping. */
const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * A small PDF: text pages (Helvetica, not embedded → standard font data), an
 * outline, optional encryption dictionary.
 * @param {{ pages: { w: number, h: number, rotate?: number, lines: string[] }[],
 *           outline?: { title: string, page?: number, named?: string, children?: any[] }[],
 *           encrypted?: boolean }} spec
 * @returns {Buffer}
 */
function makePdf(spec) {
  /** @type {string[]} */
  const objs = [];
  const add = (body) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageRefs = [];
  for (const p of spec.pages) {
    let y = p.h - 72;
    const ops = ['BT', '/F1 16 Tf'];
    for (const line of p.lines) {
      ops.push(`1 0 0 1 56 ${y} Tm (${esc(line)}) Tj`);
      y -= 26;
    }
    ops.push('ET', '0.85 0.1 0.2 RG 4 w 40 40 m 160 40 l S');
    const content = ops.join('\n');
    const c = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    const pg = add(
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${p.w} ${p.h}] ${p.rotate ? `/Rotate ${p.rotate} ` : ''}` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`,
    );
    pageRefs.push(pg);
  }
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;

  let outlinesRef = 0;
  /** @type {[string, number][]} */
  const named = [];
  if (spec.outline && spec.outline.length) {
    outlinesRef = add('');
    /**
     * @param {any[]} items
     * @param {number} parent
     * @returns {{ first: number, last: number, count: number }}
     */
    const build = (items, parent) => {
      const refs = items.map(() => add(''));
      let count = 0;
      items.forEach((it, k) => {
        let dest = '';
        if (it.named) {
          named.push([it.named, it.page]);
          dest = `/Dest (${esc(it.named)})`;
        } else if (it.page) {
          dest = `/Dest [${pageRefs[it.page - 1]} 0 R /XYZ 0 0 0]`;
        }
        let kids = '';
        if (it.children && it.children.length) {
          const sub = build(it.children, refs[k]);
          kids = `/First ${sub.first} 0 R /Last ${sub.last} 0 R /Count ${sub.count}`;
          count += sub.count;
        }
        objs[refs[k] - 1] =
          `<< /Title (${esc(it.title)}) /Parent ${parent} 0 R ${dest} ${kids}` +
          `${k > 0 ? ` /Prev ${refs[k - 1]} 0 R` : ''}${k < refs.length - 1 ? ` /Next ${refs[k + 1]} 0 R` : ''} >>`;
        count += 1;
      });
      return { first: refs[0], last: refs[refs.length - 1], count };
    };
    const top = build(spec.outline, outlinesRef);
    objs[outlinesRef - 1] = `<< /Type /Outlines /First ${top.first} 0 R /Last ${top.last} 0 R /Count ${top.count} >>`;
  }
  const names = named.length
    ? ` /Names << /Dests << /Names [${named
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([n, page]) => `(${esc(n)}) [${pageRefs[page - 1]} 0 R /Fit]`)
        .join(' ')}] >> >>`
    : '';
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${outlinesRef ? ` /Outlines ${outlinesRef} 0 R /PageMode /UseOutlines` : ''}${names} >>`;
  let encrypt = 0;
  if (spec.encrypted) {
    encrypt = add(
      `<< /Filter /Standard /V 1 /R 2 /O <${randomBytes(32).toString('hex')}> /U <${randomBytes(32).toString('hex')}> /P -44 >>`,
    );
  }
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  const chunks = [Buffer.from(out, 'latin1')];
  let pos = chunks[0].length;
  objs.forEach((body, i) => {
    offsets.push(pos);
    const b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    chunks.push(b);
    pos += b.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  const id = randomBytes(16).toString('hex');
  const trailer =
    `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /ID [<${id}> <${id}>]${encrypt ? ` /Encrypt ${encrypt} 0 R` : ''} >>\n` +
    `startxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(chunks);
}

const LOREM = [
  'Placeholder text for the viewer test. Nothing here is medical content.',
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'Searchable words: alpha bravo charlie delta echo foxtrot golf.',
  'Line four keeps the page busy with more neutral sample words.',
];
const SAMPLE = makePdf({
  pages: [
    { w: 612, h: 792, lines: ['Sample page one', ...LOREM, 'Unique marker zebra.'] },
    { w: 612, h: 792, lines: ['Sample page two', ...LOREM] },
    { w: 792, h: 612, lines: ['Sample page three is landscape', ...LOREM] },
    { w: 612, h: 792, rotate: 90, lines: ['Sample page four is rotated', ...LOREM] },
    { w: 612, h: 792, lines: ['Sample page five', ...LOREM, 'Another zebra here.'] },
    { w: 612, h: 792, lines: ['Sample page six', ...LOREM] },
  ],
  outline: [
    { title: 'Part one', page: 1, children: [{ title: 'Section A', named: 'sec-a', page: 2 }, { title: 'Section B', page: 3 }] },
    { title: 'Part two', named: 'part-two', page: 5, children: [{ title: 'Deep', page: 6, children: [{ title: 'Deeper', page: 6 }] }] },
    { title: 'Web link only' },
  ],
});
const LOCKED = makePdf({ pages: [{ w: 612, h: 792, lines: ['Locked'] }], encrypted: true });
const DAMAGED = Buffer.from('This is not a PDF file at all. '.repeat(40));

/* ---------------- server + harness ---------------- */

const HARNESS = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>PDF viewer harness</title>
<link rel="stylesheet" href="css/tokens.css">
<link rel="stylesheet" href="css/base.css">
<link rel="stylesheet" href="css/components.css">
<link rel="stylesheet" href="css/book.css">
<style>html, body { margin: 0; height: 100%; background: var(--bg); } #host { position: fixed; inset: 0; }</style>
</head>
<body>
<div id="host"></div>
<script type="module">
import * as pdf from './js/features/book/pdf.js';
import * as viewer from './js/features/book/viewer.js';
window.__pdfv = { pdf, viewer, ready: true };
</script>
</body>
</html>`;

const server = await startServer({ port: 0 });
server.setOverride('__pdfv-harness.html', HARNESS);
server.setOverride('__pdfv/sample.pdf', SAMPLE);
server.setOverride('__pdfv/locked.pdf', LOCKED);
server.setOverride('__pdfv/damaged.pdf', DAMAGED);
server.setOverride('__pdfv/empty.pdf', Buffer.alloc(0));
const HAVE1 = existsSync(PDF1);
const HAVE2 = existsSync(PDF2);
if (HAVE1) server.setOverride('__pdfv/ch01.pdf', await readFile(PDF1));
if (HAVE2) server.setOverride('__pdfv/ch02.pdf', await readFile(PDF2));
if (!HAVE1 || !HAVE2) console.log(`Note: chapter PDFs missing (${HAVE1 ? '' : PDF1} ${HAVE2 ? '' : PDF2}); their checks are skipped.`);

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

/**
 * @param {{ width: number, height: number }} viewport
 * @param {'light' | 'dark'} scheme
 * @param {string} label
 * @param {number} [dpr]
 */
async function openHarness(viewport, scheme, label, dpr = 2) {
  const context = await browser.newContext({
    viewport,
    colorScheme: scheme,
    deviceScaleFactor: dpr,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.on('console', (msg) => {
    if (msg.type() === 'error') failures.push(`[${label}] console error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => failures.push(`[${label}] page error: ${String(err)}`));
  await page.goto(`${server.url}__pdfv-harness.html`);
  await page.waitForFunction(() => window.__pdfv && window.__pdfv.ready);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__log = { mounts: [], unmounts: [], pages: [], selects: [], renders: [] };
    w.__long = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__long.push({ t: e.startTime, d: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* no longtask support */
    }
  });
  return { context, page };
}

/**
 * Opens a PDF in the harness; resolves with the time to the first rendered page.
 * @param {import('playwright').Page} page
 * @param {string} file
 * @param {object} [opts]
 */
async function openDoc(page, file, opts = {}) {
  return page.evaluate(
    async ({ file, opts }) => {
      const w = /** @type {any} */ (window);
      const blob = await (await fetch(file)).blob();
      const host = document.getElementById('host');
      const t0 = performance.now();
      const doc = await w.__pdfv.pdf.openPdf(blob);
      const tDoc = performance.now() - t0;
      const v = w.__pdfv.viewer.createPdfViewer(host, doc, {
        ...opts,
        label: 'Test document',
        onPageChange: (n) => w.__log.pages.push(n),
        overlay: (n, el, size, overlayEl) => {
          w.__log.mounts.push(n);
          const box = document.createElement('div');
          box.className = 'test-overlay';
          box.dataset.size = `${Math.round(size.w)}x${Math.round(size.h)}`;
          Object.assign(box.style, { position: 'absolute', left: '8%', top: '4%', width: '20%', height: '3%', background: 'rgba(29,78,216,.25)', border: '2px solid #1d4ed8' });
          overlayEl.append(box);
          return { destroy: () => { w.__log.unmounts.push(n); box.remove(); } };
        },
      });
      w.__doc = doc;
      w.__v = v;
      v.on('textselect', (s) => w.__log.selects.push(s && { page: s.page, text: s.text, rects: s.rects.length }));
      const first = await new Promise((resolve) => {
        const off = v.on('render', (e) => {
          w.__log.renders.push(e.page);
          resolve(performance.now() - t0);
          off();
        });
      });
      v.on('render', (e) => w.__log.renders.push(e.page));
      await v.ready;
      return { first: Math.round(first), open: Math.round(tDoc), pages: doc.numPages };
    },
    { file, opts },
  );
}

/** @param {import('playwright').Page} page */
const closeDoc = (page) =>
  page.evaluate(async () => {
    const w = /** @type {any} */ (window);
    w.__v?.destroy();
    await w.__doc?.destroy();
    w.__v = w.__doc = null;
  });

/** Viewer DOM state. @param {import('playwright').Page} page */
const state = (page) =>
  page.evaluate(() => {
    const w = /** @type {any} */ (window);
    const sc = document.querySelector('.pdfv');
    const pages = [...document.querySelectorAll('.pdfv-page')];
    return {
      page: w.__v.page(),
      count: w.__v.pageCount(),
      scale: w.__v.scale(),
      mounted: pages.filter((p) => p.classList.contains('is-mounted')).map((p) => Number(p.dataset.page)),
      rendered: pages.filter((p) => p.classList.contains('is-rendered')).map((p) => Number(p.dataset.page)),
      canvases: document.querySelectorAll('.pdfv-canvas').length,
      details: document.querySelectorAll('.pdfv-detail').length,
      overlays: document.querySelectorAll('.test-overlay').length,
      scrollTop: sc.scrollTop,
      scrollLeft: sc.scrollLeft,
      clientW: sc.clientWidth,
      clientH: sc.clientHeight,
      scrollW: sc.scrollWidth,
      docOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });

/** Waits until every mounted page is drawn at the current zoom. @param {import('playwright').Page} page */
const settle = (page, ms = 250) =>
  page
    .waitForFunction(
      () => {
        const pages = [...document.querySelectorAll('.pdfv-page.is-mounted')];
        return pages.length > 0 && pages.every((p) => p.classList.contains('is-rendered') || p.classList.contains('is-error'));
      },
      null,
      { timeout: TIMEOUT },
    )
    .then(() => page.waitForTimeout(ms));

/**
 * Content under a viewport point, as page + fractions (independent of zoom).
 * @param {import('playwright').Page} page
 * @param {number} x viewport x inside the scroller
 * @param {number} y
 */
const probe = (page, x, y) =>
  page.evaluate(
    ([x, y]) => {
      const sc = document.querySelector('.pdfv').getBoundingClientRect();
      const cx = sc.left + x;
      const cy = sc.top + y;
      for (const p of document.querySelectorAll('.pdfv-page')) {
        const r = p.getBoundingClientRect();
        if (cy >= r.top && cy <= r.bottom) return { page: Number(p.dataset.page), fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height };
      }
      return null;
    },
    [x, y],
  );

/* ---------------- scenarios ---------------- */

/** Text layer spans sit over the drawn glyphs (checks a span's box against the canvas ink). @param {import('playwright').Page} page */
const textAlignment = (page) =>
  page.evaluate(() => {
    const pageEl = document.querySelector('.pdfv-page.is-rendered');
    const span = [...pageEl.querySelectorAll('.textLayer span')].find((s) => s.textContent.length > 10);
    const canvas = pageEl.querySelector('.pdfv-canvas');
    if (!span || !canvas) return { ok: false, why: 'no span/canvas' };
    const pr = pageEl.getBoundingClientRect();
    const sr = span.getBoundingClientRect();
    const sx = canvas.width / pr.width;
    const sy = canvas.height / pr.height;
    const ctx = canvas.getContext('2d');
    const x0 = Math.max(0, Math.floor((sr.left - pr.left) * sx));
    const y0 = Math.max(0, Math.floor((sr.top - pr.top) * sy));
    const w = Math.max(1, Math.floor(sr.width * sx));
    const hh = Math.max(1, Math.floor(sr.height * sy));
    const inside = ctx.getImageData(x0, y0, w, hh).data;
    let dark = 0;
    for (let i = 0; i < inside.length; i += 4) if (inside[i] + inside[i + 1] + inside[i + 2] < 300) dark++;
    // The same box shifted down by two of its heights should hold much less ink than the box itself… unless lines are dense,
    // so compare with the ink density right above the span instead (gap between lines).
    const above = ctx.getImageData(x0, Math.max(0, y0 - Math.floor(hh * 0.6)), w, Math.max(1, Math.floor(hh * 0.25))).data;
    let darkAbove = 0;
    for (let i = 0; i < above.length; i += 4) if (above[i] + above[i + 1] + above[i + 2] < 300) darkAbove++;
    const density = dark / (inside.length / 4);
    const densityAbove = darkAbove / (above.length / 4);
    return { ok: density > 0.02 && density > densityAbove, density, densityAbove, text: span.textContent.slice(0, 30) };
  });

/**
 * Scrolls through the document with the mouse wheel; returns long tasks and the
 * largest number of page canvases alive.
 * @param {import('playwright').Page} page
 * @param {number} steps
 * @param {number} dy
 */
async function scrollThrough(page, steps, dy) {
  const box = await page.locator('.pdfv').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__long.length = 0;
    w.__maxCanvases = 0;
    w.__maxMounted = 0;
    const tick = () => {
      w.__maxCanvases = Math.max(w.__maxCanvases, document.querySelectorAll('.pdfv-canvas').length);
      w.__maxMounted = Math.max(w.__maxMounted, document.querySelectorAll('.pdfv-page.is-mounted').length);
      if (w.__sampling) requestAnimationFrame(tick);
    };
    w.__sampling = true;
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
  return page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.__sampling = false;
    return { long: w.__long.map((e) => Math.round(e.d)), maxCanvases: w.__maxCanvases, maxMounted: w.__maxMounted };
  });
}

/**
 * Two-finger pinch via CDP touch events (Chromium).
 * @param {import('playwright').Page} page
 * @param {{ x: number, y: number }} c centre (page px)
 * @param {number} d0 start distance
 * @param {number} d1 end distance
 */
async function pinch(page, c, d0, d1) {
  const cdp = await page.context().newCDPSession(page);
  const pts = (d) => [
    { x: c.x - d / 2, y: c.y, id: 1 },
    { x: c.x + d / 2, y: c.y, id: 2 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) });
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + ((d1 - d0) * i) / steps) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/* ---------------- run ---------------- */

try {
  // 1. Desktop timing + memory on the chapter PDFs.
  for (const [name, file, have] of [
    ['ch01', '__pdfv/ch01.pdf', HAVE1],
    ['ch02', '__pdfv/ch02.pdf', HAVE2],
  ]) {
    if (!have) continue;
    console.log(`Desktop timing ${name}`);
    const { context, page } = await openHarness({ width: 1280, height: 800 }, 'light', `desktop-${name}`, 1);
    const t = await openDoc(page, file);
    perf[`${name}.firstPageMs`] = t.first;
    perf[`${name}.openMs`] = t.open;
    check(t.first < 1500, `${name}: first page visible in ${t.first} ms (< 1500)`);
    await settle(page);
    const s0 = await state(page);
    check(s0.count === t.pages, `${name}: ${t.pages} page boxes`);
    check(s0.mounted.length <= 4, `${name}: only visible ±1 pages mounted at start (${s0.mounted})`);
    const scroll = await scrollThrough(page, 60, 260);
    perf[`${name}.scrollLongTasks`] = scroll.long;
    perf[`${name}.maxCanvases`] = scroll.maxCanvases;
    check(scroll.maxCanvases <= 6, `${name}: ≤ 6 page canvases alive while scrolling (${scroll.maxCanvases})`);
    check(scroll.long.every((d) => d <= 100), `${name}: no long task > 100 ms while scrolling (${scroll.long.join(',') || 'none'})`);
    // Fast fling to the end and back: still bounded.
    const fling = await scrollThrough(page, 12, -2500);
    check(fling.maxCanvases <= 6, `${name}: ≤ 6 canvases during a fast fling (${fling.maxCanvases})`);
    await closeDoc(page);
    await context.close();
  }

  // 2. Phone / iPad, light + dark, on the 56-page chapter (or the sample PDF).
  const main = HAVE2 ? '__pdfv/ch02.pdf' : '__pdfv/sample.pdf';
  for (const [vpName, vp, dpr] of [
    ['phone', { width: 390, height: 844 }, 3],
    ['ipad', { width: 834, height: 1194 }, 2],
  ]) {
    for (const scheme of ['light', 'dark']) {
      const label = `${vpName}-${scheme}`;
      console.log(`Viewer ${label}`);
      const { context, page } = await openHarness(vp, scheme, label, dpr);
      const t = await openDoc(page, main);
      perf[`${label}.firstPageMs`] = t.first;
      await settle(page);
      let s = await state(page);
      check(!s.docOverflow && s.scrollW <= s.clientW + 1, `${label}: fit width, no horizontal scroll (${s.scrollW}/${s.clientW})`);
      const geo = await page.evaluate(() => {
        const p = document.querySelector('.pdfv-page');
        const r = p.getBoundingClientRect();
        const c = p.querySelector('.pdfv-canvas');
        return { w: r.width, h: r.height, cw: c.width, ch: c.height, label: p.getAttribute('aria-label'), role: p.getAttribute('role') };
      });
      check(Math.abs(geo.h / geo.w - 783 / 612) < 0.01 || main.endsWith('sample.pdf'), `${label}: page box has the page's aspect (${geo.w}x${geo.h})`);
      check(geo.cw >= Math.floor(geo.w * dpr) - 2 || geo.cw * geo.ch >= 4.5e6, `${label}: canvas is DPR-sharp or at the pixel budget (${geo.cw}x${geo.ch})`);
      check(/^Page 1 of \d+$/.test(geo.label) && geo.role === 'group', `${label}: page a11y label "${geo.label}"`);
      const align = await textAlignment(page);
      check(align.ok, `${label}: text layer lies over the drawn text ${JSON.stringify(align)}`);
      await page.screenshot({ path: path.join(OUT, `${label}-open.png`) });

      // Overlay hook: one live overlay per mounted page; pairs mount/unmount.
      s = await state(page);
      check(s.overlays === s.mounted.length, `${label}: overlay per mounted page (${s.overlays} vs ${s.mounted.length})`);

      // goTo + page tracking
      await page.evaluate(() => /** @type {any} */ (window).__v.goTo(20));
      await page.waitForTimeout(400);
      await settle(page);
      s = await state(page);
      check(s.page === Math.min(20, s.count), `${label}: goTo(20) → page ${s.page}`);
      check(s.mounted.includes(Math.min(20, s.count)), `${label}: target page mounted`);
      const logs = await page.evaluate(() => /** @type {any} */ (window).__log);
      check(logs.pages.at(-1) === s.page, `${label}: onPageChange reported ${logs.pages.at(-1)}`);
      const live = logs.mounts.length - logs.unmounts.length;
      check(live === s.overlays && live === s.mounted.length, `${label}: overlay mount/unmount pairs (${logs.mounts.length}/${logs.unmounts.length}, live ${live})`);
      check(s.canvases <= 6, `${label}: ≤ 6 canvases after a jump (${s.canvases})`);

      // Keyboard
      await page.focus('.pdfv');
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(700);
      s = await state(page);
      check(s.page === Math.min(21, s.count) || s.scrollTop > 0, `${label}: PageDown moves on (page ${s.page})`);
      await page.keyboard.press('End');
      await page.waitForTimeout(500);
      s = await state(page);
      check(s.page === s.count, `${label}: End → last page (${s.page}/${s.count})`);
      await page.keyboard.press('Home');
      await page.waitForTimeout(500);
      s = await state(page);
      check(s.page === 1 && s.scrollTop < 20, `${label}: Home → first page`);
      await settle(page);

      // Zoom buttons keep the centre
      const centre = { x: s.clientW / 2, y: s.clientH / 2 };
      const before = await probe(page, centre.x, centre.y);
      await page.evaluate(() => /** @type {any} */ (window).__v.zoomIn());
      await page.evaluate(() => /** @type {any} */ (window).__v.zoomIn());
      await settle(page, 400);
      const after = await probe(page, centre.x, centre.y);
      check(
        before && after && before.page === after.page && Math.abs(before.fx - after.fx) < 0.02 && Math.abs(before.fy - after.fy) < 0.02,
        `${label}: zoom in keeps the centre (${JSON.stringify(before)} → ${JSON.stringify(after)})`,
      );
      s = await state(page);
      check(s.scale > 0 && s.scrollW > s.clientW, `${label}: zoomed in (scale ${s.scale.toFixed(2)})`);
      const align2 = await textAlignment(page);
      check(align2.ok, `${label}: text layer aligned after zoom ${JSON.stringify(align2)}`);
      await page.screenshot({ path: path.join(OUT, `${label}-zoom.png`) });

      // Two-finger pinch out around a point, then back to fit width
      if (vpName === 'phone') {
        const box = await page.locator('.pdfv').boundingBox();
        const pc = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 };
        const pb = await probe(page, pc.x - box.x, pc.y - box.y);
        const scale0 = s.scale;
        await pinch(page, pc, 100, 220);
        await settle(page, 400);
        const pa = await probe(page, pc.x - box.x, pc.y - box.y);
        s = await state(page);
        check(s.scale > scale0 * 1.6, `${label}: pinch zoomed (${scale0.toFixed(2)} → ${s.scale.toFixed(2)})`);
        check(
          pb && pa && pb.page === pa.page && Math.abs(pb.fx - pa.fx) < 0.03 && Math.abs(pb.fy - pa.fy) < 0.03,
          `${label}: pinch keeps the focal point (${JSON.stringify(pb)} → ${JSON.stringify(pa)})`,
        );
        const det = await page.evaluate(() => document.querySelectorAll('.pdfv-detail').length);
        perf[`${label}.detailTilesAtHighZoom`] = det;
        await page.screenshot({ path: path.join(OUT, `${label}-pinch.png`) });
      }

      // Ctrl + wheel zoom (desktop gesture) keeps the point under the cursor
      {
        const box = await page.locator('.pdfv').boundingBox();
        const pt = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 };
        const pb = await probe(page, pt.x - box.x, pt.y - box.y);
        const sc0 = (await state(page)).scale;
        await page.mouse.move(pt.x, pt.y);
        await page.keyboard.down('Control');
        for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 60);
        await page.keyboard.up('Control');
        await page.waitForTimeout(400);
        await settle(page);
        const pa = await probe(page, pt.x - box.x, pt.y - box.y);
        const sc1 = (await state(page)).scale;
        check(sc1 < sc0 * 0.8, `${label}: ctrl+wheel zoomed out (${sc0.toFixed(2)} → ${sc1.toFixed(2)})`);
        check(
          pb && pa && pb.page === pa.page && Math.abs(pb.fx - pa.fx) < 0.03 && Math.abs(pb.fy - pa.fy) < 0.03,
          `${label}: ctrl+wheel keeps the cursor point (${JSON.stringify(pb)} → ${JSON.stringify(pa)})`,
        );
      }

      await page.evaluate(() => /** @type {any} */ (window).__v.setScale('fit-page'));
      await settle(page);
      s = await state(page);
      const fitPage = await page.evaluate(() => {
        const sc = document.querySelector('.pdfv').getBoundingClientRect();
        const p = document.querySelector(`.pdfv-page[data-page="${/** @type {any} */ (window).__v.page()}"]`).getBoundingClientRect();
        return { inside: p.top >= sc.top - 1 && p.bottom <= sc.bottom + 1 && p.left >= sc.left - 1 && p.right <= sc.right + 1 };
      });
      check(fitPage.inside, `${label}: fit page shows the whole page`);
      await page.screenshot({ path: path.join(OUT, `${label}-fitpage.png`) });
      await page.evaluate(() => /** @type {any} */ (window).__v.setScale('fit-width'));
      await settle(page);

      // Search
      const res = await page.evaluate(async () => {
        const w = /** @type {any} */ (window);
        const out = [];
        for await (const m of w.__v.search('the')) {
          out.push(m);
          if (out.length >= 400) break;
        }
        return { n: out.length, first: out[0], pages: [...new Set(out.map((m) => m.page))].length };
      });
      check(res.n > 0 && res.first && res.first.rects.length > 0, `${label}: search finds matches (${res.n} on ${res.pages} pages)`);
      check(res.first && typeof res.first.excerpt.match === 'string' && /the/i.test(res.first.excerpt.match), `${label}: excerpt ${JSON.stringify(res.first && res.first.excerpt)}`);
      const shown = await page.evaluate(() => /** @type {any} */ (window).__v.showMatch(30));
      await page.waitForTimeout(700);
      await settle(page);
      const hits = await page.evaluate(() => ({
        all: document.querySelectorAll('.pdfv-hit').length,
        current: document.querySelectorAll('.pdfv-hit.is-current').length,
      }));
      check(shown && hits.all > 0 && hits.current >= 1, `${label}: matches highlighted, current distinct (${hits.all}/${hits.current})`);
      await page.screenshot({ path: path.join(OUT, `${label}-search.png`) });

      // Text selection → textselect event
      await page.evaluate(() => {
        const span = [...document.querySelectorAll('.pdfv-page.is-rendered .textLayer span')].find((x) => x.textContent.trim().length > 12);
        const r = document.createRange();
        r.setStart(span.firstChild, 0);
        r.setEnd(span.firstChild, Math.min(12, span.firstChild.length));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      });
      await page.waitForTimeout(400);
      const sel = await page.evaluate(() => /** @type {any} */ (window).__log.selects.at(-1));
      check(sel && sel.page >= 1 && sel.text.length > 0 && sel.rects > 0, `${label}: textselect event ${JSON.stringify(sel)}`);
      await page.evaluate(() => getSelection().removeAllRanges());
      await page.waitForTimeout(300);
      const cleared = await page.evaluate(() => /** @type {any} */ (window).__log.selects.at(-1));
      check(cleared === null, `${label}: textselect null when cleared`);

      // Thumbnail
      const th = await page.evaluate(async () => {
        const c = await /** @type {any} */ (window).__v.thumbnail(2, 100);
        return { w: c.width, h: c.height, css: c.style.width };
      });
      check(th.w >= 100 && th.css === '100px', `${label}: thumbnail ${JSON.stringify(th)}`);

      // Destroy
      const d = await page.evaluate(() => {
        const w = /** @type {any} */ (window);
        const live = w.__log.mounts.length - w.__log.unmounts.length;
        w.__v.destroy();
        return {
          live,
          after: w.__log.mounts.length - w.__log.unmounts.length,
          dom: document.querySelectorAll('.pdfv, .pdfv-page, canvas.pdfv-canvas').length,
          host: document.getElementById('host').className,
        };
      });
      check(d.after === 0 && d.dom === 0 && d.host === '', `${label}: destroy() unmounts everything ${JSON.stringify(d)}`);
      await page.evaluate(() => /** @type {any} */ (window).__doc.destroy());
      await context.close();
    }
  }

  // 3. Sample PDF: outline, mixed page sizes, rotation, errors, small search.
  {
    console.log('Sample PDF (outline, sizes, rotation, errors)');
    const { context, page } = await openHarness({ width: 834, height: 1194 }, 'light', 'sample', 2);
    const info = await page.evaluate(async () => {
      const w = /** @type {any} */ (window);
      const blob = await (await fetch('__pdfv/sample.pdf')).blob();
      return w.__pdfv.pdf.pdfInfo(blob);
    });
    check(info.pages === 6, `pdfInfo pages = 6 (${info.pages})`);
    const want = [
      ['Part one', 1, 1],
      ['Section A', 2, 2],
      ['Section B', 3, 2],
      ['Part two', 5, 1],
      ['Deep', 6, 2],
      ['Deeper', 6, 3],
    ];
    check(
      JSON.stringify(info.outline.map((o) => [o.title, o.page, o.level])) === JSON.stringify(want),
      `outline resolved ${JSON.stringify(info.outline)}`,
    );
    await openDoc(page, '__pdfv/sample.pdf', { initialPage: 3 });
    await settle(page);
    let s = await state(page);
    check(s.page === 3, `initialPage 3 opens on page 3 (${s.page})`);
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll('.pdfv-page')].map((p) => {
        const r = p.getBoundingClientRect();
        return +(r.width / r.height).toFixed(3);
      }),
    );
    check(sizes[2] > 1.2 && sizes[3] > 1.2 && sizes[0] < 0.8, `landscape + rotated pages laid out wide (${sizes.join(',')})`);
    const vo = await page.evaluate(() => /** @type {any} */ (window).__v.outline());
    check(vo.length === 6, `viewer.outline() (${vo.length})`);
    const txt = await page.evaluate(() => /** @type {any} */ (window).__v.textOf(1));
    check(/Unique marker zebra\./.test(txt) && txt.includes('\n'), `textOf(1) ${JSON.stringify(txt.slice(0, 60))}`);
    const zebras = await page.evaluate(async () => {
      const out = [];
      for await (const m of /** @type {any} */ (window).__v.search('ZEBRA')) out.push(m.page);
      return out;
    });
    check(JSON.stringify(zebras) === '[1,5]', `search is case-insensitive, page order (${zebras})`);
    await page.evaluate(() => /** @type {any} */ (window).__v.goTo(4, { smooth: false }));
    await settle(page);
    const rot = await page.evaluate(() => document.querySelector('.pdfv-page[data-page="4"] .textLayer')?.getAttribute('data-main-rotation'));
    check(rot === '90', `rotated page text layer rotation (${rot})`);
    const align = await page.evaluate(() => {
      const pg = document.querySelector('.pdfv-page[data-page="4"]').getBoundingClientRect();
      const span = [...document.querySelectorAll('.pdfv-page[data-page="4"] .textLayer span')].find((x) => x.textContent.length > 5);
      const r = span.getBoundingClientRect();
      return { inside: r.left >= pg.left - 2 && r.right <= pg.right + 2 && r.top >= pg.top - 2 && r.bottom <= pg.bottom + 2, tall: r.height > r.width };
    });
    check(align.inside && align.tall, `rotated text layer stays on its page and runs vertically ${JSON.stringify(align)}`);
    await page.screenshot({ path: path.join(OUT, 'sample-rotated.png') });
    s = await state(page);
    const sizeAttr = await page.evaluate(() => document.querySelector('.pdfv-page[data-page="4"] .test-overlay')?.dataset.size);
    check(sizeAttr === '792x612', `overlay gets the page size in points (rotated: ${sizeAttr})`);
    await closeDoc(page);

    const errors = await page.evaluate(async () => {
      const w = /** @type {any} */ (window);
      const out = {};
      for (const name of ['locked', 'damaged', 'empty']) {
        try {
          const blob = await (await fetch(`__pdfv/${name}.pdf`)).blob();
          await w.__pdfv.pdf.openPdf(blob);
          out[name] = 'opened';
        } catch (e) {
          out[name] = `${e.name}:${e.code}:${e.userMessage}`;
        }
      }
      try {
        await w.__pdfv.pdf.openPdf('__pdfv/missing.pdf');
        out.missing = 'opened';
      } catch (e) {
        out.missing = `${e.name}:${e.code}`;
      }
      const bytes = new Uint8Array(await (await fetch('__pdfv/sample.pdf')).arrayBuffer());
      const doc = await w.__pdfv.pdf.openPdf(bytes.buffer);
      out.bufferKept = bytes.byteLength > 0 && doc.numPages === 6;
      await doc.destroy();
      return out;
    });
    check(/^PdfError:password:.*password/i.test(errors.locked), `password-protected → plain message (${errors.locked})`);
    check(/^PdfError:invalid:/.test(errors.damaged), `damaged → invalid (${errors.damaged})`);
    check(/^PdfError:empty:/.test(errors.empty), `empty → empty (${errors.empty})`);
    check(/^PdfError:invalid/.test(errors.missing), `missing URL → invalid (${errors.missing})`);
    check(errors.bufferKept === true, 'ArrayBuffer source is copied (caller keeps its bytes)');
    await context.close();
  }
} catch (err) {
  failures.push(`crashed: ${err?.stack || err}`);
} finally {
  await browser.close();
  await server.close();
}

console.log(`\nPerformance: ${JSON.stringify(perf, null, 2)}`);
console.log(`\n${checks} checks, ${failures.length} failure(s). Screenshots: ${OUT}`);
for (const f of failures) console.log(`FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
