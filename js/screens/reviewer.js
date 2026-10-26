/**
 * Reviewer dashboard (`#/reviewer`, docs/ARCHITECTURE.md §8, §7.11).
 *
 * For specialists who check the AI-generated questions. Shows:
 * - counts: questions marked reviewed / not yet reviewed in the data, and
 *   this device's approvals and fix requests (reviews of an older question
 *   version are counted as "to re-check");
 * - the unreviewed questions, filterable (To do / Approved / Needs fix / All),
 *   each a link to the question in browse mode;
 * - "Review in practice mode" (a quiz of unreviewed questions) and
 *   "Export review file" (to send to the owner).
 *
 * Outside reviewer mode it explains the mode and offers the switch.
 *
 * @module screens/reviewer
 */

import { h, clear } from '../core/dom.js';
import { bus } from '../core/events.js';
import { navigate } from '../core/router.js';
import { getSetting, setSetting } from '../core/settings.js';
import { debounce, formatNumber, plural, formatRelative } from '../core/util.js';
import { setHeader } from '../ui/shell.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, segmented, toggle, toast, chip, skeleton } from '../ui/components.js';

/** Rows rendered at first; "Show more" adds this many each time. */
const PAGE_SIZE = 100;
const REFRESH_DELAY_MS = 300;

/**
 * @typedef {{ qid: string, qversion: number, status: 'ok' | 'fix', comment?: string, ts: number }} Review
 * @typedef {{ id: string, version?: number, topic?: string, stem: string, reviewed?: boolean, chapterId?: string }} Question
 * @typedef {'todo' | 'ok' | 'fix' | 'all'} Filter
 */

/**
 * Plain stem start for a list row.
 * @param {string} stem
 * @param {(s: string) => string} toPlain
 * @returns {string}
 */
function stemTitle(stem, toPlain) {
  const text = toPlain(String(stem || '')).replace(/\s+/g, ' ').trim();
  return text.length > 110 ? `${text.slice(0, 108).replace(/\s+\S*$/, '')}…` : text;
}

/**
 * This device's review state of a question.
 * @param {Question} q
 * @param {Review | undefined} r
 * @returns {'todo' | 'ok' | 'fix' | 'stale'}
 */
function stateOf(q, r) {
  if (!r) return 'todo';
  if ((Number(q.version) || 1) > (Number(r.qversion) || 1)) return 'stale';
  return r.status === 'fix' ? 'fix' : 'ok';
}

/**
 * Starts a quiz of the unreviewed questions and opens it.
 * @returns {Promise<void>}
 */
async function startReviewQuiz() {
  try {
    const mod = await import('../features/quiz/start.js');
    const id = await mod.startQuiz({ filter: 'unreviewed', count: 'all', mode: 'tutor', order: 'sequential', title: 'Review · Not yet reviewed' });
    navigate(`/quiz/${encodeURIComponent(id)}`);
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (!e?.userMessage) console.error('[reviewer] startQuiz failed:', err);
    toast(e?.userMessage || "Couldn't start the review. Please try again.", { kind: e?.name === 'NoQuestionsError' ? 'info' : 'danger' });
  }
}

/**
 * Exports the review file (reviews + reports) and saves it.
 * @param {HTMLButtonElement} btn
 * @returns {Promise<void>}
 */
async function exportReviews(btn) {
  if (btn.getAttribute('aria-busy') === 'true') return;
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    const [review, backup] = await Promise.all([import('../features/review.js'), import('../features/backup.js')]);
    const res = await review.exportReviewFile();
    const how = await backup.saveFile(res.blob, res.filename);
    if (how !== 'cancelled') {
      const counts = /** @type {any} */ (res).counts;
      const what = counts ? ` (${plural(counts.reviews, 'review')}, ${plural(counts.reports, 'report')})` : '';
      toast(how === 'downloaded' ? `Review file saved as ${res.filename}${what}. Send it to the app owner.` : `Review file ready${what}.`, {
        kind: 'success',
        duration: 6000,
      });
    }
  } catch (err) {
    console.error('[reviewer] Export failed:', err);
    toast(/** @type {any} */ (err)?.userMessage || "Couldn't make the review file. Please try again.", { kind: 'danger' });
  } finally {
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

/**
 * Screen shown outside reviewer mode.
 * @returns {HTMLElement}
 */
function offState() {
  return h(
    'div',
    { class: 'misc-stack' },
    emptyState({
      icon: 'check',
      title: 'Reviewer mode is off',
      text: 'Reviewer mode is for specialists who check the questions. It adds Approve / Needs fix to every question and lets you send your review file to the app owner.',
    }),
    h(
      'div',
      { class: 'set-group rv-switch' },
      h(
        'div',
        { class: 'set-row is-toggle' },
        toggle({
          checked: false,
          label: 'Turn on reviewer mode',
          description: 'You can turn it off any time in Settings.',
          onChange: async (on) => {
            try {
              await setSetting('reviewerMode', on);
            } catch (err) {
              console.error('[reviewer] Could not turn on reviewer mode:', err);
              toast("Couldn't change reviewer mode. Please try again.", { kind: 'danger' });
              return;
            }
            if (on) navigate('/reviewer', { replace: true });
          },
        }),
      ),
    ),
  );
}

/**
 * One count tile (same vital-sign look as the Stats overview).
 * @param {string} label
 * @param {number} value
 * @param {string} [tone] success | warning | danger | neutral (tick + icon colour)
 * @param {string} [iconName]
 * @returns {HTMLElement}
 */
function countTile(label, value, tone, iconName) {
  return h(
    'div',
    { class: ['stat-tile', tone && `tone-${tone}`] },
    h(
      'span',
      { class: 'stat-tile-head' },
      h('span', { class: 'stat-tile-label' }, label),
      iconName ? h('span', { class: 'stat-tile-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 18 })) : null,
    ),
    h('span', { class: 'stat-tile-value num-display' }, formatNumber(value)),
  );
}

export default {
  /**
   * @returns {Promise<{ el: HTMLElement, destroy: () => void }>}
   */
  async render() {
    setHeader({ title: 'Reviewer', back: '/settings' });
    const body = h('div', { class: 'misc-stack' });
    const page = h(
      'div',
      { class: 'misc-page screen-reviewer' },
      h('h1', { class: 'visually-hidden', tabindex: '-1' }, 'Reviewer dashboard'),
      body,
    );

    if (getSetting('reviewerMode') !== true) {
      body.append(offState());
      return { el: page, destroy() {} };
    }

    let alive = true;
    /** @type {Filter} */
    let filter = 'todo';
    let shownCount = PAGE_SIZE;
    let seq = 0;

    const load = async (/** @type {boolean} */ first) => {
      const mine = ++seq;
      if (first) {
        clear(body);
        body.append(skeleton(5));
        page.setAttribute('aria-busy', 'true');
      }
      try {
        const [data, repo, inline, lists] = await Promise.all([
          import('../core/data.js'),
          import('../core/store/repo.js'),
          import('../features/explain/inline.js'),
          import('../features/lists.js').catch(() => null),
        ]);
        const [questions, reviews, chapters] = await Promise.all([data.loadStudyBank(), repo.reviewsRepo.all(), data.studyChapters()]);
        if (!alive || mine !== seq) return;
        draw(/** @type {Question[]} */ (questions), /** @type {Review[]} */ (reviews), chapters, inline.inlineToPlain, lists);
      } catch (err) {
        if (!alive || mine !== seq) return;
        console.error('[reviewer] Could not load:', err);
        if (!first) return;
        clear(body);
        body.append(
          emptyState({
            icon: 'alert',
            title: "The dashboard couldn't load",
            text: /** @type {any} */ (err)?.userMessage || 'Please try again. Your reviews are safe on this device.',
            action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => void load(true) }),
          }),
        );
      } finally {
        if (mine === seq) page.removeAttribute('aria-busy');
      }
    };

    /**
     * @param {Question[]} questions
     * @param {Review[]} reviews
     * @param {{ id: string, short?: string, title: string }[]} chapters
     * @param {(s: string) => string} toPlain
     * @param {any} lists
     */
    function draw(questions, reviews, chapters, toPlain, lists) {
      const byQid = new Map(reviews.map((r) => [r.qid, r]));
      const names = new Map(chapters.map((c) => [c.id, c.short || c.title]));
      const inBank = new Set(questions.map((q) => q.id));
      const reviewedInData = questions.filter((q) => q.reviewed === true).length;
      const unreviewed = questions.filter((q) => q.reviewed === false);
      const mine = reviews.filter((r) => inBank.has(r.qid));
      const states = new Map(unreviewed.map((q) => [q.id, stateOf(q, byQid.get(q.id))]));
      const approvals = mine.filter((r) => r.status === 'ok').length;
      const fixes = mine.filter((r) => r.status === 'fix').length;
      const stale = questions.filter((q) => byQid.has(q.id) && stateOf(q, byQid.get(q.id)) === 'stale').length;
      const todoCount = unreviewed.filter((q) => {
        const s = states.get(q.id);
        return s === 'todo' || s === 'stale';
      }).length;

      const listKey = lists && Array.isArray(lists.LIST_KINDS) && lists.LIST_KINDS.includes('unreviewed') ? 'unreviewed' : undefined;
      const hrefOf = (/** @type {string} */ qid) =>
        lists && typeof lists.listHref === 'function' ? lists.listHref(qid, listKey) : `#/q/${encodeURIComponent(qid)}`;

      const exportBtn = button({ label: 'Export review file', icon: 'download', variant: 'primary', onClick: () => void exportReviews(exportBtn) });
      const practiceBtn = button({ label: 'Review in practice mode', icon: 'play', variant: 'secondary', onClick: () => void startReviewQuiz() });
      practiceBtn.disabled = unreviewed.length === 0;

      const listBox = h('div', { class: 'rv-list-box' });
      const filterCtl = segmented({
        ariaLabel: 'Show',
        value: filter,
        options: [
          { value: 'todo', label: `To do ${formatNumber(todoCount)}` },
          { value: 'ok', label: 'Approved' },
          { value: 'fix', label: 'Needs fix' },
          { value: 'all', label: 'All' },
        ],
        onChange: (v) => {
          filter = v;
          shownCount = PAGE_SIZE;
          drawList();
        },
      });
      filterCtl.classList.add('rv-filter');

      function drawList() {
        clear(listBox);
        const rows = unreviewed.filter((q) => {
          const s = states.get(q.id);
          if (filter === 'all') return true;
          if (filter === 'todo') return s === 'todo' || s === 'stale';
          return s === filter;
        });
        if (rows.length === 0) {
          const text =
            unreviewed.length === 0
              ? 'Every question in the bank is marked reviewed.'
              : filter === 'todo'
                ? 'You have checked every unreviewed question on this device. Export your review file to send it.'
                : filter === 'ok'
                  ? 'No approvals yet.'
                  : 'No fix requests yet.';
          listBox.append(h('p', { class: 'misc-note is-good' }, text));
          return;
        }
        const visible = rows.slice(0, shownCount);
        listBox.append(
          h(
            'ul',
            { class: 'list rv-list' },
            visible.map((q) => {
              const s = states.get(q.id);
              const r = byQid.get(q.id);
              const badge =
                s === 'ok'
                  ? chip('Approved', { kind: 'success', icon: 'check' })
                  : s === 'fix'
                    ? chip('Needs fix', { kind: 'danger', icon: 'flag' })
                    : s === 'stale'
                      ? chip('Changed, re-check', { kind: 'warning', icon: 'refresh' })
                      : null;
              const meta = [q.chapterId ? names.get(q.chapterId) : null, q.id, q.topic, r ? formatRelative(r.ts) : null].filter(Boolean).join(' · ');
              return h(
                'li',
                {},
                h(
                  'a',
                  { class: 'rv-item', href: hrefOf(q.id) },
                  h('span', { class: 'rv-item-text' }, h('span', { class: 'rv-item-title' }, stemTitle(q.stem, toPlain)), h('span', { class: 'rv-item-meta' }, meta)),
                  badge,
                ),
              );
            }),
          ),
        );
        if (rows.length > visible.length) {
          listBox.append(
            h(
              'div',
              { class: 'rv-more' },
              button({
                label: `Show more (${formatNumber(rows.length - visible.length)} left)`,
                variant: 'secondary',
                onClick: () => {
                  shownCount += PAGE_SIZE;
                  drawList();
                },
              }),
            ),
          );
        }
      }

      clear(body);
      body.append(
        h(
          'section',
          { class: 'misc-section', 'aria-labelledby': 'rv-counts-h' },
          h('h2', { class: 'misc-h2', id: 'rv-counts-h' }, 'Progress'),
          h(
            'div',
            { class: 'stat-tiles' },
            countTile('Not yet reviewed', unreviewed.length, unreviewed.length ? 'warning' : 'neutral', 'clock'),
            countTile('Marked reviewed', reviewedInData, 'success', 'check'),
            countTile('Your approvals', approvals, approvals ? 'success' : 'neutral', 'star'),
            countTile('Your fix requests', fixes, fixes ? 'danger' : 'neutral', 'flag'),
          ),
          stale
            ? h('p', { class: 'misc-note' }, `${plural(stale, 'question')} changed after you reviewed ${stale === 1 ? 'it' : 'them'}. Please check ${stale === 1 ? 'it' : 'them'} again.`)
            : null,
          h('div', { class: 'set-actions rv-actions' }, practiceBtn, exportBtn),
          h('p', { class: 'set-hint' }, 'Your approvals and fix requests stay on this device until you export the review file and send it.'),
        ),
        h(
          'section',
          { class: 'misc-section', 'aria-labelledby': 'rv-list-h' },
          h('h2', { class: 'misc-h2', id: 'rv-list-h' }, 'Questions not yet reviewed'),
          unreviewed.length ? filterCtl : null,
          listBox,
        ),
      );
      drawList();
    }

    const refresh = debounce(() => {
      if (alive) void load(false);
    }, REFRESH_DELAY_MS);
    const offs = [
      bus.on('store:change', (p) => {
        if (p && p.store === 'reviews') refresh();
      }),
      bus.on('settings:change', (p) => {
        if (p && p.key === 'reviewerMode' && p.value !== true && alive) navigate('/reviewer', { replace: true });
      }),
    ];

    await load(true);

    return {
      el: page,
      destroy() {
        alive = false;
        refresh.cancel();
        for (const off of offs) off();
      },
    };
  },
};
