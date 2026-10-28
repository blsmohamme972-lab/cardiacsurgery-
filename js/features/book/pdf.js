/**
 * PDF engine: loads the vendored PDF.js on demand (docs/ARCHITECTURE.md §7.17
 * "features/book/pdf.js").
 *
 * - PDF.js 4.10.38, **legacy build** (vendor/pdfjs/, Safari/iPadOS 16.4+), is
 *   imported lazily the first time a PDF is opened, so the app's first load
 *   stays small. Every URL is relative to this module (`new URL(…, import.meta.url)`),
 *   so the app works under any sub-path and inside a Capacitor wrapper.
 * - Parsing runs in one shared **module worker** (`pdf.worker.min.mjs`), reused by
 *   every document (opening the reader after an import costs no second start-up).
 *   {@link closePdfEngine} stops it when no document is open any more.
 * - Safe by default: `isEvalSupported: false`, no XFA, no scripting (PDF.js only
 *   runs PDF JavaScript inside its viewer's sandbox, which is not shipped), only
 *   errors logged (`verbosity: ERRORS`).
 * - {@link openPdf} accepts a Blob/File (from IndexedDB or the file picker), an
 *   ArrayBuffer/typed array (copied: PDF.js transfers its buffer to the worker,
 *   and the caller may still need the original bytes) or a relative/absolute URL
 *   (downloaded whole first, so a service-worker cached file never meets HTTP
 *   range requests).
 * - Every failure becomes a {@link PdfError} with a plain-language `userMessage`
 *   (password-protected, damaged/not a PDF, unreadable from storage, offline,
 *   engine failed to start).
 * - {@link pdfInfo} reads page count, title and the outline (bookmarks) with every
 *   destination resolved to a 1-based page number.
 *
 * Importing this module touches no DOM; the pure helpers ({@link toPdfError},
 * {@link cleanText}, {@link flattenOutline}) are unit-testable in Node.
 *
 * @module features/book/pdf
 */

/** Version of the vendored PDF.js (vendor/README.md). */
export const PDFJS_VERSION = '4.10.38';

/** Deepest outline level kept (deeper entries are clamped to it). */
export const MAX_OUTLINE_LEVEL = 6;
/** Most outline entries read (protects against malformed, looping outlines). */
export const MAX_OUTLINE_ITEMS = 2000;

/** PDF.js `VerbosityLevel.ERRORS` (warnings would go to console.log). */
const VERBOSITY_ERRORS = 0;

/** Plain-language messages per error code. */
const MESSAGES = Object.freeze({
  password:
    'This PDF is locked with a password. Open it in another app, save a copy without the password, then import that copy.',
  invalid: "This file isn't a readable PDF. It may be damaged or not a PDF. Import it again from the original file.",
  empty: 'This file is empty. Import it again from the original file.',
  read: "This PDF couldn't be read from your device's storage. Import it again from the original file.",
  network: "The PDF couldn't be downloaded. Check your connection, then try again.",
  engine: "The PDF reader couldn't start. Reload the app, then try again.",
  cancelled: 'Opening the PDF was cancelled.',
  unknown: "This PDF couldn't be opened. Try again, or import it again from the original file.",
});

/**
 * @typedef {'password' | 'invalid' | 'empty' | 'read' | 'network' | 'engine' | 'cancelled' | 'unknown'} PdfErrorCode
 */

/** A PDF that could not be opened or read, with a message for the user. */
export class PdfError extends Error {
  /**
   * @param {PdfErrorCode} code
   * @param {{ detail?: string, cause?: unknown, userMessage?: string }} [info]
   */
  constructor(code, { detail = '', cause, userMessage } = {}) {
    const message = userMessage || MESSAGES[code] || MESSAGES.unknown;
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'PdfError';
    /** @type {PdfErrorCode} */
    this.code = code;
    /** Plain-language message for a toast or an error state. */
    this.userMessage = message;
    /** Technical detail for developers (never shown to users). */
    this.detail = detail;
  }
}

/**
 * Maps anything thrown by PDF.js (or by reading the file) to a {@link PdfError}.
 * Pure: looks only at `name`/`message`.
 * @param {unknown} err
 * @param {PdfErrorCode} [fallback='unknown'] Code when nothing more specific matches.
 * @returns {PdfError}
 */
export function toPdfError(err, fallback = 'unknown') {
  if (err instanceof PdfError) return err;
  const e = /** @type {{ name?: string, message?: string } | null} */ (err && typeof err === 'object' ? err : null);
  const name = (e && e.name) || '';
  const message = (e && e.message) || String(err ?? '');
  const detail = name ? `${name}: ${message}` : message;
  /** @param {PdfErrorCode} code */
  const make = (code) => new PdfError(code, { detail, cause: err });
  if (name === 'PasswordException' || /password/i.test(message)) return make('password');
  if (name === 'InvalidPDFException' || name === 'MissingPDFException' || /invalid pdf|no pdf header|bad xref/i.test(message)) {
    return make('invalid');
  }
  if (name === 'UnexpectedResponseException') return make('network');
  if (name === 'AbortException' || /loading aborted|worker was destroyed/i.test(message)) return make('cancelled');
  if (name === 'NotReadableError' || name === 'NotFoundError') return make('read');
  return make(fallback);
}

/**
 * Text from a PDF (title, outline entry) made safe for display: control
 * characters removed, whitespace collapsed, trimmed, at most `max` characters.
 * @param {unknown} value
 * @param {number} [max=200]
 * @returns {string}
 */
export function cleanText(value, max = 200) {
  if (typeof value !== 'string') return '';
  const s = value
    .replace(/[­﻿​]/g, '') // soft hyphen, BOM, zero-width space
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// ---------------------------------------------------------------------------
// Library + worker
// ---------------------------------------------------------------------------

/**
 * Absolute URL of a vendored PDF.js file.
 * @param {string} file e.g. 'pdf.min.mjs' or 'standard_fonts/'
 * @returns {string}
 */
function vendorUrl(file) {
  return new URL(`../../../vendor/pdfjs/${file}`, import.meta.url).href;
}

/** @type {Promise<any> | null} */
let libPromise = null;
/** @type {any} Shared PDFWorker (null until the first document opens). */
let sharedWorker = null;

/**
 * Loads the PDF.js library (once) and points it at the module worker.
 * @returns {Promise<any>} The PDF.js module namespace (getDocument, TextLayer, …).
 * @throws {PdfError} code 'engine' when the files can't be loaded (e.g. never cached and offline).
 */
export function loadPdfJs() {
  if (!libPromise) {
    libPromise = import(vendorUrl('pdf.min.mjs'))
      .then((lib) => {
        if (!lib || typeof lib.getDocument !== 'function') throw new Error('PDF.js did not load');
        lib.GlobalWorkerOptions.workerSrc = vendorUrl('pdf.worker.min.mjs');
        return lib;
      })
      .catch((err) => {
        libPromise = null; // allow a retry (e.g. after coming back online)
        throw new PdfError('engine', { detail: String((err && err.message) || err), cause: err });
      });
  }
  return libPromise;
}

/**
 * The shared worker (created on first use, re-created after {@link closePdfEngine}).
 * @param {any} lib
 * @returns {any}
 */
function workerFor(lib) {
  if (!sharedWorker || sharedWorker.destroyed) {
    sharedWorker = new lib.PDFWorker({ name: 'kirklin-pdf', verbosity: VERBOSITY_ERRORS });
  }
  return sharedWorker;
}

/**
 * Stops the shared PDF worker to free its memory. Call only after every
 * document opened with {@link openPdf} has been destroyed (`doc.destroy()`);
 * the next {@link openPdf} starts a new worker.
 * @returns {void}
 */
export function closePdfEngine() {
  if (sharedWorker && !sharedWorker.destroyed) {
    try {
      sharedWorker.destroy();
    } catch {
      /* already gone */
    }
  }
  sharedWorker = null;
}

// ---------------------------------------------------------------------------
// Opening documents
// ---------------------------------------------------------------------------

/**
 * Reads a source into bytes PDF.js may take ownership of.
 * @param {Blob | ArrayBuffer | ArrayBufferView | string | URL} source
 * @returns {Promise<Uint8Array>}
 */
async function bytesOf(source) {
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    if (source.size === 0) throw new PdfError('empty');
    try {
      return new Uint8Array(await source.arrayBuffer());
    } catch (err) {
      throw new PdfError('read', { detail: String((err && /** @type {Error} */ (err).message) || err), cause: err });
    }
  }
  if (source instanceof ArrayBuffer) {
    if (source.byteLength === 0) throw new PdfError('empty');
    return new Uint8Array(source.slice(0));
  }
  if (ArrayBuffer.isView(source)) {
    if (source.byteLength === 0) throw new PdfError('empty');
    const view = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    return view.slice();
  }
  if (typeof source === 'string' || source instanceof URL) {
    let response;
    try {
      response = await fetch(String(source), { credentials: 'same-origin' });
    } catch (err) {
      throw new PdfError('network', { detail: String((err && /** @type {Error} */ (err).message) || err), cause: err });
    }
    if (!response.ok) throw new PdfError(response.status === 404 ? 'invalid' : 'network', { detail: `HTTP ${response.status}` });
    return bytesOf(await response.blob());
  }
  throw new PdfError('invalid', { detail: 'Unsupported source type' });
}

/**
 * Opens a PDF.
 * @param {Blob | ArrayBuffer | ArrayBufferView | string | URL} source A Blob/File, bytes (copied), or a URL (relative to the page).
 * @returns {Promise<any>} The PDFDocumentProxy (`numPages`, `getPage(n)`, `destroy()`, …). The caller destroys it.
 * @throws {PdfError}
 */
export async function openPdf(source) {
  // Start the library + worker while the file is being read.
  const libP = loadPdfJs();
  libP.then(workerFor, () => {});
  const [lib, data] = await Promise.all([libP, bytesOf(source)]);
  let task;
  try {
    task = lib.getDocument({
      data,
      worker: workerFor(lib),
      isEvalSupported: false,
      enableXfa: false,
      stopAtErrors: false,
      standardFontDataUrl: vendorUrl('standard_fonts/'),
      verbosity: VERBOSITY_ERRORS,
    });
    return await task.promise;
  } catch (err) {
    if (task) task.destroy().catch(() => {});
    throw toPdfError(err);
  }
}

// ---------------------------------------------------------------------------
// Outline + info
// ---------------------------------------------------------------------------

/**
 * @typedef {{ title: string, page: number, level: number }} OutlineEntry
 * `page` is 1-based; `level` 1 = top level.
 */

/**
 * Flattens a PDF.js outline tree (depth first, document order). Entries whose
 * destination can't be resolved (web links, broken targets) are dropped; their
 * children are kept at their own level.
 * @param {any[] | null} items PDF.js `getOutline()` result.
 * @param {(dest: unknown) => Promise<number | null>} resolve Destination → 1-based page (or null).
 * @param {{ maxLevel?: number, maxItems?: number }} [limits]
 * @returns {Promise<OutlineEntry[]>}
 */
export async function flattenOutline(items, resolve, { maxLevel = MAX_OUTLINE_LEVEL, maxItems = MAX_OUTLINE_ITEMS } = {}) {
  /** @type {OutlineEntry[]} */
  const out = [];
  let seen = 0;
  /** @type {Set<unknown>} */
  const visiting = new Set();
  /**
   * @param {any[]} list
   * @param {number} level
   */
  const walk = async (list, level) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (seen >= maxItems) return;
      if (!item || typeof item !== 'object' || visiting.has(item)) continue;
      seen += 1;
      visiting.add(item);
      const title = cleanText(item.title);
      let page = null;
      if (item.dest !== null && item.dest !== undefined) {
        try {
          page = await resolve(item.dest);
        } catch {
          page = null;
        }
      }
      if (title && Number.isInteger(page)) out.push({ title, page: /** @type {number} */ (page), level: Math.min(level, maxLevel) });
      await walk(item.items, level + 1);
      visiting.delete(item);
    }
  };
  await walk(items || [], 1);
  return out;
}

/**
 * Resolves a destination (named or explicit) to a 1-based page number.
 * @param {any} doc PDFDocumentProxy
 * @param {unknown} dest
 * @returns {Promise<number | null>}
 */
export async function destinationPage(doc, dest) {
  let explicit = dest;
  if (typeof dest === 'string') explicit = await doc.getDestination(dest);
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const target = explicit[0];
  let index = null;
  if (Number.isInteger(target)) index = target;
  else if (target && typeof target === 'object') index = await doc.getPageIndex(target);
  if (!Number.isInteger(index)) return null;
  const page = /** @type {number} */ (index) + 1;
  return page >= 1 && page <= doc.numPages ? page : null;
}

/**
 * The document outline, flattened, with pages resolved. Never throws (a broken
 * outline yields []).
 * @param {any} doc PDFDocumentProxy
 * @returns {Promise<OutlineEntry[]>}
 */
export async function readOutline(doc) {
  try {
    const items = await doc.getOutline();
    return await flattenOutline(items, (dest) => destinationPage(doc, dest));
  } catch {
    return [];
  }
}

/**
 * The document title from its metadata (XMP dc:title first, then the Info
 * dictionary), or '' when there is none. Never throws.
 * @param {any} doc PDFDocumentProxy
 * @returns {Promise<string>}
 */
export async function readTitle(doc) {
  try {
    const { info, metadata } = await doc.getMetadata();
    const fromXmp = metadata && typeof metadata.get === 'function' ? cleanText(metadata.get('dc:title')) : '';
    if (fromXmp && !/^untitled$/i.test(fromXmp)) return fromXmp;
    const fromInfo = cleanText(info && info.Title);
    return /^untitled$/i.test(fromInfo) ? '' : fromInfo;
  } catch {
    return '';
  }
}

/**
 * Page count, title and outline of a PDF (used when importing a file).
 * Opens the file, reads what it needs and closes it again.
 * @param {Blob | ArrayBuffer | ArrayBufferView} blob
 * @returns {Promise<{ pages: number, title: string, outline: OutlineEntry[] }>}
 * @throws {PdfError}
 */
export async function pdfInfo(blob) {
  const doc = await openPdf(blob);
  try {
    const [title, outline] = await Promise.all([readTitle(doc), readOutline(doc)]);
    return { pages: doc.numPages, title, outline };
  } finally {
    doc.destroy().catch(() => {});
  }
}
