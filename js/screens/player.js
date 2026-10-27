/**
 * Player screen (`#/quiz/:id`, docs/ARCHITECTURE.md §8 "Player", §7.3, §7.13).
 *
 * The most important screen. Answers the questions of one stored session:
 * - Top bar: close (saves, goes back), progress "7 / 20" with a thin bar (tap →
 *   question navigator), exam timer, mark (exam), bookmark, More menu
 *   (read aloud, note, voice note, scratchpad, Ask GPT, report, shortcuts).
 * - Tutor: tap → instant feedback + explanation (question-view.js).
 * - Exam: selection changeable, navigator grid (answered / marked / current),
 *   Finish confirms only when questions are unanswered, time up → auto-finish.
 * - Bottom bar (thumb reach): Prev, Draw, Highlight, Scratchpad, Next (→ Finish / See results).
 * - Keyboard: 1–5 / A–E choose, ←/→ move, Shift+B (or B once answered) bookmark,
 *   Shift+D (or D once answered) draw, M mark, H highlight, ? shortcuts, Esc.
 * - Always resumable: the index, answers, strikes, marks and timers live in the
 *   session (debounced saves, flushed on pagehide/hidden and on leave); the
 *   scroll position per session is remembered on this device.
 *
 * @module screens/player
 */

import { h } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { getSetting } from '../core/settings.js';
import { formatDuration, plural } from '../core/util.js';
import { getQuestions } from '../core/data.js';
import { icon } from '../ui/icons.js';
import { setHeader, setTabBarVisible } from '../ui/shell.js';
import { button, iconButton, toast, sheet, confirmSheet, emptyState, spinner } from '../ui/components.js';
import {
  loadSession,
  saveSession,
  flushSessions,
  recordAnswer,
  completeSession,
  applyAnswer,
  toggleStrike,
  toggleMark,
  goTo,
  addTime,
  answerOf,
  isFinished,
  isTimeUp,
  remainingMs,
  answeredCount,
  unansweredCount,
  firstUnansweredIndex,
  choiceOrderFor,
  isCorrectChoice,
} from '../features/quiz/engine.js';
import { highlightSelection } from '../features/annotate/highlight.js';
import { createQuestionView, createBookmarkButton, openQuestionMenu, letterFor } from '../features/question-view.js';

/** Tick interval (ms) of the clock (time tracking + exam timer). */
const TICK_MS = 1000;
/** Save the time spent every this many ticks (answers save at once). */
const SAVE_EVERY_TICKS = 5;
/** Ignore time gaps longer than this between ticks (device slept). */
const MAX_TICK_GAP_MS = 60 * 1000;
/** Auto-advance delay after an exam selection (setting `autoAdvance`). */
const AUTO_ADVANCE_MS = 450;
/** Remaining-time thresholds announced to screen readers (ms). */
const ANNOUNCE_AT = [5 * 60 * 1000, 60 * 1000];
/** Prefix of the per-session scroll memory (localStorage, per device). */
const SCROLL_KEY = 'cmcq:player-scroll:';

/**
 * @typedef {import('../features/quiz/engine.js').Session} Session
 * @typedef {import('../features/question-view.js').QuestionView} QuestionView
 */

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {string} key
 * @returns {any}
 */
function readStore(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {any} value null removes.
 */
function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* per-device convenience only */
  }
}

/** @returns {boolean} */
function reduceMotion() {
  const v = document.documentElement.dataset.reduceMotion;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * @param {EventTarget | null} t
 * @returns {boolean}
 */
function isEditable(t) {
  const el = /** @type {HTMLElement | null} */ (t);
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** @returns {boolean} A sheet/dialog is open. */
function sheetOpen() {
  return Boolean(document.querySelector('#sheet-slot .sheet-root:not(.is-closing)'));
}

/**
 * Replaces the shell's back button with a "close" icon (it already goes back).
 */
function styleCloseButton() {
  const back = document.querySelector('#app-header .hdr-back');
  if (!back) return;
  back.replaceChildren(icon('close', { size: 22 }));
  back.setAttribute('aria-label', 'Close quiz. Your progress is saved.');
  back.setAttribute('title', 'Close (progress is saved)');
  back.classList.add('player-close');
}

/**
 * A friendly state with a way out (unknown session, load failure…).
 * @param {{ icon: string, title: string, text: string, retry?: () => void }} o
 * @returns {HTMLElement}
 */
function stateView({ icon: iconName, title, text, retry }) {
  return h(
    'div',
    { class: 'player-state' },
    h('h1', { class: 'visually-hidden' }, title),
    emptyState({
      icon: iconName,
      title,
      text,
      action: h(
        'div',
        { class: 'row wrap gap-2 center' },
        retry ? button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: retry }) : null,
        button({ label: 'Go home', icon: 'home', variant: retry ? 'secondary' : 'primary', onClick: () => navigate('/') }),
        retry ? null : button({ label: 'New quiz', icon: 'plus', onClick: () => navigate('/new') }),
      ),
    }),
  );
}

/**
 * Keyboard shortcuts sheet.
 */
function showShortcuts() {
  const rows = [
    ['1 – 5 or A – E', 'Choose an answer'],
    ['← / →', 'Previous / next question'],
    ['Shift + B', 'Bookmark (B once answered)'],
    ['Shift + D', 'Draw on the question (D once answered)'],
    ['H', 'Highlight the selected text'],
    ['M', 'Mark for review (exam)'],
    ['G', 'Question list'],
    ['Esc', 'Close a sheet or stop drawing'],
  ];
  sheet({
    title: 'Keyboard shortcuts',
    size: 's',
    content: h(
      'dl',
      { class: 'player-keys' },
      rows.map(([k, v]) => [h('dt', null, h('kbd', null, k)), h('dd', null, v)]),
    ),
  });
}

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

export default {
  /**
   * @param {{ params: Record<string, string>, query: Record<string, string> }} ctx
   * @returns {Promise<{ el: HTMLElement, destroy: () => any, keepScroll: boolean }>}
   */
  async render(ctx) {
    const id = String(ctx?.params?.id ?? '');
    setTabBarVisible(false);
    setHeader({ title: 'Quiz', back: true });
    styleCloseButton();

    const restoreTabs = () => setTabBarVisible(true);
    const retry = () => location.reload();

    /** @type {Session | null} */
    let loaded;
    try {
      loaded = await loadSession(id);
    } catch (err) {
      console.error('[player] Could not load the session:', err);
      return {
        el: stateView({
          icon: 'alert',
          title: "This quiz couldn't open",
          text: 'Your device storage could not be read. Close other apps or free some space, then try again. Your progress is safe.',
          retry,
        }),
        destroy: restoreTabs,
        keepScroll: false,
      };
    }
    if (!loaded || loaded.qids.length === 0) {
      return {
        el: stateView({
          icon: 'search',
          title: 'Quiz not found',
          text: 'This quiz was removed or never finished saving. Start a new one; it takes one tap.',
        }),
        destroy: restoreTabs,
        keepScroll: false,
      };
    }
    if (isFinished(loaded)) {
      queueMicrotask(() => navigate(`/results/${encodeURIComponent(id)}`, { replace: true }));
      return { el: h('div', { class: 'player-state' }, spinner({ label: 'Opening results…' })), destroy: restoreTabs, keepScroll: false };
    }

    /** @type {Map<string, any>} */
    let byId;
    try {
      const list = await getQuestions(loaded.qids);
      byId = new Map(list.map((q) => [q.id, q]));
    } catch (err) {
      console.error('[player] Could not load questions:', err);
      return {
        el: stateView({
          icon: 'alert',
          title: "The questions couldn't load",
          text: /** @type {any} */ (err)?.userMessage || 'Please try again. If you are offline, open the app once with internet so it can finish downloading.',
          retry,
        }),
        destroy: restoreTabs,
        keepScroll: false,
      };
    }
    return mountPlayer(loaded, byId);
  },
};

/**
 * Builds the running player.
 * @param {Session} initial
 * @param {Map<string, any>} byId
 * @returns {{ el: HTMLElement, destroy: () => Promise<void>, keepScroll: boolean }}
 */
function mountPlayer(initial, byId) {
  /** @type {Session} */
  let s = initial;
  const id = s.id;
  const exam = s.mode === 'exam';
  const total = s.qids.length;
  const questions = [...byId.values()];
  const scrollKey = SCROLL_KEY + id;

  /** @type {QuestionView | null} */
  let view = null;
  /** @type {HTMLButtonElement & { destroy: () => void, toggle: () => Promise<void> } | null} */
  let bookmark = null;
  let destroyed = false;
  let finishing = false;
  let timeUpHandled = false;
  let ticks = 0;
  let lastTick = performance.now();
  let saveErrorShown = false;
  /** @type {Set<number>} */
  const announced = new Set();
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let advanceTimer = 0;
  /** @type {(() => void)[]} */
  const offs = [];

  /* ---------------- DOM ---------------- */

  const srTitle = h('h1', { class: 'visually-hidden player-h1', tabindex: '-1' });
  const stage = h('div', { class: 'player-stage' });
  const srLive = h('div', { class: 'visually-hidden', 'aria-live': 'assertive' });

  // Header pieces.
  const progressText = h('span', { class: 'player-progress-text tabular' });
  const progressFill = h('span', { class: 'player-progress-fill' });
  const progressBtn = h(
    'button',
    { type: 'button', class: 'player-progress', onClick: () => openNavigator() },
    h('span', { class: 'player-progress-row' }, progressText, icon('chevron-down', { size: 16 })),
    h('span', { class: 'player-progress-track', 'aria-hidden': 'true' }, progressFill),
  );
  const timerText = h('span', { class: 'player-timer-text tabular' });
  const timerEl = h('span', { class: 'player-timer', role: 'timer', 'aria-live': 'off' }, icon('timer', { size: 18 }), timerText);
  const markBtn = iconButton({ icon: 'flag', label: 'Mark for review', pressed: false, onClick: () => toggleMarkCurrent() });
  markBtn.classList.add('player-mark');
  const bookmarkSlot = h('span', { class: 'player-bookmark-slot' });
  const moreBtn = iconButton({ icon: 'more', label: 'More', onClick: () => openMore() });

  // Bottom bar.
  const prevBtn = button({ label: 'Prev', icon: 'chevron-left', variant: 'ghost', onClick: () => move(-1) });
  prevBtn.classList.add('pbar-prev');
  const drawBtn = button({ label: 'Draw', icon: 'pen', variant: 'ghost', onClick: () => void toggleDraw() });
  drawBtn.classList.add('pbar-tool');
  drawBtn.setAttribute('aria-pressed', 'false');
  const hlBtn = button({ label: 'Highlight', icon: 'highlighter', variant: 'ghost', onClick: () => void highlightNow() });
  hlBtn.classList.add('pbar-tool');
  // Keep the text selection when the button is pressed.
  hlBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  hlBtn.addEventListener('mousedown', (e) => e.preventDefault());
  const padBtn = button({ label: 'Scratchpad', icon: 'note', variant: 'ghost', onClick: () => void view?.openScratchpad() });
  padBtn.classList.add('pbar-tool', 'pbar-scratch');
  const nextLabel = h('span', { class: 'btn-label' }, 'Next');
  const nextIcon = h('span', { class: 'pbar-next-icon', 'aria-hidden': 'true' }, icon('chevron-right', { size: 20 }));
  const nextBtn = /** @type {HTMLButtonElement} */ (
    h('button', { type: 'button', class: 'btn btn-m btn-secondary pbar-next', onClick: () => onNext() }, nextLabel, nextIcon)
  );
  const pbar = h(
    'nav',
    { class: 'pbar', 'aria-label': 'Question navigation' },
    h('div', { class: 'pbar-inner' }, prevBtn, h('div', { class: 'pbar-tools' }, drawBtn, hlBtn, padBtn), nextBtn),
  );

  const el = h(
    'div',
    { class: ['player', exam ? 'player-exam' : 'player-tutor'], dataset: { session: id } },
    srTitle,
    stage,
    srLive,
    pbar,
  );

  setHeader({
    title: progressBtn,
    back: true,
    actions: [exam && getSetting('showTimer') !== false ? timerEl : null, exam ? markBtn : null, bookmarkSlot, moreBtn],
  });
  styleCloseButton();
  if (exam && getSetting('showTimer') === false) {
    // Hidden timer: still keep the remaining time reachable for screen readers on demand.
    progressBtn.title = 'Time is running';
  }

  /* ---------------- persistence ---------------- */

  /** Saves the session (debounced by the engine); a failure shows one calm message. */
  function persist() {
    saveSession(s).catch(() => {
      if (saveErrorShown || destroyed) return;
      saveErrorShown = true;
      toast("Your progress couldn't be saved. Free some storage space; the app keeps trying.", { kind: 'danger' });
    });
  }

  /** Adds the visible time since the last commit to the current question. */
  function commitTime() {
    const now = performance.now();
    const delta = now - lastTick;
    lastTick = now;
    if (finishing || isFinished(s) || document.visibilityState === 'hidden') return;
    if (delta <= 0 || delta > MAX_TICK_GAP_MS) return;
    const qid = s.qids[s.index];
    if (qid) s = addTime(s, qid, Math.round(delta));
  }

  function rememberScroll() {
    if (destroyed) return;
    const side = /** @type {HTMLElement | null} */ (stage.querySelector('.qv-side'));
    const mainPane = /** @type {HTMLElement | null} */ (stage.querySelector('.qv-main'));
    writeStore(scrollKey, {
      qid: s.qids[s.index],
      y: Math.round(window.scrollY),
      main: mainPane ? Math.round(mainPane.scrollTop) : 0,
      side: side ? Math.round(side.scrollTop) : 0,
    });
  }

  let scrollTimer = 0;
  const onScroll = () => {
    if (scrollTimer) return;
    scrollTimer = window.setTimeout(() => {
      scrollTimer = 0;
      rememberScroll();
    }, 250);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  // Pane scrolling (two-pane layout) does not bubble: capture it.
  el.addEventListener('scroll', onScroll, { passive: true, capture: true });
  offs.push(() => {
    window.removeEventListener('scroll', onScroll);
    clearTimeout(scrollTimer);
  });

  /* ---------------- clock ---------------- */

  function paintTimer() {
    if (!exam) return;
    const left = remainingMs(s);
    if (left === null) {
      timerEl.hidden = true;
      return;
    }
    timerText.textContent = formatDuration(left);
    timerEl.classList.toggle('is-low', left <= 60 * 1000);
    timerEl.classList.toggle('is-warn', left > 60 * 1000 && left <= 5 * 60 * 1000);
    timerEl.setAttribute('aria-label', `Time left: ${formatDuration(left)}`);
    for (const t of ANNOUNCE_AT) {
      if (left <= t && left > 0 && !announced.has(t)) {
        announced.add(t);
        const msg = t >= 60000 ? `${Math.round(t / 60000)} ${t === 60000 ? 'minute' : 'minutes'} left` : 'Time almost up';
        srLive.textContent = msg;
        if (t === 60 * 1000) toast('1 minute left.', { duration: 2500 });
      }
    }
  }

  const tick = window.setInterval(() => {
    if (destroyed || finishing) return;
    commitTime();
    paintTimer();
    ticks += 1;
    if (exam && isTimeUp(s)) {
      void onTimeUp();
      return;
    }
    if (ticks % SAVE_EVERY_TICKS === 0) persist();
  }, TICK_MS);
  offs.push(() => clearInterval(tick));

  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      commitTime();
      rememberScroll();
      persist();
      flushSessions().catch(() => {});
      view?.stopAudio();
    } else {
      lastTick = performance.now();
    }
  };
  const onPageHide = () => {
    commitTime();
    rememberScroll();
    persist();
    flushSessions().catch(() => {});
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  offs.push(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onPageHide);
  });

  async function onTimeUp() {
    if (timeUpHandled) return;
    timeUpHandled = true;
    toast("Time's up. Your exam was submitted, and here are your results.", { duration: 7000 });
    await finish({ auto: true });
  }

  /* ---------------- rendering ---------------- */

  /** @returns {string} */
  function currentQid() {
    return s.qids[s.index];
  }

  function paintHeader() {
    const n = s.index + 1;
    progressText.textContent = `${n} / ${total}`;
    const answered = answeredCount(s);
    progressFill.style.width = `${Math.round((answered / Math.max(1, total)) * 100)}%`;
    progressBtn.setAttribute('aria-label', `Question ${n} of ${total}, ${answered} answered. Open the question list.`);
    document.title = `${n} / ${total} · ${s.title} · KirKlin`;
    const qid = currentQid();
    const marked = s.marked[qid] === true;
    markBtn.setAttribute('aria-pressed', String(marked));
    markBtn.classList.toggle('is-on', marked);
    markBtn.title = marked ? 'Marked for review' : 'Mark for review';
    paintTimer();
  }

  function paintBottomBar() {
    const last = s.index >= total - 1;
    prevBtn.disabled = s.index <= 0;
    const qid = currentQid();
    const answered = Boolean(answerOf(s, qid));
    nextLabel.textContent = last ? (exam ? 'Finish' : 'See results') : 'Next';
    nextIcon.replaceChildren(icon(last ? 'check' : 'chevron-right', { size: 20 }));
    const primary = last || answered;
    nextBtn.classList.toggle('btn-primary', primary);
    nextBtn.classList.toggle('btn-secondary', !primary);
    const drawing = Boolean(view?.isDrawing());
    drawBtn.setAttribute('aria-pressed', String(drawing));
    drawBtn.classList.toggle('is-on', drawing);
    el.classList.toggle('is-drawing', drawing);
  }

  /** @param {number} [dir] -1 / 1 for the slide direction, 0 for none. */
  function renderQuestion(dir = 0) {
    view?.destroy();
    view = null;
    bookmark?.destroy();
    bookmark = null;
    const qid = currentQid();
    const q = byId.get(qid);
    srTitle.textContent = `Question ${s.index + 1} of ${total}`;

    if (!q) {
      stage.replaceChildren(
        h(
          'div',
          { class: 'player-missing' },
          emptyState({
            icon: 'alert',
            title: 'This question is no longer available',
            text: 'It was removed or is being updated. Your other answers are safe; just move on.',
            action: button({ label: 'Next question', variant: 'primary', onClick: () => onNext() }),
          }),
        ),
      );
      bookmarkSlot.replaceChildren();
    } else {
      const a = answerOf(s, qid);
      view = createQuestionView(q, {
        mode: exam ? 'exam' : 'tutor',
        choiceOrder: choiceOrderFor(s, q),
        selected: a ? a.choice : null,
        struck: s.struck[qid] || [],
        revealed: !exam && Boolean(a),
        onChoose: (cid) => void choose(q, cid),
        onStrike: (cid) => strike(qid, cid),
        onDrawingChange: () => paintBottomBar(),
      });
      if (dir && !reduceMotion()) view.el.classList.add(dir > 0 ? 'enter-next' : 'enter-prev');
      stage.replaceChildren(view.el);
      bookmark = createBookmarkButton(qid);
      bookmarkSlot.replaceChildren(bookmark);
    }
    paintHeader();
    paintBottomBar();
  }

  /**
   * Restores the remembered scroll position for this question (once, after mount).
   */
  function restoreScroll() {
    const saved = readStore(scrollKey);
    if (!saved || saved.qid !== currentQid()) {
      window.scrollTo(0, 0);
      return;
    }
    // Wait for the explanation and fonts to lay out.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (destroyed) return;
        window.scrollTo(0, Number(saved.y) || 0);
        const mainPane = /** @type {HTMLElement | null} */ (stage.querySelector('.qv-main'));
        const side = /** @type {HTMLElement | null} */ (stage.querySelector('.qv-side'));
        if (mainPane) mainPane.scrollTop = Number(saved.main) || 0;
        if (side) side.scrollTop = Number(saved.side) || 0;
      }),
    );
  }

  /* ---------------- actions ---------------- */

  /**
   * Moves to another question.
   * @param {number} index
   * @param {{ focus?: boolean }} [opts]
   */
  function goToIndex(index, { focus = true } = {}) {
    if (destroyed || finishing) return;
    const i = Math.max(0, Math.min(total - 1, index));
    if (i === s.index) return;
    clearTimeout(advanceTimer);
    commitTime();
    const dir = i > s.index ? 1 : -1;
    s = goTo(s, i);
    persist();
    renderQuestion(dir);
    window.scrollTo(0, 0);
    rememberScroll();
    if (focus) srTitle.focus({ preventScroll: true });
  }

  /** @param {number} delta */
  function move(delta) {
    if (delta > 0 && s.index >= total - 1) {
      void finish();
      return;
    }
    goToIndex(s.index + delta);
  }

  function onNext() {
    move(1);
  }

  /**
   * Takes over the stored state of one answer (keeps every other in-memory change).
   * @param {string} qid
   * @param {Session} from
   */
  function adoptAnswer(qid, from) {
    const a = answerOf(from, qid);
    const answers = { ...s.answers };
    if (a) answers[qid] = a;
    else delete answers[qid];
    const struck = { ...s.struck };
    if (Array.isArray(from.struck[qid]) && from.struck[qid].length) struck[qid] = from.struck[qid];
    else delete struck[qid];
    s = { ...s, answers, struck, updatedAt: Math.max(s.updatedAt || 0, from.updatedAt || 0) };
  }

  /**
   * @param {any} q
   * @param {string} cid
   */
  async function choose(q, cid) {
    if (destroyed || finishing || isFinished(s)) return;
    const qid = q.id;
    if (qid !== currentQid()) return;
    if (!exam && answerOf(s, qid)) return;
    commitTime();
    const ms = Math.max(0, Math.round(s.perQuestionMs[qid] || 0));
    const correct = isCorrectChoice(q, cid);
    // Instant feedback first; storage follows.
    if (exam) {
      view?.update({ selected: cid, struck: (s.struck[qid] || []).filter((c) => c !== cid) });
    } else {
      view?.update({ selected: cid, revealed: true, struck: [] });
      srLive.textContent = correct ? 'Correct.' : `Incorrect. The answer is ${letterFor(view?.getState().choiceOrder || [], q.answer)}.`;
      requestAnimationFrame(() => {
        const fb = view?.el.querySelector('.qv-feedback');
        if (fb && window.innerWidth < 1000) fb.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
      });
    }
    const before = s;
    try {
      const res = await recordAnswer(before, q, cid, ms);
      if (destroyed) return;
      adoptAnswer(qid, res.session);
      if (isFinished(res.session)) {
        // Finished elsewhere (time ran out in another tab): show the results.
        navigate(`/results/${encodeURIComponent(id)}`, { replace: true });
        return;
      }
    } catch (err) {
      console.error('[player] Could not save the answer:', err);
      // Keep the answer in memory; the next save retries.
      s = applyAnswer(s, qid, cid, correct, ms, Date.now());
      persist();
      toast("Your answer couldn't be saved yet. Free some storage space; the app will try again.", { kind: 'danger' });
    }
    if (qid === currentQid()) {
      const a = answerOf(s, qid);
      view?.update({ selected: a ? a.choice : null, struck: s.struck[qid] || [], revealed: !exam && Boolean(a) });
    }
    paintHeader();
    paintBottomBar();
    if (exam && getSetting('autoAdvance') === true && s.index < total - 1) {
      clearTimeout(advanceTimer);
      const from = s.index;
      advanceTimer = setTimeout(() => {
        if (s.index === from) goToIndex(from + 1);
      }, AUTO_ADVANCE_MS);
    }
  }

  /**
   * @param {string} qid
   * @param {string} cid
   */
  function strike(qid, cid) {
    if (destroyed || finishing) return;
    const next = toggleStrike(s, qid, cid);
    if (next === s) return;
    s = next;
    persist();
    if (qid === currentQid()) view?.update({ struck: s.struck[qid] || [] });
  }

  function toggleMarkCurrent() {
    if (!exam || destroyed || finishing) return;
    const qid = currentQid();
    const next = toggleMark(s, qid);
    if (next === s) return;
    s = next;
    persist();
    paintHeader();
    toast(s.marked[qid] ? 'Marked for review' : 'Mark removed', { duration: 1600 });
  }

  async function toggleDraw() {
    if (!view) return;
    const on = !view.isDrawing();
    await view.setDrawing(on);
    paintBottomBar();
  }

  async function highlightNow() {
    let ok = false;
    try {
      ok = await highlightSelection();
    } catch (err) {
      console.error('[player] Highlight failed:', err);
      toast("Couldn't save the highlight. Please try again.", { kind: 'danger' });
      return;
    }
    if (!ok) toast('Select some text first, then tap Highlight.', { duration: 2500 });
  }

  function openMore() {
    if (!view) {
      showShortcuts();
      return;
    }
    const q = byId.get(currentQid());
    openQuestionMenu(view, q, {
      extra: [
        { title: 'Question list', subtitle: 'Jump to any question', icon: 'grid', onClick: () => openNavigator() },
        { title: 'Keyboard shortcuts', icon: 'info', onClick: showShortcuts },
      ],
    });
  }

  /**
   * Finishes the session (confirms only when questions are unanswered).
   * @param {{ auto?: boolean }} [opts]
   */
  async function finish({ auto = false } = {}) {
    if (finishing || destroyed) return;
    commitTime();
    const left = unansweredCount(s);
    if (!auto && left > 0) {
      const ok = await confirmSheet({
        title: exam ? 'Finish the exam?' : 'Finish this quiz?',
        text: `${plural(left, 'question')} ${left === 1 ? 'is' : 'are'} still unanswered. ${
          exam ? 'Unanswered questions count as wrong.' : 'You can retry them from the results.'
        }`,
        confirmLabel: exam ? 'Finish exam' : 'Finish',
      });
      if (!ok || destroyed) {
        const first = firstUnansweredIndex(s, s.index);
        if (!ok && first >= 0 && first !== s.index && !destroyed) {
          toast(`Question ${first + 1} is unanswered.`, {
            action: { label: 'Go there', onClick: () => goToIndex(first) },
          });
        }
        return;
      }
    }
    finishing = true;
    view?.stopAudio();
    try {
      s = await completeSession(s, questions);
      writeStore(scrollKey, null);
      navigate(`/results/${encodeURIComponent(id)}`, { replace: true });
    } catch (err) {
      console.error('[player] Could not finish the session:', err);
      finishing = false;
      timeUpHandled = false;
      toast("Couldn't finish the quiz. Free some storage space and try again; your answers are safe.", {
        kind: 'danger',
        action: { label: 'Try again', onClick: () => void finish({ auto: true }) },
        duration: 0,
      });
    }
  }

  /* ---------------- navigator ---------------- */

  function openNavigator() {
    if (destroyed) return;
    /** @type {{ close: (r?: string) => Promise<void> } | null} */
    let ref = null;
    const answered = answeredCount(s);
    const markedCount = s.qids.filter((q) => s.marked[q] === true).length;
    const cells = s.qids.map((qid, i) => {
      const a = answerOf(s, qid);
      const marked = s.marked[qid] === true;
      const current = i === s.index;
      let status = a ? 'answered' : 'not answered';
      /** @type {string[]} */
      const cls = ['nav-cell'];
      if (a) cls.push('is-answered');
      if (!exam && a) {
        cls.push(a.correct ? 'is-correct' : 'is-wrong');
        status = a.correct ? 'correct' : 'incorrect';
      }
      if (marked) cls.push('is-marked');
      if (current) cls.push('is-current');
      return h(
        'button',
        {
          type: 'button',
          class: cls,
          'aria-label': `Question ${i + 1}, ${status}${marked ? ', marked' : ''}${current ? ', current' : ''}`,
          'aria-current': current ? 'true' : undefined,
          'data-autofocus': current ? '' : undefined,
          onClick: () => {
            void ref?.close('pick').then(() => goToIndex(i));
          },
        },
        h('span', { class: 'nav-num tabular' }, String(i + 1)),
        marked ? h('span', { class: 'nav-flag', 'aria-hidden': 'true' }, icon('flag', { size: 12 })) : null,
      );
    });
    const legend = h(
      'div',
      { class: 'nav-legend', 'aria-hidden': 'true' },
      exam
        ? [
            h('span', { class: 'nav-key' }, h('span', { class: 'nav-swatch is-answered' }), 'Answered'),
            h('span', { class: 'nav-key' }, h('span', { class: 'nav-swatch' }), 'Not answered'),
          ]
        : [
            h('span', { class: 'nav-key' }, h('span', { class: 'nav-swatch is-correct' }), 'Correct'),
            h('span', { class: 'nav-key' }, h('span', { class: 'nav-swatch is-wrong' }), 'Wrong'),
            h('span', { class: 'nav-key' }, h('span', { class: 'nav-swatch' }), 'Not answered'),
          ],
      exam ? h('span', { class: 'nav-key' }, h('span', { class: 'nav-swatch is-marked' }, icon('flag', { size: 10 })), 'Marked') : null,
      h('span', { class: 'nav-key' }, h('span', { class: 'nav-swatch is-current' }), 'Current'),
    );
    const summary = h(
      'p',
      { class: 'nav-summary' },
      `${answered} of ${total} answered`,
      exam && markedCount ? ` · ${markedCount} marked` : '',
      exam ? ` · ${formatDuration(remainingMs(s) ?? 0)} left` : '',
    );
    const finishBtn = button({
      label: exam ? 'Finish exam' : 'Finish and see results',
      icon: 'check',
      variant: answered === total ? 'primary' : 'secondary',
      block: true,
      onClick: () => {
        void ref?.close('finish').then(() => finish());
      },
    });
    ref = sheet({
      title: 'Questions',
      content: h('div', { class: 'nav-sheet' }, summary, h('div', { class: 'nav-grid', role: 'group', 'aria-label': 'Questions' }, cells), legend),
      actions: [finishBtn],
    });
  }

  /* ---------------- keyboard ---------------- */

  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (destroyed || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isEditable(e.target) || sheetOpen()) return;
    const key = e.key;
    if (key === 'Escape') {
      if (view?.isDrawing()) {
        e.preventDefault();
        void toggleDraw();
      }
      return;
    }
    if (view?.isDrawing() && key.toLowerCase() !== 'd') return;
    const q = byId.get(currentQid());
    const locked = !q || isFinished(s) || (!exam && Boolean(answerOf(s, currentQid())));
    const order = view?.getState().choiceOrder || [];
    const lower = key.length === 1 ? key.toLowerCase() : key;

    if (e.shiftKey && lower === 'b') {
      e.preventDefault();
      void bookmark?.toggle();
      return;
    }
    if (e.shiftKey && lower === 'd') {
      e.preventDefault();
      void toggleDraw();
      return;
    }
    if (/^[1-5]$/.test(key) || (!e.shiftKey && /^[a-e]$/.test(lower) && !(locked && (lower === 'b' || lower === 'd')))) {
      const idx = /^[1-5]$/.test(key) ? Number(key) - 1 : lower.charCodeAt(0) - 97;
      const cid = order[idx];
      if (q && cid && !locked) {
        e.preventDefault();
        void choose(q, cid);
      }
      return;
    }
    switch (lower) {
      case 'ArrowRight':
        if (/** @type {HTMLElement} */ (e.target)?.closest?.('.xb-table-wrap, [role="slider"], .segmented')) return;
        e.preventDefault();
        if (s.index < total - 1) goToIndex(s.index + 1, { focus: false });
        break;
      case 'ArrowLeft':
        if (/** @type {HTMLElement} */ (e.target)?.closest?.('.xb-table-wrap, [role="slider"], .segmented')) return;
        e.preventDefault();
        goToIndex(s.index - 1, { focus: false });
        break;
      case 'b':
        e.preventDefault();
        void bookmark?.toggle();
        break;
      case 'd':
        e.preventDefault();
        void toggleDraw();
        break;
      case 'h':
        e.preventDefault();
        void highlightNow();
        break;
      case 'm':
        if (exam) {
          e.preventDefault();
          toggleMarkCurrent();
        }
        break;
      case 'g':
        e.preventDefault();
        openNavigator();
        break;
      case '?':
        e.preventDefault();
        showShortcuts();
        break;
      default:
    }
  };
  document.addEventListener('keydown', onKey);
  offs.push(() => document.removeEventListener('keydown', onKey));

  /* ---------------- swipe (a shortcut for Prev / Next) ---------------- */

  /** @type {{ id: number, x: number, y: number, t: number } | null} */
  let swipe = null;
  stage.addEventListener(
    'pointerdown',
    (e) => {
      const t = /** @type {HTMLElement} */ (e.target);
      if (e.pointerType !== 'touch' || !e.isPrimary || view?.isDrawing()) return;
      // Choices own swipe-left (strike); tables, canvases and controls scroll or act themselves.
      if (t?.closest?.('.qv-choice-row, .xb-table-wrap, canvas, input, textarea, button, a, .voice-scrub')) return;
      swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    },
    { passive: true },
  );
  stage.addEventListener(
    'pointerup',
    (e) => {
      const sw = swipe;
      swipe = null;
      if (!sw || e.pointerId !== sw.id) return;
      const dx = e.clientX - sw.x;
      const dy = e.clientY - sw.y;
      const sel = getSelection();
      if (sel && !sel.isCollapsed) return;
      if (performance.now() - sw.t > 600 || Math.abs(dx) < 80 || Math.abs(dy) > Math.abs(dx) * 0.5) return;
      if (dx < 0 && s.index < total - 1) goToIndex(s.index + 1, { focus: false });
      else if (dx > 0) goToIndex(s.index - 1, { focus: false });
    },
    { passive: true },
  );
  stage.addEventListener('pointercancel', () => {
    swipe = null;
  });

  /* ---------------- start ---------------- */

  renderQuestion(0);
  // After the router mounted the element.
  requestAnimationFrame(() => {
    if (destroyed) return;
    restoreScroll();
    if (exam && isTimeUp(s)) void onTimeUp();
  });

  return {
    el,
    keepScroll: true,
    async destroy() {
      if (destroyed) return;
      clearTimeout(advanceTimer);
      commitTime();
      rememberScroll();
      destroyed = true;
      for (const off of offs.splice(0)) off();
      view?.destroy();
      view = null;
      bookmark?.destroy();
      setTabBarVisible(true);
      if (!finishing) {
        try {
          await saveSession(s);
          await flushSessions();
        } catch (err) {
          console.error('[player] Could not save the session on leave:', err);
        }
      }
    },
  };
}
