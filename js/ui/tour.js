/**
 * First-run tour (docs/ARCHITECTURE.md §6.5).
 *
 * Four short, skippable slides in a sheet: practice & exam, highlight & draw,
 * notes & voice, offline & backup. Swipe, arrow keys, dots, Back/Next and the
 * close button all work; closing it any way marks the tour as done.
 * Styles: the "First-run tour" section of css/components.css.
 *
 * Importing this module has no side effects.
 *
 * @module ui/tour
 */

import { h, svg } from '../core/dom.js';
import { getSetting, setSetting } from '../core/settings.js';
import { button, sheet } from './components.js';
import { icon } from './icons.js';

/**
 * @typedef {object} Slide
 * @property {string} title
 * @property {string} text
 * @property {() => HTMLElement} art Decorative illustration (hidden from screen readers).
 */

/** @type {readonly Slide[]} */
const SLIDES = Object.freeze([
  {
    title: 'Practice & exam',
    text: 'Practice shows the answer and explanation right away. Exam is timed, with your score at the end.',
    art: artPractice,
  },
  {
    title: 'Highlight & draw',
    text: 'Select any text to highlight it. Turn on Draw to write with your finger or a stylus.',
    art: artHighlight,
  },
  {
    title: 'Notes & voice',
    text: 'Add a typed or voice note to any question. Find them all in Library.',
    art: artNotes,
  },
  {
    title: 'Offline & backup',
    text: 'Everything works offline and stays on this device. Export a backup anytime in Settings.',
    art: artOffline,
  },
]);

/** Swipe distance (fraction of width) or speed (px/ms) that changes slide. */
const SWIPE_FRACTION = 0.18;
const SWIPE_VELOCITY = 0.45;

/** @type {Promise<void> | null} */
let running = null;

/* ------------------------------------------------------------------ */
/* Illustrations                                                       */
/* ------------------------------------------------------------------ */

/** @returns {HTMLElement} */
function line(width = 100) {
  const el = h('span', { class: 'mock-line' });
  el.style.width = `${width}%`;
  return el;
}

/** @returns {HTMLElement} */
function artPractice() {
  const choice = (letter, state, width) =>
    h(
      'div',
      { class: ['mock-choice', state && `is-${state}`] },
      h('span', {}, letter),
      line(width),
      state === 'correct' ? icon('check', { size: 14 }) : state === 'wrong' ? icon('x', { size: 14 }) : null,
    );
  return h(
    'div',
    { class: 'tour-art' },
    h(
      'div',
      { class: 'mock-card' },
      line(92),
      line(70),
      choice('A', null, 70),
      choice('B', 'wrong', 82),
      choice('C', 'correct', 64),
    ),
    floatAt(h('span', { class: 'mock-float' }, icon('timer', { size: 14 }), '1:30'), { top: '18px', right: '22px' }),
  );
}

/** @returns {HTMLElement} */
function artHighlight() {
  const ink = svg(
    'svg',
    { class: 'mock-ink', viewBox: '0 0 220 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    // A hand-drawn loop around a phrase and a wavy underline.
    svg('path', {
      d: 'M146 46c20-6 52-4 54 4s-32 12-54 9-18-11 6-14',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 3,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
    svg('path', {
      d: 'M16 93c10-5 20-5 30 0s20 5 30 0 20-5 30 0',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 3,
      'stroke-linecap': 'round',
    }),
  );
  return h(
    'div',
    { class: 'tour-art' },
    h(
      'div',
      { class: 'mock-card' },
      line(96),
      h('span', { class: 'mock-hl' }, line(100)),
      line(84),
      line(90),
      line(58),
      ink,
    ),
    floatAt(h('span', { class: 'mock-float' }, icon('highlighter', { size: 14 }), icon('pen', { size: 14 })), {
      top: '16px',
      right: '22px',
    }),
  );
}

/** @returns {HTMLElement} */
function artNotes() {
  const heights = [8, 14, 20, 12, 18, 24, 10, 16, 22, 12, 8, 14, 18, 10];
  const wave = h('span', { class: 'mock-wave' });
  for (const px of heights) {
    const bar = h('span', {});
    bar.style.height = `${px}px`;
    wave.append(bar);
  }
  return h(
    'div',
    { class: 'tour-art' },
    h(
      'div',
      { class: 'mock-card' },
      h('div', { class: 'row', style: { '--gap': '6px', color: 'var(--text-2)' } }, icon('note', { size: 14 }), line(40)),
      line(94),
      line(76),
      h('div', { class: 'mock-voice' }, h('span', { class: 'mock-mic' }, icon('mic', { size: 16 })), wave),
    ),
  );
}

/** @returns {HTMLElement} */
function artOffline() {
  const row = (iconName, label) =>
    h(
      'div',
      { class: 'mock-row' },
      h('span', { class: 'mock-badge' }, icon(iconName, { size: 16 })),
      label,
      h('span', { class: 'mock-ok' }, icon('check', { size: 16 })),
    );
  return h(
    'div',
    { class: 'tour-art' },
    h(
      'div',
      { class: 'mock-card' },
      row('wifi-off', 'Works offline'),
      row('heart', 'Saved on this device'),
      row('download', 'Backup file'),
    ),
  );
}

/**
 * Hides an illustration from assistive technology.
 * @param {HTMLElement} el
 * @returns {HTMLElement}
 */
function decorative(el) {
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/**
 * Absolutely positions a decorative element.
 * @param {HTMLElement} el
 * @param {Record<string, string>} pos
 * @returns {HTMLElement}
 */
function floatAt(el, pos) {
  Object.assign(el.style, pos);
  return el;
}

/* ------------------------------------------------------------------ */
/* Tour                                                                */
/* ------------------------------------------------------------------ */

/** Saves `tourDone` (never throws; the tour is not worth an error message). */
function markDone() {
  try {
    Promise.resolve(setSetting('tourDone', true)).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[tour] Could not save tourDone', err);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[tour] Could not save tourDone', err);
  }
}

/**
 * Shows the tour on first run only (setting `tourDone`).
 * @returns {Promise<boolean>} `true` (after the tour closes) when it was shown,
 *   `false` when it had been seen before.
 */
export async function maybeShowTour() {
  let done = false;
  try {
    done = Boolean(getSetting('tourDone'));
  } catch {
    done = false;
  }
  if (done) return false;
  await showTour();
  return true;
}

/**
 * Opens the tour (also from Settings → Help). If it is already open, returns
 * the same promise.
 * @returns {Promise<void>} Resolves when the tour is closed.
 */
export function showTour() {
  if (running) return running;
  /** @type {Promise<void>} */
  const promise = new Promise((resolve) => {
    let index = 0;
    const count = SLIDES.length;

    const track = h('div', { class: 'tour-track' });
    const slides = SLIDES.map((s, i) =>
      h(
        'section',
        {
          class: 'tour-slide',
          'aria-roledescription': 'slide',
          'aria-label': `${i + 1} of ${count}`,
        },
        decorative(s.art()),
        h('h3', { class: 'tour-title' }, s.title),
        h('p', { class: 'tour-text' }, s.text),
      ),
    );
    track.append(...slides);
    const viewport = h('div', { class: 'tour-viewport' }, track);

    const dots = SLIDES.map((s, i) => {
      const dot = h('button', { type: 'button', class: 'tour-dot', 'aria-label': `Step ${i + 1}: ${s.title}` });
      dot.addEventListener('click', () => go(i));
      return dot;
    });
    const dotRow = h('div', { class: 'tour-dots' }, ...dots);
    const live = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });

    const root = h(
      'div',
      { class: 'tour', 'aria-roledescription': 'carousel', 'aria-label': 'Quick tour' },
      viewport,
      dotRow,
      live,
    );

    const backBtn = button({ label: 'Skip', variant: 'ghost', onClick: () => (index === 0 ? finish() : go(index - 1)) });
    backBtn.classList.add('tour-back');
    const nextBtn = button({ label: 'Next', variant: 'primary', onClick: () => (index === count - 1 ? finish() : go(index + 1)) });

    const ref = sheet({
      title: 'Quick tour',
      content: root,
      actions: [backBtn, nextBtn],
      size: 'm',
      onClose: () => {
        markDone();
        if (running === promise) running = null;
        resolve();
      },
    });
    const closeBtn = ref.el.querySelector('.sheet-close');
    if (closeBtn) {
      closeBtn.setAttribute('aria-label', 'Skip tour');
      closeBtn.setAttribute('title', 'Skip tour');
    }

    function finish() {
      ref.close('done');
    }

    /**
     * Shows slide `i`.
     * @param {number} i
     * @param {boolean} [announce=true]
     */
    function go(i, announce = true) {
      index = Math.max(0, Math.min(count - 1, i));
      track.style.setProperty('--tour-index', String(index));
      track.style.setProperty('--tour-drag', '0px');
      slides.forEach((slide, n) => {
        const on = n === index;
        slide.inert = !on;
        slide.setAttribute('aria-hidden', String(!on));
      });
      dots.forEach((dot, n) => {
        if (n === index) dot.setAttribute('aria-current', 'step');
        else dot.removeAttribute('aria-current');
      });
      setLabel(backBtn, index === 0 ? 'Skip' : 'Back');
      setLabel(nextBtn, index === count - 1 ? 'Start studying' : 'Next');
      if (announce) live.textContent = `Step ${index + 1} of ${count}: ${SLIDES[index].title}`;
    }

    // Arrow keys move between slides from anywhere in the sheet.
    ref.el.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (/** @type {Element} */ (e.target).closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        go(index + 1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        go(index - 1);
      }
    });

    enableSwipe(viewport, track, {
      canGo: (dir) => index + dir >= 0 && index + dir < count,
      onSwipe: (dir) => go(index + dir),
    });

    go(0, false);
  });
  running = promise;
  // If building the tour failed, allow another try later.
  promise.catch(() => {
    if (running === promise) running = null;
  });
  return promise;
}

/**
 * Replaces a button's visible label.
 * @param {HTMLButtonElement} btn
 * @param {string} text
 */
function setLabel(btn, text) {
  const label = btn.querySelector('.btn-label');
  if (label) label.textContent = text;
  else btn.textContent = text;
}

/**
 * Horizontal swipe between slides (vertical scrolling stays native).
 * @param {HTMLElement} viewport
 * @param {HTMLElement} track
 * @param {{ canGo: (dir: number) => boolean, onSwipe: (dir: number) => void }} handlers
 */
function enableSwipe(viewport, track, { canGo, onSwipe }) {
  /** @type {{ id: number, x0: number, y0: number, x: number, t: number, v: number, active: boolean } | null} */
  let drag = null;

  viewport.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, t: performance.now(), v: 0, active: false };
  });

  viewport.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.active) {
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        drag.active = true;
        try {
          viewport.setPointerCapture(e.pointerId);
        } catch {
          /* the swipe still works without capture */
        }
        track.classList.add('is-dragging');
      } else if (Math.abs(dy) > 10) {
        drag = null;
        return;
      } else return;
    }
    const now = performance.now();
    drag.v = 0.8 * ((e.clientX - drag.x) / Math.max(1, now - drag.t)) + 0.2 * drag.v;
    drag.x = e.clientX;
    drag.t = now;
    // Resist at the first and last slide.
    const dir = dx < 0 ? 1 : -1;
    const offset = canGo(dir) ? dx : dx * 0.25;
    track.style.setProperty('--tour-drag', `${offset}px`);
  });

  /** @param {PointerEvent} e */
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { active, x0, v } = drag;
    drag = null;
    if (!active) return;
    track.classList.remove('is-dragging');
    const dx = e.clientX - x0;
    const width = viewport.clientWidth || 1;
    const dir = dx < 0 ? 1 : -1;
    const passed = Math.abs(dx) / width > SWIPE_FRACTION || Math.abs(v) > SWIPE_VELOCITY;
    if (e.type !== 'pointercancel' && passed && canGo(dir)) onSwipe(dir);
    else track.style.setProperty('--tour-drag', '0px');
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
  // A drag should never turn into a click on something inside.
  viewport.addEventListener(
    'click',
    (e) => {
      if (track.classList.contains('is-dragging')) e.stopPropagation();
    },
    true,
  );
}
