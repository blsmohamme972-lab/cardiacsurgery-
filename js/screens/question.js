/**
 * Question browse screen (`#/q/:qid?list=<key>`, docs/ARCHITECTURE.md §8
 * "Question", §7.13).
 *
 * Shows one question in the answered (revealed) state with the same view as
 * the player: explanation, notes, highlights, drawing, Ask GPT, report.
 * Opened from a list (Library, Search, Results), it shows "3 / 12" and
 * Prev / Next that follow the list; without a list, just Back.
 * From a session list the user's own answer and choice order are shown.
 *
 * Keyboard: ←/→ previous/next, B bookmark, D draw, H highlight, Esc stop drawing.
 *
 * @module screens/question
 */

import { h } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { getQuestion } from '../core/data.js';
import { icon } from '../ui/icons.js';
import { setHeader, setTabBarVisible } from '../ui/shell.js';
import { button, iconButton, toast, emptyState } from '../ui/components.js';
import { listHref } from '../features/lists.js';
import { createQuestionView, createBookmarkButton, openQuestionMenu } from '../features/question-view.js';

/**
 * @param {EventTarget | null} t
 * @returns {boolean}
 */
function isEditable(t) {
  const el = /** @type {HTMLElement | null} */ (t);
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** @returns {boolean} */
function sheetOpen() {
  return Boolean(document.querySelector('#sheet-slot .sheet-root:not(.is-closing)'));
}

/**
 * The session answer state for a `session:<id>` list (choice order + answer).
 * @param {string} key
 * @param {any} q
 * @returns {Promise<{ choiceOrder?: string[], selected: string | null }>}
 */
async function sessionContext(key, q) {
  if (!key.startsWith('session:')) return { selected: null };
  try {
    const engine = await import('../features/quiz/engine.js');
    const s = await engine.loadSession(key.slice('session:'.length));
    if (!s || !s.qids.includes(q.id)) return { selected: null };
    const a = engine.answerOf(s, q.id);
    return { choiceOrder: engine.choiceOrderFor(s, q), selected: a ? a.choice : null };
  } catch (err) {
    console.warn('[question] Could not read the session:', err);
    return { selected: null };
  }
}

export default {
  /**
   * @param {{ params: Record<string, string>, query: Record<string, string> }} ctx
   * @returns {Promise<{ el: HTMLElement, destroy: () => void }>}
   */
  async render(ctx) {
    const qid = String(ctx?.params?.qid ?? '');
    const key = typeof ctx?.query?.list === 'string' ? ctx.query.list : '';
    setHeader({ title: 'Question', back: true });

    let q = null;
    try {
      q = await getQuestion(qid);
    } catch (err) {
      console.error('[question] Could not load the question:', err);
      return {
        el: h(
          'div',
          { class: 'player-state' },
          h('h1', { class: 'visually-hidden' }, "The question couldn't load"),
          emptyState({
            icon: 'alert',
            title: "The question couldn't load",
            text: /** @type {any} */ (err)?.userMessage || 'Please try again. If you are offline, open the app once with internet.',
            action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => location.reload() }),
          }),
        ),
        destroy() {},
      };
    }
    if (!q) {
      return {
        el: h(
          'div',
          { class: 'player-state' },
          h('h1', { class: 'visually-hidden' }, 'Question not found'),
          emptyState({
            icon: 'search',
            title: 'Question not found',
            text: 'It was removed or is not available yet.',
            action: button({ label: 'Go home', icon: 'home', variant: 'primary', onClick: () => navigate('/') }),
          }),
        ),
        destroy() {},
      };
    }

    // The list (for prev/next) and the session context load together.
    /** @type {{ title: string, qids: string[] } | null} */
    let list = null;
    const [listRes, sctx] = await Promise.all([
      key
        ? import('../features/lists.js')
            .then((m) => m.getList(key))
            .catch((err) => {
              console.warn('[question] Could not load the list:', err);
              return null;
            })
        : Promise.resolve(null),
      sessionContext(key, q),
    ]);
    if (listRes && Array.isArray(listRes.qids) && listRes.qids.includes(qid)) list = listRes;
    const pos = list ? list.qids.indexOf(qid) : -1;
    const total = list ? list.qids.length : 0;

    setTabBarVisible(false);
    let destroyed = false;
    /** @type {(() => void)[]} */
    const offs = [];

    const view = createQuestionView(q, {
      mode: 'browse',
      choiceOrder: sctx.choiceOrder,
      selected: sctx.selected,
      struck: [],
      revealed: true,
      onDrawingChange: () => paintBar(),
    });

    const bookmark = createBookmarkButton(qid);
    const moreBtn = iconButton({ icon: 'more', label: 'More', onClick: () => openQuestionMenu(view, q) });
    setHeader({
      title: list ? `${pos + 1} / ${total}` : 'Question',
      subtitle: list ? list.title : undefined,
      back: true,
      actions: [bookmark, moreBtn],
    });

    /** @param {number} delta */
    const go = (delta) => {
      if (!list) return;
      const i = pos + delta;
      if (i < 0 || i >= total) return;
      // listHref gives '#/q/<qid>?list=<key>'; the router takes the part after '#'.
      navigate(listHref(list.qids[i], key).slice(1), { replace: true });
    };

    const prevBtn = button({ label: 'Prev', icon: 'chevron-left', variant: 'ghost', onClick: () => go(-1) });
    prevBtn.classList.add('pbar-prev');
    const drawBtn = button({ label: 'Draw', icon: 'pen', variant: 'ghost', onClick: () => void toggleDraw() });
    drawBtn.classList.add('pbar-tool');
    const hlBtn = button({ label: 'Highlight', icon: 'highlighter', variant: 'ghost', onClick: () => void highlightNow() });
    hlBtn.classList.add('pbar-tool');
    hlBtn.addEventListener('pointerdown', (e) => e.preventDefault());
    hlBtn.addEventListener('mousedown', (e) => e.preventDefault());
    const nextBtn = /** @type {HTMLButtonElement} */ (
      h(
        'button',
        { type: 'button', class: 'btn btn-m btn-primary pbar-next', onClick: () => go(1) },
        h('span', { class: 'btn-label' }, 'Next'),
        h('span', { class: 'pbar-next-icon', 'aria-hidden': 'true' }, icon('chevron-right', { size: 20 })),
      )
    );
    prevBtn.disabled = !list || pos <= 0;
    nextBtn.disabled = !list || pos >= total - 1;
    if (!list) {
      prevBtn.hidden = true;
      nextBtn.hidden = true;
    }

    const pbar = h(
      'nav',
      { class: 'pbar', 'aria-label': 'Question navigation' },
      h('div', { class: 'pbar-inner' }, prevBtn, h('div', { class: 'pbar-tools' }, drawBtn, hlBtn), nextBtn),
    );
    const el = h(
      'div',
      { class: 'qscreen', dataset: { qid } },
      h('h1', { class: 'visually-hidden', tabindex: '-1' }, list ? `Question ${pos + 1} of ${total}` : `Question ${qid}`),
      view.el,
      pbar,
    );

    function paintBar() {
      const on = view.isDrawing();
      drawBtn.setAttribute('aria-pressed', String(on));
      drawBtn.classList.toggle('is-on', on);
      el.classList.toggle('is-drawing', on);
    }
    paintBar();

    async function toggleDraw() {
      await view.setDrawing(!view.isDrawing());
      paintBar();
    }

    async function highlightNow() {
      try {
        const { highlightSelection } = await import('../features/annotate/highlight.js');
        if (!(await highlightSelection())) toast('Select some text first, then tap Highlight.', { duration: 2500 });
      } catch (err) {
        console.error('[question] Highlight failed:', err);
        toast("Couldn't save the highlight. Please try again.", { kind: 'danger' });
      }
    }

    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (destroyed || e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target) || sheetOpen()) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === 'Escape') {
        if (view.isDrawing()) {
          e.preventDefault();
          void toggleDraw();
        }
        return;
      }
      if (view.isDrawing() && k !== 'd') return;
      const inScroller = /** @type {HTMLElement} */ (e.target)?.closest?.('.xb-table-wrap, [role="slider"], .segmented');
      if (k === 'ArrowRight' && !inScroller) {
        e.preventDefault();
        go(1);
      } else if (k === 'ArrowLeft' && !inScroller) {
        e.preventDefault();
        go(-1);
      } else if (k === 'b') {
        e.preventDefault();
        void bookmark.toggle();
      } else if (k === 'd') {
        e.preventDefault();
        void toggleDraw();
      } else if (k === 'h') {
        e.preventDefault();
        void highlightNow();
      }
    };
    document.addEventListener('keydown', onKey);
    offs.push(() => document.removeEventListener('keydown', onKey));

    const onHidden = () => {
      if (document.visibilityState === 'hidden') view.stopAudio();
    };
    document.addEventListener('visibilitychange', onHidden);
    offs.push(() => document.removeEventListener('visibilitychange', onHidden));

    return {
      el,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const off of offs.splice(0)) off();
        view.destroy();
        bookmark.destroy();
        setTabBarVisible(true);
      },
    };
  },
};
