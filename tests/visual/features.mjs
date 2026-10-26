#!/usr/bin/env node
/**
 * Browser check for the question features: note editor (features/notes.js),
 * voice notes (features/voice.js), Ask GPT (features/askgpt.js) and the
 * Listen control (features/tts.js).
 *
 * Builds an in-memory test page (served at tests/fixtures/features.html
 * through a server override, never written to disk) and checks in Chromium
 * with a fake microphone (--use-fake-ui-for-media-stream
 * --use-fake-device-for-media-stream):
 * - note: type → "Saved" → reload → text is back; char count only from 1000;
 *   a change from other code (store:change) shows up when not typing and
 *   never replaces unsaved typing; flush on blur.
 * - voice: record 2 s → stop → listed → reload → still listed → play →
 *   delete → Undo restores it; the microphone is released after stop.
 * - Ask GPT: one-time notice (Cancel keeps it, Continue opens with
 *   `noopener` a chatgpt.com/?q= URL and shows the copy toast); second tap
 *   opens at once; offline → disabled with "Needs internet"; back online.
 * - Listen: rendered when speechSynthesis exists; a tap never crashes (headless
 *   Chromium may have no voices; then it must fall back to a calm idle state).
 * Optional screenshots (phone 390×844 + iPad 834×1194, light + dark).
 *
 *   node tests/visual/features.mjs [--shots <dir>]
 *
 * Exit code 1 on any failure. Dev-only.
 *
 * @module tests/visual/features
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { startServer } from '../serve.mjs';

// The pre-installed Playwright is a global package: resolve it the CommonJS way (NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright');

const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg !== -1 ? path.resolve(process.argv[shotsArg + 1]) : null;
const FIXTURE = 'tests/fixtures/features.html';

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Features fixture</title>
  <link rel="stylesheet" href="../../css/tokens.css">
  <link rel="stylesheet" href="../../css/base.css">
  <link rel="stylesheet" href="../../css/components.css">
  <link rel="stylesheet" href="../../css/features.css">
  <style>
    body { background: var(--bg); color: var(--text); font-size: var(--fs-m); line-height: var(--lh-body); margin: 0; }
    .fx { max-width: var(--maxw); margin: 0 auto; padding: var(--sp-4); display: grid; gap: var(--sp-5); }
    .fx-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-l); padding: var(--sp-4); display: grid; gap: var(--sp-4); }
    .fx-tools { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: center; }
    .fx h1 { font-size: var(--fs-l); margin: 0; }
    .fx h2 { font-size: var(--fs-m); margin: 0; }
  </style>
</head>
<body>
  <main id="main" class="fx"></main>
  <div id="toast-slot" class="toast-slot" aria-live="polite"></div>
  <div id="sheet-slot"></div>
  <script type="module">
    import { h } from '../../js/core/dom.js';
    import { initSettings } from '../../js/core/settings.js';
    import { createNoteEditor } from '../../js/features/notes.js';
    import { createVoiceNotes } from '../../js/features/voice.js';
    import { createAskGptButton } from '../../js/features/askgpt.js';
    import { createListenButton } from '../../js/features/tts.js';
    import { bus } from '../../js/core/events.js';

    const question = {
      id: 'DEMO-9101', version: 1,
      stem: 'Sample stem: the **Alpha step** comes first -> then the Beta step. Which step comes first?',
      choices: [{ id: 'a', text: 'Alpha step' }, { id: 'b', text: 'Beta step' }, { id: 'c', text: 'Gamma step' }],
      answer: 'a',
      explanation: [{ id: 'p1', type: 'p', text: 'The Alpha step opens the sample sequence.' }],
    };
    const ctx = () => ({ choiceOrder: ['b', 'a', 'c'], userChoice: 'b', revealed: true });

    await initSettings();
    const main = document.getElementById('main');
    main.append(
      h('h1', null, 'Features check'),
      h('section', { class: 'fx-card' },
        h('h2', null, 'Sample stem'),
        h('p', null, 'Sample stem: the Alpha step comes first, then the Beta step. Which step comes first?'),
        h('div', { class: 'fx-tools' }, createListenButton(question, ctx), createAskGptButton(question, ctx)),
      ),
      h('section', { class: 'fx-card' },
        h('h2', null, 'Your notes'),
        createNoteEditor(question.id),
        createVoiceNotes(question.id),
      ),
    );
    // Lets the test emit bus events (net:change, route:change) like the app does.
    document.body.addEventListener('fx-emit', (e) => bus.emit(e.detail.name, e.detail.payload));
    document.body.dataset.ready = 'true';
  </script>
</body>
</html>`;

/** Records window.open calls and media tracks, before any page script runs. */
const INIT_SCRIPT = () => {
  window.__opened = [];
  window.open = (...args) => {
    window.__opened.push(args);
    return null; // what noopener returns
  };
  window.__tracks = [];
  const gum = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (gum) {
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await gum(c);
      window.__tracks.push(...s.getTracks());
      return s;
    };
  }
};

let failures = 0;
/**
 * @param {boolean} cond
 * @param {string} msg
 */
function check(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL ${msg}`);
  }
}

const server = await startServer({ port: 0 });
server.setOverride(FIXTURE, FIXTURE_HTML);
const url = server.url + FIXTURE;

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

/**
 * @param {{ width: number, height: number }} viewport
 * @param {'light' | 'dark'} colorScheme
 */
async function newPage(viewport, colorScheme) {
  const context = await browser.newContext({ viewport, colorScheme, permissions: ['microphone', 'clipboard-read', 'clipboard-write'] });
  await context.addInitScript(INIT_SCRIPT);
  const page = await context.newPage();
  /** @type {string[]} */
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForSelector('body[data-ready="true"]');
  return { context, page, errors };
}

/** @param {import('playwright').Page} page */
async function reload(page) {
  await page.reload();
  await page.waitForSelector('body[data-ready="true"]');
}

try {
  console.log('Functional checks (phone, light)');
  const { context, page, errors } = await newPage({ width: 390, height: 844 }, 'light');

  // ---- Note ---------------------------------------------------------------
  const note = page.locator('.note-input');
  await note.click();
  await note.pressSequentially('Alpha note line');
  await page.waitForSelector('.note-status[data-state="saved"]', { timeout: 3000 });
  check((await page.textContent('.note-status-text')) === 'Saved', 'note: "Saved" shows after typing');
  check(await page.locator('.note-count').isHidden(), 'note: character count hidden below 1000');
  await note.fill('x'.repeat(1001));
  await note.dispatchEvent('input');
  check((await page.textContent('.note-count'))?.includes('1,001 characters'), 'note: character count from 1000');
  await note.fill('Alpha note line');
  await note.dispatchEvent('input');
  const h0 = await note.evaluate((t) => t.offsetHeight);
  await note.fill('Line\n'.repeat(12));
  await note.dispatchEvent('input');
  const h1 = await note.evaluate((t) => t.offsetHeight);
  check(h1 > h0 + 60, `note: textarea grows (${h0} → ${h1}px)`);
  await note.fill('Alpha note line');
  await note.dispatchEvent('input');
  // Blur flushes at once (no 500 ms wait).
  await page.locator('h1').click();
  await page.waitForTimeout(150);
  await reload(page);
  await page.waitForFunction(() => document.querySelector('.note-input')?.value === 'Alpha note line', null, { timeout: 3000 });
  check(true, 'note: text is back after reload');

  // store:change from other code shows up when not typing...
  await page.evaluate(async () => {
    const { notesRepo } = await import('../../js/core/store/repo.js');
    await notesRepo.set('DEMO-9101', 'Imported note');
  });
  await page.waitForFunction(() => document.querySelector('.note-input')?.value === 'Imported note', null, { timeout: 2000 });
  check(true, 'note: follows store:change from other code');
  // ...but never replaces unsaved typing.
  await note.click();
  await note.press('End');
  await note.pressSequentially(' plus typing');
  await page.evaluate(async () => {
    const { notesRepo } = await import('../../js/core/store/repo.js');
    await notesRepo.set('DEMO-9101', 'Other code text');
  });
  await page.waitForTimeout(100);
  check((await note.inputValue()) === 'Imported note plus typing', 'note: unsaved typing is not clobbered');
  await page.waitForSelector('.note-status[data-state="saved"]', { timeout: 3000 });
  await page.locator('h1').click();

  // ---- Voice ----------------------------------------------------------------
  check(await page.locator('.voice-empty').isVisible(), 'voice: empty hint shown');
  await page.click('.voice-record');
  await page.waitForSelector('.voice-live:not([hidden])', { timeout: 5000 });
  check(true, 'voice: recording panel appears');
  await page.waitForTimeout(2100);
  const timerText = await page.textContent('.voice-timer');
  check(/^0:0[2-3]$/.test(timerText ?? ''), `voice: live timer runs (${timerText})`);
  const meter = await page.locator('.voice-meter-fill').evaluate((e) => e.style.transform);
  check(/scaleX\(/.test(meter), `voice: level meter updates (${meter})`);
  if (SHOTS) {
    await mkdir(SHOTS, { recursive: true });
    await page.locator('.voice-notes').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS, 'features-recording-phone-light.png') });
  }
  await page.click('.voice-stop');
  await page.waitForSelector('.voice-item', { timeout: 5000 });
  check((await page.locator('.voice-item').count()) === 1, 'voice: recording listed after stop');
  check(await page.evaluate(() => window.__tracks.length > 0 && window.__tracks.every((t) => t.readyState === 'ended')), 'voice: microphone released after stop');
  const timeText = await page.textContent('.voice-time');
  check(/0:00 \/ 0:0[1-3]/.test(timeText ?? ''), `voice: duration shown (${timeText})`);

  await reload(page);
  await page.waitForSelector('.voice-item', { timeout: 3000 });
  check((await page.locator('.voice-item').count()) === 1, 'voice: still listed after reload');

  await page.click('.voice-play');
  await page.waitForSelector('.voice-item.is-playing', { timeout: 3000 }).then(
    () => check(true, 'voice: plays'),
    () => check(false, 'voice: plays'),
  );
  await page.waitForTimeout(600);
  const pos = await page.locator('.voice-scrub').evaluate((r) => Number(r.value));
  check(pos > 0, `voice: scrubber follows playback (${pos} ms)`);
  await page.click('.voice-play');
  await page.waitForTimeout(100);
  check(!(await page.locator('.voice-item.is-playing').count()), 'voice: pause');

  await page.click('.voice-delete');
  await page.waitForTimeout(100);
  check((await page.locator('.voice-item').count()) === 0, 'voice: deleted at once');
  const stored0 = await page.evaluate(async () => (await (await import('../../js/core/store/repo.js')).voiceRepo.byQid('DEMO-9101')).length);
  check(stored0 === 0, 'voice: removed from storage');
  await page.click('.toast-action:has-text("Undo")');
  await page.waitForSelector('.voice-item', { timeout: 3000 });
  check((await page.locator('.voice-item').count()) === 1, 'voice: Undo restores it');
  await reload(page);
  await page.waitForSelector('.voice-item', { timeout: 3000 });
  check((await page.locator('.voice-item').count()) === 1, 'voice: restored note persists');

  // Recording is saved (not lost) when the screen changes.
  await page.click('.voice-record');
  await page.waitForSelector('.voice-live:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => document.body.dispatchEvent(new CustomEvent('fx-emit', { detail: { name: 'route:change', payload: {} } })));
  await page.waitForFunction(() => document.querySelectorAll('.voice-item').length === 2, null, { timeout: 3000 }).then(
    () => check(true, 'voice: recording saved on screen change'),
    () => check(false, 'voice: recording saved on screen change'),
  );
  await page.waitForTimeout(200);
  check(await page.evaluate(() => window.__tracks.every((t) => t.readyState === 'ended')), 'voice: microphone released on screen change');

  // ---- Ask GPT --------------------------------------------------------------
  await page.click('.askgpt-btn');
  await page.waitForSelector('.sheet .askgpt-notice', { timeout: 2000 });
  check(true, 'askgpt: one-time notice appears');
  await page.click('.sheet-footer button:has-text("Cancel")');
  await page.waitForTimeout(400);
  check((await page.evaluate(() => window.__opened.length)) === 0, 'askgpt: Cancel opens nothing');
  await page.click('.askgpt-btn');
  await page.waitForSelector('.sheet .askgpt-notice', { timeout: 2000 });
  check(true, 'askgpt: notice again after Cancel');
  if (SHOTS) {
    await page.waitForTimeout(500); // let the sheet finish sliding in
    await page.screenshot({ path: path.join(SHOTS, 'features-askgpt-notice-phone-light.png') });
  }
  await page.click('.sheet-footer button:has-text("Continue")');
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => window.__opened);
  check(opened.length === 1 && opened[0][0].startsWith('https://chatgpt.com/?q=') && opened[0][1] === '_blank' && opened[0][2] === 'noopener',
    'askgpt: Continue opens chatgpt.com/?q= with noopener');
  const prompt = decodeURIComponent(opened[0][0].slice('https://chatgpt.com/?q='.length));
  check(/A\. Beta step\nB\. Alpha step\nC\. Gamma step/.test(prompt) && /My answer: A\. Beta step/.test(prompt), 'askgpt: prompt has display order and user answer');
  await page.waitForSelector('.toast-action:has-text("Open ChatGPT")', { timeout: 2000 });
  check(true, 'askgpt: toast with "Open ChatGPT"');
  await page.click('.askgpt-btn');
  await page.waitForTimeout(300);
  check((await page.evaluate(() => window.__opened.length)) === 2 && !(await page.locator('.sheet .askgpt-notice').count()), 'askgpt: second tap opens at once (notice seen)');
  await context.setOffline(true);
  await page.waitForTimeout(200);
  check(await page.locator('.askgpt-btn').isDisabled(), 'askgpt: disabled offline');
  check((await page.textContent('.askgpt-hint')) === 'Needs internet', 'askgpt: "Needs internet" hint offline');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'features-offline-phone-light.png') });
  await context.setOffline(false);
  await page.waitForTimeout(200);
  check(await page.locator('.askgpt-btn').isEnabled(), 'askgpt: enabled again online');
  await page.evaluate(() => document.body.dispatchEvent(new CustomEvent('fx-emit', { detail: { name: 'net:change', payload: { online: false } } })));
  check(await page.locator('.askgpt-btn').isDisabled(), 'askgpt: follows net:change');
  await page.evaluate(() => document.body.dispatchEvent(new CustomEvent('fx-emit', { detail: { name: 'net:change', payload: { online: true } } })));

  // ---- Listen ---------------------------------------------------------------
  const hasTts = await page.evaluate(() => 'speechSynthesis' in window);
  const listen = page.locator('.listen');
  if (!hasTts) {
    check(await listen.isHidden(), 'listen: hidden without speechSynthesis');
  } else {
    check(await listen.isVisible(), 'listen: shown');
    const voices = await page.evaluate(() => speechSynthesis.getVoices().length);
    console.log(`  info headless voices: ${voices}`);
    check((await page.textContent('.listen-btn .btn-label')) === 'Listen', 'listen: idle label "Listen"');
    check(await page.locator('.listen-stop').isHidden(), 'listen: Stop hidden when idle');
    await page.click('.listen-btn');
    await page.waitForTimeout(800);
    const state = await listen.getAttribute('data-state');
    check(['idle', 'speaking', 'paused'].includes(state ?? ''), `listen: graceful state after tap (${state})`);
    if (state === 'speaking') {
      check((await page.textContent('.listen-btn .btn-label')) === 'Pause', 'listen: label "Pause" while speaking');
      await page.click('.listen-btn');
      check((await listen.getAttribute('data-state')) === 'paused', 'listen: pause');
      await page.click('.listen-btn');
      check((await listen.getAttribute('data-state')) === 'speaking', 'listen: resume');
      await page.evaluate(() => document.body.dispatchEvent(new CustomEvent('fx-emit', { detail: { name: 'route:change', payload: {} } })));
      check((await listen.getAttribute('data-state')) === 'idle', 'listen: stops on route:change');
    }
  }

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  await context.close();

  // ---- Screenshots -------------------------------------------------------------
  if (SHOTS) {
    console.log('Screenshots');
    for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['ipad', { width: 834, height: 1194 }]]) {
      for (const scheme of /** @type {const} */ (['light', 'dark'])) {
        const s = await newPage(viewport, scheme);
        // Seed two voice notes (silent WAV blobs) in this fresh context.
        await s.page.evaluate(async () => {
          const { voiceRepo } = await import('../../js/core/store/repo.js');
          const wav = (seconds) => {
            const rate = 8000;
            const n = rate * seconds;
            const buf = new DataView(new ArrayBuffer(44 + n));
            const str = (o, t) => [...t].forEach((c, i) => buf.setUint8(o + i, c.charCodeAt(0)));
            str(0, 'RIFF'); buf.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
            buf.setUint32(16, 16, true); buf.setUint16(20, 1, true); buf.setUint16(22, 1, true);
            buf.setUint32(24, rate, true); buf.setUint32(28, rate, true); buf.setUint16(32, 1, true);
            buf.setUint16(34, 8, true); str(36, 'data'); buf.setUint32(40, n, true);
            for (let i = 0; i < n; i++) buf.setUint8(44 + i, 128);
            return new Blob([buf], { type: 'audio/wav' });
          };
          await voiceRepo.add({ qid: 'DEMO-9101', blob: wav(3), mime: 'audio/wav', durationMs: 3000 });
          await voiceRepo.add({ qid: 'DEMO-9101', blob: wav(1), mime: 'audio/wav', durationMs: 72000 });
        });
        await s.page.waitForFunction(() => document.querySelectorAll('.voice-item').length === 2, null, { timeout: 3000 });
        await s.page.locator('.note-input').fill('Alpha note line\nSecond line of the sample note.');
        await s.page.locator('.note-input').dispatchEvent('input');
        await s.page.waitForSelector('.note-status[data-state="saved"]', { timeout: 3000 });
        const overflow = await s.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
        check(!overflow, `${name} ${scheme}: no horizontal scroll`);
        const small = await s.page.evaluate(() =>
          [...document.querySelectorAll('main button, main input[type=range]')]
            .filter((b) => b.offsetParent)
            .map((b) => b.getBoundingClientRect())
            .filter((r) => r.height < 28 || r.width < 28).length,
        );
        check(small === 0, `${name} ${scheme}: no tiny controls`);
        const file = path.join(SHOTS, `features-${name}-${scheme}.png`);
        await s.page.screenshot({ path: file, fullPage: true });
        console.log(`  shot ${file}`);
        check(s.errors.length === 0, `${name} ${scheme}: no console errors${s.errors.length ? `: ${s.errors.join(' | ')}` : ''}`);
        await s.context.close();
      }
    }
  }
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await browser.close();
  await server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll feature checks passed');
process.exit(failures ? 1 : 0);
