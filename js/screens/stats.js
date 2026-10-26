/**
 * Stats screen (`#/stats`, docs/ARCHITECTURE.md §8, §7.4).
 *
 * Overview tiles (answered, accuracy, average time, due, streak), a 30-day
 * activity chart (inline SVG: a text summary for everyone, a `<title>` per
 * bar for pointer users and a visually hidden table for screen readers),
 * accuracy by chapter, topics to work on (topics at 100% are listed apart as
 * "Strong"), and the learner's own study aids.
 *
 * States: loading (skeleton), error (plain message + Try again), empty (no
 * answer yet → one-tap Start practice) and demo mode (a calm note on top).
 * The numbers refresh in place when an answer is saved (`qstate:change`) or
 * a note/highlight/voice note changes, without losing the scroll position.
 *
 * @module screens/stats
 */

import { h, svg, clear } from '../core/dom.js';
import { bus } from '../core/events.js';
import { navigate } from '../core/router.js';
import { debounce, formatDuration, formatNumber, plural, pct } from '../core/util.js';
import { setHeader } from '../ui/shell.js';
import { button, emptyState, progressBar, chip, toast, listItem, skeleton } from '../ui/components.js';
import { computeStats } from '../features/stats.js';

/** @typedef {import('../features/stats.js').Stats} Stats */
/** @typedef {import('../features/stats.js').TopicStats} TopicStats */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHART_W = 300;
const CHART_H = 100;
const BAR_GAP = 2;
/** Wait this long after the last change before recomputing (answers come in bursts). */
const REFRESH_DELAY_MS = 400;
/** Stores whose changes alter the numbers on this screen. */
const WATCHED_STORES = new Set(['qstate', 'attempts', 'notes', 'voice', 'highlights']);

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
 * @param {Record<string, any>} options
 * @returns {Promise<void>}
 */
async function startAndOpen(options) {
  let mod;
  try {
    mod = await import('../features/quiz/start.js');
  } catch (err) {
    console.warn('[stats] Quiz starter unavailable:', err);
    toast("Couldn't start a quiz right now. Please reload the app.", { kind: 'danger' });
    return;
  }
  try {
    const id = await mod.startQuiz(options);
    navigate(`/quiz/${encodeURIComponent(id)}`);
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (!e?.userMessage) console.error('[stats] startQuiz failed:', err);
    toast(e?.userMessage || "Couldn't start the quiz. Please try again.", {
      kind: e?.name === 'NoQuestionsError' ? 'info' : 'danger',
    });
  }
}

/**
 * One overview tile (a button when it has an action).
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
    { class: 'misc-section', 'aria-labelledby': 'stats-overview-h' },
    h('h2', { class: 'visually-hidden', id: 'stats-overview-h' }, 'Overview'),
    h(
      'div',
      { class: 'stat-tiles' },
      tile({
        label: 'Answered',
        value: formatNumber(s.answeredUnique),
        sub: `of ${plural(s.totalQuestions, 'question')}`,
      }),
      tile({ label: 'Accuracy', value: `${s.correctPct}%`, sub: plural(s.attempts, 'answer') }),
      tile({ label: 'Avg time', value: s.avgMs > 0 ? formatDuration(s.avgMs) : '—', sub: 'per answer' }),
      tile({
        label: 'Due',
        value: formatNumber(due),
        sub: due > 0 ? 'Review now ›' : 'Nothing due',
        tone: due > 0 ? 'primary' : undefined,
        onClick: due > 0 ? () => void startAndOpen({ filter: 'due', mode: 'tutor' }) : undefined,
      }),
      tile({
        label: 'Streak',
        value: plural(s.streak, 'day'),
        sub: `Best: ${plural(s.bestStreak, 'day')}`,
        tone: s.streak > 0 ? 'streak' : undefined,
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
  const peak = Math.max(0, ...days.map((d) => d.n));
  const max = Math.max(1, peak);
  const slot = CHART_W / Math.max(1, days.length);
  const barW = Math.max(1, slot - BAR_GAP);

  const summaryText =
    total === 0
      ? 'No answers in the last 30 days.'
      : `${plural(total, 'answer')} on ${plural(active, 'day')}, ${pct(right, total)}% right. Today: ${plural(today?.n ?? 0, 'answer')}.`;

  const bars = days.map((d, i) => {
    const hgt = d.n > 0 ? Math.max(4, (d.n / max) * (CHART_H - 6)) : 0;
    const x = i * slot + BAR_GAP / 2;
    const tip = `${dayLabel(d.day)}: ${plural(d.n, 'answer')}${d.n ? `, ${d.correct} right` : ''}`;
    return svg(
      'g',
      { class: ['act-bar', i === days.length - 1 && 'is-today'] },
      svg('title', {}, tip),
      // Invisible full-height hit area so the tooltip works on short bars too.
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
    { class: 'misc-section misc-card', 'aria-labelledby': 'stats-act-h' },
    h(
      'div',
      { class: 'misc-section-head' },
      h('h2', { class: 'misc-h2', id: 'stats-act-h' }, 'Last 30 days'),
      peak > 0 ? h('span', { class: 'stats-peak tabular', 'aria-hidden': 'true' }, `Best day: ${formatNumber(peak)}`) : null,
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
    { class: 'misc-section', 'aria-labelledby': 'stats-ch-h' },
    h('h2', { class: 'misc-h2', id: 'stats-ch-h' }, 'Accuracy by chapter'),
    h(
      'ul',
      { class: 'list stats-chapters' },
      rows.map((c) => {
        const started = c.answered > 0;
        const detail = started
          ? `${formatNumber(c.answered)} of ${formatNumber(c.total)} answered · last answer right on ${formatNumber(c.correct)}`
          : `Not started · ${plural(c.total, 'question')}`;
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
            progressBar(started ? c.pct : 0, { label: `${c.title}: ${started ? `${c.pct}% right` : 'not started'}` }),
            h('span', { class: 'stats-chapter-detail' }, detail),
          ),
        );
      }),
    ),
  );
}

/**
 * One topic row.
 * @param {TopicStats} t
 * @param {Map<string, string>} chapterNames
 * @returns {HTMLElement}
 */
function topicRow(t, chapterNames) {
  const strong = t.pct >= 100;
  const kind = strong ? 'success' : t.pct < 50 ? 'danger' : t.pct < 75 ? 'warning' : 'neutral';
  const sub = [chapterNames.size > 1 && t.chapterId ? chapterNames.get(t.chapterId) : null, `${t.correct} of ${plural(t.n, 'answer')} right`]
    .filter(Boolean)
    .join(' · ');
  return h(
    'li',
    { class: 'stats-topic' },
    h('span', { class: 'stats-topic-text' }, h('span', { class: 'stats-topic-name' }, t.topic), h('span', { class: 'stats-topic-sub' }, sub)),
    strong ? chip('Strong', { kind: 'success', icon: 'check' }) : chip(`${t.pct}%`, { kind }),
  );
}

/**
 * Topics to work on (weakest first). Topics at 100% are never called "weak":
 * they are listed apart as "Strong", or the section says nothing is weak yet.
 * @param {Stats} s
 * @returns {HTMLElement}
 */
function weakTopics(s) {
  const rows = s.weakTopics || [];
  const names = new Map((s.byChapter || []).map((c) => [c.id, c.short || c.title]));
  const weak = rows.filter((t) => t.pct < 100);
  const strong = rows.filter((t) => t.pct >= 100);

  /** @type {Node[]} */
  const body = [];
  if (rows.length === 0) {
    body.push(h('p', { class: 'misc-note' }, 'Answer at least 3 questions on a topic to see how you do on it.'));
  } else {
    if (weak.length) body.push(h('ul', { class: 'list' }, weak.map((t) => topicRow(t, names))));
    else body.push(h('p', { class: 'misc-note is-good' }, 'Nothing weak so far: every topic you answered 3 or more times is at 100%.'));
    if (strong.length) {
      body.push(
        h('h3', { class: 'misc-h3' }, 'Strong topics'),
        h('ul', { class: 'list' }, strong.map((t) => topicRow(t, names))),
      );
    }
  }
  return h(
    'section',
    { class: 'misc-section', 'aria-labelledby': 'stats-topics-h' },
    h('h2', { class: 'misc-h2', id: 'stats-topics-h' }, 'Topics to work on'),
    ...body,
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
    { class: 'misc-section', 'aria-labelledby': 'stats-aids-h' },
    h('h2', { class: 'misc-h2', id: 'stats-aids-h' }, 'Your study aids'),
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
    { class: 'misc-banner', role: 'note' },
    h('strong', {}, 'Demo mode. '),
    'These stats count the demo questions. Real chapters appear here once they are published.',
  );
}

/**
 * The content for a stats result.
 * @param {Stats} s
 * @returns {Node[]}
 */
function content(s) {
  /** @type {Node[]} */
  const out = [];
  if (s.demoMode) out.push(demoNote());
  if (!s.attempts) {
    out.push(
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
    return out;
  }
  out.push(overview(s), activity(s));
  const chapters = byChapter(s);
  if (chapters) out.push(chapters);
  out.push(weakTopics(s), studyAids(s));
  return out;
}

/**
 * Error state with a retry.
 * @param {unknown} err
 * @param {() => void} retry
 * @returns {HTMLElement}
 */
function errorState(err, retry) {
  return emptyState({
    icon: 'alert',
    title: "Your stats couldn't load",
    text: /** @type {any} */ (err)?.userMessage || 'Please try again. Your progress is safe on this device.',
    action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: retry }),
  });
}

export default {
  /**
   * @returns {Promise<{ el: HTMLElement, destroy: () => void }>}
   */
  async render() {
    setHeader({ title: 'Stats' });
    const body = h('div', { class: 'misc-stack', 'aria-live': 'off' });
    const page = h(
      'div',
      { class: 'misc-page screen-stats' },
      h('h1', { class: 'visually-hidden', tabindex: '-1' }, 'Your stats'),
      body,
    );

    let alive = true;
    let seq = 0;

    /**
     * Computes and shows the stats. The first load replaces the skeleton;
     * later loads swap content only when they succeed (keeps what is shown).
     * @param {boolean} first
     */
    const load = async (first) => {
      const mine = ++seq;
      if (first) {
        page.setAttribute('aria-busy', 'true');
        clear(body);
        body.append(skeleton(4));
      }
      try {
        const s = await computeStats();
        if (!alive || mine !== seq) return;
        clear(body);
        body.append(...content(s));
      } catch (err) {
        if (!alive || mine !== seq) return;
        console.error('[stats] Could not compute stats:', err);
        if (first) {
          clear(body);
          body.append(errorState(err, () => void load(true)));
        }
      } finally {
        if (mine === seq) page.removeAttribute('aria-busy');
      }
    };

    const refresh = debounce(() => {
      if (alive) void load(false);
    }, REFRESH_DELAY_MS);
    const offs = [
      bus.on('qstate:change', () => refresh()),
      bus.on('store:change', (p) => {
        if (p && WATCHED_STORES.has(p.store)) refresh();
      }),
    ];

    await load(true);

    return {
      el: page,
      destroy() {
        alive = false;
        /** @type {any} */ (refresh).cancel?.();
        for (const off of offs) off();
      },
    };
  },
};
