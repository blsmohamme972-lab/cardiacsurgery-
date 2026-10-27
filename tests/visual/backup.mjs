#!/usr/bin/env node
/**
 * Browser check for backup export/import and the review tools (dev-only, never loaded by the app).
 *
 * Serves the repo with tests/serve.mjs on a random port and an in-memory harness page
 * (tokens/base/components/review CSS + sheet/toast slots), then in Chromium:
 * 1. seeds IndexedDB through js/core/store/repo.js (incl. a voice blob, an image and a scratchpad scene),
 * 2. exports a backup with saveFile() and captures the download,
 * 3. wipes every store, imports through openImportDialog() with Merge, checks the round trip
 *    (voice bytes identical, lastRoute untouched), merges again (no duplicates),
 * 4. imports with Replace everything (confirm sheet) and checks extra device data is gone,
 *    then a backup made without media: Replace keeps the device's voice notes and images,
 * 5. opens a corrupt file and a review file → plain-language error state,
 * 6. sends a report and approves in the reviewer panel,
 * and takes screenshots of the report sheet, reviewer panel and import dialog at
 * phone (390×844) and iPad (834×1194) sizes in light and dark.
 *
 * Usage: node tests/visual/backup.mjs [--out <dir>]   (exit code 1 on any failure)
 *
 * @module tests/visual/backup
 */

import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join(os.tmpdir(), 'backup-shots'));

const HARNESS = 'tests/fixtures/backup-harness.html';
const HARNESS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Backup harness</title>
<link rel="stylesheet" href="../../css/tokens.css">
<link rel="stylesheet" href="../../css/base.css">
<link rel="stylesheet" href="../../css/components.css">
<link rel="stylesheet" href="../../css/review.css">
<script>document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';</script>
</head>
<body>
<main id="main" tabindex="-1" style="padding:16px;max-width:72ch;margin:0 auto"><h1 style="font-size:20px">Harness</h1><div id="mount"></div></main>
<div id="toast-slot" aria-live="polite"></div>
<div id="sheet-slot"></div>
<script type="module">document.body.dataset.ready = 'true';</script>
</body>
</html>`;

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'ipad', width: 834, height: 1194 },
];
const SCHEMES = ['light', 'dark'];

/** @type {string[]} */
const failures = [];
/**
 * @param {boolean} cond
 * @param {string} message
 */
function check(cond, message) {
  if (!cond) failures.push(message);
}

const QUESTION = { id: 'DEMO-0001', version: 2, reviewed: false, stem: 'Sample stem', choices: [], answer: 'a' };

const server = await startServer({ port: 0 });
server.setOverride(HARNESS, HARNESS_HTML);
const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

/**
 * @param {import('playwright').BrowserContext} context
 */
async function openPage(context) {
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  await page.goto(`${server.url}${HARNESS}`, { waitUntil: 'load' });
  await page.waitForSelector('body[data-ready="true"]');
  return { page, errors };
}

/**
 * First differing store between two snapshots (for failure messages).
 * @param {Record<string, any[]>} a
 * @param {Record<string, any[]>} b
 */
function diff(a, b) {
  for (const k of Object.keys(a)) {
    const x = JSON.stringify(a[k]);
    const y = JSON.stringify(b[k]);
    if (x !== y) return `${k}: ${x.slice(0, 300)} ≠ ${y.slice(0, 300)}`;
  }
  return '';
}

/** Closes every open sheet the way a user would (Esc), so the page is not left inert. */
async function closeSheets(page) {
  for (let i = 0; i < 5 && (await page.$('.sheet-root:not(.is-closing)')); i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
  }
  await page.waitForFunction(() => !document.querySelector('.sheet-root'));
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

/** Clears every store (in the page). */
async function wipe(page) {
  await page.evaluate(async () => {
    const repo = await import('../../js/core/store/repo.js');
    for (const name of repo.ALL_STORES) await repo.replaceStore(name, []);
  });
}

/** Snapshot of the stores as comparable plain data (voice → bytes array). */
async function snapshot(page) {
  return page.evaluate(async () => {
    const repo = await import('../../js/core/store/repo.js');
    /** @type {Record<string, any[]>} */
    const out = {};
    for (const name of repo.ALL_STORES) {
      const rows = await repo.dumpStore(name);
      out[name] = [];
      for (const r of rows) {
        const copy = { ...r };
        if (name === 'attempts') delete copy.id;
        if (name === 'voice' || name === 'media') copy.blob = copy.blob ? [...new Uint8Array(await copy.blob.arrayBuffer())].join(',') : null;
        out[name].push(Object.fromEntries(Object.entries(copy).sort(([a], [b]) => a.localeCompare(b))));
      }
      out[name].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return out;
  });
}

try {
  // ------------------------------------------------------------------
  // Functional round trip (iPad size, light, mouse → download path)
  // ------------------------------------------------------------------
  {
    const context = await browser.newContext({ viewport: { width: 834, height: 1194 }, colorScheme: 'light', acceptDownloads: true });
    const { page, errors } = await openPage(context);
    await wipe(page);
    await page.evaluate(async () => {
      const repo = await import('../../js/core/store/repo.js');
      await repo.settingsRepo.set('defaultCount', 40);
      await repo.settingsRepo.set('lastRoute', '/stats');
      await repo.qstateRepo.put({ qid: 'DEMO-0001', seen: 2, correct: 1, incorrect: 1, totalMs: 8000, bookmarked: true });
      await repo.attemptsRepo.add({ qid: 'DEMO-0001', choice: 'a', correct: true, ms: 3000, ts: 1761480000000, mode: 'tutor', sessionId: 's1' });
      await repo.attemptsRepo.add({ qid: 'DEMO-0001', choice: 'b', correct: false, ms: 5000, ts: 1761480001000, mode: 'tutor', sessionId: 's1' });
      await repo.notesRepo.set('DEMO-0001', 'Alpha note');
      await repo.highlightsRepo.add({ qid: 'DEMO-0001', qversion: 1, block: 'stem', quote: 'Sample', prefix: '', suffix: ' stem', start: 0, color: 'green' });
      await repo.inkRepo.set('DEMO-0001', 'stem', { qversion: 1, strokes: [{ tool: 'pen', color: '#1d4ed8', size: 0.006, pts: [0.1, 0.1, 0.5, 0.2, 0.3, 0.6] }] });
      const bytes = new Uint8Array(250_001).map((_, i) => (i * 31 + 3) & 255);
      await repo.voiceRepo.add({ qid: 'DEMO-0001', blob: new Blob([bytes], { type: 'audio/webm' }), mime: 'audio/webm', durationMs: 4200 });
      const imgBytes = new Uint8Array(180_002).map((_, i) => (i * 17 + 5) & 255);
      const img = await repo.mediaRepo.add({ qid: 'DEMO-0001', blob: new Blob([imgBytes], { type: 'image/jpeg' }), width: 1600, height: 1200 });
      await repo.inkRepo.set('DEMO-0001', 'scratch', {
        qversion: 1,
        strokes: [],
        scene: {
          v: 2,
          page: { w: 2000, h: 3000, bg: 'dots' },
          items: [
            { id: 'it1', type: 'image', media: img.id, x: 100, y: 100, w: 800, h: 600, rot: 0 },
            { id: 'it2', type: 'stroke', tool: 'pen', color: '#1d4ed8', size: 6, pts: [150, 150, 0.5, 300, 320, 0.6] },
          ],
        },
      });
      await repo.reportsRepo.add({ qid: 'DEMO-0001', qversion: 1, reason: 'Other', text: 'Alpha step' });
      await repo.reviewsRepo.set('DEMO-0001', { qversion: 1, status: 'fix', comment: 'Sample comment' });
      await repo.sessionsRepo.put({ id: 's1', mode: 'tutor', qids: ['DEMO-0001'], answers: {}, index: 0, createdAt: 1761480000000, updatedAt: 1761480002000, finishedAt: null });
    });
    const original = await snapshot(page);

    // Export + capture the download.
    const [download, saved] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate(async () => {
        const b = await import('../../js/features/backup.js');
        const { blob, filename } = await b.exportBackup({ includeMedia: true });
        return b.saveFile(blob, filename);
      }),
    ]);
    check(saved === 'downloaded', `saveFile returned ${saved}`);
    check(/^cardiac-mcq-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), `filename ${download.suggestedFilename()}`);
    const file = path.join(OUT, 'export.json');
    await download.saveAs(file);
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    check(parsed.type === 'cardiac-mcq-backup' && parsed.formatVersion === 1, 'export header');
    check(parsed.stores.voice?.length === 1 && parsed.stores.voice[0].blob === null && parsed.stores.voice[0].data.length > 300000, 'voice exported as base64');
    check(parsed.stores.media?.length === 1 && parsed.stores.media[0].blob === null && parsed.stores.media[0].data.length > 240000
      && parsed.stores.media[0].mime === 'image/jpeg' && parsed.stores.media[0].bytes === 180002, 'image exported as base64');
    check(parsed.stores.ink.some((r) => r.block === 'scratch' && r.scene?.items?.length === 2), 'scratchpad scene exported');
    check(!parsed.stores.settings.some((r) => r.key === 'lastRoute'), 'lastRoute not exported');

    // Wipe, keep a device lastRoute, import with Merge through the dialog.
    await wipe(page);
    await page.evaluate(async () => (await import('../../js/core/store/repo.js')).settingsRepo.set('lastRoute', '/library'));
    const openDialog = async (content, name = 'backup.json') => {
      await page.evaluate(
        async ({ content, name }) => {
          const b = await import('../../js/features/backup.js');
          window.__importResult = undefined;
          b.openImportDialog(new File([content], name, { type: 'application/json' })).then((r) => {
            window.__importResult = r;
          });
        },
        { content, name },
      );
    };
    await openDialog(text);
    await page.waitForSelector('.bk-option-input');
    check((await page.textContent('.bk-counts')).includes('Voice notes'), 'summary lists voice notes');
    check((await page.textContent('.bk-counts')).includes('Images'), 'summary lists images');
    check((await page.textContent('.bk-media')).trim() === 'Includes voice notes and images', 'media chip (with media)');
    check(await page.isChecked('.bk-option-merge .bk-option-input'), 'merge is the default');
    await page.click('.bk-import-btn');
    await page.waitForFunction(() => window.__importResult !== undefined);
    await page.waitForSelector('.toast');
    const afterMerge = await snapshot(page);
    const strip = (snap) => ({ ...snap, settings: snap.settings.filter((r) => r.key !== 'lastRoute') });
    check(JSON.stringify(strip(afterMerge)) === JSON.stringify(strip(original)), `merge round trip restores every record (incl. voice bytes): ${diff(strip(original), strip(afterMerge))}`);
    check(afterMerge.settings.find((r) => r.key === 'lastRoute')?.value === '/library', 'lastRoute untouched by merge');

    // Merge again: nothing duplicated.
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await openDialog(text);
    await page.waitForSelector('.bk-option-input');
    await page.click('.bk-import-btn');
    await page.waitForFunction(() => window.__importResult !== undefined);
    const again = await page.evaluate(() => window.__importResult);
    check(again && again.added === 0, `second merge added ${again?.added}`);
    const toastText = await page.textContent('.toast');
    check(/Nothing new/.test(toastText || ''), `second merge toast: ${toastText}`);
    check((await snapshot(page)).attempts.length === 2, 'attempts deduplicated');

    // Replace: extra device data disappears; confirm sheet in between.
    await page.evaluate(async () => (await import('../../js/core/store/repo.js')).notesRepo.set('DEMO-0002', 'Extra device note'));
    await openDialog(text);
    await page.waitForSelector('.bk-option-input');
    await page.click('.bk-option-replace');
    check((await page.textContent('.bk-import-btn')).trim() === 'Replace', 'danger button label');
    await page.click('.bk-import-btn');
    await page.waitForSelector('.sheet-root:last-child .btn-danger');
    await page.screenshot({ path: path.join(OUT, 'replace-confirm-ipad-light.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, 'replace-confirm-phone-light.png') });
    await page.setViewportSize({ width: 834, height: 1194 });
    await page.click('.sheet-root:last-child .btn-danger');
    await page.waitForFunction(() => window.__importResult !== undefined);
    const afterReplace = await snapshot(page);
    check(!afterReplace.notes.some((n) => n.qid === 'DEMO-0002'), 'replace removed extra device note');
    check(JSON.stringify(strip(afterReplace)) === JSON.stringify(strip(original)), `replace round trip matches: ${diff(strip(original), strip(afterReplace))}`);
    check(afterReplace.settings.find((r) => r.key === 'lastRoute')?.value === '/library', 'lastRoute untouched by replace');

    // A backup made without media: Replace keeps the device's voice notes and images.
    const lightText = await page.evaluate(async () => {
      const b = await import('../../js/features/backup.js');
      return (await b.exportBackup({ includeMedia: false })).blob.text();
    });
    const light = JSON.parse(lightText);
    check(light.includesMedia === false && !('voice' in light.stores) && !('media' in light.stores), 'export without media omits voice + media');
    await closeSheets(page);
    await openDialog(lightText);
    await page.waitForSelector('.bk-option-input');
    check((await page.textContent('.bk-media')).trim() === 'No voice notes or images in this backup', 'media chip (without media)');
    check(/Voice notes and images on this device are kept/.test(await page.textContent('.bk-option-replace')), 'replace text says media is kept');
    await page.click('.bk-option-replace');
    await page.click('.bk-import-btn');
    await page.waitForSelector('.sheet-root:last-child .btn-danger');
    await page.click('.sheet-root:last-child .btn-danger');
    await page.waitForFunction(() => window.__importResult !== undefined);
    const lightResult = await page.evaluate(() => window.__importResult);
    check(lightResult?.keptVoice === true && lightResult?.keptMedia === true, 'replace result reports kept voice + media');
    const afterLight = await snapshot(page);
    check(JSON.stringify(afterLight.media) === JSON.stringify(original.media), 'device images kept (bytes identical)');
    check(JSON.stringify(afterLight.voice) === JSON.stringify(original.voice), 'device voice notes kept');

    // Corrupt and wrong files.
    for (const [content, expect] of [
      ['{"type":"cardiac-mcq-backup","formatVersion":1,"stores":{"notes":[{"qid":', /incomplete or damaged/],
      [JSON.stringify({ type: 'cardiac-mcq-review', formatVersion: 1, reviews: [], reports: [] }), /review file/],
      ['not json at all', /isn't a KirKlin backup/],
    ]) {
      await closeSheets(page);
      await openDialog(content);
      await page.waitForSelector('.bk-error-state');
      const msg = await page.textContent('.bk-error-text');
      check(expect.test(msg || ''), `error message "${msg}" should match ${expect}`);
    }
    check((await snapshot(page)).notes.length === 1, 'bad files changed nothing');

    // Report sheet: choose a reason, type, send.
    await closeSheets(page);
    await page.evaluate(async (q) => (await import('../../js/features/review.js')).openReportSheet(q), QUESTION);
    await page.waitForSelector('.rv-option');
    await page.click('.rv-option:nth-child(2)');
    await page.fill('.rv-textarea', 'Sample detail');
    await page.click('.sheet-footer .btn-primary');
    await page.waitForSelector('.toast');
    const reports = await page.evaluate(async () => (await import('../../js/core/store/repo.js')).reportsRepo.byQid('DEMO-0001'));
    check(reports.some((r) => r.reason === 'Unclear question' && r.text === 'Sample detail' && r.qversion === 2), 'report saved');

    // Reviewer panel: stale review (v1 vs v2) → Approve.
    await page.evaluate(async (q) => {
      const { createReviewerPanel } = await import('../../js/features/review.js');
      document.getElementById('mount').replaceChildren(createReviewerPanel(q));
    }, QUESTION);
    await page.waitForSelector('.rv-panel.is-stale');
    await page.click('.rv-verdict-ok');
    await page.waitForSelector('.rv-verdict-ok[aria-pressed="true"]');
    await page.fill('.rv-panel .rv-textarea', 'Looks fine');
    await page.waitForFunction(async () => {
      const repo = await import('../../js/core/store/repo.js');
      const r = await repo.reviewsRepo.get('DEMO-0001');
      return r && r.status === 'ok' && r.qversion === 2 && r.comment === 'Looks fine';
    }, null, { timeout: 4000 });

    // Review file export.
    const reviewFile = await page.evaluate(async () => {
      const { exportReviewFile } = await import('../../js/features/review.js');
      const { blob, filename } = await exportReviewFile();
      return { filename, json: JSON.parse(await blob.text()) };
    });
    check(reviewFile.json.type === 'cardiac-mcq-review' && reviewFile.json.reviews.length === 1 && reviewFile.json.reports.length === 2, 'review file content');

    // Storage info.
    const info = await page.evaluate(async () => (await import('../../js/features/backup.js')).storageInfo());
    check(typeof info.usage === 'number' && typeof info.persisted === 'boolean', 'storageInfo shape');

    check(errors.length === 0, `console errors (functional): ${errors.join(' | ')}`);
    await context.close();
  }

  // ------------------------------------------------------------------
  // Screenshots
  // ------------------------------------------------------------------
  const sample = JSON.stringify({
    type: 'cardiac-mcq-backup',
    formatVersion: 1,
    appVersion: '2026.10.26-1',
    exportedAt: '2026-10-25T14:05:00.000Z',
    includesMedia: false,
    stores: {
      qstate: [{ qid: 'DEMO-0001', seen: 1, correct: 1, incorrect: 0, totalMs: 1, lastTs: 1, bookmarked: false, srs: null }],
      attempts: [{ qid: 'DEMO-0001', choice: 'a', correct: true, ms: 1, ts: 1, mode: 'tutor', sessionId: null }],
      notes: [{ qid: 'DEMO-0001', text: 'Alpha', updated: 1 }],
      sessions: [{ id: 's', updatedAt: 1, finishedAt: null }],
    },
  });
  for (const vp of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      const tag = `${vp.name}-${scheme}`;
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
        colorScheme: scheme,
        hasTouch: vp.name === 'phone',
      });
      const { page, errors } = await openPage(context);
      await page.evaluate(async () => {
        document.documentElement.dataset.reduceMotion = 'true';
        const repo = await import('../../js/core/store/repo.js');
        await repo.reviewsRepo.set('DEMO-0001', { qversion: 1, status: 'fix', comment: 'Sample comment for the author' });
      });

      // Report sheet with a chosen reason.
      await page.evaluate(async (q) => (await import('../../js/features/review.js')).openReportSheet(q), QUESTION);
      await page.waitForSelector('.rv-option');
      await page.click('.rv-option:nth-child(3)');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `report-${tag}.png`) });
      const small = await page.evaluate(() =>
        [...document.querySelectorAll('.rv-option, .sheet-footer .btn')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.height < 44;
        }).length,
      );
      check(small === 0, `${tag}: report sheet targets under 44px: ${small}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);

      // Reviewer panel (stale state) + badge.
      await page.evaluate(async (q) => {
        const { createReviewerPanel, unreviewedBadge } = await import('../../js/features/review.js');
        // The badge shows only in Reviewer mode (learners never see it).
        document.getElementById('mount').replaceChildren(...[unreviewedBadge(q), createReviewerPanel(q)].filter(Boolean));
      }, QUESTION);
      await page.waitForSelector('.rv-panel.is-stale');
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(OUT, `panel-${tag}.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(overflow <= 0, `${tag}: horizontal overflow ${overflow}px`);

      // Import dialog (summary) and error state.
      await page.evaluate(async (content) => {
        const b = await import('../../js/features/backup.js');
        b.openImportDialog(new File([content], 'x.json'));
      }, sample);
      await page.waitForSelector('.bk-option-input');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `import-${tag}.png`) });
      await page.click('.bk-option-replace');
      await page.waitForTimeout(100);
      await page.screenshot({ path: path.join(OUT, `import-replace-${tag}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      await page.evaluate(async () => {
        const b = await import('../../js/features/backup.js');
        b.openImportDialog(new File(['{"type":"cardiac-mcq-backup", "formatVersion": 1, "stores": {"no'], 'x.json'));
      });
      await page.waitForSelector('.bk-error-state');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `import-error-${tag}.png`) });

      check(errors.length === 0, `${tag}: console errors: ${errors.join(' | ')}`);
      await context.close();
    }
  }
} catch (err) {
  failures.push(`crashed: ${err?.stack || err}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`FAIL (${failures.length})\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`OK — screenshots in ${OUT}`);
