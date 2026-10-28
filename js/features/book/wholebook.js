/**
 * "Add the whole book once" (docs/ARCHITECTURE.md §7.17): the owner's single
 * PDF of the whole book is stored once on the device; every chapter opens as a
 * page range of it.
 *
 * - **Chapter detection** ({@link detectChapterStarts}): for each chapter (book
 *   page from `data/index.json`), cheap probes near `bookPage + offset`, never a
 *   scan of the whole book. Page labels (`doc.getPageLabels()`) are used when the
 *   PDF has them. Otherwise the printed page numbers (folios: numbers in the top
 *   or bottom band of a page) give the offset; the chapter title on the first page
 *   confirms it. The offset is expected to stay constant within a volume and is
 *   re-derived where it changes (Volume 2 has its own front matter). Chapters
 *   that can't be confirmed get an estimate from a neighbour's offset, or none.
 * - **Ranges** ({@link computeRanges}): a chapter runs to the page before the
 *   next chapter (never longer than its printed length, so the next volume's
 *   front matter is never inside a chapter); the last chapter runs to the end.
 * - **Privacy**: front-matter pages (before chapter 1) are never shown, searched,
 *   listed or kept in the outline; probes start well inside the book.
 * - **Import** ({@link importWholeBook}): checks, range-opens the file (only the
 *   probed pages are read), detects, and stores the Blob once
 *   (`wholeBookRepo`), with the map and the outline of the chapter pages.
 * - **Share target inbox** ({@link takeSharedFiles}): PDFs shared to the
 *   installed app on Android are stashed by sw.js in Cache Storage and picked up here.
 *
 * The detection, range and matching helpers are pure (no DOM, no IndexedDB at
 * import time), so they are unit-tested in Node with fake page readers.
 *
 * @module features/book/wholebook
 */

import { wholeBookRepo, checkWholeBookInput } from '../../core/store/repo.js';

/** A PDF with at least this many pages is treated as the whole book (one chapter is far shorter). */
export const WHOLE_BOOK_MIN_PAGES = 150;
/** Top and bottom share of a page where printed page numbers are looked for. */
export const FOLIO_BAND = 0.12;
/** Share of a title's words that must appear on a page to count as the chapter's title. */
export const TITLE_MIN = 0.75;
/** Cache Storage name of the share-target inbox (sw.js keeps it across updates). */
export const SHARE_CACHE = 'cmcq-share-inbox';
/** Path prefix of shared files inside the inbox (relative to the app). */
export const SHARE_PREFIX = '__share/';
/** Shared files older than this are dropped from the inbox (ms). */
const SHARE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Probe steps (PDF pages after the guess) when no offset is known yet: skip likely front matter first. */
const FIRST_PROBES = Object.freeze([40, 60, 80, 100, 30, 120, 150, 200, 20]);
/** Probe steps when the offset changed (e.g. the next volume's front matter). */
const NEXT_PROBES = Object.freeze([1, 3, 6, 10, 15, 20, 30, 40, 50, 60, 80, 100, -1, -3, -6, -10]);
/** Small words ignored when matching titles. */
const STOP = new Set(['and', 'the', 'of', 'with', 'for', 'in', 'on', 'to', 'a', 'an', 'or', 'from', 'by', 'at', 'its', 'their', 'other', 'forms']);

/**
 * @typedef {{ id: string, number: number, title: string, page: number, volume?: number | null }} BookChapterRef
 *   `page` = first printed book page (data/index.json).
 * @typedef {{ text: string, folios: number[] }} PageFacts
 * @typedef {{ from: number, how: 'labels' | 'confirmed' | 'folio' | 'title' | 'estimated' | 'manual' }} ChapterStart
 * @typedef {{ from: number, to: number, how: string }} ChapterRange
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Lower-case words (letters and digits) of a text. Pure.
 * @param {unknown} text
 * @returns {string[]}
 */
export function wordsOf(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The words of a title that are worth matching (no small words, no duplicates). Pure.
 * @param {string} title
 * @returns {string[]}
 */
export function titleWords(title) {
  return [...new Set(wordsOf(title).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

/**
 * Share (0–1) of a title's words found on a page. Pure.
 * @param {string} text Page text.
 * @param {string} title
 * @returns {number}
 */
export function titleScore(text, title) {
  const want = titleWords(title);
  if (!want.length) return 0;
  const have = new Set(wordsOf(text));
  return want.filter((w) => have.has(w)).length / want.length;
}

/**
 * Plain text and printed page numbers of a page from PDF.js text items. Pure.
 * Numbers count as folios only inside the top or bottom {@link FOLIO_BAND} of the
 * page, as whole tokens of 1–4 digits (not part of a decimal, range or a word).
 * @param {{ str?: string, transform?: number[] }[]} items PDF.js `getTextContent().items`.
 * @param {number[]} view Page box `[x0, y0, x1, y1]` (PDF.js `page.view`).
 * @returns {PageFacts}
 */
export function pageFacts(items, view) {
  const [, y0 = 0, , y1 = 792] = Array.isArray(view) ? view : [];
  const height = y1 - y0 || 792;
  /** @type {Set<number>} */
  const folios = new Set();
  const parts = [];
  for (const it of Array.isArray(items) ? items : []) {
    const str = typeof it?.str === 'string' ? it.str : '';
    if (!str) continue;
    parts.push(str);
    const y = Array.isArray(it.transform) ? Number(it.transform[5]) : NaN;
    if (!Number.isFinite(y)) continue;
    const rel = (y - y0) / height;
    if (rel > FOLIO_BAND && rel < 1 - FOLIO_BAND) continue;
    for (const m of str.matchAll(/(?<![\p{L}\p{N}.,\-–/])(\d{1,4})(?![\p{L}\p{N}%]|[.,]\d|[-–/]\d)/gu)) {
      const n = Number(m[1]);
      if (n >= 1) folios.add(n);
    }
  }
  return { text: parts.join(' '), folios: [...folios] };
}

/**
 * Chapter starts from PDF page labels: the first page (after the previous
 * chapter's) whose label is the chapter's printed first page. Pure.
 * @param {(string | null)[] | null} labels One label per PDF page (PDF.js `getPageLabels()`).
 * @param {BookChapterRef[]} chapters In book order.
 * @returns {Map<string, number>} chapter id → PDF page (1-based).
 */
export function labelStarts(labels, chapters) {
  /** @type {Map<string, number>} */
  const out = new Map();
  if (!Array.isArray(labels) || !labels.length) return out;
  /** @type {Map<string, number[]>} */
  const where = new Map();
  labels.forEach((l, i) => {
    const key = typeof l === 'string' ? l.trim() : '';
    if (!/^\d+$/.test(key)) return;
    const k = String(Number(key));
    const list = where.get(k);
    if (list) list.push(i + 1);
    else where.set(k, [i + 1]);
  });
  let prev = 0;
  for (const c of chapters) {
    const hit = (where.get(String(c.page)) || []).find((p) => p > prev);
    if (hit) {
      out.set(c.id, hit);
      prev = hit;
    }
  }
  return out;
}

/**
 * Fills chapters without a detected start from a neighbour's offset (the
 * nearest found chapter of the same volume, else the nearest found chapter),
 * keeping the starts in book order. Pure.
 * @param {BookChapterRef[]} chapters In book order.
 * @param {Map<string, ChapterStart>} starts Detected starts (not modified).
 * @param {number} numPages
 * @returns {Map<string, ChapterStart>} Detected + estimated starts.
 */
export function estimateMissing(chapters, starts, numPages) {
  /** @type {Map<string, ChapterStart>} */
  const out = new Map(starts);
  const found = chapters.map((c, i) => ({ c, i, s: starts.get(c.id) })).filter((x) => x.s);
  if (!found.length) return out;
  chapters.forEach((c, i) => {
    if (out.has(c.id)) return;
    const vol = c.volume ?? null;
    /** @param {(x: typeof found[number]) => boolean} ok */
    const nearest = (ok) => found.filter(ok).sort((a, b) => Math.abs(a.i - i) - Math.abs(b.i - i) || a.i - b.i)[0];
    const pick = nearest((x) => (x.c.volume ?? null) === vol) || nearest(() => true);
    if (!pick) return;
    const from = c.page + (/** @type {ChapterStart} */ (pick.s).from - pick.c.page);
    const before = [...chapters.slice(0, i)].reverse().find((x) => out.has(x.id));
    const after = chapters.slice(i + 1).find((x) => out.has(x.id));
    const lo = before ? /** @type {ChapterStart} */ (out.get(before.id)).from : 0;
    const hi = after ? /** @type {ChapterStart} */ (out.get(after.id)).from : numPages + 1;
    if (from > lo && from < hi && from >= 1 && from <= numPages) out.set(c.id, { from, how: 'estimated' });
  });
  return out;
}

/**
 * Page ranges of the chapters from their starts. A chapter ends before the
 * next known start and is never longer than its printed length
 * (`next.page − page`); the last chapter runs to the end of the PDF. Pure.
 * @param {BookChapterRef[]} chapters In book order.
 * @param {Map<string, ChapterStart>} starts
 * @param {number} numPages
 * @returns {Record<string, ChapterRange>}
 */
export function computeRanges(chapters, starts, numPages) {
  /** @type {Record<string, ChapterRange>} */
  const out = {};
  chapters.forEach((c, i) => {
    const s = starts.get(c.id);
    if (!s || !(s.from >= 1 && s.from <= numPages)) return;
    const next = chapters[i + 1];
    let to = numPages;
    if (next && next.page > c.page) to = Math.min(to, s.from + (next.page - c.page) - 1);
    const later = chapters.slice(i + 1).map((x) => starts.get(x.id)).find((x) => x && x.from > s.from);
    if (later) to = Math.min(to, later.from - 1);
    out[c.id] = { from: s.from, to: Math.max(s.from, to), how: s.how };
  });
  return out;
}

/**
 * A chapter's page range in the whole book, or null. Pure.
 * @param {{ map?: { chapters?: Record<string, ChapterRange> } | null } | null | undefined} meta Whole-book metadata.
 * @param {string} chapterId
 * @returns {ChapterRange | null}
 */
export function rangeOf(meta, chapterId) {
  const r = meta?.map?.chapters?.[chapterId];
  return r && Number.isInteger(r.from) && Number.isInteger(r.to) && r.to >= r.from ? r : null;
}

/**
 * The outline entries inside a chapter's range, renumbered to pages within the chapter. Pure.
 * @param {{ title: string, page: number, level: number }[]} outline Whole-book outline (PDF pages).
 * @param {ChapterRange} range
 * @returns {{ title: string, page: number, level: number }[]}
 */
export function outlineFor(outline, range) {
  if (!Array.isArray(outline) || !range) return [];
  return outline.filter((o) => o.page >= range.from && o.page <= range.to).map((o) => ({ title: o.title, page: o.page - range.from + 1, level: o.level }));
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Finds the first PDF page of every chapter with a few cheap probes.
 * @param {{ chapters: BookChapterRef[], numPages: number,
 *   readPage: (pdfPage: number) => Promise<PageFacts>, getLabels?: () => Promise<(string | null)[] | null>,
 *   onProgress?: (done: number, total: number, chapter: BookChapterRef, start: ChapterStart | null) => void,
 *   signal?: AbortSignal }} opts
 * @returns {Promise<{ starts: Map<string, ChapterStart>, reads: number }>} Only detected starts (no estimates).
 */
export async function detectChapterStarts({ chapters, numPages, readPage, getLabels, onProgress, signal }) {
  /** @type {Map<number, Promise<PageFacts | null>>} */
  const cache = new Map();
  let reads = 0;
  /** @param {number} p @returns {Promise<PageFacts | null>} */
  const read = (p) => {
    if (!(p >= 1 && p <= numPages)) return Promise.resolve(null);
    let r = cache.get(p);
    if (!r) {
      reads++;
      r = readPage(p).catch(() => ({ text: '', folios: [] }));
      cache.set(p, r);
    }
    return r;
  };
  /** @param {PageFacts | null} f @param {number} n */
  const has = (f, n) => Boolean(f && f.folios.includes(n));

  let labels = null;
  try {
    labels = getLabels ? await getLabels() : null;
  } catch {
    labels = null;
  }
  const fromLabels = labelStarts(labels, chapters);

  /** @type {Map<string, ChapterStart>} */
  const starts = new Map();
  /** @type {number | null} */
  let offset = null;
  let prevFrom = 0;

  /**
   * @param {BookChapterRef} c
   * @param {number} p
   * @returns {Promise<ChapterStart | null>}
   */
  const verify = async (c, p) => {
    if (!(p > prevFrom && p <= numPages)) return null;
    const [a, b, d] = await Promise.all([read(p), read(p + 1), read(p + 2)]);
    const hits = (has(a, c.page) ? 1 : 0) + (has(b, c.page + 1) ? 1 : 0) + (has(d, c.page + 2) ? 1 : 0);
    const title = Boolean(a && titleScore(a.text, c.title) >= TITLE_MIN);
    if (hits >= 1 && title) return { from: p, how: 'confirmed' };
    if (hits >= 2) return { from: p, how: 'folio' };
    if (title && !(a && a.folios.length) && !(b && b.folios.length)) {
      // No printed numbers at all: the first page (going back) that carries the title.
      let q = p;
      for (let k = 0; k < 40 && q - 1 > prevFrom; k++) {
        const prev = await read(q - 1);
        if (prev && titleScore(prev.text, c.title) >= TITLE_MIN) q--;
        else break;
      }
      return { from: q, how: 'title' };
    }
    return null;
  };

  /**
   * Offsets suggested by printed numbers near a guess (two consecutive pages must agree).
   * @param {BookChapterRef} c
   * @param {number} guess
   * @param {readonly number[]} steps
   */
  async function* probe(c, guess, steps) {
    /** @type {Set<number>} */
    const tried = new Set();
    for (const step of steps) {
      if (signal?.aborted) return;
      const p = guess + step;
      if (!(p > prevFrom && p <= numPages)) continue;
      const f = await read(p);
      for (const n of f ? f.folios : []) {
        const o = p - n;
        if (tried.has(o) || !(c.page + o > prevFrom && c.page + o <= numPages)) continue;
        const [next, prev] = await Promise.all([read(p + 1), read(p - 1)]);
        if (!has(next, n + 1) && !has(prev, n - 1)) continue;
        tried.add(o);
        yield o;
      }
    }
  }

  for (let i = 0; i < chapters.length; i++) {
    if (signal?.aborted) throw new DOMException('Detection cancelled', 'AbortError');
    const c = chapters[i];
    /** @type {ChapterStart | null} */
    let found = null;
    const lab = fromLabels.get(c.id);
    if (lab && lab > prevFrom) found = { from: lab, how: 'labels' };
    if (!found && offset !== null) found = await verify(c, c.page + offset);
    if (!found) {
      const guess = c.page + (offset ?? 0);
      for await (const o of probe(c, guess, offset === null ? FIRST_PROBES : NEXT_PROBES)) {
        found = await verify(c, c.page + o);
        if (found) break;
      }
    }
    if (found && found.from > prevFrom) {
      starts.set(c.id, found);
      prevFrom = found.from;
      offset = found.from - c.page;
    } else {
      found = null;
    }
    try {
      onProgress?.(i + 1, chapters.length, c, found);
    } catch (err) {
      console.warn('[book] onProgress failed', err);
    }
  }
  return { starts, reads };
}

/**
 * Detection + estimates + ranges for an open document (PDF.js proxy).
 * @param {any} doc PDFDocumentProxy (range-loaded).
 * @param {BookChapterRef[]} chapters
 * @param {{ onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ map: { version: 1, pages: number, detected: number, chapters: Record<string, ChapterRange> },
 *   found: number, estimated: number, missing: string[], reads: number }>}
 */
export async function detectBookMap(doc, chapters, { onProgress, signal } = {}) {
  const numPages = Number(doc.numPages) || 0;
  const { starts, reads } = await detectChapterStarts({
    chapters,
    numPages,
    signal,
    getLabels: () => doc.getPageLabels(),
    readPage: async (p) => {
      const page = await doc.getPage(p);
      try {
        const content = await page.getTextContent({ includeMarkedContent: false });
        return pageFacts(content.items, page.view);
      } finally {
        page.cleanup?.();
      }
    },
    onProgress: (done, total) => onProgress?.(done, total),
  });
  const all = estimateMissing(chapters, starts, numPages);
  const ranges = computeRanges(chapters, all, numPages);
  return {
    map: { version: 1, pages: numPages, detected: Date.now(), chapters: ranges },
    found: starts.size,
    estimated: all.size - starts.size,
    missing: chapters.filter((c) => !ranges[c.id]).map((c) => c.id),
    reads,
  };
}

/**
 * Applies a manual start page to one chapter, then re-estimates every chapter
 * that was only estimated (or missing) from the detected and manual starts. Pure.
 * @param {BookChapterRef[]} chapters
 * @param {Record<string, ChapterRange>} ranges Current map ranges.
 * @param {string} chapterId
 * @param {number | null} from New first PDF page (null clears the chapter).
 * @param {number} numPages
 * @returns {Record<string, ChapterRange>}
 */
export function adjustRanges(chapters, ranges, chapterId, from, numPages) {
  /** @type {Map<string, ChapterStart>} */
  const fixed = new Map();
  for (const c of chapters) {
    const r = ranges[c.id];
    if (c.id === chapterId) continue;
    if (r && r.how !== 'estimated') fixed.set(c.id, { from: r.from, how: /** @type {any} */ (r.how) });
  }
  if (Number.isInteger(from) && /** @type {number} */ (from) >= 1 && /** @type {number} */ (from) <= numPages) {
    fixed.set(chapterId, { from: /** @type {number} */ (from), how: 'manual' });
  }
  // Drop fixed starts that would break the book order around the manual one.
  const ordered = chapters.filter((c) => fixed.has(c.id));
  /** @type {Map<string, ChapterStart>} */
  const clean = new Map();
  let prev = 0;
  for (const c of ordered) {
    const s = /** @type {ChapterStart} */ (fixed.get(c.id));
    if (s.from > prev || c.id === chapterId) {
      if (c.id === chapterId) {
        // The manual one wins: remove earlier starts that are not before it.
        for (const [id, v] of [...clean]) if (v.from >= s.from) clean.delete(id);
      }
      clean.set(c.id, s);
      prev = s.from;
    }
  }
  return computeRanges(chapters, estimateMissing(chapters, clean, numPages), numPages);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * An import problem with a plain-language message.
 * @param {string} code
 * @param {string} message
 * @param {unknown} [cause]
 * @returns {Error & { code: string, userMessage: string }}
 */
function importError(code, message, cause) {
  const err = /** @type {Error & { code: string, userMessage: string }} */ (new Error(message, cause !== undefined ? { cause } : undefined));
  err.code = code;
  err.userMessage = message;
  return err;
}

/**
 * Free space check before storing a big file. Never throws for unknown estimates.
 * @param {number} bytes
 * @returns {Promise<void>}
 * @throws {Error} code 'no-space' when the browser says there isn't room.
 */
async function ensureSpace(bytes) {
  const storage = /** @type {any} */ (globalThis.navigator)?.storage;
  try {
    await storage?.persist?.();
  } catch {
    /* best effort */
  }
  try {
    const est = typeof storage?.estimate === 'function' ? await storage.estimate() : null;
    if (est && Number.isFinite(est.quota) && Number.isFinite(est.usage) && est.quota - est.usage < bytes * 1.05 + 32 * 1024 * 1024) {
      throw importError('no-space', 'There isn’t enough free space on this device for the book. Free up some space, then try again.');
    }
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'no-space') throw err;
  }
}

/**
 * Chapter refs for detection from `loadIndex({ includeUnpublished: true })`.
 * @param {{ parts: { id: string, volume?: number }[], chapters: { id: string, number: number, title: string, page?: number, part: string }[] }} index
 * @returns {BookChapterRef[]}
 */
export function chapterRefsOf(index) {
  const vol = new Map((index?.parts || []).map((p) => [p.id, p.volume ?? null]));
  return (index?.chapters || [])
    .filter((c) => Number.isInteger(c.page) && /** @type {number} */ (c.page) >= 1)
    .map((c) => ({ id: c.id, number: c.number, title: c.title, page: /** @type {number} */ (c.page), volume: vol.get(c.part) ?? null }))
    .sort((a, b) => a.page - b.page);
}

/**
 * Imports the whole book: checks the file, range-opens it (only the probed pages
 * are read), finds the chapters and stores the Blob once with the map.
 * Progress phases: `'open'`, `'find'` (done/total chapters), `'save'`.
 * With `requireMatch`, the file is only stored when it looks like the book (at
 * least 3 chapters found); otherwise it throws code `'not-book'` (nothing stored).
 * @param {Blob & { name?: string }} file
 * @param {{ chapters: BookChapterRef[], requireMatch?: boolean,
 *   onProgress?: (p: { phase: 'open' | 'find' | 'save', done?: number, total?: number }) => void, signal?: AbortSignal }} opts
 * @returns {Promise<{ meta: any, found: number, estimated: number, missing: string[], pages: number, reads: number }>}
 * @throws {Error & { code: string, userMessage: string }} codes: bad-input | empty | not-pdf | too-large |
 *   too-short | not-book | no-space | password | damaged | error
 */
export async function importWholeBook(file, { chapters, requireMatch = false, onProgress, signal } = /** @type {any} */ ({})) {
  await checkWholeBookInput(file);
  await ensureSpace(file.size);
  onProgress?.({ phase: 'open' });
  const { openPdf } = await import('./pdf.js');
  /** @type {any} */
  let doc;
  try {
    doc = await openPdf(file, { range: true });
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (code === 'password') throw importError('password', 'This PDF is locked with a password. Save a copy without the password, then add that copy.', err);
    if (code === 'invalid' || code === 'empty') throw importError('damaged', "This PDF looks damaged and can't be opened.", err);
    throw importError('error', /** @type {any} */ (err)?.userMessage || "This PDF couldn't be opened. Please try again.", err);
  }
  try {
    const pages = Number(doc.numPages) || 0;
    if (pages < WHOLE_BOOK_MIN_PAGES) {
      throw importError('too-short', `This PDF has only ${pages} pages, so it isn't the whole book. Add it as a chapter PDF instead.`);
    }
    /** @type {Promise<any> | null} */
    let saving = null;
    const save = () => {
      onProgress?.({ phase: 'save' });
      saving ??= wholeBookRepo.put({ blob: file, fileName: String(file.name ?? 'Book.pdf'), pages });
      return saving;
    };
    // Explicit "whole book": store while detecting (both read the file independently).
    if (!requireMatch) save().catch(() => {});
    const res = await detectBookMap(doc, chapters, { signal, onProgress: (done, total) => onProgress?.({ phase: 'find', done, total }) });
    if (requireMatch && res.found < 3) {
      throw importError('not-book', 'This PDF doesn’t look like the book: its chapters couldn’t be found.');
    }
    const firstStart = Math.min(...Object.values(res.map.chapters).map((r) => r.from), Infinity);
    const outline = await readChapterOutline(doc, firstStart);
    try {
      await save();
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e?.code === 'too-large') throw importError('too-large', e.userMessage, err);
      if (e?.name === 'QuotaExceededError' || e?.code === 'QuotaExceededError') {
        throw importError('no-space', 'There isn’t enough free space on this device for the book. Free up some space, then try again.', err);
      }
      throw importError('error', e?.userMessage || "The book couldn't be saved on this device. Please try again.", err);
    }
    const meta = await wholeBookRepo.setMap(res.map, { outline });
    return { meta, found: res.found, estimated: res.estimated, missing: res.missing, pages, reads: res.reads };
  } finally {
    doc.destroy?.().catch?.(() => {});
  }
}

/**
 * Runs the chapter detection again on the stored whole book (e.g. when the
 * first import was interrupted, or after "Find chapters again") and saves the map.
 * @param {{ chapters: BookChapterRef[], onProgress?: (p: { phase: 'open' | 'find', done?: number, total?: number }) => void,
 *   signal?: AbortSignal }} opts
 * @returns {Promise<{ meta: any, found: number, estimated: number, missing: string[], pages: number, reads: number }>}
 * @throws {Error & { code: string, userMessage: string }} code 'missing' when no whole book is stored.
 */
export async function redetectWholeBook({ chapters, onProgress, signal }) {
  const rec = await wholeBookRepo.get();
  if (!rec?.blob) throw importError('missing', 'The book isn’t on this device any more. Add it again.');
  onProgress?.({ phase: 'open' });
  const { openPdf } = await import('./pdf.js');
  /** @type {any} */
  let doc;
  try {
    doc = await openPdf(rec.blob, { range: true });
  } catch (err) {
    throw importError('error', /** @type {any} */ (err)?.userMessage || "The book couldn't be opened. Please try again.", err);
  }
  try {
    const res = await detectBookMap(doc, chapters, { signal, onProgress: (done, total) => onProgress?.({ phase: 'find', done, total }) });
    const firstStart = Math.min(...Object.values(res.map.chapters).map((r) => r.from), Infinity);
    const outline = await readChapterOutline(doc, firstStart);
    const meta = await wholeBookRepo.setMap(res.map, { outline });
    return { meta, found: res.found, estimated: res.estimated, missing: res.missing, pages: Number(doc.numPages) || 0, reads: res.reads };
  } finally {
    doc.destroy?.().catch?.(() => {});
  }
}

/**
 * The outline of the whole book, without entries before the first chapter
 * (front matter is never kept). Never throws.
 * @param {any} doc
 * @param {number} firstPage First chapter's first PDF page.
 * @returns {Promise<{ title: string, page: number, level: number }[]>}
 */
async function readChapterOutline(doc, firstPage) {
  try {
    const { readOutline } = await import('./pdf.js');
    const all = await readOutline(doc);
    return Number.isFinite(firstPage) ? all.filter((o) => o.page >= firstPage) : [];
  } catch {
    return [];
  }
}

/**
 * Number of pages of a PDF, read cheaply (range-loaded; only the file's
 * structure is read). null when it can't be opened.
 * @param {Blob} blob
 * @returns {Promise<number | null>}
 */
export async function pageCountOf(blob) {
  try {
    const { openPdf } = await import('./pdf.js');
    const doc = await openPdf(blob, { range: true });
    const n = Number(doc.numPages) || null;
    doc.destroy?.().catch?.(() => {});
    return n;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Share target inbox (Android: "Share" a PDF to the installed app)
// ---------------------------------------------------------------------------

/**
 * Whether a share id (from `#/book?import=<id>`) is well formed. Pure.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isShareId(id) {
  return typeof id === 'string' && /^[a-z0-9]{6,40}$/.test(id);
}

/**
 * Takes the files sw.js stashed for a share id out of the inbox (they are
 * deleted from it), and drops stale entries of earlier shares. Never throws.
 * @param {string} id
 * @returns {Promise<File[]>}
 */
export async function takeSharedFiles(id) {
  if (!isShareId(id) || typeof caches === 'undefined') return [];
  /** @type {File[]} */
  const files = [];
  try {
    const cache = await caches.open(SHARE_CACHE);
    const now = Date.now();
    for (const req of await cache.keys()) {
      const url = new URL(req.url);
      const m = /__share\/([a-z0-9]+)\/(\d+)$/.exec(url.pathname);
      if (!m) continue;
      if (m[1] === id) {
        const res = await cache.match(req);
        if (res) {
          const blob = await res.blob();
          let name = 'Shared.pdf';
          try {
            name = decodeURIComponent(res.headers.get('X-File-Name') || '') || name;
          } catch {
            /* keep the default */
          }
          files.push(new File([blob], name, { type: blob.type || 'application/pdf', lastModified: now }));
        }
        await cache.delete(req);
      } else {
        const ts = parseInt(m[1].slice(0, 9), 36);
        if (!Number.isFinite(ts) || now - ts > SHARE_MAX_AGE_MS) await cache.delete(req);
      }
    }
  } catch (err) {
    console.warn('[book] shared files could not be read', err);
  }
  return files;
}
