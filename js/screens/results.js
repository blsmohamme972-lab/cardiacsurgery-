/**
 * Results screen (`#/results/:id`, docs/ARCHITECTURE.md §8 "Results", §7.3).
 *
 * Score ring, correct / incorrect / unanswered counts, time, accuracy by
 * chapter and by topic, and the list of questions (each opens in browse mode
 * inside the session list, so prev/next follow the session). Actions: Retry
 * mistakes, New quiz, Home. An unfinished session shows "Continue" instead.
 * A finished exam whose grading was interrupted is graded again here
 * (completeSession is idempotent).
 *
 * @module screens/results
 */

import { h } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { formatDuration, plural, pct } from '../core/util.js';
import { getQuestions, loadIndex } from '../core/data.js';
import { icon } from '../ui/icons.js';
import { setHeader } from '../ui/shell.js';
import { button, ring, listItem, emptyState, progressBar, segmented, toast } from '../ui/components.js';
import { loadSession, summarize, isFinished, completeSession, answeredCount } from '../features/quiz/engine.js';
import { listHref } from '../features/lists.js';

/** Status → icon name and label. */
const STATUS = Object.freeze({
  correct: { icon: 'check', label: 'Correct' },
  incorrect: { icon: 'x', label: 'Incorrect' },
  unanswered: { icon: 'info', label: 'Not answered' },
});

/** Plain-text start of a stem for list rows. */
const STEM_PREVIEW = 110;

/**
 * Plain text of an inline-markup string (markers dropped), shortened.
 * @param {unknown} text
 * @returns {string}
 */
function preview(text) {
  const s = String(text ?? '')
    .replace(/[*_^~`\\]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > STEM_PREVIEW ? `${s.slice(0, STEM_PREVIEW - 1).trimEnd()}…` : s;
}

/**
 * A friendly full-screen state with a way out.
 * @param {{ icon: string, title: string, text: string, retry?: boolean }} o
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
        retry ? button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => location.reload() }) : null,
        button({ label: 'Go home', icon: 'home', variant: retry ? 'secondary' : 'primary', onClick: () => navigate('/') }),
      ),
    }),
  );
}

/**
 * One stat tile.
 * @param {string | number} value
 * @param {string} label
 * @param {string} [kind]
 * @returns {HTMLElement}
 */
function stat(value, label, kind) {
  return h(
    'div',
    { class: ['res-stat', kind ? `is-${kind}` : null].filter(Boolean) },
    h('span', { class: 'res-stat-value' }, String(value)),
    h('span', { class: 'res-stat-label' }, label),
  );
}

/**
 * Accuracy bars (by chapter or by topic).
 * @param {{ name: string, total: number, answered: number, correct: number, pct: number }[]} rows
 * @returns {HTMLElement}
 */
function bars(rows) {
  return h(
    'div',
    { class: 'res-bars' },
    rows.map((r) =>
      h(
        'div',
        { class: 'res-bar' },
        h(
          'div',
          { class: 'res-bar-top' },
          h('span', { class: 'res-bar-name' }, r.name),
          h('span', { class: 'res-bar-num' }, `${r.correct} / ${r.total} · ${r.pct}%`),
        ),
        progressBar(r.pct, { label: `${r.name}: ${r.correct} of ${r.total} correct` }),
      ),
    ),
  );
}

export default {
  /**
   * @param {{ params: Record<string, string> }} ctx
   * @returns {Promise<HTMLElement>}
   */
  async render(ctx) {
    const id = String(ctx?.params?.id ?? '');
    setHeader({ title: 'Results', back: '/' });

    let s;
    try {
      s = await loadSession(id);
    } catch (err) {
      console.error('[results] Could not load the session:', err);
      return stateView({
        icon: 'alert',
        title: "Results couldn't open",
        text: 'Your device storage could not be read. Close other apps or free some space, then try again.',
        retry: true,
      });
    }
    if (!s) {
      return stateView({ icon: 'search', title: 'Results not found', text: 'This quiz was removed. Start a new one from Home.' });
    }

    /** @type {any[]} */
    let questions = [];
    try {
      questions = await getQuestions(s.qids);
    } catch (err) {
      // The summary still works from the recorded answers.
      console.warn('[results] Could not load questions:', err);
    }
    const byId = new Map(questions.map((q) => [q.id, q]));

    // Grading was interrupted earlier (e.g. storage error): finish it now.
    if (isFinished(s) && !s.graded) {
      try {
        s = await completeSession(s, questions);
      } catch (err) {
        console.error('[results] Grading failed:', err);
        toast("Your results couldn't be saved to your statistics yet. They will be added next time.", { kind: 'danger' });
      }
    }

    const finished = isFinished(s);
    const sum = summarize(s, questions);
    const exam = s.mode === 'exam';
    const listKey = `session:${s.id}`;

    /** @type {Map<string, any>} */
    let chapterNames = new Map();
    try {
      const index = await loadIndex();
      chapterNames = new Map([...index.chapters, ...(index.demo ? [index.demo] : [])].map((c) => [c.id, c.short || c.title]));
    } catch {
      /* names fall back to ids */
    }

    setHeader({ title: finished ? 'Results' : 'Quiz progress', back: '/', subtitle: s.title });

    /* ---------- hero ---------- */
    const heading = finished
      ? sum.pct >= 80
        ? 'Excellent work'
        : sum.pct >= 60
          ? 'Good work'
          : 'Keep going'
      : 'Not finished yet';
    const mistakes = sum.items.filter((it) => it.status !== 'correct').map((it) => it.qid).filter((q) => byId.has(q));

    const actions = h('div', { class: 'res-actions' });
    if (!finished) {
      actions.append(
        button({
          label: 'Continue',
          icon: 'play',
          variant: 'primary',
          size: 'l',
          onClick: () => navigate(`/quiz/${encodeURIComponent(s.id)}`),
        }),
      );
    } else if (mistakes.length) {
      const retry = button({
        label: `Retry mistakes (${mistakes.length})`,
        icon: 'refresh',
        variant: 'primary',
        size: 'l',
        onClick: async () => {
          const { startAndOpen } = await import('../features/quiz/start.js');
          await startAndOpen(
            { qids: mistakes, mode: 'tutor', order: 'sequential', title: `Mistakes · ${s.title}` },
            { trigger: retry },
          );
        },
      });
      actions.append(retry);
    }
    actions.append(
      button({ label: 'New quiz', icon: 'plus', variant: finished && !mistakes.length ? 'primary' : 'secondary', onClick: () => navigate('/new') }),
      button({ label: 'Home', icon: 'home', variant: 'ghost', onClick: () => navigate('/') }),
    );

    const hero = h(
      'section',
      { class: 'res-hero', 'aria-label': 'Score' },
      ring(sum.pct, { size: 128, label: `Score ${sum.pct}%` }),
      h('h1', { tabindex: '-1' }, heading),
      h(
        'p',
        { class: 'res-sub' },
        `${sum.correct} of ${plural(sum.total, 'question')} correct`,
        exam ? ' · Exam' : ' · Practice',
        sum.timeMs ? ` · ${formatDuration(sum.timeMs)}` : '',
      ),
      h(
        'div',
        { class: 'res-counts' },
        stat(sum.correct, 'Correct', 'correct'),
        stat(sum.incorrect, 'Incorrect', 'wrong'),
        stat(sum.unanswered, 'Unanswered'),
        stat(sum.avgMs ? formatDuration(sum.avgMs) : '–', 'Avg / question'),
      ),
      actions,
    );

    /* ---------- by chapter / topic ---------- */
    const sections = [];
    const chapterRows = sum.byChapter.map((c) => ({
      name: chapterNames.get(c.chapterId) || c.chapterId || 'Other',
      total: c.total,
      answered: c.answered,
      correct: c.correct,
      pct: pct(c.correct, c.total),
    }));
    if (chapterRows.length > 1) {
      sections.push(h('section', { class: 'res-section' }, h('h2', null, 'By chapter'), bars(chapterRows)));
    }
    const topicRows = sum.byTopic
      .filter((t) => t.topic)
      .map((t) => ({ name: t.topic, total: t.total, answered: t.answered, correct: t.correct, pct: pct(t.correct, t.total) }))
      .sort((a, b) => a.pct - b.pct || b.total - a.total);
    if (topicRows.length > 1) {
      sections.push(h('section', { class: 'res-section' }, h('h2', null, 'By topic'), bars(topicRows.slice(0, 12))));
    }

    /* ---------- question list ---------- */
    const list = h('div', { class: 'list res-list' });
    /** @param {'all' | 'wrong'} which */
    const paintList = (which) => {
      const items = sum.items.filter((it) => which === 'all' || it.status !== 'correct');
      list.replaceChildren(
        ...items.map((it) => {
          const i = s.qids.indexOf(it.qid);
          const q = byId.get(it.qid);
          const st = STATUS[it.status] || STATUS.unanswered;
          return listItem({
            title: q ? preview(q.stem) : 'This question is no longer available',
            subtitle: `${i + 1}. ${st.label}${it.ms ? ` · ${formatDuration(it.ms)}` : ''}${it.marked ? ' · Marked' : ''}`,
            icon: h('span', { class: ['res-status', `is-${it.status}`], 'aria-hidden': 'true' }, icon(st.icon, { size: 18 })),
            href: q ? listHref(it.qid, listKey) : undefined,
          });
        }),
      );
      if (!items.length) list.append(h('p', { class: 'muted p-4 m-0' }, 'No mistakes. Every question is correct.'));
    };
    paintList('all');
    const filter =
      finished && mistakes.length && mistakes.length < sum.total
        ? segmented({
            options: [
              { value: 'all', label: `All (${sum.total})` },
              { value: 'wrong', label: `Mistakes (${mistakes.length})` },
            ],
            value: 'all',
            ariaLabel: 'Show questions',
            onChange: (v) => paintList(v),
          })
        : null;
    filter?.classList.add('res-filter');

    const listSection = finished
      ? h('section', { class: 'res-section' }, h('h2', null, 'Questions'), filter, list)
      : h(
          'section',
          { class: 'res-section' },
          h('p', { class: 'muted m-0' }, `${answeredCount(s)} of ${sum.total} answered. Continue to finish and see every answer.`),
        );

    return h('div', { class: 'results' }, hero, ...sections, listSection);
  },
};
