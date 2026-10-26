#!/usr/bin/env node
/**
 * Visual + behaviour check for the ink tools (docs/ARCHITECTURE.md §7.7):
 * ink layers over [data-block] elements, toolbar, scratchpad.
 *
 * Serves an in-memory test page (never written to disk) with a few
 * [data-block] elements and drives it with Playwright (pre-installed):
 * - mouse strokes and dispatched pen PointerEvents with pressure
 * - persistence across reload (IndexedDB), undo/redo, eraser, highlighter, clear + undo
 * - two-finger touch never draws; palm rejection after a pen is seen
 * - stale ink (question version changed) is reported
 * - scratchpad zoom buttons, drawing, saving as block "scratch"
 * - screenshots of the toolbar and scratchpad: phone 390×844 and iPad 834×1194, light + dark
 *
 * Usage: node tests/visual/ink.mjs [--out <dir>]   (exit code 1 on failure)
 *
 * Dev-only. Never loaded by the app.
 *
 * @module tests/visual/ink
 */

import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../serve.mjs';

const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : path.join(os.tmpdir(), 'ink-visual');
const PAGE = 'tests/visual/ink-page.html';

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Ink test</title>
<link rel="stylesheet" href="../../css/tokens.css">
<link rel="stylesheet" href="../../css/base.css">
<link rel="stylesheet" href="../../css/components.css">
<link rel="stylesheet" href="../../css/ink.css">
<style>
  .q { max-width: 720px; margin: 0 auto; padding: 16px 16px 160px; }
  .q > div { margin: 0 0 16px; padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; line-height: 1.6; }
  .q h1 { font-size: var(--fs-l); margin: 0 0 12px; }
  .tall { height: 260px; }
</style>
<script type="module">
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const ink = await import('../../js/features/annotate/ink.js');
  const { createInkToolbar } = await import('../../js/features/annotate/ink-toolbar.js');
  const { openScratchpad } = await import('../../js/features/annotate/scratchpad.js');
  const { inkRepo } = await import('../../js/core/store/repo.js');
  const question = { id: 'DEMO-9001', version: Number(params.get('v') || 1) };
  const root = document.querySelector('.q');
  const ctrl = ink.initInk(root, question);
  const events = { stale: [], saved: 0, change: 0 };
  ctrl.on('stale', (p) => events.stale.push(p.blocks));
  ctrl.on('saved', () => { events.saved++; });
  ctrl.on('change', () => { events.change++; });
  let toolbar = null;
  if (params.get('toolbar') !== '0') {
    toolbar = createInkToolbar(ctrl, { onDone: () => ctrl.disable(), onScratchpad: () => openScratchpad(question) });
    document.body.append(toolbar);
  }
  await ctrl.ready;
  window.__ink = { ink, ctrl, inkRepo, question, events, openScratchpad, toolbar };
  document.body.dataset.ready = 'true';
</script>
</head>
<body>
  <main class="q">
    <h1>Sample question</h1>
    <div data-block="stem">Sample stem text for the drawing test. Alpha step, beta step, gamma step.</div>
    <div data-block="p1" class="tall">Second block with more neutral placeholder text so the layer is tall enough to draw on.</div>
    <div data-block="p2">Third block. <span data-block="choice-a">Inline choice text</span></div>
  </main>
  <div id="toast-slot" aria-live="polite"></div>
  <div id="sheet-slot"></div>
</body>
</html>`;

let failures = 0;
/**
 * @param {boolean} cond
 * @param {string} msg
 */
function check(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
}

/** @param {import('playwright').Page} page */
async function ready(page) {
  await page.waitForSelector('body[data-ready="true"]', { timeout: 10000 });
}

/** @param {import('playwright').Page} page @param {string} block */
async function stored(page, block) {
  return page.evaluate(async (b) => {
    await window.__ink.ctrl.flush();
    const rec = await window.__ink.inkRepo.get(window.__ink.question.id, b);
    return rec ? rec.strokes : [];
  }, block);
}

/** Box of a block's layer canvas. */
async function box(page, block) {
  return page.locator(`[data-block="${block}"] > canvas.ink-layer`).boundingBox();
}

/** Mouse stroke across a block (fractions of its box). */
async function mouseStroke(page, block, from, to, steps = 12) {
  const b = await box(page, block);
  await page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(b.x + b.width * (from[0] + (to[0] - from[0]) * t), b.y + b.height * (from[1] + (to[1] - from[1]) * t + Math.sin(t * 6) * 0.08));
  }
  await page.mouse.up();
}

/** Dispatches synthetic PointerEvents on a block's canvas. */
async function pointerStroke(page, block, { type = 'pen', id = 11, pressures = [0.2, 0.5, 0.9, 0.6, 0.3], y = 0.5 } = {}) {
  await page.evaluate(
    ({ block, type, id, pressures, y }) => {
      const c = document.querySelector(`[data-block="${block}"] > canvas.ink-layer`);
      const r = c.getBoundingClientRect();
      const fire = (name, i, p) =>
        c.dispatchEvent(
          new PointerEvent(name, {
            pointerId: id,
            pointerType: type,
            isPrimary: true,
            bubbles: true,
            cancelable: true,
            button: name === 'pointermove' ? -1 : 0,
            buttons: name === 'pointerup' ? 0 : 1,
            pressure: p,
            clientX: r.left + r.width * (0.15 + 0.7 * (i / (pressures.length - 1))),
            clientY: r.top + r.height * y,
          }),
        );
      fire('pointerdown', 0, pressures[0]);
      pressures.forEach((p, i) => fire('pointermove', i, p));
      fire('pointerup', pressures.length - 1, 0);
    },
    { block, type, id, pressures, y },
  );
}

/** Count non-transparent pixels on a block's canvas. */
async function inkedPixels(page, block) {
  return page.evaluate((b) => {
    const c = document.querySelector(`[data-block="${b}"] > canvas.ink-layer`);
    if (!c || !c.width || !c.height) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  }, block);
}

/** Loads the pre-installed Playwright (global install, found through NODE_PATH). */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return createRequire(import.meta.url)('playwright');
  }
}

async function main() {
  const { chromium } = await loadPlaywright();
  await mkdir(OUT, { recursive: true });
  const server = await startServer({ port: 0 });
  server.setOverride(PAGE, PAGE_HTML);
  const url = `${server.url}${PAGE}`;
  const browser = await chromium.launch();
  /** @type {string[]} */
  const consoleErrors = [];

  /** @param {object} opts */
  async function newPage(opts) {
    const context = await browser.newContext(opts);
    const page = await context.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    return { context, page };
  }

  try {
    /* ---------------- behaviour (phone, light) ---------------- */
    console.log('Behaviour (phone 390×844, light)');
    const { context, page } = await newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light', deviceScaleFactor: 2 });
    await page.goto(url);
    await ready(page);

    const layers = await page.locator('canvas.ink-layer').count();
    check(layers === 4, `one ink layer per [data-block] (${layers})`);
    check(
      (await page.locator('canvas.ink-layer[data-anchor-skip]').count()) === layers,
      'layers carry data-anchor-skip',
    );
    const pe = await page.$eval('[data-block="stem"] > canvas', (c) => getComputedStyle(c).pointerEvents);
    check(pe === 'none', 'disabled layers ignore input (pointer-events: none)');

    // Drawing while disabled does nothing.
    await mouseStroke(page, 'stem', [0.1, 0.3], [0.9, 0.6]);
    check((await stored(page, 'stem')).length === 0, 'no ink while disabled');

    await page.evaluate(() => window.__ink.ctrl.enable());
    const ta = await page.$eval('[data-block="stem"] > canvas', (c) => c.style.touchAction);
    check(ta === 'none', `fingers draw before any pen is seen (touch-action ${ta})`);

    // Two-finger touch never draws.
    await page.evaluate(() => {
      const c = document.querySelector('[data-block="p1"] > canvas');
      const r = c.getBoundingClientRect();
      const ev = (name, id, x, y, primary) =>
        c.dispatchEvent(new PointerEvent(name, { pointerId: id, pointerType: 'touch', isPrimary: primary, bubbles: true, cancelable: true, buttons: name === 'pointerup' ? 0 : 1, clientX: r.left + x, clientY: r.top + y }));
      ev('pointerdown', 21, 40, 40, true);
      ev('pointermove', 21, 60, 50, true);
      ev('pointerdown', 22, 140, 40, false);
      ev('pointermove', 21, 60, 20, true);
      ev('pointermove', 22, 140, 20, false);
      ev('pointerup', 22, 140, 20, false);
      ev('pointerup', 21, 60, 20, true);
    });
    check((await stored(page, 'p1')).length === 0, 'two-finger touch is a scroll, never a stroke');

    // One-finger touch draws (no pen seen yet).
    await pointerStroke(page, 'p1', { type: 'touch', id: 23, pressures: [0, 0, 0, 0, 0], y: 0.8 });
    let p1 = await stored(page, 'p1');
    check(p1.length === 1 && p1[0].tool === 'pen', 'one-finger touch draws while no pen was seen');

    // Mouse stroke.
    await mouseStroke(page, 'stem', [0.1, 0.3], [0.9, 0.6]);
    let stem = await stored(page, 'stem');
    check(stem.length === 1, 'mouse stroke saved to IndexedDB');
    const pts = stem[0]?.pts || [];
    check(pts.length >= 9 && pts.length % 3 === 0, `stroke has x,y,p triples (${pts.length / 3} points)`);
    check(
      pts.every((v, i) => (i % 3 === 2 ? v >= 0 && v <= 1 : v >= -0.1 && v <= 1.1) && Math.round(v * 10000) / 10000 === v),
      'coordinates are fractions rounded to 4 decimals',
    );
    check(stem[0]?.color === '#1d4ed8' && Math.abs(stem[0].size - 0.006 * (358 / 358)) < 0.003, 'default colour and size');
    check((await inkedPixels(page, 'stem')) > 100, 'stroke is rendered on the layer');

    // Pen with pressure.
    await pointerStroke(page, 'p1', { type: 'pen', id: 31, pressures: [0.1, 0.4, 0.95, 0.95, 0.5, 0.2] });
    p1 = await stored(page, 'p1');
    const penStroke = p1[1];
    const pressures = penStroke ? penStroke.pts.filter((_, i) => i % 3 === 2) : [];
    check(p1.length === 2 && Math.max(...pressures) - Math.min(...pressures) > 0.3, `pen pressure is recorded (${pressures.join(', ')})`);
    const ta2 = await page.$eval('[data-block="stem"] > canvas', (c) => c.style.touchAction);
    check(ta2 === 'manipulation', `after a pen is seen, touch scrolls (touch-action ${ta2})`);
    await pointerStroke(page, 'p1', { type: 'touch', id: 32, pressures: [0, 0, 0, 0, 0], y: 0.3 });
    check((await stored(page, 'p1')).length === 2, 'palm rejection: touch no longer draws');

    // Undo / redo via toolbar.
    const undo = page.getByRole('button', { name: 'Undo' });
    const redo = page.getByRole('button', { name: 'Redo' });
    check(await redo.isDisabled(), 'Redo disabled with nothing to redo');
    await undo.click();
    check((await stored(page, 'p1')).length === 1, 'Undo removes the last stroke');
    await redo.click();
    check((await stored(page, 'p1')).length === 2, 'Redo puts it back');

    // Highlighter (via the toolbar).
    await page.getByRole('button', { name: 'Highlighter' }).click();
    check((await page.getByRole('button', { name: 'Highlighter' }).getAttribute('aria-pressed')) === 'true', 'Highlighter shows pressed');
    await mouseStroke(page, 'p2', [0.05, 0.5], [0.95, 0.5], 8);
    const p2 = await stored(page, 'p2');
    check(p2.length === 1 && p2[0].tool === 'hl', 'highlighter stroke saved with tool "hl"');
    check(p2[0] && p2[0].size > stem[0].size * 3, 'highlighter is wide');
    const savedTool = await page.evaluate(async () => (await window.__ink.inkRepo && (await import('../../js/core/settings.js')).getSetting('inkTool')));
    check(savedTool === 'hl', 'last tool remembered in settings');

    // Colour + size from the popover.
    await page.getByRole('button', { name: 'Colour, size and more' }).click();
    await page.getByRole('button', { name: 'Red', exact: true }).click();
    check((await page.getByRole('button', { name: 'Colour, size and more' }).getAttribute('aria-expanded')) === 'false', 'popover closes after picking a colour');
    const state = await page.evaluate(() => window.__ink.ctrl.getState());
    check(state.color === '#dc2626' && state.tool === 'hl', 'colour picked, tool kept');

    // Eraser removes whole strokes it touches.
    await page.getByRole('button', { name: 'Eraser' }).click();
    await mouseStroke(page, 'stem', [0.5, 0.05], [0.5, 0.95], 10);
    check((await stored(page, 'stem')).length === 0, 'eraser removed the stroke it touched');
    await undo.click();
    check((await stored(page, 'stem')).length === 1, 'Undo brings the erased stroke back');

    // Clear all (undoable).
    await page.getByRole('button', { name: 'Colour, size and more' }).click();
    await page.getByRole('button', { name: 'Clear all' }).click();
    check((await stored(page, 'stem')).length === 0 && (await stored(page, 'p1')).length === 0, 'Clear all empties every layer');
    const toastText = await page.locator('#toast-slot').innerText();
    check(/Drawing cleared/.test(toastText), 'undo toast shown after clear');
    await undo.click();
    check((await stored(page, 'stem')).length === 1 && (await stored(page, 'p1')).length === 2, 'Undo restores everything after clear');

    // Reload: ink persists and renders.
    await page.reload();
    await ready(page);
    check((await inkedPixels(page, 'stem')) > 100 && (await inkedPixels(page, 'p1')) > 100, 'ink restored and rendered after reload');
    const restored = await page.evaluate(() => window.__ink.ctrl.getState());
    check(restored.tool === 'eraser' && restored.color === '#dc2626', 'toolbar restored last tool and colour');
    check((await page.evaluate(() => window.__ink.events.stale.length)) === 0, 'no stale ink for the same version');

    // Stale: same question, new version.
    await page.goto(`${url}?v=2`);
    await ready(page);
    await page.waitForTimeout(50);
    const stale = await page.evaluate(() => window.__ink.ctrl.staleBlocks());
    check(stale.join(',') === 'p1,p2,stem', `ink from an older version is still shown and reported stale (${stale})`);
    check((await inkedPixels(page, 'stem')) > 100, 'stale ink is still visible');
    await page.goto(url);
    await ready(page);

    // Resize keeps ink aligned (fractions).
    await page.setViewportSize({ width: 834, height: 1194 });
    await page.waitForTimeout(150);
    const wide = await page.$eval('[data-block="stem"] > canvas', (c) => ({ w: c.width, cw: c.clientWidth }));
    check(wide.w === Math.round(wide.cw * 2), `layer resized with devicePixelRatio (${wide.w} for ${wide.cw}px)`);
    await page.setViewportSize({ width: 390, height: 844 });

    // Block re-render: layer comes back automatically.
    await page.evaluate(() => {
      const el = document.querySelector('[data-block="p2"]');
      el.replaceChildren(document.createTextNode('Re-rendered third block.'));
    });
    await page.waitForTimeout(100);
    check((await page.locator('[data-block="p2"] > canvas.ink-layer').count()) === 1, 'layer re-attached after the block re-rendered');

    // Scratchpad.
    await page.evaluate(() => window.__ink.ctrl.enable());
    await page.getByRole('button', { name: 'Colour, size and more' }).click();
    await page.getByRole('button', { name: 'Scratchpad' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const zoomValue = () => page.locator('.scratch-zoom-value').innerText();
    check((await zoomValue()) === '100%', 'scratchpad opens at 100%');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    check((await zoomValue()) === '125%', 'Zoom in → 125%');
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Zoom out' }).click();
    check((await zoomValue()) === '80%', 'Zoom out twice → 80%');
    await page.locator('.scratch-zoom-reset').click();
    check((await zoomValue()) === '100%', 'Reset → 100%');
    await page.locator('.scratch .ink-toolbar').getByRole('button', { name: 'Pen' }).click();
    const vb = await page.locator('.scratch-viewport').boundingBox();
    await page.mouse.move(vb.x + 60, vb.y + 100);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(vb.x + 60 + i * 20, vb.y + 100 + Math.sin(i) * 30);
    await page.mouse.up();
    check(
      (await page.locator('.scratch .ink-toolbar [aria-label="Scratchpad"]').count()) === 0,
      'no scratchpad button inside the scratchpad',
    );
    await page.locator('.scratch .ink-tb-done').click();
    await page.waitForTimeout(500);
    const scratch = await page.evaluate(async () => {
      const r = await window.__ink.inkRepo.get(window.__ink.question.id, 'scratch');
      return r ? r.strokes : [];
    });
    check(scratch.length === 1 && scratch[0].pts[0] > 0.02 && scratch[0].pts[0] < 0.05, 'scratch stroke saved as block "scratch" in page fractions');
    check((await page.getByRole('dialog').count()) === 0, 'Done closes the scratchpad');
    await context.close();

    /* ---------------- screenshots ---------------- */
    console.log('Screenshots');
    for (const [name, viewport] of [
      ['phone', { width: 390, height: 844 }],
      ['ipad', { width: 834, height: 1194 }],
      ['wide', { width: 1194, height: 834 }],
    ]) {
      for (const scheme of ['light', 'dark']) {
        if (name === 'wide' && scheme === 'dark') continue;
        const { context: ctx, page: pg } = await newPage({ viewport, colorScheme: scheme, deviceScaleFactor: 2 });
        await pg.goto(url);
        await ready(pg);
        await pg.evaluate(() => window.__ink.ctrl.enable());
        const overflow = await pg.evaluate(() => {
          const t = document.querySelector('.ink-toolbar');
          return { scroll: document.documentElement.scrollWidth, vw: innerWidth, tb: t.scrollWidth, tbw: t.clientWidth };
        });
        check(overflow.scroll <= overflow.vw && overflow.tb <= overflow.tbw, `${name}/${scheme}: no horizontal overflow (${JSON.stringify(overflow)})`);
        const small = await pg.$$eval('.ink-toolbar button', (bs) =>
          bs.filter((b) => b.offsetParent !== null).filter((b) => b.offsetWidth < 44 || b.offsetHeight < 44).map((b) => b.getAttribute('aria-label') || b.textContent),
        );
        check(small.length === 0, `${name}/${scheme}: all toolbar targets ≥ 44px ${small.join(', ')}`);
        await pg.screenshot({ path: path.join(OUT, `toolbar-${name}-${scheme}.png`) });
        if (await pg.locator('.ink-tb-style').isVisible()) {
          await pg.locator('.ink-tb-style').click();
          const pb = await pg.locator('.ink-tb-panel').boundingBox();
          check(pb.x >= 0 && pb.x + pb.width <= viewport.width, `${name}/${scheme}: popover fits on screen`);
          await pg.screenshot({ path: path.join(OUT, `toolbar-${name}-${scheme}-popover.png`) });
          await pg.keyboard.press('Escape');
        }
        await pg.evaluate(() => window.__ink.openScratchpad(window.__ink.question));
        await pg.getByRole('dialog').waitFor();
        await pg.waitForTimeout(450);
        await pg.screenshot({ path: path.join(OUT, `scratchpad-${name}-${scheme}.png`) });
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const realErrors = consoleErrors.filter((e) => !/favicon/.test(e));
  check(realErrors.length === 0, `no console errors${realErrors.length ? `: ${realErrors.join(' | ')}` : ''}`);
  console.log(`\nScreenshots: ${OUT}`);
  console.log(failures ? `${failures} check(s) failed` : 'All ink checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
