/**
 * Range copy: builds a new PDF holding only pages `from..to` of a (possibly
 * huge) PDF Blob **without reading the whole file** (docs/ARCHITECTURE.md §7.17,
 * "Export annotated copy" of a whole-book chapter).
 *
 * pdf-lib can only load a complete file into memory, which a 400 MB book on a
 * phone cannot afford. This module reads the file the way a PDF reader does:
 *
 * 1. the tail (`startxref`), then every cross-reference section — classic
 *    `xref` tables and compressed cross-reference streams, hybrid files
 *    (`/XRefStm`) and incremental updates (`/Prev` chains; newest entry wins);
 * 2. the catalog and only the page-tree nodes on the way to the wanted pages
 *    (inherited `Resources`, `MediaBox`, `CropBox`, `Rotate` are carried down);
 * 3. every object those pages need, one `blob.slice()` per object (its span
 *    ends at the next object's offset) or per compressed object stream;
 * 4. copies them into a fresh pdf-lib `PDFDocument` (new object numbers).
 *
 * Nothing outside the pages is pulled in: links to other pages (`/Dest`,
 * `/A /GoTo`), annotation back-pointers (`/P`, `/Parent`, `/Popup`), article
 * beads and any stray reference to another page, the page tree or the catalog
 * are dropped (replaced by null). Encrypted files are refused (`code 'encrypted'`).
 *
 * The parsing helpers ({@link findStartXref}, {@link parseXrefTable},
 * {@link parseXrefStreamData}) are pure; the module touches no DOM, so it runs
 * in Node too (tests use a file-backed Blob).
 *
 * @module features/book/extract
 */

/** Bytes read from the end of the file to find `startxref`. */
const TAIL_BYTES = 4096;
/** Most cross-reference sections followed (protects against /Prev loops). */
const MAX_XREF_SECTIONS = 64;
/** Keys never copied from any dictionary (back-pointers into the page tree, fields or structure tree). */
const DROP_ALWAYS = new Set(['Parent', 'StructParent', 'StructParents']);
/** Keys never copied from an annotation (links back into the rest of the file). */
const DROP_IN_ANNOT = new Set(['P', 'Popup', 'Dest', 'IRT']);
/** Attributes a page inherits from its page-tree ancestors (PDF 32000 §7.7.3.4). */
const INHERITABLE = Object.freeze(['Resources', 'MediaBox', 'CropBox', 'Rotate']);

/** A file this module can't copy pages from. */
export class ExtractError extends Error {
  /**
   * @param {'encrypted' | 'structure' | 'read' | 'range'} code
   * @param {string} message Technical detail (not for users).
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts);
    this.name = 'ExtractError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Bytes → Latin-1 text (one char per byte). Pure.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

/**
 * The offset after the last `startxref` keyword of a file's tail. Pure.
 * @param {string} tail Latin-1 text of the last bytes.
 * @returns {number | null}
 */
export function findStartXref(tail) {
  const i = tail.lastIndexOf('startxref');
  if (i < 0) return null;
  const m = /^startxref\s+(\d+)/.exec(tail.slice(i));
  return m ? Number(m[1]) : null;
}

/**
 * @typedef {{ type: 0 | 1 | 2, offset?: number, gen?: number, stream?: number, index?: number }} XrefEntry
 * type 0 free · 1 at `offset` · 2 compressed in object stream `stream` at `index`.
 */

/**
 * Parses a classic cross-reference table starting with `xref`. Lenient about
 * whitespace (CR, LF, CRLF, extra spaces). Pure.
 * @param {string} text Latin-1 text from the `xref` keyword on.
 * @returns {{ entries: [number, XrefEntry][], trailerAt: number }} `trailerAt` = index of `trailer` in `text`.
 * @throws {ExtractError} When the table is malformed.
 */
export function parseXrefTable(text) {
  if (!/^\s*xref/.test(text)) throw new ExtractError('structure', 'no xref keyword');
  const re = /\s*(trailer|\d+)/y;
  re.lastIndex = text.indexOf('xref') + 4;
  /** @type {[number, XrefEntry][]} */
  const entries = [];
  for (let guard = 0; guard < 1e6; guard++) {
    const head = re.exec(text);
    if (!head) throw new ExtractError('structure', 'xref table ends early');
    if (head[1] === 'trailer') return { entries, trailerAt: re.lastIndex - 7 };
    const start = Number(head[1]);
    const countM = /\s+(\d+)/y;
    countM.lastIndex = re.lastIndex;
    const c = countM.exec(text);
    if (!c) throw new ExtractError('structure', 'xref subsection without count');
    const count = Number(c[1]);
    const row = /\s*(\d+)\s+(\d+)\s+([nf])/y;
    row.lastIndex = countM.lastIndex;
    for (let k = 0; k < count; k++) {
      const m = row.exec(text);
      if (!m) throw new ExtractError('structure', 'bad xref row');
      const num = start + k;
      entries.push(m[3] === 'n' ? [num, { type: 1, offset: Number(m[1]), gen: Number(m[2]) }] : [num, { type: 0 }]);
    }
    re.lastIndex = row.lastIndex;
  }
  throw new ExtractError('structure', 'xref table too long');
}

/**
 * Decodes the rows of a cross-reference stream. Pure.
 * @param {Uint8Array} data Decoded stream data.
 * @param {number[]} W Field widths `[w1, w2, w3]`.
 * @param {number[]} index `[start, count, start, count, …]`.
 * @returns {[number, XrefEntry][]}
 * @throws {ExtractError}
 */
export function parseXrefStreamData(data, W, index) {
  if (!Array.isArray(W) || W.length < 3 || W.some((w) => !Number.isInteger(w) || w < 0 || w > 8)) {
    throw new ExtractError('structure', 'bad /W in xref stream');
  }
  const [w1, w2, w3] = W;
  const rowLen = w1 + w2 + w3;
  if (rowLen === 0) throw new ExtractError('structure', 'empty /W');
  /** @param {number} at @param {number} w @param {number} dflt */
  const field = (at, w, dflt) => {
    if (w === 0) return dflt;
    let v = 0;
    for (let i = 0; i < w; i++) v = v * 256 + data[at + i];
    return v;
  };
  /** @type {[number, XrefEntry][]} */
  const out = [];
  let pos = 0;
  for (let s = 0; s + 1 < index.length; s += 2) {
    const start = index[s];
    const count = index[s + 1];
    for (let k = 0; k < count; k++) {
      if (pos + rowLen > data.length) throw new ExtractError('structure', 'xref stream shorter than its /Index');
      const type = field(pos, w1, 1);
      const a = field(pos + w1, w2, 0);
      const b = field(pos + w1 + w2, w3, 0);
      pos += rowLen;
      const num = start + k;
      if (type === 1) out.push([num, { type: 1, offset: a, gen: b }]);
      else if (type === 2) out.push([num, { type: 2, stream: a, index: b }]);
      else out.push([num, { type: 0 }]);
    }
  }
  return out;
}

/**
 * Undoes a PNG (Predictor ≥ 10) or TIFF (Predictor 2, 8-bit) predictor, as used
 * by most cross-reference streams (`/DecodeParms << /Predictor 12 /Columns 5 >>`). Pure.
 * @param {Uint8Array} data Inflated bytes.
 * @param {{ predictor?: number, columns?: number, colors?: number, bits?: number }} parms
 * @returns {Uint8Array}
 * @throws {ExtractError} On an unknown PNG row filter.
 */
export function unpredict(data, { predictor = 1, columns = 1, colors = 1, bits = 8 } = {}) {
  if (predictor < 2) return data;
  const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
  const rowLen = Math.ceil((columns * colors * bits) / 8);
  if (predictor === 2) {
    if (bits !== 8) return data;
    const out = data.slice();
    for (let r = 0; r + rowLen <= out.length; r += rowLen) for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const inAt = r * (rowLen + 1) + 1;
    const at = r * rowLen;
    for (let i = 0; i < rowLen; i++) {
      const x = data[inAt + i];
      const left = i >= bpp ? out[at + i - bpp] : 0;
      const up = r > 0 ? out[at - rowLen + i] : 0;
      const upLeft = r > 0 && i >= bpp ? out[at - rowLen + i - bpp] : 0;
      let v;
      switch (type) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + left;
          break;
        case 2:
          v = x + up;
          break;
        case 3:
          v = x + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new ExtractError('structure', `unknown PNG filter ${type}`);
      }
      out[at + i] = v & 255;
    }
  }
  return out;
}

/**
 * Index of the first byte after `N G obj` at the start of an object span, or -1. Pure.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function objectBodyStart(bytes) {
  const head = latin1(bytes.subarray(0, Math.min(bytes.length, 128)));
  const m = /^\s*\d+\s+\d+\s+obj/.exec(head);
  return m ? m[0].length : -1;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * Builds a new PDF holding pages `from..to` (1-based, inclusive) of `blob`.
 * @param {any} lib The pdf-lib module namespace (vendor/pdf-lib).
 * @param {Blob} blob The source PDF (read with `slice()` only).
 * @param {number} from
 * @param {number} to
 * @param {{ onRead?: (bytes: number) => void }} [opts] `onRead` reports every byte count read (diagnostics/tests).
 * @returns {Promise<any>} A pdf-lib `PDFDocument` with `to − from + 1` pages.
 * @throws {ExtractError}
 */
export async function extractPageRange(lib, blob, from, to, { onRead } = {}) {
  const { PDFDocument, PDFObjectParser, PDFContext, PDFRef, PDFDict, PDFArray, PDFName, PDFNumber, PDFRawStream, PDFNull, PDFPageLeaf, PDFPage } = lib;
  const size = blob.size;
  /**
   * Decoded stream data (filters by pdf-lib, then the predictor of /DecodeParms).
   * @param {any} stream PDFRawStream
   * @returns {Uint8Array}
   */
  const decodeStream = (stream) => {
    const data = lib.decodePDFRawStream(stream).decode();
    let parms = stream.dict.get(PDFName.of('DecodeParms'));
    if (parms instanceof PDFArray) parms = parms.size() ? parms.get(parms.size() - 1) : null;
    if (!(parms instanceof PDFDict)) return data;
    /** @param {string} k @param {number} d */
    const n = (k, d) => {
      const v = parms.get(PDFName.of(k));
      return v instanceof PDFNumber ? v.asNumber() : d;
    };
    return unpredict(data, { predictor: n('Predictor', 1), columns: n('Columns', 1), colors: n('Colors', 1), bits: n('BitsPerComponent', 8) });
  };

  /** @param {number} start @param {number} end */
  const read = async (start, end) => {
    const a = Math.max(0, Math.min(size, start));
    const b = Math.max(a, Math.min(size, end));
    try {
      const buf = new Uint8Array(await blob.slice(a, b).arrayBuffer());
      onRead?.(buf.length);
      return buf;
    } catch (err) {
      throw new ExtractError('read', `could not read bytes ${a}–${b}`, { cause: err });
    }
  };

  const src = PDFContext.create();
  /** @param {Uint8Array} bytes */
  const parseObj = (bytes) => PDFObjectParser.forBytes(bytes, src).parseObject();

  /** @param {any} v */
  const num = (v) => (v instanceof PDFNumber ? v.asNumber() : null);
  /** @param {any} dict @param {string} key */
  const getRaw = (dict, key) => (dict && typeof dict.get === 'function' ? dict.get(PDFName.of(key)) : undefined);

  // ---- 1. cross-reference sections ----
  const tail = latin1(await read(size - TAIL_BYTES, size));
  const startxref = findStartXref(tail);
  if (startxref === null || startxref >= size) throw new ExtractError('structure', 'no startxref');

  /** @type {Map<number, XrefEntry>} */
  const xref = new Map();
  /** @type {any} */
  let trailer = null;
  /** @type {number[]} */
  const sectionOffsets = [];
  const queue = [startxref];
  /** @type {Set<number>} */
  const seen = new Set();
  /** @param {[number, XrefEntry][]} entries */
  const addEntries = (entries) => {
    for (const [n, e] of entries) if (!xref.has(n)) xref.set(n, e);
  };

  // Spans of xref sections are unknown before all offsets are known: read generously and grow.
  /** @param {number} at */
  const readSection = async (at) => {
    let len = 64 * 1024;
    for (;;) {
      const bytes = await read(at, at + len);
      const text = latin1(bytes.subarray(0, Math.min(bytes.length, 16)));
      if (/^\s*xref/.test(text)) {
        const full = latin1(bytes);
        try {
          const { entries, trailerAt } = parseXrefTable(full);
          const end = full.indexOf('>>', trailerAt) >= 0 ? findDictEnd(full, full.indexOf('<<', trailerAt)) : -1;
          if (end < 0) throw new ExtractError('structure', 'trailer cut');
          const dict = parseObj(bytes.subarray(full.indexOf('<<', trailerAt), end));
          return { entries, dict };
        } catch (err) {
          if (at + len >= size) throw err;
          len *= 4;
          continue;
        }
      }
      // A cross-reference stream object.
      const body = objectBodyStart(bytes);
      if (body < 0) throw new ExtractError('structure', 'startxref points at neither xref nor an object');
      /** @type {any} */
      let obj;
      try {
        obj = parseObj(bytes.subarray(body));
      } catch (err) {
        if (at + len >= size) throw new ExtractError('structure', 'xref stream unreadable', { cause: err });
        len *= 4;
        continue;
      }
      if (!(obj instanceof PDFRawStream)) throw new ExtractError('structure', 'xref object is not a stream');
      const contentsLen = num(getRaw(obj.dict, 'Length'));
      if (contentsLen !== null && obj.contents.length < contentsLen && at + len < size) {
        len = Math.max(len * 4, contentsLen + 4096);
        continue;
      }
      const data = decodeStream(obj);
      const W = arrayNumbers(getRaw(obj.dict, 'W'));
      const sizeN = num(getRaw(obj.dict, 'Size')) ?? 0;
      const idx = getRaw(obj.dict, 'Index') ? arrayNumbers(getRaw(obj.dict, 'Index')) : [0, sizeN];
      return { entries: parseXrefStreamData(data, W, idx), dict: obj.dict };
    }
  };
  /** @param {any} a */
  function arrayNumbers(a) {
    if (!(a instanceof PDFArray)) return [];
    const out = [];
    for (let i = 0; i < a.size(); i++) out.push(num(a.get(i)) ?? 0);
    return out;
  }

  while (queue.length) {
    const at = /** @type {number} */ (queue.shift());
    if (seen.has(at) || at < 0 || at >= size) continue;
    if (seen.size >= MAX_XREF_SECTIONS) break;
    seen.add(at);
    sectionOffsets.push(at);
    const { entries, dict } = await readSection(at);
    addEntries(entries);
    if (!trailer) trailer = dict;
    const stm = num(getRaw(dict, 'XRefStm'));
    if (stm !== null) queue.unshift(stm); // hybrid file: the stream belongs to this same update
    const prev = num(getRaw(dict, 'Prev'));
    if (prev !== null) queue.push(prev);
  }
  if (!trailer) throw new ExtractError('structure', 'no trailer');
  if (getRaw(trailer, 'Encrypt')) throw new ExtractError('encrypted', 'encrypted PDF');

  // Object spans: from an object's offset to the next known offset.
  const offsets = [...new Set([...[...xref.values()].filter((e) => e.type === 1).map((e) => /** @type {number} */ (e.offset)), ...sectionOffsets, size])].sort((a, b) => a - b);
  /** @param {number} at */
  const spanEnd = (at) => {
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= at) lo = mid + 1;
      else hi = mid;
    }
    return offsets[lo] > at ? offsets[lo] : size;
  };

  // ---- 2. object loading ----
  /** @type {Map<number, any>} */
  const objects = new Map();
  /** @type {Map<number, Map<number, any>>} */
  const objStreams = new Map();

  /** @param {number} stmNum */
  const loadObjectStream = async (stmNum) => {
    let table = objStreams.get(stmNum);
    if (table) return table;
    const stm = await loadNum(stmNum);
    if (!(stm instanceof PDFRawStream)) throw new ExtractError('structure', `object stream ${stmNum} is not a stream`);
    const data = decodeStream(stm);
    const n = num(getRaw(stm.dict, 'N')) ?? 0;
    const first = num(getRaw(stm.dict, 'First')) ?? 0;
    const header = latin1(data.subarray(0, first)).trim().split(/\s+/).map(Number);
    table = new Map();
    for (let i = 0; i < n; i++) {
      const objNum = header[i * 2];
      const off = header[i * 2 + 1];
      const next = i + 1 < n ? header[i * 2 + 3] : data.length - first;
      if (!Number.isInteger(objNum) || !Number.isInteger(off)) continue;
      try {
        table.set(objNum, parseObj(data.subarray(first + off, first + next)));
      } catch {
        /* a broken entry stays missing (resolves to null) */
      }
    }
    objStreams.set(stmNum, table);
    return table;
  };

  /**
   * @param {number} n Object number.
   * @returns {Promise<any>} The object, or PDFNull when missing/broken.
   */
  async function loadNum(n) {
    if (objects.has(n)) return objects.get(n);
    const e = xref.get(n);
    let obj = PDFNull;
    if (e && e.type === 1) {
      const at = /** @type {number} */ (e.offset);
      const bytes = await read(at, spanEnd(at));
      const body = objectBodyStart(bytes);
      if (body >= 0) {
        try {
          obj = parseObj(bytes.subarray(body));
        } catch {
          obj = PDFNull;
        }
      }
    } else if (e && e.type === 2) {
      const table = await loadObjectStream(/** @type {number} */ (e.stream));
      obj = table.get(n) ?? PDFNull;
    }
    objects.set(n, obj);
    // Lets pdf-lib's own lookups (e.g. an indirect /Filter) resolve inside the source context.
    if (obj !== PDFNull) src.assign(PDFRef.of(n, e && e.type === 1 ? /** @type {number} */ (e.gen) : 0), obj);
    return obj;
  }

  /** @param {any} v */
  const deref = async (v) => (v instanceof PDFRef ? loadNum(v.objectNumber) : v);
  /** @param {any} dict */
  const typeOf = (dict) => {
    const t = dict instanceof PDFDict ? dict.get(PDFName.of('Type')) : null;
    return t instanceof PDFName ? t.asString().replace(/^\//, '') : '';
  };

  // ---- 3. page tree ----
  const root = await deref(getRaw(trailer, 'Root'));
  if (!(root instanceof PDFDict)) throw new ExtractError('structure', 'no catalog');
  const first = Math.round(from);
  const last = Math.round(to);
  if (!(first >= 1 && last >= first)) throw new ExtractError('range', `bad range ${from}–${to}`);

  /** @type {{ ref: any, dict: any, inherited: Map<string, any> }[]} */
  const wanted = [];
  /**
   * @param {any} nodeRef
   * @param {number} startIndex 0-based index of the node's first page.
   * @param {Map<string, any>} inherited
   * @param {number} depth
   */
  const walk = async (nodeRef, startIndex, inherited, depth) => {
    if (depth > 64) throw new ExtractError('structure', 'page tree too deep');
    const node = await deref(nodeRef);
    if (!(node instanceof PDFDict)) return 0;
    const kids = node.get(PDFName.of('Kids'));
    const isTree = typeOf(node) === 'Pages' || (kids && !(typeOf(node) === 'Page'));
    if (!isTree) {
      if (startIndex + 1 >= first && startIndex + 1 <= last) wanted.push({ ref: nodeRef, dict: node, inherited });
      return 1;
    }
    const here = new Map(inherited);
    for (const key of INHERITABLE) {
      const v = node.get(PDFName.of(key));
      if (v !== undefined) here.set(key, v);
    }
    const kidList = await deref(kids);
    if (!(kidList instanceof PDFArray)) return 0;
    const count = num(await deref(node.get(PDFName.of('Count'))));
    // All kids are leaves when the count equals the number of kids: no need to read the others.
    const flat = count !== null && count === kidList.size();
    let index = startIndex;
    for (let i = 0; i < kidList.size(); i++) {
      if (index + 1 > last) break;
      const kidRef = kidList.get(i);
      if (flat) {
        if (index + 1 >= first) await walk(kidRef, index, here, depth + 1);
        index += 1;
        continue;
      }
      const kid = await deref(kidRef);
      const kidCount = kid instanceof PDFDict && typeOf(kid) !== 'Page' && kid.get(PDFName.of('Kids')) ? num(await deref(kid.get(PDFName.of('Count')))) : 1;
      const n = kidCount ?? 1;
      if (index + n >= first) await walk(kidRef, index, here, depth + 1);
      index += n;
    }
    return index - startIndex;
  };
  await walk(root.get(PDFName.of('Pages')), 0, new Map(), 0);
  if (wanted.length !== last - first + 1) throw new ExtractError('range', `found ${wanted.length} of ${last - first + 1} pages`);

  // ---- 4. copy ----
  const out = await PDFDocument.create({ updateMetadata: false });
  const dst = out.context;
  /** @type {Map<number, any>} source object number → new ref */
  const refMap = new Map();
  const pageNums = new Set(wanted.map((w) => (w.ref instanceof PDFRef ? w.ref.objectNumber : -1)));

  /**
   * @param {any} dict
   * @returns {Promise<boolean>} Whether a dictionary is an annotation action/link that leads elsewhere in the file.
   */
  const isInternalAction = async (dict) => {
    const a = await deref(dict);
    if (!(a instanceof PDFDict)) return false;
    const s = a.get(PDFName.of('S'));
    const kind = s instanceof PDFName ? s.asString().replace(/^\//, '') : '';
    return kind !== 'URI' && kind !== 'Launch';
  };

  /**
   * @param {any} v
   * @returns {Promise<any>}
   */
  const copyValue = async (v) => {
    if (v instanceof PDFRef) return copyRef(v);
    if (v instanceof PDFRawStream) return PDFRawStream.of(await copyDict(v.dict), v.contents);
    if (v instanceof PDFDict) return copyDict(v);
    if (v instanceof PDFArray) {
      const arr = PDFArray.withContext(dst);
      for (let i = 0; i < v.size(); i++) arr.push(await copyValue(v.get(i)));
      return arr;
    }
    return v; // names, numbers, strings, booleans, null: immutable
  };

  /**
   * @param {any} dict
   * @returns {Promise<any>}
   */
  const copyDict = async (dict) => {
    const outDict = PDFDict.withContext(dst);
    const isAnnot = typeOf(dict) === 'Annot' || (dict.get(PDFName.of('Subtype')) && dict.get(PDFName.of('Rect')));
    for (const [key, val] of dict.entries()) {
      const k = key.asString().replace(/^\//, '');
      if (DROP_ALWAYS.has(k) || (isAnnot && DROP_IN_ANNOT.has(k))) continue;
      if (isAnnot && (k === 'A' || k === 'PA') && (await isInternalAction(val))) continue;
      outDict.set(key, await copyValue(val));
    }
    return outDict;
  };

  /**
   * @param {any} ref
   * @returns {Promise<any>}
   */
  async function copyRef(ref) {
    const n = ref.objectNumber;
    const known = refMap.get(n);
    if (known) return known;
    const newRef = dst.nextRef();
    refMap.set(n, newRef);
    const obj = await loadNum(n);
    const t = typeOf(obj instanceof PDFRawStream ? obj.dict : obj);
    if (!pageNums.has(n) && (t === 'Page' || t === 'Pages' || t === 'Catalog')) {
      dst.assign(newRef, PDFNull);
      return newRef;
    }
    dst.assign(newRef, await copyValue(obj));
    return newRef;
  }

  // Reserve the new pages' refs first so references between them stay inside the copy.
  const pageRefs = wanted.map((w) => {
    const r = dst.nextRef();
    if (w.ref instanceof PDFRef) refMap.set(w.ref.objectNumber, r);
    return r;
  });
  for (let i = 0; i < wanted.length; i++) {
    const { dict, inherited } = wanted[i];
    /** @type {Map<any, any>} */
    const entries = new Map();
    for (const [key, val] of dict.entries()) {
      const k = key.asString().replace(/^\//, '');
      if (k === 'Parent' || k === 'B' || k === 'StructParents') continue;
      if (k === 'Annots') {
        const list = await deref(val);
        if (!(list instanceof PDFArray)) continue;
        const arr = PDFArray.withContext(dst);
        for (let j = 0; j < list.size(); j++) arr.push(await copyValue(list.get(j)));
        entries.set(key, arr);
        continue;
      }
      entries.set(key, await copyValue(val));
    }
    for (const key of INHERITABLE) {
      const name = PDFName.of(key);
      if (!entries.has(name) && inherited.has(key)) entries.set(name, await copyValue(inherited.get(key)));
    }
    if (!entries.has(PDFName.of('MediaBox'))) entries.set(PDFName.of('MediaBox'), dst.obj([0, 0, 612, 792]));
    if (!entries.has(PDFName.of('Resources'))) entries.set(PDFName.of('Resources'), dst.obj({}));
    entries.set(PDFName.of('Type'), PDFName.of('Page'));
    const leaf = PDFPageLeaf.fromMapWithContext(entries, dst, false);
    dst.assign(pageRefs[i], leaf);
    out.addPage(PDFPage.of(leaf, pageRefs[i], out));
  }
  return out;
}

/**
 * Index just after the `>>` that closes the dictionary opening at `open`
 * (nested dictionaries, strings and hex strings skipped). Pure.
 * @param {string} text
 * @param {number} open Index of `<<`.
 * @returns {number} -1 when not closed.
 */
export function findDictEnd(text, open) {
  if (open < 0 || text.slice(open, open + 2) !== '<<') return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      // literal string with nesting and escapes
      let d = 1;
      for (i++; i < text.length && d > 0; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '(') d++;
        else if (text[i] === ')') d--;
      }
      i--;
    } else if (c === '<' && text[i + 1] === '<') {
      depth++;
      i++;
    } else if (c === '<') {
      const close = text.indexOf('>', i + 1); // hex string
      if (close < 0) return -1;
      i = close;
    } else if (c === '>' && text[i + 1] === '>') {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    } else if (c === '%') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
    }
  }
  return -1;
}
