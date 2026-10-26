#!/usr/bin/env node
/**
 * Visual check for the explanation renderer (dev-only, never loaded by the app).
 *
 * Serves the repo with tests/serve.mjs on a random port, opens
 * tests/fixtures/explain.html at phone (390×844) and iPad (834×1194) sizes in
 * light and dark, saves full-page screenshots, and asserts basic layout facts:
 * - no console errors or page errors (the deliberately broken image's 404 is expected),
 * - no horizontal page overflow,
 * - every block element has `data-block` (unless deliberately id-less) and `class="xb xb-<type>"`,
 * - wide tables scroll inside their own frame, sticky first column stays in view,
 * - flow / mind-map layouts switch with the container width,
 * - the image viewer opens, zooms and closes with Esc.
 *
 * Usage: node tests/visual/render.mjs [--out <dir>]
 * Default output folder: $TMPDIR/explain-shots (or ./explain-shots when unset).
 * Exit code 1 on any failure.
 *
 * @module tests/visual/render
 */

import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../serve.mjs';

// Playwright is pre-installed globally; require() honours NODE_PATH, ESM import does not.
const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(os.tmpdir(), 'explain-shots'));

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'ipad', width: 834, height: 1194 },
];
const SCHEMES = /** @type {const} */ (['light', 'dark']);
const BLOCK_TYPES = ['heading', 'p', 'list', 'table', 'flow', 'mindmap', 'callout', 'quote', 'image'];

/** @type {string[]} */
const failures = [];

/**
 * @param {boolean} cond
 * @param {string} message
 */
function check(cond, message) {
  if (!cond) failures.push(message);
}

const server = await startServer({ port: 0 });
const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

try {
  for (const vp of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      const tag = `${vp.name}-${scheme}`;
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        colorScheme: scheme,
        hasTouch: vp.name === 'phone',
      });
      const page = await context.newPage();
      /** @type {string[]} */
      const errors = [];
      page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        // The gallery's broken-image sample 404s on purpose.
        if (/Failed to load resource.*404/.test(text) && /not-here\.webp/.test(msg.location()?.url || '')) return;
        errors.push(`console.error: ${text} (${msg.location()?.url || ''})`);
      });

      await page.goto(`${server.url}tests/fixtures/explain.html`, { waitUntil: 'load' });
      await page.waitForSelector('body[data-ready="true"]');
      // Load every lazy image (and let the broken one fail) before measuring.
      await page.evaluate(async () => {
        for (const img of document.querySelectorAll('img')) img.loading = 'eager';
        await new Promise((r) => setTimeout(r, 300));
      });
      await page.waitForTimeout(200);

      const facts = await page.evaluate((types) => {
        const doc = document.documentElement;
        const blocks = [...document.querySelectorAll('.explain > *')];
        const badClass = blocks.filter((el) => {
          const type = [...el.classList].find((c) => c.startsWith('xb-') && types.includes(c.slice(3)));
          return !el.classList.contains('xb') || !type;
        }).map((el) => el.className);
        const missingBlock = blocks.filter((el) => !el.hasAttribute('data-block')).map((el) => el.textContent.slice(0, 40));
        const notRelative = blocks.filter((el) => getComputedStyle(el).position !== 'relative').length;
        const byType = Object.fromEntries(types.map((t) => [t, document.querySelectorAll(`.explain > .xb-${t}`).length]));

        const wide = document.querySelector('[data-block="t3"] .xb-table-scroll');
        const wideScrolls = wide ? wide.scrollWidth > wide.clientWidth + 1 : false;
        let stickyOk = null;
        if (wide && wideScrolls) {
          wide.scrollLeft = 200;
          const cell = wide.querySelector('tbody tr th');
          stickyOk = Math.abs(cell.getBoundingClientRect().left - wide.getBoundingClientRect().left) < 2;
          wide.scrollLeft = 0;
        }
        const f2Row = document.querySelector('[data-block="f2"] .xb-flow-branches');
        const narrowRow = document.querySelector('[data-block="n1"] .xb-flow-branches');
        const m2 = document.querySelector('[data-block="m2"] .xb-mm-branches');
        const n2 = document.querySelector('[data-block="n2"] .xb-mm-branches');
        const brokenFallback = !!document.querySelector('[data-block="i2"] .xb-img-error');
        const unsafeFallback = !!document.querySelector('[data-block="i3"] .xb-img-error');
        const unsafeImg = !!document.querySelector('img[src^="javascript:"]');
        const badSkip = [...document.querySelectorAll('[data-block] svg, .xb-callout-kind')]
          .filter((el) => !el.closest('[data-anchor-skip]')).length;
        const smallTargets = [...document.querySelectorAll('.explain button')]
          .filter((b) => { const r = b.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).length;
        return {
          overflowX: doc.scrollWidth - doc.clientWidth,
          blocks: blocks.length,
          badClass,
          missingBlock,
          notRelative,
          byType,
          wideScrolls,
          stickyOk,
          f2Display: f2Row ? getComputedStyle(f2Row).display : null,
          narrowDisplay: narrowRow ? getComputedStyle(narrowRow).display : null,
          m2Display: m2 ? getComputedStyle(m2).display : null,
          n2Display: n2 ? getComputedStyle(n2).display : null,
          brokenFallback,
          unsafeFallback,
          unsafeImg,
          badSkip,
          smallTargets,
        };
      }, BLOCK_TYPES);

      check(facts.overflowX <= 0, `${tag}: horizontal page overflow of ${facts.overflowX}px`);
      check(facts.badClass.length === 0, `${tag}: blocks without "xb xb-<type>": ${JSON.stringify(facts.badClass)}`);
      // Exactly two blocks in the gallery are deliberately without a usable id (no id, duplicate id).
      check(facts.missingBlock.length === 2, `${tag}: expected 2 id-less blocks, got ${JSON.stringify(facts.missingBlock)}`);
      check(facts.notRelative === 0, `${tag}: ${facts.notRelative} blocks are not position: relative`);
      for (const t of BLOCK_TYPES) check(facts.byType[t] > 0, `${tag}: no rendered block of type ${t}`);
      check(facts.wideScrolls, `${tag}: wide table does not scroll inside its frame`);
      check(facts.stickyOk !== false, `${tag}: sticky first column moved while scrolling`);
      check(facts.narrowDisplay === 'flex', `${tag}: 3 branches in a 340px column should stack (got ${facts.narrowDisplay})`);
      check(facts.f2Display === 'grid', `${tag}: 2 branches should sit side by side (got ${facts.f2Display})`);
      check(facts.n2Display === 'flex', `${tag}: mind map in a 340px column should stack (got ${facts.n2Display})`);
      check(facts.m2Display === (vp.name === 'ipad' ? 'grid' : 'flex'), `${tag}: mind map layout ${facts.m2Display} unexpected`);
      check(facts.brokenFallback, `${tag}: broken image did not show its placeholder`);
      check(facts.unsafeFallback && !facts.unsafeImg, `${tag}: unsafe image src was not blocked`);
      check(facts.badSkip === 0, `${tag}: ${facts.badSkip} decorations inside blocks lack data-anchor-skip`);
      check(facts.smallTargets === 0, `${tag}: ${facts.smallTargets} buttons smaller than 44×44`);

      await page.screenshot({ path: path.join(OUT, `${tag}.png`), fullPage: true });
      for (const sec of ['tables', 'flows', 'mind-maps', 'callouts']) {
        const el = page.locator(`#sec-${sec}`);
        await el.screenshot({ path: path.join(OUT, `${tag}-${sec}.png`) });
      }

      // Image viewer: open, zoom in, close with Esc, focus returns.
      if (scheme === 'light') {
        const btn = page.locator('[data-block="i1"] .xb-img-btn');
        await btn.scrollIntoViewIfNeeded();
        await btn.click();
        const dialog = page.locator('.sheet[role="dialog"]');
        await dialog.waitFor({ state: 'visible' });
        await page.waitForTimeout(450);
        await page.locator('.xb-viewer button[aria-label="Zoom in"]').click();
        const zoom = await page.locator('.xb-viewer-zoom').textContent();
        check(zoom === '150%', `${tag}: zoom in should show 150% (got ${zoom})`);
        await page.screenshot({ path: path.join(OUT, `${tag}-viewer.png`) });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached', timeout: 2000 }).catch(() => check(false, `${tag}: viewer did not close on Esc`));
        const focused = await page.evaluate(() => document.activeElement?.classList.contains('xb-img-btn'));
        check(focused, `${tag}: focus did not return to the image after closing the viewer`);
      }

      check(errors.length === 0, `${tag}: ${errors.join(' | ')}`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`Explanation visual check: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
process.stdout.write(`Explanation visual check passed. Screenshots: ${OUT}\n`);
