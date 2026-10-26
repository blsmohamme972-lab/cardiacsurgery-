#!/usr/bin/env node
/**
 * Boot smoke test (Playwright, Chromium, phone 390×844).
 *
 * Checks, in one browser context:
 *   1. The app boots: the splash goes away, `body[aria-busy]` is cleared, the
 *      header and the 5-tab bar render (with icons), and the home route mounts
 *      a screen (not the router's error state). No horizontal page scroll.
 *   2. Every tab opens its screen without errors.
 *   3. The service worker installs and activates and controls the page.
 *   4. The app reloads offline (context.setOffline(true)) and mounts home again.
 * Console errors, page errors (uncaught exceptions) and failed same-origin
 * requests fail the test (exit 1), except the expected ones listed in
 * EXPECTED_ERRORS.
 *
 * Files that don't exist yet are stubbed in memory with server.setOverride
 * (never on disk), detected at run time so the test keeps working as files
 * appear: missing screens get a minimal screen module, other missing modules
 * an empty module, missing stylesheets an empty sheet. The stubs cover every
 * sw.js APP_SHELL entry (or the worker install would fail) and every
 * relative import in js/ whose target is missing. The stubbed files are
 * listed in the output.
 *
 * Usage:
 *   node tests/smoke.mjs                 # run
 *   node tests/smoke.mjs --shots DIR     # also save screenshots (light + dark) to DIR
 *   node tests/smoke.mjs --verbose       # print every console message
 *
 * Uses the pre-installed Playwright (never installs it). Dev-only.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

import { ROOT, startServer } from './serve.mjs';
import { findImports, parseAppShell } from '../scripts/lint.mjs';

const VIEWPORT = { width: 390, height: 844 };
const BOOT_TIMEOUT_MS = 15000;
const SW_TIMEOUT_MS = 30000;

/** Console errors that are expected and harmless (regexes on the message text). */
const EXPECTED_ERRORS = [
  // Chromium logs this for an unsupported prefers-* media query in some builds.
  /^Unrecognized feature: /,
];

const SCREEN_STUB =
  '/** Smoke-test stub (screen not written yet). @module stub */\n' +
  'export default { async render() { const el = document.createElement("div"); el.dataset.stub = "screen"; return el; } };\n';
const MODULE_STUB = '/** Smoke-test stub (module not written yet). @module stub */\nexport {};\n';
const CSS_STUB = '/* Smoke-test stub (stylesheet not written yet). */\n';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Loads the pre-installed Playwright (global install, found through NODE_PATH). */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return createRequire(import.meta.url)('playwright');
  }
}

/**
 * @param {string} dir Repo-relative directory.
 * @returns {string[]} Repo-relative .js files below it.
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

/**
 * Files the app needs that are not on disk yet, with the stub to serve.
 * @returns {Map<string, string>}
 */
function missingFileStubs() {
  /** @type {Set<string>} */
  const wanted = new Set();
  const shell = parseAppShell(readFileSync(path.join(ROOT, 'sw.js'), 'utf8'));
  for (const e of shell?.entries ?? []) {
    const rel = e.path.replace(/^\.\//, '');
    if (rel) wanted.add(rel);
  }
  for (const file of jsFilesUnder('js')) {
    const src = readFileSync(path.join(ROOT, file), 'utf8');
    for (const ref of findImports(src)) {
      if (!ref.specifier.startsWith('./') && !ref.specifier.startsWith('../')) continue;
      wanted.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), ref.specifier)));
    }
  }
  const stubs = new Map();
  for (const rel of [...wanted].sort()) {
    if (existsSync(path.join(ROOT, rel))) continue;
    if (rel.startsWith('js/screens/') && rel.endsWith('.js')) stubs.set(rel, SCREEN_STUB);
    else if (rel.endsWith('.js')) stubs.set(rel, MODULE_STUB);
    else if (rel.endsWith('.css')) stubs.set(rel, CSS_STUB);
  }
  return stubs;
}

/**
 * Collects problems reported by the page.
 * @param {import('playwright').Page} page
 * @param {string} origin
 * @param {boolean} verbose
 */
function watchPage(page, origin, verbose) {
  /** @type {string[]} */
  const problems = [];
  let phase = 'boot';
  page.on('console', (msg) => {
    const text = msg.text();
    if (verbose) process.stdout.write(`  [console.${msg.type()}] ${text}\n`);
    if (msg.type() !== 'error') return;
    if (EXPECTED_ERRORS.some((re) => re.test(text))) return;
    const loc = msg.location();
    const where = loc && loc.url ? ` (${loc.url.replace(origin, '')}:${loc.lineNumber + 1})` : '';
    problems.push(`[${phase}] console error: ${text}${where}`);
  });
  page.on('pageerror', (err) => {
    problems.push(`[${phase}] page error: ${err.message}${err.stack ? `\n      ${err.stack.split('\n').slice(1, 3).join('\n      ')}` : ''}`);
  });
  page.on('requestfailed', (req) => {
    if (!req.url().startsWith(origin)) return;
    const reason = req.failure()?.errorText ?? 'failed';
    if (reason === 'net::ERR_ABORTED') return; // navigation replaced the request
    problems.push(`[${phase}] request failed: ${req.url().replace(origin, '')} (${reason})`);
  });
  page.on('response', (res) => {
    if (res.url().startsWith(origin) && res.status() >= 400) {
      problems.push(`[${phase}] HTTP ${res.status()}: ${res.url().replace(origin, '')}`);
    }
  });
  return {
    problems,
    /** @param {string} p */
    setPhase(p) {
      phase = p;
    },
  };
}

/**
 * Waits for the boot splash to go away and the first screen to mount.
 * @param {import('playwright').Page} page
 */
async function waitForBoot(page) {
  await page.waitForFunction(
    () => {
      const main = document.getElementById('main');
      return (
        !document.getElementById('boot') &&
        document.body.getAttribute('aria-busy') !== 'true' &&
        main !== null &&
        main.childElementCount > 0 &&
        !main.querySelector('.route-loading-wrap')
      );
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

/**
 * Inspects the rendered shell.
 * @param {import('playwright').Page} page
 */
function inspectShell(page) {
  return page.evaluate(() => {
    const header = document.getElementById('app-header');
    const tabs = [...document.querySelectorAll('#tabbar .tab')];
    const visible = (/** @type {Element | null} */ el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const main = document.getElementById('main');
    return {
      headerVisible: visible(header),
      headerText: (header?.textContent ?? '').trim(),
      tabCount: tabs.length,
      tabsVisible: tabs.filter(visible).length,
      tabIcons: tabs.filter((t) => t.querySelector('.tab-icon svg')).length,
      smallTabs: tabs
        .filter(visible)
        .map((t) => t.getBoundingClientRect())
        .filter((r) => r.width < 44 || r.height < 44).length,
      mainChildren: main?.childElementCount ?? 0,
      routeError: main?.querySelector('.route-error h1')?.textContent ?? null,
      stub: Boolean(main?.querySelector('[data-stub]')),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      theme: document.documentElement.dataset.theme ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {Promise<number>} Exit code.
 */
async function main(argv) {
  const verbose = argv.includes('--verbose');
  const shotsAt = argv.indexOf('--shots');
  const shotsDir = shotsAt !== -1 ? path.resolve(argv[shotsAt + 1] ?? '.') : null;
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });

  /** @type {string[]} */
  const failures = [];
  const check = (/** @type {boolean} */ ok, /** @type {string} */ what) => {
    process.stdout.write(`  ${ok ? 'ok  ' : 'FAIL'} ${what}\n`);
    if (!ok) failures.push(what);
  };

  const stubs = missingFileStubs();
  const server = await startServer({ port: 0 });
  for (const [rel, text] of stubs) server.setOverride(rel, text);
  process.stdout.write(`smoke: ${server.url}\n`);
  if (stubs.size) process.stdout.write(`  stubbed ${stubs.size} missing file(s): ${[...stubs.keys()].join(', ')}\n`);

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  let watcher = null;
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    watcher = watchPage(page, server.origin, verbose);

    // 1. Boot.
    process.stdout.write('boot\n');
    const started = Date.now();
    await page.goto(server.url, { waitUntil: 'load' });
    let booted = true;
    try {
      await waitForBoot(page);
    } catch {
      booted = false;
    }
    check(booted, `splash removed and first screen mounted (${Date.now() - started} ms)`);
    const s = await inspectShell(page);
    check(s.headerVisible, `header renders${s.headerText ? ` ("${s.headerText.slice(0, 40)}")` : ''}`);
    check(s.tabCount === 5 && s.tabsVisible === 5, `tab bar shows 5 tabs (found ${s.tabsVisible}/${s.tabCount})`);
    check(s.tabIcons === s.tabCount, `every tab has an icon (${s.tabIcons}/${s.tabCount})`);
    check(s.smallTabs === 0, 'tabs are at least 44×44 px');
    check(s.mainChildren > 0 && !s.routeError, `home route mounts a screen${s.stub ? ' (stub)' : ''}${s.routeError ? ` — error state: "${s.routeError}"` : ''}`);
    check(s.overflowX <= 0, `no horizontal page scroll (${s.overflowX}px extra)`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'smoke-home-light.png') });

    // First-run tour: shown once, skippable, then remembered (checked again after the offline reload).
    watcher.setPhase('tour');
    const tour = await page.waitForSelector('#sheet-slot .tour', { state: 'visible', timeout: 5000 }).catch(() => null);
    check(Boolean(tour), 'first-run tour opens');
    if (tour) {
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'smoke-tour.png') });
      await page.getByRole('button', { name: 'Skip', exact: true }).click();
      const closed = await page
        .waitForSelector('#sheet-slot .tour', { state: 'detached', timeout: 5000 })
        .then(() => true, () => false);
      check(closed, 'tour closes with "Skip"');
    }

    // 2. Every tab.
    watcher.setPhase('tabs');
    process.stdout.write('tabs\n');
    const tabs = await page.$$eval('#tabbar .tab', (els) => els.map((el) => el.getAttribute('data-route') || ''));
    for (const route of tabs) {
      // Mark the current screen, so the wait below sees the new one, not the old one.
      await page.evaluate(() => {
        for (const el of document.getElementById('main')?.children ?? []) el.setAttribute('data-smoke-old', '');
      });
      await page.click(`#tabbar .tab[data-route="${route}"]`);
      let ok = true;
      try {
        await page.waitForFunction(
          (r) => {
            const main = document.getElementById('main');
            const hash = location.hash.replace(/^#/, '') || '/';
            return (
              hash.split('?')[0] === r &&
              main &&
              main.childElementCount > 0 &&
              !main.querySelector('[data-smoke-old], .route-loading-wrap')
            );
          },
          route,
          { timeout: BOOT_TIMEOUT_MS },
        );
      } catch {
        ok = false;
      }
      const t = await inspectShell(page);
      const current = await page.$eval(`#tabbar .tab[data-route="${route}"]`, (el) => el.getAttribute('aria-current'));
      check(ok && !t.routeError, `#${route} mounts${t.stub ? ' (stub)' : ''}${t.routeError ? ` — error state: "${t.routeError}"` : ''}`);
      check(current === 'page', `#${route} tab is marked current`);
      check(t.overflowX <= 0, `#${route} has no horizontal page scroll (${t.overflowX}px extra)`);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `smoke-tab${route.replace(/\//g, '-') || '-home'}.png`) });
    }
    await page.click('#tabbar .tab[data-route="/"]');
    await waitForBoot(page).catch(() => {});

    // 3. Service worker.
    watcher.setPhase('sw');
    process.stdout.write('service worker\n');
    const sw = await page
      .evaluate(
        (ms) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ ok: false, why: 'timed out' }), ms);
            const finish = () => {
              clearTimeout(timer);
              navigator.serviceWorker.ready.then((ready) => {
                resolve({ ok: true, state: ready.active?.state ?? 'none' });
              });
            };
            // A failed install leaves the worker "redundant": report it instead of waiting.
            const watch = (/** @type {ServiceWorker | null | undefined} */ w) => {
              w?.addEventListener('statechange', () => {
                if (w.state === 'redundant' && !navigator.serviceWorker.controller) {
                  clearTimeout(timer);
                  resolve({ ok: false, why: 'install failed (worker became redundant; see console)' });
                }
              });
            };
            navigator.serviceWorker.getRegistration().then((reg) => {
              watch(reg?.installing);
              reg?.addEventListener('updatefound', () => watch(reg.installing));
            });
            if (navigator.serviceWorker.controller) finish();
            else navigator.serviceWorker.addEventListener('controllerchange', finish, { once: true });
          }),
        SW_TIMEOUT_MS,
      )
      .catch((err) => ({ ok: false, why: String(err) }));
    check(sw.ok === true, `service worker installed and controls the page${sw.ok ? ` (state ${sw.state})` : ` — ${sw.why}`}`);
    const cacheNames = await page.evaluate(async () => (await caches.keys()).sort());
    check(cacheNames.some((k) => k.startsWith('cmcq-shell-')) && cacheNames.some((k) => k.startsWith('cmcq-data-')), `caches created (${cacheNames.join(', ') || 'none'})`);

    // 4. Offline reload.
    watcher.setPhase('offline');
    process.stdout.write('offline reload\n');
    await context.setOffline(true);
    let offlineOk = true;
    try {
      await page.reload({ waitUntil: 'load' });
      await waitForBoot(page);
    } catch (err) {
      offlineOk = false;
      process.stdout.write(`    ${String(err).split('\n')[0]}\n`);
    }
    const o = await inspectShell(page).catch(() => null);
    check(offlineOk && Boolean(o) && o.mainChildren > 0 && !o.routeError, `app reloads offline and mounts home${o?.routeError ? ` — error state: "${o.routeError}"` : ''}`);
    check(Boolean(o) && o.tabsVisible === 5, 'tab bar renders offline');
    await page.waitForTimeout(1500);
    check(!(await page.$('#sheet-slot .tour')), 'tour stays dismissed after reload');
    const offlineBanner = await page.$eval('#banner-slot', (el) => (el.textContent ?? '').trim()).catch(() => '');
    process.stdout.write(`  info offline banner: ${offlineBanner ? `"${offlineBanner.slice(0, 60)}"` : '(none)'}\n`);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'smoke-offline.png') });
    await context.setOffline(false);
    await context.close();

    // Dark mode screenshot (separate context, no service worker needed).
    if (shotsDir) {
      const dark = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark', deviceScaleFactor: 2 });
      const p = await dark.newPage();
      const w = watchPage(p, server.origin, verbose);
      w.setPhase('dark');
      await p.goto(server.url, { waitUntil: 'load' });
      await waitForBoot(p).catch(() => {});
      await p.screenshot({ path: path.join(shotsDir, 'smoke-home-dark.png') });
      watcher.problems.push(...w.problems);
      await dark.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const problems = watcher ? watcher.problems : [];
  if (problems.length) {
    process.stdout.write(`\nunexpected errors (${problems.length}):\n`);
    for (const p of problems) process.stdout.write(`  ${p}\n`);
  }
  const failed = failures.length + problems.length;
  process.stdout.write(`\nsmoke: ${failures.length} failed check(s), ${problems.length} error(s) → ${failed ? 'FAILED' : 'OK'}\n`);
  return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`smoke: ${(err && err.stack) || err}\n`);
    process.exitCode = 1;
  },
);
