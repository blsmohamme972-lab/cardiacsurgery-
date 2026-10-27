/**
 * Quiz builder screen (`#/new`, docs/ARCHITECTURE.md §8).
 *
 * Chapters (multi-select chips with "All", grouped by part when there are
 * many), filter (segmented, `FILTER_LABELS`), count (10 / 20 / 40 / All /
 * custom), mode (Practice: explanation after each answer / Exam: timed,
 * results at the end), random order and shuffled choices; a live
 * "N questions available" line (debounced `countAvailable`) and a Start
 * button that is disabled with the reason when nothing matches.
 *
 * The query may preset `chapters` (comma list or `all`), `filter`, `mode`
 * (`tutor`|`practice`|`exam`) and `count`. Without a preset, the last choices
 * of this browser session are restored (sessionStorage, best effort).
 *
 * Styles: css/screen-home.css.
 *
 * @module screens/builder
 */

import { h } from '../core/dom.js';
import { debounce, formatNumber, plural } from '../core/util.js';
import { getSetting } from '../core/settings.js';
import { loadIndex, studyChapters } from '../core/data.js';
import { FILTERS, FILTER_LABELS, countAvailable, isFilter } from '../features/quiz/builder.js';
import { MAX_COUNT, noQuestionsMessage, startAndOpen } from '../features/quiz/start.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, segmented, toggle } from '../ui/components.js';
import { setHeader } from '../ui/shell.js';
import { navigate } from '../core/router.js';

const STORAGE_KEY = 'cmcq.builder.v1';
const COUNT_DEBOUNCE_MS = 180;
const PRESET_COUNTS = [10, 20, 40];
/** Group chapter chips by part above this many chapters. */
const GROUP_THRESHOLD = 8;

/** One-line hint per filter (what it selects). */
const FILTER_HINTS = Object.freeze({
  all: 'Every question in the chosen chapters.',
  new: "Questions you haven't answered yet.",
  incorrect: 'Questions you got wrong last time.',
  bookmarked: 'Questions you bookmarked.',
  due: 'Answered questions that are due for review today.',
  unreviewed: 'Questions not yet checked by a specialist.',
  flagged: 'Questions you reported a problem with.',
  notes: 'Questions you wrote a note on.',
});

/**
 * @typedef {object} BuilderState
 * @property {'all' | string[]} chapters
 * @property {string} filter
 * @property {number | 'all' | 'custom'} count
 * @property {number} custom
 * @property {'tutor' | 'exam'} mode
 * @property {boolean} randomOrder
 * @property {boolean} shuffleChoices
 */

/** @returns {Partial<BuilderState>} */
function loadSaved() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** @param {BuilderState} s */
function save(s) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* Private mode or full storage: the choices just aren't remembered. */
  }
}

/**
 * Initial state from the query (wins), the saved choices, then defaults.
 * @param {Record<string, string>} query
 * @param {Set<string>} valid Valid chapter ids.
 * @returns {BuilderState}
 */
function initialState(query, valid) {
  const hasPreset = ['chapters', 'filter', 'mode', 'count'].some((k) => typeof query[k] === 'string' && query[k] !== '');
  const saved = hasPreset ? {} : loadSaved();
  const def = Number(getSetting('defaultCount')) || 20;

  /** @type {'all' | string[]} */
  let chapters = 'all';
  const rawCh = typeof query.chapters === 'string' ? query.chapters : Array.isArray(saved.chapters) ? saved.chapters.join(',') : 'all';
  if (rawCh && rawCh !== 'all') {
    const list = [...new Set(rawCh.split(',').map((x) => x.trim()).filter((x) => valid.has(x)))];
    if (list.length && list.length < valid.size) chapters = list;
  }

  const picked = isFilter(query.filter) ? query.filter : isFilter(saved.filter) ? saved.filter : 'all';
  // 'unreviewed' is a reviewer-only filter; learners never see it.
  const filter = picked === 'unreviewed' && getSetting('reviewerMode') !== true ? 'all' : picked;
  const rawMode = query.mode ?? saved.mode;
  const mode = rawMode === 'exam' ? 'exam' : 'tutor';

  /** @type {number | 'all' | 'custom'} */
  let count = PRESET_COUNTS.includes(def) ? def : 'custom';
  let custom = def;
  const rawCount = query.count ?? saved.count;
  if (rawCount === 'all') count = 'all';
  else if (rawCount === 'custom' && Number(saved.custom) >= 1) {
    count = 'custom';
    custom = Math.min(MAX_COUNT, Math.floor(Number(saved.custom)));
  } else if (rawCount !== undefined && Number(rawCount) >= 1) {
    const n = Math.min(MAX_COUNT, Math.floor(Number(rawCount)));
    if (PRESET_COUNTS.includes(n)) count = n;
    else {
      count = 'custom';
      custom = n;
    }
  }
  return {
    chapters,
    filter,
    count,
    custom,
    mode,
    randomOrder: typeof saved.randomOrder === 'boolean' ? saved.randomOrder : true,
    shuffleChoices: typeof saved.shuffleChoices === 'boolean' ? saved.shuffleChoices : getSetting('shuffleChoices') !== false,
  };
}

/**
 * A titled form section.
 * @param {string} id
 * @param {string} title
 * @param {Node[]} children
 * @param {string} [hint]
 * @returns {HTMLElement}
 */
function field(id, title, children, hint) {
  return h(
    'section',
    { class: 'nb-field', role: 'group', 'aria-labelledby': id },
    h('h2', { class: 'nb-label', id }, title),
    ...children,
    hint ? h('p', { class: 'nb-hint' }, hint) : null,
  );
}

export default {
  /**
   * @param {{ query: Record<string, string> }} ctx
   * @returns {Promise<HTMLElement | { el: HTMLElement, destroy: () => void }>}
   */
  async render({ query = {} }) {
    setHeader({ title: 'Custom quiz', back: true });
    const page = h('div', { class: 'screen-builder' }, h('h1', { class: 'visually-hidden', tabindex: '-1' }, 'Build a custom quiz'));

    let chapters;
    let index;
    try {
      [chapters, index] = await Promise.all([studyChapters(), loadIndex()]);
    } catch (err) {
      console.error('[builder] Could not load the chapters:', err);
      page.append(
        emptyState({
          icon: 'alert',
          title: "The chapters couldn't load",
          text: /** @type {any} */ (err)?.userMessage || 'Please try again. Your progress is safe on this device.',
          action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => navigate('/new', { replace: true }) }),
        }),
      );
      return page;
    }
    if (chapters.length === 0) {
      page.append(emptyState({ icon: 'layers', title: 'No chapters yet', text: 'Chapters appear here as soon as they are published.' }));
      return page;
    }

    const valid = new Set(chapters.map((c) => c.id));
    const state = initialState(query, valid);
    let alive = true;
    let available = /** @type {number | null} */ (null);
    let countSeq = 0;

    // ---------------- Chapters ----------------
    const allChip = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'nb-chip nb-chip-all' }, icon('check', { size: 16 }), h('span', {}, 'All chapters')));
    allChip.addEventListener('click', () => {
      state.chapters = 'all';
      onChange();
    });
    /** @type {Map<string, HTMLButtonElement>} */
    const chipById = new Map();
    for (const c of chapters) {
      const label = c.demo ? c.short || 'Demo' : `${c.number}. ${c.short || c.title}`;
      const b = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'nb-chip', title: c.title }, icon('check', { size: 16 }), h('span', {}, label)));
      b.addEventListener('click', () => {
        const cur = state.chapters === 'all' ? [] : state.chapters.slice();
        const i = cur.indexOf(c.id);
        if (i === -1) cur.push(c.id);
        else cur.splice(i, 1);
        state.chapters = cur.length === 0 || cur.length === valid.size ? 'all' : cur;
        onChange();
      });
      chipById.set(c.id, b);
    }
    const chipsWrap = h('div', { class: 'nb-chips' }, allChip);
    if (chapters.length > GROUP_THRESHOLD && !index.demoMode) {
      const byPart = new Map(index.parts.map((p) => [p.id, p]));
      /** @type {Map<string, HTMLButtonElement[]>} */
      const groups = new Map();
      for (const c of chapters) {
        const key = c.part ?? '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)?.push(/** @type {HTMLButtonElement} */ (chipById.get(c.id)));
      }
      for (const [pid, chips] of groups) {
        const p = byPart.get(pid);
        chipsWrap.append(
          h('div', { class: 'nb-chip-group' }, h('div', { class: 'nb-chip-part' }, p ? `Part ${p.number} · ${p.title}` : 'Other'), h('div', { class: 'nb-chips' }, chips)),
        );
      }
    } else {
      chipsWrap.append(...chipById.values());
    }

    // ---------------- Filter ----------------
    const filterHint = h('p', { class: 'nb-hint' });
    const filterSeg = segmented({
      ariaLabel: 'Which questions',
      value: state.filter,
      options: FILTERS.filter((f) => f !== 'unreviewed' || getSetting('reviewerMode') === true)
        .map((f) => ({ value: f, label: /** @type {Record<string, string>} */ (FILTER_LABELS)[f] })),
      onChange: (v) => {
        state.filter = v;
        onChange();
      },
    });

    // ---------------- Count ----------------
    const customInput = /** @type {HTMLInputElement} */ (
      h('input', {
        type: 'number',
        class: 'nb-custom-input',
        inputmode: 'numeric',
        min: '1',
        max: String(MAX_COUNT),
        step: '1',
        'aria-label': 'Number of questions',
        value: String(state.custom),
      })
    );
    customInput.addEventListener('input', () => {
      const n = Math.floor(Number(customInput.value));
      state.custom = Number.isFinite(n) ? n : 0;
      onChange(false);
    });
    const customRow = h('label', { class: 'nb-custom' }, h('span', {}, 'Number of questions'), customInput);
    const countSeg = segmented({
      ariaLabel: 'Number of questions',
      value: state.count,
      options: [...PRESET_COUNTS.map((n) => ({ value: n, label: String(n) })), { value: 'all', label: 'All' }, { value: 'custom', label: 'Custom' }],
      onChange: (v) => {
        state.count = v;
        onChange(false);
        if (v === 'custom') requestAnimationFrame(() => customInput.focus());
      },
    });

    // ---------------- Mode ----------------
    const modeName = `nb-mode-${Math.random().toString(36).slice(2, 8)}`;
    /**
     * @param {'tutor' | 'exam'} value
     * @param {string} title
     * @param {string} desc
     * @param {string} iconName
     */
    const modeCard = (value, title, desc, iconName) => {
      const input = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: modeName, value, class: 'nb-mode-input' }));
      input.checked = state.mode === value;
      input.addEventListener('change', () => {
        if (input.checked) {
          state.mode = value;
          onChange(false);
        }
      });
      return h(
        'label',
        { class: ['nb-mode', `nb-mode-${value}`] },
        input,
        h('span', { class: 'nb-mode-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 22 })),
        h('span', { class: 'nb-mode-text' }, h('span', { class: 'nb-mode-title' }, title), h('span', { class: 'nb-mode-desc' }, desc)),
        h('span', { class: 'nb-mode-check', 'aria-hidden': 'true' }, icon('check', { size: 16 })),
      );
    };
    const modes = h(
      'div',
      { class: 'nb-modes', role: 'radiogroup', 'aria-labelledby': 'nb-mode-h' },
      modeCard('tutor', 'Practice', 'See the explanation after each answer.', 'target'),
      modeCard('exam', 'Exam', 'Timed. Results and explanations at the end.', 'timer'),
    );

    // ---------------- Options ----------------
    const options = h(
      'div',
      { class: 'nb-toggles' },
      toggle({
        label: 'Random question order',
        description: 'Off: questions come in chapter order.',
        checked: state.randomOrder,
        onChange: (v) => {
          state.randomOrder = v;
          onChange(false);
        },
      }),
      toggle({
        label: 'Shuffle answer choices',
        description: 'Mixes the order of A–E in every question.',
        checked: state.shuffleChoices,
        onChange: (v) => {
          state.shuffleChoices = v;
          onChange(false);
        },
      }),
    );

    // ---------------- Start bar ----------------
    const availLine = h('p', { class: 'nb-available', 'aria-live': 'polite' }, 'Counting questions…');
    const reasonLine = h('p', { class: 'nb-reason', hidden: true });
    const startBtn = button({ label: 'Start', icon: 'play', variant: 'primary', size: 'l', block: true });
    startBtn.classList.add('nb-start');
    startBtn.addEventListener('click', () => {
      const n = wantedCount();
      if (n === null) return;
      void startAndOpen(
        {
          chapters: state.chapters,
          filter: state.filter,
          count: n,
          mode: state.mode,
          order: state.randomOrder ? 'random' : 'sequential',
          shuffleChoices: state.shuffleChoices,
        },
        { trigger: startBtn },
      );
    });
    const startBar = h('div', { class: 'nb-startbar' }, h('div', { class: 'nb-startbar-inner' }, h('div', { class: 'nb-start-text' }, availLine, reasonLine), startBtn));

    /** @returns {number | 'all' | null} The count to request, or null when the custom value is invalid. */
    function wantedCount() {
      if (state.count === 'custom') {
        const n = state.custom;
        return Number.isFinite(n) && n >= 1 && n <= MAX_COUNT ? n : null;
      }
      return state.count;
    }

    function paint() {
      const all = state.chapters === 'all';
      allChip.setAttribute('aria-pressed', String(all));
      for (const [id, b] of chipById) b.setAttribute('aria-pressed', String(!all && state.chapters.includes(id)));
      filterHint.textContent = /** @type {Record<string, string>} */ (FILTER_HINTS)[state.filter] ?? '';
      customRow.hidden = state.count !== 'custom';

      const n = wantedCount();
      let reason = '';
      if (available === null) {
        availLine.textContent = 'Counting questions…';
      } else {
        availLine.textContent = `${plural(available, 'question')} available`;
        if (available === 0) reason = noQuestionsMessage(state.filter);
        else if (n === null) reason = `Enter a number from 1 to ${formatNumber(MAX_COUNT)}.`;
      }
      reasonLine.textContent = reason;
      reasonLine.hidden = reason === '';
      const use = available === null || n === null ? null : n === 'all' ? available : Math.min(n, available);
      startBtn.disabled = available === null || available === 0 || n === null;
      const label = startBtn.querySelector('.btn-label');
      if (label) label.textContent = use ? `Start ${plural(use, 'question')}` : 'Start';
      if (use && state.mode === 'exam') {
        const secs = Number(getSetting('examSecondsPerQuestion')) || 90;
        availLine.textContent += ` · exam time ${Math.max(1, Math.round((use * secs) / 60))} min`;
      }
    }

    const recount = debounce(async () => {
      const mine = ++countSeq;
      try {
        const n = await countAvailable({ chapters: state.chapters, filter: /** @type {any} */ (state.filter) });
        if (!alive || mine !== countSeq) return;
        available = n;
      } catch (err) {
        if (!alive || mine !== countSeq) return;
        console.error('[builder] Could not count questions:', err);
        available = null;
        availLine.textContent = /** @type {any} */ (err)?.userMessage || "Couldn't count the questions. Check your connection once and try again.";
        startBtn.disabled = true;
        return;
      }
      paint();
    }, COUNT_DEBOUNCE_MS);

    /** @param {boolean} [needsRecount=true] */
    function onChange(needsRecount = true) {
      save(state);
      if (needsRecount) {
        available = null;
        recount();
      }
      paint();
    }

    const form = h(
      'div',
      { class: 'nb-grid' },
      h(
        'div',
        { class: 'nb-col' },
        field('nb-ch-h', 'Chapters', [chipsWrap]),
        field('nb-filter-h', 'Questions', [filterSeg, filterHint]),
      ),
      h(
        'div',
        { class: 'nb-col' },
        field('nb-count-h', 'How many', [countSeg, customRow]),
        h('section', { class: 'nb-field' }, h('h2', { class: 'nb-label', id: 'nb-mode-h' }, 'Mode'), modes),
        field('nb-opt-h', 'Options', [options]),
      ),
    );
    page.append(form, startBar);
    paint();
    recount();

    return {
      el: page,
      destroy() {
        alive = false;
        recount.cancel();
      },
    };
  },
};
