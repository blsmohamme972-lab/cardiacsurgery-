#!/usr/bin/env node
/**
 * Browser check for Scratchpad v2 (docs/ARCHITECTURE.md §7.16; dev-only,
 * never loaded by the app).
 *
 * Boots the real app from tests/serve.mjs (random port, service workers
 * blocked), opens a practice session and drives the scratchpad from the
 * player's bottom-bar "Scratchpad" button in Chromium at 390×844 and
 * 834×1194, light and dark:
 *
 * - opens with one tap at fit width ("100%"), first-run hint, all toolbar targets ≥ 44 px,
 *   no horizontal overflow; the player bottom bar still fits at 390 px
 * - mouse stroke + pen stroke (PointerEvents with pressure) → items
 * - Image: file chooser (a PNG generated in memory) → inserted, selected,
 *   resized with the corner handle (aspect kept), drawn on (stroke above the image)
 * - text box, eraser, undo / redo, the three views (over, split, full)
 * - Done → saved to inkRepo (scene v2) + mediaRepo; reload → everything is back
 *   (scene and image pixels)
 * - a legacy v1 scratch record (strokes only) is migrated and saved back
 * - no console errors. Screenshots go to --out.
 *
 * Usage: node tests/visual/scratch.mjs [--out <dir>]   (exit code 1 on any failure)
 *
 * @module tests/visual/scratch
 */

import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(os.tmpdir(), 'scratch-shots'));
const TIMEOUT = 10000;
const QIDS = ['DEMO-0001', 'DEMO-0002', 'DEMO-0003'];

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

/* ---------------- a PNG made in memory ---------------- */

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
/**
 * @param {string} type
 * @param {Buffer} data
 */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/**
 * An RGBA PNG with a colour gradient and a dark band (opaque unless `alpha`).
 * @param {number} w
 * @param {number} h
 * @param {boolean} [alpha=false]
 */
function makePng(w, h, alpha = false) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const band = Math.abs(y - h / 2) < h / 10;
      raw[o] = band ? 20 : Math.round((x / w) * 255);
      raw[o + 1] = band ? 40 : Math.round((y / h) * 200);
      raw[o + 2] = band ? 90 : 180;
      raw[o + 3] = alpha && x < w / 3 ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- helpers ---------------- */

const server = await startServer({ port: 0 });
const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

/**
 * @param {{ width: number, height: number }} vp
 * @param {'light' | 'dark'} scheme
 * @param {string} label
 */
async function openApp(vp, scheme, label) {
  const context = await browser.newContext({ viewport: vp, colorScheme: scheme, serviceWorkers: 'block', deviceScaleFactor: 2 });
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
async function startPractice(page) {
  const id = await page.evaluate(async (qids) => {
    const e = await import('./js/features/quiz/engine.js');
    const s = await e.createSession({ qids, mode: 'tutor', title: 'Practice test', shuffleChoices: false });
    return s.id;
  }, QIDS);
  await page.evaluate((sid) => {
    location.hash = `#/quiz/${sid}`;
  }, id);
  await page.waitForSelector('.pbar .pbar-scratch');
  await page.waitForTimeout(150);
  return id;
}

/** @param {import('playwright').Page} page */
async function openPad(page) {
  await page.locator('.pbar').getByRole('button', { name: 'Scratchpad' }).click();
  await page.waitForSelector('.scratch[data-ready="true"]');
  await page.waitForTimeout(120);
}

/**
 * A button inside the scratchpad (exact accessible name).
 * @param {import('playwright').Page} page
 * @param {string} name
 */
const btn = (page, name) => page.locator('.scratch').getByRole('button', { name, exact: true });

/** @param {import('playwright').Page} page */
const scratchRecord = (page, qid = QIDS[0]) =>
  page.evaluate(async (q) => {
    const r = await import('./js/core/store/repo.js');
    return r.inkRepo.get(q, 'scratch');
  }, qid);

/** @param {import('playwright').Page} page */
const mediaCount = (page, qid = QIDS[0]) =>
  page.evaluate(async (q) => {
    const r = await import('./js/core/store/repo.js');
    return (await r.mediaRepo.byQid(q)).length;
  }, qid);

/**
 * Draws with the mouse along points relative to the viewport box.
 * @param {import('playwright').Page} page
 * @param {[number, number][]} pts
 */
async function mouseDraw(page, pts) {
  const vb = await page.locator('.scratch-viewport').boundingBox();
  await page.mouse.move(vb.x + pts[0][0], vb.y + pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(vb.x + x, vb.y + y, { steps: 3 });
  await page.mouse.up();
}

/**
 * Draws with dispatched pen PointerEvents (pressure ramps up then down).
 * @param {import('playwright').Page} page
 * @param {[number, number][]} pts relative to the viewport
 */
async function penDraw(page, pts) {
  await page.evaluate((list) => {
    const el = document.querySelector('.scratch-viewport');
    const r = el.getBoundingClientRect();
    const base = { pointerId: 77, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, composed: true };
    list.forEach(([x, y], i) => {
      const type = i === 0 ? 'pointerdown' : 'pointermove';
      const pressure = 0.2 + 0.7 * Math.sin((Math.PI * i) / Math.max(1, list.length - 1));
      el.dispatchEvent(new PointerEvent(type, { ...base, clientX: r.left + x, clientY: r.top + y, pressure, buttons: 1, button: i === 0 ? 0 : -1 }));
    });
    const [x, y] = list[list.length - 1];
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: r.left + x, clientY: r.top + y, pressure: 0, buttons: 0, button: 0 }));
  }, pts);
}

/** @param {import('playwright').Page} page */
async function toolbarChecks(page, label) {
  const info = await page.evaluate(() => {
    const tb = document.querySelector('.scratch-toolbar');
    const top = document.querySelector('.scratch-top');
    const small = [...document.querySelectorAll('.scratch-toolbar button, .scratch-top button')]
      .filter((b) => b.offsetParent !== null && !b.closest('[hidden]'))
      .filter((b) => b.offsetWidth < 44 || b.offsetHeight < 44)
      .map((b) => `${b.getAttribute('aria-label') || b.textContent} ${b.offsetWidth}x${b.offsetHeight}`);
    return {
      small,
      tbOverflow: tb.scrollWidth > tb.clientWidth + 1,
      topOverflow: top.scrollWidth > top.clientWidth + 1,
      page: document.documentElement.scrollWidth > innerWidth,
    };
  });
  check(info.small.length === 0, `${label}: every scratchpad target ≥ 44 px (${info.small.join(', ')})`);
  check(!info.tbOverflow && !info.topOverflow && !info.page, `${label}: no horizontal overflow ${JSON.stringify(info)}`);
}

/** @param {import('playwright').Page} page */
async function chooseView(page, name) {
  await btn(page, 'More options').click();
  await page.locator('.scratch-pop-more').getByRole('radio', { name }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
}

/* ---------------- main flow (phone, light) ---------------- */

try {
  console.log('Main flow (390×844 light)');
  const { context, page } = await openApp({ width: 390, height: 844 }, 'light', 'phone-light');
  await startPractice(page);

  // The bottom bar keeps fitting with the new button.
  const bar = await page.evaluate(() => {
    const inner = document.querySelector('.pbar-inner');
    const btns = [...inner.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
    return {
      overflow: inner.scrollWidth > inner.clientWidth + 1,
      right: Math.max(...btns.map((b) => b.right)),
      small: btns.filter((b) => b.width < 44 || b.height < 44).length,
      vw: innerWidth,
    };
  });
  check(!bar.overflow && bar.right <= bar.vw && bar.small === 0, `player bar fits at 390 px ${JSON.stringify(bar)}`);
  await page.screenshot({ path: path.join(OUT, 'player-bar-phone-light.png') });

  await openPad(page);
  check((await page.getByRole('dialog').count()) === 1, 'Scratchpad opens with one tap from the bottom bar');
  check((await page.locator('.scratch-zoom-value').innerText()) === '100%', 'opens at fit width (100%)');
  check(await page.locator('.scratch-hint').isVisible(), 'first-open hint is shown');
  check((await page.locator('.scratch').getAttribute('data-view')) === 'over', 'default view is "over the question"');
  check((await btn(page, 'Pen').getAttribute('aria-pressed')) === 'true', 'Pen is the default tool');
  await toolbarChecks(page, 'phone');
  await page.screenshot({ path: path.join(OUT, 'main-pad-over-phone-light.png') });

  // Mouse stroke + pen stroke.
  await mouseDraw(page, [[40, 120], [90, 150], [150, 130], [200, 170]]);
  check(await page.locator('.scratch-hint').evaluate((el) => el.hidden || el.classList.contains('is-hidden')), 'hint hides after the first stroke');
  check(!(await btn(page, 'Undo').isDisabled()), 'Undo enabled after drawing');
  await penDraw(page, [[40, 220], [70, 230], [110, 240], [150, 236], [190, 250], [230, 262]]);
  await page.waitForTimeout(600);
  let rec = await scratchRecord(page);
  check(rec?.scene?.v === 2 && rec.scene.items.length === 2, `two strokes autosaved as a v2 scene (${rec?.scene?.items?.length})`);
  const pen = rec?.scene?.items?.[1];
  const pressures = pen ? pen.pts.filter((_, i) => i % 3 === 2) : [];
  check(pressures.length > 2 && Math.max(...pressures) - Math.min(...pressures) > 0.2, `pen pressure stored (${pressures.join(',')})`);

  // Image via the file chooser.
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), btn(page, 'Image').click()]);
  await chooser.setFiles({ name: 'diagram.png', mimeType: 'image/png', buffer: makePng(640, 400) });
  await page.waitForFunction(() => !document.querySelector('.scratch-selbar')?.hidden);
  check((await btn(page, 'Select').getAttribute('aria-pressed')) === 'true', 'after an image insert the Select tool is on');
  await page.waitForTimeout(600);
  rec = await scratchRecord(page);
  const img = rec?.scene?.items?.find((i) => i.type === 'image');
  check(img && Math.abs(img.w / img.h - 1.6) < 0.01, `image inserted with its aspect ratio (${img && (img.w / img.h).toFixed(3)})`);
  check((await mediaCount(page)) === 1, 'image stored in mediaRepo');
  const mediaRec = await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    const [m] = await r.mediaRepo.byQid('DEMO-0001');
    return m ? { mime: m.mime, w: m.width, h: m.height } : null;
  });
  check(mediaRec && /webp|jpeg/.test(mediaRec.mime) && mediaRec.w === 640, `opaque PNG re-encoded (${JSON.stringify(mediaRec)})`);
  await page.screenshot({ path: path.join(OUT, 'main-pad-image-selected-phone-light.png') });

  // Resize with the se handle (aspect kept).
  const vb = await page.locator('.scratch-viewport').boundingBox();
  const s = vb.width / 2000;
  const toScreen = (x, y) => ({ x: vb.x + x * s, y: vb.y + y * s });
  const se = toScreen(img.x + img.w, img.y + img.h);
  await page.mouse.move(se.x, se.y);
  await page.mouse.down();
  await page.mouse.move(se.x + 30, se.y + 50, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  rec = await scratchRecord(page);
  const img2 = rec.scene.items.find((i) => i.type === 'image');
  check(img2.w > img.w + 50 && Math.abs(img2.w / img2.h - 1.6) < 0.02 && Math.abs(img2.x - img.x) < 1, `corner handle resizes with aspect kept (${img.w}→${img2.w})`);

  // Draw on the image with the pen.
  await btn(page, 'Pen').click();
  const c = toScreen(img2.x + img2.w / 2, img2.y + img2.h / 2);
  await mouseDraw(page, [[c.x - vb.x - 40, c.y - vb.y], [c.x - vb.x, c.y - vb.y + 20], [c.x - vb.x + 40, c.y - vb.y]]);
  await page.waitForTimeout(600);
  rec = await scratchRecord(page);
  const types = rec.scene.items.map((i) => i.type);
  check(types.join(',') === 'stroke,stroke,image,stroke', `stroke drawn on top of the image (${types.join(',')})`);

  // Undo / redo.
  await btn(page, 'Undo').click();
  await page.waitForTimeout(500);
  check((await scratchRecord(page)).scene.items.length === 3, 'Undo removes the last stroke');
  await btn(page, 'Redo').click();
  await page.waitForTimeout(500);
  check((await scratchRecord(page)).scene.items.length === 4, 'Redo brings it back');

  // Text box.
  await btn(page, 'Text').click();
  await page.mouse.click(vb.x + 60, vb.y + vb.height - 120);
  await page.waitForSelector('.scratch-text-editor');
  await page.keyboard.type('Neutral note');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  rec = await scratchRecord(page);
  check(rec.scene.items.some((i) => i.type === 'text' && i.text === 'Neutral note'), 'text box saved');

  // Eraser removes the first stroke.
  await btn(page, 'Eraser').click();
  await mouseDraw(page, [[85, 135], [95, 150], [100, 160]]);
  await page.waitForTimeout(600);
  rec = await scratchRecord(page);
  check(rec.scene.items.length === 4 && rec.scene.items[0].type === 'stroke', `eraser removed one stroke (${rec.scene.items.length})`);

  // Keyboard shortcut: V → select.
  await page.locator('.scratch-viewport').focus();
  await page.keyboard.press('v');
  check((await btn(page, 'Select').getAttribute('aria-pressed')) === 'true', 'V selects the Select tool');

  // Views.
  await chooseView(page, 'Split');
  check((await page.locator('.scratch').getAttribute('data-view')) === 'split', 'Split view');
  check((await page.locator('.scratch-question').innerText()).length > 20, 'split view shows the question copy');
  await page.screenshot({ path: path.join(OUT, 'main-pad-split-phone-light.png') });
  await chooseView(page, 'Full page');
  check((await page.locator('.scratch').getAttribute('data-view')) === 'full', 'Full page view');
  await page.screenshot({ path: path.join(OUT, 'main-pad-full-phone-light.png') });
  check((await page.evaluate(async () => (await import('./js/core/settings.js')).getSetting('scratchView'))) === 'full', 'view remembered in settings');

  // Done → closed and saved.
  await btn(page, 'Done').click();
  await page.waitForFunction(() => !document.querySelector('.scratch'));
  check((await page.getByRole('dialog').count()) === 0, 'Done closes the scratchpad');

  // Reload → everything is back.
  await page.reload();
  await page.waitForSelector('.pbar .pbar-scratch');
  await openPad(page);
  check((await page.locator('.scratch').getAttribute('data-view')) === 'full', 'reopens in the remembered view');
  check(await page.locator('.scratch-hint').evaluate((el) => el.hidden), 'no hint when the page has content');
  await page.waitForTimeout(500);
  const pix = await page.evaluate(({ x, y }) => {
    const cv = document.querySelector('.scratch-canvas');
    const r = cv.getBoundingClientRect();
    const k = cv.width / r.width;
    const vp = document.querySelector('.scratch-viewport').getBoundingClientRect();
    // Full view has a 12px margin: map page units with the current scale.
    const scale = (vp.width - 24) / 2000;
    const px = Math.round((12 + x * scale) * k);
    const py = Math.round((12 + y * scale) * k);
    const d = cv.getContext('2d').getImageData(px, py, 1, 1).data;
    return [...d];
  }, { x: img2.x + img2.w * 0.15, y: img2.y + img2.h * 0.15 });
  check(pix[3] === 255 && pix[2] > 120, `image pixels painted after reload (${pix.join(',')})`);
  await page.screenshot({ path: path.join(OUT, 'main-pad-reloaded-phone-light.png') });
  await btn(page, 'Close scratchpad').click();
  await page.waitForFunction(() => !document.querySelector('.scratch'));

  // Legacy v1 record migrates.
  await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    await r.inkRepo.set('DEMO-0002', 'scratch', { qversion: 1, strokes: [{ tool: 'pen', color: '#dc2626', size: 0.003, pts: [0.1, 0.1, 0.5, 0.3, 0.12, 0.6] }] });
  });
  await page.locator('.pbar').getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(300);
  await openPad(page);
  await page.waitForTimeout(700);
  rec = await scratchRecord(page, 'DEMO-0002');
  const mig = rec?.scene?.items?.[0];
  check(rec?.scene?.v === 2 && mig?.type === 'stroke' && mig.pts[0] === 200 && mig.pts[1] === 300 && mig.size === 6, `v1 strokes migrated to a v2 scene (${JSON.stringify(mig)})`);
  check(Array.isArray(rec?.strokes) && rec.strokes.length === 0, 'legacy strokes cleared after migration');
  await btn(page, 'Done').click();
  await context.close();

  /* ---------------- screenshots + layout at every size ---------------- */
  for (const [name, vp] of [
    ['phone', { width: 390, height: 844 }],
    ['ipad', { width: 834, height: 1194 }],
  ]) {
    for (const scheme of ['light', 'dark']) {
      console.log(`Layout ${name} ${scheme}`);
      const { context: ctx, page: pg } = await openApp(vp, scheme, `${name}-${scheme}`);
      await startPractice(pg);
      await pg.locator('.choice').first().click().catch(() => {});
      await pg.waitForTimeout(200);
      await openPad(pg);
      await toolbarChecks(pg, `${name}/${scheme}`);
      await mouseDraw(pg, [[60, 200], [120, 240], [200, 210], [260, 260]]);
      await btn(pg, 'Highlighter').click();
      await mouseDraw(pg, [[50, 300], [250, 300]]);
      await btn(pg, 'Shapes').click();
      await pg.locator('.scratch-pop-shapes').getByRole('button', { name: 'Arrow' }).click();
      await mouseDraw(pg, [[80, 380], [240, 340]]);
      await pg.screenshot({ path: path.join(OUT, `pad-over-${name}-${scheme}.png`) });
      await btn(pg, 'Colour and size').click();
      const pb = await pg.locator('.scratch-pop-style').boundingBox();
      check(pb && pb.x >= 0 && pb.x + pb.width <= vp.width, `${name}/${scheme}: colour popover fits`);
      await pg.waitForTimeout(250);
      await pg.screenshot({ path: path.join(OUT, `pad-style-${name}-${scheme}.png`) });
      await pg.keyboard.press('Escape');
      await btn(pg, 'More options').click();
      await pg.waitForTimeout(250);
      await pg.screenshot({ path: path.join(OUT, `pad-more-${name}-${scheme}.png`) });
      await pg.keyboard.press('Escape');
      const [ch] = await Promise.all([pg.waitForEvent('filechooser'), btn(pg, 'Image').click()]);
      await ch.setFiles({ name: 'clip.png', mimeType: 'image/png', buffer: makePng(300, 300, true) });
      await pg.waitForFunction(() => !document.querySelector('.scratch-selbar')?.hidden);
      await pg.waitForTimeout(200);
      await pg.screenshot({ path: path.join(OUT, `pad-image-${name}-${scheme}.png`) });
      await chooseView(pg, 'Split');
      await pg.screenshot({ path: path.join(OUT, `pad-split-${name}-${scheme}.png`) });
      await chooseView(pg, 'Full page');
      await pg.screenshot({ path: path.join(OUT, `pad-full-${name}-${scheme}.png`) });
      await toolbarChecks(pg, `${name}/${scheme} full`);
      await btn(pg, 'Done').click();
      await pg.waitForFunction(() => !document.querySelector('.scratch'));
      if (name === 'phone' && scheme === 'light') {
        const mime = await pg.evaluate(async () => {
          const r = await import('./js/core/store/repo.js');
          return (await r.mediaRepo.byQid('DEMO-0001')).map((m) => m.mime);
        });
        check(mime.includes('image/png'), `transparent PNG kept as PNG (${mime.join(',')})`);
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
