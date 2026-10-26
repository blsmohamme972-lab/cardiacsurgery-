#!/usr/bin/env node
/**
 * End-to-end tests (docs/ARCHITECTURE.md §9). Dev-only, never loaded by the app.
 *
 * Serves the repository with tests/serve.mjs on a random port and drives the
 * real app (index.html) in Chromium at two sizes, each test in a fresh browser
 * context (empty IndexedDB, caches and service workers):
 *
 *   phone 390×844 and iPad 834×1194 (both touch, mobile viewport).
 *
 * Tests:
 *   1. service worker installs and controls the app after a reload
 *   2. home renders (demo mode)
 *   3. demo practice from the Home quick action: answer → feedback → explanation blocks
 *   4. bookmark persists across reload
 *   5. highlight via a text selection persists
 *   6. ink stroke via pointer events persists
 *   7. note autosave persists
 *   8. exam flow → Finish → results
 *   9. search finds a demo question and opens it
 *  10. backup export → reset → import (Merge) round trip
 *  11. offline reload works (and a demo quiz starts offline)
 *  12. "Update available" banner after a version bump → Update → new version
 *
 * A test fails on any thrown error, any uncaught page error and any
 * console.error (except the small allowlist below). Selectors prefer what the
 * user sees (roles, accessible names, visible text). No fixed sleeps: every
 * wait is for a condition.
 *
 * Usage: node tests/e2e.mjs [--only <substring>] [--viewport phone|ipad] [--headed] [--verbose]
 * Exit code 1 on any failure.
 *
 * @module tests/e2e
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, ROOT } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
/** @param {string} name */
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const ONLY = argValue('--only');
const ONLY_VIEWPORT = argValue('--viewport');
const HEADED = args.includes('--headed');
const VERBOSE = args.includes('--verbose');

/** Default timeout for every Playwright wait (ms). */
const TIMEOUT = 15000;

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  { name: 'ipad', viewport: { width: 834, height: 1194 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
].filter((v) => !ONLY_VIEWPORT || v.name === ONLY_VIEWPORT);

/**
 * console.error messages that are not app bugs. Keep this list small and explain each entry.
 * @type {RegExp[]}
 */
const CONSOLE_ALLOWLIST = [
  // Chromium warns about Permissions-Policy features it doesn't know; not from app code.
  /^Unrecognized feature/,
  // Offline test: the browser itself logs failed network requests (the service worker answers them).
  /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED/,
];

// ---------------------------------------------------------------------------
// Demo data (to answer deterministically and pick a search word)
// ---------------------------------------------------------------------------

const demo = JSON.parse(await readFile(path.join(ROOT, 'data', 'demo.json'), 'utf8'));
/** @type {Map<string, string>} qid → correct choice id */
const ANSWERS = new Map(demo.questions.map((q) => [q.id, q.answer]));
const SEARCH_QID = demo.questions[0].id;
/** A word from the first demo stem (plain letters, 5+ chars). */
const SEARCH_WORD = (String(demo.questions[0].stem).match(/[A-Za-z]{5,}/g) || ['timed'])
  .map((w) => w.toLowerCase())
  .find((w) => !['which', 'there', 'their', 'about', 'until'].includes(w)) || 'timed';

const swSource = await readFile(path.join(ROOT, 'sw.js'), 'utf8');
const versionSource = await readFile(path.join(ROOT, 'js', 'version.js'), 'utf8');
const CURRENT_VERSION = /const VERSION = '([^']+)'/.exec(swSource)?.[1];
const NEXT_VERSION = '2099.12.31-9';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class TestError extends Error {}

/**
 * @param {unknown} cond
 * @param {string} message
 */
function assert(cond, message) {
  if (!cond) throw new TestError(message);
}

/**
 * Polls `fn` until it returns a truthy value (no fixed sleeps in tests).
 * @template T
 * @param {() => Promise<T> | T} fn
 * @param {string} what Shown when it times out.
 * @param {number} [timeout]
 * @returns {Promise<T>}
 */
async function waitUntil(fn, what, timeout = TIMEOUT) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new TestError(`Timed out waiting for ${what}${last instanceof Error ? ` (${last.message.split('\n')[0]})` : ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * All records of one IndexedDB store, read through a separate connection
 * (call only after the app opened the database once).
 * @param {import('playwright').Page} page
 * @param {string} store
 * @returns {Promise<any[]>}
 */
function idbAll(page, store) {
  return page.evaluate(
    (s) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('cardiac-mcq');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(s)) {
            db.close();
            resolve([]);
            return;
          }
          const get = db.transaction(s, 'readonly').objectStore(s).getAll();
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
          get.onerror = () => {
            db.close();
            reject(get.error);
          };
        };
      }),
    store,
  );
}

/** @param {import('playwright').Page} page */
const homeHeading = (page) => page.getByRole('heading', { name: 'Start studying' });

/**
 * Opens the app, marks the first-run tour as done and reloads at Home.
 * @param {import('playwright').Page} page
 * @param {string} url
 */
async function openApp(page, url) {
  await page.goto(url);
  await page.locator('#main > *').first().waitFor();
  await skipTour(page);
}

/**
 * Marks the tour as done (it is tested elsewhere) and reloads at Home.
 * @param {import('playwright').Page} page
 */
async function skipTour(page) {
  await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    await r.settingsRepo.set('tourDone', true);
  });
  await page.evaluate(() => (location.hash = '#/'));
  await page.reload();
  await homeHeading(page).waitFor();
}

/**
 * Taps the "Practice N" quick action and waits for the first question.
 * @param {import('playwright').Page} page
 * @returns {Promise<string>} The qid on screen.
 */
async function startPractice(page) {
  await page.getByRole('button', { name: /^Practice \d+/ }).click();
  await page.waitForURL(/#\/quiz\//);
  return currentQid(page);
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function currentQid(page) {
  const qv = page.locator('.player .qv');
  await qv.locator('.qv-choice').first().waitFor();
  const qid = await qv.getAttribute('data-qid');
  assert(qid && ANSWERS.has(qid), `unknown question on screen: ${qid}`);
  return /** @type {string} */ (qid);
}

/**
 * Taps the correct choice of the question on screen.
 * @param {import('playwright').Page} page
 * @param {string} qid
 */
async function answerCorrectly(page, qid) {
  await page.locator(`.qv-choices .qv-choice[data-choice="${ANSWERS.get(qid)}"]`).click();
}

/**
 * Reloads and waits until the same question is back on screen.
 * @param {import('playwright').Page} page
 * @param {string} qid
 */
async function reloadToQuestion(page, qid) {
  await page.reload();
  const again = await currentQid(page);
  assert(again === qid, `after reload the app shows ${again}, expected ${qid}`);
}

/**
 * Text node range over the first word (4+ letters) of an element.
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @returns {Promise<string>} The selected text.
 */
function selectFirstWord(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} not found`);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const m = /[A-Za-z]{4,}/.exec(n.textContent || '');
      if (!m) continue;
      const range = document.createRange();
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(range);
      return m[0];
    }
    throw new Error('no word to select');
  }, selector);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * @typedef {{ page: import('playwright').Page, context: import('playwright').BrowserContext,
 *   server: Awaited<ReturnType<typeof startServer>>, vp: typeof VIEWPORTS[number] }} T
 */

/** @type {{ name: string, sw?: boolean, run: (t: T) => Promise<void> }[]} */
const TESTS = [
  {
    name: 'service worker installs and the app boots',
    sw: true,
    async run({ page, server }) {
      await openApp(page, server.url);
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.reload();
      await homeHeading(page).waitFor();
      const info = await page.evaluate(async () => ({
        controlled: Boolean(navigator.serviceWorker.controller),
        caches: await caches.keys(),
      }));
      assert(info.controlled, 'the page is not controlled by the service worker after a reload');
      assert(info.caches.includes(`cmcq-shell-${CURRENT_VERSION}`), `shell cache missing (have: ${info.caches.join(', ')})`);
      assert(info.caches.includes(`cmcq-data-${CURRENT_VERSION}`), `data cache missing (have: ${info.caches.join(', ')})`);
    },
  },
  {
    name: 'home renders (demo mode)',
    async run({ page, server }) {
      await openApp(page, server.url);
      await page.getByRole('heading', { level: 1 }).first().waitFor();
      await page.getByRole('button', { name: /^Practice \d+/ }).waitFor();
      await page.getByRole('button', { name: /^Exam/ }).waitFor();
      await page.getByText('Demo mode.').waitFor();
      await page.getByRole('link', { name: new RegExp(demo.chapter?.title ? escapeRe(demo.chapter.title) : 'App tour') }).first().waitFor();
      await page.getByRole('navigation', { name: 'Main' }).waitFor();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(over <= 1, `horizontal page scroll (${over}px)`);
    },
  },
  {
    name: 'demo practice: answer → feedback → explanation',
    async run({ page, server }) {
      await openApp(page, server.url);
      const qid = await startPractice(page);
      await answerCorrectly(page, qid);
      await page.locator('.qv-feedback', { hasText: 'Correct.' }).waitFor();
      await page.getByRole('heading', { name: 'Explanation' }).waitFor();
      await page.locator('.qv-explain .explain [data-block]').first().waitFor();
      const blocks = await page.locator('.qv-explain .explain [data-block]').count();
      const expected = demo.questions.find((q) => q.id === qid).explanation.length;
      assert(blocks >= expected, `explanation shows ${blocks} blocks, expected ${expected}`);
      assert((await page.locator('.qv-choice-row.is-correct').count()) === 1, 'the correct choice is not marked');
    },
  },
  {
    name: 'bookmark persists across reload',
    async run({ page, server }) {
      await openApp(page, server.url);
      const qid = await startPractice(page);
      const bookmark = page.getByRole('button', { name: 'Bookmark', exact: true });
      await bookmark.click();
      await waitUntil(async () => (await bookmark.getAttribute('aria-pressed')) === 'true', 'bookmark pressed');
      await waitUntil(async () => (await idbAll(page, 'qstate')).some((s) => s.qid === qid && s.bookmarked), 'bookmark saved');
      await reloadToQuestion(page, qid);
      await waitUntil(async () => (await bookmark.getAttribute('aria-pressed')) === 'true', 'bookmark still pressed after reload');
    },
  },
  {
    name: 'highlight via selection persists',
    async run({ page, server }) {
      await openApp(page, server.url);
      const qid = await startPractice(page);
      const stem = '.player .qv [data-block="stem"]';
      const word = await selectFirstWord(page, stem);
      const bar = page.getByRole('toolbar', { name: 'Highlight options' });
      await bar.waitFor();
      await bar.getByRole('button', { name: /^Highlight green/ }).click();
      await page.locator(`${stem} mark.uhl.uhl-green`).waitFor();
      await waitUntil(async () => (await idbAll(page, 'highlights')).some((r) => r.qid === qid && r.color === 'green'), 'highlight saved');
      await reloadToQuestion(page, qid);
      const mark = page.locator(`${stem} mark.uhl`);
      await mark.first().waitFor();
      const text = (await mark.allInnerTexts()).join('');
      assert(text === word, `highlight after reload wraps "${text}", expected "${word}"`);
    },
  },
  {
    name: 'ink stroke via pointer events persists',
    async run({ page, server }) {
      await openApp(page, server.url);
      const qid = await startPractice(page);
      await page.locator('.pbar').getByRole('button', { name: 'Draw' }).click();
      await page.locator('.ink-toolbar').waitFor();
      const layer = page.locator('.player .qv [data-block="stem"] > canvas.ink-layer');
      await layer.waitFor();
      const box = await layer.boundingBox();
      assert(box && box.width > 20 && box.height > 10, 'ink layer over the stem has no size');
      const b = /** @type {{x:number,y:number,width:number,height:number}} */ (box);
      await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * 0.5);
      await page.mouse.down();
      for (let i = 1; i <= 12; i += 1) {
        await page.mouse.move(b.x + b.width * (0.1 + 0.07 * i), b.y + b.height * (0.5 + 0.3 * Math.sin(i / 2)));
      }
      await page.mouse.up();
      // Scoped to the ink toolbar (one run once saw a second "Done" button on iPad; not reproducible).
      await page.locator('.ink-toolbar').getByRole('button', { name: 'Done' }).click();
      await page.locator('.ink-toolbar').waitFor({ state: 'detached' });
      const hasInk = async () =>
        (await idbAll(page, 'ink')).some((r) => r.qid === qid && Array.isArray(r.strokes) && r.strokes.length > 0);
      await waitUntil(hasInk, 'ink saved');
      await reloadToQuestion(page, qid);
      await waitUntil(hasInk, 'ink still stored after reload');
      await page.locator('.player .qv [data-block="stem"] > canvas.ink-layer').waitFor({ state: 'attached' });
    },
  },
  {
    name: 'note autosave persists',
    async run({ page, server }) {
      await openApp(page, server.url);
      const qid = await startPractice(page);
      await answerCorrectly(page, qid);
      const note = page.getByRole('textbox', { name: 'Your note' });
      await note.waitFor();
      await waitUntil(async () => (await note.getAttribute('aria-busy')) !== 'true', 'note loaded');
      const text = 'E2E placeholder note';
      await note.fill(text);
      await page.locator('.note-status', { hasText: 'Saved' }).waitFor();
      await reloadToQuestion(page, qid);
      await waitUntil(async () => (await note.inputValue()) === text, 'note text after reload');
    },
  },
  {
    name: 'exam flow → results',
    async run({ page, server }) {
      await openApp(page, server.url);
      await page.getByRole('button', { name: /^Exam/ }).click();
      await page.waitForURL(/#\/quiz\//);
      const answered = 3;
      for (let i = 0; i < answered; i += 1) {
        const qid = await currentQid(page);
        await answerCorrectly(page, qid);
        await page.locator('.qv-choice-row.is-selected').waitFor();
        assert((await page.locator('.qv-explain').count()) === 0, 'exam mode shows the explanation before Finish');
        await page.locator('.pbar').getByRole('button', { name: 'Next' }).click();
        await waitUntil(async () => (await page.locator('.player .qv').getAttribute('data-qid')) !== qid, 'next question');
      }
      await page.getByRole('button', { name: /^Question \d+ of \d+/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Finish exam' }).click();
      const confirm = page.getByRole('dialog', { name: 'Finish the exam?' });
      await confirm.getByRole('button', { name: 'Finish exam' }).click();
      await page.waitForURL(/#\/results\//);
      const score = page.getByRole('region', { name: 'Score' });
      await score.waitFor();
      const summary = await score.locator('.res-sub').innerText();
      assert(new RegExp(`^${answered} of \\d+ questions? correct`).test(summary), `results summary: "${summary}"`);
      await score.getByText('Unanswered').waitFor();
    },
  },
  {
    name: 'search finds a demo question',
    async run({ page, server }) {
      await openApp(page, server.url);
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Search' }).click();
      const box = page.getByRole('searchbox', { name: 'Search questions' });
      await box.fill(SEARCH_WORD);
      const hit = page.locator('.search-hit', { hasText: SEARCH_QID });
      await hit.first().waitFor();
      await hit.first().click();
      await page.locator(`.qv[data-qid="${SEARCH_QID}"]`).waitFor();
    },
  },
  {
    name: 'backup export → reset → import round trip',
    async run({ page, server }) {
      await openApp(page, server.url);
      const qid = await startPractice(page);
      const bookmark = page.getByRole('button', { name: 'Bookmark', exact: true });
      await bookmark.click();
      await waitUntil(async () => (await idbAll(page, 'qstate')).some((s) => s.qid === qid && s.bookmarked), 'bookmark saved');

      // Export.
      await page.evaluate(() => (location.hash = '#/settings'));
      const exportBtn = page.getByRole('button', { name: 'Export backup' });
      await exportBtn.waitFor();
      const [download] = await Promise.all([page.waitForEvent('download'), exportBtn.click()]);
      const file = await download.path();
      assert(file, 'the backup download has no file');
      const backup = JSON.parse(await readFile(/** @type {string} */ (file), 'utf8'));
      assert(backup && typeof backup === 'object', 'the backup file is not JSON');

      // Reset: close the app's connection and delete the database.
      await page.evaluate(async () => {
        const db = await import('./js/core/store/db.js');
        await db.closeDB();
        await new Promise((resolve, reject) => {
          const req = indexedDB.deleteDatabase('cardiac-mcq');
          req.onsuccess = () => resolve(undefined);
          req.onerror = () => reject(req.error);
        });
      });
      await page.evaluate(() => (location.hash = '#/'));
      await page.reload();
      await page.locator('#main > *').first().waitFor();
      await skipTour(page);
      assert(!(await idbAll(page, 'qstate')).some((s) => s.qid === qid && s.bookmarked), 'the reset kept the bookmark');

      // Import with Merge.
      await page.evaluate(() => (location.hash = '#/settings'));
      await page.getByRole('button', { name: 'Import backup' }).waitFor();
      await page.locator('#main input[type="file"]').setInputFiles(/** @type {string} */ (file));
      const dialog = page.getByRole('dialog', { name: 'Import backup' });
      await dialog.waitFor();
      await dialog.getByRole('button', { name: 'Merge this backup' }).click();
      await dialog.waitFor({ state: 'detached' });
      await waitUntil(async () => (await idbAll(page, 'qstate')).some((s) => s.qid === qid && s.bookmarked), 'bookmark back after import');

      // Visible on Home too.
      await page.evaluate(() => (location.hash = '#/'));
      await page.getByRole('button', { name: /^Bookmarks.*1 saved/ }).waitFor();
    },
  },
  {
    name: 'offline reload works',
    sw: true,
    async run({ page, context, server }) {
      await openApp(page, server.url);
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.reload();
      await homeHeading(page).waitFor();
      await waitUntil(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'service worker control');
      await context.setOffline(true);
      await page.reload();
      await homeHeading(page).waitFor();
      // The demo data comes from the cache too.
      const qid = await startPractice(page);
      await answerCorrectly(page, qid);
      await page.locator('.qv-explain .explain [data-block]').first().waitFor();
      await context.setOffline(false);
    },
  },
  {
    name: 'update banner after a version bump',
    sw: true,
    async run({ page, server }) {
      assert(CURRENT_VERSION, 'VERSION not found in sw.js');
      await openApp(page, server.url);
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
      await page.reload();
      await homeHeading(page).waitFor();
      await waitUntil(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 'service worker control');

      // "Deploy" a new version (in memory only).
      server.setOverride('sw.js', swSource.replace(`const VERSION = '${CURRENT_VERSION}'`, `const VERSION = '${NEXT_VERSION}'`));
      server.setOverride('js/version.js', versionSource.replace(`'${CURRENT_VERSION}'`, `'${NEXT_VERSION}'`));
      await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        await reg?.update();
      });
      await page.getByText('Update available').waitFor({ timeout: 30000 });
      const loaded = page.waitForEvent('load');
      await page.locator('[data-banner="update"]').getByRole('button', { name: 'Update', exact: true }).click();
      await loaded;
      await homeHeading(page).waitFor();
      const version = await page.evaluate(async () => (await import('./js/version.js')).APP_VERSION);
      assert(version === NEXT_VERSION, `after the update the app runs ${version}, expected ${NEXT_VERSION}`);
      await page.evaluate(() => (location.hash = '#/settings'));
      await page.getByText(NEXT_VERSION, { exact: true }).first().waitFor();
      assert((await page.getByText('Update available').count()) === 0, 'the update banner is still shown after updating');
    },
  },
];

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const started = Date.now();
const server = await startServer({ port: 0 });
const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

let passed = 0;
/** @type {string[]} */
const failed = [];

try {
  for (const vp of VIEWPORTS) {
    for (const test of TESTS) {
      if (ONLY && !test.name.includes(ONLY)) continue;
      const t0 = Date.now();
      const context = await browser.newContext({
        viewport: vp.viewport,
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        deviceScaleFactor: vp.deviceScaleFactor,
        permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
        serviceWorkers: test.sw ? 'allow' : 'block',
        acceptDownloads: true,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(TIMEOUT);
      /** @type {string[]} */
      const pageErrors = [];
      page.on('pageerror', (err) => pageErrors.push(`page error: ${String(err?.stack || err).split('\n')[0]}`));
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (CONSOLE_ALLOWLIST.some((re) => re.test(text))) return;
        pageErrors.push(`console.error: ${text.split('\n')[0]}`);
      });
      let error = '';
      try {
        await test.run({ page, context, server, vp });
      } catch (err) {
        error = err instanceof Error ? (VERBOSE ? err.message : err.message.split('\n')[0]) : String(err);
      } finally {
        server.clearOverrides();
        await context.close().catch(() => {});
      }
      if (!error && pageErrors.length) error = pageErrors.join(' | ');
      else if (error && pageErrors.length) error += ` | ${pageErrors.join(' | ')}`;
      const ms = Date.now() - t0;
      if (error) {
        failed.push(`${vp.name}: ${test.name}`);
        console.log(`✗ ${vp.name}: ${test.name} (${ms} ms)\n    ${error}`);
      } else {
        passed += 1;
        console.log(`✓ ${vp.name}: ${test.name} (${ms} ms)`);
      }
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length) {
  console.log(`\n${failed.length} failed, ${passed} passed (${secs} s)`);
  process.exit(1);
}
console.log(`\nAll ${passed} e2e tests passed (${secs} s)`);
