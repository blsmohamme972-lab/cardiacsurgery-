/**
 * Home screen (`#/`, docs/ARCHITECTURE.md §8).
 *
 * Start studying within two taps of opening the app:
 * - a greeting line for the time of day;
 * - "Continue" for the latest unfinished session (title, "7 / 20", mode;
 *   one tap resumes it; a small "Discard" with Undo);
 * - "Due for review" (count; one tap starts a review);
 * - quick actions (Practice, Exam, Mistakes, Bookmarks; one tap each, with
 *   the learner's defaults) and "Build custom quiz";
 * - the **published** chapters grouped by part, each with a progress ring and
 *   counts; in demo mode a demo card explains that real chapters appear once
 *   they are published.
 *
 * Counts come from the index and the learner's records only (no question
 * file is fetched here), so Home stays instant with thousands of questions.
 * The screen refreshes itself when progress or sessions change.
 *
 * Styles: css/screen-home.css.
 *
 * @module screens/home
 */

import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { getSetting } from '../core/settings.js';
import { formatNumber, formatRelative, pct, plural } from '../core/util.js';
import { loadIndex, chapterIdFromQid } from '../core/data.js';
import { qstateRepo } from '../core/store/repo.js';
import { isDue } from '../features/srs.js';
import { answeredCount, deleteSession, latestUnfinished, restoreSession } from '../features/quiz/engine.js';
import { startAndOpen } from '../features/quiz/start.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, iconButton, progressBar, ring, toast, undoToast, chip } from '../ui/components.js';
import { setHeader } from '../ui/shell.js';

/** Refresh delay after a burst of store events. */
const REFRESH_DELAY_MS = 250;
/** Stores whose changes can alter what Home shows. */
const WATCHED_STORES = new Set(['qstate', 'sessions', 'attempts']);

/**
 * @typedef {{ answered: number, correct: number }} Progress
 * @typedef {object} HomeModel
 * @property {Awaited<ReturnType<typeof loadIndex>>} index
 * @property {any} session Latest unfinished session or null.
 * @property {Map<string, Progress>} progress Chapter id → progress.
 * @property {number} due
 * @property {number} mistakes
 * @property {number} bookmarks
 * @property {boolean} recordsFailed
 */

/**
 * Greeting for an hour of the day (0–23).
 * @param {number} hour
 * @returns {string}
 */
function greeting(hour) {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Loads everything Home needs. The index is required; records and the
 * session are best effort (Home still works without them).
 * @returns {Promise<HomeModel>}
 */
async function loadModel() {
  const [index, statesRes, sessionRes] = await Promise.all([
    loadIndex(),
    qstateRepo.all().then(
      (v) => ({ ok: true, v }),
      (err) => ({ ok: false, err }),
    ),
    latestUnfinished().then(
      (v) => ({ ok: true, v }),
      (err) => ({ ok: false, err }),
    ),
  ]);
  if (!statesRes.ok) console.warn('[home] Progress unavailable:', statesRes.err);
  if (!sessionRes.ok) console.warn('[home] Unfinished session unavailable:', sessionRes.err);

  const study = new Set(index.demoMode ? (index.demo ? [index.demo.id] : []) : index.chapters.map((c) => c.id));
  /** @type {Map<string, Progress>} */
  const progress = new Map();
  let due = 0;
  let mistakes = 0;
  let bookmarks = 0;
  const now = Date.now();
  const states = statesRes.ok && Array.isArray(statesRes.v) ? statesRes.v : [];
  for (const st of states) {
    if (!st || typeof st.qid !== 'string') continue;
    const cid = chapterIdFromQid(st.qid);
    if (!cid) continue;
    if ((st.seen ?? 0) > 0) {
      const p = progress.get(cid) ?? { answered: 0, correct: 0 };
      p.answered += 1;
      if (st.lastCorrect === true) p.correct += 1;
      progress.set(cid, p);
    }
    if (!study.has(cid)) continue;
    if (isDue(st.srs, now)) due += 1;
    if (st.lastCorrect === false) mistakes += 1;
    if (st.bookmarked === true) bookmarks += 1;
  }
  return {
    index,
    session: sessionRes.ok ? sessionRes.v : null,
    progress,
    due,
    mistakes,
    bookmarks,
    recordsFailed: !statesRes.ok,
  };
}

/**
 * "Continue" card for an unfinished session.
 * @param {any} s
 * @param {() => void} refresh
 * @returns {HTMLElement}
 */
function continueCard(s, refresh) {
  const total = Array.isArray(s.qids) ? s.qids.length : 0;
  let done = 0;
  try {
    done = answeredCount(s);
  } catch {
    done = 0;
  }
  const exam = s.mode === 'exam';
  const title = typeof s.title === 'string' && s.title ? s.title : exam ? 'Exam' : 'Practice';
  const when = formatRelative(s.updatedAt ?? s.createdAt);
  const href = `#/quiz/${encodeURIComponent(s.id)}`;

  const discard = iconButton({
    icon: 'x',
    label: 'Discard this quiz',
    onClick: async () => {
      try {
        await deleteSession(s.id);
      } catch (err) {
        console.error('[home] Could not discard the session:', err);
        toast("Couldn't discard the quiz. Please try again.", { kind: 'danger' });
        return;
      }
      refresh();
      undoToast('Quiz discarded', () => {
        restoreSession(s)
          .then(() => refresh())
          .catch((err) => {
            console.error('[home] Could not restore the session:', err);
            toast("Couldn't bring the quiz back. Please try again.", { kind: 'danger' });
          });
      });
    },
  });
  discard.classList.add('home-continue-discard');

  return h(
    'section',
    { class: 'home-card home-continue', 'aria-labelledby': 'home-continue-h' },
    h(
      'a',
      { class: 'home-continue-link', href },
      h(
        'span',
        { class: 'home-card-top' },
        h('span', { class: 'home-eyebrow', id: 'home-continue-h' }, 'Continue where you left off'),
      ),
      h('span', { class: 'home-continue-title' }, title),
      h(
        'span',
        { class: 'home-continue-meta' },
        chip(exam ? 'Exam' : 'Practice', { kind: exam ? 'warning' : 'info', icon: exam ? 'timer' : 'target' }),
        h('span', { class: 'tabular' }, `${formatNumber(done)} / ${formatNumber(total)}`),
        when ? h('span', { class: 'home-continue-when' }, `· ${when}`) : null,
      ),
      progressBar(pct(done, total), { label: `${done} of ${total} answered` }),
      h('span', { class: 'home-continue-cta' }, icon('play', { size: 18 }), h('span', {}, 'Resume')),
    ),
    discard,
  );
}

/**
 * "Due for review" card.
 * @param {number} due
 * @returns {HTMLElement}
 */
function dueCard(due) {
  const btn = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      { type: 'button', class: 'home-card home-due', 'aria-describedby': 'home-due-sub' },
      h('span', { class: 'home-due-icon', 'aria-hidden': 'true' }, icon('refresh', { size: 22 })),
      h(
        'span',
        { class: 'home-due-text' },
        h('span', { class: 'home-due-title' }, `${plural(due, 'question')} due for review`),
        h('span', { class: 'home-due-sub', id: 'home-due-sub' }, 'Review them now to remember them for longer.'),
      ),
      h('span', { class: 'home-due-cta' }, 'Start', icon('chevron-right', { size: 18 })),
    )
  );
  btn.addEventListener('click', () => void startAndOpen({ filter: 'due', mode: 'tutor' }, { trigger: btn }));
  return btn;
}

/**
 * One quick-action tile.
 * @param {{ label: string, sub: string, iconName: string, tone: string, opts: Record<string, any> }} a
 * @returns {HTMLButtonElement}
 */
function quickAction({ label, sub, iconName, tone, opts }) {
  const btn = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      { type: 'button', class: ['home-qa', `tone-${tone}`] },
      h('span', { class: 'home-qa-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 22 })),
      h('span', { class: 'home-qa-label' }, label),
      h('span', { class: 'home-qa-sub' }, sub),
    )
  );
  btn.addEventListener('click', () => void startAndOpen(opts, { trigger: btn }));
  return btn;
}

/**
 * Quick actions + "Build custom quiz".
 * @param {HomeModel} m
 * @returns {HTMLElement}
 */
function quickActions(m) {
  const n = Number(getSetting('defaultCount')) || 20;
  const secs = Number(getSetting('examSecondsPerQuestion')) || 90;
  const minutes = Math.max(1, Math.round((n * secs) / 60));
  return h(
    'section',
    { class: 'home-section', 'aria-labelledby': 'home-qa-h' },
    h('h2', { class: 'home-h2', id: 'home-qa-h' }, 'Start studying'),
    h(
      'div',
      { class: 'home-qa-grid' },
      quickAction({ label: `Practice ${n}`, sub: 'Explanation after each answer', iconName: 'target', tone: 'primary', opts: { mode: 'tutor', count: n } }),
      quickAction({ label: 'Exam', sub: `${n} questions · ${minutes} min`, iconName: 'timer', tone: 'warning', opts: { mode: 'exam', count: n } }),
      quickAction({
        label: 'Mistakes',
        sub: m.mistakes ? `${formatNumber(m.mistakes)} to redo` : 'Redo what you got wrong',
        iconName: 'x',
        tone: 'danger',
        opts: { mode: 'tutor', filter: 'incorrect' },
      }),
      quickAction({
        label: 'Bookmarks',
        sub: m.bookmarks ? `${formatNumber(m.bookmarks)} saved` : 'Questions you saved',
        iconName: 'bookmark',
        tone: 'info',
        opts: { mode: 'tutor', filter: 'bookmarked' },
      }),
    ),
    h(
      'a',
      { class: 'home-custom', href: '#/new' },
      h('span', { class: 'home-custom-icon', 'aria-hidden': 'true' }, icon('filter', { size: 20 })),
      h(
        'span',
        { class: 'home-custom-text' },
        h('span', { class: 'home-custom-title' }, 'Build custom quiz'),
        h('span', { class: 'home-custom-sub' }, 'Pick chapters, filter, number of questions and mode'),
      ),
      icon('chevron-right', { size: 18 }),
    ),
  );
}

/**
 * One chapter row (link to the chapter screen).
 * @param {any} c Chapter or demo.
 * @param {Progress | undefined} p
 * @returns {HTMLElement}
 */
function chapterRow(c, p) {
  const total = Number(c.count) || 0;
  const answered = Math.min(p?.answered ?? 0, total || Infinity);
  const value = pct(answered, total);
  const accuracy = p && p.answered > 0 ? pct(p.correct, p.answered) : null;
  const detail =
    answered > 0
      ? `${formatNumber(answered)} of ${plural(total, 'question')} · ${accuracy}% right`
      : `${plural(total, 'question')} · Not started`;
  const label = c.demo ? c.title : `${c.number}. ${c.title}`;
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'home-chapter', href: `#/chapter/${encodeURIComponent(c.id)}` },
      ring(value, { size: 44, label: `${value}% answered` }),
      h(
        'span',
        { class: 'home-chapter-text' },
        h('span', { class: 'home-chapter-title' }, label),
        h('span', { class: 'home-chapter-sub' }, detail),
      ),
      h('span', { class: 'home-chapter-chevron', 'aria-hidden': 'true' }, icon('chevron-right', { size: 18 })),
    ),
  );
}

/**
 * Published chapters grouped by part (or the demo card in demo mode).
 * @param {HomeModel} m
 * @returns {HTMLElement}
 */
function chaptersSection(m) {
  const { index } = m;
  const section = h('section', { class: 'home-section', 'aria-labelledby': 'home-ch-h' });
  if (index.demoMode) {
    section.append(h('h2', { class: 'home-h2', id: 'home-ch-h' }, 'Chapters'));
    if (index.demo) {
      section.append(
        h(
          'div',
          { class: 'home-demo' },
          h(
            'p',
            { class: 'home-demo-note' },
            h('strong', {}, 'Demo mode. '),
            'Real chapters appear here as soon as they are published. Until then, try every feature with these sample questions about using the app.',
          ),
          h('ul', { class: 'home-chapters' }, chapterRow(index.demo, m.progress.get(index.demo.id))),
        ),
      );
    } else {
      section.append(
        emptyState({ icon: 'layers', title: 'No chapters yet', text: 'Chapters appear here as soon as they are published. Check back after the next update.' }),
      );
    }
    return section;
  }

  const byId = new Map(index.chapters.map((c) => [c.id, c]));
  const total = index.chapters.reduce((a, c) => a + (Number(c.count) || 0), 0);
  section.append(
    h(
      'div',
      { class: 'home-section-head' },
      h('h2', { class: 'home-h2', id: 'home-ch-h' }, 'Chapters'),
      h('span', { class: 'home-section-meta' }, `${plural(index.chapters.length, 'chapter')} · ${plural(total, 'question')}`),
    ),
  );
  for (const part of index.parts) {
    const chapters = part.chapters.map((id) => byId.get(id)).filter(Boolean);
    if (chapters.length === 0) continue;
    const hid = `home-part-${part.id}`;
    section.append(
      h(
        'div',
        { class: 'home-part', role: 'group', 'aria-labelledby': hid },
        h('h3', { class: 'home-part-title', id: hid }, h('span', { class: 'home-part-num' }, `Part ${part.number}`), ' ', part.title),
        h('ul', { class: 'home-chapters' }, chapters.map((c) => chapterRow(c, m.progress.get(c.id)))),
      ),
    );
  }
  return section;
}

/**
 * Builds the page body from the model.
 * @param {HomeModel} m
 * @param {() => void} refresh
 * @returns {Node[]}
 */
function body(m, refresh) {
  const top = h('div', { class: 'home-top' });
  if (m.session) top.append(continueCard(m.session, refresh));
  if (m.due > 0) top.append(dueCard(m.due));
  /** @type {Node[]} */
  const out = [];
  if (m.recordsFailed) {
    out.push(
      h(
        'p',
        { class: 'home-warning', role: 'status' },
        icon('alert', { size: 18 }),
        h('span', {}, "Your progress couldn't be read just now. It is still saved on this device; reload the app to see it."),
      ),
    );
  }
  if (top.childElementCount) out.push(top);
  out.push(quickActions(m), chaptersSection(m));
  return out;
}

/** @returns {HTMLElement} */
function header() {
  const hour = new Date().getHours();
  return h(
    'div',
    { class: 'home-hello' },
    h('h1', { class: 'home-greeting', tabindex: '-1' }, greeting(hour)),
    h('p', { class: 'home-tagline' }, 'Pick up where you left off, or start something new.'),
  );
}

export default {
  /**
   * @returns {Promise<{ el: HTMLElement, destroy: () => void }>}
   */
  async render() {
    setHeader({});
    const content = h('div', { class: 'home-content' });
    const page = h('div', { class: 'screen-home' }, header(), content);

    let alive = true;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    let seq = 0;

    const draw = async () => {
      const mine = ++seq;
      try {
        const m = await loadModel();
        if (!alive || mine !== seq) return;
        content.replaceChildren(...body(m, refresh));
      } catch (err) {
        if (!alive || mine !== seq) return;
        console.error('[home] Could not load the chapters:', err);
        content.replaceChildren(
          emptyState({
            icon: 'alert',
            title: "The chapters couldn't load",
            text: /** @type {any} */ (err)?.userMessage || 'Please check your connection once and try again. Your progress is safe on this device.',
            action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => refresh() }),
          }),
        );
      }
    };
    function refresh() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (alive) void draw();
      }, REFRESH_DELAY_MS);
    }

    await draw();

    const offs = [
      bus.on('store:change', (p) => {
        if (p && WATCHED_STORES.has(p.store)) refresh();
      }),
      bus.on('qstate:change', () => refresh()),
    ];
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return {
      el: page,
      destroy() {
        alive = false;
        if (timer !== null) clearTimeout(timer);
        for (const off of offs) off();
        document.removeEventListener('visibilitychange', onVisible);
      },
    };
  },
};
