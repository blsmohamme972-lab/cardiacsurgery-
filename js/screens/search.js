/**
 * Search screen (`#/search?q=…`, docs/ARCHITECTURE.md §8, §7.5).
 *
 * - A big search field that has focus on open (`autofocus`; the router
 *   focuses it instead of the heading).
 * - Instant results as you type (debounced 150 ms); the query is mirrored
 *   into the address bar with `replace` (never a new history entry per key),
 *   so Back leaves the screen and a reload shows the same results.
 * - Each result is a real link to `#/q/<qid>?list=search:<q>`, so the
 *   question screen can step through the results with prev/next.
 * - Matches in the snippet are `<mark>`ed from the search module's segments.
 * - Enter opens the first result; Escape clears the field.
 * - The index is prepared when the screen opens; a spinner shows only when
 *   that takes a moment (the first time).
 * - Empty field → tips and topic suggestions; no results → tips.
 *
 * @module screens/search
 */

import { h, clear } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { debounce, formatNumber, plural } from '../core/util.js';
import { setHeader } from '../ui/shell.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, iconButton, spinner } from '../ui/components.js';
import { search, prepareSearchIndex } from '../features/search.js';
import { listHref, searchListKey } from '../features/lists.js';

/** Typing pause before searching (ms). */
const DEBOUNCE_MS = 150;
/** Results shown at most; one extra is fetched to know there are more. */
const SHOW_LIMIT = 100;
/** Don't flash a spinner for an index that is ready almost at once. */
const SPINNER_DELAY_MS = 150;
/** Topic suggestions shown under an empty field. */
const MAX_SUGGESTIONS = 8;

/**
 * @typedef {{ qid: string, chapterId: string | null, title: string,
 *   snippet: { text: string, match: boolean }[], score: number }} SearchResult
 */

/**
 * Chapter id → short label, plus a few topic suggestions, from the study bank.
 * Never throws (the screen works without them).
 * @returns {Promise<{ names: Map<string, string>, topics: string[] }>}
 */
async function loadBankInfo() {
  /** @type {Map<string, string>} */
  const names = new Map();
  /** @type {string[]} */
  const topics = [];
  try {
    const data = await import('../core/data.js');
    const [chapters, questions] = await Promise.all([data.studyChapters(), data.loadStudyBank()]);
    for (const c of chapters) names.set(c.id, c.short || c.title);
    const counts = new Map();
    for (const q of questions) {
      const t = typeof q.topic === 'string' ? q.topic.trim() : '';
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
    topics.push(
      ...[...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_SUGGESTIONS)
        .map(([t]) => t),
    );
  } catch (err) {
    console.warn('[search] Chapter names unavailable:', err);
  }
  return { names, topics };
}

/**
 * Snippet segments → text with `<mark>` around matches.
 * @param {{ text: string, match: boolean }[]} snippet
 * @returns {Node[]}
 */
function snippetNodes(snippet) {
  return (Array.isArray(snippet) ? snippet : []).map((seg) =>
    seg && seg.match ? h('mark', { class: 'search-mark' }, String(seg.text)) : document.createTextNode(String(seg?.text ?? '')),
  );
}

/**
 * The search badge with its faint heartbeat trace (same look as `emptyState()`).
 * @returns {HTMLElement}
 */
function introBadge() {
  return h(
    'div',
    { class: 'empty-icon', 'aria-hidden': 'true' },
    icon('search', { size: 28 }),
    h('span', { class: 'empty-ecg' }, h('span', { class: 'ecg-line' })),
  );
}

/**
 * Tips shown under an empty field or when nothing matches.
 * @returns {HTMLElement}
 */
function tipsList() {
  return h(
    'ul',
    { class: 'search-tips' },
    h('li', {}, 'Searches question text, answer choices, explanations, topics and tags.'),
    h('li', {}, 'Every word must match. Fewer words find more.'),
    h('li', {}, 'The last word can be the start of a word: “brea” finds “breathing”.'),
  );
}

export default {
  /**
   * @param {{ query?: Record<string, string>, signal?: AbortSignal }} ctx
   * @returns {{ el: HTMLElement, destroy: () => void }}
   */
  render(ctx) {
    setHeader({ title: 'Search' });
    const initial = typeof ctx?.query?.q === 'string' ? ctx.query.q : '';

    let alive = true;
    let seq = 0;
    let ready = false;
    /** @type {SearchResult[]} */
    let shown = [];
    /** @type {{ names: Map<string, string>, topics: string[] }} */
    let bank = { names: new Map(), topics: [] };

    const input = /** @type {HTMLInputElement} */ (
      h('input', {
        type: 'search',
        id: 'search-input',
        class: 'search-input',
        placeholder: 'Search questions',
        autocomplete: 'off',
        autocapitalize: 'off',
        spellcheck: false,
        enterkeyhint: 'search',
        autofocus: true,
        'aria-describedby': 'search-status',
        'aria-controls': 'search-results',
        value: initial,
      })
    );
    const clearBtn = iconButton({
      icon: 'close',
      label: 'Clear search',
      onClick: () => {
        input.value = '';
        onInput();
        input.focus();
      },
    });
    clearBtn.classList.add('search-clear');
    clearBtn.hidden = initial.trim() === '';

    const status = h('p', { class: 'search-status', id: 'search-status', role: 'status', 'aria-live': 'polite' });
    const results = h('div', { class: 'search-results', id: 'search-results' });

    const form = h(
      'form',
      {
        class: 'search-form',
        role: 'search',
        onSubmit: (/** @type {Event} */ e) => {
          e.preventDefault();
          openFirst();
        },
      },
      h('label', { class: 'visually-hidden', for: 'search-input' }, 'Search questions'),
      h('span', { class: 'search-icon', 'aria-hidden': 'true' }, icon('search', { size: 22 })),
      input,
      clearBtn,
    );

    const page = h(
      'div',
      { class: 'misc-page screen-search' },
      h('h1', { class: 'visually-hidden', tabindex: '-1' }, 'Search'),
      form,
      status,
      results,
    );

    /** Opens the first result (Enter). */
    function openFirst() {
      const q = input.value.trim();
      if (!q) return;
      run.flush();
      if (shown.length > 0) navigate(listHref(shown[0].qid, searchListKey(q)));
    }

    /** Keeps `?q=` in the address bar in step with the field, without history entries. */
    function syncUrl() {
      const q = input.value.trim();
      navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search', { replace: true, silent: true });
    }

    /** Empty field: tips + topic suggestions. */
    function showIntro() {
      clear(results);
      status.textContent = '';
      const suggestions = bank.topics.length
        ? h(
            'div',
            { class: 'search-suggest' },
            h('h2', { class: 'misc-h3' }, 'Try a topic'),
            h(
              'div',
              { class: 'search-chips' },
              bank.topics.map((t) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'search-chip',
                    onClick: () => {
                      input.value = t;
                      onInput();
                      run.flush();
                    },
                  },
                  t,
                ),
              ),
            ),
          )
        : null;
      results.append(
        h(
          'div',
          { class: 'search-intro' },
          introBadge(),
          h('h2', { class: 'empty-title' }, 'Find any question'),
          tipsList(),
          suggestions,
        ),
      );
    }

    /**
     * @param {string} q
     * @param {SearchResult[]} list
     * @param {boolean} more
     */
    function showResults(q, list, more) {
      shown = list;
      clear(results);
      if (list.length === 0) {
        status.textContent = `No results for “${q}”.`;
        results.append(
          h(
            'div',
            { class: 'search-intro' },
            introBadge(),
            h('h2', { class: 'empty-title' }, 'No questions match'),
            h('p', { class: 'empty-text' }, 'Check the spelling, or try fewer or shorter words.'),
            tipsList(),
          ),
        );
        return;
      }
      status.textContent = more
        ? `Top ${formatNumber(list.length)} results. Add a word to narrow them down.`
        : `${plural(list.length, 'result')}. Press Enter to open the first.`;
      const key = searchListKey(q);
      results.append(
        h(
          'ol',
          { class: 'list search-list' },
          list.map((r) => {
            const chapter = r.chapterId ? bank.names.get(r.chapterId) : null;
            return h(
              'li',
              {},
              h(
                'a',
                { class: 'search-hit', href: listHref(r.qid, key) },
                h('span', { class: 'search-hit-title' }, r.title),
                r.snippet && r.snippet.length ? h('span', { class: 'search-hit-snippet' }, ...snippetNodes(r.snippet)) : null,
                h('span', { class: 'search-hit-meta' }, [chapter, r.qid].filter(Boolean).join(' · ')),
              ),
            );
          }),
        ),
      );
    }

    /**
     * @param {unknown} err
     */
    function showError(err) {
      shown = [];
      clear(results);
      status.textContent = '';
      console.error('[search] Search failed:', err);
      results.append(
        emptyState({
          icon: 'alert',
          title: "Search isn't available right now",
          text: /** @type {any} */ (err)?.userMessage || /** @type {any} */ (err)?.message || 'The questions could not be loaded. Please try again.',
          action: button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => void prepare() }),
        }),
      );
    }

    /** Runs the current query (latest call wins). */
    async function runNow() {
      const q = input.value.trim();
      const mine = ++seq;
      if (!q) {
        shown = [];
        showIntro();
        return;
      }
      if (!ready) return; // prepare() runs the query once the index is ready
      try {
        const list = await search(q, { limit: SHOW_LIMIT + 1 });
        if (!alive || mine !== seq) return;
        showResults(q, list.slice(0, SHOW_LIMIT), list.length > SHOW_LIMIT);
      } catch (err) {
        if (!alive || mine !== seq) return;
        showError(err);
      }
    }
    const run = debounce(() => void runNow(), DEBOUNCE_MS);

    function onInput() {
      clearBtn.hidden = input.value.trim() === '';
      syncUrl();
      run();
    }

    input.addEventListener('input', onInput);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value !== '') {
        e.preventDefault();
        input.value = '';
        onInput();
        run.flush();
      } else if (e.key === 'ArrowDown') {
        const first = /** @type {HTMLElement | null} */ (results.querySelector('a.search-hit'));
        if (first) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    // Arrow keys move between results; Escape goes back to the field.
    results.addEventListener('keydown', (e) => {
      const links = /** @type {HTMLElement[]} */ ([...results.querySelectorAll('a.search-hit')]);
      const i = links.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (i === -1) return;
      if (e.key === 'ArrowDown' && i < links.length - 1) {
        e.preventDefault();
        links[i + 1].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (i === 0 ? input : links[i - 1]).focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.focus();
      }
    });

    /** Builds the index (spinner only when it takes a moment), then searches. */
    async function prepare() {
      ready = false;
      const timer = setTimeout(() => {
        if (!alive || ready) return;
        clear(results);
        status.textContent = '';
        results.append(h('div', { class: 'search-loading' }, spinner({ label: 'Preparing search…' })));
      }, SPINNER_DELAY_MS);
      try {
        const [, info] = await Promise.all([prepareSearchIndex(), loadBankInfo()]);
        bank = info;
        clearTimeout(timer);
        if (!alive) return;
        ready = true;
        run.cancel();
        await runNow(); // the field's current text (typed while preparing, or ?q=)
      } catch (err) {
        clearTimeout(timer);
        if (alive) showError(err);
      }
    }

    if (!initial.trim()) showIntro();
    void prepare();

    return {
      el: page,
      destroy() {
        alive = false;
        run.cancel();
      },
    };
  },
};
