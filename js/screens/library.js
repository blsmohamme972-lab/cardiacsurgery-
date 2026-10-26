/**
 * Library screen (`#/library`, docs/ARCHITECTURE.md §8, §7.13).
 *
 * Tabs: Bookmarks / Notes / Voice / Highlights / Flagged / Sessions. The
 * active tab is kept in the URL (`?tab=`), so Back and reload return to it.
 *
 * - Question tabs list `lists.getList(<kind>)`; each row opens
 *   `listHref(qid, kind)` (browse mode with prev/next through the list) and
 *   shows the question's opening words, its chapter and what the learner
 *   saved (note text, highlight quote, voice count, report reason).
 * - Sessions lists every quiz: unfinished ones resume, finished ones open
 *   their results; each can be deleted with Undo.
 * - Lists render in chunks ("Show more"), and only the questions of the shown
 *   chunk are loaded, so thousands of items stay fast.
 * - Empty tabs teach the feature in one sentence, with an action.
 * - The open tab refreshes when its store changes.
 *
 * Styles: css/screen-home.css.
 *
 * @module screens/library
 */

import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { formatDuration, formatNumber, formatRelative, pct, plural } from '../core/util.js';
import { getQuestions, studyChapters, chapterIdFromQid } from '../core/data.js';
import { highlightsRepo, notesRepo, reportsRepo, sessionsRepo, voiceRepo } from '../core/store/repo.js';
import { inlineToPlain } from '../features/explain/inline.js';
import { getList, listHref } from '../features/lists.js';
import { deleteSession, restoreSession } from '../features/quiz/engine.js';
import { startAndOpen } from '../features/quiz/start.js';
import { icon } from '../ui/icons.js';
import { button, chip, emptyState, iconButton, skeleton, toast, undoToast } from '../ui/components.js';
import { setHeader } from '../ui/shell.js';
import { navigate } from '../core/router.js';

/** Rows rendered per chunk. */
const CHUNK = 40;
const REFRESH_DELAY_MS = 300;
const SNIPPET_LEN = 140;

/**
 * @typedef {object} TabDef
 * @property {string} id
 * @property {string} label
 * @property {string} icon
 * @property {string} store The store whose changes refresh the tab.
 * @property {string} noun Singular noun for the count line.
 * @property {string} emptyTitle
 * @property {string} emptyText
 */

/** @type {readonly TabDef[]} */
const TABS = Object.freeze([
  {
    id: 'bookmarks',
    label: 'Bookmarks',
    icon: 'bookmark',
    store: 'qstate',
    noun: 'bookmark',
    emptyTitle: 'No bookmarks yet',
    emptyText: 'Tap the bookmark icon on any question to save it here for later.',
  },
  {
    id: 'notes',
    label: 'Notes',
    icon: 'note',
    store: 'notes',
    noun: 'note',
    emptyTitle: 'No notes yet',
    emptyText: 'Write a note under any question after you answer it; every note is collected here.',
  },
  {
    id: 'voice',
    label: 'Voice',
    icon: 'mic',
    store: 'voice',
    noun: 'question with voice notes',
    emptyTitle: 'No voice notes yet',
    emptyText: 'Record a short voice note on any question and play it back here, even offline.',
  },
  {
    id: 'highlights',
    label: 'Highlights',
    icon: 'highlighter',
    store: 'highlights',
    noun: 'highlighted question',
    emptyTitle: 'No highlights yet',
    emptyText: 'Select text in a question or its explanation and pick a color; highlighted questions appear here.',
  },
  {
    id: 'flagged',
    label: 'Flagged',
    icon: 'flag',
    store: 'reports',
    noun: 'flagged question',
    emptyTitle: 'Nothing flagged',
    emptyText: 'Use “Report a problem” on a question that looks wrong; it is listed here so you can find it again.',
  },
  {
    id: 'sessions',
    label: 'Sessions',
    icon: 'clock',
    store: 'sessions',
    noun: 'session',
    emptyTitle: 'No quizzes yet',
    emptyText: 'Every practice and exam you start is saved here, so you can resume it or review the results.',
  },
]);

const TAB_IDS = new Set(TABS.map((t) => t.id));

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function snippet(text, max = SNIPPET_LEN) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Per-question details for a question tab: qid → subtitle text.
 * @param {string} tab
 * @returns {Promise<Map<string, string>>}
 */
async function loadDetails(tab) {
  /** @type {Map<string, string>} */
  const out = new Map();
  if (tab === 'notes') {
    for (const n of await notesRepo.all()) if (n && typeof n.text === 'string') out.set(n.qid, snippet(n.text));
  } else if (tab === 'voice') {
    /** @type {Map<string, { n: number, ms: number }>} */
    const agg = new Map();
    for (const v of await voiceRepo.all()) {
      if (!v || typeof v.qid !== 'string') continue;
      const a = agg.get(v.qid) ?? { n: 0, ms: 0 };
      a.n += 1;
      a.ms += Number(v.durationMs) || 0;
      agg.set(v.qid, a);
    }
    for (const [qid, a] of agg) out.set(qid, `${plural(a.n, 'voice note')} · ${formatDuration(a.ms)}`);
  } else if (tab === 'highlights') {
    /** @type {Map<string, { n: number, ts: number, quote: string }>} */
    const agg = new Map();
    for (const hl of await highlightsRepo.all()) {
      if (!hl || typeof hl.qid !== 'string') continue;
      const a = agg.get(hl.qid) ?? { n: 0, ts: -Infinity, quote: '' };
      a.n += 1;
      if ((Number(hl.ts) || 0) >= a.ts) {
        a.ts = Number(hl.ts) || 0;
        a.quote = String(hl.quote ?? '');
      }
      agg.set(hl.qid, a);
    }
    for (const [qid, a] of agg) out.set(qid, a.quote ? `“${snippet(a.quote, 90)}”${a.n > 1 ? ` +${a.n - 1}` : ''}` : plural(a.n, 'highlight'));
  } else if (tab === 'flagged') {
    /** @type {Map<string, number>} */
    const latest = new Map();
    for (const r of await reportsRepo.all()) {
      if (!r || typeof r.qid !== 'string') continue;
      const ts = Number(r.ts) || 0;
      if (ts >= (latest.get(r.qid) ?? -Infinity)) {
        latest.set(r.qid, ts);
        out.set(r.qid, [r.reason, r.text ? snippet(r.text, 80) : ''].filter(Boolean).join(' · '));
      }
    }
  }
  return out;
}

/**
 * Score text of a finished session from its recorded answers.
 * @param {any} s
 * @returns {{ right: number, total: number }}
 */
function scoreOf(s) {
  const total = Array.isArray(s.qids) ? s.qids.length : 0;
  let right = 0;
  const answers = s.answers && typeof s.answers === 'object' ? s.answers : {};
  for (const qid of s.qids ?? []) if (answers[qid]?.correct === true) right += 1;
  return { right, total };
}

export default {
  /**
   * @param {{ query: Record<string, string> }} ctx
   * @returns {Promise<{ el: HTMLElement, destroy: () => void }>}
   */
  async render({ query = {} }) {
    setHeader({ title: 'Library' });
    let active = TAB_IDS.has(query.tab) ? query.tab : 'bookmarks';
    let alive = true;
    let seq = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** Rows shown in the current tab (kept across refreshes). */
    let shown = CHUNK;

    /** @type {Map<string, string>} chapter id → short name */
    let chapterNames = new Map();
    try {
      chapterNames = new Map((await studyChapters()).map((c) => [c.id, c.short || c.title]));
    } catch (err) {
      console.warn('[library] Chapter names unavailable:', err);
    }

    const panel = h('div', { class: 'lib-panel', role: 'tabpanel', id: 'lib-panel', tabindex: '-1' });
    /** @type {Map<string, HTMLButtonElement>} */
    const tabBtns = new Map();
    const tablist = h('div', { class: 'lib-tabs', role: 'tablist', 'aria-label': 'Library sections' });
    for (const t of TABS) {
      const b = /** @type {HTMLButtonElement} */ (
        h(
          'button',
          { type: 'button', class: 'lib-tab', role: 'tab', id: `lib-tab-${t.id}`, 'aria-controls': 'lib-panel' },
          icon(t.icon, { size: 18 }),
          h('span', {}, t.label),
        )
      );
      b.addEventListener('click', () => select(t.id, false));
      tabBtns.set(t.id, b);
      tablist.append(b);
    }
    tablist.addEventListener('keydown', (e) => {
      const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === active);
      let n = i;
      if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = TABS.length - 1;
      else n = (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      select(TABS[n].id, true);
    });

    const page = h('div', { class: 'screen-library' }, h('h1', { class: 'visually-hidden', tabindex: '-1' }, 'Library'), h('div', { class: 'lib-tabs-wrap' }, tablist), panel);

    /**
     * @param {string} id
     * @param {boolean} focus
     */
    function select(id, focus) {
      if (!TAB_IDS.has(id)) return;
      const changed = id !== active;
      active = id;
      if (changed) shown = CHUNK;
      paintTabs();
      const b = tabBtns.get(id);
      if (focus) b?.focus();
      b?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (changed) {
        navigate(`/library?tab=${encodeURIComponent(id)}`, { replace: true, silent: true });
        void load();
      }
    }

    function paintTabs() {
      for (const [id, b] of tabBtns) {
        const on = id === active;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      panel.setAttribute('aria-labelledby', `lib-tab-${active}`);
    }

    /** @returns {TabDef} */
    const tabDef = () => /** @type {TabDef} */ (TABS.find((t) => t.id === active));

    /** @param {TabDef} t */
    function empty(t) {
      const btn = button({ label: 'Start practice', icon: 'play', variant: 'primary' });
      btn.addEventListener('click', () => void startAndOpen({ mode: 'tutor' }, { trigger: btn }));
      return emptyState({ icon: t.icon, title: t.emptyTitle, text: t.emptyText, action: btn });
    }

    /**
     * @param {unknown} err
     * @returns {HTMLElement}
     */
    function failed(err) {
      console.error('[library] Could not load the list:', err);
      return emptyState({
        icon: 'alert',
        title: "This list couldn't load",
        text: /** @type {any} */ (err)?.userMessage || 'Please try again. Everything you saved is still on this device.',
        action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => void load() }),
      });
    }

    /**
     * @param {number} total
     * @param {string} noun
     * @returns {HTMLElement}
     */
    const countLine = (total, noun) => h('p', { class: 'lib-count', role: 'status' }, plural(total, noun));

    /**
     * "Show more" footer.
     * @param {number} total
     * @param {() => void} more
     * @returns {HTMLElement | null}
     */
    function moreButton(total, more) {
      if (shown >= total) return null;
      const left = total - shown;
      return h(
        'div',
        { class: 'lib-more' },
        button({ label: `Show ${formatNumber(Math.min(CHUNK, left))} more`, icon: 'chevron-down', variant: 'secondary', onClick: more }),
        h('span', { class: 'lib-more-sub' }, `${formatNumber(left)} not shown`),
      );
    }

    // ---------------- Question tabs ----------------

    /**
     * @param {string[]} qids
     * @param {string} key
     * @param {Map<string, string>} details
     * @returns {Promise<HTMLElement[]>}
     */
    async function questionRows(qids, key, details) {
      const qs = await getQuestions(qids);
      const byId = new Map(qs.map((q) => [q.id, q]));
      return qids.map((qid) => {
        const q = byId.get(qid);
        const cid = chapterIdFromQid(qid);
        const ch = cid ? chapterNames.get(cid) : null;
        const detail = details.get(qid);
        if (!q) {
          return h(
            'li',
            {},
            h(
              'div',
              { class: 'lib-row is-missing' },
              h('span', { class: 'lib-row-text' }, h('span', { class: 'lib-row-title' }, 'This question is no longer available'), h('span', { class: 'lib-row-sub' }, qid)),
            ),
          );
        }
        const sub = [ch, q.topic].filter(Boolean).join(' · ');
        return h(
          'li',
          {},
          h(
            'a',
            { class: 'lib-row', href: listHref(qid, key) },
            h(
              'span',
              { class: 'lib-row-text' },
              h('span', { class: 'lib-row-title clamp-2' }, snippet(inlineToPlain(q.stem), 220)),
              detail ? h('span', { class: 'lib-row-detail clamp-2' }, detail) : null,
              sub ? h('span', { class: 'lib-row-sub' }, sub) : null,
            ),
            h('span', { class: 'lib-row-chevron', 'aria-hidden': 'true' }, icon('chevron-right', { size: 18 })),
          ),
        );
      });
    }

    /**
     * @param {TabDef} t
     * @param {number} mine
     */
    async function loadQuestions(t, mine) {
      const [list, details] = await Promise.all([getList(t.id), loadDetails(t.id)]);
      if (!alive || mine !== seq) return;
      const qids = list.qids;
      if (qids.length === 0) {
        panel.replaceChildren(empty(t));
        return;
      }
      const ul = h('ul', { class: 'list lib-list' });
      const foot = h('div', {});
      const appendChunk = async (from, to) => {
        const rows = await questionRows(qids.slice(from, to), list.key, details);
        if (!alive || mine !== seq) return;
        ul.append(...rows);
      };
      await appendChunk(0, Math.min(shown, qids.length));
      if (!alive || mine !== seq) return;
      const paintFoot = () => {
        foot.replaceChildren(
          moreButton(qids.length, async () => {
            const from = shown;
            shown = Math.min(qids.length, shown + CHUNK);
            try {
              await appendChunk(from, shown);
            } catch (err) {
              shown = from;
              console.error('[library] Could not load more:', err);
              toast("Couldn't load more. Please try again.", { kind: 'danger' });
            }
            paintFoot();
          }) ?? '',
        );
      };
      paintFoot();
      panel.replaceChildren(countLine(qids.length, t.noun), ul, foot);
    }

    // ---------------- Sessions tab ----------------

    /**
     * @param {any} s
     * @returns {HTMLElement}
     */
    function sessionRow(s) {
      const finished = s.finishedAt != null;
      const exam = s.mode === 'exam';
      const total = Array.isArray(s.qids) ? s.qids.length : 0;
      const answered = Object.keys(s.answers ?? {}).filter((q) => (s.qids ?? []).includes(q)).length;
      const when = formatRelative(finished ? s.finishedAt : (s.updatedAt ?? s.createdAt));
      const title = typeof s.title === 'string' && s.title ? s.title : exam ? 'Exam' : 'Practice';
      // Name the mode only when the title doesn't already start with it.
      const modeWord = exam ? 'Exam' : 'Practice';
      const modePrefix = title.startsWith(modeWord) ? '' : `${modeWord} · `;
      let meta;
      let status;
      if (finished) {
        const { right } = scoreOf(s);
        const p = pct(right, total);
        meta = `${modePrefix}${right} / ${total} right · ${when}`;
        status = chip(`${p}%`, { kind: p >= 75 ? 'success' : p >= 50 ? 'warning' : 'danger' });
        status.classList.add('lib-score');
      } else {
        meta = `${modePrefix}${answered} / ${total} answered · ${when}`;
        status = chip('In progress', { kind: 'info', icon: 'play' });
      }
      const href = finished ? `#/results/${encodeURIComponent(s.id)}` : `#/quiz/${encodeURIComponent(s.id)}`;
      const li = h('li', { class: 'lib-session' });
      const del = iconButton({
        icon: 'trash',
        label: `Delete “${title}”`,
        onClick: async () => {
          try {
            await deleteSession(s.id);
          } catch (err) {
            console.error('[library] Could not delete the session:', err);
            toast("Couldn't delete it. Please try again.", { kind: 'danger' });
            return;
          }
          li.remove();
          undoToast('Quiz deleted', () => {
            restoreSession(s)
              .then(() => refresh())
              .catch((err) => {
                console.error('[library] Could not restore the session:', err);
                toast("Couldn't bring it back. Please try again.", { kind: 'danger' });
              });
          });
        },
      });
      li.append(
        h(
          'a',
          { class: 'lib-row', href, 'aria-label': `${title}. ${meta}. ${finished ? 'Open results' : 'Resume'}` },
          h('span', { class: ['lib-row-icon', exam ? 'is-exam' : 'is-practice'], 'aria-hidden': 'true' }, icon(exam ? 'timer' : 'target', { size: 20 })),
          h(
            'span',
            { class: 'lib-row-text' },
            h('span', { class: 'lib-row-title' }, title),
            h('span', { class: 'lib-row-sub' }, meta),
          ),
          h('span', { class: 'lib-row-status' }, status),
        ),
        del,
      );
      return li;
    }

    /**
     * @param {TabDef} t
     * @param {number} mine
     */
    async function loadSessions(t, mine) {
      const all = await sessionsRepo.all();
      if (!alive || mine !== seq) return;
      const list = (Array.isArray(all) ? all : []).filter((s) => s && typeof s.id === 'string');
      if (list.length === 0) {
        panel.replaceChildren(empty(t));
        return;
      }
      const ul = h('ul', { class: 'list lib-list' });
      const foot = h('div', {});
      ul.append(...list.slice(0, shown).map(sessionRow));
      const paintFoot = () => {
        foot.replaceChildren(
          moreButton(list.length, () => {
            const from = shown;
            shown = Math.min(list.length, shown + CHUNK);
            ul.append(...list.slice(from, shown).map(sessionRow));
            paintFoot();
          }) ?? '',
        );
      };
      paintFoot();
      panel.replaceChildren(countLine(list.length, t.noun), ul, foot);
    }

    async function load() {
      const mine = ++seq;
      const t = tabDef();
      panel.setAttribute('aria-busy', 'true');
      if (!panel.firstChild || panel.dataset.tab !== t.id) panel.replaceChildren(skeleton(4));
      panel.dataset.tab = t.id;
      try {
        if (t.id === 'sessions') await loadSessions(t, mine);
        else await loadQuestions(t, mine);
      } catch (err) {
        if (alive && mine === seq) panel.replaceChildren(failed(err));
      } finally {
        if (mine === seq) panel.removeAttribute('aria-busy');
      }
    }

    function refresh() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (alive) void load();
      }, REFRESH_DELAY_MS);
    }

    paintTabs();
    await load();
    requestAnimationFrame(() => tabBtns.get(active)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));

    const offs = [
      bus.on('store:change', (p) => {
        if (p && p.store === tabDef().store) refresh();
      }),
      bus.on('qstate:change', () => {
        if (active === 'bookmarks') refresh();
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
