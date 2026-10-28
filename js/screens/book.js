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
import { bookRepo } from '../core/store/repo.js';
import { plural } from '../core/util.js';
import { setHeader } from '../ui/shell.js';
import { icon } from '../ui/icons.js';
import { button, iconButton, sheet, toast, undoToast, emptyState, spinner } from '../ui/components.js';
import { importPdfFiles, undoImport, loadBookData, pdfPageFor, formatBytes } from '../features/book/library.js';

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

export default {
  /**
   * @param {{ params: Record<string, string>, query: Record<string, string> }} _ctx
   */
  async render(_ctx) {
    setHeader({ title: 'Book' });

    /** @type {Awaited<ReturnType<typeof loadIndex>>} */
    let index;
    /** @type {BookMeta[]} */
    let metas = [];
    /** @type {Awaited<ReturnType<typeof loadBookData>>} */
    let bookData = { schemaVersion: 1, chapters: {} };
    try {
      [index, metas, bookData] = await Promise.all([
        loadIndex({ includeUnpublished: true }),
        bookRepo.all().catch((err) => {
          console.warn('[book] could not read the stored PDFs', err);
          toast("Your PDFs couldn't be read from this device. Reload the app to try again.", { kind: 'danger' });
          return [];
        }),
        loadBookData(),
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
    let destroyed = false;

    /* ---------------- hero ---------------- */

    const heroCount = h('span', { class: 'book-vital-value num-display' });
    const heroBytes = h('span', { class: 'book-vital-value num-display' });
    const addBtn = button({ label: 'Add PDFs', icon: 'upload', variant: 'primary', onClick: () => void chooseAndImport() });
    addBtn.classList.add('book-add');
    const continueSlot = h('div', { class: 'book-continue-slot' });
    const hero = h(
      'section',
      { class: 'book-hero', 'aria-labelledby': 'book-h1' },
      h(
        'div',
        { class: 'book-hero-text' },
        h('p', { class: 'book-eyebrow' }, `${index.parts.length} parts · ${chapters.length} chapters`),
        h('h1', { class: 'book-title', id: 'book-h1', tabindex: '-1' }, 'Your book'),
        h('p', { class: 'book-tagline' }, 'Read, highlight and annotate the chapter PDFs. They stay on this device and open offline.'),
      ),
      h('div', { class: 'book-hero-ecg', 'aria-hidden': 'true' }, h('span', { class: 'ecg-line' })),
      h(
        'dl',
        { class: 'book-vitals' },
        h('div', { class: 'book-vital' }, h('dt', { class: 'book-vital-label' }, 'On this device'), h('dd', { class: 'book-vital-dd' }, heroCount)),
        h('div', { class: 'book-vital' }, h('dt', { class: 'book-vital-label' }, 'Storage used'), h('dd', { class: 'book-vital-dd' }, heroBytes)),
      ),
      h('div', { class: 'book-hero-actions' }, addBtn),
    );

    const emptyNote = h(
      'p',
      { class: 'book-empty-note', role: 'note' },
      icon('info', { size: 20 }),
      h(
        'span',
        null,
        h('strong', null, 'Add your chapter PDFs: '),
        'tap Add PDFs and choose the files (several at once). Each is matched to its chapter by its name, e.g. “Chapter-01-….pdf”.',
      ),
    );

    function renderHero() {
      const n = stored.size;
      heroCount.replaceChildren(String(n), h('span', { class: 'book-vital-unit' }, ` / ${chapters.length}`));
      const bytes = [...stored.values()].reduce((s, m) => s + (Number(m.bytes) || 0), 0);
      heroBytes.textContent = n ? formatBytes(bytes) : '0 MB';
      emptyNote.hidden = n > 0;
      renderContinue();
    }

    function renderContinue() {
      const lastId = getSetting('bookLast');
      const recent = [...stored.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
      const meta = (typeof lastId === 'string' && stored.get(lastId)) || recent.find((m) => (m.lastPage || 1) > 1) || null;
      const ch = meta ? byId.get(meta.id) : null;
      if (!meta || !ch) {
        continueSlot.replaceChildren();
        return;
      }
      const pages = Number(meta.pages) || 0;
      const page = Math.max(1, Number(meta.lastPage) || 1);
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
      const out = memory.outlines.get(ch.id);
      if (out) return out.map((o) => ({ title: o.title, pdfPage: o.page, label: `PDF p. ${o.page}`, level: Math.min(2, o.level) }));
      return null;
    }

    /** @param {Chapter} ch */
    const hasSections = (ch) => Boolean(bookData.chapters?.[ch.id]?.sections.length) || stored.has(ch.id);

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
      if (!stored.has(ch.id)) {
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
        const meta = stored.get(ch.id);
        const isOpen = expanded.has(ch.id);
        li.classList.toggle('has-pdf', Boolean(meta));
        li.classList.toggle('is-open', isOpen);
        const pages = Number(meta?.pages) || 0;
        const page = Math.max(1, Number(meta?.lastPage) || 1);
        const pct = meta && pages ? Math.round((Math.min(page, pages) / pages) * 100) : 0;
        const range = pageRange(ch);
        const sub = meta
          ? h(
              'span',
              { class: 'book-ch-sub' },
              h('span', { class: 'book-ch-status is-ready' }, pages ? `Page ${page} of ${pages}` : 'Ready to read'),
              range ? h('span', { class: 'book-ch-range' }, ` · ${range}`) : null,
              pages ? h('span', { class: 'book-meter', style: { '--p': `${pct}%` }, 'aria-hidden': 'true' }) : null,
            )
          : h('span', { class: 'book-ch-sub' }, h('span', { class: 'book-ch-status' }, 'PDF not added'), range ? h('span', { class: 'book-ch-range' }, ` · ${range}`) : null);
        const mainLabel = meta
          ? `Chapter ${ch.number}, ${ch.title}. ${pages ? `Page ${page} of ${pages}.` : ''} Open`
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
              if (!meta) void addFor(ch);
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
        if (!meta) {
          const add = button({ label: 'Add PDF', size: 's', variant: 'secondary', onClick: () => void addFor(ch) });
          add.classList.add('book-ch-add');
          add.setAttribute('aria-label', `Add the PDF of Chapter ${ch.number}`);
          actions.append(add);
        }
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
        const has = stored.has(ch.id);
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
        const n = p.ids.filter((id) => stored.has(id)).length;
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
        const next = await bookRepo.all();
        if (destroyed) return;
        stored = new Map(next.map((m) => [m.id, m]));
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
      if (p?.store !== 'books') return;
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
      const pdfs = files.filter((f) => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name));
      if (!pdfs.length) {
        toast("These aren't PDF files. Choose the chapter PDFs.", { kind: 'danger' });
        return;
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
      const items = meta
        ? [
            item('book', 'Open', meta.pages ? `Page ${meta.lastPage || 1} of ${meta.pages}` : '', () => openChapter(ch)),
            item('upload', 'Replace PDF', 'Choose a new file for this chapter. Your notes stay.', () => void addFor(ch)),
            item('download', 'Export annotated copy', 'A new PDF with your notes drawn in. The original stays as it is.', () => void exportCopy(ch)),
            item('trash', 'Remove from this device', 'Frees space. Your notes are kept for when you add it again.', () => void removePdf(ch), true),
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
      continueSlot,
      emptyNote,
      h('div', { class: 'book-list-head' }, h('h2', { class: 'book-h2' }, 'Chapters'), filter),
      filterStatus,
      list,
      noMatch,
      h('p', { class: 'book-foot' }, 'Your PDFs are kept only on this device. They are not uploaded anywhere and are not in backups unless you choose to include them.'),
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
