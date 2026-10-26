#!/usr/bin/env node
/**
 * Browser check for the Player, Results and Question browse screens and the
 * shared question view (dev-only, never loaded by the app).
 *
 * Boots the real app (index.html) from tests/serve.mjs on a random port with
 * service workers blocked, creates sessions with demo question ids through
 * `engine.createSession` (page.evaluate), and checks in Chromium at
 * 390×844, 834×1194 and 1194×834, light and dark:
 *
 * - Tutor: "1 / 5" + tab bar hidden; tap a choice → instant feedback,
 *   explanation blocks render, "Your notes" shows; side by side on ≥ 1000px;
 *   strike button; Highlight with no selection → hint toast; Draw opens the
 *   ink toolbar, Esc closes it; bookmark persists after reload; the index
 *   resumes after reload; keyboard "1" answers.
 * - Exam: select + change (no feedback), navigator sheet jumps, Finish
 *   confirms (unanswered remain) → Results (ring, counts, list) → open a
 *   question → Next / Prev follow the session list ("2 / 4").
 * - No console errors, no horizontal page scroll. Screenshots go to --out.
 *
 * Usage: node tests/visual/player.mjs [--out <dir>]   (exit code 1 on any failure)
 *
 * @module tests/visual/player
 */

import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(os.tmpdir(), 'player-shots'));

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'ipad', width: 834, height: 1194 },
  { name: 'wide', width: 1194, height: 834 },
];
const SCHEMES = ['light', 'dark'];
const TIMEOUT = 10000;
const TUTOR_QIDS = ['DEMO-0001', 'DEMO-0002', 'DEMO-0003', 'DEMO-0004', 'DEMO-0005'];
const EXAM_QIDS = ['DEMO-0006', 'DEMO-0007', 'DEMO-0008', 'DEMO-0009'];

/** @type {string[]} */
const failures = [];
/**
 * @param {unknown} cond
 * @param {string} message
 */
function check(cond, message) {
  if (!cond) failures.push(message);
}

const server = await startServer({ port: 0 });
const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

/**
 * Opens a fresh app instance (new context = empty IndexedDB) with the tour done.
 * @param {{ name: string, width: number, height: number }} vp
 * @param {'light' | 'dark'} scheme
 * @param {string} label
 */
async function openApp(vp, scheme, label) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, serviceWorkers: 'block' });
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

/**
 * @param {import('playwright').Page} page
 * @param {string[]} qids
 * @param {'tutor' | 'exam'} mode
 * @returns {Promise<string>}
 */
async function newSession(page, qids, mode) {
  return page.evaluate(
    async ({ qids: ids, mode: m }) => {
      const e = await import('./js/features/quiz/engine.js');
      const s = await e.createSession({ qids: ids, mode: m, title: m === 'exam' ? 'Exam test' : 'Practice test', shuffleChoices: false });
      return s.id;
    },
    { qids, mode },
  );
}

/** @param {import('playwright').Page} page */
const headerTitle = (page) => page.locator('#app-header .hdr-title').innerText();

/**
 * @param {import('playwright').Page} page
 * @param {string} text
 */
async function waitHeader(page, text) {
  await page.waitForFunction((t) => document.querySelector('#app-header .hdr-title')?.textContent?.includes(t), text);
}

/**
 * @param {import('playwright').Page} page
 * @param {string} label
 */
async function noHScroll(page, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `[${label}] horizontal page scroll (${over}px)`);
}

/** @param {import('playwright').Page} page */
async function clearToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

/**
 * @param {import('playwright').Page} page
 * @param {string} name
 */
async function shot(page, name) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

/**
 * @param {{ name: string, width: number, height: number }} vp
 * @param {'light' | 'dark'} scheme
 */
async function tutorFlow(vp, scheme) {
  const label = `tutor ${vp.name} ${scheme}`;
  const { context, page } = await openApp(vp, scheme, label);
  try {
    const id = await newSession(page, TUTOR_QIDS, 'tutor');
    await page.evaluate((h) => (location.hash = h), `#/quiz/${id}`);
    await page.waitForSelector('.player .qv .qv-choice');
    await waitHeader(page, '1 / 5');
    check((await page.evaluate(() => document.documentElement.dataset.tabbar)) === 'hidden', `[${label}] tab bar not hidden`);
    check((await page.locator('.pbar').isVisible()) === true, `[${label}] bottom bar missing`);
    check((await page.locator('.qv-letter').first().innerText()).trim() === 'A', `[${label}] letter badge A missing`);
    await shot(page, `${vp.name}-${scheme}-tutor-question`);

    // Strike button toggles the struck state.
    await page.locator('.qv-strike').nth(1).click();
    await page.waitForSelector('.qv-choice-row.is-struck');
    await page.locator('.qv-strike').nth(1).click();
    await page.waitForFunction(() => !document.querySelector('.qv-choice-row.is-struck'));

    // Highlight without a selection → hint.
    await clearToasts(page);
    await page.locator('.pbar button', { hasText: 'Highlight' }).click();
    await page.waitForSelector('.toast');
    check(/Select some text first/.test(await page.locator('.toast').last().innerText()), `[${label}] highlight hint missing`);
    await clearToasts(page);

    // Answer → feedback + explanation.
    await page.locator('.qv-choice').first().click();
    await page.waitForSelector('.qv-feedback.is-correct, .qv-feedback.is-wrong');
    await page.waitForSelector('.qv-explain [data-block]');
    const blocks = await page.locator('.qv-explain [data-block]').count();
    check(blocks >= 3, `[${label}] explanation blocks: ${blocks}`);
    check((await page.locator('.qv-choice-row.is-correct').count()) === 1, `[${label}] correct choice not shown`);
    await page.waitForSelector('.qv-notes textarea');
    if (vp.width >= 1000) {
      const [a, b] = await Promise.all([page.locator('.qv-main').boundingBox(), page.locator('.qv-side').boundingBox()]);
      check(a && b && b.x > a.x + a.width - 2, `[${label}] explanation not beside the question`);
    }
    await page.evaluate(() => scrollTo(0, 0));
    await shot(page, `${vp.name}-${scheme}-tutor-answered`);
    await page.locator('.qv-explain').scrollIntoViewIfNeeded();
    await shot(page, `${vp.name}-${scheme}-tutor-explanation`);
    await noHScroll(page, label);

    // Draw on / Esc off.
    await page.locator('.pbar button', { hasText: 'Draw' }).click();
    await page.waitForSelector('.ink-toolbar');
    await shot(page, `${vp.name}-${scheme}-tutor-draw`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ink-toolbar'));

    // Bookmark persists after reload.
    await page.locator('.qv-bookmark').click();
    await page.waitForFunction(() => document.querySelector('.qv-bookmark')?.getAttribute('aria-pressed') === 'true');
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForSelector('.player .qv-explain');
    await page.waitForFunction(() => document.querySelector('.qv-bookmark')?.getAttribute('aria-pressed') === 'true');

    // Next + resume index after reload.
    await clearToasts(page);
    await page.locator('.pbar-next').click();
    await waitHeader(page, '2 / 5');
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForSelector('.player .qv .qv-choice');
    await waitHeader(page, '2 / 5');

    // Keyboard "1" answers.
    await page.locator('.player-h1').focus();
    await page.keyboard.press('1');
    await page.waitForSelector('.qv-feedback.is-correct, .qv-feedback.is-wrong');
    // → moves on.
    await page.keyboard.press('ArrowRight');
    await waitHeader(page, '3 / 5');
  } catch (err) {
    failures.push(`[${label}] ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-${scheme}-tutor-FAIL.png`) }).catch(() => {});
  } finally {
    await context.close();
  }
}

/**
 * @param {{ name: string, width: number, height: number }} vp
 * @param {'light' | 'dark'} scheme
 */
async function examFlow(vp, scheme) {
  const label = `exam ${vp.name} ${scheme}`;
  const { context, page } = await openApp(vp, scheme, label);
  try {
    const id = await newSession(page, EXAM_QIDS, 'exam');
    await page.evaluate((h) => (location.hash = h), `#/quiz/${id}`);
    await page.waitForSelector('.player .qv .qv-choice');
    await waitHeader(page, '1 / 4');
    check(await page.locator('.player-timer').isVisible(), `[${label}] timer missing`);

    // Select + change, no feedback.
    await page.locator('.qv-choice').nth(0).click();
    await page.waitForSelector('.qv-choice-row.is-selected');
    await page.locator('.qv-choice').nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll('.qv-choice-row.is-selected').length === 1 && document.querySelectorAll('.qv-choice-row')[1].classList.contains('is-selected'));
    check((await page.locator('.qv-feedback.is-correct, .qv-feedback.is-wrong').count()) === 0, `[${label}] exam shows feedback`);
    check((await page.locator('.qv-explain').count()) === 0, `[${label}] exam shows the explanation`);
    await page.locator('.player-mark').click();
    await shot(page, `${vp.name}-${scheme}-exam-question`);

    // Next, answer q2, then the navigator.
    await clearToasts(page);
    await page.locator('.pbar-next').click();
    await waitHeader(page, '2 / 4');
    await page.locator('.qv-choice').nth(2).click();
    await page.waitForSelector('.qv-choice-row.is-selected');
    await page.locator('.player-progress').click();
    await page.waitForSelector('.nav-grid .nav-cell');
    check((await page.locator('.nav-cell').count()) === 4, `[${label}] navigator cells`);
    check((await page.locator('.nav-cell.is-answered').count()) === 2, `[${label}] navigator answered count`);
    await shot(page, `${vp.name}-${scheme}-exam-navigator`);
    await page.locator('.nav-cell').nth(3).click();
    await waitHeader(page, '4 / 4');
    await page.waitForFunction(() => !document.querySelector('#sheet-slot .sheet-root'));

    // Finish → confirm (2 unanswered) → results.
    await page.locator('.pbar-next', { hasText: 'Finish' }).click();
    await page.waitForSelector('.sheet .btn', { state: 'visible' });
    await page.locator('.sheet button', { hasText: 'Finish exam' }).click();
    await page.waitForFunction(() => location.hash.startsWith('#/results/'));
    await page.waitForSelector('.results .res-hero');
    check((await page.locator('.res-list .list-item').count()) === 4, `[${label}] results list`);
    check(await page.evaluate(() => document.documentElement.dataset.tabbar !== 'hidden'), `[${label}] tab bar still hidden on results`);
    await shot(page, `${vp.name}-${scheme}-results`);
    await noHScroll(page, label);

    // Open a question from the list → browse with prev/next.
    await page.locator('.res-list .list-item').first().click();
    await page.waitForSelector('.qscreen .qv-explain');
    await waitHeader(page, '1 / 4');
    check((await page.locator('.qv-choice-row.is-correct').count()) === 1, `[${label}] browse shows the answer`);
    await shot(page, `${vp.name}-${scheme}-question`);
    await page.locator('.qscreen .pbar-next').click();
    await waitHeader(page, '2 / 4');
    await page.locator('.qscreen .pbar-prev').click();
    await waitHeader(page, '1 / 4');
    check((await headerTitle(page)).includes('1 / 4'), `[${label}] prev`);
    // Back returns to the results.
    await page.locator('#app-header .hdr-back').click();
    await page.waitForSelector('.results .res-hero');
  } catch (err) {
    failures.push(`[${label}] ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-${scheme}-exam-FAIL.png`) }).catch(() => {});
  } finally {
    await context.close();
  }
}

try {
  for (const vp of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      await tutorFlow(vp, /** @type {'light' | 'dark'} */ (scheme));
      await examFlow(vp, /** @type {'light' | 'dark'} */ (scheme));
    }
  }
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`player visual check: ${failures.length} failure(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
process.stdout.write(`player visual check: OK (screenshots in ${OUT})\n`);
