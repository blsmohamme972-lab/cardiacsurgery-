/**
 * Stats screen (`#/stats`, docs/ARCHITECTURE.md §8, §7.4).
 *
 * Overview tiles (answered, accuracy, average time, due, streak), a 30-day
 * activity chart (inline SVG with a text summary and a screen-reader table),
 * accuracy by chapter, and weak topics (100% topics labelled "Strong").
 * Before the first answer it shows a friendly empty state with a Start button.
 *
 * @module screens/stats
 */

import { h, svg } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { formatDuration, formatNumber, plural, pct } from '../core/util.js';
import { setHeader } from '../ui/shell.js';
import { button, emptyState, progressBar, chip, toast, listItem } from '../ui/components.js';
import { computeStats } from '../features/stats.js';

/** @typedef {import('../features/stats.js').Stats} Stats */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHART_W = 300;
const CHART_H = 96;
const BAR_GAP = 2;

/**
 * "2026-10-26" → "26 Oct".
 * @param {string} day
 * @returns {string}
 */
function dayLabel(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
  if (!m) return day || '';
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || ''}`.trim();
}

/**
 * Starts a quiz through `quiz/start.js` (loaded on demand) and opens it.
 * Falls back to Home when the module can't load.
 * @param {Record<string, any>} options
 * @returns {Promise<void>}
 */
async function startAndOpen(options) {
  let mod;
  try {
    mod = await import('../features/quiz/start.js');
  } catch (err) {
    console.warn('[stats] Quiz starter unavailable:', err);
    navigate('/');
    return;
  }
  try {
    const id = await mod.startQuiz(options);
    navigate(`/quiz/${encodeURIComponent(id)}`);
  } catch (err) {
    const msg = /** @type {any} */ (err)?.userMessage || "Couldn't start the quiz. Please try again.";
    if (!(/** @type {any} */ (err)?.userMessage)) console.error('[stats] startQuiz failed:', err);
    toast(msg, { kind: /** @type {any} */ (err)?.name === 'NoQuestionsError' ? 'info' : 'danger' });
  }
}

/**
 * One overview tile.
 * @param {{ label: string, value: string, sub?: string, icon?: string, onClick?: () => void, tone?: string }} t
 * @returns {HTMLElement}
 */
function tile({ label, value, sub, onClick, tone }) {
  const content = [
    h('span', { class: 'stat-tile-label' }, label),
    h('span', { class: 'stat-tile-value tabular' }, value),
    sub ? h('span', { class: 'stat-tile-sub' }, sub) : null,
  ];
  if (onClick) {
    return h('button', { type: 'button', class: ['stat-tile', 'is-action', tone && `tone-${tone}`], onClick }, ...content);
  }
  return h('div', { class: ['stat-tile', tone && `tone-${tone}`] }, ...content);
}

/**
 * Overview tiles.
 * @param {Stats} s
 * @returns {HTMLElement}
 */
function overview(s) {
  const due = s.dueCount;
  return h(
    'section',
    { class: 'stats-section', 'aria-labelledby': 'stats-overview-h' },
    h('h2', { class: 'stats-h2 visually-hidden', id: 'stats-overview-h' }, 'Overview'),
    h(
      'div',
      { class: 'stat-tiles' },
      tile({
        label: 'Answered',
        value: formatNumber(s.answeredUnique),
        sub: `of ${plural(s.totalQuestions, 'question')}`,
      }),
      tile({ label: 'Accuracy', value: `${s.correctPct}%`, sub: plural(s.attempts, 'answer') }),
      tile({ label: 'Avg time', value: formatDuration(s.avgMs), sub: 'per answer' }),
      tile({
        label: 'Due',
        value: formatNumber(due),
        sub: due > 0 ? 'Review now' : 'Nothing due',
        tone: due > 0 ? 'primary' : undefined,
        onClick: due > 0 ? () => void startAndOpen({ filter: 'due', mode: 'tutor' }) : undefined,
      }),
      tile({
        label: 'Streak',
        value: plural(s.streak, 'day'),
        sub: `Best: ${plural(s.bestStreak, 'day')}`,
      }),
    ),
  );
}

/**
 * 30-day activity bars (SVG) + text summary + screen-reader table.
 * @param {Stats} s
 * @returns {HTMLElement}
 */
function activity(s) {
  const days = s.daily || [];
  const total = days.reduce((a, d) => a + d.n, 0);
  const active = days.filter((d) => d.n > 0).length;
  const right = days.reduce((a, d) => a + d.correct, 0);
  const today = days.at(-1);
  const max = Math.max(1, ...days.map((d) => d.n));
  const slot = CHART_W / Math.max(1, days.length);
  const barW = Math.max(1, slot - BAR_GAP);

  const summaryText =
    total === 0
      ? 'No answers in the last 30 days.'
      : `${plural(total, 'answer')} on ${plural(active, 'day')} in the last 30 days, ${pct(right, total)}% right. Today: ${plural(today?.n ?? 0, 'answer')}.`;

  const bars = days.map((d, i) => {
    const hgt = d.n > 0 ? Math.max(3, (d.n / max) * (CHART_H - 4)) : 0;
    const x = i * slot + BAR_GAP / 2;
    const tip = `${dayLabel(d.day)}: ${plural(d.n, 'answer')}${d.n ? `, ${d.correct} right` : ''}`;
    return svg(
      'g',
      { class: ['act-bar', i === days.length - 1 && 'is-today'] },
      svg('title', {}, tip),
      // Invisible full-height hit area so the tooltip works on tiny bars too.
      svg('rect', { class: 'act-hit', x: i * slot, y: 0, width: slot, height: CHART_H }),
      d.n > 0
        ? svg('rect', { class: 'act-fill', x, y: CHART_H - hgt, width: barW, height: hgt, rx: Math.min(2, barW / 2) })
        : svg('rect', { class: 'act-zero', x, y: CHART_H - 2, width: barW, height: 2 }),
    );
  });

  const chart = svg(
    'svg',
    {
      class: 'act-chart',
      viewBox: `0 0 ${CHART_W} ${CHART_H}`,
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    svg('line', { class: 'act-base', x1: 0, x2: CHART_W, y1: CHART_H - 0.5, y2: CHART_H - 0.5 }),
    ...bars,
  );

  const table = h(
    'table',
    { class: 'visually-hidden' },
    h('caption', {}, 'Answers per day, last 30 days'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Day'), h('th', { scope: 'col' }, 'Answers'), h('th', { scope: 'col' }, 'Right'))),
    h(
      'tbody',
      {},
      days.map((d) => h('tr', {}, h('th', { scope: 'row' }, dayLabel(d.day)), h('td', {}, String(d.n)), h('td', {}, String(d.correct)))),
    ),
  );

  return h(
    'section',
    { class: 'stats-section card-section', 'aria-labelledby': 'stats-act-h' },
    h(
      'div',
      { class: 'stats-section-head' },
      h('h2', { class: 'stats-h2', id: 'stats-act-h' }, 'Last 30 days'),
      h('span', { class: 'stats-peak tabular', 'aria-hidden': 'true' }, `Peak ${formatNumber(max === 1 && total === 0 ? 0 : max)}`),
    ),
    h('p', { class: 'stats-summary' }, summaryText),
    h('div', { class: 'act-wrap' }, chart),
    h(
      'div',
      { class: 'act-axis', 'aria-hidden': 'true' },
      h('span', {}, days[0] ? dayLabel(days[0].day) : ''),
      h('span', {}, 'Today'),
    ),
    table,
  );
}

/**
 * Accuracy by chapter.
 * @param {Stats} s
 * @returns {HTMLElement | null}
 */
function byChapter(s) {
  const rows = s.byChapter || [];
  if (rows.length === 0) return null;
  return h(
    'section',
    { class: 'stats-section', 'aria-labelledby': 'stats-ch-h' },
    h('h2', { class: 'stats-h2', id: 'stats-ch-h' }, 'Accuracy by chapter'),
    h(
      'ul',
      { class: 'list stats-chapters' },
      rows.map((c) => {
        const started = c.answered > 0;
        const detail = started ? `${c.pct}% right · ${formatNumber(c.answered)} of ${formatNumber(c.total)} answered` : `Not started · ${plural(c.total, 'question')}`;
        return h(
          'li',
          {},
          h(
            'a',
            { class: 'stats-chapter', href: `#/chapter/${encodeURIComponent(c.id)}` },
            h(
              'span',
              { class: 'stats-chapter-top' },
              h('span', { class: 'stats-chapter-name' }, c.short || c.title),
              h('span', { class: 'stats-chapter-pct tabular' }, started ? `${c.pct}%` : '—'),
            ),
            progressBar(started ? c.pct : 0, { label: `${c.title}: accuracy` }),
            h('span', { class: 'stats-chapter-detail' }, detail),
          ),
        );
      }),
    ),
  );
}

/**
 * Weak topics (weakest first). Topics at 100% are labelled "Strong".
 * @param {Stats} s
 * @returns {HTMLElement}
 */
function weakTopics(s) {
  const rows = s.weakTopics || [];
  const short = new Map((s.byChapter || []).map((c) => [c.id, c.short || c.title]));
  const body =
    rows.length === 0
      ? h('p', { class: 'stats-note' }, 'Answer at least 3 questions on a topic to see how you do on it.')
      : h(
          'ul',
          { class: 'list' },
          rows.map((t) => {
            const strong = t.pct >= 100;
            const kind = strong ? 'success' : t.pct < 50 ? 'danger' : t.pct < 75 ? 'warning' : 'neutral';
            return h(
              'li',
              { class: 'stats-topic' },
              h(
                'span',
                { class: 'stats-topic-text' },
                h('span', { class: 'stats-topic-name' }, t.topic),
                h(
                  'span',
                  { class: 'stats-topic-sub' },
                  [t.chapterId && short.get(t.chapterId), `${t.correct} of ${plural(t.n, 'answer')} right`].filter(Boolean).join(' · '),
                ),
              ),
              strong ? chip('Strong', { kind: 'success', icon: 'check' }) : chip(`${t.pct}%`, { kind }),
            );
          }),
        );
  return h(
    'section',
    { class: 'stats-section', 'aria-labelledby': 'stats-topics-h' },
    h('h2', { class: 'stats-h2', id: 'stats-topics-h' }, 'Topics to work on'),
    body,
  );
}

/**
 * Counts of the learner's own study aids, linking to the Library.
 * @param {Stats} s
 * @returns {HTMLElement}
 */
function studyAids(s) {
  return h(
    'section',
    { class: 'stats-section', 'aria-labelledby': 'stats-aids-h' },
    h('h2', { class: 'stats-h2', id: 'stats-aids-h' }, 'Your study aids'),
    h(
      'div',
      { class: 'list' },
      listItem({ title: 'Bookmarks', icon: 'bookmark', trailing: formatNumber(s.bookmarks), href: '#/library' }),
      listItem({ title: 'Notes', icon: 'note', trailing: formatNumber(s.notes), href: '#/library' }),
      listItem({ title: 'Voice notes', icon: 'mic', trailing: formatNumber(s.voice), href: '#/library' }),
      listItem({ title: 'Highlights', icon: 'highlighter', trailing: formatNumber(s.highlights), href: '#/library' }),
    ),
  );
}

/** @returns {HTMLElement} */
function demoNote() {
  return h(
    'p',
    { class: 'stats-demo-note', role: 'note' },
    h('strong', {}, 'Demo mode. '),
    'These stats count the demo questions. Real chapters appear here once they are published.',
  );
}

export default {
  /**
   * @returns {Promise<HTMLElement>}
   */
  async render() {
    setHeader({ title: 'Stats' });
    const page = h('div', { class: 'screen-stats misc-page' }, h('h1', { class: 'visually-hidden', tabindex: '-1' }, 'Your stats'));

    /** @type {Stats} */
    let s;
    try {
      s = await computeStats();
    } catch (err) {
      console.error('[stats] Could not compute stats:', err);
      page.append(
        emptyState({
          icon: 'alert',
          title: "Your stats couldn't load",
          text: /** @type {any} */ (err)?.userMessage || 'Please try again. Your progress is safe on this device.',
          action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => navigate('/stats', { replace: true }) }),
        }),
      );
      return page;
    }

    if (s.demoMode) page.append(demoNote());

    if (!s.attempts) {
      page.append(
        emptyState({
          icon: 'stats',
          title: 'Answer a few questions to see your stats',
          text: 'Your accuracy, daily streak and the topics to work on will appear here as you study.',
          action: button({
            label: 'Start practice',
            icon: 'play',
            variant: 'primary',
            size: 'l',
            onClick: () => void startAndOpen({ mode: 'tutor' }),
          }),
        }),
      );
      return page;
    }

    page.append(overview(s), activity(s));
    const chapters = byChapter(s);
    if (chapters) page.append(chapters);
    page.append(weakTopics(s), studyAids(s));
    return page;
  },
};
