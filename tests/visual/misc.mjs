#!/usr/bin/env node
/**
 * Browser check for the Stats, Search, Settings and Reviewer screens (dev-only, never loaded by the app).
 *
 * Serves the repo with tests/serve.mjs on a random port (files other agents have not written yet are
 * stubbed in memory, never on disk) and, in Chromium at phone (390×844) and iPad (834×1194) sizes in
 * light and dark:
 * 1. boots the app, closes the first-run tour, and opens every screen without console/page errors;
 * 2. Stats: empty state with a Start button, then after answering a demo question through the quiz
 *    engine (page.evaluate) the tiles, 30-day chart (+ text summary + hidden table) and chapter rows;
 * 3. Search: the field has focus, a word from data/demo.json finds a question, matches are <mark>ed,
 *    `?q=` is mirrored into the address, and the result links to the question with a search list;
 * 4. Settings: theme and text size apply instantly and persist after a reload; "Export backup" makes a
 *    download; "Check for update" answers in plain language;
 * 5. Reviewer: off-state explains the mode; once on, counts + the unreviewed list render;
 * and takes full-page screenshots of every screen.
 *
 * Usage: node tests/visual/misc.mjs [--out <dir>]   (exit code 1 on any failure)
 *
 * @module tests/visual/misc
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT, startServer } from '../serve.mjs';
import { findImports, parseAppShell } from '../../scripts/lint.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(os.tmpdir(), 'misc-shots'));

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'ipad', width: 834, height: 1194 },
];
const SCHEMES = ['light', 'dark'];
/** A word from data/demo.json (DEMO-0001 stem: "You want a **timed** test …"). */
const SEARCH_WORD = 'timed';
const EXPECTED_ERRORS = [/^Unrecognized feature: /];

/** @type {string[]} */
const failures = [];
/**
 * @param {boolean} cond
 * @param {string} message
 */
function check(cond, message) {
  if (!cond) failures.push(message);
}

/**
 * @param {string} dir Repo-relative directory.
 * @returns {string[]}
 */
function jsFilesUnder(dir) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...jsFilesUnder(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/** In-memory stubs for app files that are not on disk yet (same rules as tests/smoke.mjs). */
function missingFileStubs() {
  const wanted = new Set();
  const shell = parseAppShell(readFileSync(path.join(ROOT, 'sw.js'), 'utf8'));
  for (const e of shell?.entries ?? []) {
    const rel = e.path.replace(/^\.\//, '');
    if (rel) wanted.add(rel);
  }
  for (const file of jsFilesUnder('js')) {
    for (const ref of findImports(readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (!ref.specifier.startsWith('./') && !ref.specifier.startsWith('../')) continue;
      wanted.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), ref.specifier)));
    }
  }
  const stubs = new Map();
  for (const rel of wanted) {
    if (existsSync(path.join(ROOT, rel))) continue;
    if (rel.startsWith('js/screens/') && rel.endsWith('.js')) {
      stubs.set(rel, '/** stub @module stub */\nexport default { render() { return document.createElement("div"); } };\n');
    } else if (rel.endsWith('.js')) stubs.set(rel, '/** stub @module stub */\nexport {};\n');
    else if (rel.endsWith('.css')) stubs.set(rel, '/* stub */\n');
  }
  return stubs;
}

const server = await startServer({ port: 0 });
const stubs = missingFileStubs();
for (const [rel, text] of stubs) server.setOverride(rel, text);
if (stubs.size) console.log(`Stubbed in memory: ${[...stubs.keys()].join(', ')}`);

const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

/**
 * Waits until the router has mounted a screen for the current hash.
 * @param {import('playwright').Page} page
 * @param {string} selector
 */
async function waitScreen(page, selector) {
  await page.waitForSelector(selector, { timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('#main [aria-busy="true"]'), undefined, { timeout: 15000 });
}

/**
 * @param {import('playwright').Page} page
 * @param {string} hash e.g. '#/stats'
 * @param {string} selector
 */
async function go(page, hash, selector) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await waitScreen(page, selector);
  await page.waitForTimeout(150);
}

/**
 * @param {import('playwright').Page} page
 * @param {string} name
 */
async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
}

/** @param {import('playwright').Page} page */
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    const tag = `${vp.name}-${scheme}`;
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      colorScheme: /** @type {'light' | 'dark'} */ (scheme),
      serviceWorkers: 'block',
      acceptDownloads: true,
    });
    const page = await context.newPage();
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !EXPECTED_ERRORS.some((re) => re.test(msg.text()))) errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(`${server.url}#/`, { waitUntil: 'load' });
    await page.waitForFunction(() => !document.getElementById('boot') && document.getElementById('main')?.childElementCount, undefined, {
      timeout: 15000,
    });
    // First-run tour: mark it done (the tour itself is checked elsewhere).
    await page.waitForTimeout(400);
    for (let i = 0; i < 3 && (await page.$('.sheet-root')); i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await page.evaluate(async () => {
      const s = await import(new URL('js/core/settings.js', location.href).href);
      await s.setSetting('tourDone', true);
    });

    // --- Stats: empty state -------------------------------------------------------------------
    await go(page, '#/stats', '.screen-stats');
    await page.waitForSelector('.screen-stats .empty-state, .screen-stats .stat-tiles');
    check(Boolean(await page.$('.screen-stats .empty-state button')), `${tag}: stats empty state has a Start button`);
    check(Boolean(await page.$('.screen-stats .misc-banner')), `${tag}: stats shows the demo-mode note`);
    await shot(page, `stats-empty-${tag}`);

    // Answer a demo question through the engine.
    const answered = await page.evaluate(async () => {
      const base = location.href;
      const engine = await import(new URL('js/features/quiz/engine.js', base).href);
      const data = await import(new URL('js/core/data.js', base).href);
      const s = await engine.createSession({ qids: ['DEMO-0001', 'DEMO-0002'], title: 'Visual test', mode: 'tutor' });
      const q1 = await data.getQuestion('DEMO-0001');
      const q2 = await data.getQuestion('DEMO-0002');
      const r1 = await engine.recordAnswer(s, q1, q1.answer, 12000);
      const wrong = q2.choices.find((c) => c.id !== q2.answer).id;
      const r2 = await engine.recordAnswer(r1.session, q2, wrong, 30000);
      return r1.applied && r2.applied;
    });
    check(answered === true, `${tag}: answers recorded through the engine`);
    await page.waitForSelector('.screen-stats .stat-tiles', { timeout: 5000 }).catch(() => null); // live refresh
    await go(page, '#/', '#main > *');
    await go(page, '#/stats', '.screen-stats .stat-tiles');
    const stats = await page.evaluate(() => ({
      tiles: [...document.querySelectorAll('.stat-tile')].map((t) => t.textContent),
      bars: document.querySelectorAll('.act-chart .act-fill').length,
      summary: document.querySelector('.stats-summary')?.textContent ?? '',
      table: document.querySelectorAll('.screen-stats table tbody tr').length,
      chapters: document.querySelectorAll('.stats-chapter').length,
    }));
    check(stats.tiles.some((t) => /Answered\s*2/.test(t)), `${tag}: stats "Answered 2" tile (${stats.tiles.join(' | ')})`);
    check(stats.tiles.some((t) => /Accuracy\s*50%/.test(t)), `${tag}: stats accuracy 50%`);
    check(stats.bars === 1, `${tag}: one activity bar today (got ${stats.bars})`);
    check(/2 answers/.test(stats.summary), `${tag}: chart text summary (${stats.summary})`);
    check(stats.table === 30, `${tag}: 30-row screen-reader table (got ${stats.table})`);
    check(stats.chapters >= 1, `${tag}: accuracy-by-chapter row`);
    check(await noHorizontalScroll(page), `${tag}: stats has no horizontal scroll`);
    await shot(page, `stats-${tag}`);

    // --- Search -------------------------------------------------------------------------------
    await go(page, '#/search', '.screen-search');
    check(await page.evaluate(() => document.activeElement?.id === 'search-input'), `${tag}: search field has focus`);
    await shot(page, `search-empty-${tag}`);
    await page.fill('#search-input', SEARCH_WORD);
    await page.waitForSelector('.search-hit', { timeout: 5000 }).catch(() => null);
    const found = await page.evaluate(() => ({
      hits: [...document.querySelectorAll('.search-hit')].map((a) => a.getAttribute('href')),
      marks: document.querySelectorAll('.search-hit mark').length,
      status: document.getElementById('search-status')?.textContent ?? '',
      hash: location.hash,
    }));
    check(found.hits.some((hr) => hr?.includes('DEMO-0001')), `${tag}: search finds DEMO-0001 (${found.hits.join(', ')})`);
    check(found.hits.every((hr) => hr?.startsWith('#/q/') && hr.includes('list=search')), `${tag}: result links carry the search list`);
    check(found.marks > 0, `${tag}: matches are marked`);
    check(/result/.test(found.status), `${tag}: live result count (${found.status})`);
    check(found.hash === `#/search?q=${SEARCH_WORD}`, `${tag}: ?q= mirrored (${found.hash})`);
    await shot(page, `search-${tag}`);
    await page.fill('#search-input', 'zzzqqqxx');
    await page.waitForFunction(() => /No results/.test(document.getElementById('search-status')?.textContent ?? ''), undefined, {
      timeout: 5000,
    }).catch(() => check(false, `${tag}: "No results" message`));

    // --- Settings -----------------------------------------------------------------------------
    await go(page, '#/settings', '.screen-settings');
    await page.waitForFunction(() => !document.querySelector('.set-storage .spinner'), undefined, { timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(300);
    await shot(page, `settings-${tag}`);
    check(await noHorizontalScroll(page), `${tag}: settings has no horizontal scroll`);

    if (vp.name === 'phone' && scheme === 'light') {
      // Theme + font size apply instantly and persist after a reload.
      await page.click('#set-appearance .segmented [role="radio"]:has-text("Dark")');
      check((await page.getAttribute('html', 'data-theme')) === 'dark', `${tag}: theme applies instantly`);
      await page.click('button[aria-label="Larger text"]');
      await page.click('button[aria-label="Larger text"]');
      const scale = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim());
      check(scale === '1.1', `${tag}: font scale applies instantly (${scale})`);
      await page.waitForTimeout(300);
      await page.reload({ waitUntil: 'load' });
      await waitScreen(page, '.screen-settings');
      check((await page.getAttribute('html', 'data-theme')) === 'dark', `${tag}: theme persists after reload`);
      const scale2 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim());
      check(scale2 === '1.1', `${tag}: font scale persists after reload (${scale2})`);
      await shot(page, `settings-changed-${tag}`);
      await page.click('#set-appearance .segmented [role="radio"]:has-text("Automatic")');
      await page.click('#set-appearance button:has-text("Reset")');
      check((await page.getAttribute('html', 'data-theme')) === 'light', `${tag}: theme back to automatic`);

      // Export backup → a download.
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
        page.click('button:has-text("Export backup")'),
      ]);
      check(Boolean(download && /^cardiac-mcq-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename())), `${tag}: export downloads a backup`);

      // Check for update → plain-language answer.
      await page.click('button:has-text("Check for update")');
      await page.waitForFunction(() => {
        const t = document.querySelector('.set-update-result')?.textContent ?? '';
        return t !== '' && t !== 'Checking…';
      }, undefined, { timeout: 8000 }).catch(() => null);
      const upd = await page.textContent('.set-update-result');
      check(Boolean(upd && upd !== 'Checking…'), `${tag}: update check answers (${upd})`);
    }

    // --- Reviewer -----------------------------------------------------------------------------
    await go(page, '#/reviewer', '.screen-reviewer');
    check(Boolean(await page.$('.screen-reviewer .empty-state')), `${tag}: reviewer off-state`);
    await shot(page, `reviewer-off-${tag}`);
    await page.click('.screen-reviewer .toggle');
    await waitScreen(page, '.screen-reviewer .rv-list, .screen-reviewer .misc-note');
    await page.waitForTimeout(150);
    const rv = await page.evaluate(() => ({
      tiles: document.querySelectorAll('.screen-reviewer .stat-tile').length,
      rows: document.querySelectorAll('.rv-item').length,
    }));
    check(rv.tiles === 4, `${tag}: reviewer count tiles (${rv.tiles})`);
    check(rv.rows > 0, `${tag}: unreviewed questions listed (${rv.rows})`);
    check(await noHorizontalScroll(page), `${tag}: reviewer has no horizontal scroll`);
    await shot(page, `reviewer-${tag}`);
    await page.evaluate(async () => {
      const s = await import(new URL('js/core/settings.js', location.href).href);
      await s.setSetting('reviewerMode', false);
    });

    for (const e of errors) failures.push(`${tag}: ${e}`);
    await context.close();
  }
}

await browser.close();
await server.close();

if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK — screenshots in ${OUT}`);
