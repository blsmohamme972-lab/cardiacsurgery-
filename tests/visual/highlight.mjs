#!/usr/bin/env node
/**
 * Browser check for highlights (js/features/annotate/highlight.js + anchor.js).
 *
 * Builds an in-memory test page (served at tests/fixtures/hl.html through a
 * server override, never written to disk) with a stem, choices, a choice note
 * and a few explanation blocks, then checks in Chromium:
 * select → colour → saved; reload → mark is back (IndexedDB); tap → remove →
 * Undo; cross-block selection clipped to the first block; orphan detection;
 * version healing; store:change from other code; re-render re-apply; keyboard
 * (Tab into the bar, arrows, Esc); highlightSelection(); touch placement below
 * the selection. Optional screenshots of the floating bar (phone/iPad, light/dark).
 *
 *   node tests/visual/highlight.mjs [--shots <dir>]
 *
 * Exit code 1 on any failure. Dev-only.
 *
 * @module tests/visual/highlight
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startServer } from '../serve.mjs';

// The pre-installed Playwright is a global package: resolve it the CommonJS way (NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');

const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg !== -1 ? path.resolve(process.argv[shotsArg + 1]) : null;
const FIXTURE = 'tests/fixtures/hl.html';

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Highlight fixture</title>
  <link rel="stylesheet" href="../../css/tokens.css">
  <link rel="stylesheet" href="../../css/base.css">
  <link rel="stylesheet" href="../../css/components.css">
  <link rel="stylesheet" href="../../css/annotate.css">
  <style>
    body { background: var(--bg); color: var(--text); font-size: var(--fs-m); line-height: var(--lh-body); }
    .fx { max-width: var(--maxw); margin: 0 auto; padding: var(--sp-4); display: grid; gap: var(--sp-4); }
    .fx-choice { display: flex; gap: var(--sp-3); width: 100%; text-align: left; padding: var(--sp-3);
      border: 1px solid var(--border); border-radius: var(--r-m); background: var(--surface);
      -webkit-user-select: text; user-select: text; }
    .fx-letter { font-weight: 700; }
    .fx table { border-collapse: collapse; } .fx td, .fx th { border: 1px solid var(--border); padding: 4px 8px; }
  </style>
</head>
<body>
  <main id="main" class="fx"></main>
  <div id="toast-slot" class="toast-slot" aria-live="polite"></div>
  <script type="module">
    import { h } from '../../js/core/dom.js';
    import { initSettings } from '../../js/core/settings.js';
    import { renderStem, renderBlocks, renderInline } from '../../js/features/explain/render.js';
    import { initHighlights, highlightSelection } from '../../js/features/annotate/highlight.js';
    import { highlightsRepo } from '../../js/core/store/repo.js';

    const question = {
      id: 'DEMO-9001', version: 2,
      stem: 'Sample stem: the **Alpha step** comes first, then the Beta step, and finally the Gamma step. Which step comes first?',
      choices: [{ id: 'a', text: 'Alpha step' }, { id: 'b', text: 'Beta step' }, { id: 'c', text: 'Gamma step' }],
      choiceNotes: { b: 'Beta step is second in the sample order.' },
      answer: 'a',
      explanation: [
        { id: 'h1', type: 'heading', text: 'Sample order' },
        { id: 'p1', type: 'p', text: 'The Alpha step always opens the sample sequence. It prepares the ground for every later step.' },
        { id: 'l1', type: 'list', items: ['Alpha step: first', 'Beta step: second', 'Gamma step: third'] },
        { id: 't1', type: 'table', head: ['Step', 'Order'], rows: [['Alpha', 'First'], ['Beta', 'Second']] },
        { id: 'c1', type: 'callout', kind: 'pearl', text: 'Remember: A before B before C.' },
      ],
    };

    const orphans = [];
    let explainEl = null;
    function render() {
      const main = document.getElementById('main');
      explainEl = renderBlocks(question.explanation, { qid: question.id });
      main.replaceChildren(
        renderStem(question),
        h('div', { class: 'fx-choices' }, question.choices.map((c, i) =>
          h('button', { type: 'button', class: 'fx-choice', dataset: { choice: c.id } },
            h('span', { class: 'fx-letter', 'data-anchor-skip': '' }, 'ABC'[i]),
            h('span', { dataset: { block: 'choice-' + c.id } }, renderInline(c.text))))),
        h('p', { class: 'fx-note', dataset: { block: 'note-b' } }, renderInline(question.choiceNotes.b)),
        explainEl,
      );
    }

    await initSettings();
    render();
    const main = document.getElementById('main');
    const ctrl = initHighlights(main, question, { onOrphans: (list) => orphans.push(list) });
    window.__hl = {
      ctrl, orphans, question, highlightsRepo, highlightSelection,
      rerenderExplanation() { const fresh = renderBlocks(question.explanation, { qid: question.id }); explainEl.replaceWith(fresh); explainEl = fresh; },
    };
    window.__ready = true;
  </script>
</body>
</html>`;

let failures = 0;
const consoleErrors = [];

/** @param {boolean} cond @param {string} msg */
function check(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${msg}`);
  }
}

/** Selects `quote` (first occurrence) in a block; optionally extends to `endQuote` in `endBlock`. */
async function select(page, block, quote, endBlock, endQuote) {
  await page.evaluate(
    async ([block, quote, endBlock, endQuote]) => {
      const { rangeFromOffsets, blockText } = await import('../../js/features/annotate/anchor.js');
      const el = document.querySelector(`[data-block="${block}"]`);
      const s = blockText(el).indexOf(quote);
      const r = rangeFromOffsets(el, s, s + quote.length);
      if (endBlock) {
        const el2 = document.querySelector(`[data-block="${endBlock}"]`);
        const e = blockText(el2).indexOf(endQuote) + endQuote.length;
        const r2 = rangeFromOffsets(el2, e, e);
        r.setEnd(r2.endContainer, r2.endOffset);
      }
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    },
    [block, quote, endBlock, endQuote],
  );
}

const barVisible = '.hl-bar:not([hidden])';

async function open(context, server) {
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.goto(server.url + FIXTURE);
  await page.waitForFunction(() => window.__ready === true);
  await page.waitForTimeout(100);
  return page;
}

async function main() {
  const server = await startServer({ port: 0 });
  server.setOverride(FIXTURE, FIXTURE_HTML);
  const browser = await chromium.launch();
  try {
    // ------------------------------------------------------------ functional (desktop mouse)
    console.log('Functional checks');
    const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
    let page = await open(context, server);

    await select(page, 'p1', 'Alpha step always');
    await page.waitForSelector(barVisible, { timeout: 2000 });
    const order = await page.$$eval('.hl-bar .hl-swatch', (els) => els.map((e) => e.dataset.color));
    check(order[0] === 'yellow' && order.length === 4, `bar shows 4 colours, remembered first (${order.join(',')})`);
    check(await page.$('.hl-bar .hl-copy') !== null, 'bar has Copy');
    check(!(await page.textContent('.hl-bar')).includes('null'), 'bar has no stray text');
    // Mouse: bar above the selection.
    const geo = await page.evaluate(() => {
      const r = getSelection().getRangeAt(0).getBoundingClientRect();
      const b = document.querySelector('.hl-bar').getBoundingClientRect();
      return { selTop: r.top, barBottom: b.bottom };
    });
    check(geo.barBottom <= geo.selTop, 'mouse: bar sits above the selection');

    await page.click('.hl-bar [data-color="green"]');
    await page.waitForSelector('mark.uhl.uhl-green');
    let markText = await page.$$eval('[data-block="p1"] mark.uhl', (ms) => ms.map((m) => m.textContent).join(''));
    check(markText === 'Alpha step always', `mark wraps the selection ("${markText}")`);
    check(await page.$(barVisible) === null, 'bar hides after choosing a colour');
    check((await page.evaluate(() => getSelection().isCollapsed)) === true, 'selection cleared after highlighting');
    await page.waitForTimeout(150);
    const stored = await page.evaluate(() => window.__hl.highlightsRepo.byQid('DEMO-9001'));
    check(stored.length === 1 && stored[0].block === 'p1' && stored[0].color === 'green' && stored[0].qversion === 2 &&
      stored[0].quote === 'Alpha step always' && !String(stored[0].id).startsWith('tmp-'), 'saved to IndexedDB with block, colour, qversion');

    // Highlight across inline markup in the stem (strong) splits safely.
    await select(page, 'stem', 'the Alpha step comes');
    await page.waitForSelector(barVisible);
    const order2 = await page.$$eval('.hl-bar .hl-swatch', (els) => els.map((e) => e.dataset.color));
    check(order2[0] === 'green', 'last used colour is shown first next time');
    await page.click('.hl-bar [data-color="pink"]');
    await page.waitForSelector('[data-block="stem"] mark.uhl-pink');
    const stemMarks = await page.$$eval('[data-block="stem"] mark.uhl', (ms) => ms.map((m) => m.textContent));
    check(stemMarks.join('') === 'the Alpha step comes' && stemMarks.length >= 2, `stem highlight split across <strong> (${JSON.stringify(stemMarks)})`);
    check(await page.$eval('[data-block="stem"] strong', (s) => s.textContent) === 'Alpha step', 'author markup kept intact');

    // Reload → marks are back.
    await page.reload();
    await page.waitForFunction(() => window.__ready === true);
    await page.waitForSelector('[data-block="p1"] mark.uhl-green', { timeout: 3000 });
    markText = await page.$$eval('[data-block="p1"] mark.uhl', (ms) => ms.map((m) => m.textContent).join(''));
    check(markText === 'Alpha step always', 'after reload the highlight is re-applied');
    check(await page.$('[data-block="stem"] mark.uhl-pink') !== null, 'after reload the stem highlight is re-applied');

    // Tap → edit bar → change colour → remove → undo.
    await page.click('[data-block="p1"] mark.uhl');
    await page.waitForSelector('.hl-bar[data-mode="edit"]:not([hidden])');
    check(await page.$('.hl-bar .hl-remove') !== null, 'edit bar has Remove');
    check(await page.$eval('.hl-bar [data-color="green"]', (b) => b.getAttribute('aria-pressed')) === 'true', 'current colour is marked pressed');
    check(await page.$('[data-block="p1"] mark.uhl.is-active') !== null, 'tapped highlight is outlined');
    await page.click('.hl-bar [data-color="blue"]');
    await page.waitForSelector('[data-block="p1"] mark.uhl-blue');
    check(true, 'colour changed to blue');
    await page.click('.hl-bar .hl-remove');
    await page.waitForFunction(() => !document.querySelector('[data-block="p1"] mark.uhl'));
    check(true, 'remove takes the mark away');
    await page.waitForSelector('.toast-action');
    check((await page.textContent('.toast-msg'))?.includes('Highlight removed'), 'undo toast shown');
    await page.click('.toast-action');
    await page.waitForSelector('[data-block="p1"] mark.uhl-blue');
    await page.waitForTimeout(150);
    check((await page.evaluate(() => window.__hl.highlightsRepo.byQid('DEMO-9001'))).some((r) => r.block === 'p1' && r.color === 'blue'),
      'undo restores it in storage');
    const stemP = await page.evaluate(() => document.querySelector('[data-block="p1"]').textContent);
    check(stemP.startsWith('The Alpha step always opens'), 'block text unchanged after remove/undo');

    // Cross-block selection: clipped to the first block.
    await select(page, 'p1', 'prepares the ground', 'l1', 'Beta step');
    await page.waitForSelector(barVisible);
    await page.click('.hl-bar [data-color="yellow"]');
    await page.waitForSelector('[data-block="p1"] mark.uhl-yellow');
    const p1y = await page.$$eval('[data-block="p1"] mark.uhl-yellow', (ms) => ms.map((m) => m.textContent).join(''));
    check(p1y === 'prepares the ground for every later step.', `cross-block selection clipped to first block ("${p1y}")`);
    check((await page.$$('[data-block="l1"] mark.uhl')).length === 0, 'nothing highlighted in the second block');

    // Selection inside a table cell and the choice inside a button.
    await select(page, 't1', 'Second');
    await page.waitForSelector(barVisible);
    await page.click('.hl-bar [data-color="yellow"]');
    await page.waitForSelector('[data-block="t1"] mark.uhl');
    check(await page.$eval('[data-block="t1"] mark.uhl', (m) => m.parentElement.tagName) === 'TD', 'table highlight stays inside the cell');
    await select(page, 'choice-b', 'Beta');
    await page.waitForSelector(barVisible);
    await page.click('.hl-bar [data-color="pink"]');
    await page.waitForSelector('[data-block="choice-b"] mark.uhl-pink');
    check((await page.$eval('[data-block="choice-b"]', (e) => e.textContent)) === 'Beta step', 'choice highlight keeps the choice text');
    check((await page.$eval('[data-block="choice-b"] mark.uhl', (m) => m.tabIndex)) === -1, 'no tab stop for highlights inside a choice button');
    // Selecting inside that highlight shows the edit bar (the way to remove it).
    await select(page, 'choice-b', 'et');
    await page.waitForSelector('.hl-bar[data-mode="edit"]:not([hidden])');
    check(true, 'selection inside a highlight opens the edit bar');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.hl-bar').hidden);
    check(true, 'Esc closes the bar');
    await page.evaluate(() => getSelection().removeAllRanges());

    // Selection starting on UI chrome (letter badge) → clipped into the block.
    const letterSnap = await page.evaluate(async () => {
      const badge = document.querySelector('[data-choice="c"] .fx-letter');
      const block = document.querySelector('[data-block="choice-c"]');
      const r = document.createRange();
      r.setStart(badge.firstChild, 0);
      r.setEnd(block.firstChild, 5);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return true;
    });
    await page.waitForSelector(barVisible);
    await page.click('.hl-bar [data-color="green"]');
    await page.waitForSelector('[data-block="choice-c"] mark.uhl');
    check(letterSnap && (await page.$eval('[data-block="choice-c"] mark.uhl', (m) => m.textContent)) === 'Gamma',
      'selection that starts on a letter badge highlights only block text');
    check((await page.$eval('[data-choice="c"] .fx-letter', (e) => e.textContent)) === 'C', 'letter badge untouched');

    // Keyboard: Tab into the bar, arrows move, Esc returns.
    await select(page, 'c1', 'Remember');
    await page.waitForSelector(barVisible);
    await page.keyboard.press('Tab');
    check(await page.evaluate(() => document.activeElement?.classList.contains('hl-swatch')), 'Tab moves focus into the bar');
    const before = await page.evaluate(() => document.activeElement?.dataset.color);
    await page.keyboard.press('ArrowRight');
    const after = await page.evaluate(() => document.activeElement?.dataset.color);
    check(Boolean(after) && after !== before, `ArrowRight moves within the bar (${before} → ${after})`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-block="c1"] mark.uhl');
    check(true, 'Enter on a colour saves the highlight');
    // Enter on a focusable highlight opens the edit bar.
    await page.focus('[data-block="c1"] mark.uhl[tabindex="0"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.hl-bar[data-mode="edit"]:not([hidden])');
    check(await page.evaluate(() => document.querySelector('.hl-bar').contains(document.activeElement)), 'Enter on a highlight opens the bar with focus in it');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => document.activeElement?.matches('mark.uhl')), 'Esc returns focus to the highlight');

    // highlightSelection() helper (bottom-bar button).
    await select(page, 'l1', 'Gamma step: third');
    await page.waitForSelector(barVisible);
    const used = await page.evaluate(() => window.__hl.highlightSelection('blue'));
    await page.waitForSelector('[data-block="l1"] mark.uhl-blue');
    check(used === true, 'highlightSelection() highlights the current selection');
    check((await page.evaluate(() => window.__hl.highlightSelection())) === false, 'highlightSelection() → false without a selection');

    // Re-render (question view re-renders the explanation) → marks re-applied automatically.
    await page.evaluate(() => window.__hl.rerenderExplanation());
    await page.waitForSelector('[data-block="p1"] mark.uhl-blue');
    check(true, 're-rendered explanation gets its highlights back');

    // store:change from other code (e.g. backup import) → shows without refresh().
    await page.evaluate(() => window.__hl.highlightsRepo.add({
      qid: 'DEMO-9001', qversion: 2, block: 'note-b', quote: 'second', prefix: 'Beta step is ', suffix: ' in the sample order.', start: 13, color: 'yellow',
    }));
    await page.waitForSelector('[data-block="note-b"] mark.uhl', { timeout: 2000 });
    check(true, 'store:change from elsewhere refreshes highlights');

    // Orphans + version healing.
    await page.evaluate(async () => {
      const r = window.__hl.highlightsRepo;
      await r.add({ qid: 'DEMO-9001', qversion: 1, block: 'p1', quote: 'Removed sentence', prefix: '', suffix: '', start: 0, color: 'pink' });
      await r.add({ qid: 'DEMO-9001', qversion: 1, block: 'gone-block', quote: 'Old', prefix: '', suffix: '', start: 0, color: 'blue' });
      await r.add({ qid: 'DEMO-9001', qversion: 1, block: 'h1', quote: 'order', prefix: 'Sample ', suffix: '', start: 7, color: 'green' });
      await window.__hl.ctrl.refresh();
    });
    await page.waitForTimeout(300);
    const lastOrphans = await page.evaluate(() => window.__hl.orphans.at(-1) || []);
    check(lastOrphans.length === 2 && lastOrphans.some((o) => o.block === 'gone-block') && lastOrphans.some((o) => o.quote === 'Removed sentence'),
      `orphans reported (${lastOrphans.map((o) => o.block).join(',')})`);
    check(await page.$('[data-block="h1"] mark.uhl-green') !== null, 'highlight from an older version that still matches is applied');
    const healed = await page.evaluate(async () => (await window.__hl.highlightsRepo.byQid('DEMO-9001')).find((r) => r.block === 'h1'));
    check(healed?.qversion === 2, 'matching highlight is moved to the new question version');

    // Nothing leaks after destroy.
    await page.evaluate(() => window.__hl.ctrl.destroy());
    check((await page.$('.hl-bar')) === null, 'destroy removes the bar');
    await select(page, 'stem', 'Gamma');
    await page.waitForTimeout(300);
    check((await page.$('.hl-bar')) === null, 'no bar after destroy');
    await context.close();

    // ------------------------------------------------------------ touch placement
    console.log('Touch checks');
    const tctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    page = await open(tctx, server);
    await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })));
    await select(page, 'p1', 'sample sequence');
    await page.waitForSelector(barVisible, { timeout: 2000 });
    const tg = await page.evaluate(() => {
      const r = getSelection().getRangeAt(0).getBoundingClientRect();
      const b = document.querySelector('.hl-bar').getBoundingClientRect();
      return { selBottom: r.bottom, barTop: b.top, barLeft: b.left, barRight: b.right, vw: innerWidth };
    });
    check(tg.barTop >= tg.selBottom + 20, 'touch: bar sits below the selection (clear of the native menu)');
    check(tg.barLeft >= 0 && tg.barRight <= tg.vw, 'touch: bar inside the viewport');
    const sizes = await page.$$eval('.hl-bar button', (bs) => bs.map((b) => [b.offsetWidth, b.offsetHeight]));
    check(sizes.every(([w, hh]) => w >= 44 && hh >= 44), 'all bar buttons ≥ 44×44');
    await page.tap('.hl-bar [data-color="yellow"]');
    await page.waitForSelector('[data-block="p1"] mark.uhl-yellow');
    check(true, 'tap on a colour saves on touch');
    await tctx.close();

    // ------------------------------------------------------------ screenshots
    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      for (const [name, vp] of [['phone', { width: 390, height: 844 }], ['ipad', { width: 834, height: 1194 }]]) {
        for (const scheme of ['light', 'dark']) {
          const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, hasTouch: name === 'phone', deviceScaleFactor: 2 });
          const p = await open(ctx, server);
          await p.evaluate(async () => {
            const r = window.__hl.highlightsRepo;
            await r.add({ qid: 'DEMO-9001', qversion: 2, block: 'stem', quote: 'Beta step', prefix: '', suffix: '', start: 0, color: 'green' });
            await r.add({ qid: 'DEMO-9001', qversion: 2, block: 'l1', quote: 'Alpha step: first', prefix: '', suffix: '', start: 0, color: 'blue' });
            await r.add({ qid: 'DEMO-9001', qversion: 2, block: 'c1', quote: 'A before B', prefix: '', suffix: '', start: 0, color: 'pink' });
            await window.__hl.ctrl.refresh();
          });
          await p.waitForSelector('mark.uhl');
          if (name === 'phone') {
            await p.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })));
          }
          await select(p, 'p1', 'Alpha step always opens');
          await p.waitForSelector(barVisible);
          await p.waitForTimeout(250);
          await p.screenshot({ path: path.join(SHOTS, `hl-${name}-${scheme}-create.png`) });
          await p.evaluate(() => getSelection().removeAllRanges());
          await p.waitForTimeout(200);
          await p.click('[data-block="l1"] mark.uhl');
          await p.waitForSelector('.hl-bar[data-mode="edit"]:not([hidden])');
          await p.waitForTimeout(250);
          await p.screenshot({ path: path.join(SHOTS, `hl-${name}-${scheme}-edit.png`) });
          await ctx.close();
        }
      }
      console.log(`  screenshots in ${SHOTS}`);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  check(realErrors.length === 0, `no console errors${realErrors.length ? ': ' + realErrors.join(' | ') : ''}`);
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll highlight checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
