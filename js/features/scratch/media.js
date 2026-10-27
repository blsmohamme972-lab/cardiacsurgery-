/**
 * Scratchpad images (docs/ARCHITECTURE.md §7.16 "features/scratch/media.js").
 *
 * - {@link pickImageFile}: the native picker (`<input type="file" accept="image/*">`):
 *   on phones it offers Photos, Camera and Files by itself.
 * - {@link imageFilesFrom}: images from a paste or drop event.
 * - {@link importImage}: decodes (EXIF orientation applied), downscales to
 *   ≤ 2048 px on the long side, re-encodes (WebP or JPEG at 0.85; PNG kept when
 *   the image has transparency) and stores it with `mediaRepo`.
 *
 * Every failure becomes a {@link MediaError} with a plain-language
 * `userMessage`. The pure helpers ({@link fitSize}, {@link chooseFormat})
 * are unit-testable in Node; importing this module touches no DOM.
 *
 * @module features/scratch/media
 */

import { mediaRepo } from '../../core/store/repo.js';

/** Longest side of a stored image (px). */
export const MAX_SIDE = 2048;
/** Encoder quality for JPEG / WebP. */
export const QUALITY = 0.85;
/** Largest file we try to open (bytes). */
export const MAX_INPUT_BYTES = 60 * 1024 * 1024;
/** Largest stored image (bytes); bigger encodes are retried at lower quality. */
export const MAX_STORED_BYTES = 6 * 1024 * 1024;

/** A failed image import, with a message for the user. */
export class MediaError extends Error {
  /**
   * @param {'not-image' | 'too-big' | 'decode' | 'encode' | 'storage' | 'cancelled'} code
   * @param {string} userMessage
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(code, userMessage, opts = {}) {
    super(userMessage, opts);
    this.name = 'MediaError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

/**
 * Size that fits inside `max` on the long side (never upscales). Pure.
 * @param {number} w
 * @param {number} h
 * @param {number} [max=MAX_SIDE]
 * @returns {{ w: number, h: number, scaled: boolean }}
 */
export function fitSize(w, h, max = MAX_SIDE) {
  const W = Math.max(1, Math.round(w) || 1);
  const H = Math.max(1, Math.round(h) || 1);
  const k = Math.min(1, max / Math.max(W, H));
  return { w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)), scaled: k < 1 };
}

/**
 * The output type to try first. Pure.
 * @param {{ hasAlpha: boolean, inputType?: string, webp?: boolean }} o
 * @returns {'image/png' | 'image/webp' | 'image/jpeg'}
 */
export function chooseFormat({ hasAlpha, webp = true }) {
  if (hasAlpha) return 'image/png';
  return webp ? 'image/webp' : 'image/jpeg';
}

/**
 * Does this file look like an image we can open?
 * @param {{ type?: string, name?: string } | null | undefined} file
 * @returns {boolean}
 */
export function isImageFile(file) {
  if (!file) return false;
  if (typeof file.type === 'string' && file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp|heic|heif|avif)$/i.test(file.name || '');
}

/**
 * Opens the device's image picker. Resolves with the chosen file, or null
 * when the user cancelled.
 * @returns {Promise<File | null>}
 */
export function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.className = 'scratch-file-input';
    input.hidden = true;
    let done = false;
    const finish = (/** @type {File | null} */ f) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(f);
    };
    input.addEventListener('change', () => finish(input.files?.[0] || null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input);
    input.click();
  });
}

/**
 * Image files carried by a paste or drop event.
 * @param {ClipboardEvent | DragEvent} e
 * @returns {File[]}
 */
export function imageFilesFrom(e) {
  const dt = /** @type {any} */ (e).clipboardData || /** @type {any} */ (e).dataTransfer;
  if (!dt) return [];
  /** @type {File[]} */
  const out = [];
  for (const item of dt.items ? [...dt.items] : []) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f && isImageFile(f)) out.push(f);
    }
  }
  if (!out.length && dt.files) for (const f of dt.files) if (isImageFile(f)) out.push(f);
  return out;
}

/**
 * Decodes a file, applying its EXIF orientation.
 * @param {Blob} file
 * @returns {Promise<ImageBitmap | HTMLImageElement>}
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall back to <img> (e.g. older Safari with options) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {string} type
 * @param {number} quality
 * @returns {Promise<Blob | null>}
 */
function toBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/**
 * True when any pixel is not fully opaque (sampled on a small copy).
 * @param {CanvasImageSource} src
 * @param {number} w
 * @param {number} h
 * @returns {boolean}
 */
function hasTransparency(src, w, h) {
  const s = fitSize(w, h, 256);
  const c = document.createElement('canvas');
  c.width = s.w;
  c.height = s.h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(src, 0, 0, s.w, s.h);
  const data = ctx.getImageData(0, 0, s.w, s.h).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true;
  return false;
}

/**
 * Turns a picked, pasted or dropped file into a stored image.
 * @param {File | Blob} file
 * @param {{ qid: string }} opts
 * @returns {Promise<{ id: string, width: number, height: number, bitmap: ImageBitmap | null }>}
 *   `bitmap` is a decoded copy for immediate display (may be null).
 */
export async function importImage(file, { qid }) {
  if (!file || (!isImageFile(/** @type {any} */ (file)) && !(file.type || '').startsWith('image/'))) {
    throw new MediaError('not-image', "That file isn't a picture. Choose a photo or an image file.");
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new MediaError('too-big', 'That picture is too large to open (over 60 MB). Try a smaller one.');
  }
  /** @type {ImageBitmap | HTMLImageElement} */
  let src;
  try {
    src = await decode(file);
  } catch (err) {
    throw new MediaError(
      'decode',
      "This picture couldn't be opened. Try a JPEG or PNG (some formats, like HEIC on some phones, aren't supported).",
      { cause: err },
    );
  }
  const natW = /** @type {any} */ (src).naturalWidth || src.width;
  const natH = /** @type {any} */ (src).naturalHeight || src.height;
  const size = fitSize(natW, natH);
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new MediaError('encode', "This picture couldn't be prepared. Please try again.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const mayHaveAlpha = !/jpe?g/i.test(file.type || '');
  const alpha = mayHaveAlpha && hasTransparency(src, natW, natH);
  ctx.drawImage(src, 0, 0, size.w, size.h);
  if ('close' in src && typeof src.close === 'function') src.close();

  /** @type {Blob | null} */
  let blob = null;
  if (alpha) {
    blob = await toBlob(canvas, 'image/png', 1);
    if (blob && blob.size > MAX_STORED_BYTES) blob = await toBlob(canvas, 'image/webp', QUALITY);
  } else {
    blob = await toBlob(canvas, 'image/webp', QUALITY);
    // Browsers without a WebP encoder return PNG: use JPEG instead.
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', QUALITY);
    for (let q = 0.7; blob && blob.size > MAX_STORED_BYTES && q >= 0.4; q -= 0.15) {
      blob = await toBlob(canvas, blob.type, q);
    }
  }
  if (!blob || !blob.size) throw new MediaError('encode', "This picture couldn't be prepared. Please try another one.");

  let rec;
  try {
    rec = await mediaRepo.add({ qid, blob, mime: blob.type, width: size.w, height: size.h });
  } catch (err) {
    const name = /** @type {any} */ (err)?.name;
    throw new MediaError(
      'storage',
      name === 'RangeError'
        ? 'That picture is too large to keep. Try a smaller one.'
        : "There isn't enough storage space to keep this picture. Free up some space on your device and try again.",
      { cause: err },
    );
  }
  let bitmap = null;
  try {
    bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(canvas) : null;
  } catch {
    bitmap = null;
  }
  return { id: rec.id, width: size.w, height: size.h, bitmap };
}

/**
 * The stored blob of an image (null when missing, e.g. a backup without media).
 * @param {string} id
 * @returns {Promise<Blob | null>}
 */
export async function loadMediaBlob(id) {
  try {
    const rec = await mediaRepo.get(id);
    return rec && rec.blob ? rec.blob : null;
  } catch {
    return null;
  }
}

/**
 * Removes a question's images that the scene no longer uses (never throws).
 * @param {string} qid
 * @param {Iterable<string>} keepIds
 * @returns {Promise<string[]>}
 */
export async function pruneMedia(qid, keepIds) {
  try {
    return await mediaRepo.prune(qid, new Set(keepIds));
  } catch (err) {
    console.warn('[scratch] could not tidy unused images', err);
    return [];
  }
}
