/**
 * Settings screen (`#/settings`, docs/ARCHITECTURE.md §8, §5.5, §7.12, §7.15).
 *
 * Sections: Appearance (theme, text size with live preview, motion), Read
 * aloud (English device voices best first + Preview, speed, how to get a
 * better voice; hidden when the browser can't speak), Study (shuffle,
 * default count, exam seconds per question, auto-advance, timer, drawing
 * input), Your data (export with/without voice notes or images, import, storage used,
 * protection status), Reviewer mode (+ dashboard link), Help (tour, demo)
 * and About (version, check for update, offline note).
 *
 * Every control saves instantly with `setSetting()` (no Save button). Heavy
 * tools (backup, read aloud, tour, quiz starter, update checker) load on
 * demand with `import()`, so one failing tool never breaks the screen.
 *
 * @module screens/settings
 */

import { h, clear } from '../core/dom.js';
import { bus } from '../core/events.js';
import { navigate } from '../core/router.js';
import { getSetting, setSetting, FONT_SCALE_MIN, FONT_SCALE_MAX } from '../core/settings.js';
import { clamp, plural } from '../core/util.js';
import { APP_VERSION } from '../version.js';
import { setHeader } from '../ui/shell.js';
import { icon } from '../ui/icons.js';
import { button, iconButton, segmented, toggle, listItem, toast, progressBar, chip, spinner } from '../ui/components.js';

const FONT_STEP = 0.05;
const RATE_MIN = 0.8;
const RATE_MAX = 1.4;
const RATE_STEP = 0.1;
const COUNT_PRESETS = [10, 20, 40, 'all'];
const EXAM_SECONDS_STEP = 15;
const EXAM_SECONDS_MIN = 30;
const EXAM_SECONDS_MAX = 600;

/** Plain messages for `checkForUpdate()` results (sw-client.js). */
const UPDATE_MESSAGES = Object.freeze({
  'update-ready': 'An update is ready. Tap “Update” in the banner at the top to install it.',
  downloading: 'An update is downloading. A banner will appear when it is ready.',
  'up-to-date': 'You have the latest version.',
  offline: "You're offline. Connect to the internet, then check again.",
  unsupported: "This browser can't check for updates here. Open the app from your home screen, or reload the page.",
  error: "Couldn't check right now. Please try again in a moment.",
});

/** Icon shown beside each section heading (decorative). */
const SECTION_ICONS = Object.freeze({
  appearance: 'sun',
  read: 'volume',
  study: 'target',
  data: 'layers',
  reviewer: 'check',
  help: 'info',
  about: 'heart',
});

/**
 * Saves a setting; tells the user when it only lasts for this session.
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
async function save(key, value) {
  try {
    const stored = await setSetting(key, value);
    if (!stored) {
      toast("This change works now, but your device couldn't store it. It may reset when the app restarts.", { kind: 'danger' });
    }
  } catch (err) {
    console.error(`[settings] Could not change "${key}":`, err);
    toast("Couldn't change this setting. Please try again.", { kind: 'danger' });
  }
}

/**
 * A section heading with its (decorative) icon badge.
 * @param {string} id
 * @param {string} title
 * @returns {HTMLElement}
 */
function sectionHeading(id, title) {
  const name = /** @type {Record<string, string>} */ (SECTION_ICONS)[id];
  return h(
    'h2',
    { class: ['misc-h2', name && 'has-icon'], id: `set-${id}-h` },
    name ? h('span', { class: 'misc-h2-icon', 'aria-hidden': 'true' }, icon(name, { size: 16 })) : null,
    title,
  );
}

/**
 * A titled settings section.
 * @param {string} id
 * @param {string} title
 * @param {...(Node | null | false)} children
 * @returns {HTMLElement}
 */
function section(id, title, ...children) {
  return h(
    'section',
    { class: 'misc-section', id: `set-${id}`, 'aria-labelledby': `set-${id}-h` },
    sectionHeading(id, title),
    h('div', { class: 'set-group' }, ...children),
  );
}

/**
 * A row with a visible label (and optional hint) above or beside a control.
 * @param {{ label: string, hint?: string, control: Node, labelId?: string, forId?: string, stacked?: boolean }} opts
 * @returns {HTMLElement}
 */
function row({ label, hint, control, labelId, forId, stacked = false }) {
  const hintId = hint && labelId ? `${labelId}-hint` : undefined;
  return h(
    'div',
    { class: ['set-row', stacked && 'is-stacked'] },
    h(
      'div',
      { class: 'set-row-text' },
      forId
        ? h('label', { class: 'set-label', id: labelId, for: forId }, label)
        : h('span', { class: 'set-label', id: labelId }, label),
      hint ? h('span', { class: 'set-hint', id: hintId }, hint) : null,
    ),
    h('div', { class: 'set-row-control' }, control),
  );
}

/**
 * A wrapped toggle row (the component already has label + description).
 * @param {string} key
 * @param {string} label
 * @param {string} [description]
 * @returns {HTMLElement}
 */
function settingToggle(key, label, description) {
  return h(
    'div',
    { class: 'set-row is-toggle' },
    toggle({ checked: getSetting(key) === true, label, description, onChange: (on) => void save(key, on) }),
  );
}

/**
 * Starts a quiz through `quiz/start.js` (loaded on demand) and opens it.
 * @param {Record<string, any>} options
 * @returns {Promise<void>}
 */
async function startAndOpen(options) {
  try {
    const mod = await import('../features/quiz/start.js');
    const id = await mod.startQuiz(options);
    navigate(`/quiz/${encodeURIComponent(id)}`);
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (!e?.userMessage) console.error('[settings] startQuiz failed:', err);
    toast(e?.userMessage || "Couldn't start the demo. Please reload the app and try again.", {
      kind: e?.name === 'NoQuestionsError' ? 'info' : 'danger',
    });
  }
}

/**
 * Runs an async button action with a busy state; the button can't be double-tapped.
 * @param {HTMLButtonElement} btn
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
async function busy(btn, fn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

/**
 * @param {Set<() => void>} offs
 * @returns {HTMLElement}
 */
function appearanceSection(offs) {
  const theme = segmented({
    ariaLabel: 'Theme',
    value: getSetting('theme'),
    options: [
      { value: 'system', label: 'Automatic' },
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ],
    onChange: (v) => void save('theme', v),
  });

  const pctText = (/** @type {number} */ v) => `${Math.round(v * 100)}%`;
  const current = () => clamp(Number(getSetting('fontScale')) || 1, FONT_SCALE_MIN, FONT_SCALE_MAX);
  const slider = /** @type {HTMLInputElement} */ (
    h('input', {
      type: 'range',
      id: 'set-font',
      class: 'set-range',
      min: String(FONT_SCALE_MIN),
      max: String(FONT_SCALE_MAX),
      step: String(FONT_STEP),
      value: String(current()),
      'aria-valuetext': pctText(current()),
    })
  );
  const valueOut = h('output', { class: 'set-value tabular', for: 'set-font' }, pctText(current()));
  const smaller = iconButton({ icon: 'minus', label: 'Smaller text', onClick: () => setFont(current() - FONT_STEP) });
  const larger = iconButton({ icon: 'plus', label: 'Larger text', onClick: () => setFont(current() + FONT_STEP) });
  const reset = button({ label: 'Reset', variant: 'ghost', size: 's', onClick: () => setFont(1) });

  /** Updates the controls to the current value. */
  const showFont = () => {
    const v = current();
    slider.value = String(v);
    slider.setAttribute('aria-valuetext', pctText(v));
    valueOut.textContent = pctText(v);
    smaller.disabled = v <= FONT_SCALE_MIN + 1e-9;
    larger.disabled = v >= FONT_SCALE_MAX - 1e-9;
    reset.hidden = Math.abs(v - 1) < 1e-9;
  };
  /** @param {number} v */
  const setFont = (v) => {
    const next = Math.round(clamp(v, FONT_SCALE_MIN, FONT_SCALE_MAX) * 100) / 100;
    void save('fontScale', next);
    showFont();
  };
  slider.addEventListener('input', () => setFont(Number(slider.value)));
  showFont();

  const motion = segmented({
    ariaLabel: 'Reduce motion',
    value: ((v) => (v === true ? 'on' : v === false ? 'off' : v))(getSetting('reduceMotion')),
    options: [
      { value: 'system', label: 'Automatic' },
      { value: 'on', label: 'On' },
      { value: 'off', label: 'Off' },
    ],
    onChange: (v) => void save('reduceMotion', v),
  });

  // Keep controls in step when a setting changes elsewhere (another tab, import).
  offs.add(
    bus.on('settings:change', (p) => {
      if (!p) return;
      if (p.key === 'theme') theme.value = p.value;
      if (p.key === 'fontScale') showFont();
    }),
  );

  return section(
    'appearance',
    'Appearance',
    row({ label: 'Theme', hint: 'Automatic follows your device.', control: theme, stacked: true }),
    h(
      'div',
      { class: 'set-row is-stacked' },
      h(
        'div',
        { class: 'set-row-text set-row-head' },
        h('label', { class: 'set-label', for: 'set-font' }, 'Text size'),
        valueOut,
        reset,
      ),
      h('div', { class: 'set-font-control' }, smaller, slider, larger),
      h(
        'p',
        { class: 'set-preview', 'aria-label': 'Preview' },
        h('strong', {}, 'Preview. '),
        'This is how question text will look. Pick a size that is easy to read at arm’s length.',
      ),
    ),
    row({ label: 'Reduce motion', hint: 'Turn animations down or off.', control: motion, stacked: true }),
  );
}

// ---------------------------------------------------------------------------
// Read aloud
// ---------------------------------------------------------------------------

/**
 * Fills the Read aloud section once the read-aloud module and voices load.
 * Hides the section when the browser can't speak.
 * @param {HTMLElement} sec
 * @param {HTMLElement} body
 * @param {() => boolean} isAlive
 * @returns {Promise<void>}
 */
async function fillReadAloud(sec, body, isAlive) {
  let tts;
  try {
    tts = await import('../features/tts.js');
  } catch (err) {
    console.warn('[settings] Read aloud unavailable:', err);
    sec.hidden = true;
    return;
  }
  if (!isAlive()) return;
  if (!tts.isTtsSupported()) {
    sec.hidden = true;
    return;
  }

  /** @type {SpeechSynthesisVoice[]} */
  let voices = [];
  try {
    voices = await tts.listEnglishVoices();
  } catch (err) {
    console.warn('[settings] Could not list voices:', err);
  }
  if (!isAlive()) return;

  const saved = getSetting('ttsVoice');
  const select = /** @type {HTMLSelectElement} */ (
    h(
      'select',
      { id: 'set-voice', class: 'set-select', disabled: voices.length === 0 },
      h('option', { value: '' }, voices.length ? `Automatic (${voices[0].name})` : 'Automatic'),
      voices.map((v) => h('option', { value: v.voiceURI }, `${v.name} · ${v.lang}`)),
    )
  );
  select.value = voices.some((v) => v.voiceURI === saved) ? saved : '';
  select.addEventListener('change', () => void save('ttsVoice', select.value || null));

  const rateText = (/** @type {number} */ r) => `${r.toFixed(1)}×`;
  const rateNow = () => clamp(Number(getSetting('ttsRate')) || 1, RATE_MIN, RATE_MAX);
  const rate = /** @type {HTMLInputElement} */ (
    h('input', {
      type: 'range',
      id: 'set-rate',
      class: 'set-range',
      min: String(RATE_MIN),
      max: String(RATE_MAX),
      step: String(RATE_STEP),
      value: String(rateNow()),
      'aria-valuetext': rateText(rateNow()),
    })
  );
  const rateOut = h('output', { class: 'set-value tabular', for: 'set-rate' }, rateText(rateNow()));
  rate.addEventListener('input', () => {
    const r = Math.round(clamp(Number(rate.value), RATE_MIN, RATE_MAX) * 10) / 10;
    rate.setAttribute('aria-valuetext', rateText(r));
    rateOut.textContent = rateText(r);
    void save('ttsRate', r);
  });

  const preview = button({
    label: 'Preview',
    icon: 'play',
    variant: 'secondary',
    onClick: () =>
      void busy(preview, async () => {
        const voice = voices.find((v) => v.voiceURI === select.value) || voices[0] || null;
        try {
          await tts.previewVoice(voice, rateNow());
        } catch (err) {
          toast(/** @type {any} */ (err)?.message || "This voice couldn't play. Try another one.", { kind: 'danger' });
        }
      }),
  });

  const tip = h(
    'details',
    { class: 'set-details' },
    h('summary', {}, 'Get a clearer voice (free)'),
    h(
      'div',
      { class: 'set-details-body' },
      h(
        'p',
        {},
        h('strong', {}, 'iPhone / iPad: '),
        'Settings › Accessibility › Spoken Content › Voices › English. Pick a voice marked “Premium” or “Enhanced” and download it.',
      ),
      h(
        'p',
        {},
        h('strong', {}, 'Android: '),
        'Settings › Accessibility › Text-to-speech › Google › Install voice data › English (high quality).',
      ),
      h('p', { class: 'set-hint' }, 'Then come back here and pick it. Voices run on your device, so reading aloud works offline.'),
    ),
  );

  clear(body);
  body.classList.remove('set-loading');
  body.classList.add('set-read-body');
  body.append(
    voices.length === 0
      ? h('p', { class: 'misc-note' }, 'No English voice was found on this device yet. Follow the tip below to add one.')
      : null,
    row({ label: 'Voice', hint: 'English voices on this device, best first.', control: select, labelId: 'set-voice-l', forId: 'set-voice', stacked: true }),
    h(
      'div',
      { class: 'set-row is-stacked' },
      h('div', { class: 'set-row-text set-row-head' }, h('label', { class: 'set-label', for: 'set-rate' }, 'Speed'), rateOut),
      h('div', { class: 'set-font-control' }, h('span', { class: 'set-scale-end', 'aria-hidden': 'true' }, 'Slower'), rate, h('span', { class: 'set-scale-end', 'aria-hidden': 'true' }, 'Faster')),
      h('div', { class: 'set-actions' }, preview),
    ),
    h('div', { class: 'set-row is-stacked' }, tip),
  );
}

// ---------------------------------------------------------------------------
// Study
// ---------------------------------------------------------------------------

/** @returns {HTMLElement} */
function studySection() {
  const savedCount = getSetting('defaultCount');
  const countOptions = COUNT_PRESETS.includes(savedCount) ? COUNT_PRESETS : [...COUNT_PRESETS.slice(0, 3), savedCount, 'all'];
  const count = segmented({
    ariaLabel: 'Questions per quiz',
    value: savedCount,
    options: countOptions
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((v) => ({ value: v, label: v === 'all' ? 'All' : String(v) })),
    onChange: (v) => void save('defaultCount', v),
  });

  // Exam seconds per question: a stepper.
  const secs = () => clamp(Number(getSetting('examSecondsPerQuestion')) || 90, EXAM_SECONDS_MIN, EXAM_SECONDS_MAX);
  const secsText = (/** @type {number} */ s) => (s % 60 === 0 ? `${s / 60} min` : s > 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`);
  const out = h('output', { class: 'set-step-value tabular', 'aria-live': 'polite' }, secsText(secs()));
  const less = iconButton({ icon: 'minus', label: 'Less time per question', onClick: () => stepSecs(-EXAM_SECONDS_STEP) });
  const more = iconButton({ icon: 'plus', label: 'More time per question', onClick: () => stepSecs(EXAM_SECONDS_STEP) });
  const showSecs = () => {
    const s = secs();
    out.textContent = secsText(s);
    less.disabled = s <= EXAM_SECONDS_MIN;
    more.disabled = s >= EXAM_SECONDS_MAX;
  };
  /** @param {number} d */
  const stepSecs = (d) => {
    const next = clamp(Math.round((secs() + d) / EXAM_SECONDS_STEP) * EXAM_SECONDS_STEP, EXAM_SECONDS_MIN, EXAM_SECONDS_MAX);
    void save('examSecondsPerQuestion', next).then(showSecs);
    out.textContent = secsText(next);
    less.disabled = next <= EXAM_SECONDS_MIN;
    more.disabled = next >= EXAM_SECONDS_MAX;
  };
  showSecs();
  const stepper = h('div', { class: 'set-stepper', role: 'group', 'aria-labelledby': 'set-secs-l' }, less, out, more);

  const draw = segmented({
    ariaLabel: 'Draw with',
    value: getSetting('drawInput'),
    options: [
      { value: 'auto', label: 'Automatic' },
      { value: 'finger', label: 'Finger' },
      { value: 'pen', label: 'Pen only' },
    ],
    onChange: (v) => void save('drawInput', v),
  });

  return section(
    'study',
    'Study',
    settingToggle('shuffleChoices', 'Shuffle answer choices', 'Show the choices in a new order each time.'),
    row({ label: 'Questions per quiz', hint: 'Used by the quick Practice and Exam buttons.', control: count, stacked: true }),
    row({ label: 'Exam time per question', hint: 'Sets the exam clock.', control: stepper, labelId: 'set-secs-l' }),
    settingToggle('showTimer', 'Show the timer', 'See the time left during an exam.'),
    settingToggle('autoAdvance', 'Go to the next question automatically', 'Move on right after you answer.'),
    row({
      label: 'Draw with',
      hint: 'Automatic: finger or pen. Once a pen is used, fingers scroll instead of drawing.',
      control: draw,
      stacked: true,
    }),
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * @param {() => boolean} isAlive
 * @returns {HTMLElement}
 */
function dataSection(isAlive) {
  /** @returns {Promise<typeof import('../features/backup.js')>} */
  const backupModule = () => import('../features/backup.js');

  /**
   * @param {boolean} includeMedia
   * @param {HTMLButtonElement} btn
   */
  /** Book PDFs are large and the user still has the originals, so they are left out unless asked for. */
  let includeBooks = false;
  const booksToggle = toggle({
    checked: false,
    label: 'Include book PDFs',
    description: 'Adds the chapter PDFs you imported in Book. The backup file gets much larger.',
    onChange: (on) => { includeBooks = Boolean(on); },
  });

  const doExport = (includeMedia, btn) =>
    busy(btn, async () => {
      try {
        const bk = await backupModule();
        const res = await bk.exportBackup({ includeMedia, includeBooks });
        const how = await bk.saveFile(res.blob, res.filename);
        if (how === 'cancelled') return;
        const skipped = Number(/** @type {any} */ (res).skipped) || 0;
        const extra = skipped ? ` ${plural(skipped, 'voice note')} couldn't be read and ${skipped === 1 ? 'was' : 'were'} left out.` : '';
        toast(
          how === 'downloaded'
            ? `Backup saved as ${res.filename}. Keep it somewhere safe, like Files or a cloud drive.${extra}`
            : `Backup ready.${extra}`,
          { kind: skipped ? 'info' : 'success', duration: 6000 },
        );
      } catch (err) {
        console.error('[settings] Export failed:', err);
        toast(/** @type {any} */ (err)?.userMessage || "Couldn't make the backup. Please try again.", { kind: 'danger' });
      }
    });

  const exportAll = button({ label: 'Export backup', icon: 'download', variant: 'primary', onClick: () => void doExport(true, exportAll) });
  const exportLight = button({ label: 'Without voice notes or images', icon: 'download', variant: 'secondary', onClick: () => void doExport(false, exportLight) });

  const fileInput = /** @type {HTMLInputElement} */ (
    h('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' })
  );
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // the same file can be picked again
    if (!file) return;
    try {
      const bk = await backupModule();
      const result = await bk.openImportDialog(file);
      if (result) void refreshStorage();
    } catch (err) {
      console.error('[settings] Import failed:', err);
      toast(/** @type {any} */ (err)?.userMessage || "Couldn't open the backup. Please try again.", { kind: 'danger' });
    }
  });
  const importBtn = button({ label: 'Import backup', icon: 'upload', variant: 'secondary', onClick: () => fileInput.click() });

  // Storage info
  const storageBox = h('div', { class: 'set-storage', 'aria-live': 'polite' }, spinner({ label: 'Checking storage…' }));

  const refreshStorage = async () => {
    let bk;
    let info;
    try {
      bk = await backupModule();
      info = await bk.storageInfo();
    } catch (err) {
      console.warn('[settings] Storage info unavailable:', err);
      if (isAlive()) {
        clear(storageBox);
        storageBox.append(h('p', { class: 'set-hint' }, "This browser doesn't report storage use. Your data is still saved on this device."));
      }
      return;
    }
    if (!isAlive()) return;
    clear(storageBox);
    const { usage, quota, persisted } = info;
    const used = bk.formatBytes(usage);
    const share = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
    storageBox.append(
      h(
        'div',
        { class: 'set-storage-line' },
        h('span', { class: 'set-label' }, 'Storage used'),
        h('span', { class: 'set-value tabular' }, quota > 0 ? `${used} of ${bk.formatBytes(quota)}` : used),
      ),
      quota > 0 ? progressBar(Math.max(share, usage > 0 ? 1 : 0), { label: 'Storage used' }) : null,
    );
    if (persisted) {
      storageBox.append(
        h(
          'div',
          { class: 'set-persist' },
          chip('Protected', { kind: 'success', icon: 'check' }),
          h('span', { class: 'set-hint' }, 'Your browser will keep your progress even when the device is low on space.'),
        ),
      );
    } else {
      const protect = button({
        label: 'Protect my data',
        icon: 'check',
        variant: 'secondary',
        size: 's',
        onClick: () =>
          void busy(protect, async () => {
            const ok = await bk.requestPersistence().catch(() => false);
            if (ok) toast('Done. Your progress is protected on this device.', { kind: 'success' });
            else
              toast('Your browser said no for now. Adding the app to your home screen and using it often usually helps. Exporting a backup keeps you safe meanwhile.', {
                duration: 8000,
              });
            await refreshStorage();
          }),
      });
      storageBox.append(
        h(
          'div',
          { class: 'set-persist' },
          chip('Not protected yet', { kind: 'warning', icon: 'alert' }),
          h('span', { class: 'set-hint' }, 'If the device runs very low on space, the browser could clear app data. Export a backup now and then.'),
          protect,
        ),
      );
    }
  };
  void refreshStorage();

  return section(
    'data',
    'Your data',
    h(
      'div',
      { class: 'set-row is-stacked' },
      h(
        'div',
        { class: 'set-row-text' },
        h('span', { class: 'set-label' }, 'Backup'),
        h(
          'span',
          { class: 'set-hint' },
          'Everything stays on this device. A backup file moves your progress, notes, highlights, drawings and voice notes to another device.',
        ),
      ),
      booksToggle,
      h('div', { class: 'set-actions' }, exportAll, exportLight, importBtn, fileInput),
    ),
    h('div', { class: 'set-row is-stacked' }, storageBox),
  );
}

// ---------------------------------------------------------------------------
// Reviewer, Help, About
// ---------------------------------------------------------------------------

/** @returns {HTMLElement} */
function reviewerSection() {
  const link = h('div', { class: 'list set-inner-list' }, listItem({ title: 'Open reviewer dashboard', icon: 'check', href: '#/reviewer' }));
  link.hidden = getSetting('reviewerMode') !== true;
  return section(
    'reviewer',
    'Reviewer mode',
    h(
      'div',
      { class: 'set-row is-toggle' },
      toggle({
        checked: getSetting('reviewerMode') === true,
        label: 'Reviewer mode',
        description: 'For specialists checking questions: adds Approve / Needs fix to every question.',
        onChange: (on) => {
          link.hidden = !on;
          void save('reviewerMode', on);
        },
      }),
    ),
    link,
  );
}

/**
 * @param {() => boolean} isAlive
 * @returns {HTMLElement}
 */
function helpSection(isAlive) {
  const tourItem = listItem({
    title: 'Show the tour',
    subtitle: 'A 4-step look at the main features.',
    icon: 'info',
    onClick: async () => {
      try {
        const tour = await import('../ui/tour.js');
        await tour.showTour();
      } catch (err) {
        console.error('[settings] Tour failed:', err);
        toast("The tour couldn't open. Please reload the app.", { kind: 'danger' });
      }
    },
  });
  const demoItem = listItem({
    title: 'Try the demo',
    subtitle: '10 practice questions about using the app.',
    icon: 'play',
    onClick: () => void startAndOpen({ chapters: ['demo'], mode: 'tutor', count: 'all' }),
  });
  demoItem.hidden = true; // shown once the index confirms the demo exists
  const list = h('div', { class: 'list' }, tourItem, demoItem);

  (async () => {
    try {
      const data = await import('../core/data.js');
      const index = await data.loadIndex();
      if (isAlive() && index && index.demo) demoItem.hidden = false;
    } catch (err) {
      console.warn('[settings] Could not check demo mode:', err);
    }
  })();

  return h(
    'section',
    { class: 'misc-section', id: 'set-help', 'aria-labelledby': 'set-help-h' },
    sectionHeading('help', 'Help'),
    list,
  );
}

/**
 * @param {() => boolean} isAlive
 * @returns {HTMLElement}
 */
function aboutSection(isAlive) {
  const result = h('p', { class: 'set-update-result', role: 'status', 'aria-live': 'polite' });
  const check = button({
    label: 'Check for update',
    icon: 'refresh',
    variant: 'secondary',
    onClick: () =>
      void busy(check, async () => {
        result.textContent = 'Checking…';
        result.dataset.kind = '';
        let status = 'error';
        try {
          const sw = await import('../core/sw-client.js');
          status = await sw.checkForUpdate();
        } catch (err) {
          console.warn('[settings] Update check failed:', err);
        }
        if (!isAlive()) return;
        result.textContent = /** @type {Record<string, string>} */ (UPDATE_MESSAGES)[status] || UPDATE_MESSAGES.error;
        result.dataset.kind = status === 'up-to-date' ? 'success' : status === 'update-ready' || status === 'downloading' ? 'info' : 'warning';
      }),
  });
  return section(
    'about',
    'About',
    h(
      'div',
      { class: 'set-row' },
      h('div', { class: 'set-row-text' }, h('span', { class: 'set-label' }, 'Version'), h('span', { class: 'set-hint tabular' }, APP_VERSION)),
      h('div', { class: 'set-row-control' }, check),
    ),
    h('div', { class: 'set-row is-stacked set-update-row' }, result),
    h(
      'div',
      { class: 'set-row set-offline' },
      h('span', { class: 'set-offline-icon', 'aria-hidden': 'true' }, icon('check', { size: 18 })),
      h(
        'p',
        { class: 'set-hint' },
        h('strong', {}, 'Works offline. '),
        'After the first load everything works without internet. Your progress stays on this device and survives every update.',
      ),
    ),
  );
}

export default {
  /**
   * @returns {{ el: HTMLElement, destroy: () => void }}
   */
  render() {
    setHeader({ title: 'Settings' });
    let alive = true;
    const isAlive = () => alive;
    /** @type {Set<() => void>} */
    const offs = new Set();

    const readBody = h('div', { class: 'set-loading' }, spinner({ label: 'Loading voices…' }));
    const readSection = section('read', 'Read aloud', readBody);
    void fillReadAloud(readSection, readBody, isAlive);

    const page = h(
      'div',
      { class: 'misc-page screen-settings' },
      h('h1', { class: 'visually-hidden', tabindex: '-1' }, 'Settings'),
      appearanceSection(offs),
      readSection,
      studySection(),
      dataSection(isAlive),
      reviewerSection(),
      helpSection(isAlive),
      aboutSection(isAlive),
      h('p', { class: 'set-footer' }, 'Changes save automatically.'),
    );

    return {
      el: page,
      destroy() {
        alive = false;
        for (const off of offs) off();
        offs.clear();
      },
    };
  },
};
