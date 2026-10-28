/**
 * PDF reader / editor for one chapter (`/book/:id?page=N`, docs/ARCHITECTURE.md §7.17).
 *
 * Full screen (the tab bar hides). Header: back, chapter title, Search,
 * Sections, ⋯ (go to page, whole page / page width, export annotated copy,
 * replace PDF). The stage holds the virtualized viewer (features/book/viewer.js)
 * with the annotation layer of every mounted page (features/book/annotate.js).
 *
 * Read mode: a bottom bar with Pages (thumbnails), the page indicator
 * ("12 / 56", tap to jump) and zoom (−, %, +; % = relative to page width),
 * plus an **Edit** button in thumb reach. Edit mode: the annotation tool bar
 * docks at the bottom; Done (or Esc) returns to reading.
 *
 * The reader opens at `?page=`, else at the last page read, with the last
 * zoom; the position is saved (debounced) to `bookRepo.setPosition`. Without
 * a PDF on the device it shows one friendly button to add it.
 *
 * Keys: Ctrl/⌘+F or / search · G go to page · E edit · +/−/0 zoom · Esc closes
 * search / leaves editing (tool keys while editing: see annotate.js).
 *
 * @module screens/reader
 */

import { h } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { loadIndex } from '../core/data.js';
import { setSetting } from '../core/settings.js';
import { bookRepo } from '../core/store/repo.js';
import { debounce, plural } from '../core/util.js';
import { setHeader, setTabBarVisible } from '../ui/shell.js';
import { icon } from '../ui/icons.js';
import { button, iconButton, sheet, toast, emptyState, spinner } from '../ui/components.js';
import { importPdfFiles, loadBookData, pdfPageFor, bookPageFor } from '../features/book/library.js';
import { pickPdfFiles } from './book.js';

/** Position saves are debounced by this much (ms). */
const POSITION_DELAY_MS = 600;
/** Search starts this long after the last keystroke (ms). */
const SEARCH_DELAY_MS = 250;

/**
 * @param {EventTarget | null} t
 * @returns {boolean}
 */
function isEditable(t) {
  const el = /** @type {HTMLElement | null} */ (t);
  return Boolean(el && el.tagName && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

export default {
  /**
   * @param {{ params: Record<string, string>, query: Record<string, string> }} ctx
   */
  async render(ctx) {
    const id = String(ctx.params.id || '');
    setTabBarVisible(false);
    setHeader({ title: 'Book', back: '/book' });

    /** @type {any} */
    let chapter = null;
    try {
      const index = await loadIndex({ includeUnpublished: true });
      chapter = index.chapters.find((c) => c.id === id) || null;
    } catch (err) {
      console.warn('[reader] index failed', err);
    }
    if (!chapter) {
      return {
        el: emptyState({
          icon: 'book',
          title: 'Chapter not found',
          text: 'This chapter doesn’t exist. Pick one from the Book tab.',
          action: button({ label: 'Go to Book', variant: 'primary', onClick: () => navigate('/book') }),
        }),
        destroy: () => setTabBarVisible(true),
      };
    }
    const ch = chapter;
    const shortTitle = ch.short || `Chapter ${ch.number}`;

    /* ---------------- state ---------------- */

    let destroyed = false;
    /** @type {any} */ let doc = null;
    /** @type {any} */ let viewer = null;
    /** @type {any} */ let annot = null;
    /** @type {any} */ let toolbar = null;
    /** @type {any} */ let pdfMod = null;
    let pageNow = 1;
    let pageCount = 0;
    /** @type {number | 'fit-width' | 'fit-page'} */
    let scaleMode = 'fit-width';
    let fitWidth = 1;
    /** @type {(() => void)[]} */
    const offs = [];
    const requestedPage = Number.parseInt(ctx.query.page || '', 10);

    /* ---------------- DOM ---------------- */

    const srTitle = h('h1', { class: 'visually-hidden', tabindex: '-1' }, `Chapter ${ch.number}: ${ch.title}`);
    const viewerHost = h('div', { class: 'reader-viewer' });
    const loading = h('div', { class: 'reader-loading' }, spinner({ label: 'Opening the PDF…' }));
    const zoomHint = h('div', { class: 'reader-zoomhint', 'aria-hidden': 'true', hidden: true });

    const pageFloat = h(
      'button',
      { type: 'button', class: 'reader-pagefloat', hidden: true, onClick: () => openJump() },
      '1 / 1',
    );
    const editFab = h(
      'button',
      { type: 'button', class: 'reader-edit-fab', 'aria-pressed': 'false', hidden: true, onClick: () => annot?.setEditing(true) },
      icon('pen', { size: 20 }),
      h('span', null, 'Edit'),
    );
    const stage = h('div', { class: 'reader-stage' }, viewerHost, loading, pageFloat, editFab, zoomHint);

    /* search bar */
    const searchInput = /** @type {HTMLInputElement} */ (
      h('input', {
        type: 'search',
        class: 'reader-search-input',
        id: `reader-q-${ch.id}`,
        placeholder: 'Find in this chapter',
        autocomplete: 'off',
        enterkeyhint: 'search',
      })
    );
    const searchStatus = h('span', { class: 'reader-search-status', role: 'status', 'aria-live': 'polite' });
    const prevBtn = iconButton({ icon: 'chevron-up', label: 'Previous match', onClick: () => stepMatch(-1) });
    const nextBtn = iconButton({ icon: 'chevron-down', label: 'Next match', onClick: () => stepMatch(1) });
    const closeSearchBtn = iconButton({ icon: 'close', label: 'Close search', onClick: () => closeSearch() });
    const searchBar = h(
      'div',
      { class: 'reader-search', role: 'search', hidden: true },
      h('label', { class: 'visually-hidden', for: searchInput.id }, 'Find in this chapter'),
      h('span', { class: 'reader-search-icon', 'aria-hidden': 'true' }, icon('search', { size: 18 })),
      searchInput,
      searchStatus,
      prevBtn,
      nextBtn,
      closeSearchBtn,
    );

    /* read bar */
    const pagesBtn = h(
      'button',
      { type: 'button', class: 'reader-bar-btn', 'aria-label': 'Pages: thumbnails of every page', onClick: () => void openThumbs() },
      icon('grid', { size: 20 }),
      h('span', { class: 'reader-bar-label' }, 'Pages'),
    );
    const pagePill = h('button', { type: 'button', class: 'reader-page', onClick: () => openJump() }, '1 / 1');
    const zoomOut = iconButton({ icon: 'zoom-out', label: 'Zoom out', onClick: () => viewer?.zoomOut() });
    const zoomIn = iconButton({ icon: 'zoom-in', label: 'Zoom in', onClick: () => viewer?.zoomIn() });
    const zoomValue = h('button', { type: 'button', class: 'reader-zoom-value', title: 'Fit to page width', onClick: () => viewer?.setScale('fit-width') }, '100%');
    const readBar = h(
      'div',
      { class: 'reader-bar', role: 'toolbar', 'aria-label': 'Reading' },
      pagesBtn,
      pagePill,
      h('div', { class: 'reader-zoom', role: 'group', 'aria-label': 'Zoom' }, zoomOut, zoomValue, zoomIn),
    );
    const bottom = h('div', { class: 'reader-bottom' }, readBar);

    const root = h('div', { class: 'reader', dataset: { edit: 'false' } }, srTitle, searchBar, stage, bottom);

    /* header */
    const searchBtn = iconButton({ icon: 'search', label: 'Find in this chapter', onClick: () => openSearch() });
    const sectionsBtn = iconButton({ icon: 'list', label: 'Sections', onClick: () => void openSections() });
    const moreBtn = iconButton({ icon: 'more', label: 'More', onClick: () => openMore() });
    moreBtn.setAttribute('aria-haspopup', 'dialog');
    for (const b of [searchBtn, sectionsBtn, moreBtn]) b.disabled = true;
    setHeader({ title: shortTitle, subtitle: `Chapter ${ch.number}`, back: '/book', actions: [searchBtn, sectionsBtn, moreBtn] });

    /* ---------------- position ---------------- */

    const savePosition = debounce(() => {
      if (!pageCount) return;
      bookRepo.setPosition(ch.id, { lastPage: pageNow, lastScale: scaleMode }).catch((err) => console.warn('[reader] position not saved', err));
    }, POSITION_DELAY_MS);
    const savePositionNow = () => {
      savePosition.cancel?.();
      if (!pageCount) return Promise.resolve();
      return bookRepo.setPosition(ch.id, { lastPage: pageNow, lastScale: scaleMode }).catch(() => {});
    };
    const onPageHide = () => void savePositionNow();
    globalThis.addEventListener('pagehide', onPageHide);

    /** @param {number} p */
    function showPage(p) {
      pageNow = p;
      const txt = `${p} / ${pageCount || '…'}`;
      pagePill.textContent = txt;
      pageFloat.textContent = txt;
      const label = `Page ${p} of ${pageCount}. Go to page`;
      pagePill.setAttribute('aria-label', label);
      pageFloat.setAttribute('aria-label', label);
    }

    /** @param {{ scale: number, mode: string | null, fitWidth: number }} s */
    function showScale(s) {
      if (!s) return;
      fitWidth = s.fitWidth > 0 ? s.fitWidth : fitWidth;
      scaleMode = s.mode === 'fit-width' || s.mode === 'fit-page' ? s.mode : s.scale;
      const pct = Math.round((s.scale / (fitWidth || 1)) * 100);
      zoomValue.textContent = `${pct}%`;
      zoomValue.setAttribute('aria-label', `Zoom ${pct}% of the page width. Tap to fit the width`);
    }

    /* ---------------- open ---------------- */

    async function open() {
      let rec = null;
      try {
        rec = await bookRepo.get(ch.id);
      } catch (err) {
        console.warn('[reader] read failed', err);
        return showProblem("This chapter's PDF couldn't be read from this device.", 'Please try again, or add the PDF again.');
      }
      if (destroyed) return;
      if (!rec || !rec.blob) return showMissing();
      setSetting('bookLast', ch.id).catch(() => {});

      let viewerMod;
      let annotMod;
      try {
        [pdfMod, viewerMod, annotMod] = await Promise.all([
          import('../features/book/pdf.js'),
          import('../features/book/viewer.js'),
          import('../features/book/annotate.js'),
        ]);
      } catch (err) {
        console.warn('[reader] modules failed', err);
        return showProblem('The PDF reader couldn’t load.', 'Reload the app and try again.', true);
      }
      if (destroyed) return;
      try {
        doc = await pdfMod.openPdf(rec.blob);
      } catch (err) {
        if (destroyed) return;
        const msg = /** @type {any} */ (err)?.userMessage || 'This PDF couldn’t be opened.';
        return showProblem(msg, 'You can choose the file again.', false, true);
      }
      if (destroyed) {
        doc.destroy?.().catch?.(() => {});
        return;
      }
      pageCount = Number(doc.numPages) || 0;
      annot = annotMod.createBookAnnotator(ch.id);
      const startPage = Number.isInteger(requestedPage) && requestedPage >= 1 ? Math.min(requestedPage, pageCount || requestedPage) : Math.max(1, Number(rec.lastPage) || 1);
      const startScale = rec.lastScale === 'fit-page' || typeof rec.lastScale === 'number' ? rec.lastScale : 'fit-width';
      scaleMode = startScale;
      viewer = viewerMod.createPdfViewer(viewerHost, doc, {
        initialPage: startPage,
        initialScale: startScale,
        overlay: annot.overlay,
        label: `Chapter ${ch.number}, ${ch.title}`,
      });
      annot.attachViewer(viewer);
      offs.push(
        viewer.on('page', (/** @type {number} */ p) => {
          showPage(p);
          savePosition();
        }),
        viewer.on('scale', (/** @type {any} */ s) => {
          showScale(s);
          savePosition();
        }),
        annot.on('edit', (/** @type {{ editing: boolean }} */ e) => setEditMode(e.editing)),
        annot.on('zoomhint', (/** @type {{ scale: number } | null} */ z) => {
          zoomHint.hidden = !z;
          if (z) zoomHint.textContent = `${Math.round((z.scale / (fitWidth || 1)) * 100)}%`;
        }),
      );
      showPage(startPage);
      try {
        await viewer.ready;
      } catch (err) {
        if (destroyed) return;
        console.warn('[reader] viewer failed', err);
        loading.remove();
        return;
      }
      if (destroyed) return;
      loading.remove();
      showPage(viewer.page());
      for (const b of [searchBtn, sectionsBtn, moreBtn]) b.disabled = false;
      editFab.hidden = false;
      root.dataset.ready = 'true';
    }

    /**
     * A calm problem state inside the stage.
     * @param {string} title
     * @param {string} text
     * @param {boolean} [reload]
     * @param {boolean} [replace]
     */
    function showProblem(title, text, reload = false, replace = false) {
      loading.remove();
      readBar.hidden = true;
      const action = reload
        ? button({ label: 'Reload', variant: 'primary', onClick: () => location.reload() })
        : replace
          ? button({ label: 'Choose the PDF again', icon: 'upload', variant: 'primary', onClick: () => void addPdf() })
          : button({ label: 'Back to Book', variant: 'primary', onClick: () => navigate('/book') });
      stage.replaceChildren(h('div', { class: 'reader-state' }, emptyState({ icon: 'alert', title, text, action })));
    }

    function showMissing() {
      loading.remove();
      readBar.hidden = true;
      const add = button({ label: 'Add this chapter’s PDF', icon: 'upload', variant: 'primary', size: 'l', onClick: () => void addPdf() });
      add.classList.add('reader-add');
      stage.replaceChildren(
        h(
          'div',
          { class: 'reader-state' },
          emptyState({
            icon: 'book',
            title: `Chapter ${ch.number}: ${ch.title}`,
            text: 'This chapter’s PDF isn’t on this device yet. Add it once — it stays here and opens offline.',
            action: add,
          }),
        ),
      );
    }

    async function addPdf() {
      const [file] = await pickPdfFiles({ multiple: false });
      if (!file || destroyed) return;
      const busy = toast('Adding the PDF…', { duration: 0 });
      try {
        const [r] = await importPdfFiles([file], { chapterFor: () => ch.id });
        busy.close();
        if (r && (r.status === 'added' || r.status === 'replaced' || r.status === 'unchanged')) {
          navigate(`/book/${ch.id}`, { replace: true });
        } else {
          toast(r?.message || "Couldn't add this file. Please try again.", { kind: 'danger', duration: 7000 });
        }
      } catch (err) {
        busy.close();
        console.warn('[reader] add failed', err);
        toast("Couldn't add this file. Please try again.", { kind: 'danger' });
      }
    }

    /* ---------------- edit mode ---------------- */

    /** @param {boolean} on */
    async function setEditMode(on) {
      root.dataset.edit = String(on);
      editFab.hidden = on || !viewer;
      editFab.setAttribute('aria-pressed', String(on));
      pageFloat.hidden = !on;
      if (on) {
        if (!toolbar) {
          const { createBookToolbar } = await import('../features/book/annotate.js');
          if (destroyed) return;
          toolbar = createBookToolbar(annot, { onDone: () => editFab.focus({ preventScroll: true }) });
        }
        bottom.replaceChildren(toolbar);
        toolbar.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      } else {
        bottom.replaceChildren(readBar);
      }
    }

    /* ---------------- search ---------------- */

    let searchGen = 0;
    /** @type {any[]} */
    let matches = [];
    let current = -1;
    let searching = false;

    function openSearch() {
      if (!viewer) return;
      searchBar.hidden = false;
      root.classList.add('is-searching');
      searchInput.focus();
      searchInput.select();
    }

    function closeSearch() {
      searchGen++;
      matches = [];
      current = -1;
      searching = false;
      viewer?.clearSearch();
      searchBar.hidden = true;
      root.classList.remove('is-searching');
      searchStatus.textContent = '';
      searchBtn.focus({ preventScroll: true });
    }

    function paintSearch() {
      const q = searchInput.value.trim();
      prevBtn.disabled = matches.length < 2;
      nextBtn.disabled = matches.length < 2;
      if (!q) searchStatus.textContent = '';
      else if (!matches.length) searchStatus.textContent = searching ? 'Searching…' : 'No matches';
      else searchStatus.textContent = `${current + 1} of ${matches.length}${searching ? '…' : ''}`;
    }

    async function runSearch() {
      const gen = ++searchGen;
      matches = [];
      current = -1;
      const q = searchInput.value.trim();
      if (!q || !viewer) {
        viewer?.clearSearch();
        searching = false;
        paintSearch();
        return;
      }
      searching = true;
      paintSearch();
      try {
        for await (const m of viewer.search(q)) {
          if (gen !== searchGen || destroyed) return;
          matches.push(m);
          if (matches.length === 1) {
            current = 0;
            viewer.showMatch(m);
          }
          paintSearch();
        }
      } catch (err) {
        console.warn('[reader] search failed', err);
      }
      if (gen !== searchGen) return;
      searching = false;
      paintSearch();
    }
    const runSearchSoon = debounce(() => void runSearch(), SEARCH_DELAY_MS);
    searchInput.addEventListener('input', () => runSearchSoon());
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!matches.length) {
          runSearchSoon.cancel?.();
          void runSearch();
        } else stepMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSearch();
      }
    });

    /** @param {1 | -1} dir */
    function stepMatch(dir) {
      if (!matches.length || !viewer) return;
      current = (current + dir + matches.length) % matches.length;
      viewer.showMatch(matches[current]);
      paintSearch();
    }

    /* ---------------- sheets ---------------- */

    function openJump() {
      if (!viewer) return;
      const input = /** @type {HTMLInputElement} */ (
        h('input', {
          type: 'number',
          class: 'reader-jump-input',
          id: `reader-jump-${ch.id}`,
          min: '1',
          max: String(pageCount),
          inputmode: 'numeric',
          value: String(pageNow),
          'data-autofocus': '',
        })
      );
      const msg = h('p', { class: 'reader-jump-msg', role: 'status' }, `1 to ${pageCount}`);
      /** @type {{ close: (r?: string) => Promise<void> } | null} */
      let ref = null;
      const go = () => {
        const n = Number.parseInt(input.value, 10);
        if (!Number.isInteger(n) || n < 1 || n > pageCount) {
          msg.textContent = `Type a page from 1 to ${pageCount}.`;
          msg.classList.add('is-problem');
          input.focus();
          return;
        }
        void ref?.close('go');
        viewer.goTo(n);
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          go();
        }
      });
      ref = sheet({
        title: 'Go to page',
        content: h('div', { class: 'reader-jump' }, h('label', { class: 'reader-jump-label', for: input.id }, 'Page number'), input, msg),
        actions: [button({ label: 'Cancel', onClick: () => void ref?.close('cancel') }), button({ label: 'Go', variant: 'primary', onClick: go })],
        size: 's',
      });
      requestAnimationFrame(() => input.select());
    }

    async function openSections() {
      if (!viewer) return;
      const data = await loadBookData();
      const entry = data.chapters?.[ch.id];
      /** @type {{ title: string, page: number, label: string, level: number }[]} */
      let items = [];
      let source = 'book';
      if (entry && entry.sections.length) {
        items = entry.sections.map((s) => ({ title: s.title, page: Math.min(pageCount, pdfPageFor(s.page, entry.firstPage)), label: `p. ${s.page}`, level: s.level }));
      } else {
        source = 'pdf';
        try {
          const outline = await viewer.outline();
          items = outline.map((/** @type {any} */ o) => ({ title: o.title, page: o.page, label: `p. ${o.page}`, level: Math.min(2, o.level || 1) }));
        } catch {
          items = [];
        }
      }
      if (destroyed) return;
      let currentIdx = -1;
      items.forEach((it, i) => {
        if (it.page <= pageNow) currentIdx = i;
      });
      /** @type {{ close: (r?: string) => Promise<void>, el: HTMLElement } | null} */
      let ref = null;
      const content = items.length
        ? h(
            'ol',
            { class: 'reader-sections' },
            items.map((it, i) =>
              h(
                'li',
                { class: ['reader-sec', `reader-sec-l${it.level === 2 ? 2 : 1}`] },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'reader-sec-btn',
                    'aria-current': i === currentIdx ? 'true' : undefined,
                    onClick: () => {
                      void ref?.close('go');
                      viewer.goTo(it.page);
                    },
                  },
                  h('span', { class: 'reader-sec-title' }, it.title),
                  h('span', { class: 'reader-sec-page' }, it.label),
                ),
              ),
            ),
          )
        : h('p', { class: 'reader-sections-none' }, 'This chapter has no list of sections. Use Pages or Go to page instead.');
      ref = sheet({
        title: 'Sections',
        content: h(
          'div',
          { class: 'reader-sections-wrap' },
          items.length && source === 'pdf' ? h('p', { class: 'reader-sections-src' }, 'From the PDF’s bookmarks') : null,
          content,
        ),
        size: 'm',
      });
      ref.el.classList.add('reader-sections-sheet');
      const cur = /** @type {HTMLElement | null} */ (ref.el.querySelector('[aria-current="true"]'));
      requestAnimationFrame(() => cur?.scrollIntoView({ block: 'center' }));
    }

    async function openThumbs() {
      if (!viewer) return;
      const withNotes = annot ? await annot.pagesWithNotes().catch(() => new Set()) : new Set();
      if (destroyed) return;
      const entry = (await loadBookData()).chapters?.[ch.id];
      /** @type {{ close: (r?: string) => Promise<void>, el: HTMLElement } | null} */
      let ref = null;
      /** @type {IntersectionObserver | null} */
      let io = null;
      const cells = [];
      for (let p = 1; p <= pageCount; p++) {
        const frame = h('span', { class: 'reader-thumb-frame' }, h('span', { class: 'reader-thumb-ph', 'aria-hidden': 'true' }));
        const label = entry ? `Page ${p} (book p. ${bookPageFor(p, entry.firstPage)})` : `Page ${p}`;
        const cell = h(
          'button',
          {
            type: 'button',
            class: ['reader-thumb', p === pageNow && 'is-current', withNotes.has(p) && 'has-notes'],
            'aria-label': `${label}${withNotes.has(p) ? ', has your notes' : ''}`,
            'aria-current': p === pageNow ? 'page' : undefined,
            dataset: { page: String(p) },
            onClick: () => {
              void ref?.close('go');
              viewer.goTo(p);
            },
          },
          frame,
          h('span', { class: 'reader-thumb-num' }, String(p), withNotes.has(p) ? h('span', { class: 'reader-thumb-dot', 'aria-hidden': 'true' }) : null),
        );
        cells.push(cell);
      }
      const grid = h('div', { class: 'reader-thumbs' }, cells);
      ref = sheet({
        title: `Pages · ${plural(pageCount, 'page')}`,
        content: grid,
        size: 'l',
        onClose: () => io?.disconnect(),
      });
      ref.el.classList.add('reader-thumbs-sheet');
      const scrollBox = ref.el.querySelector('.sheet-body');
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const cell = /** @type {HTMLElement} */ (e.target);
            io?.unobserve(cell);
            const p = Number(cell.dataset.page);
            viewer
              .thumbnail(p, 220)
              .then((/** @type {HTMLCanvasElement} */ canvas) => {
                canvas.classList.add('reader-thumb-img');
                canvas.setAttribute('aria-hidden', 'true');
                cell.querySelector('.reader-thumb-frame')?.replaceChildren(canvas);
              })
              .catch(() => {});
          }
        },
        { root: scrollBox, rootMargin: '200px 0px' },
      );
      for (const c of cells) io.observe(c);
      requestAnimationFrame(() => cells[pageNow - 1]?.scrollIntoView({ block: 'center' }));
    }

    function openMore() {
      if (!viewer) return;
      /** @type {{ close: (r?: string) => Promise<void> } | null} */
      let ref = null;
      /**
       * @param {string} iconName
       * @param {string} label
       * @param {string} sub
       * @param {() => void} fn
       */
      const item = (iconName, label, sub, fn) =>
        h(
          'button',
          {
            type: 'button',
            class: 'book-menu-item',
            onClick: async () => {
              await ref?.close('pick');
              fn();
            },
          },
          h('span', { class: 'book-menu-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 20 })),
          h('span', { class: 'book-menu-text' }, h('span', { class: 'book-menu-label' }, label), sub ? h('span', { class: 'book-menu-sub' }, sub) : null),
        );
      ref = sheet({
        title: shortTitle,
        content: h(
          'div',
          { class: 'book-menu', role: 'group' },
          item('target', 'Go to page…', `You are on page ${pageNow} of ${pageCount}.`, () => openJump()),
          item('layers', scaleMode === 'fit-page' ? 'Fit page width' : 'Show whole page', 'Change how the page fits the screen.', () =>
            viewer.setScale(scaleMode === 'fit-page' ? 'fit-width' : 'fit-page'),
          ),
          item('download', 'Export annotated copy', 'A new PDF with your notes drawn in. The original stays as it is.', () => void exportCopy()),
          item('upload', 'Replace PDF', 'Choose a new file for this chapter. Your notes stay.', () => void addPdf()),
        ),
        size: 's',
      });
    }

    async function exportCopy() {
      await annot?.flush();
      const { exportAnnotatedCopy } = await import('../features/book/export.js');
      await exportAnnotatedCopy(ch.id, { title: `Chapter ${ch.number} - ${ch.title}` });
    }

    /* ---------------- keyboard ---------------- */

    /** @param {KeyboardEvent} e */
    function onKey(e) {
      if (destroyed || !viewer || e.defaultPrevented) return;
      if (document.querySelector('.sheet-root.is-open')) return; // a sheet has the keyboard
      if (annot?.handleKey(e)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openSearch();
        return;
      }
      if (mod || e.altKey || isEditable(e.target)) return;
      if (e.key === 'Escape') {
        if (!searchBar.hidden) closeSearch();
        else if (annot?.isEditing()) annot.setEditing(false);
        else return;
        e.preventDefault();
        return;
      }
      if (annot?.isEditing()) return;
      const k = e.key.toLowerCase();
      if (k === '/') openSearch();
      else if (k === 'g') openJump();
      else if (k === 'e') annot?.setEditing(true);
      else if (e.key === '+' || e.key === '=') viewer.zoomIn();
      else if (e.key === '-') viewer.zoomOut();
      else if (e.key === '0') viewer.setScale('fit-width');
      else return;
      e.preventDefault();
    }
    document.addEventListener('keydown', onKey);

    void open();

    return {
      el: root,
      keepScroll: false,
      async destroy() {
        destroyed = true;
        document.removeEventListener('keydown', onKey);
        globalThis.removeEventListener('pagehide', onPageHide);
        searchGen++;
        runSearchSoon.cancel?.();
        for (const off of offs) {
          try {
            off();
          } catch {
            /* ignore */
          }
        }
        const pos = savePositionNow();
        try {
          await annot?.destroy();
        } catch (err) {
          console.warn('[reader] notes not saved on close', err);
        }
        toolbar?.destroy();
        viewer?.destroy();
        try {
          await doc?.destroy();
        } catch {
          /* ignore */
        }
        try {
          pdfMod?.closePdfEngine?.();
        } catch {
          /* ignore */
        }
        setTabBarVisible(true);
        await pos;
      },
    };
  },
};
