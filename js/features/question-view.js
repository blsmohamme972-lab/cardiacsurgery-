/**
 * Shared question rendering for the Player, the Question browse screen and the
 * Results review (docs/ARCHITECTURE.md §7.13).
 *
 * One view renders one question in every state:
 * - `tutor`  : tap a choice → instant feedback (correct green, chosen wrong red,
 *              correct answer shown) and the explanation slides in.
 * - `exam`   : tap selects (changeable), no feedback until the exam is finished.
 * - `browse` : the answered/revealed state (search, library, results review).
 *
 * The view owns the choices (letter badges assigned in display order, a
 * visible strike button plus long-press / swipe-left to strike), the feedback
 * line, the choice notes, the explanation (render.js), sources, a tools row
 * (Listen, Ask GPT, Report), the "Your notes" section (text note + voice
 * notes), the reviewer panel (reviewer mode), highlights and ink layers.
 *
 * Heavy tools (ink, ink toolbar, scratchpad, notes, voice, Ask GPT, Listen)
 * are loaded with dynamic `import()` the first time they are needed. A tool
 * that fails to load shows one plain-language toast and never breaks the view.
 * Saved highlights load right after the question renders; saved ink loads the
 * ink layers (disabled) so drawings are visible without a tap.
 *
 * Wide screens (≥ 1000px, css/screen-player.css): the question sits on the
 * left and the explanation on the right; both panes scroll on their own.
 *
 * Importing this module does not touch `document`.
 *
 * @module features/question-view
 */

import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { getSetting } from '../core/settings.js';
import { inkRepo, qstateRepo } from '../core/store/repo.js';
import { icon } from '../ui/icons.js';
import { button, iconButton, toast, sheet, listItem } from '../ui/components.js';
import { renderStem, renderBlocks, renderImage, renderInline } from './explain/render.js';
import { initHighlights } from './annotate/highlight.js';
import { openReportSheet, createReviewerPanel, unreviewedBadge } from './review.js';

/** Display letters, assigned in display order (never stored). */
export const LETTERS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);

/** Message for a tool module that could not be loaded. */
export const TOOL_LOAD_ERROR = "This tool couldn't load. Reload the app.";

/** Hold this long on a choice (touch/pen) to strike it through. */
const LONG_PRESS_MS = 520;
/** Horizontal distance (px) of a left swipe that strikes a choice. */
const SWIPE_PX = 56;
/** Movement (px) that cancels a long press. */
const MOVE_CANCEL_PX = 10;

/**
 * @typedef {'tutor' | 'exam' | 'browse'} ViewMode
 * @typedef {object} ViewState
 * @property {ViewMode} mode
 * @property {string[]} choiceOrder Choice ids in display order.
 * @property {string | null} selected Chosen choice id.
 * @property {string[]} struck Struck choice ids.
 * @property {boolean} revealed Show the answer and the explanation.
 * @typedef {object} ViewOptions
 * @property {ViewMode} [mode='tutor']
 * @property {string[]} [choiceOrder]
 * @property {string | null} [selected]
 * @property {string[]} [struck]
 * @property {boolean} [revealed]
 * @property {(choiceId: string) => void} [onChoose]
 * @property {(choiceId: string) => void} [onStrike]
 * @property {(on: boolean) => void} [onDrawingChange] Drawing turned on/off (also by the toolbar's Done).
 * @typedef {object} QuestionView
 * @property {HTMLElement} el
 * @property {(partial: Partial<ViewState>) => void} update
 * @property {(on: boolean) => Promise<boolean>} setDrawing Resolves with the new state (false when ink failed to load).
 * @property {() => boolean} isDrawing
 * @property {() => void} focusFirstChoice
 * @property {() => void} destroy
 * @property {() => ViewState} getState
 * @property {() => void} openNotes Opens the notes sheet (text note + voice notes).
 * @property {() => Promise<void>} openScratchpad
 * @property {() => boolean} canAskGpt True when Ask GPT is allowed (never during an unfinished exam).
 * @property {() => Promise<void>} askGpt
 * @property {() => Promise<void>} listen Starts (or pauses/resumes) reading aloud.
 * @property {() => void} stopAudio Stops reading aloud.
 * @property {() => void} report Opens "Report a problem".
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Choice ids of a question in file order.
 * @param {any} question
 * @returns {string[]}
 */
function choiceIds(question) {
  return Array.isArray(question?.choices) ? question.choices.filter((c) => isObj(c) && typeof c.id === 'string').map((c) => c.id) : [];
}

/**
 * A valid display order: the given order filtered to existing ids, missing ids appended.
 * @param {any} question
 * @param {unknown} order
 * @returns {string[]}
 */
function normalizeOrder(question, order) {
  const ids = choiceIds(question);
  if (!Array.isArray(order)) return ids;
  const valid = new Set(ids);
  const out = [...new Set(order.filter((id) => typeof id === 'string' && valid.has(id)))];
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * The display letter of a choice id in an order ('' when not shown).
 * @param {string[]} order
 * @param {string | null | undefined} id
 * @returns {string}
 */
export function letterFor(order, id) {
  const i = Array.isArray(order) && id ? order.indexOf(id) : -1;
  return i >= 0 ? LETTERS[i] || String(i + 1) : '';
}

/** @returns {boolean} */
function reduceMotion() {
  const v = document.documentElement.dataset.reduceMotion;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Tool modules that already showed their load error (one toast per tool per page). */
const failedTools = new Set();

/**
 * Loads a tool module; on failure shows one plain-language toast.
 * @template T
 * @param {string} name For the console and toast de-duplication.
 * @param {() => Promise<T>} loader
 * @returns {Promise<T | null>}
 */
export async function loadTool(name, loader) {
  try {
    return await loader();
  } catch (err) {
    console.warn(`[question-view] Could not load ${name}:`, err);
    if (!failedTools.has(name)) {
      failedTools.add(name);
      setTimeout(() => failedTools.delete(name), 8000);
      toast(TOOL_LOAD_ERROR, { kind: 'danger', action: { label: 'Reload', onClick: () => location.reload() } });
    }
    return null;
  }
}

/**
 * Builds a tool element with a factory; failures become one toast and `null`.
 * @template T
 * @param {string} name
 * @param {() => T} factory
 * @returns {T | null}
 */
function buildTool(name, factory) {
  try {
    return factory();
  } catch (err) {
    console.warn(`[question-view] ${name} failed:`, err);
    if (!failedTools.has(name)) {
      failedTools.add(name);
      setTimeout(() => failedTools.delete(name), 8000);
      toast(TOOL_LOAD_ERROR, { kind: 'danger' });
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Shared pieces used by the screens                                   */
/* ------------------------------------------------------------------ */

/**
 * A one-tap bookmark toggle for a question. Instant: the icon flips at once,
 * the write follows; a failed write flips it back and explains.
 * Keeps in sync with `qstate:change` (another screen or a backup import).
 *
 * @param {string} qid
 * @returns {HTMLButtonElement & { toggle: () => Promise<void>, destroy: () => void }}
 */
export function createBookmarkButton(qid) {
  let on = false;
  let busy = false;
  const btn = /** @type {HTMLButtonElement & { toggle: () => Promise<void>, destroy: () => void }} */ (
    iconButton({ icon: 'bookmark', label: 'Bookmark', pressed: false, onClick: () => void btn.toggle() })
  );
  btn.classList.add('qv-bookmark');

  /** @param {boolean} value */
  const paint = (value) => {
    on = value;
    btn.setAttribute('aria-pressed', String(value));
    btn.classList.toggle('is-on', value);
    btn.replaceChildren(icon(value ? 'bookmark-filled' : 'bookmark', { size: 22 }));
    btn.title = value ? 'Remove bookmark' : 'Bookmark';
    btn.setAttribute('aria-label', 'Bookmark');
  };

  const load = async () => {
    try {
      const st = await qstateRepo.get(qid);
      if (!busy) paint(isObj(st) && st.bookmarked === true);
    } catch (err) {
      console.warn('[question-view] Could not read the bookmark:', err);
    }
  };

  btn.toggle = async () => {
    if (busy) return;
    busy = true;
    const before = on;
    paint(!before);
    try {
      const { toggleBookmark } = await import('./quiz/engine.js');
      const stored = await toggleBookmark(qid);
      paint(stored);
      toast(stored ? 'Bookmarked' : 'Bookmark removed', { duration: 1800 });
    } catch (err) {
      paint(before);
      console.error('[question-view] Bookmark failed:', err);
      toast("Couldn't save the bookmark. Check your storage space, then try again.", { kind: 'danger' });
    } finally {
      busy = false;
    }
  };

  const off = bus.on('qstate:change', (p) => {
    if (!busy && p && p.qid === qid) void load();
  });
  btn.destroy = () => off();
  paint(false);
  void load();
  return btn;
}

/**
 * Opens a sheet with the question's text note and voice notes.
 * @param {any} question
 * @param {{ focus?: 'note' | 'voice' }} [opts]
 * @returns {Promise<void>}
 */
export async function openNotesSheet(question, { focus = 'note' } = {}) {
  const [notes, voice] = await Promise.all([
    loadTool('notes', () => import('./notes.js')),
    loadTool('voice notes', () => import('./voice.js')),
  ]);
  if (!notes && !voice) return;
  /** @type {any[]} */
  const parts = [];
  const editor = notes ? buildTool('notes', () => notes.createNoteEditor(question.id)) : null;
  const voiceEl = voice ? buildTool('voice notes', () => voice.createVoiceNotes(question.id)) : null;
  if (editor) parts.push(editor);
  if (voiceEl) parts.push(voiceEl);
  if (parts.length === 0) return;
  const content = h('div', { class: 'qv-notes-sheet' }, parts);
  sheet({
    title: 'Your notes',
    content,
    onClose: () => {
      try {
        /** @type {any} */ (editor)?.flush?.();
      } catch {
        /* autosave already handles it */
      }
    },
  });
  requestAnimationFrame(() => {
    if (focus === 'voice') {
      /** @type {HTMLElement | null} */ (content.querySelector('.voice-record, .voice-notes button'))?.focus();
    } else {
      /** @type {HTMLElement | null} */ (content.querySelector('textarea'))?.focus();
    }
  });
}

/**
 * Opens the "More" menu for a question view (report, note, voice note,
 * scratchpad, Ask GPT, Listen, plus optional extra rows).
 *
 * @param {QuestionView} view
 * @param {any} question
 * @param {{ extra?: { title: string, subtitle?: string, icon: string, onClick: () => void }[] }} [opts]
 * @returns {void}
 */
export function openQuestionMenu(view, question, { extra = [] } = {}) {
  /** @type {{ close: (r?: string) => Promise<void> } | null} */
  let ref = null;
  /** @param {() => any} fn */
  const run = (fn) => () => {
    void ref?.close('action').then(() => fn());
  };
  /** @type {HTMLElement[]} */
  const rows = [
    listItem({ title: 'Read aloud', subtitle: 'Listen to the question', icon: 'play', onClick: run(() => view.listen()) }),
    listItem({ title: 'Note', subtitle: 'Write a note for this question', icon: 'note', onClick: run(() => openNotesSheet(question)) }),
    listItem({ title: 'Voice note', subtitle: 'Record a short audio note', icon: 'mic', onClick: run(() => openNotesSheet(question, { focus: 'voice' })) }),
    listItem({ title: 'Scratchpad', subtitle: 'A blank page to draw and work things out', icon: 'pen', onClick: run(() => view.openScratchpad()) }),
  ];
  if (view.canAskGpt()) {
    rows.push(listItem({ title: 'Ask GPT', subtitle: 'Opens ChatGPT (outside source, needs internet)', icon: 'sparkles', onClick: run(() => view.askGpt()) }));
  }
  for (const x of extra) rows.push(listItem({ title: x.title, subtitle: x.subtitle, icon: x.icon, onClick: run(x.onClick) }));
  rows.push(listItem({ title: 'Report a problem', subtitle: 'Wrong answer, typo, unclear…', icon: 'flag', onClick: run(() => view.report()) }));
  ref = sheet({ title: 'More', content: h('div', { class: 'list qv-menu' }, rows), size: 's' });
}

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

/**
 * Renders one question in every state (§7.13).
 *
 * @param {any} question A Question (§3.3).
 * @param {ViewOptions} [opts]
 * @returns {QuestionView}
 */
export function createQuestionView(question, opts = {}) {
  const qid = String(question?.id ?? '');
  /** @type {ViewState} */
  const state = {
    mode: opts.mode === 'exam' || opts.mode === 'browse' ? opts.mode : 'tutor',
    choiceOrder: normalizeOrder(question, opts.choiceOrder),
    selected: typeof opts.selected === 'string' ? opts.selected : null,
    struck: Array.isArray(opts.struck) ? [...opts.struck] : [],
    revealed: opts.mode === 'browse' ? opts.revealed !== false : Boolean(opts.revealed),
  };
  const { onChoose, onStrike, onDrawingChange } = opts;
  let destroyed = false;
  let drawing = false;
  /** @type {(() => void)[]} */
  const cleanups = [];

  const choiceById = new Map((question?.choices || []).filter(isObj).map((c) => [c.id, c]));
  const uidBase = `qv-${qid.replace(/[^A-Za-z0-9-]/g, '')}-${Math.random().toString(36).slice(2, 7)}`;

  /* ---------------- question pane ---------------- */

  const badge = unreviewedBadge(question);
  const meta = h(
    'div',
    { class: 'qv-meta' },
    badge,
    question?.topic ? h('span', { class: 'qv-topic' }, String(question.topic)) : null,
    h('span', { class: 'qv-qid', 'aria-label': `Question ID ${qid}` }, qid),
  );
  const notices = h('div', { class: 'qv-notices', 'aria-live': 'polite' });
  const stem = renderStem(question);
  stem.id = `${uidBase}-stem`;
  const image = question?.image ? h('div', { class: 'qv-image' }, renderImage(question.image)) : null;

  /** @type {Map<string, { row: HTMLElement, btn: HTMLButtonElement, letter: HTMLElement, status: HTMLElement,
   *   sr: HTMLElement, srLetter: HTMLElement, strike: HTMLButtonElement, note: HTMLElement | null }>} */
  const rows = new Map();
  const choicesEl = h('div', { class: 'qv-choices', role: 'group', 'aria-label': 'Answer choices' });
  for (const cid of state.choiceOrder) {
    const c = choiceById.get(cid);
    if (!c) continue;
    const letter = h('span', { class: 'qv-letter', 'data-anchor-skip': '', 'aria-hidden': 'true' });
    const status = h('span', { class: 'qv-status', 'data-anchor-skip': '', 'aria-hidden': 'true' });
    const sr = h('span', { class: 'visually-hidden', 'data-anchor-skip': '' });
    const srLetter = h('span', { class: 'visually-hidden', 'data-anchor-skip': '' });
    const textEl = h('span', { class: 'qv-choice-text', dataset: { block: `choice-${cid}` } }, renderInline(c.text));
    const btn = /** @type {HTMLButtonElement} */ (
      h('button', { type: 'button', class: 'qv-choice', dataset: { choice: cid } }, letter, srLetter, textEl, sr, status)
    );
    const strike = /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: 'qv-strike', 'aria-pressed': 'false', 'data-anchor-skip': '', dataset: { choice: cid } },
        icon('eye-off', { size: 18 }),
      )
    );
    const row = h('div', { class: 'qv-choice-row', dataset: { choice: cid } }, btn, strike);
    rows.set(cid, { row, btn, letter, status, sr, srLetter, strike, note: null });
    wireChoice(cid, btn, strike);
    choicesEl.append(row);
  }

  const feedback = h('div', { class: 'qv-feedback', role: 'status', 'aria-live': 'polite' });
  const tools = h('div', { class: 'qv-tools' });
  const reportBtn = button({ label: 'Report', icon: 'flag', variant: 'ghost', size: 's', onClick: () => api.report() });
  reportBtn.classList.add('qv-report');
  const listenSlot = h('div', { class: 'qv-listen-slot' });
  const gptSlot = h('div', { class: 'qv-gpt-slot' });
  tools.append(listenSlot, gptSlot, reportBtn);

  const main = h('div', { class: 'qv-main' }, meta, notices, stem, image, choicesEl, feedback, tools);

  /* ---------------- explanation pane ---------------- */

  const side = h('div', { class: 'qv-side' });
  const sideHint = h(
    'div',
    { class: 'qv-side-hint', 'aria-hidden': 'true' },
    h('span', { class: 'qv-side-hint-icon' }, icon('info', { size: 22 })),
    h('p', null, 'Pick an answer to see the explanation here.'),
    // Decorative "standby monitor" trace (the whole hint is aria-hidden).
    h('span', { class: 'ecg-line qv-side-hint-ecg' }),
  );

  const el = h(
    'article',
    { class: ['qv', `qv-mode-${state.mode}`], dataset: { qid }, 'aria-label': `Question ${qid}` },
    main,
    side,
  );

  /** @type {HTMLElement | null} */
  let explainSection = null;
  /** @type {HTMLElement | null} */
  let notesSection = null;
  /** @type {HTMLElement | null} */
  let reviewerEl = null;
  /** @type {any} */
  let listenEl = null;
  /** @type {any} */
  let gptEl = null;
  /** @type {Promise<any> | null} */
  let listenLoading = null;
  /** @type {Promise<any> | null} */
  let gptLoading = null;
  /** @type {any} */
  let ink = null;
  /** @type {Promise<any> | null} */
  let inkLoading = null;
  /** @type {HTMLElement | null} */
  let toolbar = null;
  /** @type {any[]} */
  let orphanList = [];
  let inkStale = false;

  /* ---------------- choice input ---------------- */

  /**
   * @param {string} cid
   * @param {HTMLButtonElement} btn
   * @param {HTMLButtonElement} strike
   */
  function wireChoice(cid, btn, strike) {
    /** @type {{ id: number, x: number, y: number, timer: number, fired: boolean, swiped: boolean } | null} */
    let press = null;
    let suppressClick = false;

    const clearPress = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };

    btn.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || drawing || !canStrike()) return;
      clearPress();
      const p = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: 0, fired: false, swiped: false };
      p.timer = window.setTimeout(() => {
        if (press !== p) return;
        p.fired = true;
        suppressClick = true;
        try {
          getSelection()?.removeAllRanges();
        } catch {
          /* ignore */
        }
        navigator.vibrate?.(12);
        strikeChoice(cid);
      }, LONG_PRESS_MS);
      press = p;
    });
    btn.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.id || press.fired) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      if (Math.abs(dx) > MOVE_CANCEL_PX || Math.abs(dy) > MOVE_CANCEL_PX) clearTimeout(press.timer);
      if (!press.swiped && dx < -SWIPE_PX && Math.abs(dy) < SWIPE_PX * 0.6) {
        press.swiped = true;
        suppressClick = true;
        row(cid)?.row.classList.add('is-swiping');
        setTimeout(() => row(cid)?.row.classList.remove('is-swiping'), 220);
        strikeChoice(cid);
      }
    });
    const end = () => {
      if (press && (press.fired || press.swiped)) {
        // The click that follows the gesture must not choose the answer.
        setTimeout(() => {
          suppressClick = false;
        }, 400);
      }
      clearPress();
    };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', () => {
      clearPress();
      suppressClick = false;
    });
    btn.addEventListener('contextmenu', (e) => {
      // A long press strikes the choice while answering; no context menu then.
      if (canStrike()) e.preventDefault();
    });
    btn.addEventListener('click', (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.preventDefault();
        return;
      }
      if (drawing || isLocked()) return;
      // A mouse drag that selected text inside the choice is a highlight, not an answer.
      // A tap that ends a text selection (inside or into this choice) is a highlight, not an answer.
      const sel = getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount && (btn.contains(sel.anchorNode) || btn.contains(sel.focusNode))) return;
      choose(cid);
    });
    strike.addEventListener('click', () => strikeChoice(cid));
  }

  /** @param {string} cid */
  function row(cid) {
    return rows.get(cid) ?? null;
  }

  /** @returns {boolean} The answer can no longer change (tutor answered, browse, revealed). */
  function isLocked() {
    if (state.mode === 'browse' || state.revealed) return true;
    return false;
  }

  /** @returns {boolean} */
  function canStrike() {
    return !isLocked() && typeof onStrike === 'function';
  }

  /** @param {string} cid */
  function choose(cid) {
    if (typeof onChoose !== 'function') return;
    try {
      onChoose(cid);
    } catch (err) {
      console.error('[question-view] onChoose failed:', err);
    }
  }

  /** @param {string} cid */
  function strikeChoice(cid) {
    if (!canStrike()) return;
    try {
      /** @type {Function} */ (onStrike)(cid);
    } catch (err) {
      console.error('[question-view] onStrike failed:', err);
    }
  }

  /* ---------------- state → DOM ---------------- */

  function paintChoices() {
    const correctId = question?.answer;
    const revealed = state.revealed;
    const locked = isLocked();
    state.choiceOrder.forEach((cid, i) => {
      const r = rows.get(cid);
      if (!r) return;
      const letter = LETTERS[i] || String(i + 1);
      r.letter.textContent = letter;
      r.srLetter.textContent = `${letter}. `;
      const selected = state.selected === cid;
      const struck = !revealed && state.struck.includes(cid);
      const isCorrect = revealed && cid === correctId;
      const isWrong = revealed && selected && cid !== correctId;
      r.row.classList.toggle('is-selected', selected);
      r.row.classList.toggle('is-struck', struck);
      r.row.classList.toggle('is-correct', isCorrect);
      r.row.classList.toggle('is-wrong', isWrong);
      r.row.classList.toggle('is-dim', revealed && !isCorrect && !isWrong);
      r.row.classList.toggle('is-locked', locked);
      r.btn.setAttribute('aria-pressed', String(selected));
      if (locked) r.btn.setAttribute('aria-disabled', 'true');
      else r.btn.removeAttribute('aria-disabled');
      r.status.replaceChildren(isCorrect ? icon('check', { size: 20 }) : isWrong ? icon('x', { size: 20 }) : '');
      r.sr.textContent = isCorrect
        ? selected
          ? ' (your answer, correct)'
          : ' (correct answer)'
        : isWrong
          ? ' (your answer, incorrect)'
          : struck
            ? ' (struck out)'
            : '';
      r.strike.hidden = locked || typeof onStrike !== 'function';
      r.strike.setAttribute('aria-pressed', String(struck));
      const label = struck ? `Restore choice ${letter}` : `Strike out choice ${letter}`;
      r.strike.setAttribute('aria-label', label);
      r.strike.title = label;
      r.strike.replaceChildren(icon(struck ? 'eye' : 'eye-off', { size: 18 }));
      // Choice notes appear under each choice once revealed.
      const noteText = isObj(question?.choiceNotes) ? question.choiceNotes[cid] : null;
      if (revealed && typeof noteText === 'string' && noteText.trim() && !r.note) {
        r.note = h('div', { class: 'qv-choice-note', dataset: { block: `note-${cid}` } }, renderInline(noteText));
        r.row.after(r.note);
      } else if (!revealed && r.note) {
        r.note.remove();
        r.note = null;
      }
    });
  }

  function paintFeedback() {
    const correctId = question?.answer;
    const correctLetter = letterFor(state.choiceOrder, correctId);
    feedback.replaceChildren();
    feedback.className = 'qv-feedback';
    if (!state.revealed) return;
    if (state.selected && state.selected === correctId) {
      feedback.classList.add('is-correct');
      feedback.append(h('span', { class: 'qv-fb-icon', 'aria-hidden': 'true' }, icon('check', { size: 20 })), h('span', null, h('strong', null, 'Correct.'), ' Well done.'));
    } else if (state.selected) {
      feedback.classList.add('is-wrong');
      feedback.append(
        h('span', { class: 'qv-fb-icon', 'aria-hidden': 'true' }, icon('x', { size: 20 })),
        h('span', null, h('strong', null, 'Not quite.'), ` The answer is ${correctLetter}.`),
      );
    } else {
      feedback.classList.add('is-info');
      feedback.append(
        h('span', { class: 'qv-fb-icon', 'aria-hidden': 'true' }, icon('target', { size: 20 })),
        h('span', null, state.mode === 'browse' ? 'Answer: ' : 'Not answered. The answer is ', h('strong', null, correctLetter), '.'),
      );
    }
  }

  function buildExplanation() {
    const headingId = `${uidBase}-xh`;
    const blocks = Array.isArray(question?.explanation) ? question.explanation : [];
    const body = blocks.length
      ? renderBlocks(blocks, { qid })
      : h('p', { class: 'qv-empty-explain' }, 'There is no explanation for this question yet.');
    const sources = Array.isArray(question?.source)
      ? question.source.filter((s) => isObj(s) && (s.ref || s.loc))
      : [];
    const section = h(
      'section',
      { class: 'qv-explain', 'aria-labelledby': headingId },
      h('h2', { class: 'qv-h2', id: headingId }, 'Explanation'),
      body,
      sources.length
        ? h(
            'p',
            { class: 'qv-source' },
            h('span', { class: 'qv-source-label' }, sources.length > 1 ? 'Sources: ' : 'Source: '),
            sources.map((s, i) => [i ? '; ' : '', [s.ref, s.loc].filter(Boolean).join(', ')]),
          )
        : null,
    );
    return section;
  }

  function buildNotesSection() {
    const headingId = `${uidBase}-nh`;
    const body = h('div', { class: 'qv-notes-body' });
    const section = h(
      'section',
      { class: 'qv-notes', 'aria-labelledby': headingId },
      h('h2', { class: 'qv-h2', id: headingId }, icon('note', { size: 18 }), 'Your notes'),
      body,
    );
    void Promise.all([loadTool('notes', () => import('./notes.js')), loadTool('voice notes', () => import('./voice.js'))]).then(
      ([notes, voice]) => {
        if (destroyed) return;
        const editor = notes ? buildTool('notes', () => notes.createNoteEditor(qid)) : null;
        const voiceEl = voice ? buildTool('voice notes', () => voice.createVoiceNotes(qid)) : null;
        if (editor) body.append(editor);
        if (voiceEl) body.append(voiceEl);
        if (!editor && !voiceEl) section.hidden = true;
        cleanups.push(() => {
          try {
            /** @type {any} */ (editor)?.flush?.();
            /** @type {any} */ (editor)?.destroy?.();
            /** @type {any} */ (voiceEl)?.destroy?.();
          } catch (err) {
            console.warn('[question-view] Notes cleanup failed:', err);
          }
        });
      },
    );
    return section;
  }

  function paintReveal() {
    el.classList.toggle('is-revealed', state.revealed);
    el.classList.toggle('has-side', state.revealed || state.mode === 'tutor');
    if (state.revealed) {
      sideHint.remove();
      if (!explainSection) {
        explainSection = buildExplanation();
        if (!reduceMotion()) explainSection.classList.add('is-entering');
        side.append(explainSection);
        notesSection = buildNotesSection();
        side.append(notesSection);
        if (getSetting('reviewerMode') === true) {
          reviewerEl = buildTool('reviewer panel', () => createReviewerPanel(question));
          if (reviewerEl) side.append(h('div', { class: 'qv-reviewer' }, reviewerEl));
        }
        void ensureGpt();
      }
    } else {
      if (explainSection) {
        explainSection.remove();
        notesSection?.remove();
        reviewerEl?.parentElement?.remove();
        explainSection = null;
        notesSection = null;
        reviewerEl = null;
      }
      gptSlot.replaceChildren();
      gptEl = null;
      if (state.mode === 'tutor' && !sideHint.isConnected) side.append(sideHint);
    }
  }

  function paint() {
    el.classList.remove('qv-mode-tutor', 'qv-mode-exam', 'qv-mode-browse');
    el.classList.add(`qv-mode-${state.mode}`);
    paintChoices();
    paintFeedback();
    paintReveal();
  }

  /* ---------------- tools ---------------- */

  /** @returns {boolean} */
  function canAskGpt() {
    return state.revealed || state.mode !== 'exam';
  }

  async function ensureListen() {
    if (listenEl) return listenEl;
    if (!listenLoading) {
      listenLoading = loadTool('read aloud', () => import('./tts.js')).then((mod) => {
        if (!mod || destroyed) return null;
        const node = buildTool('read aloud', () =>
          mod.createListenButton(question, () => ({ choiceOrder: state.choiceOrder.slice(), revealed: state.revealed })),
        );
        if (node) {
          listenEl = node;
          listenSlot.append(node);
        }
        return listenEl;
      });
      listenLoading.finally(() => {
        if (!listenEl) listenLoading = null;
      });
    }
    return listenLoading;
  }

  async function ensureGpt() {
    if (gptEl) return gptEl;
    if (!canAskGpt()) return null;
    if (!gptLoading) {
      gptLoading = loadTool('Ask GPT', () => import('./askgpt.js')).then((mod) => {
        if (!mod || destroyed || !canAskGpt()) return null;
        const node = buildTool('Ask GPT', () =>
          mod.createAskGptButton(question, () => ({ choiceOrder: state.choiceOrder.slice(), userChoice: state.selected })),
        );
        if (node) {
          gptEl = node;
          gptSlot.replaceChildren(node);
        }
        return gptEl;
      });
      gptLoading.finally(() => {
        gptLoading = null;
      });
    }
    return gptLoading;
  }

  /**
   * Loads the ink layers (once). Saved drawings show at once; input stays off until enabled.
   * @returns {Promise<any>}
   */
  function ensureInk() {
    if (ink) return Promise.resolve(ink);
    if (!inkLoading) {
      inkLoading = loadTool('drawing', () => import('./annotate/ink.js')).then((mod) => {
        if (!mod || destroyed) return null;
        const ctrl = buildTool('drawing', () => mod.initInk(el, question));
        if (!ctrl) return null;
        ink = ctrl;
        try {
          ink.on?.('stale', (/** @type {any} */ p) => {
            inkStale = Array.isArray(p?.blocks) && p.blocks.length > 0;
            paintNotices();
          });
          ink.on?.('error', () => {
            toast("Your drawing couldn't be saved. Check your storage space.", { kind: 'danger' });
          });
        } catch {
          /* optional events */
        }
        return ink;
      });
      inkLoading.finally(() => {
        if (!ink) inkLoading = null;
      });
    }
    return inkLoading;
  }

  function hideToolbar() {
    toolbar?.remove();
    toolbar = null;
  }

  /**
   * @param {boolean} on
   * @returns {Promise<boolean>}
   */
  async function setDrawing(on) {
    const want = Boolean(on);
    if (want === drawing || destroyed) return drawing;
    if (!want) {
      drawing = false;
      el.classList.remove('is-drawing');
      hideToolbar();
      try {
        await ink?.disable?.();
      } catch (err) {
        console.warn('[question-view] Ink disable failed:', err);
      }
      onDrawingChange?.(false);
      return false;
    }
    const ctrl = await ensureInk();
    if (!ctrl || destroyed) return false;
    const tbMod = await loadTool('drawing toolbar', () => import('./annotate/ink-toolbar.js'));
    if (destroyed) return false;
    try {
      getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
    try {
      ctrl.enable();
    } catch (err) {
      console.warn('[question-view] Ink enable failed:', err);
      toast(TOOL_LOAD_ERROR, { kind: 'danger' });
      return false;
    }
    drawing = true;
    el.classList.add('is-drawing');
    if (tbMod) {
      const tb = buildTool('drawing toolbar', () =>
        tbMod.createInkToolbar(ctrl, {
          onDone: () => void setDrawing(false),
          onScratchpad: () => void api.openScratchpad(),
        }),
      );
      if (tb) {
        toolbar = tb;
        tb.classList.add('qv-ink-toolbar');
        document.body.append(tb);
      }
    }
    onDrawingChange?.(true);
    return true;
  }

  /* ---------------- notices (orphans / stale ink) ---------------- */

  function paintNotices() {
    notices.replaceChildren();
    if (orphanList.length) {
      const n = orphanList.length;
      notices.append(
        h(
          'div',
          { class: 'qv-notice' },
          h('span', { class: 'qv-notice-icon', 'aria-hidden': 'true' }, icon('info', { size: 18 })),
          h(
            'p',
            { class: 'qv-notice-text' },
            n === 1
              ? 'One of your highlights no longer matches this updated question.'
              : `${n} of your highlights no longer match this updated question.`,
          ),
          button({ label: 'Show', size: 's', variant: 'ghost', onClick: showOrphans }),
        ),
      );
    }
    if (inkStale) {
      notices.append(
        h(
          'div',
          { class: 'qv-notice' },
          h('span', { class: 'qv-notice-icon', 'aria-hidden': 'true' }, icon('pen', { size: 18 })),
          h('p', { class: 'qv-notice-text' }, 'Some drawings were made on an older version of this question, so they may sit in a slightly different place.'),
        ),
      );
    }
  }

  function showOrphans() {
    const list = h(
      'ul',
      { class: 'qv-orphans' },
      orphanList.map((o) =>
        h(
          'li',
          { class: ['qv-orphan', `uhl-${['yellow', 'green', 'blue', 'pink'].includes(o?.color) ? o.color : 'yellow'}`] },
          h('span', { class: 'qv-orphan-quote' }, `“${String(o?.quote ?? '').trim()}”`),
        ),
      ),
    );
    sheet({
      title: 'Highlights that no longer match',
      content: h(
        'div',
        { class: 'stack gap-3' },
        h('p', { class: 'muted m-0' }, 'The question was edited, so these highlighted passages can’t be placed any more. They are kept safely on your device and are listed here so nothing is lost.'),
        list,
      ),
      size: 's',
    });
  }

  /* ---------------- init ---------------- */

  paint();
  if (state.mode === 'tutor' && !state.revealed) side.append(sideHint);

  // Read aloud is available from the start (stem + choices).
  void ensureListen();

  /** @type {{ destroy: () => void, refresh: () => Promise<void> } | null} */
  let hl = null;
  // Highlights load right after the question renders (§7.13).
  queueMicrotask(() => {
    if (destroyed) return;
    hl = buildTool('highlights', () =>
      initHighlights(el, question, {
        onOrphans: (list) => {
          orphanList = Array.isArray(list) ? list : [];
          paintNotices();
        },
      }),
    );
  });

  // Saved ink: show it without a tap.
  if (qid) {
    inkRepo
      .byQid(qid)
      .then((records) => {
        if (destroyed) return;
        const any = Array.isArray(records) && records.some((r) => isObj(r) && r.block !== 'scratch' && Array.isArray(r.strokes) && r.strokes.length);
        if (any) void ensureInk();
      })
      .catch((err) => console.warn('[question-view] Could not read saved drawings:', err));
  }

  /** @type {QuestionView} */
  const api = {
    el,
    update(partial) {
      if (destroyed || !isObj(partial)) return;
      if (partial.mode === 'tutor' || partial.mode === 'exam' || partial.mode === 'browse') state.mode = partial.mode;
      if (partial.choiceOrder) state.choiceOrder = normalizeOrder(question, partial.choiceOrder);
      if ('selected' in partial) state.selected = typeof partial.selected === 'string' ? partial.selected : null;
      if (Array.isArray(partial.struck)) state.struck = [...partial.struck];
      if ('revealed' in partial) state.revealed = Boolean(partial.revealed);
      paint();
    },
    setDrawing,
    isDrawing: () => drawing,
    focusFirstChoice() {
      const first = rows.get(state.choiceOrder[0]);
      first?.btn.focus({ preventScroll: true });
    },
    getState: () => ({ ...state, choiceOrder: state.choiceOrder.slice(), struck: state.struck.slice() }),
    openNotes() {
      void openNotesSheet(question);
    },
    async openScratchpad() {
      const mod = await loadTool('scratchpad', () => import('./annotate/scratchpad.js'));
      if (!mod || destroyed) return;
      buildTool('scratchpad', () => mod.openScratchpad(question));
    },
    canAskGpt,
    async askGpt() {
      if (!canAskGpt()) {
        toast('Ask GPT is available after you finish the exam.');
        return;
      }
      const node = await ensureGpt();
      const btn = /** @type {HTMLButtonElement | null} */ (node?.querySelector?.('button'));
      if (!btn) return;
      if (btn.disabled) {
        toast('Ask GPT needs an internet connection. Everything else works offline.');
        return;
      }
      btn.click();
    },
    async listen() {
      const node = await ensureListen();
      if (!node || node.hidden) {
        if (node) toast('Read aloud isn’t available on this device.');
        return;
      }
      /** @type {HTMLButtonElement | null} */ (node.querySelector('.listen-btn') || node.querySelector('button'))?.click();
    },
    stopAudio() {
      try {
        listenEl?.stop?.();
      } catch {
        /* ignore */
      }
    },
    report() {
      try {
        openReportSheet(question);
      } catch (err) {
        console.error('[question-view] Report sheet failed:', err);
        toast(TOOL_LOAD_ERROR, { kind: 'danger' });
      }
    },
    destroy() {
      if (destroyed) return;
      api.stopAudio();
      destroyed = true;
      hideToolbar();
      try {
        listenEl?.destroy?.();
      } catch {
        /* ignore */
      }
      try {
        hl?.destroy();
      } catch (err) {
        console.warn('[question-view] Highlight cleanup failed:', err);
      }
      const inkCtrl = ink;
      ink = null;
      if (inkCtrl) {
        Promise.resolve()
          .then(() => inkCtrl.destroy?.())
          .catch((err) => console.warn('[question-view] Ink cleanup failed:', err));
      }
      for (const fn of cleanups.splice(0)) fn();
    },
  };
  return api;
}
