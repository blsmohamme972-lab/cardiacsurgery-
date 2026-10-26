#!/usr/bin/env node
/**
 * Browser check for the Home, Chapter, Builder and Library screens
 * (dev-only, never loaded by the app).
 *
 * Boots the real app (index.html) from tests/serve.mjs on a random port,
 * with service workers blocked. Files that other groups have not written yet
 * are stubbed in memory (never on disk), like tests/smoke.mjs does. In
 * Chromium it checks, in demo mode:
 *
 * 1. Fresh device (phone, light): Mistakes and Bookmarks quick actions show a
 *    helpful toast and stay on Home (never a dead end); Library tabs show
 *    their teaching empty states; the Builder shows a live count, and with a
 *    filter that matches nothing, Start is disabled with the reason shown.
 * 2. Practice → `#/quiz/<id>`; back on Home the Continue card appears;
 *    Discard + Undo brings it back. Exam → `#/quiz/<id>`.
 * 3. Seeded progress: the Due card appears and starts a quiz; Mistakes and
 *    Bookmarks start quizzes; the Chapter screen for `demo` shows its stats,
 *    topics and actions (Practice starts a quiz); every Library tab lists
 *    rows; Sessions delete + Undo.
 * 4. Screenshots of every screen at phone (390×844) and iPad (834×1194), in
 *    light and dark; no horizontal page scroll; no console errors on these
 *    screens (errors while the player is open are ignored: it is another
 *    group's screen and only the URL change is checked here).
 *
 * Usage: node tests/visual/home.mjs [--out <dir>]   (exit code 1 on any failure)
 *
 * @module tests/visual/home
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
const OUT = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(os.tmpdir(), 'home-shots'));

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'ipad', width: 834, height: 1194 },
];
const SCHEMES = ['light', 'dark'];
const TIMEOUT = 10000;
const QUIZ_RE = /^#\/quiz\/[^/?#]+/;

/** @type {string[]} */
const failures = [];
/**
 * @param {unknown} cond
 * @param {string} message
 */
function check(cond, message) {
  if (!cond) failures.push(message);
}

// ---------------------------------------------------------------------------
// In-memory stubs for files that are not on disk yet
// ---------------------------------------------------------------------------

const SCREEN_STUB =
  '/** Visual-test stub. @module stub */\n' +
  'export default { async render() { const el = document.createElement("div"); el.dataset.stub = "screen"; return el; } };\n';

/** @param {string} dir */
function jsFilesUnder(dir) {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...jsFilesUnder(rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

/** @returns {Map<string, string>} */
function missingFileStubs() {
  const wanted = new Set();
  const shell = parseAppShell(readFileSync(path.join(ROOT, 'sw.js'), 'utf8'));
  for (const e of shell?.entries ?? []) wanted.add(e.path.replace(/^\.\//, ''));
  for (const file of jsFilesUnder('js')) {
    for (const ref of findImports(readFileSync(path.join(ROOT, file), 'utf8'))) {
      if (!ref.specifier.startsWith('.')) continue;
      wanted.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), ref.specifier)));
    }
  }
  const stubs = new Map();
  for (const rel of wanted) {
    if (!rel || existsSync(path.join(ROOT, rel))) continue;
    if (rel.startsWith('js/screens/')) stubs.set(rel, SCREEN_STUB);
    else if (rel.endsWith('.js')) stubs.set(rel, '/** stub @module stub */\nexport {};\n');
    else if (rel.endsWith('.css')) stubs.set(rel, '/* stub */\n');
  }
  return stubs;
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

const server = await startServer({ port: 0 });
const stubs = missingFileStubs();
for (const [rel, text] of stubs) server.setOverride(rel, text);
const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

/**
 * Opens a fresh app instance (new context = empty IndexedDB), skips the tour.
 * @param {{ name: string, width: number, height: number }} vp
 * @param {'light' | 'dark'} scheme
 * @param {string} label
 */
async function openApp(vp, scheme, label) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  /** @param {string} text */
  const report = async (text) => {
    let hash = '';
    try {
      hash = new URL(page.url()).hash;
    } catch {
      /* ignore */
    }
    if (/^#\/(quiz|results|q)\//.test(hash)) return; // other group's screens
    failures.push(`[${label}] console error on ${hash || '#/'}: ${text}`);
  };
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/^Unrecognized feature/.test(msg.text())) void report(msg.text());
  });
  page.on('pageerror', (err) => void report(String(err)));
  await page.goto(server.url);
  await page.waitForSelector('#main .screen-home .home-qa');
  await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    await r.settingsRepo.set('tourDone', true);
  });
  await page.reload();
  await page.waitForSelector('#main .screen-home .home-qa');
  return { context, page };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} hash
 * @param {string} selector Waited for after the change.
 */
async function go(page, hash, selector) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await page.waitForSelector(selector);
  await page.waitForTimeout(150);
}

/** @param {import('playwright').Page} page */
async function waitQuiz(page) {
  try {
    await page.waitForFunction((re) => new RegExp(re).test(location.hash), QUIZ_RE.source, { timeout: TIMEOUT });
    return true;
  } catch {
    return false;
  }
}

/** @param {import('playwright').Page} page */
const hashOf = (page) => page.evaluate(() => location.hash);

/**
 * @param {import('playwright').Page} page
 * @param {string} label
 */
async function noHScroll(page, label) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `[${label}] horizontal page scroll (${over}px)`);
}

/**
 * Clicks a quick action on Home by its label.
 * @param {import('playwright').Page} page
 * @param {string} label
 */
async function quick(page, label) {
  await page.locator('.home-qa', { hasText: label }).first().click();
}

/** @param {import('playwright').Page} page */
async function toastText(page) {
  const t = page.locator('.toast .toast-msg').last();
  await t.waitFor({ timeout: TIMEOUT });
  return (await t.textContent()) ?? '';
}

/** @param {import('playwright').Page} page */
async function clearToasts(page) {
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

/** Seeds progress, bookmarks, a note, a highlight, a report and a voice note. */
async function seed(page) {
  await page.evaluate(async () => {
    const r = await import('./js/core/store/repo.js');
    const now = Date.now();
    const put = (qid, extra) => r.qstateRepo.put({ ...r.emptyQState(qid), ...extra });
    await put('DEMO-0001', {
      seen: 1,
      incorrect: 1,
      lastCorrect: false,
      lastChoice: 'a',
      lastTs: now - 5000,
      srs: { due: now - 60000, interval: 0, ease: 2.3, reps: 0, lapses: 1 },
    });
    await put('DEMO-0002', {
      seen: 1,
      correct: 1,
      lastCorrect: true,
      lastTs: now - 4000,
      bookmarked: true,
      srs: { due: now + 86400000, interval: 1, ease: 2.5, reps: 1, lapses: 0 },
    });
    await put('DEMO-0003', { bookmarked: true });
    await r.notesRepo.set('DEMO-0002', 'Placeholder note text for the library list.');
    await r.highlightsRepo.add({ qid: 'DEMO-0001', qversion: 1, block: 'stem', quote: 'placeholder quote', prefix: '', suffix: '', start: 0, color: 'yellow', ts: now });
    await r.reportsRepo.add({ qid: 'DEMO-0003', qversion: 1, reason: 'Typo or formatting', text: 'Placeholder report', ts: now });
    await r.voiceRepo.add({ qid: 'DEMO-0002', blob: new Blob([new Uint8Array(64)], { type: 'audio/webm' }), mime: 'audio/webm', durationMs: 4200 });
  });
}

const LIB_TABS = ['bookmarks', 'notes', 'voice', 'highlights', 'flagged', 'sessions'];

// ---------------------------------------------------------------------------
// 1 + 2. Fresh device: toasts, empty states, builder, start + continue
// ---------------------------------------------------------------------------

{
  const label = 'fresh';
  const { context, page } = await openApp(VIEWPORTS[0], 'light', label);

  check(!(await page.locator('.home-continue').count()), `[${label}] no Continue card on a fresh device`);
  check(!(await page.locator('.home-due').count()), `[${label}] no Due card on a fresh device`);
  check((await page.locator('.home-demo').count()) === 1, `[${label}] demo card shown in demo mode`);

  for (const qa of ['Mistakes', 'Bookmarks']) {
    await quick(page, qa);
    const msg = await toastText(page).catch(() => '');
    check(msg.length > 10, `[${label}] ${qa} with nothing to study shows a toast (got "${msg}")`);
    check(['', '#', '#/'].includes(await hashOf(page)), `[${label}] ${qa} stays on Home when empty`);
    await clearToasts(page);
  }

  // Library empty states.
  for (const tab of LIB_TABS) {
    await go(page, `#/library?tab=${tab}`, `.screen-library .lib-panel[data-tab="${tab}"]:not([aria-busy])`);
    await page.waitForSelector('.lib-panel .empty-state, .lib-panel .lib-list');
    const empty = await page.locator('.lib-panel .empty-state').count();
    check(empty === 1, `[${label}] Library ${tab}: teaching empty state`);
    const selected = await page.locator(`#lib-tab-${tab}[aria-selected="true"]`).count();
    check(selected === 1, `[${label}] Library ${tab}: tab selected`);
  }
  // Tab switching by click keeps the URL in sync.
  await page.locator('#lib-tab-notes').click();
  await page.waitForSelector('.lib-panel[data-tab="notes"]');
  check((await hashOf(page)).includes('tab=notes'), `[${label}] Library tab click updates the URL`);

  // Builder: live count, then a filter that matches nothing.
  await go(page, '#/new', '.screen-builder .nb-startbar');
  await page.waitForFunction(() => /\d+ questions? available/.test(document.querySelector('.nb-available')?.textContent ?? ''));
  const avail = await page.locator('.nb-available').textContent();
  check(/^(\d+) questions? available/.test(avail ?? '') && !/^0 /.test(avail ?? ''), `[${label}] Builder live count > 0 ("${avail}")`);
  check(!(await page.locator('.nb-startbar button.btn-primary').isDisabled()), `[${label}] Builder Start enabled when questions exist`);
  await page.locator('.seg-option', { hasText: 'Bookmarks' }).first().click();
  await page.waitForFunction(() => /^0 questions available/.test(document.querySelector('.nb-available')?.textContent ?? ''));
  check(await page.locator('.nb-startbar button.btn-primary').isDisabled(), `[${label}] Builder Start disabled at 0`);
  const reason = await page.locator('.nb-reason').textContent();
  check(await page.locator('.nb-reason').isVisible(), `[${label}] Builder shows the reason at 0`);
  check((reason ?? '').length > 10, `[${label}] Builder reason text ("${reason}")`);
  await page.screenshot({ path: path.join(OUT, 'builder-zero-phone-light.png'), fullPage: true });
  await page.locator('.seg-option', { hasText: 'All' }).first().click();
  await page.waitForFunction(() => /^[1-9]\d* questions? available/.test(document.querySelector('.nb-available')?.textContent ?? ''));
  // Custom count validation.
  await page.locator('.seg-option', { hasText: 'Custom' }).click();
  await page.locator('.nb-custom-input').fill('0');
  await page.waitForTimeout(50);
  check(await page.locator('.nb-startbar button.btn-primary').isDisabled(), `[${label}] Builder Start disabled for custom 0`);
  await page.locator('.nb-custom-input').fill('3');
  await page.waitForTimeout(50);
  const startLabel = await page.locator('.nb-startbar button.btn-primary').textContent();
  check(/Start 3 questions/.test(startLabel ?? ''), `[${label}] Builder Start label shows the count ("${startLabel}")`);
  // Builder Start → quiz.
  await page.locator('.nb-startbar button.btn-primary').click();
  check(await waitQuiz(page), `[${label}] Builder Start opens #/quiz/<id>`);

  // Home: Practice → quiz; back home → Continue card; discard + undo.
  await go(page, '#/', '.screen-home .home-qa');
  await quick(page, 'Practice');
  check(await waitQuiz(page), `[${label}] Practice quick action opens #/quiz/<id>`);
  const quizHash = await hashOf(page);
  await go(page, '#/', '.screen-home .home-continue');
  const resume = await page.locator('.home-continue-link').getAttribute('href');
  check(resume === quizHash, `[${label}] Continue card resumes the latest quiz (${resume} vs ${quizHash})`);
  await page.screenshot({ path: path.join(OUT, 'home-continue-phone-light.png'), fullPage: true });
  await page.locator('.home-continue-discard').click();
  await page.waitForSelector('.screen-home .home-continue', { state: 'detached' }).catch(() => {});
  // Another unfinished quiz (from the builder) may now be the latest; the discarded one must be gone.
  const afterDiscard = await page.locator('.home-continue-link').getAttribute('href').catch(() => null);
  check(afterDiscard !== quizHash, `[${label}] Discard removes the quiz from Continue`);
  await page.locator('.toast-action', { hasText: 'Undo' }).click();
  await page.waitForFunction((h) => document.querySelector('.home-continue-link')?.getAttribute('href') === h, quizHash);
  check(true, 'undo');

  await quick(page, 'Exam');
  check(await waitQuiz(page), `[${label}] Exam quick action opens #/quiz/<id>`);
  check((await hashOf(page)) !== quizHash, `[${label}] Exam starts a new session`);

  await context.close();
}

// ---------------------------------------------------------------------------
// 3. Seeded progress: Due, Mistakes, Bookmarks, Chapter, Library rows, Sessions
// ---------------------------------------------------------------------------

{
  const label = 'seeded';
  const { context, page } = await openApp(VIEWPORTS[0], 'light', label);
  await seed(page);
  await go(page, '#/new', '.screen-builder');
  await go(page, '#/', '.screen-home .home-due');
  const dueText = await page.locator('.home-due-title').textContent();
  check(/^1 question due/.test(dueText ?? ''), `[${label}] Due card count ("${dueText}")`);
  const mistakesSub = await page.locator('.home-qa', { hasText: 'Mistakes' }).locator('.home-qa-sub').textContent();
  check(/1 to redo/.test(mistakesSub ?? ''), `[${label}] Mistakes tile shows the count ("${mistakesSub}")`);
  const ringCount = await page.locator('.home-chapter').count();
  check(ringCount === 1, `[${label}] demo chapter row on Home`);

  await page.locator('.home-due').click();
  check(await waitQuiz(page), `[${label}] Due card opens #/quiz/<id>`);
  for (const qa of ['Mistakes', 'Bookmarks']) {
    await go(page, '#/', '.screen-home .home-qa');
    await quick(page, qa);
    check(await waitQuiz(page), `[${label}] ${qa} quick action opens #/quiz/<id>`);
  }

  // Chapter screen.
  await go(page, '#/', '.screen-home .home-chapter');
  await page.locator('.home-chapter').first().click();
  await page.waitForSelector('.screen-chapter .ch-actions');
  check((await hashOf(page)) === '#/chapter/demo', `[${label}] chapter row opens #/chapter/demo`);
  const topics = await page.locator('.ch-topic').count();
  check(topics >= 1, `[${label}] chapter lists topics (${topics})`);
  const answered = await page.locator('.ch-stat', { hasText: 'Answered' }).locator('.ch-stat-value').textContent();
  check(/^2 \/ \d+/.test(answered ?? ''), `[${label}] chapter answered count ("${answered}")`);
  const browse = await page.locator('.ch-more a', { hasText: 'Browse' }).getAttribute('href');
  check(/^#\/q\/DEMO-\d+\?list=chapter%3Ademo$/.test(browse ?? ''), `[${label}] Browse link ("${browse}")`);
  await page.locator('.ch-action', { hasText: 'Mistakes in this chapter' }).click();
  check(await waitQuiz(page), `[${label}] chapter Mistakes opens #/quiz/<id>`);
  await go(page, '#/chapter/demo', '.screen-chapter .ch-actions');
  await page.locator('.ch-action', { hasText: 'Practice' }).click();
  check(await waitQuiz(page), `[${label}] chapter Practice opens #/quiz/<id>`);

  // Unknown chapter → friendly state.
  await go(page, '#/chapter/ch01', '.screen-chapter .empty-state');

  // Library rows.
  const expected = { bookmarks: 2, notes: 1, voice: 1, highlights: 1, flagged: 1 };
  for (const [tab, n] of Object.entries(expected)) {
    await go(page, `#/library?tab=${tab}`, `.lib-panel[data-tab="${tab}"]:not([aria-busy])`);
    await page.waitForSelector('.lib-panel .lib-list, .lib-panel .empty-state');
    const rows = await page.locator('.lib-panel a.lib-row').count();
    check(rows === n, `[${label}] Library ${tab}: ${n} row(s) (got ${rows})`);
    const href = await page.locator('.lib-panel a.lib-row').first().getAttribute('href');
    check(new RegExp(`^#/q/DEMO-\\d+\\?list=${tab}$`).test(href ?? ''), `[${label}] Library ${tab} link ("${href}")`);
  }

  // Sessions: delete + Undo.
  await go(page, '#/library?tab=sessions', '.lib-panel[data-tab="sessions"] .lib-list');
  const before = await page.locator('.lib-session').count();
  check(before >= 5, `[${label}] Sessions lists every quiz (${before})`);
  await page.locator('.lib-session').first().locator('button').click();
  await page.waitForFunction((n) => document.querySelectorAll('.lib-session').length === n - 1, before);
  await page.waitForTimeout(450); // let the store refresh settle
  check((await page.locator('.lib-session').count()) === before - 1, `[${label}] Sessions delete removes the row`);
  await page.locator('.toast-action', { hasText: 'Undo' }).click();
  await page.waitForFunction((n) => document.querySelectorAll('.lib-session').length === n, before);
  check(true, 'undo');

  await context.close();
}

// ---------------------------------------------------------------------------
// 4. Screenshots: every screen, phone + iPad, light + dark
// ---------------------------------------------------------------------------

for (const vp of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    const label = `${vp.name}-${scheme}`;
    const { context, page } = await openApp(vp, /** @type {any} */ (scheme), label);
    await page.screenshot({ path: path.join(OUT, `home-fresh-${label}.png`), fullPage: true });
    await seed(page);
    // An unfinished session for the Continue card.
    await quick(page, 'Practice');
    check(await waitQuiz(page), `[${label}] Practice opens a quiz`);
    await go(page, '#/', '.screen-home .home-continue');
    await page.waitForSelector('.home-due');
    await noHScroll(page, `${label} home`);
    await page.screenshot({ path: path.join(OUT, `home-${label}.png`), fullPage: true });

    await go(page, '#/chapter/demo', '.screen-chapter .ch-actions');
    await noHScroll(page, `${label} chapter`);
    await page.screenshot({ path: path.join(OUT, `chapter-${label}.png`), fullPage: true });

    await go(page, '#/new', '.screen-builder .nb-startbar');
    await page.waitForFunction(() => /available/.test(document.querySelector('.nb-available')?.textContent ?? ''));
    await noHScroll(page, `${label} builder`);
    await page.screenshot({ path: path.join(OUT, `builder-${label}.png`), fullPage: true });

    for (const tab of ['bookmarks', 'sessions', 'flagged']) {
      await go(page, `#/library?tab=${tab}`, `.lib-panel[data-tab="${tab}"]:not([aria-busy]) .lib-list`);
      await noHScroll(page, `${label} library ${tab}`);
      await page.screenshot({ path: path.join(OUT, `library-${tab}-${label}.png`), fullPage: true });
    }
    // Touch targets on Home.
    await go(page, '#/', '.screen-home .home-qa');
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('#main a, #main button')]
        .filter((el) => el.offsetParent !== null)
        .map((el) => ({ el: el.className || el.tagName, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
        .map(({ el, r }) => `${el} ${Math.round(r.width)}x${Math.round(r.height)}`),
    );
    check(small.length === 0, `[${label}] touch targets < 44px on Home: ${small.join(', ')}`);
    await context.close();
  }
}

await browser.close();
await server.close();

if (stubs.size) console.warn(`(stubbed in memory: ${[...stubs.keys()].join(', ')})`);
if (failures.length) {
  console.error(`home visual check: ${failures.length} failure(s)`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.warn(`home visual check: OK (screenshots in ${OUT})`);
