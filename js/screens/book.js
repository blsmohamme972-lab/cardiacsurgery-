/**
 * Book tab (`/book`, docs/ARCHITECTURE.md §7.17): the owner's book as parts →
 * all 55 chapters → sub-chapters, with the chapter PDFs the user imported on
 * this device.
 *
 * - Top: a "monitor" panel with how many chapters are on the device, the
 *   storage they use, **Add PDFs** (multi-file picker; files are matched to
 *   chapters by name) and **Continue reading**.
 * - Import results sheet: the matched chapter per file, a chapter picker for
 *   files that didn't match, Undo for the whole import (also restores replaced files).
 * - A filter field for chapter titles / numbers.
 * - Every chapter row: number, title, book pages, and either "Page 12 of 27"
 *   with a progress bar (PDF on the device: opens the reader) or "Add PDF".
 *   Sub-chapters (from `data/book.json`, or the PDF's own outline) expand
 *   under the row and open the reader at their page.
 * - ⋯ menu (also long-press): Open, Replace PDF, Export annotated copy,
 *   Remove from this device (with Undo; notes are kept).
 * - **Add the whole book** (§7.17): one PDF of the whole book, stored once;
 *   every chapter opens as a page range of it. A progress sheet ("Finding
 *   chapters… 23/55"), then the chapter-pages sheet: every chapter with its
 *   detected PDF pages and a manual "Starts on PDF page" field (estimates around a
 *   manual change are re-computed; Undo). A chapter's own PDF, when added, wins
 *   over the book's pages. Pages before Chapter 1 are never shown.
 * - A PDF that is clearly the whole book (≥ 150 pages, chapters found) is
 *   recognised in Add PDFs, drag and drop and the Android share target
 *   (`#/book?import=<id>`, files stashed by sw.js).
 * - Query: `?pages=<chapterId>` opens the chapter-pages sheet at that chapter,
 *   `?add=book` points at the "Add the whole book" button.
 * - PDFs can also be dropped onto the screen.
 * - Scroll position, expanded chapters and the filter are remembered.
 *
 * @module screens/book
 */

import { h } from '../core/dom.js';
import { bus } from '../core/events.js';
import { navigate } from '../core/router.js';
import { loadIndex } from '../core/data.js';
import { getSetting, setSetting } from '../core/settings.js';
import { bookRepo, wholeBookRepo, BOOK_MAX_BYTES } from '../core/store/repo.js';
import { plural } from '../core/util.js';
import { setHeader } from '../ui/shell.js';
import { icon } from '../ui/icons.js';
import { button, iconButton, sheet, toast, undoToast, emptyState, spinner, progressBar } from '../ui/components.js';
import { importPdfFiles, undoImport, loadBookData, pdfPageFor, bookPageFor, formatBytes } from '../features/book/library.js';
import {
  WHOLE_BOOK_MIN_PAGES,
  adjustRanges,
  chapterRefsOf,
  importWholeBook,
  isShareId,
  outlineFor,
  pageCountOf,
  rangeOf,
  redetectWholeBook,
  takeSharedFiles,
} from '../features/book/wholebook.js';

/** Undo window before "Remove the book" really deletes the file (ms). */
const REMOVE_DELAY_MS = 6500;
/** Labels of how a chapter's pages were found. */
const HOW_LABEL = Object.freeze({
  labels: 'Found',
  confirmed: 'Found',
  folio: 'Found',
  title: 'Found',
  estimated: 'Estimated',
  manual: 'Set by you',
});

/** Long-press time on a chapter row (ms). */
const LONG_PRESS_MS = 550;

/**
 * Remembered for this app session: scroll, filter and open chapters.
 * (Expanded chapters are also stored in the `bookExpanded` setting.)
 */
const memory = {
  scrollY: 0,
  filter: '',
  /** @type {Set<string> | null} */
  expanded: null,
  /** Outlines read from stored PDFs (chapter id → entries). @type {Map<string, { title: string, page: number, level: number }[]>} */
  outlines: new Map(),
};

/**
 * @typedef {import('../core/data.js').Chapter} Chapter
 * @typedef {{ id: string, title: string, fileName: string, bytes: number, pages: number | null, added: number,
 *   updated: number, lastPage: number, lastScale: any }} BookMeta
 */

/**
 * A hidden file input that opens the system picker for PDFs.
 * @param {{ multiple?: boolean }} [opts]
 * @returns {Promise<File[]>} The chosen files ([] when cancelled).
 */
export function pickPdfFiles({ multiple = true } = {}) {
  return new Promise((resolve) => {
    const input = /** @type {HTMLInputElement} */ (
      h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple, hidden: true, class: 'book-file-input' })
    );
    let done = false;
    const finish = (/** @type {File[]} */ files) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    document.body.append(input);
    input.click();
  });
}

/**
 * Chapter label "Chapter 3 · Title".
 * @param {{ number: number, title: string }} c
 */
const chapterLabel = (c) => `Chapter ${c.number} · ${c.title}`;

/**
 * Plain-language import outcome for one file.
 * @param {any} r ImportResult
 * @returns {{ ok: boolean, text: string }}
 */
function outcome(r) {
  switch (r.status) {
    case 'added':
      return { ok: true, text: 'Added' };
    case 'replaced':
      return { ok: true, text: 'Added · replaced the earlier file' };
    case 'unchanged':
      return { ok: true, text: 'Already on this device' };
    case 'unmatched':
      return { ok: false, text: 'Which chapter is this? Choose one below.' };
    case 'duplicate':
      return { ok: false, text: 'Another file in this batch went to the same chapter. Choose another chapter.' };
    case 'too-large':
      return { ok: false, text: r.message || 'This PDF is too large to keep in the app.' };
    case 'no-space':
      return { ok: false, text: 'Your device storage is full. Free up some space, then try again.' };
    default:
      return { ok: false, text: r.message || "Couldn't add this file. Please try again." };
  }
}

/** A pending "Remove the book" (undo window), shared across renders. */
const removal = { timer: 0, pending: false };

export default {
  /**
   * @param {{ params: Record<string, string>, query: Record<string, string> }} ctx
   */
  async render(ctx) {
    setHeader({ title: 'Book' });

    /** @type {Awaited<ReturnType<typeof loadIndex>>} */
    let index;
    /** @type {BookMeta[]} */
    let metas = [];
    /** @type {Awaited<ReturnType<typeof loadBookData>>} */
    let bookData = { schemaVersion: 1, chapters: {} };
    /** @type {any} The whole book's metadata (null when not added). */
    let whole = null;
    try {
      [index, metas, bookData, whole] = await Promise.all([
        loadIndex({ includeUnpublished: true }),
        bookRepo.all().catch((err) => {
          console.warn('[book] could not read the stored PDFs', err);
          toast("Your PDFs couldn't be read from this device. Reload the app to try again.", { kind: 'danger' });
          return [];
        }),
        loadBookData(),
        wholeBookRepo.meta().catch((err) => {
          console.warn('[book] could not read the whole book', err);
          return null;
        }),
      ]);
    } catch (err) {
      console.warn('[book] could not load the book', err);
      return emptyState({
        icon: 'book',
        title: "The book couldn't load",
        text: /** @type {any} */ (err)?.userMessage || 'Please reload the app and try again.',
        action: button({ label: 'Reload', variant: 'primary', onClick: () => location.reload() }),
      });
    }

    if (!memory.expanded) {
      const saved = getSetting('bookExpanded');
      memory.expanded = new Set(Array.isArray(saved) ? saved.filter((x) => typeof x === 'string') : []);
    }
    const expanded = memory.expanded;
    /** @type {Map<string, BookMeta>} */
    let stored = new Map(metas.map((m) => [m.id, m]));
    const chapters = /** @type {Chapter[]} */ (index.chapters);
    const byId = new Map(chapters.map((c) => [c.id, c]));
    const chapterRefs = chapters.map((c) => ({ id: c.id, number: c.number, title: c.title }));
    const bookRefs = chapterRefsOf(/** @type {any} */ (index));
    let destroyed = false;

    /** The whole book's metadata, unless a removal is pending. */
    const book = () => (whole && !removal.pending ? whole : null);
    /**
     * A chapter's page range in the whole book (null when it has its own PDF, or isn't in the book).
     * @param {string} id
     */
    const bookRange = (id) => (stored.has(id) ? null : rangeOf(book(), id));
    /** @param {string} id */
    const available = (id) => stored.has(id) || Boolean(bookRange(id));
    /**
     * Reading state of a chapter: pages, current page, source.
     * @param {string} id
     * @returns {{ pages: number, page: number, updated: number, source: 'pdf' | 'book' } | null}
     */
    const infoOf = (id) => {
      const m = stored.get(id);
      if (m) return { pages: Number(m.pages) || 0, page: Math.max(1, Number(m.lastPage) || 1), updated: m.updated || 0, source: 'pdf' };
      const r = bookRange(id);
      if (!r) return null;
      const pos = book()?.positions?.[id];
      return { pages: r.to - r.from + 1, page: Math.max(1, Number(pos?.lastPage) || 1), updated: pos?.updated || 0, source: 'book' };
    };

    /* ---------------- hero ---------------- */

    const heroCount = h('span', { class: 'book-vital-value num-display' });
    const heroBytes = h('span', { class: 'book-vital-value num-display' });
    const addBtn = button({ label: 'Add PDFs', icon: 'upload', variant: 'secondary', onClick: () => void chooseAndImport() });
    addBtn.classList.add('book-add', 'book-add-quiet');
    const addBookBtn = button({ label: 'Add the whole book', icon: 'book', variant: 'primary', onClick: () => void chooseWholeBook() });
    addBookBtn.classList.add('book-add-whole');
    const continueSlot = h('div', { class: 'book-continue-slot' });
    const wholeSlot = h('div', { class: 'book-whole-slot' });
    const hero = h(
      'section',
      { class: 'book-hero', 'aria-labelledby': 'book-h1' },
      h(
        'div',
        { class: 'book-hero-text' },
        h('p', { class: 'book-eyebrow' }, `${index.parts.length} parts · ${chapters.length} chapters`),
        h('h1', { class: 'book-title', id: 'book-h1', tabindex: '-1' }, 'Your book'),
        h('p', { class: 'book-tagline' }, 'Read, highlight and annotate the book. It stays on this device and opens offline.'),
      ),
      h('div', { class: 'book-hero-ecg', 'aria-hidden': 'true' }, h('span', { class: 'ecg-line' })),
      h(
        'dl',
        { class: 'book-vitals' },
        h('div', { class: 'book-vital' }, h('dt', { class: 'book-vital-label' }, 'On this device'), h('dd', { class: 'book-vital-dd' }, heroCount)),
        h('div', { class: 'book-vital' }, h('dt', { class: 'book-vital-label' }, 'Storage used'), h('dd', { class: 'book-vital-dd' }, heroBytes)),
      ),
      h('div', { class: 'book-hero-actions' }, addBookBtn, addBtn),
    );

    const emptyAddBook = button({ label: 'Add the whole book', icon: 'book', variant: 'primary', size: 's', onClick: () => void chooseWholeBook() });
    emptyAddBook.classList.add('book-empty-add');
    const emptyNote = h(
      'div',
      { class: 'book-empty-note', role: 'note' },
      icon('info', { size: 20 }),
      h(
        'div',
        { class: 'book-empty-body' },
        h(
          'p',
          null,
          h('strong', null, 'Add the whole book once: '),
          'choose the book’s PDF and every chapter opens from it, at the right pages. Or tap Add PDFs to add chapter PDFs (matched by name, e.g. “Chapter-01-….pdf”).',
        ),
        emptyAddBook,
      ),
    );

    function renderHero() {
      const n = chapters.filter((c) => available(c.id)).length;
      heroCount.replaceChildren(String(n), h('span', { class: 'book-vital-unit' }, ` / ${chapters.length}`));
      const bytes = [...stored.values()].reduce((s, m) => s + (Number(m.bytes) || 0), 0) + (Number(book()?.bytes) || 0);
      heroBytes.textContent = bytes ? formatBytes(bytes) : '0 MB';
      emptyNote.hidden = n > 0 || Boolean(book());
      addBookBtn.hidden = Boolean(book());
      renderWhole();
      renderContinue();
    }

    /** The whole-book card: file, chapters found, Check chapter pages, ⋯. */
    function renderWhole() {
      const b = book();
      if (!b) {
        wholeSlot.replaceChildren();
        return;
      }
      const ranges = b.map?.chapters || {};
      const found = chapters.filter((c) => ranges[c.id]).length;
      const estimated = chapters.filter((c) => ranges[c.id]?.how === 'estimated').length;
      const missing = chapters.length - found;
      const status = !b.map
        ? 'Chapters not found yet'
        : missing
          ? `${found} of ${chapters.length} chapters found · ${missing} to set`
          : estimated
            ? `All ${chapters.length} chapters · ${estimated} estimated`
            : `All ${chapters.length} chapters found`;
      const check = button({
        label: b.map ? 'Check chapter pages' : 'Find chapters',
        icon: b.map ? 'target' : 'search',
        variant: missing || !b.map ? 'primary' : 'secondary',
        size: 's',
        onClick: () => (b.map ? showMap() : void findAgain()),
      });
      check.classList.add('book-whole-check');
      const more = iconButton({ icon: 'more', label: 'More actions for the whole book', onClick: () => openBookMenu(more) });
      more.setAttribute('aria-haspopup', 'dialog');
      wholeSlot.replaceChildren(
        h(
          'section',
          { class: ['book-whole', (missing || !b.map) && 'is-attention'], 'aria-label': 'The whole book' },
          h('span', { class: 'book-whole-icon', 'aria-hidden': 'true' }, icon('book', { size: 22 })),
          h(
            'div',
            { class: 'book-whole-text' },
            h('span', { class: 'book-whole-eyebrow' }, 'Whole book on this device'),
            h('span', { class: 'book-whole-name' }, b.fileName || 'Book PDF'),
            h(
              'span',
              { class: 'book-whole-meta' },
              [b.pages ? `${b.pages.toLocaleString('en-US')} pages` : null, formatBytes(b.bytes), status].filter(Boolean).join(' · '),
            ),
          ),
          h('div', { class: 'book-whole-actions' }, check, more),
        ),
      );
    }

    function renderContinue() {
      const lastId = getSetting('bookLast');
      const candidates = chapters.map((c) => ({ c, info: infoOf(c.id) })).filter((x) => x.info);
      const recent = candidates.sort((a, b) => (/** @type {any} */ (b.info).updated || 0) - (/** @type {any} */ (a.info).updated || 0));
      const pick = (typeof lastId === 'string' && recent.find((x) => x.c.id === lastId)) || recent.find((x) => (x.info?.page || 1) > 1) || null;
      const ch = pick ? pick.c : null;
      if (!pick || !ch) {
        continueSlot.replaceChildren();
        return;
      }
      const pages = Number(pick.info?.pages) || 0;
      const page = Math.max(1, Number(pick.info?.page) || 1);
      const pct = pages ? Math.round((page / pages) * 100) : 0;
      continueSlot.replaceChildren(
        h(
          'a',
          { class: 'book-continue', href: `#/book/${ch.id}`, 'aria-label': `Continue reading Chapter ${ch.number}, ${ch.title}, page ${page}` },
          h('span', { class: 'book-continue-icon', 'aria-hidden': 'true' }, icon('book', { size: 22 })),
          h(
            'span',
            { class: 'book-continue-text' },
            h('span', { class: 'book-continue-eyebrow' }, 'Continue reading'),
            h('span', { class: 'book-continue-title' }, `${ch.number}. ${ch.title}`),
            h(
              'span',
              { class: 'book-continue-meta' },
              pages ? `Page ${page} of ${pages}` : `Page ${page}`,
              pages ? h('span', { class: 'book-meter', style: { '--p': `${pct}%` }, 'aria-hidden': 'true' }) : null,
            ),
          ),
          h('span', { class: 'book-continue-go', 'aria-hidden': 'true' }, icon('chevron-right', { size: 20 })),
        ),
      );
    }

    /* ---------------- filter ---------------- */

    const filterInput = /** @type {HTMLInputElement} */ (
      h('input', {
        type: 'search',
        class: 'book-filter-input',
        id: 'book-filter',
        placeholder: 'Find a chapter',
        autocomplete: 'off',
        enterkeyhint: 'search',
        value: memory.filter,
        onInput: () => applyFilter(),
      })
    );
    const filterStatus = h('p', { class: 'book-filter-status', role: 'status', 'aria-live': 'polite' });
    const filter = h(
      'div',
      { class: 'book-filter', role: 'search' },
      h('label', { class: 'visually-hidden', for: 'book-filter' }, 'Find a chapter by title or number'),
      h('span', { class: 'book-filter-icon', 'aria-hidden': 'true' }, icon('search', { size: 20 })),
      filterInput,
    );

    /* ---------------- parts + chapters ---------------- */

    const list = h('div', { class: 'book-parts' });
    /** @type {Map<string, { li: HTMLElement, render: () => void, ch: Chapter }>} */
    const rows = new Map();
    /** @type {{ el: HTMLElement, part: any, meta: HTMLElement, ids: string[] }[]} */
    const partEls = [];

    /** Book pages of a chapter: "pp. 28–83". */
    function pageRange(/** @type {Chapter} */ ch) {
      const i = chapters.indexOf(ch);
      const next = chapters[i + 1];
      if (!ch.page) return '';
      return next && next.page > ch.page ? `pp. ${ch.page}–${next.page - 1}` : `from p. ${ch.page}`;
    }

    /**
     * Sections of a chapter: data/book.json (book pages → PDF pages) or the PDF outline.
     * @param {Chapter} ch
     * @returns {{ title: string, pdfPage: number, label: string, level: number }[] | null} null = not known yet.
     */
    function sectionsOf(ch) {
      const entry = bookData.chapters?.[ch.id];
      if (entry && entry.sections.length) {
        return entry.sections.map((s) => ({ title: s.title, pdfPage: pdfPageFor(s.page, entry.firstPage), label: `p. ${s.page}`, level: s.level }));
      }
      const r = bookRange(ch.id);
      if (r) {
        return outlineFor(book()?.outline || [], r).map((o) => ({
          title: o.title,
          pdfPage: o.page,
          label: ch.page ? `p. ${bookPageFor(o.page, ch.page)}` : `PDF p. ${o.page}`,
          level: Math.min(2, o.level),
        }));
      }
      const out = memory.outlines.get(ch.id);
      if (out) return out.map((o) => ({ title: o.title, pdfPage: o.page, label: `PDF p. ${o.page}`, level: Math.min(2, o.level) }));
      return null;
    }

    /** @param {Chapter} ch */
    const hasSections = (ch) => Boolean(bookData.chapters?.[ch.id]?.sections.length) || stored.has(ch.id) || Boolean(bookRange(ch.id));

    /**
     * Reads the outline of a stored PDF (once per session).
     * @param {Chapter} ch
     */
    async function loadOutline(ch) {
      if (memory.outlines.has(ch.id)) return;
      try {
        const rec = await bookRepo.get(ch.id);
        if (!rec?.blob) return;
        const { pdfInfo } = await import('../features/book/pdf.js');
        const info = await pdfInfo(rec.blob);
        memory.outlines.set(ch.id, Array.isArray(info.outline) ? info.outline : []);
      } catch (err) {
        console.warn('[book] outline unavailable', err);
        memory.outlines.set(ch.id, []);
      }
    }

    /**
     * Opens the reader (at a PDF page) or asks for the PDF.
     * @param {Chapter} ch
     * @param {number} [page]
     */
    function openChapter(ch, page) {
      if (!available(ch.id)) {
        void addFor(ch);
        return;
      }
      navigate(page ? `/book/${ch.id}?page=${page}` : `/book/${ch.id}`);
    }

    /**
     * One chapter row.
     * @param {Chapter} ch
     */
    function chapterRow(ch) {
      const li = h('li', { class: 'book-ch', dataset: { id: ch.id } });
      let press = 0;
      let longPressed = false;

      function render() {
        const meta = infoOf(ch.id);
        const isOpen = expanded.has(ch.id);
        li.classList.toggle('has-pdf', Boolean(meta));
        li.classList.toggle('from-book', meta?.source === 'book');
        li.classList.toggle('is-open', isOpen);
        const pages = Number(meta?.pages) || 0;
        const page = Math.max(1, Number(meta?.page) || 1);
        const pct = meta && pages ? Math.round((Math.min(page, pages) / pages) * 100) : 0;
        const range = pageRange(ch);
        const missingInBook = !meta && Boolean(book());
        const sub = meta
          ? h(
              'span',
              { class: 'book-ch-sub' },
              h('span', { class: 'book-ch-status is-ready' }, pages ? `Page ${page} of ${pages}` : 'Ready to read'),
              range ? h('span', { class: 'book-ch-range' }, `· ${range}`) : null,
              pages ? h('span', { class: 'book-ch-progress', 'aria-hidden': 'true' }, h('span', { class: 'book-meter', style: { '--p': `${pct}%` } })) : null,
            )
          : h(
              'span',
              { class: 'book-ch-sub' },
              missingInBook
                ? h('span', { class: 'book-ch-status is-add' }, icon('target', { size: 14 }), 'Set its pages')
                : h('span', { class: 'book-ch-status is-add' }, icon('plus', { size: 14 }), 'Add PDF'),
              range ? h('span', { class: 'book-ch-range' }, `· ${range}`) : null,
            );
        const mainLabel = meta
          ? `Chapter ${ch.number}, ${ch.title}. ${pages ? `Page ${page} of ${pages}.` : ''} Open`
          : missingInBook
            ? `Chapter ${ch.number}, ${ch.title}. Not found in your book's PDF. Set its pages`
            : `Chapter ${ch.number}, ${ch.title}. PDF not added. Add PDF`;
        const main = h(
          meta ? 'a' : 'button',
          {
            class: 'book-ch-main',
            href: meta ? `#/book/${ch.id}` : undefined,
            type: meta ? undefined : 'button',
            'aria-label': mainLabel,
            onClick: (/** @type {MouseEvent} */ e) => {
              if (longPressed) {
                e.preventDefault();
                longPressed = false;
                return;
              }
              if (!meta) {
                if (missingInBook) showMap({ focus: ch.id });
                else void addFor(ch);
              }
            },
          },
          h('span', { class: 'book-ch-num num-display', 'aria-hidden': 'true' }, String(ch.number)),
          h('span', { class: 'book-ch-text' }, h('span', { class: 'book-ch-title' }, ch.title), sub),
        );
        // Long-press opens the menu (touch and mouse); a visible ⋯ button does the same.
        main.addEventListener('pointerdown', (e) => {
          if (e.button > 0) return;
          longPressed = false;
          clearTimeout(press);
          const x = e.clientX;
          const y = e.clientY;
          press = window.setTimeout(() => {
            longPressed = true;
            try {
              navigator.vibrate?.(12);
            } catch {
              /* ignore */
            }
            openMenu(ch, main);
          }, LONG_PRESS_MS);
          const cancel = (/** @type {PointerEvent} */ ev) => {
            if (ev.type === 'pointermove' && Math.hypot(ev.clientX - x, ev.clientY - y) < 10) return;
            clearTimeout(press);
            main.removeEventListener('pointermove', cancel);
          };
          main.addEventListener('pointermove', cancel);
          main.addEventListener('pointerup', cancel, { once: true });
          main.addEventListener('pointercancel', cancel, { once: true });
        });
        main.addEventListener('contextmenu', (e) => e.preventDefault());

        const actions = h('div', { class: 'book-ch-actions' });
        li.classList.toggle('has-toggle', hasSections(ch));
        if (hasSections(ch)) {
          const tog = iconButton({ icon: 'chevron-down', label: `${isOpen ? 'Hide' : 'Show'} sections of Chapter ${ch.number}`, onClick: () => toggle() });
          tog.classList.add('book-ch-toggle');
          tog.setAttribute('aria-expanded', String(isOpen));
          tog.setAttribute('aria-controls', `book-sec-${ch.id}`);
          actions.append(tog);
        }
        const more = iconButton({ icon: 'more', label: `More actions for Chapter ${ch.number}`, onClick: () => openMenu(ch, more) });
        more.classList.add('book-ch-more');
        more.setAttribute('aria-haspopup', 'dialog');
        actions.append(more);

        const head = h('div', { class: 'book-ch-head' }, main, actions);
        const kids = [head];
        if (isOpen) kids.push(sectionList(ch));
        li.replaceChildren(...kids);
      }

      function toggle() {
        if (expanded.has(ch.id)) expanded.delete(ch.id);
        else expanded.add(ch.id);
        void setSetting('bookExpanded', [...expanded]).catch(() => {});
        render();
        li.querySelector('.book-ch-toggle')?.focus({ preventScroll: true });
      }

      rows.set(ch.id, { li, render, ch });
      render();
      return li;
    }

    /**
     * The expanded sub-chapter list of a chapter.
     * @param {Chapter} ch
     */
    function sectionList(ch) {
      const box = h('div', { class: 'book-sections', id: `book-sec-${ch.id}` });
      const fill = () => {
        const secs = sectionsOf(ch);
        if (secs === null) {
          box.replaceChildren(h('div', { class: 'book-sections-loading' }, spinner({ label: 'Reading the chapter’s outline…' })));
          void loadOutline(ch).then(() => {
            if (!destroyed && box.isConnected) fill();
          });
          return;
        }
        if (!secs.length) {
          box.replaceChildren(h('p', { class: 'book-sections-none' }, 'This PDF has no list of sections. Open it to browse its pages.'));
          return;
        }
        const has = available(ch.id);
        box.replaceChildren(
          h(
            'ol',
            { class: 'book-sec-list', 'aria-label': `Sections of Chapter ${ch.number}` },
            secs.map((s) =>
              h(
                'li',
                { class: ['book-sec', `book-sec-l${s.level === 2 ? 2 : 1}`] },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'book-sec-btn',
                    'aria-label': `${s.title}, ${s.label}${has ? '' : '. Add the PDF first'}`,
                    onClick: () => {
                      if (has) openChapter(ch, s.pdfPage);
                      else {
                        toast(`Add the PDF of Chapter ${ch.number} to read this section.`, {
                          action: { label: 'Add PDF', onClick: () => void addFor(ch) },
                        });
                      }
                    },
                  },
                  h('span', { class: 'book-sec-title' }, s.title),
                  h('span', { class: 'book-sec-page' }, s.label),
                ),
              ),
            ),
          ),
        );
      };
      fill();
      return box;
    }

    function renderParts() {
      list.replaceChildren();
      partEls.length = 0;
      for (const part of index.parts) {
        const partChapters = chapters.filter((c) => c.part === part.id);
        if (!partChapters.length) continue;
        const hid = `book-part-${part.id}`;
        const meta = h('span', { class: 'book-part-meta' });
        const el = h(
          'section',
          { class: 'book-part', 'aria-labelledby': hid },
          h(
            'div',
            { class: 'book-part-head' },
            h('span', { class: 'book-part-badge num-display', 'aria-hidden': 'true' }, String(part.number)),
            h(
              'h2',
              { class: 'book-part-title', id: hid },
              h('span', { class: 'book-part-num' }, `Part ${part.number}`),
              h('span', { class: 'visually-hidden' }, ': '),
              h('span', { class: 'book-part-name' }, part.title),
            ),
            meta,
          ),
          h('ul', { class: 'book-chapters' }, partChapters.map((c) => chapterRow(c))),
        );
        partEls.push({ el, part, meta, ids: partChapters.map((c) => c.id) });
        list.append(el);
      }
      renderPartMeta();
    }

    function renderPartMeta() {
      for (const p of partEls) {
        const n = p.ids.filter((id) => available(id)).length;
        p.meta.textContent = `${plural(p.ids.length, 'chapter')} · ${n ? `${n} on this device` : 'no PDFs yet'}`;
      }
    }

    const noMatch = h('p', { class: 'book-no-match', hidden: true }, 'No chapter matches. Try another word or a chapter number.');

    function applyFilter() {
      const q = filterInput.value.trim().toLowerCase();
      memory.filter = filterInput.value;
      let shown = 0;
      for (const { li, ch } of rows.values()) {
        const hit = !q || ch.title.toLowerCase().includes(q) || String(ch.number) === q.replace(/^(ch(apter)?\.?\s*)/, '');
        li.hidden = !hit;
        if (hit) shown++;
      }
      for (const p of partEls) {
        const any = p.ids.some((id) => !rows.get(id)?.li.hidden);
        const partHit = q && (p.part.title.toLowerCase().includes(q) || `part ${String(p.part.number).toLowerCase()}` === q);
        if (partHit) {
          for (const id of p.ids) {
            const r = rows.get(id);
            if (r && r.li.hidden) {
              r.li.hidden = false;
              shown++;
            }
          }
        }
        p.el.hidden = !(any || partHit);
      }
      noMatch.hidden = shown > 0;
      filterStatus.textContent = q ? (shown ? `${plural(shown, 'chapter')} shown` : 'No chapter matches') : '';
    }

    /* ---------------- refresh after changes ---------------- */

    async function refresh() {
      try {
        const [next, w] = await Promise.all([bookRepo.all(), wholeBookRepo.meta()]);
        if (destroyed) return;
        stored = new Map(next.map((m) => [m.id, m]));
        whole = w;
      } catch (err) {
        console.warn('[book] refresh failed', err);
        return;
      }
      for (const r of rows.values()) r.render();
      renderHero();
      renderPartMeta();
      applyFilter();
    }
    let refreshTimer = 0;
    const offStore = bus.on('store:change', (p) => {
      if (p?.store !== 'books' && p?.store !== 'wholebook') return;
      clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(), 120);
    });

    /* ---------------- import ---------------- */

    async function chooseAndImport() {
      const files = await pickPdfFiles({ multiple: true });
      if (files.length) await runImport(files);
    }

    /**
     * Adds (or replaces) the PDF of one chapter.
     * @param {Chapter} ch
     */
    async function addFor(ch) {
      const [file] = await pickPdfFiles({ multiple: false });
      if (!file) return;
      await runImport([file], { only: ch.id });
    }

    /**
     * Imports files and shows what happened.
     * @param {File[]} files
     * @param {{ only?: string }} [opts] Put every file into this chapter.
     */
    async function runImport(files, { only } = {}) {
      let pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
      if (!pdfs.length) {
        toast("These aren't PDF files. Choose the chapter PDFs.", { kind: 'danger' });
        return;
      }
      if (!only) {
        // A file that is clearly the whole book goes to the whole-book import.
        const checking = pdfs.length > 1 || pdfs[0].size > 20 * 1024 * 1024 ? toast('Checking the files…', { duration: 0 }) : null;
        /** @type {File | null} */
        let bookFile = null;
        try {
          for (const f of pdfs) {
            if (f.size > BOOK_MAX_BYTES || ((await pageCountOf(f)) ?? 0) >= WHOLE_BOOK_MIN_PAGES) {
              bookFile = f;
              break;
            }
          }
        } finally {
          checking?.close();
        }
        if (bookFile) {
          pdfs = pdfs.filter((f) => f !== bookFile);
          await runWholeImport(bookFile, { requireMatch: true });
          if (!pdfs.length || destroyed) return;
        }
      }
      const busy = toast(pdfs.length > 1 ? `Adding ${pdfs.length} PDFs…` : 'Adding the PDF…', { duration: 0 });
      addBtn.disabled = true;
      let results = [];
      try {
        results = await importPdfFiles(pdfs, { chapters: chapterRefs, chapterFor: only ? () => only : undefined });
      } catch (err) {
        console.warn('[book] import failed', err);
        toast("The PDFs couldn't be added. Please try again.", { kind: 'danger' });
        return;
      } finally {
        busy.close();
        addBtn.disabled = false;
      }
      await refresh();
      if (destroyed) return;
      const allGood = results.length === 1 && (results[0].status === 'added' || results[0].status === 'unchanged');
      if (allGood) {
        const r = results[0];
        const ch = byId.get(r.chapterId);
        if (r.status === 'added' && ch) {
          toast(`Added: Chapter ${ch.number}.`, { kind: 'success', action: { label: 'Open', onClick: () => openChapter(ch) } });
        } else if (ch) toast(`Chapter ${ch.number} is already on this device.`);
        return;
      }
      showResults(results);
    }

    /**
     * The import results sheet.
     * @param {any[]} results
     */
    function showResults(results) {
      const listEl = h('ul', { class: 'book-results' });
      /** @type {{ close: (r?: string) => Promise<void>, el: HTMLElement } | null} */
      let ref = null;
      /** Every result ever produced in this sheet (for Undo). @type {any[]} */
      const all = [...results];

      /**
       * @param {any} r
       * @returns {HTMLElement}
       */
      function resultRow(r) {
        const li = h('li', { class: 'book-result' });
        const paint = (/** @type {any} */ res) => {
          const o = outcome(res);
          const ch = res.chapterId ? byId.get(res.chapterId) : null;
          li.classList.toggle('is-ok', o.ok);
          li.classList.toggle('is-problem', !o.ok);
          const kids = [
            h('span', { class: 'book-result-icon', 'aria-hidden': 'true' }, icon(o.ok ? 'check' : 'alert', { size: 18 })),
            h(
              'div',
              { class: 'book-result-text' },
              h('span', { class: 'book-result-title' }, o.ok && ch ? chapterLabel(ch) : res.name || 'PDF file'),
              h('span', { class: 'book-result-file' }, o.ok && ch ? res.name : ''),
              h('span', { class: ['book-result-msg', !o.ok && 'is-problem'] }, o.text),
            ),
          ];
          li.replaceChildren(...kids);
          if (!o.ok && ['unmatched', 'duplicate'].includes(res.status)) {
            const sel = /** @type {HTMLSelectElement} */ (
              h(
                'select',
                { class: 'book-result-select', 'aria-label': `Chapter for ${res.name}` },
                h('option', { value: '' }, 'Choose a chapter…'),
                index.parts.map((p) =>
                  h(
                    'optgroup',
                    { label: `Part ${p.number}: ${p.title}` },
                    chapters.filter((c) => c.part === p.id).map((c) => h('option', { value: c.id }, `${c.number}. ${c.title}${stored.has(c.id) ? ' (replace)' : ''}`)),
                  ),
                ),
              )
            );
            const go = button({
              label: 'Add',
              size: 's',
              variant: 'primary',
              onClick: async () => {
                if (!sel.value) {
                  sel.focus();
                  toast('Choose the chapter this file belongs to.');
                  return;
                }
                go.disabled = true;
                const [next] = await importPdfFiles([res.file], { chapters: chapterRefs, chapterFor: () => sel.value });
                all.push(next);
                await refresh();
                paint(next);
              },
            });
            li.append(h('div', { class: 'book-result-fix' }, sel, go));
          }
        };
        paint(r);
        return li;
      }

      listEl.append(...results.map((r) => resultRow(r)));
      const okCount = results.filter((r) => r.status === 'added' || r.status === 'replaced').length;
      const undoBtn = button({
        label: 'Undo',
        icon: 'undo',
        variant: 'ghost',
        onClick: async () => {
          const n = await undoImport(all);
          await refresh();
          void ref?.close('undo');
          toast(n ? `Undone: ${plural(n, 'chapter')} restored as before.` : 'Nothing to undo.');
        },
      });
      const done = button({ label: 'Done', variant: 'primary', onClick: () => void ref?.close('done') });
      ref = sheet({
        title: okCount ? `Added ${plural(okCount, 'PDF')}` : 'Check these files',
        content: h('div', { class: 'book-results-wrap' }, h('p', { class: 'book-results-lead' }, 'Each file was matched to a chapter by its name.'), listEl),
        actions: [undoBtn, done],
        size: 'm',
      });
      ref.el.classList.add('book-results-sheet');
    }

    /* ---------------- the whole book ---------------- */

    async function chooseWholeBook() {
      const [file] = await pickPdfFiles({ multiple: false });
      if (file) await runWholeImport(file, { requireMatch: false });
    }

    /**
     * A progress sheet for a long book task. Closing it lets the task finish in the background.
     * @param {string} title
     */
    function progressSheet(title) {
      const status = h('p', { class: 'book-progress-status', role: 'status', 'aria-live': 'polite' }, 'Opening the PDF…');
      const barSlot = h('div', { class: 'book-progress-bar' }, spinner({ label: '' }));
      const note = h('p', { class: 'book-progress-note' }, 'Only the pages needed are read, so this takes a moment even for a large book. You can close this; it keeps going.');
      let closed = false;
      const ref = sheet({
        title,
        content: h('div', { class: 'book-progress' }, barSlot, status, note),
        size: 's',
        onClose: () => {
          closed = true;
        },
      });
      ref.el.classList.add('book-progress-sheet');
      return {
        /** @param {{ phase: string, done?: number, total?: number }} p */
        update(p) {
          if (closed) return;
          if (p.phase === 'find' && p.total) {
            status.textContent = `Finding chapters… ${p.done}/${p.total}`;
            barSlot.replaceChildren(progressBar(Math.round(((p.done || 0) / p.total) * 100), { label: 'Finding chapters' }));
          } else if (p.phase === 'save') {
            if (!/^Finding/.test(status.textContent || '')) status.textContent = 'Saving the book on this device…';
          } else if (p.phase === 'open') {
            status.textContent = 'Opening the PDF…';
          }
        },
        saving() {
          if (!closed) status.textContent = 'Saving the book on this device… (a large file can take a minute)';
        },
        close: () => (closed ? Promise.resolve() : ref.close('done')),
      };
    }

    /**
     * Imports one PDF as the whole book, then shows the chapter pages.
     * @param {File} file
     * @param {{ requireMatch: boolean }} opts `requireMatch`: only when it looks like the book (from Add PDFs, drop, share).
     */
    async function runWholeImport(file, { requireMatch }) {
      addBtn.disabled = true;
      addBookBtn.disabled = true;
      const prog = progressSheet('Adding your book');
      let res = null;
      try {
        res = await importWholeBook(file, {
          chapters: bookRefs,
          requireMatch,
          onProgress: (p) => {
            prog.update(p);
            if (p.phase === 'find' && p.done === p.total) prog.saving();
          },
        });
      } catch (err) {
        await prog.close();
        const e = /** @type {any} */ (err);
        if (e?.code === 'not-book' || (requireMatch && e?.code === 'too-short')) {
          if (e.code === 'too-short') {
            // Not the book: a normal chapter import.
            await runImport([file]);
            return;
          }
          toast(`“${file.name}” doesn’t look like the book: its chapters couldn’t be found.`, {
            duration: 9000,
            action: { label: 'Add as the book', onClick: () => void runWholeImport(file, { requireMatch: false }) },
          });
          return;
        }
        if (e?.code !== 'error') console.warn('[book] whole book import:', e?.code);
        else console.warn('[book] whole book import failed', err);
        toast(e?.userMessage || "The book couldn't be added. Please try again.", { kind: 'danger', duration: 8000 });
        return;
      } finally {
        addBtn.disabled = false;
        addBookBtn.disabled = false;
      }
      await prog.close();
      await refresh();
      if (destroyed) return;
      const missing = res.missing.length;
      toast(
        missing
          ? `Added the book. ${res.found} chapters found; ${missing} need their pages set.`
          : `Added the book: all ${bookRefs.length} chapters are ready.`,
        { kind: 'success', duration: 6000 },
      );
      showMap({ fresh: true });
    }

    async function findAgain() {
      const prog = progressSheet('Finding chapters');
      try {
        const res = await redetectWholeBook({ chapters: bookRefs, onProgress: (p) => prog.update(p) });
        await prog.close();
        await refresh();
        if (destroyed) return;
        toast(`${res.found} of ${bookRefs.length} chapters found.`, { kind: 'success' });
        showMap();
      } catch (err) {
        await prog.close();
        console.warn('[book] find chapters failed', err);
        toast(/** @type {any} */ (err)?.userMessage || "The chapters couldn't be found. Please try again.", { kind: 'danger' });
      }
    }

    /**
     * The chapter-pages sheet: every chapter with its PDF pages, status and a manual start field.
     * @param {{ focus?: string, fresh?: boolean }} [opts]
     */
    function showMap({ focus, fresh = false } = {}) {
      const b = book();
      if (!b) return;
      const pages = Number(b.pages) || Number(b.map?.pages) || 0;
      /** @type {Record<string, { from: number, to: number, how: string }>} */
      let ranges = { ...(b.map?.chapters || {}) };
      const lead = h('p', { class: 'book-map-lead' });
      const listEl = h('ol', { class: 'book-map-list' });
      /** @type {{ close: (r?: string) => Promise<void>, el: HTMLElement } | null} */
      let ref = null;
      /** @type {string | null} */
      let editing = focus || null;

      const paintLead = () => {
        const found = bookRefs.filter((c) => ranges[c.id]).length;
        const estimated = bookRefs.filter((c) => ranges[c.id]?.how === 'estimated').length;
        const missing = bookRefs.length - found;
        lead.replaceChildren(
          h('strong', null, missing ? `${found} of ${bookRefs.length} chapters found.` : `All ${bookRefs.length} chapters have their pages.`),
          ' ',
          missing || estimated
            ? 'Check the chapters marked Estimated or Not found: type the PDF page where each one starts. The others adjust with it.'
            : 'Each chapter opens at these pages of your PDF.',
          ' Pages before Chapter 1 are never shown in the app.',
        );
      };

      /**
       * @param {string} id
       * @param {number | null} from
       */
      async function setStart(id, from) {
        const before = { ...ranges };
        const next = adjustRanges(bookRefs, ranges, id, from, pages);
        try {
          await wholeBookRepo.setMap({ version: 1, pages, detected: b.map?.detected ?? Date.now(), chapters: next });
        } catch (err) {
          console.warn('[book] map not saved', err);
          toast("The pages couldn't be saved. Please try again.", { kind: 'danger' });
          return;
        }
        ranges = next;
        editing = null;
        whole = await wholeBookRepo.meta().catch(() => whole);
        paint();
        void refresh();
        const c = bookRefs.find((x) => x.id === id);
        undoToast(`Chapter ${c?.number} ${from ? `starts on PDF page ${from}` : 'cleared'}.`, async () => {
          try {
            await wholeBookRepo.setMap({ version: 1, pages, detected: b.map?.detected ?? Date.now(), chapters: before });
            ranges = before;
            whole = await wholeBookRepo.meta().catch(() => whole);
            if (ref?.el.isConnected) paint();
            void refresh();
          } catch (err) {
            console.warn('[book] undo map failed', err);
          }
        });
      }

      /** @param {import('../features/book/wholebook.js').BookChapterRef} c */
      function row(c) {
        const r = ranges[c.id];
        const how = r ? r.how : 'missing';
        const statusText = r ? HOW_LABEL[/** @type {keyof typeof HOW_LABEL} */ (how)] || 'Found' : 'Not found';
        const own = stored.has(c.id);
        const li = h('li', { class: ['book-map-row', `is-${r ? (how === 'estimated' ? 'estimated' : how === 'manual' ? 'manual' : 'found') : 'missing'}`], dataset: { id: c.id } });
        const where = r
          ? `PDF pages ${r.from}–${r.to} · book pp. ${c.page}–${c.page + (r.to - r.from)}`
          : `Book p. ${c.page} · not found in the PDF`;
        const fixBtn = button({
          label: r ? 'Adjust' : 'Set',
          size: 's',
          variant: r ? 'ghost' : 'primary',
          ariaLabel: `${r ? 'Adjust' : 'Set'} the first page of Chapter ${c.number}`,
          onClick: () => {
            editing = editing === c.id ? null : c.id;
            paint();
            /** @type {HTMLInputElement | null} */ (listEl.querySelector(`[data-id="${c.id}"] input`))?.focus();
          },
        });
        fixBtn.classList.add('book-map-fix');
        li.append(
          h('span', { class: 'book-map-num num-display', 'aria-hidden': 'true' }, String(c.number)),
          h(
            'div',
            { class: 'book-map-text' },
            h('span', { class: 'book-map-title' }, c.title),
            h(
              'span',
              { class: 'book-map-line' },
              h('span', { class: ['book-map-chip', `is-${r ? how : 'missing'}`] }, statusText),
              h('span', { class: 'book-map-where' }, where),
            ),
            own ? h('span', { class: 'book-map-own' }, 'Opens its own PDF (added separately)') : null,
          ),
          fixBtn,
        );
        if (editing === c.id) {
          const inputId = `book-map-in-${c.id}`;
          const input = /** @type {HTMLInputElement} */ (
            h('input', {
              type: 'number',
              id: inputId,
              class: 'book-map-input',
              min: '1',
              max: String(pages),
              inputmode: 'numeric',
              value: r ? String(r.from) : '',
              placeholder: 'Page',
            })
          );
          const msg = h('span', { class: 'book-map-msg', role: 'status' }, `1 to ${pages}: the PDF page (as your PDF app counts them) where “Chapter ${c.number}” begins.`);
          const apply = () => {
            const n = Number.parseInt(input.value, 10);
            if (!Number.isInteger(n) || n < 1 || n > pages) {
              msg.textContent = `Type a page from 1 to ${pages}.`;
              msg.classList.add('is-problem');
              input.focus();
              return;
            }
            void setStart(c.id, n);
          };
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              apply();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              editing = null;
              paint();
            }
          });
          const save = button({ label: 'Save', size: 's', variant: 'primary', onClick: apply });
          const clear = r && r.how === 'manual' ? button({ label: 'Use the estimate', size: 's', variant: 'ghost', onClick: () => void setStart(c.id, null) }) : null;
          li.append(
            h(
              'div',
              { class: 'book-map-edit' },
              h('label', { class: 'book-map-label', for: inputId }, 'Starts on PDF page'),
              h('div', { class: 'book-map-edit-row' }, input, save, clear),
              msg,
            ),
          );
        }
        return li;
      }

      function paint() {
        paintLead();
        listEl.replaceChildren(...bookRefs.map((c) => row(c)));
      }
      paint();

      const again = button({ label: 'Find again', icon: 'refresh', variant: 'ghost', onClick: async () => {
        await ref?.close('again');
        void findAgain();
      } });
      const done = button({ label: 'Done', variant: 'primary', onClick: () => void ref?.close('done') });
      ref = sheet({
        title: fresh ? 'Your book’s chapters' : 'Chapter pages',
        content: h('div', { class: 'book-map' }, lead, listEl),
        actions: [again, done],
        size: 'l',
      });
      ref.el.classList.add('book-map-sheet');
      const target = focus || (fresh ? bookRefs.find((c) => !ranges[c.id])?.id : null);
      if (target) {
        requestAnimationFrame(() => {
          const el = /** @type {HTMLElement | null} */ (listEl.querySelector(`[data-id="${target}"]`));
          el?.scrollIntoView({ block: 'center' });
          /** @type {HTMLInputElement | null} */ (el?.querySelector('input'))?.focus({ preventScroll: true });
        });
      }
    }

    /** @param {HTMLElement} from */
    function openBookMenu(from) {
      const b = book();
      if (!b) return;
      /** @type {{ close: (r?: string) => Promise<void>, el: HTMLElement } | null} */
      let ref = null;
      /**
       * @param {string} iconName
       * @param {string} label
       * @param {string} sub
       * @param {() => void} fn
       * @param {boolean} [danger]
       */
      const item = (iconName, label, sub, fn, danger = false) =>
        h(
          'button',
          {
            type: 'button',
            class: ['book-menu-item', danger && 'is-danger'],
            onClick: async () => {
              await ref?.close('pick');
              fn();
            },
          },
          h('span', { class: 'book-menu-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 20 })),
          h('span', { class: 'book-menu-text' }, h('span', { class: 'book-menu-label' }, label), sub ? h('span', { class: 'book-menu-sub' }, sub) : null),
        );
      ref = sheet({
        title: 'The whole book',
        content: h(
          'div',
          { class: 'book-menu', role: 'group' },
          item('target', 'Check chapter pages', 'See and adjust where each chapter starts.', () => showMap()),
          item('search', 'Find chapters again', 'Look for every chapter in the PDF again. Pages you set are replaced.', () => void findAgain()),
          item('upload', 'Replace the book’s PDF', 'Choose another file. Your notes stay.', () => void chooseWholeBook()),
          item('trash', 'Remove the book from this device', 'Frees space. Your notes are kept for when you add it again.', () => removeWholeBook(), true),
        ),
        size: 's',
        onClose: () => from?.isConnected && from.focus?.({ preventScroll: true }),
      });
      ref.el.classList.add('book-menu-sheet');
    }

    function removeWholeBook() {
      clearTimeout(removal.timer);
      removal.pending = true;
      void refresh();
      removal.timer = window.setTimeout(() => {
        if (!removal.pending) return;
        wholeBookRepo
          .remove()
          .catch((err) => {
            console.warn('[book] remove failed', err);
            toast("The book couldn't be removed. Please try again.", { kind: 'danger' });
          })
          .finally(() => {
            removal.pending = false;
          });
      }, REMOVE_DELAY_MS);
      undoToast('Removed the book from this device. Your notes are kept.', () => {
        clearTimeout(removal.timer);
        removal.pending = false;
        void refresh();
      });
    }

    /* ---------------- chapter menu ---------------- */

    /**
     * @param {Chapter} ch
     * @param {HTMLElement} [from]
     */
    function openMenu(ch, from) {
      const meta = stored.get(ch.id);
      /** @type {{ close: (r?: string) => Promise<void>, el: HTMLElement } | null} */
      let ref = null;
      /**
       * @param {string} iconName
       * @param {string} label
       * @param {string} sub
       * @param {() => void} fn
       * @param {boolean} [danger]
       */
      const item = (iconName, label, sub, fn, danger = false) =>
        h(
          'button',
          {
            type: 'button',
            class: ['book-menu-item', danger && 'is-danger'],
            onClick: async () => {
              await ref?.close('pick');
              fn();
            },
          },
          h('span', { class: 'book-menu-icon', 'aria-hidden': 'true' }, icon(iconName, { size: 20 })),
          h('span', { class: 'book-menu-text' }, h('span', { class: 'book-menu-label' }, label), sub ? h('span', { class: 'book-menu-sub' }, sub) : null),
        );
      const range = bookRange(ch.id);
      const items = range
        ? [
            item('book', 'Open', `Pages ${range.from}–${range.to} of your book’s PDF`, () => openChapter(ch)),
            item('download', 'Export annotated copy', 'A new PDF of this chapter with your notes drawn in. The book stays as it is.', () => void exportCopy(ch)),
            item('target', 'Check this chapter’s pages', 'Adjust where it starts in your book’s PDF.', () => showMap({ focus: ch.id })),
            item('upload', 'Use a separate PDF for this chapter', 'Opens instead of the book’s pages. Your notes stay.', () => void addFor(ch)),
          ]
        : meta
        ? [
            item('book', 'Open', meta.pages ? `Page ${meta.lastPage || 1} of ${meta.pages}` : '', () => openChapter(ch)),
            item('upload', 'Replace PDF', 'Choose a new file for this chapter. Your notes stay.', () => void addFor(ch)),
            item('download', 'Export annotated copy', 'A new PDF with your notes drawn in. The original stays as it is.', () => void exportCopy(ch)),
            item('trash', 'Remove from this device', 'Frees space. Your notes are kept for when you add it again.', () => void removePdf(ch), true),
          ]
        : book()
          ? [
              item('target', 'Set its pages in your book', 'Type the PDF page where this chapter starts.', () => showMap({ focus: ch.id })),
              item('upload', 'Add PDF', 'Choose this chapter’s own PDF file.', () => void addFor(ch)),
            ]
          : [item('upload', 'Add PDF', 'Choose this chapter’s PDF file.', () => void addFor(ch))];
      ref = sheet({
        title: chapterLabel(ch),
        content: h('div', { class: 'book-menu', role: 'group' }, items),
        size: 's',
        onClose: () => from?.isConnected && from.focus?.({ preventScroll: true }),
      });
      ref.el.classList.add('book-menu-sheet');
    }

    /** @param {Chapter} ch */
    async function exportCopy(ch) {
      const { exportAnnotatedCopy } = await import('../features/book/export.js');
      await exportAnnotatedCopy(ch.id, { title: `Chapter ${ch.number} - ${ch.title}` });
    }

    /** @param {Chapter} ch */
    async function removePdf(ch) {
      let rec = null;
      try {
        rec = await bookRepo.get(ch.id);
        await bookRepo.remove(ch.id);
      } catch (err) {
        console.warn('[book] remove failed', err);
        toast("The PDF couldn't be removed. Please try again.", { kind: 'danger' });
        return;
      }
      await refresh();
      const keep = rec;
      undoToast(`Removed Chapter ${ch.number}'s PDF. Your notes are kept.`, async () => {
        if (!keep?.blob) return;
        try {
          await bookRepo.put(keep);
          await refresh();
        } catch (err) {
          console.warn('[book] undo remove failed', err);
          toast("The PDF couldn't be put back. Add it again from your files.", { kind: 'danger' });
        }
      });
    }

    /* ---------------- drag & drop ---------------- */

    const root = h(
      'div',
      { class: 'book' },
      hero,
      wholeSlot,
      continueSlot,
      emptyNote,
      h('div', { class: 'book-list-head' }, h('h2', { class: 'book-h2' }, 'Chapters'), filter),
      filterStatus,
      list,
      noMatch,
      h(
        'p',
        { class: 'book-foot' },
        'Your PDFs are kept only on this device. They are not uploaded anywhere. Chapter PDFs are in backups only if you choose to include them; the whole book is never in backups (keep your original file).',
      ),
    );

    root.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) {
        e.preventDefault();
        root.classList.add('is-drop');
      }
    });
    root.addEventListener('dragleave', (e) => {
      if (e.target === root) root.classList.remove('is-drop');
    });
    root.addEventListener('drop', (e) => {
      root.classList.remove('is-drop');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      void runImport(files);
    });

    renderParts();
    renderHero();
    applyFilter();

    // Links into the Book tab: shared files, the chapter-pages sheet, "Add the whole book".
    const q = ctx?.query || {};
    if (q.import || q.pages || q.add) {
      navigate('/book', { replace: true, silent: true });
      requestAnimationFrame(() => {
        if (destroyed) return;
        if (q.import) void importShared(q.import);
        else if (q.pages && book()) showMap({ focus: q.pages });
        else if (q.add === 'book' && !addBookBtn.hidden) {
          addBookBtn.focus();
          addBookBtn.classList.add('is-pointed');
        }
      });
    }

    /** @param {string} id */
    async function importShared(id) {
      if (!isShareId(id)) {
        toast("The shared PDF couldn't be received. Share it again, or add it here with Add PDFs.", { kind: 'danger', duration: 8000 });
        return;
      }
      const files = await takeSharedFiles(id);
      if (destroyed) return;
      if (!files.length) {
        toast("The shared PDF wasn't found. Share it again, or add it here with Add PDFs.", { kind: 'danger', duration: 8000 });
        return;
      }
      await runImport(files);
    }

    // Restore the scroll position once the list is in the page.
    const y = memory.scrollY;
    requestAnimationFrame(() => {
      if (!destroyed && y > 0) window.scrollTo(0, y);
    });

    return {
      el: root,
      keepScroll: true,
      destroy() {
        destroyed = true;
        memory.scrollY = window.scrollY;
        clearTimeout(refreshTimer);
        offStore();
      },
    };
  },
};
