/**
 * Stats screen (`#/stats`, docs/ARCHITECTURE.md §8, §7.4).
 *
 * Overview tiles (answered, accuracy, average time, due — vital-sign style —
 * and the streak as a small "monitor" strip), a 30-day activity chart (inline
 * SVG drawn at its measured width: thin single-hue bars, today and the best
 * day labelled, a tooltip per day on hover, tap and arrow keys, a text
 * summary for everyone and a visually hidden table for screen readers),
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
import { clamp, debounce, formatDuration, formatNumber, plural, pct } from '../core/util.js';
import { setHeader } from '../ui/shell.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, progressBar, chip, toast, listItem, skeleton } from '../ui/components.js';
import { computeStats } from '../features/stats.js';

/** @typedef {import('../features/stats.js').Stats} Stats */
/** @typedef {import('../features/stats.js').TopicStats} TopicStats */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * Activity chart geometry (CSS px: the SVG is drawn at its measured width,
 * so the rounded bar ends stay true circles at every screen size).
 */
/** Height of the bar area. */
const PLOT_H = 112;
/** Headroom above the tallest bar for its value label. */
const LABEL_H = 22;
/** Thin bars: at most this wide… */
const BAR_MAX_W = 16;
/** …and at most this share of their day slot (the rest is air). */
const BAR_SHARE = 0.66;
/** Minimum surface gap between neighbouring bars. */
const BAR_GAP = 2;
/** Rounded data end; the baseline end stays square. */
const BAR_RADIUS = 4;
/** Shortest visible bar for a day with answers. */
const BAR_MIN_H = 3;
/** Width used until the chart is measured. */
const FALLBACK_W = 320;
/** Two cap labels closer than this (px) would collide: only today's is kept. */
const LABEL_MIN_SPACING = 30;
/** A tap that moves further than this (px) is a scroll, not a tap. */
const TAP_SLOP = 10;

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
 * Rounds to 2 decimals for compact SVG attributes.
 * @param {number} v
 * @returns {number}
 */
function r2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * A column bar: rounded data end on top, square at the baseline.
 * @param {number} x Left edge.
 * @param {number} base Baseline y.
 * @param {number} w Width.
 * @param {number} hgt Height (> 0).
 * @returns {string} SVG path data.
 */
function barPath(x, base, w, hgt) {
  const r = r2(Math.min(BAR_RADIUS, w / 2, hgt));
  const top = base - hgt;
  const [X, B, W, T] = [r2(x), r2(base), r2(x + w), r2(top)];
  return `M${X} ${B}V${r2(top + r)}A${r} ${r} 0 0 1 ${r2(x + r)} ${T}H${r2(x + w - r)}A${r} ${r} 0 0 1 ${W} ${r2(top + r)}V${B}Z`;
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
 * One overview tile, styled like a vital-sign readout: small-caps label with
 * a parameter icon, a big display number (+ unit), a quiet line below. A
 * button when it has an action.
 * @param {{ label: string, value: string, unit?: string, sub?: string, icon?: string, onClick?: () => void, tone?: string }} t
 * @returns {HTMLElement}
 */
function tile({ label, value, unit, sub, icon: iconName, onClick, tone }) {
  const content = [
    h(
      'span',
      { class: 'stat-tile-head' },
      h('span', { class: 'stat-tile-label' }, label),
      iconName ? h('span', { class: 'stat-tile-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 18 })) : null,
    ),
    h('span', { class: 'stat-tile-value num-display' }, value, unit ? h('span', { class: 'stat-tile-unit' }, unit) : null),
    sub ? h('span', { class: 'stat-tile-sub' }, sub) : null,
  ];
  if (onClick) {
    return h('button', { type: 'button', class: ['stat-tile', 'is-action', tone && `tone-${tone}`], onClick }, ...content);
  }
  return h('div', { class: ['stat-tile', tone && `tone-${tone}`] }, ...content);
}

/**
 * The streak as a small "monitor" strip: venous-navy panel, a heart that
 * beats a few times when the streak is alive, and a faint ECG trace.
 * @param {Stats} s
 * @returns {HTMLElement}
 */
function streakTile(s) {
  const alive = s.streak > 0;
  return h(
    'div',
    { class: ['stat-tile', 'stat-monitor', alive && 'tone-streak'] },
    h('span', { class: 'stat-monitor-heart', 'aria-hidden': 'true' }, icon('heart', { size: 24 })),
    h(
      'span',
      { class: 'stat-monitor-text' },
      h('span', { class: 'stat-tile-label' }, 'Streak'),
      h(
        'span',
        { class: 'stat-tile-value num-display' },
        formatNumber(s.streak),
        h('span', { class: 'stat-tile-unit' }, s.streak === 1 ? ' day' : ' days'),
      ),
    ),
    h('span', { class: 'stat-tile-sub' }, `Best: ${plural(s.bestStreak, 'day')}`),
    h('span', { class: 'stat-monitor-ecg ecg-line', 'aria-hidden': 'true' }),
  );
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
      { class: 'stat-tiles stat-tiles-overview' },
      tile({
        label: 'Answered',
        icon: 'layers',
        value: formatNumber(s.answeredUnique),
        sub: `of ${plural(s.totalQuestions, 'question')}`,
      }),
      tile({ label: 'Accuracy', icon: 'target', value: formatNumber(s.correctPct), unit: '%', sub: plural(s.attempts, 'answer') }),
      tile({ label: 'Avg time', icon: 'clock', value: s.avgMs > 0 ? formatDuration(s.avgMs) : '—', sub: 'per answer' }),
      tile({
        label: 'Due',
        icon: 'refresh',
        value: formatNumber(due),
        sub: due > 0 ? 'Review now ›' : 'Nothing due',
        tone: due > 0 ? 'primary' : undefined,
        onClick: due > 0 ? () => void startAndOpen({ filter: 'due', mode: 'tutor' }) : undefined,
      }),
      streakTile(s),
    ),
  );
}

/**
 * The interactive 30-day activity chart (one series: answers per day, so no
 * legend). Thin single-hue bars with 4px rounded data ends on a hairline
 * baseline; only today and the best day carry a value label. Every day has a
 * tooltip: hover (mouse/pen), tap (touch; tap again or elsewhere to hide) or
 * Tab + ←/→/Home/End (announced politely). The visually hidden table next to
 * it stays the screen-reader view, so the tooltip never gates a value.
 * @param {Stats['daily']} days
 * @returns {{ el: HTMLElement, destroy: () => void }}
 */
function activityChart(days) {
  const n = days.length;
  const last = n - 1;
  const peak = Math.max(0, ...days.map((d) => d.n));
  const max = Math.max(1, peak);
  // The most recent best day.
  let peakIdx = -1;
  days.forEach((d, i) => {
    if (peak > 0 && d.n === peak) peakIdx = i;
  });

  let width = FALLBACK_W;
  let active = -1;
  let hovering = false;
  /** @type {{ x: number, w: number, top: number }[]} */
  let geo = [];
  /** @type {SVGElement[]} */
  let barEls = [];
  /** @type {SVGElement | null} */
  let chartEl = null;
  /** @type {{ id: number, x: number, y: number } | null} */
  let tap = null;

  const tipValue = h('strong', { class: 'act-tip-value' });
  const tipLabel = h('span', { class: 'act-tip-label' });
  const tip = h('div', { class: 'act-tip', 'aria-hidden': 'true', hidden: true }, tipValue, tipLabel);
  const live = h('p', { class: 'visually-hidden', 'aria-live': 'polite' });
  const plot = h('div', { class: 'act-plot' });
  const wrap = h(
    'div',
    {
      class: 'act-wrap',
      tabindex: '0',
      role: 'group',
      'aria-label': 'Answers per day, last 30 days. Use the left and right arrow keys to read each day.',
    },
    plot,
    tip,
  );

  /**
   * @param {number} i
   * @returns {string}
   */
  const dayName = (i) => (i === last ? 'Today' : dayLabel(days[i].day));

  /** Draws the SVG at the current width. */
  function draw() {
    const W = Math.max(120, Math.round(width));
    const H = LABEL_H + PLOT_H;
    const base = H - 1;
    const slot = W / Math.max(1, n);
    const barW = Math.max(2, Math.min(BAR_MAX_W, slot * BAR_SHARE, slot - BAR_GAP));
    geo = days.map((d, i) => {
      const hgt = d.n > 0 ? Math.max(BAR_MIN_H, (d.n / max) * (PLOT_H - 2)) : 0;
      return { x: i * slot + (slot - barW) / 2, w: barW, top: base - hgt };
    });

    barEls = days.map((d, i) =>
      svg(
        'g',
        { class: ['act-bar', i === last && 'is-today', i === active && 'is-active'] },
        // The whole day column is the hit area (bigger than the mark).
        svg('rect', { class: 'act-hit', x: r2(i * slot), y: 0, width: r2(slot), height: base }),
        d.n > 0 ? svg('path', { class: 'act-fill', d: barPath(geo[i].x, base, geo[i].w, base - geo[i].top) }) : null,
      ),
    );

    // Selective direct labels: today and the best day (never a number on every bar).
    const labelled = [];
    if (days[last]?.n > 0) labelled.push(last);
    if (peakIdx >= 0 && peakIdx !== last && !(days[last]?.n > 0 && (last - peakIdx) * slot < LABEL_MIN_SPACING)) labelled.push(peakIdx);
    const labels = labelled.map((i) => {
      const g = geo[i];
      const cx = g.x + g.w / 2;
      const anchor = cx > W - 12 ? 'end' : cx < 12 ? 'start' : 'middle';
      const x = anchor === 'end' ? g.x + g.w : anchor === 'start' ? g.x : cx;
      return svg('text', { class: 'act-val', x: r2(x), y: r2(g.top - 7), 'text-anchor': anchor }, formatNumber(days[i].n));
    });

    chartEl = svg(
      'svg',
      {
        class: ['act-chart', active >= 0 && 'has-active'],
        viewBox: `0 0 ${W} ${H}`,
        width: W,
        height: H,
        'aria-hidden': 'true',
        focusable: 'false',
      },
      ...barEls,
      svg('line', { class: 'act-base', x1: 0, x2: W, y1: base + 0.5, y2: base + 0.5 }),
      ...labels,
    );
    plot.replaceChildren(chartEl);
    if (active >= 0) placeTip();
  }

  /** Positions the tooltip above the active day, inside the chart's width. */
  function placeTip() {
    const g = geo[active];
    if (!g || !chartEl) return;
    const scale = plot.clientWidth > 0 ? plot.clientWidth / Math.max(120, Math.round(width)) : 1;
    const cx = (g.x + g.w / 2) * scale;
    const tw = tip.offsetWidth;
    const left = clamp(cx - tw / 2, 0, Math.max(0, plot.clientWidth - tw));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(Math.min(g.top, LABEL_H + PLOT_H - 1) * scale - 6)}px`;
  }

  /** Hides the tooltip when a touch lands outside the chart. */
  const onOutside = (/** @type {PointerEvent} */ e) => {
    if (!wrap.contains(/** @type {Node} */ (e.target))) setActive(-1);
  };

  /**
   * Shows the tooltip for day `i` (-1 hides it).
   * @param {number} i
   * @param {{ announce?: boolean }} [opts] Announce politely (keyboard).
   */
  function setActive(i, { announce = false } = {}) {
    const next = i >= 0 && i < n ? i : -1;
    if (next !== active) {
      active = next;
      barEls.forEach((el, k) => el.classList.toggle('is-active', k === active));
      chartEl?.classList.toggle('has-active', active >= 0);
      document.removeEventListener('pointerdown', onOutside, true);
      if (active < 0) {
        tip.hidden = true;
      } else {
        const d = days[active];
        tipValue.textContent = d.n > 0 ? plural(d.n, 'answer') : 'No answers';
        tipLabel.textContent = d.n > 0 ? `${dayName(active)} · ${formatNumber(d.correct)} right (${pct(d.correct, d.n)}%)` : dayName(active);
        tip.hidden = false;
        placeTip();
        document.addEventListener('pointerdown', onOutside, true);
      }
    }
    if (announce && active >= 0) {
      const d = days[active];
      live.textContent = `${dayName(active)}: ${plural(d.n, 'answer')}${d.n ? `, ${formatNumber(d.correct)} right` : ''}.`;
    }
  }

  /**
   * Day index under a viewport x.
   * @param {number} clientX
   * @returns {number}
   */
  const indexAt = (clientX) => {
    const rect = plot.getBoundingClientRect();
    if (!rect.width) return -1;
    return clamp(Math.floor(((clientX - rect.left) / rect.width) * n), 0, last);
  };

  wrap.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    hovering = true;
    setActive(indexAt(e.clientX));
  });
  wrap.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'touch') return;
    hovering = false;
    if (!wrap.matches(':focus-visible')) setActive(-1);
  });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') tap = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  wrap.addEventListener('pointerup', (e) => {
    if (!tap || e.pointerId !== tap.id) return;
    const moved = Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > TAP_SLOP;
    tap = null;
    if (moved) return;
    const i = indexAt(e.clientX);
    setActive(i === active ? -1 : i);
  });
  wrap.addEventListener('pointercancel', () => {
    tap = null;
  });
  wrap.addEventListener('focus', () => {
    if (active < 0 && wrap.matches(':focus-visible')) setActive(last, { announce: true });
  });
  wrap.addEventListener('blur', () => {
    if (!hovering) setActive(-1);
  });
  wrap.addEventListener('keydown', (e) => {
    const from = active < 0 ? last : active;
    let i;
    if (e.key === 'ArrowLeft') i = from - 1;
    else if (e.key === 'ArrowRight') i = from + 1;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = last;
    else if (e.key === 'Escape' && active >= 0) i = -1;
    else return;
    e.preventDefault();
    setActive(i < 0 ? -1 : clamp(i, 0, last), { announce: true });
  });

  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
          const w = Math.round(entries[0]?.contentRect.width || 0);
          if (w > 0 && w !== Math.round(width)) {
            width = w;
            draw();
          }
        })
      : null;
  ro?.observe(plot);
  draw();

  return {
    el: h('div', { class: 'act-figure' }, wrap, live),
    destroy() {
      ro?.disconnect();
      document.removeEventListener('pointerdown', onOutside, true);
    },
  };
}

/**
 * 30-day activity: header, text summary, chart, axis and screen-reader table.
 * @param {Stats} s
 * @param {(() => void)[]} cleanups Receives the chart's teardown.
 * @returns {HTMLElement}
 */
function activity(s, cleanups) {
  const days = s.daily || [];
  const total = days.reduce((a, d) => a + d.n, 0);
  const active = days.filter((d) => d.n > 0).length;
  const right = days.reduce((a, d) => a + d.correct, 0);
  const today = days.at(-1);
  const peak = Math.max(0, ...days.map((d) => d.n));

  const summaryText =
    total === 0
      ? 'No answers in the last 30 days.'
      : `${plural(total, 'answer')} on ${plural(active, 'day')}, ${pct(right, total)}% right. Today: ${plural(today?.n ?? 0, 'answer')}.`;

  const chart = activityChart(days);
  cleanups.push(chart.destroy);

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
    { class: 'misc-section misc-card stats-activity', 'aria-labelledby': 'stats-act-h' },
    h(
      'div',
      { class: 'misc-section-head' },
      h('h2', { class: 'misc-h2', id: 'stats-act-h' }, 'Last 30 days'),
      peak > 0 ? h('span', { class: 'stats-peak tabular', 'aria-hidden': 'true' }, `Best day: ${formatNumber(peak)}`) : null,
    ),
    h('p', { class: 'stats-summary' }, summaryText),
    chart.el,
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
    { class: 'misc-section stats-half', 'aria-labelledby': 'stats-ch-h' },
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
    { class: 'misc-section stats-half', 'aria-labelledby': 'stats-topics-h' },
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
 * @param {(() => void)[]} cleanups Receives teardown functions (chart observers).
 * @returns {Node[]}
 */
function content(s, cleanups) {
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
  out.push(overview(s), activity(s, cleanups));
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
    /** @type {(() => void)[]} */
    const cleanups = [];
    const teardown = () => {
      for (const fn of cleanups.splice(0)) fn();
    };

    /**
     * Computes and shows the stats. The first load replaces the skeleton;
     * later loads swap content only when they succeed (keeps what is shown).
     * @param {boolean} first
     */
    const load = async (first) => {
      const mine = ++seq;
      if (first) {
        page.setAttribute('aria-busy', 'true');
        teardown();
        clear(body);
        body.append(skeleton(4));
      }
      try {
        const s = await computeStats();
        if (!alive || mine !== seq) return;
        teardown();
        clear(body);
        body.append(...content(s, cleanups));
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
        teardown();
      },
    };
  },
};
