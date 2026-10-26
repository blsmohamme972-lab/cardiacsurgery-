/**
 * Chapter screen (`#/chapter/:id`, docs/ARCHITECTURE.md §8).
 *
 * Title, part, progress ring, accuracy, due and mistake counts, one-tap
 * Practice / Exam / Mistakes in this chapter, a custom quiz preset to this
 * chapter, "Browse questions" (prev/next through the chapter), and the topics
 * with their counts. An unknown or unpublished chapter shows a friendly empty
 * state (its file is never fetched). Refreshes when progress changes.
 *
 * Styles: css/screen-home.css.
 *
 * @module screens/chapter
 */

import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { getSetting } from '../core/settings.js';
import { formatNumber, pct, plural } from '../core/util.js';
import { getChapter, loadChapter, loadIndex } from '../core/data.js';
import { qstateRepo } from '../core/store/repo.js';
import { isDue } from '../features/srs.js';
import { startAndOpen } from '../features/quiz/start.js';
import { listHref } from '../features/lists.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, progressBar, ring } from '../ui/components.js';
import { setHeader } from '../ui/shell.js';
import { navigate } from '../core/router.js';

const REFRESH_DELAY_MS = 250;

/**
 * @typedef {object} TopicRow
 * @property {string} topic
 * @property {number} total
 * @property {number} answered
 * @property {number} correct
 * @property {string} firstQid
 */

/**
 * Per-chapter numbers from the questions and the learner's states.
 * @param {any[]} questions
 * @param {Map<string, any>} states
 * @param {number} now
 */
function summarize(questions, states, now) {
  let answered = 0;
  let correct = 0;
  let due = 0;
  let mistakes = 0;
  let bookmarks = 0;
  /** @type {Map<string, TopicRow>} */
  const topics = new Map();
  for (const q of questions) {
    const st = states.get(q.id);
    const seen = (st?.seen ?? 0) > 0;
    const right = seen && st.lastCorrect === true;
    if (seen) answered += 1;
    if (right) correct += 1;
    if (st && isDue(st.srs, now)) due += 1;
    if (st?.lastCorrect === false) mistakes += 1;
    if (st?.bookmarked === true) bookmarks += 1;
    const name = typeof q.topic === 'string' && q.topic.trim() ? q.topic.trim() : 'Other';
    const row = topics.get(name) ?? { topic: name, total: 0, answered: 0, correct: 0, firstQid: q.id };
    row.total += 1;
    if (seen) row.answered += 1;
    if (right) row.correct += 1;
    topics.set(name, row);
  }
  return { total: questions.length, answered, correct, due, mistakes, bookmarks, topics: [...topics.values()] };
}

/**
 * @param {string} label
 * @param {string} value
 * @param {string} [sub]
 * @returns {HTMLElement}
 */
function stat(label, value, sub) {
  return h(
    'div',
    { class: 'ch-stat' },
    h('span', { class: 'ch-stat-label' }, label),
    h('span', { class: 'ch-stat-value tabular num-display' }, value),
    sub ? h('span', { class: 'ch-stat-sub' }, sub) : null,
  );
}

/**
 * A big action button that starts a quiz.
 * @param {{ label: string, sub: string, iconName: string, variant: string, tone: string, opts: Record<string, any> }} a
 * @returns {HTMLButtonElement}
 */
function action({ label, sub, iconName, variant, tone, opts }) {
  const btn = /** @type {HTMLButtonElement} */ (
    h(
      'button',
      { type: 'button', class: ['ch-action', `ch-action-${variant}`, `tone-${tone}`] },
      h('span', { class: 'ch-action-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 22 })),
      h('span', { class: 'ch-action-text' }, h('span', { class: 'ch-action-label' }, label), h('span', { class: 'ch-action-sub' }, sub)),
    )
  );
  btn.addEventListener('click', () => void startAndOpen(opts, { trigger: btn }));
  return btn;
}

/** @returns {HTMLElement} */
function notFound() {
  setHeader({ title: 'Chapter', back: '/' });
  return h(
    'div',
    { class: 'screen-chapter' },
    h('h1', { class: 'visually-hidden', tabindex: '-1' }, 'Chapter not available'),
    emptyState({
      icon: 'layers',
      title: "This chapter isn't available yet",
      text: 'It will appear on Home as soon as it is published. Meanwhile, keep studying the chapters that are ready.',
      action: button({ label: 'Go to Home', icon: 'home', variant: 'primary', onClick: () => navigate('/') }),
    }),
  );
}

export default {
  /**
   * @param {{ params: { id?: string } }} ctx
   * @returns {Promise<HTMLElement | { el: HTMLElement, destroy: () => void }>}
   */
  async render({ params }) {
    const id = typeof params?.id === 'string' ? params.id : '';
    let chapter;
    let index;
    try {
      [chapter, index] = await Promise.all([getChapter(id), loadIndex()]);
    } catch (err) {
      console.error('[chapter] Could not load the index:', err);
      setHeader({ title: 'Chapter', back: '/' });
      return h(
        'div',
        { class: 'screen-chapter' },
        h('h1', { class: 'visually-hidden', tabindex: '-1' }, 'Chapter'),
        emptyState({
          icon: 'alert',
          title: "This chapter couldn't load",
          text: /** @type {any} */ (err)?.userMessage || 'Please try again. Your progress is safe on this device.',
          action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => navigate(`/chapter/${encodeURIComponent(id)}`, { replace: true }) }),
        }),
      );
    }
    if (!chapter) return notFound();

    const part = chapter.part ? index.parts.find((p) => p.id === chapter.part) : null;
    const partLine = chapter.demo ? 'Demo · questions about using the app' : part ? `Part ${part.number} · ${part.title}` : '';
    setHeader({ title: chapter.short || chapter.title, back: '/', subtitle: chapter.demo ? undefined : `Chapter ${chapter.number}` });

    const content = h('div', { class: 'ch-content' });
    /** Slot in the hero for the progress summary (filled once the questions load). */
    const heroStats = h('div', { class: 'ch-hero-stats' });
    const badge = chapter.demo
      ? h('span', { class: 'ch-badge is-demo', 'aria-hidden': 'true' }, icon('sparkles', { size: 22 }))
      : h('span', { class: 'ch-badge num-display', 'aria-hidden': 'true' }, part ? String(part.number) : String(chapter.number));
    const page = h(
      'div',
      { class: 'screen-chapter' },
      h(
        'div',
        { class: 'ch-hero' },
        h(
          'div',
          { class: 'ch-hero-head' },
          badge,
          h(
            'div',
            { class: 'ch-hero-text' },
            partLine ? h('p', { class: 'ch-part' }, partLine) : null,
            h('h1', { class: 'ch-title', tabindex: '-1' }, chapter.demo ? chapter.title : `${chapter.number}. ${chapter.title}`),
          ),
        ),
        heroStats,
      ),
      content,
    );

    let alive = true;
    let seq = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    const draw = async () => {
      const mine = ++seq;
      let questions;
      try {
        ({ questions } = await loadChapter(chapter.id));
      } catch (err) {
        if (!alive || mine !== seq) return;
        console.error('[chapter] Could not load the questions:', err);
        heroStats.replaceChildren();
        content.replaceChildren(
          emptyState({
            icon: 'alert',
            title: "The questions couldn't load",
            text: /** @type {any} */ (err)?.userMessage || 'Please try again. Your progress is safe on this device.',
            action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => void draw() }),
          }),
        );
        return;
      }
      /** @type {Map<string, any>} */
      let states = new Map();
      let statesFailed = false;
      try {
        const all = await qstateRepo.all();
        states = new Map((Array.isArray(all) ? all : []).filter((s) => s && typeof s.qid === 'string').map((s) => [s.qid, s]));
      } catch (err) {
        statesFailed = true;
        console.warn('[chapter] Progress unavailable:', err);
      }
      if (!alive || mine !== seq) return;
      content.replaceChildren(...view(questions, states, statesFailed));
    };

    /**
     * @param {any[]} questions
     * @param {Map<string, any>} states
     * @param {boolean} statesFailed
     * @returns {Node[]}
     */
    function view(questions, states, statesFailed) {
      const s = summarize(questions, states, Date.now());
      if (s.total === 0) {
        heroStats.replaceChildren();
        return [
          emptyState({
            icon: 'layers',
            title: 'No questions here yet',
            text: 'Questions for this chapter will appear after the next update.',
            action: button({ label: 'Go to Home', icon: 'home', variant: 'primary', onClick: () => navigate('/') }),
          }),
        ];
      }
      const progress = pct(s.answered, s.total);
      const accuracy = s.answered ? `${pct(s.correct, s.answered)}%` : '—';
      const n = Math.min(Number(getSetting('defaultCount')) || 20, s.total);
      const secs = Number(getSetting('examSecondsPerQuestion')) || 90;
      const chapters = [chapter.id];

      const summary = h(
        'section',
        { class: 'ch-summary', 'aria-label': 'Your progress' },
        h(
          'div',
          { class: 'ch-ring' },
          ring(progress, { size: 84, label: `${progress}% of the chapter answered` }),
          h('span', { class: 'ch-ring-caption' }, 'answered'),
        ),
        h(
          'div',
          { class: 'ch-stats' },
          stat('Answered', `${formatNumber(s.answered)} / ${formatNumber(s.total)}`),
          stat('Accuracy', accuracy),
          stat('Due', formatNumber(s.due)),
          stat('Mistakes', formatNumber(s.mistakes)),
        ),
      );

      const actions = h(
        'section',
        { class: 'ch-actions', 'aria-label': 'Study this chapter' },
        action({
          label: 'Practice',
          sub: `${plural(n, 'question')} · explanation after each answer`,
          iconName: 'target',
          variant: 'primary',
          tone: 'practice',
          opts: { chapters, mode: 'tutor', count: n },
        }),
        action({
          label: 'Exam',
          sub: `${plural(n, 'question')} · ${Math.max(1, Math.round((n * secs) / 60))} min, results at the end`,
          iconName: 'timer',
          variant: 'secondary',
          tone: 'exam',
          opts: { chapters, mode: 'exam', count: n },
        }),
        action({
          label: 'Mistakes in this chapter',
          sub: s.mistakes ? `${plural(s.mistakes, 'question')} to redo` : 'No mistakes yet',
          iconName: 'x',
          variant: 'secondary',
          tone: 'mistakes',
          opts: { chapters, mode: 'tutor', filter: 'incorrect', count: 'all' },
        }),
      );

      const more = h(
        'div',
        { class: 'ch-more' },
        h('a', { class: 'btn btn-ghost btn-m', href: `#/new?chapters=${encodeURIComponent(chapter.id)}` }, icon('filter', { size: 20 }), h('span', { class: 'btn-label' }, 'Custom quiz')),
        h('a', { class: 'btn btn-ghost btn-m', href: listHref(questions[0].id, `chapter:${chapter.id}`) }, icon('eye', { size: 20 }), h('span', { class: 'btn-label' }, 'Browse questions')),
      );

      const topics = h(
        'section',
        { class: 'ch-topics', 'aria-labelledby': 'ch-topics-h' },
        h('h2', { class: 'home-h2', id: 'ch-topics-h' }, `Topics (${formatNumber(s.topics.length)})`),
        h(
          'ul',
          { class: 'list ch-topic-list' },
          s.topics.map((t) =>
            h(
              'li',
              {},
              h(
                'a',
                { class: 'ch-topic', href: listHref(t.firstQid, `chapter:${chapter.id}`), 'aria-label': `${t.topic}: ${plural(t.total, 'question')}, ${t.answered} answered. Browse.` },
                h(
                  'span',
                  { class: 'ch-topic-top' },
                  h('span', { class: 'ch-topic-name' }, t.topic),
                  h('span', { class: 'ch-topic-count tabular' }, `${formatNumber(t.answered)} / ${formatNumber(t.total)}`),
                ),
                progressBar(pct(t.answered, t.total), { label: `${t.topic}: answered` }),
              ),
            ),
          ),
        ),
      );

      /** @type {Node[]} */
      const out = [];
      if (chapter.demo) {
        out.push(
          h('p', { class: 'home-demo-note', role: 'note' }, h('strong', {}, 'Demo. '), 'These sample questions show how the app works. Real chapters appear on Home once they are published.'),
        );
      }
      if (statesFailed) {
        out.push(h('p', { class: 'home-warning', role: 'status' }, icon('alert', { size: 18 }), h('span', {}, "Your progress couldn't be read just now. It is still saved; reload the app to see it.")));
      }
      heroStats.replaceChildren(summary);
      out.push(h('div', { class: 'ch-grid' }, h('div', { class: 'ch-main' }, actions, more), topics));
      return out;
    }

    function refresh() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (alive) void draw();
      }, REFRESH_DELAY_MS);
    }

    await draw();
    const offs = [
      bus.on('qstate:change', () => refresh()),
      bus.on('store:change', (p) => {
        if (p?.store === 'qstate') refresh();
      }),
    ];
    return {
      el: page,
      destroy() {
        alive = false;
        if (timer !== null) clearTimeout(timer);
        for (const off of offs) off();
      },
    };
  },
};
