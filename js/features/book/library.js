/**
 * Book library: matches the owner's chapter PDFs to chapters by file name,
 * imports them into the device (IndexedDB via `bookRepo`), and small helpers
 * for the Book tab (book page ↔ PDF page, sizes, storage estimate,
 * `data/book.json` loader). Contract: docs/ARCHITECTURE.md §7.17.
 *
 * The matching and page helpers are pure. Nothing touches `document`,
 * `window` or IndexedDB at import time, so this module is unit-testable in Node.
 *
 * @module features/book/library
 */

import { bookRepo, checkBookInput } from '../../core/store/repo.js';

/** Number of chapters in the book (the owner's table of contents). */
export const CHAPTER_COUNT = 55;
/** Chapter ids: `ch01` … `ch55`. */
const CHAPTER_ID = /^ch\d{2}$/;

/**
 * @typedef {{ id: string, number: number, title?: string }} ChapterRef
 * @typedef {{ title: string, page: number, level: 1 | 2 }} BookSection
 * @typedef {{ firstPage: number, sections: BookSection[], file?: string }} BookChapter
 * @typedef {{ schemaVersion: 1, chapters: Record<string, BookChapter> }} BookData
 * @typedef {'added' | 'replaced' | 'unchanged' | 'unmatched' | 'duplicate' | 'invalid' | 'too-large' | 'no-space' | 'error'} ImportStatus
 * @typedef {{ file: Blob & { name?: string }, name: string, chapterId: string | null, status: ImportStatus,
 *   record?: import('../../core/store/repo.js').BookRecord, previous?: import('../../core/store/repo.js').BookRecord | null,
 *   error?: Error & { userMessage?: string }, message?: string }} ImportResult
 */

// ---------------------------------------------------------------------------
// File name → chapter (pure)
// ---------------------------------------------------------------------------

/**
 * "Chapter 1", "Chapter-01", "chapter_01", "Chap. 3", "Ch.12", "ch01", "CH1".
 * The keyword must not be glued to a preceding letter or digit ("Research 12",
 * "Batch 3" don't count), and the number has at most two digits.
 */
const KEYWORD = /(?:^|[^\p{L}\p{N}])(?:chapter|chapt|chap|ch)(?:\.|\s|_|-|#|:|no\.?)*0*(\d{1,2})(?!\d)/giu;

/**
 * A number at the very start of the name: "01 - Anatomy", "1.pdf", "05_Mitral",
 * "3) Valves". Never a decimal ("1.5 notes"), never glued to letters ("3D"),
 * never three or more digits ("2019 notes").
 */
const LEADING = /^0*(\d{1,2})(?:(?=\s*[-–—_)\]:]|\s+\p{L})|\.(?!\d)|$)/u;

/** Words after a number that make it a count or size, not a chapter ("27 pages", "2 MB"). */
const NOT_CHAPTER_AFTER = /^\s*(?:pages?|pp?\b|p\.|pgs?\b|years?|yrs?|mb|kb|gb|bytes?|%|th\b|st\b|nd\b|rd\b|ed\b|edition)/iu;

/**
 * Normalises a file name: last path segment, NFKC, extension removed ('' for non-strings).
 * @param {unknown} fileName
 * @returns {string}
 */
function baseName(fileName) {
  if (typeof fileName !== 'string') return '';
  let name = fileName.normalize('NFKC');
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  return name.replace(/\.(pdf|PDF|Pdf)$/u, '').trim();
}

/**
 * Lower-case words of a text (letters and digits only), for title matching.
 * @param {string} text
 * @returns {string}
 */
function words(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * @param {number} n
 * @returns {string}
 */
function chapterIdOf(n) {
  return `ch${String(n).padStart(2, '0')}`;
}

/**
 * Finds the chapter a PDF belongs to from its file name.
 *
 * Recognised (case-insensitive): `Chapter-01-Anatomy-and-Dimensions.pdf`,
 * `Chapter 1 …`, `Chap. 3`, `Ch.12`, `ch01`, `CH1`, `01 - …`, `1.pdf`, also
 * behind a prefix (`9a47a464-Chapter-01-….pdf`). Page counts, sizes, years and
 * decimals are never taken for a chapter (`27 pages.pdf`, `2019.pdf`, `1.5.pdf`).
 * Two different chapter numbers in one name → null (ambiguous).
 *
 * With `chapters` (e.g. from `data/index.json`), only their numbers are valid,
 * and a name without a number may match a chapter's full title
 * (`Mitral Valve Disease.pdf` → `ch11`; the longest contained title wins, a tie → null).
 *
 * @param {unknown} fileName
 * @param {{ chapters?: ChapterRef[] | null }} [options]
 * @returns {string | null} A chapter id such as `ch01`, or null.
 */
export function matchChapter(fileName, { chapters = null } = {}) {
  const name = baseName(fileName);
  if (!name) return null;
  const list = Array.isArray(chapters) ? chapters.filter((c) => c && typeof c.id === 'string' && Number.isInteger(c.number)) : null;
  /** @param {number} n */
  const resolve = (n) => {
    if (list) return list.find((c) => c.number === n)?.id ?? null;
    return n >= 1 && n <= CHAPTER_COUNT ? chapterIdOf(n) : null;
  };

  /** @type {Set<number>} */
  const found = new Set();
  for (const m of name.matchAll(KEYWORD)) {
    const after = name.slice(/** @type {number} */ (m.index) + m[0].length);
    if (NOT_CHAPTER_AFTER.test(after)) continue;
    found.add(Number(m[1]));
  }
  if (found.size > 1) return null;
  if (found.size === 1) return resolve([...found][0]);

  const lead = LEADING.exec(name);
  if (lead) {
    const after = name.slice(lead[0].length);
    if (!NOT_CHAPTER_AFTER.test(after)) return resolve(Number(lead[1]));
  }

  if (!list) return null;
  // No number: a chapter whose whole title appears in the name.
  const text = ` ${words(name)} `;
  let best = /** @type {ChapterRef | null} */ (null);
  let bestLen = 0;
  let tie = false;
  for (const c of list) {
    const t = words(c.title ?? '');
    if (t.length < 4 || !text.includes(` ${t} `)) continue;
    if (t.length > bestLen) {
      best = c;
      bestLen = t.length;
      tie = false;
    } else if (t.length === bestLen) {
      tie = true;
    }
  }
  return best && !tie ? best.id : null;
}

// ---------------------------------------------------------------------------
// Page helpers (pure)
// ---------------------------------------------------------------------------

/**
 * PDF page index (1-based) of a printed book page: `bookPage − firstPage + 1`.
 * @param {number} bookPage
 * @param {number} firstPage The chapter's first book page (`data/book.json`).
 * @returns {number} Never below 1.
 */
export function pdfPageFor(bookPage, firstPage) {
  const p = Math.round(Number(bookPage)) - Math.round(Number(firstPage)) + 1;
  return Number.isFinite(p) && p >= 1 ? p : 1;
}

/**
 * Printed book page of a PDF page index: `pdfPage + firstPage − 1`.
 * @param {number} pdfPage 1-based.
 * @param {number} firstPage
 * @returns {number}
 */
export function bookPageFor(pdfPage, firstPage) {
  const p = Math.round(Number(pdfPage)) + Math.round(Number(firstPage)) - 1;
  return Number.isFinite(p) ? p : 1;
}

/**
 * Human-readable size: "820 KB", "16.2 MB", "1.1 GB" (1 KB = 1024 bytes).
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 || i === 0 ? 0 : 1;
  return `${Math.max(v, i === 0 ? 1 : 0).toFixed(digits)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// data/book.json
// ---------------------------------------------------------------------------

/** @type {Promise<BookData> | null} */
let bookDataPromise = null;

/**
 * Loads `data/book.json` (precached; works offline) once. On any failure the
 * Book tab still works: it resolves `{ schemaVersion: 1, chapters: {} }` and
 * warns (sections then come from the PDF outline only).
 * @param {{ fetchImpl?: typeof fetch, url?: string | URL }} [options]
 * @returns {Promise<BookData>}
 */
export function loadBookData({ fetchImpl, url } = {}) {
  if (bookDataPromise && !fetchImpl && !url) return bookDataPromise;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const target = url ?? new URL('../../../data/book.json', import.meta.url);
  const p = (async () => {
    try {
      const res = await doFetch(String(target), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return normalizeBookData(await res.json());
    } catch (err) {
      console.warn('[book] data/book.json could not be loaded:', err);
      if (!fetchImpl && !url) bookDataPromise = null;
      return { schemaVersion: /** @type {1} */ (1), chapters: {} };
    }
  })();
  if (!fetchImpl && !url) bookDataPromise = p;
  return p;
}

/**
 * Keeps only well-formed chapter entries of a parsed `data/book.json`
 * (the dev validator checks the file strictly; the app stays lenient).
 * @param {any} data
 * @returns {BookData}
 */
export function normalizeBookData(data) {
  /** @type {Record<string, BookChapter>} */
  const chapters = {};
  const src = data && typeof data === 'object' && data.chapters && typeof data.chapters === 'object' ? data.chapters : {};
  for (const [id, ch] of Object.entries(src)) {
    if (!CHAPTER_ID.test(id) || !ch || typeof ch !== 'object' || !Number.isInteger(ch.firstPage) || ch.firstPage < 1) continue;
    const sections = (Array.isArray(ch.sections) ? ch.sections : [])
      .filter((s) => s && typeof s.title === 'string' && s.title.trim() && Number.isInteger(s.page) && s.page >= 1)
      .map((s) => ({ title: s.title.trim(), page: s.page, level: /** @type {1 | 2} */ (s.level === 2 ? 2 : 1) }));
    /** @type {BookChapter} */
    const entry = { firstPage: ch.firstPage, sections };
    if (typeof ch.file === 'string' && /^[\w./-]+\.pdf$/i.test(ch.file) && !ch.file.startsWith('/') && !ch.file.includes('..')) {
      entry.file = ch.file;
    }
    chapters[id] = entry;
  }
  return { schemaVersion: 1, chapters };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const IMPORT_MESSAGES = Object.freeze({
  unmatched: 'Which chapter is this? Choose one to add it.',
  duplicate: 'Another file in this batch is already used for this chapter.',
  password: 'This PDF is locked with a password. Remove the password, then add it again.',
  damaged: "This PDF looks damaged and can't be opened.",
  error: "Couldn't add this file. Please try again.",
});

/**
 * Loads `features/book/pdf.js` lazily; null when it is not available.
 * @returns {Promise<{ pdfInfo: (blob: Blob) => Promise<{ pages: number, title?: string }> } | null>}
 */
async function loadPdfModule() {
  try {
    const mod = await import('./pdf.js');
    return typeof mod.pdfInfo === 'function' ? /** @type {any} */ (mod) : null;
  } catch (err) {
    console.warn('[book] PDF reader unavailable; importing without a page count:', err);
    return null;
  }
}

/**
 * Reads page count and title with PDF.js. Returns `{ pages: null }` when the
 * reader can't load; throws only for files PDF.js says are unusable.
 * @param {Blob} blob
 * @param {{ pdfInfo: Function } | null} pdf
 * @returns {Promise<{ pages: number | null, title: string }>}
 */
async function readInfo(blob, pdf) {
  if (!pdf) return { pages: null, title: '' };
  try {
    const info = await pdf.pdfInfo(blob);
    const pages = Number.isInteger(info?.pages) && info.pages > 0 ? info.pages : null;
    return { pages, title: typeof info?.title === 'string' ? info.title : '' };
  } catch (err) {
    // features/book/pdf.js throws PdfError (`code` 'password' | 'invalid' | 'empty' | …);
    // raw PDF.js errors carry the exception name instead.
    const e = /** @type {any} */ (err);
    const name = String(e?.name ?? '');
    const code = String(e?.code ?? '');
    if (code === 'password' || name === 'PasswordException') {
      throw Object.assign(new TypeError(IMPORT_MESSAGES.password), { code: 'password', userMessage: IMPORT_MESSAGES.password, cause: err });
    }
    if (code === 'invalid' || code === 'empty' || name === 'InvalidPDFException') {
      throw Object.assign(new TypeError(IMPORT_MESSAGES.damaged), { code: 'damaged', userMessage: IMPORT_MESSAGES.damaged, cause: err });
    }
    console.warn('[book] Could not read the PDF details; importing without a page count:', err);
    return { pages: null, title: '' };
  }
}

/**
 * Maps a storage/validation error to an import status.
 * @param {any} err
 * @returns {ImportStatus}
 */
function statusOf(err) {
  const code = String(err?.code ?? '');
  if (code === 'too-large' || err instanceof RangeError) return 'too-large';
  if (code === 'QuotaExceededError' || err?.name === 'QuotaExceededError') return 'no-space';
  if (code === 'not-pdf' || code === 'empty' || code === 'bad-input' || code === 'password' || code === 'damaged') return 'invalid';
  return 'error';
}

/**
 * Adds chapter PDFs to the device, one at a time (each file is copied into
 * IndexedDB). For every file: the chapter comes from `chapterFor(file)` when it
 * returns a chapter id, else from {@link matchChapter}. Files without a chapter
 * are returned as `'unmatched'` (the UI asks, then calls again with `chapterFor`).
 *
 * Statuses: `'added'`, `'replaced'` (`previous` = the earlier record, for Undo),
 * `'unchanged'` (same file name and size already stored; nothing written),
 * `'unmatched'`, `'duplicate'` (an earlier file in the same call took the
 * chapter), `'invalid'` (not a PDF, empty, password-locked, damaged),
 * `'too-large'` (> 300 MB), `'no-space'` (device storage full), `'error'`.
 * Never throws for a single file; each result has a plain-language `message`
 * when it was not added.
 *
 * @param {Iterable<Blob & { name?: string }> | ArrayLike<Blob & { name?: string }>} files A FileList or File[].
 * @param {{ chapterFor?: (file: Blob & { name?: string }) => string | null | undefined,
 *   chapters?: ChapterRef[] | null, onProgress?: (done: number, total: number, result: ImportResult) => void,
 *   readPdfInfo?: boolean }} [options] `chapters` limits/labels the matching (see matchChapter);
 *   `readPdfInfo: false` skips PDF.js (tests).
 * @returns {Promise<ImportResult[]>} In input order.
 */
export async function importPdfFiles(files, { chapterFor, chapters = null, onProgress, readPdfInfo = true } = {}) {
  const list = Array.from(/** @type {ArrayLike<any>} */ (files ?? []));
  const valid = Array.isArray(chapters) ? new Set(chapters.map((c) => c?.id)) : null;
  const titles = new Map((Array.isArray(chapters) ? chapters : []).map((c) => [c?.id, c?.title ?? '']));
  /** @type {ImportResult[]} */
  const results = [];
  /** @type {Set<string>} */
  const taken = new Set();
  /** @type {{ pdfInfo: Function } | null | undefined} */
  let pdf;

  for (const file of list) {
    const name = String(file?.name ?? '');
    /** @type {ImportResult} */
    let result;
    try {
      const chosen = typeof chapterFor === 'function' ? chapterFor(file) : null;
      let chapterId = typeof chosen === 'string' && chosen ? chosen : matchChapter(name, { chapters });
      if (chapterId && (!CHAPTER_ID.test(chapterId) || (valid && !valid.has(chapterId)))) chapterId = null;
      if (!chapterId) {
        result = { file, name, chapterId: null, status: 'unmatched', message: IMPORT_MESSAGES.unmatched };
      } else if (taken.has(chapterId)) {
        result = { file, name, chapterId, status: 'duplicate', message: IMPORT_MESSAGES.duplicate };
      } else {
        taken.add(chapterId);
        result = await importOne(file, name, chapterId, titles.get(chapterId) ?? '', async () => {
          if (pdf === undefined) pdf = readPdfInfo ? await loadPdfModule() : null;
          return pdf;
        });
      }
    } catch (err) {
      result = { file, name, chapterId: null, status: 'error', error: /** @type {any} */ (err), message: IMPORT_MESSAGES.error };
    }
    results.push(result);
    try {
      onProgress?.(results.length, list.length, result);
    } catch (err) {
      console.warn('[book] onProgress failed:', err);
    }
  }
  return results;
}

/**
 * @param {Blob & { name?: string }} file
 * @param {string} name
 * @param {string} chapterId
 * @param {string} chapterTitle
 * @param {() => Promise<{ pdfInfo: Function } | null>} getPdf
 * @returns {Promise<ImportResult>}
 */
async function importOne(file, name, chapterId, chapterTitle, getPdf) {
  try {
    const previous = await bookRepo.get(chapterId);
    if (previous && previous.blob && previous.fileName === name && previous.bytes === file?.size) {
      return { file, name, chapterId, status: 'unchanged', record: previous, previous };
    }
    // Cheap checks (type, size, header) before PDF.js reads the whole file.
    await checkBookInput({ id: chapterId, blob: file });
    const info = await readInfo(file, await getPdf());
    const record = await bookRepo.put({
      id: chapterId,
      blob: file,
      fileName: name,
      title: chapterTitle || info.title || baseName(name),
      pages: info.pages,
      // Re-adding a chapter keeps the reading position (clamped to the new page count).
      lastPage: previous?.lastPage ?? 1,
      lastScale: previous?.lastScale ?? null,
    });
    return { file, name, chapterId, status: previous ? 'replaced' : 'added', record, previous: previous ?? null };
  } catch (err) {
    const e = /** @type {Error & { userMessage?: string }} */ (err);
    const status = statusOf(e);
    if (status === 'error') console.warn('[book] Import failed:', err);
    return {
      file,
      name,
      chapterId,
      status,
      error: e,
      message: e?.userMessage || (status === 'error' ? IMPORT_MESSAGES.error : String(e?.message ?? IMPORT_MESSAGES.error)),
    };
  }
}

/**
 * Undoes an import: removes chapters that were added and puts back the
 * previous file of chapters that were replaced. Never throws; returns the
 * number of chapters restored.
 * @param {ImportResult[]} results The array `importPdfFiles` returned.
 * @returns {Promise<number>}
 */
export async function undoImport(results) {
  let n = 0;
  for (const r of Array.isArray(results) ? results : []) {
    try {
      if (r?.status === 'added' && r.chapterId) {
        await bookRepo.remove(r.chapterId);
        n++;
      } else if (r?.status === 'replaced' && r.previous) {
        await bookRepo.put(r.previous);
        n++;
      }
    } catch (err) {
      console.warn('[book] Undo failed for', r?.chapterId, err);
    }
  }
  return n;
}

/**
 * Device storage estimate for the Book tab ("16 MB used of 2 GB").
 * Never throws; numbers are null when the browser can't tell.
 * @returns {Promise<{ usage: number | null, quota: number | null, available: number | null, persisted: boolean | null }>}
 */
export async function storageEstimate() {
  const storage = /** @type {any} */ (globalThis.navigator)?.storage;
  let usage = null;
  let quota = null;
  let persisted = null;
  try {
    if (typeof storage?.estimate === 'function') {
      const est = await storage.estimate();
      usage = Number.isFinite(est?.usage) ? est.usage : null;
      quota = Number.isFinite(est?.quota) ? est.quota : null;
    }
  } catch {
    /* unknown */
  }
  try {
    if (typeof storage?.persisted === 'function') persisted = Boolean(await storage.persisted());
  } catch {
    /* unknown */
  }
  const available = usage !== null && quota !== null ? Math.max(0, quota - usage) : null;
  return { usage, quota, available, persisted };
}
