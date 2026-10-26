#!/usr/bin/env node
/**
 * Validates the question bank, the service-worker precache list and the
 * version stamps before a release (docs/ARCHITECTURE.md §3, §5.8, §5.9).
 *
 * Data checks
 * - `data/index.json`: schema; `parts` equal the fixed parts table (same
 *   order); all 55 `chapters` match the fixed chapter table exactly (id,
 *   number, part, prefix, file, title, page), sorted by number; `short`
 *   label; `published` flag (a published chapter must have questions);
 *   `count` equals the file contents; the `demo` entry matches DEMO and the
 *   demo file has at least one question.
 * - `data/retired.json`: shape, id format, known prefixes, no duplicates.
 * - Every chapter file, published or not, and the demo file:
 *   `schemaVersion`, chapter id, `questions` array.
 * - Every question: id format `PREFIX-NNNN` with the chapter's prefix
 *   (CH22-0001, DEMO-0001), globally unique, not retired; version, topic,
 *   tags, difficulty, reviewed, stem, image, 4–5 choices (ids a–e), answer,
 *   choice notes, source, demo flag (demo file only); every explanation
 *   block (§3.4) with unique, non-reserved ids; inline mini-markup checked
 *   with the app's own parser (§3.5, warnings: markers that would show
 *   literally, empty visible text, HTML-looking tags).
 * - Duplicate questions (error), identical or near-identical stems
 *   (warnings), answer-position balance per chapter (warning when a chapter
 *   has ≥ 20 questions and one position holds > 40% of the answers).
 *
 * App checks (skipped with --data-only)
 * - `sw.js` VERSION equals `js/version.js` APP_VERSION (format YYYY.MM.DD-N).
 * - Every file under js/, css/, icons/ plus index.html and
 *   manifest.webmanifest is in sw.js APP_SHELL, and every APP_SHELL entry
 *   exists on disk and is not under data/ (data is precached from the index:
 *   published chapters and the demo only).
 *
 * Usage:
 *   node scripts/validate.mjs               # everything
 *   node scripts/validate.mjs --data-only   # skip sw.js / version checks
 *   node scripts/validate.mjs --strict      # warnings also fail
 *   node scripts/validate.mjs --quiet       # problems and the result line only
 *   node scripts/validate.mjs --root DIR    # validate another checkout
 *
 * Exit code 1 on any error (or any warning with --strict), else 0.
 * Dev-only (Node 20+, no dependencies). Never loaded by the app.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { inlineToPlain, parseInline } from '../js/features/explain/inline.js';

/** Repository root (this file lives in scripts/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Data schema version this app understands. */
export const SCHEMA_VERSION = 1;

/**
 * @typedef {object} PartRow
 * @property {string} id       `p1` … `p7`.
 * @property {string} number   Roman numeral shown in the app (`I` … `VII`).
 * @property {number} volume   Book volume (1 or 2).
 * @property {string} title
 */

/**
 * The fixed parts of the book (§3.1), in book order. `parts` in index.json
 * must equal it, in the same order.
 * @type {ReadonlyArray<Readonly<PartRow>>}
 */
export const PARTS = Object.freeze([
  { id: 'p1', number: 'I', volume: 1, title: 'General Considerations' },
  { id: 'p2', number: 'II', volume: 1, title: 'Ischemic Heart Disease' },
  { id: 'p3', number: 'III', volume: 1, title: 'Acquired Valvar Heart Disease' },
  { id: 'p4', number: 'IV', volume: 1, title: 'Other Cardiac Conditions' },
  { id: 'p5', number: 'V', volume: 1, title: 'Advanced Heart Failure' },
  { id: 'p6', number: 'VI', volume: 1, title: 'Diseases of the Thoracic Arteries and Veins' },
  { id: 'p7', number: 'VII', volume: 2, title: 'Congenital Heart Disease' },
].map((p) => Object.freeze(p)));

/**
 * @typedef {object} ChapterRow
 * @property {number} number   Chapter number in the book (1 … 55).
 * @property {string} id       `ch01` … `ch55`.
 * @property {string} prefix   Question id prefix (`CH01` … `CH55`).
 * @property {string} file     Repo-relative chapter file.
 * @property {string} part     Part id (see PARTS).
 * @property {number} page     First page of the chapter in the owner's book.
 * @property {string} title
 */

/**
 * The fixed chapter table (§3.1): the 55 chapters of the book, in book order.
 * Ids, prefixes and files never change (progress is keyed by question id).
 * Every entry of `chapters` in index.json must match its row exactly.
 * @type {ReadonlyArray<Readonly<ChapterRow>>}
 */
export const CHAPTER_TABLE = Object.freeze([
  { number: 1, id: 'ch01', prefix: 'CH01', file: 'data/ch01.json', part: 'p1', page: 1, title: 'Anatomy and Dimensions' },
  { number: 2, id: 'ch02', prefix: 'CH02', file: 'data/ch02.json', part: 'p1', page: 28, title: 'Hypothermia, Circulatory Arrest, and Cardiopulmonary Bypass' },
  { number: 3, id: 'ch03', prefix: 'CH03', file: 'data/ch03.json', part: 'p1', page: 84, title: 'Myocardial Management During Cardiac Surgery with Cardiopulmonary Bypass' },
  { number: 4, id: 'ch04', prefix: 'CH04', file: 'data/ch04.json', part: 'p1', page: 105, title: 'Anesthesia and Postoperative Care' },
  { number: 5, id: 'ch05', prefix: 'CH05', file: 'data/ch05.json', part: 'p1', page: 186, title: 'Cardiac Reoperations: Considerations and Techniques' },
  { number: 6, id: 'ch06', prefix: 'CH06', file: 'data/ch06.json', part: 'p1', page: 200, title: 'Cardiac Imaging' },
  { number: 7, id: 'ch07', prefix: 'CH07', file: 'data/ch07.json', part: 'p1', page: 235, title: 'Generating Knowledge from Information, Data, and Analyses' },
  { number: 8, id: 'ch08', prefix: 'CH08', file: 'data/ch08.json', part: 'p1', page: 353, title: 'Quality Assurance' },
  { number: 9, id: 'ch09', prefix: 'CH09', file: 'data/ch09.json', part: 'p2', page: 384, title: 'Stenotic Arteriosclerotic Coronary Artery Disease' },
  { number: 10, id: 'ch10', prefix: 'CH10', file: 'data/ch10.json', part: 'p2', page: 464, title: 'Acute and Chronic Complications of Myocardial Infarction' },
  { number: 11, id: 'ch11', prefix: 'CH11', file: 'data/ch11.json', part: 'p3', page: 500, title: 'Mitral Valve Disease' },
  { number: 12, id: 'ch12', prefix: 'CH12', file: 'data/ch12.json', part: 'p3', page: 552, title: 'Aortic Valve' },
  { number: 13, id: 'ch13', prefix: 'CH13', file: 'data/ch13.json', part: 'p3', page: 637, title: 'Tricuspid Valve Disease' },
  { number: 14, id: 'ch14', prefix: 'CH14', file: 'data/ch14.json', part: 'p3', page: 649, title: 'Infective Endocarditis' },
  { number: 15, id: 'ch15', prefix: 'CH15', file: 'data/ch15.json', part: 'p4', page: 685, title: 'Cardiac Rhythm Disturbances' },
  { number: 16, id: 'ch16', prefix: 'CH16', file: 'data/ch16.json', part: 'p4', page: 724, title: 'Cardiac Trauma' },
  { number: 17, id: 'ch17', prefix: 'CH17', file: 'data/ch17.json', part: 'p4', page: 732, title: 'Cardiac Tumor' },
  { number: 18, id: 'ch18', prefix: 'CH18', file: 'data/ch18.json', part: 'p4', page: 748, title: 'Pericardial Disease' },
  { number: 19, id: 'ch19', prefix: 'CH19', file: 'data/ch19.json', part: 'p4', page: 763, title: 'Obstructive Hypertrophic Cardiomyopathy' },
  { number: 20, id: 'ch20', prefix: 'CH20', file: 'data/ch20.json', part: 'p5', page: 787, title: 'Mechanical Circulatory Support' },
  { number: 21, id: 'ch21', prefix: 'CH21', file: 'data/ch21.json', part: 'p5', page: 829, title: 'Cardiac Transplantation' },
  { number: 22, id: 'ch22', prefix: 'CH22', file: 'data/ch22.json', part: 'p6', page: 898, title: 'Acute Aortic Dissection' },
  { number: 23, id: 'ch23', prefix: 'CH23', file: 'data/ch23.json', part: 'p6', page: 927, title: 'Chronic Thoracic and Thoracoabdominal Aortic Disease' },
  { number: 24, id: 'ch24', prefix: 'CH24', file: 'data/ch24.json', part: 'p6', page: 971, title: 'Acute Traumatic Aortic Disruption' },
  { number: 25, id: 'ch25', prefix: 'CH25', file: 'data/ch25.json', part: 'p6', page: 986, title: 'Diseases of the Pulmonary Arteries and Systemic Veins' },
  { number: 26, id: 'ch26', prefix: 'CH26', file: 'data/ch26.json', part: 'p7', page: 1013, title: 'Anatomic Considerations in Congenital Heart Disease' },
  { number: 27, id: 'ch27', prefix: 'CH27', file: 'data/ch27.json', part: 'p7', page: 1024, title: 'Nomenclature for Congenital Heart Disease' },
  { number: 28, id: 'ch28', prefix: 'CH28', file: 'data/ch28.json', part: 'p7', page: 1030, title: 'Patent Ductus Arteriosus' },
  { number: 29, id: 'ch29', prefix: 'CH29', file: 'data/ch29.json', part: 'p7', page: 1044, title: 'Atrial Septal Defect, Partial Anomalous Pulmonary Venous Connection, Unroofed Coronary Sinus' },
  { number: 30, id: 'ch30', prefix: 'CH30', file: 'data/ch30.json', part: 'p7', page: 1079, title: 'Total Anomalous Pulmonary Venous Connection' },
  { number: 31, id: 'ch31', prefix: 'CH31', file: 'data/ch31.json', part: 'p7', page: 1105, title: 'Cor Triatriatum' },
  { number: 32, id: 'ch32', prefix: 'CH32', file: 'data/ch32.json', part: 'p7', page: 1114, title: 'Atrioventricular Septal Defect' },
  { number: 33, id: 'ch33', prefix: 'CH33', file: 'data/ch33.json', part: 'p7', page: 1164, title: 'Ventricular Septal Defect' },
  { number: 34, id: 'ch34', prefix: 'CH34', file: 'data/ch34.json', part: 'p7', page: 1212, title: 'Ventricular Septal Defect with Pulmonary Stenosis' },
  { number: 35, id: 'ch35', prefix: 'CH35', file: 'data/ch35.json', part: 'p7', page: 1288, title: 'Ventricular Septal Defect with Pulmonary Atresia' },
  { number: 36, id: 'ch36', prefix: 'CH36', file: 'data/ch36.json', part: 'p7', page: 1318, title: 'Pulmonary Stenosis or Atresia with Intact Ventricular Septum' },
  { number: 37, id: 'ch37', prefix: 'CH37', file: 'data/ch37.json', part: 'p7', page: 1347, title: 'Congenital Sinus of Valsalva Aneurysm and Aortico Ventricular Tunnel' },
  { number: 38, id: 'ch38', prefix: 'CH38', file: 'data/ch38.json', part: 'p7', page: 1363, title: 'Congenital Anomalies of the Coronary Arteries' },
  { number: 39, id: 'ch39', prefix: 'CH39', file: 'data/ch39.json', part: 'p7', page: 1397, title: 'Vascular Rings and Pulmonary Artery Sling' },
  { number: 40, id: 'ch40', prefix: 'CH40', file: 'data/ch40.json', part: 'p7', page: 1415, title: 'Coarctation of the Aorta and Interrupted Aortic Arch' },
  { number: 41, id: 'ch41', prefix: 'CH41', file: 'data/ch41.json', part: 'p7', page: 1468, title: 'Aortopulmonary Window' },
  { number: 42, id: 'ch42', prefix: 'CH42', file: 'data/ch42.json', part: 'p7', page: 1476, title: 'Origin of the Right or Left Pulmonary Artery from the Ascending Aorta' },
  { number: 43, id: 'ch43', prefix: 'CH43', file: 'data/ch43.json', part: 'p7', page: 1483, title: 'Truncus Arteriosus' },
  { number: 44, id: 'ch44', prefix: 'CH44', file: 'data/ch44.json', part: 'p7', page: 1509, title: 'Transposition of the Great Arteries' },
  { number: 45, id: 'ch45', prefix: 'CH45', file: 'data/ch45.json', part: 'p7', page: 1562, title: 'Double Outlet Right Ventricle' },
  { number: 46, id: 'ch46', prefix: 'CH46', file: 'data/ch46.json', part: 'p7', page: 1587, title: 'Double Outlet Left Ventricle' },
  { number: 47, id: 'ch47', prefix: 'CH47', file: 'data/ch47.json', part: 'p7', page: 1596, title: 'Congenitally Corrected Transposition of the Great Arteries, Other Forms of Atrioventricular Discordant Connection, and Anatomically Corrected Malposition of the Great Arteries' },
  { number: 48, id: 'ch48', prefix: 'CH48', file: 'data/ch48.json', part: 'p7', page: 1635, title: 'Ebstein Anomaly' },
  { number: 49, id: 'ch49', prefix: 'CH49', file: 'data/ch49.json', part: 'p7', page: 1666, title: 'Congenital and Pediatric Mitral Valve Disease' },
  { number: 50, id: 'ch50', prefix: 'CH50', file: 'data/ch50.json', part: 'p7', page: 1685, title: 'Congenital Aortic Stenosis' },
  { number: 51, id: 'ch51', prefix: 'CH51', file: 'data/ch51.json', part: 'p7', page: 1723, title: 'Hypoplastic Left Heart Syndrome' },
  { number: 52, id: 'ch52', prefix: 'CH52', file: 'data/ch52.json', part: 'p7', page: 1756, title: 'Functional Single Ventricle' },
  { number: 53, id: 'ch53', prefix: 'CH53', file: 'data/ch53.json', part: 'p7', page: 1833, title: 'Heterotaxy' },
  { number: 54, id: 'ch54', prefix: 'CH54', file: 'data/ch54.json', part: 'p7', page: 1846, title: 'Congenital Heart Disease in the Adult' },
  { number: 55, id: 'ch55', prefix: 'CH55', file: 'data/ch55.json', part: 'p7', page: 1941, title: 'Congenital Heart Surgery in Low-Resource Settings' },
].map((c) => Object.freeze(c)));

/**
 * The demo chapter (§3.1): questions about using the app, each with
 * `"demo": true`. Always loadable; it stands in for the bank while no chapter
 * is published. The `demo` entry of index.json must match it.
 * @type {Readonly<{ id: string, prefix: string, file: string, title: string }>}
 */
export const DEMO = Object.freeze({ id: 'demo', prefix: 'DEMO', file: 'data/demo.json', title: 'App tour (demo)' });

/**
 * @typedef {object} BankFile  One question file to validate.
 * @property {string} id
 * @property {string} prefix
 * @property {string} file
 * @property {string} title
 * @property {number | null} number  Chapter number (null for the demo).
 * @property {boolean} demo
 */

/**
 * Every question file, in book order: the 55 chapters, then the demo.
 * @type {ReadonlyArray<Readonly<BankFile>>}
 */
const BANK_FILES = Object.freeze([
  ...CHAPTER_TABLE.map((t) => Object.freeze({ id: t.id, prefix: t.prefix, file: t.file, title: t.title, number: t.number, demo: false })),
  Object.freeze({ id: DEMO.id, prefix: DEMO.prefix, file: DEMO.file, title: DEMO.title, number: null, demo: true }),
]);

/** Question id: `PREFIX-NNNN` (4+ digits). */
export const QID_RE = /^([A-Z][A-Z0-9]*)-(\d{4,})$/;
/** Explanation block id. */
export const BLOCK_ID_RE = /^[a-z0-9-]+$/;
/** App version `YYYY.MM.DD-N`. */
export const VERSION_RE = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d{0,5})$/;

const CHOICE_IDS = ['a', 'b', 'c', 'd', 'e'];
const CALLOUT_KINDS = ['key', 'pearl', 'pitfall', 'mnemonic'];
const INDEX_FILE = 'data/index.json';
const RETIRED_FILE = 'data/retired.json';

/** Allowed fields in index.json: top level, parts, chapters, demo (§3.1). */
const INDEX_KEYS = Object.freeze(['schemaVersion', 'parts', 'chapters', 'demo']);
const PART_KEYS = Object.freeze(['id', 'number', 'volume', 'title']);
const CHAPTER_KEYS = Object.freeze(['id', 'number', 'part', 'prefix', 'title', 'short', 'file', 'page', 'published', 'count']);
const DEMO_KEYS = Object.freeze(['id', 'prefix', 'title', 'short', 'file', 'count']);
/** Fields of a chapter entry that must equal its CHAPTER_TABLE row (`id` is the lookup key). */
const CHAPTER_FIXED = Object.freeze(['number', 'part', 'prefix', 'file', 'title', 'page']);
/** `short` labels longer than this get a warning (they must fit on chips). */
const SHORT_MAX = 16;

/** Allowed fields per question (anything else is probably a typo). */
const QUESTION_KEYS = new Set([
  'id', 'version', 'topic', 'tags', 'difficulty', 'reviewed', 'demo', 'stem', 'image',
  'choices', 'answer', 'explanation', 'choiceNotes', 'source',
]);
/** Allowed fields per block type, besides `id` and `type` (§3.4). */
const BLOCK_FIELDS = Object.freeze({
  heading: ['text'],
  p: ['text'],
  list: ['ordered', 'items'],
  table: ['caption', 'head', 'rows', 'emphasis'],
  flow: ['title', 'steps'],
  mindmap: ['center', 'branches'],
  callout: ['kind', 'title', 'text', 'items'],
  quote: ['text', 'ref'],
  image: ['src', 'alt', 'caption'],
});
/** Block ids that would collide with annotation anchors (§4 Highlight.block, ink "scratch"). */
const RESERVED_BLOCK_ID_RE = /^(stem|scratch|choice-.*|note-.*)$/;

/** Answer-position balance: only judged from this many questions per chapter… */
const BALANCE_MIN_QUESTIONS = 20;
/** …and flagged when one position holds more than this share. */
const BALANCE_MAX_SHARE = 0.4;
/** Near-duplicate stems: Jaccard similarity of word 3-grams (same chapter). */
const SIMILARITY_THRESHOLD = 0.85;
/** Stems shorter than this (in words) are too generic to compare for similarity. */
const SIMILARITY_MIN_WORDS = 8;

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * @typedef {{ level: 'error' | 'warning', file: string, where: string, message: string }} Problem
 */

/** Collects problems in discovery order. */
export class Reporter {
  constructor() {
    /** @type {Problem[]} */
    this.problems = [];
  }

  /**
   * @param {string} file Repo-relative file.
   * @param {string} where Question id and/or JSON path ('' for the whole file).
   * @param {string} message
   */
  error(file, where, message) {
    this.problems.push({ level: 'error', file, where, message });
  }

  /**
   * @param {string} file
   * @param {string} where
   * @param {string} message
   */
  warn(file, where, message) {
    this.problems.push({ level: 'warning', file, where, message });
  }

  get errorCount() {
    return this.problems.filter((p) => p.level === 'error').length;
  }

  get warningCount() {
    return this.problems.filter((p) => p.level === 'warning').length;
  }
}

/**
 * Error/warning helpers bound to one file and question.
 * @typedef {{ err: (at: string, msg: string) => void, warn: (at: string, msg: string) => void, file: string, qid: string }} Ctx
 */

/**
 * @param {Reporter} rep
 * @param {string} file
 * @param {string} qid Question id or a `questions[i]` label.
 * @returns {Ctx}
 */
function makeCtx(rep, file, qid) {
  const where = (/** @type {string} */ at) => [qid, at].filter(Boolean).join('  ');
  return {
    file,
    qid,
    err: (at, msg) => rep.error(file, where(at), msg),
    warn: (at, msg) => rep.warn(file, where(at), msg),
  };
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v */
function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `${typeof v} ${JSON.stringify(v)}`.slice(0, 60);
}

/** @param {string} p */
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} p */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} p Path with OS separators. */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Lists files under a directory, recursively, as repo-relative posix paths.
 * Dotfiles and dot-directories are ignored.
 * @param {string} root
 * @param {string} rel
 * @returns {string[]}
 */
function walkFiles(root, rel) {
  const abs = path.join(root, rel);
  if (!isDir(abs)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(root, childRel));
    else if (entry.isFile()) out.push(childRel);
  }
  return out.sort();
}

/**
 * Why a relative app path is unsafe, or null when fine.
 * @param {string} p
 * @returns {string | null}
 */
function unsafePathReason(p) {
  if (p.startsWith('/')) return 'must be relative (no leading "/"), because the app lives under a sub-path';
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return 'must be a relative path inside the app, not a URL';
  if (p.includes('\\')) return 'must use "/" separators';
  if (p.split('/').some((seg) => seg === '..')) return 'must not go up with ".."';
  return null;
}

/**
 * Reads and parses a JSON file; reports problems and returns undefined on failure.
 * @param {Reporter} rep
 * @param {string} root
 * @param {string} rel
 * @returns {any}
 */
function readJson(rep, root, rel) {
  const abs = path.join(root, rel);
  if (!isFile(abs)) {
    rep.error(rel, '', 'file not found');
    return undefined;
  }
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (err) {
    rep.error(rel, '', `cannot read file: ${err.message}`);
    return undefined;
  }
  if (text.charCodeAt(0) === 0xfeff) {
    rep.warn(rel, '', 'starts with a byte-order mark (BOM); save as plain UTF-8');
    text = text.slice(1);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    rep.error(rel, '', `invalid JSON: ${jsonErrorWithPosition(err, text)}`);
    return undefined;
  }
}

/**
 * Adds "line L, column C" to a JSON.parse error when Node only gives a position.
 * @param {any} err
 * @param {string} text
 */
function jsonErrorWithPosition(err, text) {
  const msg = String(err?.message ?? err);
  if (/line \d+/i.test(msg)) return msg;
  const m = /position (\d+)/i.exec(msg);
  if (!m) return msg;
  const pos = Number(m[1]);
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  return `${msg} (line ${line}, column ${col})`;
}

/**
 * Lowercased words of a markup string, for duplicate detection.
 * @param {string} s
 */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/<->|<-|->|=>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Characters a backslash escapes in inline markup (same set as features/explain/inline.js). */
const INLINE_ESCAPE_RE = /\\([\\*_=^~`\-<>])/g;
/** Stands in for an escaped character while checking: never a marker, never whitespace. */
const ESCAPED_SENTINEL = '';
const WORD_CHAR_RE = /[\p{L}\p{N}\p{M}_]/u;

/**
 * Inline mini-markup problems (§3.5) in one string, judged by the real parser
 * (`parseInline`/`inlineToPlain` from js/features/explain/inline.js), so a
 * warning means the app really shows a marker as literal text. Escaped
 * characters (`\*`) and code spans are literal on purpose and never flagged.
 *
 * Flags: unpaired or wrong-length `**` / `==` / `_` runs, an unclosed `^` or
 * `~` glued to a word (`x^2`, `CO~2`), any stray backtick, long arrows that
 * stay literal (`-->`, `==>`, `<--`), text that renders empty, HTML-looking
 * tags, leading or trailing spaces. A lone `~5 mm` (approx.) is fine.
 *
 * @param {string} s
 * @returns {string[]}
 */
export function inlineIssues(s) {
  /** @type {string[]} */
  const issues = [];
  /** @param {string} msg */
  const add = (msg) => {
    if (!issues.includes(msg)) issues.push(msg);
  };
  const plain = inlineToPlain(s);
  if (s.trim() !== '' && plain.trim() === '') add('renders as empty text');

  // Parse a copy with each escaped character replaced by a sentinel: what is
  // left as a marker character in a text token was not escaped and not used.
  const masked = s.replace(INLINE_ESCAPE_RE, ESCAPED_SENTINEL);
  for (const text of literalTexts(parseInline(masked))) {
    for (const m of text.matchAll(/\*{2,}/g)) {
      add(m[0].length === 2
        ? 'unpaired ** (bold) marker shows literally; close it, or write \\*\\* for literal stars'
        : `"${m[0]}" shows literally (bold is exactly **…**); write \\* for literal stars`);
    }
    for (const m of text.matchAll(/(?<![-<])={2,}(?!>)/g)) {
      add(m[0].length === 2
        ? 'unpaired == (mark) marker shows literally; close it, or write \\=\\= for literal equals signs'
        : `"${m[0]}" shows literally (mark is exactly ==…==); write \\= for literal equals signs`);
    }
    for (const m of text.matchAll(/_+/g)) {
      const i = /** @type {number} */ (m.index);
      const inWord = i > 0 && WORD_CHAR_RE.test(text[i - 1]) && WORD_CHAR_RE.test(text[i + m[0].length] ?? '');
      if (!inWord) add('unpaired _ (italic) marker shows literally; close it, or write \\_ for a literal underscore');
    }
    for (const [ch, name] of /** @type {const} */ ([['^', 'superscript'], ['~', 'subscript']])) {
      for (let i = text.indexOf(ch); i !== -1; i = text.indexOf(ch, i + 1)) {
        const glued = i > 0 && WORD_CHAR_RE.test(text[i - 1]) && i + 1 < text.length && !/\s/.test(text[i + 1]);
        const doubled = text[i + 1] === ch || text[i - 1] === ch;
        if (glued || doubled) add(`unclosed ${ch} (${name}) marker shows literally; write x${ch}2${ch} (no spaces inside), or \\${ch} for a literal ${ch}`);
      }
    }
    if (text.includes('`')) add('unpaired ` (code) marker shows literally; close it, or write \\` for a literal backtick');
    if (/<?[-=]{2,}>|<[-=]{2,}/.test(text)) add('long arrow (-->, ==>, <--) shows literally; use ->, =>, <-, <-> or a typed arrow (→)');
  }
  if (/<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i.test(plain)) add('looks like HTML; HTML is shown as plain text, use inline markup instead');
  if (s !== s.trim()) add('has leading or trailing spaces');
  return issues;
}

/**
 * The literal text runs of a token tree, outside code spans (code content is
 * literal by design).
 * @param {import('../js/features/explain/inline.js').Token[]} tokens
 * @param {string[]} [out]
 * @returns {string[]}
 */
function literalTexts(tokens, out = []) {
  for (const tok of tokens) {
    if (tok.t === 'text') out.push(tok.v);
    else if (tok.t !== 'code' && 'c' in tok) literalTexts(tok.c, out);
  }
  return out;
}

/**
 * Word 3-gram set of a normalized stem.
 * @param {string} norm
 * @returns {Set<string>}
 */
function shingles(norm) {
  const words = norm.split(' ').filter(Boolean);
  const out = new Set();
  if (words.length < 3) {
    out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/**
 * Jaccard similarity of two sets (0..1).
 * @param {Set<string>} a
 * @param {Set<string>} b
 */
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------------------
// Field checks
// ---------------------------------------------------------------------------

/**
 * Checks a markup string value (non-empty unless `allowEmpty`).
 * @param {Ctx} ctx
 * @param {unknown} v
 * @param {string} at
 * @param {{ allowEmpty?: boolean }} [opts]
 * @returns {boolean} True when it is a usable string.
 */
function checkText(ctx, v, at, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') {
    ctx.err(at, v === undefined ? 'is required' : `must be a string (got ${typeName(v)})`);
    return false;
  }
  if (v.trim() === '') {
    if (!allowEmpty) ctx.err(at, 'must not be empty');
    return allowEmpty;
  }
  for (const issue of inlineIssues(v)) ctx.warn(at, issue);
  return true;
}

/**
 * Checks an optional markup string field.
 * @param {Ctx} ctx
 * @param {Record<string, any>} obj
 * @param {string} key
 * @param {string} at
 */
function checkOptionalText(ctx, obj, key, at) {
  if (obj[key] !== undefined) checkText(ctx, obj[key], at);
}

/**
 * Warns about fields that are not part of the schema (likely typos).
 * @param {Ctx} ctx
 * @param {Record<string, any>} obj
 * @param {Iterable<string>} allowed
 * @param {string} at
 */
function checkKeys(ctx, obj, allowed, at) {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  for (const k of Object.keys(obj)) {
    if (!set.has(k)) ctx.warn(at ? `${at}.${k}` : k, 'unknown field (typo?); the app ignores it');
  }
}

/**
 * Checks an array of non-empty markup strings.
 * @param {Ctx} ctx
 * @param {unknown} v
 * @param {string} at
 * @param {{ min?: number }} [opts]
 * @returns {boolean}
 */
function checkTextArray(ctx, v, at, { min = 1 } = {}) {
  if (!Array.isArray(v)) {
    ctx.err(at, `must be an array (got ${typeName(v)})`);
    return false;
  }
  if (v.length < min) ctx.err(at, `needs at least ${min} item${min === 1 ? '' : 's'}`);
  v.forEach((item, i) => checkText(ctx, item, `${at}[${i}]`));
  return true;
}

/**
 * Checks an image reference (question image or image block).
 * @param {Ctx} ctx
 * @param {string} root
 * @param {Record<string, any>} img
 * @param {string} at
 */
function checkImage(ctx, root, img, at) {
  const src = img.src;
  if (typeof src !== 'string' || src.trim() === '') {
    ctx.err(`${at}.src`, 'is required (a relative path like "data/img/CH03-0001.webp")');
  } else {
    const unsafe = unsafePathReason(src);
    if (unsafe) ctx.err(`${at}.src`, unsafe);
    else if (!isFile(path.join(root, src))) ctx.err(`${at}.src`, `image not found: ${src}`);
    else if (!src.startsWith('data/')) ctx.warn(`${at}.src`, 'question images should live under data/ (for example data/img/)');
  }
  checkText(ctx, img.alt, `${at}.alt`);
  checkOptionalText(ctx, img, 'caption', `${at}.caption`);
}

// ---------------------------------------------------------------------------
// Explanation blocks (§3.4)
// ---------------------------------------------------------------------------

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @param {any} b
 * @param {string} at e.g. `explanation[2]`
 * @param {Set<string>} seenIds
 */
function checkBlock(ctx, root, b, at, seenIds) {
  if (!isObj(b)) {
    ctx.err(at, `must be an object (got ${typeName(b)})`);
    return;
  }
  // Block id
  if (typeof b.id !== 'string' || b.id === '') {
    ctx.err(`${at}.id`, 'is required (lowercase letters, digits and "-")');
  } else {
    at = `${at}#${b.id}`;
    if (!BLOCK_ID_RE.test(b.id)) ctx.err(at, 'block id may only use lowercase letters, digits and "-"');
    else if (RESERVED_BLOCK_ID_RE.test(b.id)) ctx.err(at, 'block id is reserved for annotations ("stem", "scratch", "choice-*", "note-*"); pick another');
    if (seenIds.has(b.id)) ctx.err(at, 'duplicate block id in this question (ids anchor highlights and ink)');
    seenIds.add(b.id);
  }

  const type = b.type;
  if (typeof type !== 'string' || !Object.hasOwn(BLOCK_FIELDS, type)) {
    ctx.err(`${at}.type`, `unknown block type ${JSON.stringify(type)}; use one of: ${Object.keys(BLOCK_FIELDS).join(', ')}`);
    return;
  }
  checkKeys(ctx, b, ['id', 'type', ...BLOCK_FIELDS[/** @type {keyof typeof BLOCK_FIELDS} */ (type)]], at);

  switch (type) {
    case 'heading':
    case 'p':
      checkText(ctx, b.text, `${at}.text`);
      break;

    case 'list':
      if (b.ordered !== undefined && typeof b.ordered !== 'boolean') ctx.err(`${at}.ordered`, 'must be true or false');
      if (!Array.isArray(b.items) || b.items.length === 0) {
        ctx.err(`${at}.items`, 'must be a non-empty array');
        break;
      }
      b.items.forEach((item, i) => {
        const iat = `${at}.items[${i}]`;
        if (typeof item === 'string') {
          checkText(ctx, item, iat);
        } else if (isObj(item)) {
          checkKeys(ctx, item, ['text', 'items'], iat);
          checkText(ctx, item.text, `${iat}.text`);
          if (item.items !== undefined) {
            if (!Array.isArray(item.items) || item.items.length === 0) {
              ctx.err(`${iat}.items`, 'must be a non-empty array of strings');
            } else {
              item.items.forEach((sub, j) => {
                if (isObj(sub) || Array.isArray(sub)) ctx.err(`${iat}.items[${j}]`, 'lists can be at most 2 levels deep; use a string here');
                else checkText(ctx, sub, `${iat}.items[${j}]`);
              });
            }
          }
        } else {
          ctx.err(iat, `must be a string or {text, items} (got ${typeName(item)})`);
        }
      });
      break;

    case 'table': {
      checkOptionalText(ctx, b, 'caption', `${at}.caption`);
      const headOk = Array.isArray(b.head) && b.head.length > 0;
      if (!headOk) ctx.err(`${at}.head`, 'must be a non-empty array of column titles');
      else b.head.forEach((cell, i) => checkText(ctx, cell, `${at}.head[${i}]`, { allowEmpty: true }));
      const cols = headOk ? b.head.length : 0;
      if (!Array.isArray(b.rows) || b.rows.length === 0) {
        ctx.err(`${at}.rows`, 'must be a non-empty array of rows');
      } else {
        b.rows.forEach((row, r) => {
          const rat = `${at}.rows[${r}]`;
          if (!Array.isArray(row)) {
            ctx.err(rat, `must be an array of cells (got ${typeName(row)})`);
            return;
          }
          if (cols && row.length !== cols) ctx.err(rat, `has ${row.length} cells but the table has ${cols} columns`);
          row.forEach((cell, c) => checkText(ctx, cell, `${rat}[${c}]`, { allowEmpty: true }));
          if (row.every((cell) => typeof cell === 'string' && cell.trim() === '')) ctx.warn(rat, 'row is empty');
        });
      }
      if (b.emphasis !== undefined) {
        const eat = `${at}.emphasis`;
        if (!isObj(b.emphasis)) {
          ctx.err(eat, 'must be an object like {"col": 1} or {"row": 0}');
        } else {
          checkKeys(ctx, b.emphasis, ['col', 'row'], eat);
          if (b.emphasis.col === undefined && b.emphasis.row === undefined) ctx.warn(eat, 'is empty; set "col" and/or "row"');
          const rows = Array.isArray(b.rows) ? b.rows.length : 0;
          for (const [key, limit] of /** @type {const} */ ([['col', cols], ['row', rows]])) {
            const v = b.emphasis[key];
            if (v === undefined) continue;
            if (!Number.isInteger(v) || v < 0) ctx.err(`${eat}.${key}`, 'must be a 0-based integer index');
            else if (limit && v >= limit) ctx.err(`${eat}.${key}`, `index ${v} is out of range (0–${limit - 1})`);
          }
        }
      }
      break;
    }

    case 'flow': {
      checkOptionalText(ctx, b, 'title', `${at}.title`);
      if (!Array.isArray(b.steps) || b.steps.length === 0) {
        ctx.err(`${at}.steps`, 'must be a non-empty array of steps');
        break;
      }
      if (b.steps.length < 2) ctx.warn(`${at}.steps`, 'a flow with one step has no arrows; use a "p" or "callout" block');
      b.steps.forEach((step, i) => {
        const sat = `${at}.steps[${i}]`;
        if (!isObj(step)) {
          ctx.err(sat, `must be {text, label?} or {branches: [...]} (got ${typeName(step)})`);
          return;
        }
        if (step.branches !== undefined) {
          checkKeys(ctx, step, ['branches'], sat);
          if (!Array.isArray(step.branches) || step.branches.length < 2) {
            ctx.err(`${sat}.branches`, 'must be an array of at least 2 branches (a fan-out row)');
            return;
          }
          if (step.branches.length > 4) ctx.warn(`${sat}.branches`, `${step.branches.length} branches will be cramped on phones; keep it to 4 or fewer`);
          step.branches.forEach((br, j) => {
            const bat = `${sat}.branches[${j}]`;
            if (!isObj(br)) {
              ctx.err(bat, `must be {label?, text} (got ${typeName(br)})`);
              return;
            }
            checkKeys(ctx, br, ['label', 'text'], bat);
            checkText(ctx, br.text, `${bat}.text`);
            checkOptionalText(ctx, br, 'label', `${bat}.label`);
          });
        } else {
          checkKeys(ctx, step, ['text', 'label'], sat);
          checkText(ctx, step.text, `${sat}.text`);
          checkOptionalText(ctx, step, 'label', `${sat}.label`);
          if (i === 0 && step.label !== undefined) ctx.warn(`${sat}.label`, 'no arrow leads into the first step, so this label is not shown');
        }
      });
      break;
    }

    case 'mindmap':
      checkText(ctx, b.center, `${at}.center`);
      if (!Array.isArray(b.branches) || b.branches.length < 2 || b.branches.length > 6) {
        ctx.err(`${at}.branches`, `must be an array of 2–6 branches${Array.isArray(b.branches) ? ` (has ${b.branches.length})` : ''}`);
      }
      if (Array.isArray(b.branches)) {
        b.branches.forEach((br, i) => {
          const bat = `${at}.branches[${i}]`;
          if (!isObj(br)) {
            ctx.err(bat, `must be {text, children?} (got ${typeName(br)})`);
            return;
          }
          checkKeys(ctx, br, ['text', 'children'], bat);
          checkText(ctx, br.text, `${bat}.text`);
          if (br.children !== undefined) {
            checkTextArray(ctx, br.children, `${bat}.children`);
            if (Array.isArray(br.children) && br.children.length > 6) ctx.warn(`${bat}.children`, 'more than 6 leaves gets hard to read; split the branch');
          }
        });
      }
      break;

    case 'callout':
      if (!CALLOUT_KINDS.includes(b.kind)) ctx.err(`${at}.kind`, `must be one of: ${CALLOUT_KINDS.join(', ')}`);
      checkOptionalText(ctx, b, 'title', `${at}.title`);
      checkOptionalText(ctx, b, 'text', `${at}.text`);
      if (b.items !== undefined) checkTextArray(ctx, b.items, `${at}.items`);
      if (b.text === undefined && b.items === undefined) ctx.err(at, 'a callout needs "text" or "items"');
      break;

    case 'quote':
      checkText(ctx, b.text, `${at}.text`);
      checkText(ctx, b.ref, `${at}.ref`);
      break;

    case 'image':
      checkImage(ctx, root, b, at);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Questions (§3.3)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} BankState
 * @property {Map<string, string>} ids             Question id → file.
 * @property {Set<string>} retired
 * @property {Map<string, Array<{ file: string, qid: string, choicesKey: string }>>} stems  Normalized stem → questions.
 */

/**
 * Validates one question. Returns facts the summary needs.
 * @param {Reporter} rep
 * @param {string} root
 * @param {Readonly<BankFile>} chapter
 * @param {any} q
 * @param {number} index
 * @param {BankState} bank
 * @returns {{ id: string | null, num: number | null, reviewed: boolean, answerPos: number, normStem: string }}
 */
function checkQuestion(rep, root, chapter, q, index, bank) {
  const file = chapter.file;
  const label = isObj(q) && typeof q.id === 'string' && q.id ? q.id : `questions[${index}]`;
  const ctx = makeCtx(rep, file, label);
  const result = { id: /** @type {string | null} */ (null), num: /** @type {number | null} */ (null), reviewed: false, answerPos: -1, normStem: '' };

  if (!isObj(q)) {
    ctx.err('', `question must be an object (got ${typeName(q)})`);
    return result;
  }
  checkKeys(ctx, q, [...QUESTION_KEYS, 'chapterId'], '');
  if (Object.hasOwn(q, 'chapterId')) ctx.err('chapterId', 'is reserved (the app adds it when loading); remove it from the data');

  // id
  if (typeof q.id !== 'string') {
    ctx.err('id', 'is required');
  } else {
    const m = QID_RE.exec(q.id);
    if (!m) {
      ctx.err('id', `must look like ${chapter.prefix}-0001 (prefix, dash, 4+ digits)`);
    } else if (m[1] !== chapter.prefix) {
      ctx.err('id', `prefix must be ${chapter.prefix} in this chapter`);
    } else {
      result.id = q.id;
      result.num = Number(m[2]);
      if (bank.retired.has(q.id)) ctx.err('id', 'is retired (data/retired.json); IDs are never reused, take the next free ID');
      const other = bank.ids.get(q.id);
      if (other) ctx.err('id', `duplicate question id (also in ${other}); IDs must be unique and permanent`);
      else bank.ids.set(q.id, file);
    }
  }

  // version
  if (!Number.isInteger(q.version) || q.version < 1) ctx.err('version', 'must be an integer ≥ 1 (bump it when the text changes)');

  // topic, tags
  if (checkText(ctx, q.topic, 'topic') && q.topic.length > 60) ctx.warn('topic', 'is long; keep topics short (they are used as group names)');
  if (q.tags !== undefined) {
    if (checkTextArray(ctx, q.tags, 'tags', { min: 0 })) {
      const seen = new Set();
      q.tags.forEach((t, i) => {
        if (typeof t !== 'string') return;
        const key = t.trim().toLowerCase();
        if (seen.has(key)) ctx.warn(`tags[${i}]`, `duplicate tag "${t}"`);
        seen.add(key);
      });
    }
  }

  // difficulty, reviewed, demo
  if (!Number.isInteger(q.difficulty) || q.difficulty < 1 || q.difficulty > 3) ctx.err('difficulty', 'must be 1 (easy), 2 or 3 (hard)');
  if (typeof q.reviewed !== 'boolean') ctx.err('reviewed', 'must be true or false (AI-written questions start as false)');
  else result.reviewed = q.reviewed;
  if (chapter.demo) {
    if (q.demo !== true) ctx.err('demo', 'demo-chapter questions must have "demo": true');
  } else if (q.demo !== undefined) {
    ctx.err('demo', 'only questions in the demo chapter may have "demo"');
  }

  // stem, image
  if (checkText(ctx, q.stem, 'stem')) result.normStem = normalizeText(q.stem);
  if (q.image !== undefined) {
    if (!isObj(q.image)) ctx.err('image', 'must be {src, alt, caption?}');
    else {
      checkKeys(ctx, q.image, ['src', 'alt', 'caption'], 'image');
      checkImage(ctx, root, q.image, 'image');
    }
  }

  // choices
  /** @type {string[]} */
  const choiceIds = [];
  /** @type {string[]} */
  const choiceNorms = [];
  if (!Array.isArray(q.choices)) {
    ctx.err('choices', 'must be an array of 4 or 5 choices');
  } else {
    if (q.choices.length < 4 || q.choices.length > 5) ctx.err('choices', `must have 4 or 5 choices (has ${q.choices.length})`);
    const texts = new Map();
    q.choices.forEach((c, i) => {
      const cat = `choices[${i}]`;
      if (!isObj(c)) {
        ctx.err(cat, `must be {id, text} (got ${typeName(c)})`);
        return;
      }
      checkKeys(ctx, c, ['id', 'text'], cat);
      if (typeof c.id !== 'string' || !CHOICE_IDS.includes(c.id)) ctx.err(`${cat}.id`, 'must be one of "a"–"e" (lowercase)');
      else if (choiceIds.includes(c.id)) ctx.err(`${cat}.id`, `duplicate choice id "${c.id}"`);
      else choiceIds.push(c.id);
      if (checkText(ctx, c.text, `${cat}.text`)) {
        const norm = normalizeText(c.text) || c.text.trim();
        if (texts.has(norm)) ctx.err(`${cat}.text`, `same text as choices[${texts.get(norm)}]`);
        else texts.set(norm, i);
        choiceNorms.push(norm);
      }
    });
    const expected = CHOICE_IDS.slice(0, q.choices.length);
    if (choiceIds.length === q.choices.length && choiceIds.join() !== expected.join()) {
      ctx.warn('choices', `ids should be ${expected.join(', ')} in order (got ${choiceIds.join(', ')})`);
    }
  }

  // answer
  if (typeof q.answer !== 'string' || !choiceIds.includes(q.answer)) {
    ctx.err('answer', `must be one of the choice ids (${choiceIds.join(', ') || 'none'}); got ${JSON.stringify(q.answer)}`);
  } else {
    result.answerPos = q.choices.findIndex((c) => isObj(c) && c.id === q.answer);
  }

  // explanation
  if (!Array.isArray(q.explanation) || q.explanation.length === 0) {
    ctx.err('explanation', 'must be a non-empty array of blocks');
  } else {
    const seen = new Set();
    q.explanation.forEach((b, i) => checkBlock(ctx, root, b, `explanation[${i}]`, seen));
  }

  // choiceNotes
  if (q.choiceNotes !== undefined) {
    if (!isObj(q.choiceNotes)) {
      ctx.err('choiceNotes', 'must be an object like {"a": "Why A is wrong…"}');
    } else {
      for (const [k, v] of Object.entries(q.choiceNotes)) {
        if (!choiceIds.includes(k)) ctx.err(`choiceNotes.${k}`, `"${k}" is not a choice id of this question`);
        checkText(ctx, v, `choiceNotes.${k}`);
      }
    }
  }

  // source
  if (q.source === undefined) {
    if (!chapter.demo) ctx.err('source', 'is required: at least one {ref, loc} from the owner\'s sources');
  } else if (!Array.isArray(q.source) || q.source.length === 0) {
    ctx.err('source', 'must be a non-empty array of {ref, loc}');
  } else {
    q.source.forEach((s, i) => {
      const sat = `source[${i}]`;
      if (!isObj(s)) {
        ctx.err(sat, `must be {ref, loc} (got ${typeName(s)})`);
        return;
      }
      checkKeys(ctx, s, ['ref', 'loc'], sat);
      if (typeof s.ref !== 'string' || s.ref.trim() === '') ctx.err(`${sat}.ref`, 'is required (the source name)');
      if (s.loc !== undefined && (typeof s.loc !== 'string' || s.loc.trim() === '')) ctx.err(`${sat}.loc`, 'must be a non-empty string (chapter, section or page)');
      else if (s.loc === undefined && !chapter.demo) ctx.warn(`${sat}.loc`, 'add the section or page, so reviewers can check the fact');
    });
  }

  // duplicate stems (checked after all chapters)
  if (result.normStem) {
    const list = bank.stems.get(result.normStem) ?? [];
    list.push({ file, qid: label, choicesKey: [...choiceNorms].sort().join('\u0000') });
    bank.stems.set(result.normStem, list);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Reports a field that must equal a value from a fixed table.
 * @param {Ctx} ctx
 * @param {Record<string, any>} obj
 * @param {string} key
 * @param {string | number} expected
 * @param {string} table Name of the table, for the message.
 */
function checkFixed(ctx, obj, key, expected, table) {
  const got = obj[key];
  if (got === expected) return;
  const want = `must be ${JSON.stringify(expected)} (${table}, docs/ARCHITECTURE.md §3.1)`;
  ctx.err(key, got === undefined ? `is required; ${want}` : `${want}, got ${JSON.stringify(got)}`);
}

/**
 * Checks the `short` label of a chapter or demo entry.
 * @param {Ctx} ctx
 * @param {Record<string, any>} entry
 */
function checkShort(ctx, entry) {
  const short = entry.short;
  if (typeof short !== 'string' || short.trim() === '') {
    ctx.err('short', 'is required (a short label for chips and tight spaces)');
    return;
  }
  const length = [...short].length;
  if (length > SHORT_MAX) ctx.warn('short', `is ${length} characters; keep it to ${SHORT_MAX} or fewer so it fits on chips`);
  if (short !== short.trim()) ctx.warn('short', 'has leading or trailing spaces');
}

/**
 * Checks the `count` of a chapter or demo entry against its file.
 * @param {Ctx} ctx
 * @param {Record<string, any>} entry
 * @param {string} file The question file.
 * @param {number | undefined} found Questions in the file (undefined when it could not be read).
 */
function checkCount(ctx, entry, file, found) {
  const count = entry.count;
  if (!Number.isInteger(count) || count < 0) {
    ctx.err('count', count === undefined
      ? `is required (the number of questions in ${file})`
      : `must be a whole number ≥ 0 (got ${typeName(count)})`);
  } else if (found !== undefined && found !== count) {
    ctx.err('count', `is ${count} but ${file} has ${found} question${found === 1 ? '' : 's'}; set it to ${found}`);
  }
}

/**
 * Checks index.json `parts` against the fixed parts table.
 * @param {Reporter} rep
 * @param {unknown} parts
 */
function checkParts(rep, parts) {
  const f = INDEX_FILE;
  if (!Array.isArray(parts)) {
    rep.error(f, 'parts', parts === undefined
      ? `is required (the ${PARTS.length} parts of the book)`
      : `must be an array (got ${typeName(parts)})`);
    return;
  }
  /** @type {Map<string, number>} Part id → first position. */
  const byId = new Map();
  parts.forEach((p, i) => {
    const at = `parts[${i}]`;
    if (!isObj(p) || typeof p.id !== 'string') {
      rep.error(f, at, 'must be an object with an "id"');
    } else if (byId.has(p.id)) {
      rep.error(f, at, `duplicate part id "${p.id}"`);
    } else {
      byId.set(p.id, i);
    }
  });

  for (const t of PARTS) {
    const i = byId.get(t.id);
    if (i === undefined) {
      rep.error(f, 'parts', `missing part "${t.id}" (${t.number}. ${t.title})`);
      continue;
    }
    const ctx = makeCtx(rep, f, `parts[${i}] (${t.id})`);
    checkKeys(ctx, parts[i], PART_KEYS, '');
    for (const key of /** @type {const} */ (['number', 'volume', 'title'])) checkFixed(ctx, parts[i], key, t[key], 'fixed parts table');
  }
  for (const [id, i] of byId) {
    if (!PARTS.some((t) => t.id === id)) rep.error(f, `parts[${i}]`, `unknown part "${id}" (the parts are ${PARTS.map((t) => t.id).join(', ')})`);
  }

  const order = [...byId.keys()].filter((id) => PARTS.some((t) => t.id === id));
  const expected = PARTS.map((t) => t.id).filter((id) => byId.has(id));
  if (order.join() !== expected.join()) {
    rep.error(f, 'parts', `must be in book order (${PARTS.map((t) => t.id).join(', ')}); got ${order.join(', ')}`);
  }
}

/**
 * Checks index.json `chapters` against the fixed chapter table.
 * @param {Reporter} rep
 * @param {unknown} chapters
 * @param {Map<string, number>} counts Chapter id → questions found in its file.
 * @returns {Map<string, boolean>} Chapter id → `published` (valid flags only).
 */
function checkChapters(rep, chapters, counts) {
  const f = INDEX_FILE;
  /** @type {Map<string, boolean>} */
  const published = new Map();
  if (!Array.isArray(chapters)) {
    rep.error(f, 'chapters', chapters === undefined
      ? `is required (the ${CHAPTER_TABLE.length} chapters of the book)`
      : `must be an array (got ${typeName(chapters)})`);
    return published;
  }

  /** @type {Map<string, { c: Record<string, any>, at: string }>} */
  const byId = new Map();
  chapters.forEach((c, i) => {
    const at = `chapters[${i}]`;
    if (!isObj(c) || typeof c.id !== 'string') {
      rep.error(f, at, 'must be an object with an "id"');
    } else if (byId.has(c.id)) {
      rep.error(f, at, `duplicate chapter id "${c.id}"`);
    } else {
      byId.set(c.id, { c, at });
    }
  });

  let lastNumber = -Infinity;
  for (const c of chapters) {
    if (!isObj(c) || !Number.isFinite(c.number)) continue;
    if (c.number < lastNumber) {
      rep.warn(f, 'chapters', 'are not sorted by "number" (the app sorts them, but keep the file in book order)');
      break;
    }
    lastNumber = c.number;
  }

  for (const t of CHAPTER_TABLE) {
    const found = byId.get(t.id);
    if (!found) {
      rep.error(f, 'chapters', `missing chapter "${t.id}" (${t.number}. ${t.title}); all ${CHAPTER_TABLE.length} chapters stay listed, unpublished ones with "published": false`);
      continue;
    }
    const { c, at } = found;
    const ctx = makeCtx(rep, f, `${at} (${t.id})`);
    checkKeys(ctx, c, CHAPTER_KEYS, '');
    for (const key of CHAPTER_FIXED) checkFixed(ctx, c, key, t[/** @type {keyof ChapterRow} */ (key)], 'fixed chapter table');
    checkShort(ctx, c);
    checkCount(ctx, c, t.file, counts.get(t.id));

    if (typeof c.published !== 'boolean') {
      ctx.err('published', c.published === undefined
        ? 'is required: false (hidden in the app) or true (approved by the owner)'
        : `must be true or false (got ${typeName(c.published)})`);
      continue;
    }
    published.set(t.id, c.published);
    const questions = counts.get(t.id) ?? (Number.isInteger(c.count) ? c.count : undefined);
    if (c.published && questions === 0) {
      ctx.err('published', `is true but ${t.file} has no questions; an empty chapter can't be published (set "published": false)`);
    }
  }

  for (const [id, { at }] of byId) {
    if (CHAPTER_TABLE.some((t) => t.id === id)) continue;
    rep.error(f, at, id === DEMO.id
      ? 'the demo chapter belongs in "demo", not in "chapters"'
      : `unknown chapter "${id}" (not in the fixed chapter table ch01–ch${String(CHAPTER_TABLE.length).padStart(2, '0')})`);
  }
  return published;
}

/**
 * Checks the index.json `demo` entry against DEMO.
 * @param {Reporter} rep
 * @param {unknown} demo
 * @param {Map<string, number>} counts Chapter id → questions found in its file.
 */
function checkDemoEntry(rep, demo, counts) {
  const f = INDEX_FILE;
  if (demo === undefined) {
    rep.error(f, 'demo', `is required: {"id": "${DEMO.id}", "prefix": "${DEMO.prefix}", "title": "${DEMO.title}", "short": "Demo", "file": "${DEMO.file}", "count": N} (the app shows it while no chapter is published)`);
    return;
  }
  if (!isObj(demo)) {
    rep.error(f, 'demo', `must be an object {${DEMO_KEYS.join(', ')}} (got ${typeName(demo)})`);
    return;
  }
  const ctx = makeCtx(rep, f, 'demo');
  checkKeys(ctx, demo, DEMO_KEYS, '');
  for (const key of /** @type {const} */ (['id', 'prefix', 'title', 'file'])) checkFixed(ctx, demo, key, DEMO[key], 'fixed demo entry');
  checkShort(ctx, demo);
  checkCount(ctx, demo, DEMO.file, counts.get(DEMO.id));
}

/**
 * Checks data/index.json: parts, chapters and demo (§3.1).
 * @param {Reporter} rep
 * @param {any} index Parsed index (undefined when unreadable; already reported).
 * @param {Map<string, number>} counts Chapter id → questions found in its file.
 * @returns {Map<string, boolean>} Chapter id → `published` (valid flags only).
 */
function checkIndex(rep, index, counts) {
  const f = INDEX_FILE;
  if (index === undefined) return new Map();
  if (!isObj(index)) {
    rep.error(f, '', `top level must be an object {${INDEX_KEYS.join(', ')}}`);
    return new Map();
  }
  checkKeys(makeCtx(rep, f, ''), index, INDEX_KEYS, '');
  if (index.schemaVersion !== SCHEMA_VERSION) rep.error(f, 'schemaVersion', `must be ${SCHEMA_VERSION}`);
  checkParts(rep, index.parts);
  const published = checkChapters(rep, index.chapters, counts);
  checkDemoEntry(rep, index.demo, counts);
  return published;
}

/**
 * Reads data/retired.json.
 * @param {Reporter} rep
 * @param {string} root
 * @returns {Set<string>}
 */
function loadRetired(rep, root) {
  const f = RETIRED_FILE;
  const data = readJson(rep, root, f);
  const out = new Set();
  if (data === undefined) return out;
  if (!isObj(data) || !Array.isArray(data.retired)) {
    rep.error(f, '', 'must be {"retired": ["CH03-0007", ...]}');
    return out;
  }
  checkKeys(makeCtx(rep, f, ''), data, ['retired'], '');
  const prefixes = new Set(BANK_FILES.map((t) => t.prefix));
  data.retired.forEach((id, i) => {
    const at = `retired[${i}]`;
    const m = typeof id === 'string' ? QID_RE.exec(id) : null;
    if (!m) {
      rep.error(f, at, `invalid question id ${JSON.stringify(id)}`);
      return;
    }
    if (!prefixes.has(m[1])) rep.warn(f, at, `prefix ${m[1]} belongs to no chapter (use CH01–CH${String(CHAPTER_TABLE.length).padStart(2, '0')} or ${DEMO.prefix})`);
    if (out.has(id)) rep.warn(f, at, `${id} is listed twice`);
    out.add(id);
  });
  return out;
}

/**
 * Parses a `const NAME = [ 'a', "b", ... ]` (optionally wrapped in
 * Object.freeze) string-literal array from JavaScript source.
 * @param {string} src
 * @param {string} name
 * @returns {{ entries: string[] } | { error: string }}
 */
export function parseStringArray(src, name) {
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:Object\\.freeze\\(\\s*)?\\[`).exec(src);
  if (!decl) return { error: `no "const ${name} = [ ... ]" found` };
  /** @type {string[]} */
  const entries = [];
  let i = decl.index + decl[0].length;
  while (i < src.length) {
    const c = src[i];
    if (c === ',' || /\s/.test(c)) {
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return { error: 'unterminated comment' };
      i = end + 2;
    } else if (c === ']') {
      return { entries };
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          s += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') return { error: 'template expressions (${…}) are not supported; list plain strings' };
        if (c !== '`' && src[j] === '\n') return { error: 'unterminated string' };
        s += src[j];
        j++;
      }
      if (j >= src.length) return { error: 'unterminated string' };
      entries.push(s);
      i = j + 1;
    } else {
      return { error: `unexpected ${JSON.stringify(src.slice(i, i + 24))}; ${name} must be a plain list of string literals` };
    }
  }
  return { error: 'missing closing "]"' };
}

/**
 * Reads a `const NAME = '...'` style string constant.
 * @param {string} src
 * @param {RegExp} re Group 2 is the value.
 */
function readConst(src, re) {
  const m = re.exec(src);
  return m ? m[2] : null;
}

/**
 * Checks sw.js against js/version.js and the files on disk.
 * @param {Reporter} rep
 * @param {string} root
 * @returns {{ version: string | null, shellCount: number }}
 */
function checkAppShell(rep, root) {
  const out = { version: /** @type {string | null} */ (null), shellCount: 0 };
  const swPath = path.join(root, 'sw.js');
  const verPath = path.join(root, 'js/version.js');

  /** @param {string} p @param {string} rel */
  const read = (p, rel) => {
    if (!isFile(p)) {
      rep.error(rel, '', 'file not found');
      return null;
    }
    try {
      return readFileSync(p, 'utf8');
    } catch (err) {
      rep.error(rel, '', `cannot read file: ${err.message}`);
      return null;
    }
  };
  const sw = read(swPath, 'sw.js');
  const ver = read(verPath, 'js/version.js');

  // Versions
  const swVersion = sw === null ? null : readConst(sw, /^\s*const\s+VERSION\s*=\s*(['"`])([^'"`\n]*)\1/m);
  const appVersion = ver === null ? null : readConst(ver, /^\s*export\s+const\s+APP_VERSION\s*=\s*(['"`])([^'"`\n]*)\1/m);
  if (sw !== null && swVersion === null) rep.error('sw.js', 'VERSION', "no `const VERSION = 'YYYY.MM.DD-N';` found");
  if (ver !== null && appVersion === null) rep.error('js/version.js', 'APP_VERSION', "no `export const APP_VERSION = 'YYYY.MM.DD-N';` found");
  if (swVersion !== null && !VERSION_RE.test(swVersion)) rep.error('sw.js', 'VERSION', `"${swVersion}" must look like YYYY.MM.DD-N`);
  if (appVersion !== null && !VERSION_RE.test(appVersion)) rep.error('js/version.js', 'APP_VERSION', `"${appVersion}" must look like YYYY.MM.DD-N`);
  if (swVersion !== null && appVersion !== null && swVersion !== appVersion) {
    rep.error('sw.js', 'VERSION', `"${swVersion}" differs from js/version.js APP_VERSION "${appVersion}"; run node scripts/bump-version.mjs`);
  }
  out.version = swVersion;

  // Precache list
  if (sw === null) return out;
  const parsed = parseStringArray(sw, 'APP_SHELL');
  if ('error' in parsed) {
    rep.error('sw.js', 'APP_SHELL', parsed.error);
    return out;
  }
  out.shellCount = parsed.entries.length;
  const listed = new Set();
  let hasRoot = false;
  parsed.entries.forEach((raw, i) => {
    const at = `APP_SHELL[${i}]`;
    const entry = raw.trim();
    if (entry === './' || entry === '.' || entry === '') {
      hasRoot = true;
      return;
    }
    const unsafe = unsafePathReason(entry);
    if (unsafe) {
      rep.error('sw.js', at, `"${raw}" ${unsafe}`);
      return;
    }
    const rel = entry.replace(/^\.\//, '').replace(/[?#].*$/, '');
    if (rel === 'data' || rel.startsWith('data/')) {
      rep.error('sw.js', at, `"${raw}" is question data; remove it from APP_SHELL (the install fetches data from data/index.json: published chapters and the demo only)`);
      return;
    }
    if (listed.has(rel)) rep.warn('sw.js', at, `"${raw}" is listed twice`);
    listed.add(rel);
    if (!isFile(path.join(root, rel))) rep.error('sw.js', at, `"${raw}" does not exist on disk (the service worker install would fail)`);
  });
  if (!hasRoot) rep.warn('sw.js', 'APP_SHELL', 'should include "./" (the start page)');

  const required = ['index.html', 'manifest.webmanifest', ...['js', 'css', 'icons'].flatMap((d) => walkFiles(root, d))];
  for (const rel of required) {
    if (!isFile(path.join(root, rel))) {
      rep.error(rel, '', 'file not found (the app needs it)');
    } else if (!listed.has(rel)) {
      rep.error('sw.js', 'APP_SHELL', `"${rel}" is missing; without it the app breaks offline`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ChapterSummary
 * @property {string} id
 * @property {number | null} number  Chapter number (null for the demo).
 * @property {string} title
 * @property {string} prefix
 * @property {boolean} demo
 * @property {boolean} published  From index.json (false when missing or invalid; false for the demo).
 * @property {boolean} loaded     The file was read and has a `questions` array.
 * @property {number} total
 * @property {number} reviewed
 * @property {string} nextId     Next free question id ('' when the file could not be read, so it is unknown).
 * @property {number[]} positions  Answer count per position a–e.
 */

/**
 * Runs every check.
 * @param {{ root?: string, dataOnly?: boolean }} [options]
 * @returns {{ reporter: Reporter, chapters: ChapterSummary[], app: { version: string | null, shellCount: number } | null }}
 */
export function validate({ root = ROOT, dataOnly = false } = {}) {
  const rep = new Reporter();
  /** @type {BankState} */
  const bank = { ids: new Map(), retired: loadRetired(rep, root), stems: new Map() };
  const index = readJson(rep, root, INDEX_FILE);

  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {ChapterSummary[]} */
  const chapters = [];
  /** @type {Map<string, Array<{ qid: string, set: Set<string>, norm: string }>>} */
  const forSimilarity = new Map();

  for (const t of BANK_FILES) {
    /** @type {ChapterSummary} */
    const summary = {
      id: t.id, number: t.number, title: t.title, prefix: t.prefix, demo: t.demo, published: false, loaded: false,
      total: 0, reviewed: 0, nextId: '', positions: [0, 0, 0, 0, 0],
    };
    chapters.push(summary);
    const data = readJson(rep, root, t.file);
    if (data === undefined) continue;
    const f = t.file;
    if (!isObj(data)) {
      rep.error(f, '', 'top level must be an object {schemaVersion, chapter, questions}');
      continue;
    }
    checkKeys(makeCtx(rep, f, ''), data, ['schemaVersion', 'chapter', 'questions'], '');
    if (data.schemaVersion !== SCHEMA_VERSION) rep.error(f, 'schemaVersion', `must be ${SCHEMA_VERSION}`);
    if (data.chapter !== t.id) rep.error(f, 'chapter', `must be "${t.id}" (got ${JSON.stringify(data.chapter)})`);
    if (!Array.isArray(data.questions)) {
      rep.error(f, 'questions', 'must be an array');
      continue;
    }
    counts.set(t.id, data.questions.length);
    summary.loaded = true;
    summary.total = data.questions.length;
    if (t.demo && data.questions.length === 0) {
      rep.error(f, 'questions', 'the demo needs at least one question: it is the whole study bank while no chapter is published, and Settings > Help > "Try the demo" opens it');
    }

    let maxNum = 0;
    const sims = [];
    data.questions.forEach((q, i) => {
      const r = checkQuestion(rep, root, t, q, i, bank);
      if (r.reviewed) summary.reviewed++;
      if (r.num !== null) maxNum = Math.max(maxNum, r.num);
      if (r.answerPos >= 0) summary.positions[r.answerPos]++;
      if (r.id && r.normStem && r.normStem.split(' ').length >= SIMILARITY_MIN_WORDS) {
        sims.push({ qid: r.id, set: shingles(r.normStem), norm: r.normStem });
      }
    });
    forSimilarity.set(t.id, sims);

    for (const id of bank.retired) {
      const m = QID_RE.exec(id);
      if (m && m[1] === t.prefix) maxNum = Math.max(maxNum, Number(m[2]));
    }
    summary.nextId = `${t.prefix}-${String(maxNum + 1).padStart(4, '0')}`;

    // Answer-position balance
    const answered = summary.positions.reduce((a, b) => a + b, 0);
    if (answered >= BALANCE_MIN_QUESTIONS) {
      const max = Math.max(...summary.positions);
      const pos = summary.positions.indexOf(max);
      if (max / answered > BALANCE_MAX_SHARE) {
        const pct = Math.round((max / answered) * 100);
        rep.warn(f, 'answers', `position ${'ABCDE'[pos]} is correct in ${pct}% of ${answered} questions; keep every position under ${BALANCE_MAX_SHARE * 100}%`);
      }
    }
  }

  // Duplicates across the whole bank
  for (const list of bank.stems.values()) {
    if (list.length < 2) continue;
    const first = list[0];
    for (const other of list.slice(1)) {
      if (other.choicesKey === first.choicesKey) {
        rep.error(other.file, other.qid, `duplicate of ${first.qid} (same stem and same choices); retire one of them`);
      } else {
        rep.warn(other.file, other.qid, `same stem as ${first.qid}; make sure they really test different things`);
      }
    }
  }
  // Near-duplicates within each chapter
  for (const [id, sims] of forSimilarity) {
    const file = BANK_FILES.find((t) => t.id === id)?.file ?? '';
    for (let i = 0; i < sims.length; i++) {
      for (let j = i + 1; j < sims.length; j++) {
        const a = sims[i];
        const b = sims[j];
        if (a.norm === b.norm) continue; // reported above
        const lo = Math.min(a.set.size, b.set.size);
        const hi = Math.max(a.set.size, b.set.size);
        if (lo / hi < SIMILARITY_THRESHOLD) continue; // Jaccard can't reach the threshold
        const sim = jaccard(a.set, b.set);
        if (sim >= SIMILARITY_THRESHOLD) {
          rep.warn(file, b.qid, `stem is ${Math.round(sim * 100)}% similar to ${a.qid}; check it is not a near-duplicate`);
        }
      }
    }
  }

  const published = checkIndex(rep, index, counts);
  for (const summary of chapters) summary.published = published.get(summary.id) === true;

  // JSON files in data/ that the app never loads
  const known = new Set([INDEX_FILE, RETIRED_FILE, ...BANK_FILES.map((t) => t.file)]);
  for (const rel of walkFiles(root, 'data')) {
    if (rel.endsWith('.json') && !rel.includes('/', 'data/'.length) && !known.has(rel)) {
      rep.warn(rel, '', 'not listed in data/index.json, so the app never loads it');
    }
  }

  const app = dataOnly ? null : checkAppShell(rep, root);
  return { reporter: rep, chapters, app };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node scripts/validate.mjs [--data-only] [--strict] [--quiet] [--root DIR]

  --data-only   Check data/ only (skip sw.js, js/version.js and the precache list)
  --strict      Treat warnings as errors
  --quiet       Print only problems and the result line
  --root DIR    Validate another checkout (default: this repository)
  -h, --help    Show this help`;

/**
 * @param {string[]} argv
 * @returns {{ dataOnly: boolean, strict: boolean, quiet: boolean, help: boolean, root: string }}
 */
export function parseArgs(argv) {
  const out = { dataOnly: false, strict: false, quiet: false, help: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data-only') out.dataOnly = true;
    else if (arg === '--strict') out.strict = true;
    else if (arg === '--quiet' || arg === '-q') out.quiet = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--root' || arg.startsWith('--root=')) {
      const value = arg === '--root' ? argv[++i] : arg.slice('--root='.length);
      if (!value) throw new Error('--root needs a directory');
      out.root = path.resolve(value);
    } else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

/** Longest chapter title shown in the summary table (longer ones are cut with "…"). */
const SUMMARY_TITLE_MAX = 44;

/**
 * @param {number} n
 * @param {string} word
 */
function countOf(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Compact question-bank summary. Lists the published chapters, every chapter
 * that has questions (or an unreadable file) and the demo; the many empty,
 * unpublished chapters are folded into one line so the output stays short.
 * @param {ChapterSummary[]} chapters From validate().
 * @param {{ bold?: (s: string) => string, dim?: (s: string) => string }} [style]
 * @returns {string[]} Lines to print.
 */
export function summaryLines(chapters, { bold = (s) => s, dim = (s) => s } = {}) {
  const book = chapters.filter((c) => !c.demo);
  const shown = [...book.filter((c) => c.published || c.total > 0 || !c.loaded), ...chapters.filter((c) => c.demo)];
  const folded = book.filter((c) => !c.published && c.total === 0 && c.loaded).length;
  const publishedCount = book.filter((c) => c.published).length;

  const status = (/** @type {ChapterSummary} */ c) => {
    if (!c.loaded) return 'unreadable';
    if (c.demo) return 'demo';
    return c.published ? 'published' : 'hidden';
  };
  const fit = (/** @type {string} */ s) => (s.length > SUMMARY_TITLE_MAX ? `${s.slice(0, SUMMARY_TITLE_MAX - 1).trimEnd()}…` : s);
  const titleW = Math.max(7, ...shown.map((c) => fit(c.title).length));

  const lines = [bold(`Question bank: ${publishedCount} of ${book.length} chapters published${publishedCount === 0 ? ' (the app runs in demo mode)' : ''}`)];
  if (shown.length) {
    lines.push(dim(`  ${'#'.padStart(4)}  ${'Chapter'.padEnd(titleW)}  ${'Status'.padEnd(10)}  ${'Questions'.padStart(9)}  ${'Reviewed'.padStart(8)}  ${'Answers A/B/C/D/E'.padEnd(17)}  Next free ID`));
  }
  for (const c of shown) {
    const answers = c.total > 0 ? c.positions.join('/') : '–';
    lines.push(`  ${String(c.number ?? c.id).padStart(4)}  ${fit(c.title).padEnd(titleW)}  ${status(c).padEnd(10)}  ${String(c.total).padStart(9)}  ${String(c.reviewed).padStart(8)}  ${answers.padEnd(17)}  ${c.nextId || '?'}`);
  }
  if (folded > 0) lines.push(dim(`  ${countOf(folded, 'unpublished empty chapter')} (hidden in the app)`));

  const sum = (/** @type {ChapterSummary[]} */ list, /** @type {'total' | 'reviewed'} */ key) => list.reduce((n, c) => n + c[key], 0);
  const live = book.filter((c) => c.published);
  const hidden = book.filter((c) => !c.published);
  const liveTotal = sum(live, 'total');
  const liveReviewed = sum(live, 'reviewed');
  const hiddenTotal = sum(hidden, 'total');
  const demoTotal = sum(chapters.filter((c) => c.demo), 'total');
  lines.push(`  Total: ${bold(countOf(liveTotal, 'question'))} in published chapters (${liveReviewed} reviewed, ${liveTotal - liveReviewed} not yet reviewed); `
    + `${hiddenTotal} in hidden chapters (${sum(hidden, 'reviewed')} reviewed); ${demoTotal} demo.`);
  return lines;
}

/**
 * Runs the validator and prints a report.
 * @param {string[]} argv Arguments after the script name.
 * @param {{ log?: (s: string) => void, color?: boolean }} [io]
 * @returns {number} Exit code.
 */
export function main(argv, { log = console.log, color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    log(`validate: ${err.message}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }
  if (!isDir(args.root)) {
    log(`validate: ${args.root} is not a directory`);
    return 1;
  }

  const paint = (/** @type {string} */ code, /** @type {string} */ s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red = (/** @type {string} */ s) => paint('31', s);
  const yellow = (/** @type {string} */ s) => paint('33', s);
  const green = (/** @type {string} */ s) => paint('32', s);
  const dim = (/** @type {string} */ s) => paint('2', s);
  const bold = (/** @type {string} */ s) => paint('1', s);

  const { reporter, chapters, app } = validate({ root: args.root, dataOnly: args.dataOnly });

  for (const p of reporter.problems) {
    const tag = p.level === 'error' ? red('ERROR') : yellow('WARN ');
    log(`${tag} ${p.file}${p.where ? `  ${bold(p.where)}` : ''}: ${p.message}`);
  }
  if (reporter.problems.length && !args.quiet) log('');

  if (!args.quiet) {
    for (const line of summaryLines(chapters, { bold, dim })) log(line);
    if (app) log(`${bold('App shell')}: ${app.shellCount} precached entries, version ${app.version ?? '(unknown)'}`);
    else log(dim('App shell: skipped (--data-only)'));
  }

  const errors = reporter.errorCount;
  const warnings = reporter.warningCount;
  const failed = errors > 0 || (args.strict && warnings > 0);
  const counts = `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`;
  log(failed ? red(`✖ Validation failed: ${counts}.`) : green(`✔ Validation passed: ${counts}.`));
  return failed ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`validate: unexpected failure: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  }
}
