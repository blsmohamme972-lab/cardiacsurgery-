/**
 * "Export annotated copy" (docs/ARCHITECTURE.md §7.17): a new PDF made from the
 * chapter's ORIGINAL file with the user's notes drawn on top. The stored
 * original is never modified (it is read into a fresh buffer).
 *
 * pdf-lib (vendor/pdf-lib/, MIT) is imported only when an export starts.
 *
 * What is written, page by page (`pdfNotesRepo` records):
 * - pen strokes as filled vector outlines (the same variable-width outline the
 *   screen draws), marker strokes as translucent outlines (multiply);
 * - shapes (line, arrow, rectangle, ellipse) as vector paths;
 * - text boxes as text (Helvetica, wrapped like on screen);
 * - pictures embedded (WebP is re-encoded, since PDF has no WebP);
 * - text highlights as translucent rectangles (multiply);
 * - sticky notes as PDF text annotations (the note icon most PDF apps show);
 * - voice notes as a text annotation "Voice note (recorded in KirKlin)".
 *
 * Source file: the chapter's own PDF when it has one; else the chapter's page
 * range of the whole book (§7.17), copied with {@link extractPageRange} (reads
 * only the objects of those pages, so a 400 MB book is never loaded whole). If
 * that copy fails (an unusual file structure), the whole file is loaded with
 * pdf-lib only when the device has the memory for it; otherwise the export
 * stops with a plain-language message (the original is never touched).
 *
 * Coordinates: a scene is in display points of the page (top-left origin,
 * after the page's /Rotate, inside its CropBox — like PDF.js); {@link pageMapper}
 * maps them to PDF user space for every rotation.
 *
 * @module features/book/export
 */

import { pdfNotesRepo, bookRepo, mediaRepo, wholeBookRepo } from '../../core/store/repo.js';
import { strokeToPath } from '../annotate/ink.js';
import { wrapText, TEXT_LINE, TEXT_PAD, ARROW_HEAD, ARROW_MIN } from '../scratch/geometry.js';
import { deserialize } from '../scratch/scene.js';
import { formatDuration } from '../../core/util.js';
import { sanitizeHighlights, TEXT_HL_COLORS } from './annotate.js';

/** Where the vendored pdf-lib lives (relative to this module). */
const PDF_LIB_URL = '../../../vendor/pdf-lib/pdf-lib.esm.min.js';
/** Marker / highlight opacity (the screen uses the same look). */
const HL_OPACITY = 0.35;
/** Text highlight opacity. */
const TEXT_HL_OPACITY = 0.4;
/** Size of a note annotation icon (points). */
const NOTE_ICON = 20;

/** A failed export with a plain-language message. */
export class ExportError extends Error {
  /**
   * @param {'no-pdf' | 'encrypted' | 'read' | 'build' | 'storage'} code
   * @param {string} userMessage
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(code, userMessage, opts = {}) {
    super(userMessage, opts);
    this.name = 'ExportError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

/**
 * A safe file name: "<title> (annotated).pdf". Pure.
 * @param {string} title
 * @returns {string}
 */
export function annotatedFileName(title) {
  const base = String(title || 'Chapter')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return `${base || 'Chapter'} (annotated).pdf`;
}

/**
 * `#rrggbb` → [r, g, b] in 0–1. Pure.
 * @param {string} hex
 * @returns {[number, number, number]}
 */
export function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0x111827;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Maps display points of a page (top-left origin, rotation applied, inside the
 * CropBox) to PDF user space. Pure.
 * @param {{ x: number, y: number, width: number, height: number }} box CropBox.
 * @param {number} rotation 0 | 90 | 180 | 270 (other values are normalised).
 * @param {{ w: number, h: number }} scenePage Scene page size (units).
 * @returns {{ map: (u: number, v: number) => [number, number], k: number, rotation: number, displayW: number, displayH: number }}
 *   `k` = PDF points per scene unit.
 */
export function pageMapper(box, rotation, scenePage) {
  const rot = (((Math.round(Number(rotation) / 90) * 90) % 360) + 360) % 360;
  const displayW = rot % 180 === 0 ? box.width : box.height;
  const displayH = rot % 180 === 0 ? box.height : box.width;
  const k = scenePage && scenePage.w > 0 ? displayW / scenePage.w : 1;
  const { x: bx, y: by, width: cw, height: ch } = box;
  /** @type {(u: number, v: number) => [number, number]} */
  let map;
  switch (rot) {
    case 90:
      map = (u, v) => [bx + v * k, by + u * k];
      break;
    case 180:
      map = (u, v) => [bx + cw - u * k, by + v * k];
      break;
    case 270:
      map = (u, v) => [bx + cw - v * k, by + ch - u * k];
      break;
    default:
      map = (u, v) => [bx + u * k, by + ch - v * k];
  }
  return { map, k, rotation: rot, displayW, displayH };
}

/**
 * An SVG path string (in PDF space, y negated for pdf-lib's drawSvgPath) for a
 * polygon of display points. Pure.
 * @param {number[][]} pts `[[u, v], ...]` display units.
 * @param {(u: number, v: number) => [number, number]} map
 * @param {boolean} [close=true]
 * @returns {string}
 */
export function polygonPath(pts, map, close = true) {
  let d = '';
  pts.forEach(([u, v], i) => {
    const [x, y] = map(u, v);
    d += `${i ? 'L' : 'M'}${round3(x)} ${round3(-y)} `;
  });
  return close && d ? `${d}Z` : d.trim();
}

/** @param {number} n */
const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * An ellipse as 4 cubic Béziers in a box (display units) → SVG path in PDF space. Pure.
 * @param {{ x: number, y: number, w: number, h: number }} b
 * @param {(u: number, v: number) => [number, number]} map
 * @returns {string}
 */
export function ellipsePath(b, map) {
  const K = 0.5522847498;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const rx = b.w / 2;
  const ry = b.h / 2;
  /** @param {number} u @param {number} v */
  const p = (u, v) => {
    const [x, y] = map(u, v);
    return `${round3(x)} ${round3(-y)}`;
  };
  return [
    `M${p(cx + rx, cy)}`,
    `C${p(cx + rx, cy + K * ry)} ${p(cx + K * rx, cy + ry)} ${p(cx, cy + ry)}`,
    `C${p(cx - K * rx, cy + ry)} ${p(cx - rx, cy + K * ry)} ${p(cx - rx, cy)}`,
    `C${p(cx - rx, cy - K * ry)} ${p(cx - K * rx, cy - ry)} ${p(cx, cy - ry)}`,
    `C${p(cx + K * rx, cy - ry)} ${p(cx + rx, cy - K * ry)} ${p(cx + rx, cy)}`,
    'Z',
  ].join(' ');
}

/**
 * Loads pdf-lib on first use.
 * @returns {Promise<any>}
 */
async function loadPdfLib() {
  try {
    return await import(PDF_LIB_URL);
  } catch (err) {
    throw new ExportError('build', "The PDF tools couldn't load. Reload the app and try again.", { cause: err });
  }
}

/**
 * Re-encodes an image pdf-lib can't embed (WebP, …) as PNG or JPEG.
 * @param {Blob} blob
 * @returns {Promise<{ bytes: ArrayBuffer, kind: 'png' | 'jpg' }>}
 */
async function toEmbeddable(blob) {
  const type = (blob.type || '').toLowerCase();
  if (type === 'image/png') return { bytes: await blob.arrayBuffer(), kind: 'png' };
  if (type === 'image/jpeg' || type === 'image/jpg') return { bytes: await blob.arrayBuffer(), kind: 'jpg' };
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  // Keep transparency when there is any (PNG), else a compact JPEG.
  const data = ctx.getImageData(0, 0, Math.min(canvas.width, 256), Math.min(canvas.height, 256)).data;
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      alpha = true;
      break;
    }
  }
  const out = await new Promise((resolve) => canvas.toBlob(resolve, alpha ? 'image/png' : 'image/jpeg', 0.9));
  if (!out) throw new Error('encode failed');
  return { bytes: await /** @type {Blob} */ (out).arrayBuffer(), kind: alpha ? 'png' : 'jpg' };
}

/**
 * Whether loading a whole file of `bytes` into memory is reasonable on this
 * device (pdf-lib needs about three times the file size). Pure apart from
 * reading `navigator`.
 * @param {number} bytes
 * @returns {boolean}
 */
export function canLoadWhole(bytes) {
  const nav = /** @type {any} */ (globalThis.navigator) || {};
  const gb = Number(nav.deviceMemory);
  const coarse = typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
  const budget = Number.isFinite(gb) && gb > 0 ? gb * 64 * 1024 * 1024 : coarse ? 150 * 1024 * 1024 : 600 * 1024 * 1024;
  return bytes <= budget;
}

/**
 * The chapter's pages of the whole book as a new pdf-lib document: a range copy
 * (only those pages' objects are read); the whole-file route only as a fallback
 * when memory allows.
 * @param {any} lib pdf-lib
 * @param {{ blob: Blob, from: number, to: number }} src
 * @returns {Promise<any>}
 */
async function chapterFromBook(lib, src) {
  const { extractPageRange, ExtractError } = await import('./extract.js');
  try {
    return await extractPageRange(lib, src.blob, src.from, src.to);
  } catch (err) {
    if (err instanceof ExtractError && err.code === 'encrypted') {
      throw new ExportError('encrypted', 'This PDF is protected, so an annotated copy can’t be made. You can still read and annotate it in the app.', { cause: err });
    }
    console.warn('[book export] range copy failed; trying the whole file', err);
    if (!canLoadWhole(src.blob.size)) {
      throw new ExportError(
        'build',
        'This book’s PDF is too large to copy on this device. Add this chapter’s own PDF (Add PDFs) to export it with your notes.',
        { cause: err },
      );
    }
    try {
      const full = await lib.PDFDocument.load(await src.blob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
      const out = await lib.PDFDocument.create({ updateMetadata: false });
      const indices = Array.from({ length: src.to - src.from + 1 }, (_, i) => src.from - 1 + i);
      for (const page of await out.copyPages(full, indices)) out.addPage(page);
      return out;
    } catch (err2) {
      throw new ExportError('read', "The book couldn't be opened to make a copy. The original stays as it is.", { cause: err2 });
    }
  }
}

/**
 * Builds the annotated copy of a chapter PDF.
 *
 * @param {string} bookId Chapter id.
 * @param {{ title?: string }} [opts] Title for the file name (default: the stored title).
 * @returns {Promise<{ blob: Blob, filename: string, pages: number, annotatedPages: number }>}
 *   Rejects with {@link ExportError}.
 */
export async function buildAnnotatedPdf(bookId, { title } = {}) {
  let rec;
  try {
    rec = await bookRepo.get(bookId);
  } catch (err) {
    throw new ExportError('read', "The chapter's PDF couldn't be read from this device. Please try again.", { cause: err });
  }
  /** @type {{ blob: Blob, from: number, to: number } | null} */
  let fromBook = null;
  if (!rec || !rec.blob) {
    let whole = null;
    try {
      whole = await wholeBookRepo.get();
    } catch (err) {
      throw new ExportError('read', "The book couldn't be read from this device. Please try again.", { cause: err });
    }
    const range = whole?.map?.chapters?.[bookId];
    if (!whole?.blob || !range) throw new ExportError('no-pdf', "This chapter's PDF isn't on this device. Add it first.");
    fromBook = { blob: whole.blob, from: range.from, to: range.to };
  }
  let notes = [];
  try {
    notes = await pdfNotesRepo.byBook(bookId);
  } catch (err) {
    throw new ExportError('read', "Your notes couldn't be read. Please try again.", { cause: err });
  }

  const lib = await loadPdfLib();
  const { PDFDocument, rgb, degrees, StandardFonts, PDFHexString, BlendMode } = lib;

  let doc;
  if (fromBook) {
    doc = await chapterFromBook(lib, fromBook);
  } else {
    try {
      const bytes = await /** @type {Blob} */ (rec?.blob).arrayBuffer();
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (err) {
      throw new ExportError('read', "This PDF couldn't be opened to make a copy. The original stays as it is.", { cause: err });
    }
  }
  if (doc.isEncrypted) {
    throw new ExportError('encrypted', 'This PDF is protected, so an annotated copy can’t be made. You can still read and annotate it in the app.');
  }

  const font = await doc.embedFont(StandardFonts.Helvetica);
  /** @type {Map<string, boolean>} */
  const encodable = new Map();
  /** @param {string} ch */
  const canEncode = (ch) => {
    let ok = encodable.get(ch);
    if (ok === undefined) {
      try {
        font.encodeText(ch);
        ok = true;
      } catch {
        ok = false;
      }
      encodable.set(ch, ok);
    }
    return ok;
  };
  /** @param {string} s */
  const safeText = (s) => [...s].map((ch) => (ch === '\n' || canEncode(ch) ? ch : '?')).join('');
  /** @param {string} s @param {number} size */
  const measure = (s, size) => {
    try {
      return font.widthOfTextAtSize(safeText(s), size);
    } catch {
      return s.length * size * 0.5;
    }
  };

  /** @type {Map<string, any>} */
  const embedded = new Map();
  /** @param {string} mediaId */
  async function imageFor(mediaId) {
    if (embedded.has(mediaId)) return embedded.get(mediaId);
    let img = null;
    try {
      const m = await mediaRepo.get(mediaId);
      if (m?.blob) {
        const { bytes, kind } = await toEmbeddable(m.blob);
        img = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      }
    } catch (err) {
      console.warn('[book export] picture skipped', err);
    }
    embedded.set(mediaId, img);
    return img;
  }

  const pages = doc.getPages();
  let annotatedPages = 0;
  const hlBlend = BlendMode?.Multiply;

  for (const note of notes) {
    const page = pages[note.page - 1];
    if (!page) continue;
    const highlights = sanitizeHighlights(note.highlights);
    const items = Array.isArray(note.scene?.items) ? note.scene.items : [];
    if (!items.length && !highlights.length) continue;
    annotatedPages++;
    const box = page.getCropBox();
    const rotation = page.getRotation()?.angle || 0;
    const scenePage = note.scene?.page && note.scene.page.w > 0 && note.scene.page.h > 0 ? note.scene.page : null;
    const scene = deserialize(note.scene, { bg: 'plain', size: scenePage || undefined });
    const pm = pageMapper(box, rotation, scene.page);
    const { map, k } = pm;
    const W = scene.page.w;
    const H = scene.page.h;

    // Text highlights first: they sit under the ink.
    for (const hl of highlights) {
      const c = hexToRgb01((TEXT_HL_COLORS.find((x) => x.name === hl.color) || TEXT_HL_COLORS[0]).hex);
      for (const [fx, fy, fw, fh] of hl.rects) {
        const u0 = fx * W;
        const v0 = fy * H;
        const u1 = (fx + fw) * W;
        const v1 = (fy + fh) * H;
        page.drawSvgPath(polygonPath([[u0, v0], [u1, v0], [u1, v1], [u0, v1]], map), {
          x: 0,
          y: 0,
          color: rgb(...c),
          opacity: TEXT_HL_OPACITY,
          ...(hlBlend ? { blendMode: hlBlend } : {}),
        });
      }
    }

    for (const it of scene.items) {
      try {
        if (it.type === 'stroke') {
          const stroke = {
            tool: it.tool,
            color: it.color,
            size: it.size / W,
            pts: it.pts.map((n, i) => (i % 3 === 0 ? n / W : i % 3 === 1 ? n / H : n)),
          };
          const poly = strokeToPath(stroke, W, H);
          if (poly.length < 3) continue;
          const isHl = it.tool === 'hl';
          page.drawSvgPath(polygonPath(poly, map), {
            x: 0,
            y: 0,
            color: rgb(...hexToRgb01(it.color)),
            ...(isHl ? { opacity: HL_OPACITY, ...(hlBlend ? { blendMode: hlBlend } : {}) } : {}),
          });
        } else if (it.type === 'shape') {
          const col = rgb(...hexToRgb01(it.color));
          const lw = Math.max(0.3, it.size * k);
          if (it.shape === 'line' || it.shape === 'arrow') {
            let x2 = it.x2;
            let y2 = it.y2;
            const len = Math.hypot(it.x2 - it.x1, it.y2 - it.y1);
            const head = Math.min(Math.max(ARROW_MIN * (W / 2000), it.size * ARROW_HEAD), len * 0.6);
            const a = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
            if (it.shape === 'arrow' && len > 0) {
              x2 -= Math.cos(a) * head * 0.6;
              y2 -= Math.sin(a) * head * 0.6;
            }
            page.drawSvgPath(polygonPath([[it.x1, it.y1], [x2, y2]], map, false), { x: 0, y: 0, borderColor: col, borderWidth: lw, borderLineCap: lib.LineCapStyle?.Round });
            if (it.shape === 'arrow' && len > 0) {
              const spread = Math.PI / 7;
              const tri = [
                [it.x2, it.y2],
                [it.x2 - Math.cos(a - spread) * head, it.y2 - Math.sin(a - spread) * head],
                [it.x2 - Math.cos(a + spread) * head, it.y2 - Math.sin(a + spread) * head],
              ];
              page.drawSvgPath(polygonPath(tri, map), { x: 0, y: 0, color: col });
            }
          } else {
            const b = { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1) };
            const path =
              it.shape === 'rect'
                ? polygonPath([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]], map)
                : ellipsePath(b, map);
            page.drawSvgPath(path, {
              x: 0,
              y: 0,
              borderColor: col,
              borderWidth: lw,
              ...(it.fill ? { color: col, opacity: 0.25 } : {}),
            });
          }
        } else if (it.type === 'image') {
          const img = await imageFor(it.media);
          if (!img) continue;
          // Image-local origin = its bottom-left corner as seen on screen (rotated around the centre).
          const cx = it.x + it.w / 2;
          const cy = it.y + it.h / 2;
          const c = Math.cos(it.rot);
          const s = Math.sin(it.rot);
          const lx = -it.w / 2;
          const ly = it.h / 2;
          const [x, y] = map(cx + lx * c - ly * s, cy + lx * s + ly * c);
          const angle = pm.rotation - (it.rot * 180) / Math.PI;
          page.drawImage(img, { x, y, width: it.w * k, height: it.h * k, rotate: degrees(angle) });
        } else if (it.type === 'text') {
          const pad = it.size * TEXT_PAD;
          const lines = wrapText(it.text, it.w - 2 * pad, it.size, measure);
          const lh = it.size * TEXT_LINE;
          const col = rgb(...hexToRgb01(it.color));
          lines.forEach((line, i) => {
            if (!line) return;
            // Canvas draws each line centred on its row: baseline ≈ middle + 0.35 em.
            const [x, y] = map(it.x + pad, it.y + pad + lh * i + lh / 2 + it.size * 0.35);
            page.drawText(safeText(line), { x, y, size: it.size * k, font, color: col, rotate: degrees(pm.rotation) });
          });
        } else if (it.type === 'note' || it.type === 'audio') {
          const [x, y] = map(it.x, it.y);
          const contents =
            it.type === 'note'
              ? it.text || '(empty note)'
              : `Voice note (recorded in KirKlin), ${formatDuration(it.durationMs)}. Play it in the app on page ${note.page}.`;
          const c = hexToRgb01(it.type === 'note' ? it.color : '#a6192e');
          const annot = doc.context.obj({
            Type: 'Annot',
            Subtype: 'Text',
            Rect: [x - NOTE_ICON / 2, y - NOTE_ICON / 2, x + NOTE_ICON / 2, y + NOTE_ICON / 2],
            Contents: PDFHexString.fromText(contents),
            T: PDFHexString.fromText('KirKlin'),
            Name: it.type === 'note' ? 'Note' : 'Comment',
            C: c,
            F: 4,
            Open: false,
            M: PDFHexString.fromText(new Date().toISOString()),
          });
          page.node.addAnnot(doc.context.register(annot));
        }
      } catch (err) {
        console.warn('[book export] an item could not be drawn', err);
      }
    }
  }
  let out;
  try {
    out = await doc.save({ useObjectStreams: true });
  } catch (err) {
    throw new ExportError('build', "The annotated copy couldn't be made. Please try again.", { cause: err });
  }
  const blob = new Blob([out], { type: 'application/pdf' });
  return { blob, filename: annotatedFileName(title || rec?.title || bookId), pages: pages.length, annotatedPages };
}

/**
 * Builds the annotated copy and hands it to the share sheet / downloads
 * (`backup.saveFile`). Shows plain-language progress and errors.
 * @param {string} bookId
 * @param {{ title?: string }} [opts]
 * @returns {Promise<'shared' | 'downloaded' | 'cancelled' | 'failed'>}
 */
export async function exportAnnotatedCopy(bookId, { title } = {}) {
  const { toast } = await import('../../ui/components.js');
  const busy = toast('Making your annotated copy…', { duration: 0 });
  try {
    const res = await buildAnnotatedPdf(bookId, { title });
    busy.close();
    const { saveFile } = await import('../backup.js');
    const how = await saveFile(res.blob, res.filename);
    if (how === 'downloaded') {
      toast(
        res.annotatedPages
          ? `Saved “${res.filename}” to your downloads.`
          : `Saved “${res.filename}”. This chapter has no notes yet, so it's a plain copy.`,
        { kind: 'success', duration: 6000 },
      );
    }
    return how;
  } catch (err) {
    busy.close();
    const msg = err instanceof ExportError ? err.userMessage : /** @type {any} */ (err)?.userMessage || "The annotated copy couldn't be saved. Please try again.";
    if (!(err instanceof ExportError)) console.warn('[book export] failed', err);
    toast(msg, { kind: 'danger', duration: 7000 });
    return 'failed';
  }
}
