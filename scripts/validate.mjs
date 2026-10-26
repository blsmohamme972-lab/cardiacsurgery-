#!/usr/bin/env node
/**
 * Validates the question bank, the service-worker precache list and the
 * version stamps before a release (docs/ARCHITECTURE.md §3, §5.8, §5.9).
 *
 * Data checks
 * - `data/index.json`: schema, the fixed chapter table (ids, prefixes, files,
 *   order, titles, demo flag), files exist, `count` equals the file contents.
 * - `data/retired.json`: shape, id format, no duplicates.
 * - Every chapter file: `schemaVersion`, chapter id, `questions` array.
 * - Every question: id format `PREFIX-NNNN` with the chapter's prefix,
 *   globally unique, not retired; version, topic, tags, difficulty, reviewed,
 *   stem, image, 4–5 choices (ids a–e), answer, choice notes, source, demo
 *   flag; every explanation block (§3.4) with unique, non-reserved ids;
 *   inline mini-markup balance (§3.5, warnings).
 * - Duplicate questions (error), identical or near-identical stems
 *   (warnings), answer-position balance per chapter (warning when a chapter
 *   has ≥ 20 questions and one position holds > 40% of the answers).
 *
 * App checks (skipped with --data-only)
 * - `sw.js` VERSION equals `js/version.js` APP_VERSION (format YYYY.MM.DD-N).
 * - Every file under js/, css/, icons/ plus index.html and
 *   manifest.webmanifest is in sw.js APP_SHELL, and every APP_SHELL entry
 *   exists on disk.
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

/** Repository root (this file lives in scripts/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Data schema version this app understands. */
export const SCHEMA_VERSION = 1;

/**
 * The fixed chapter table (§3.1). index.json must match it exactly.
 * @type {ReadonlyArray<Readonly<{ order: number, id: string, prefix: string, file: string, title: string, demo?: true }>>}
 */
export const CHAPTER_TABLE = Object.freeze([
  { order: 1, id: 'cpb', prefix: 'CPB', file: 'data/ch01-cpb.json', title: 'CPB & myocardial protection' },
  { order: 2, id: 'cabg', prefix: 'CABG', file: 'data/ch02-cabg.json', title: 'CABG' },
  { order: 3, id: 'valves', prefix: 'VALV', file: 'data/ch03-valves.json', title: 'Valves' },
  { order: 4, id: 'aorta', prefix: 'AORT', file: 'data/ch04-aorta.json', title: 'Aorta' },
  { order: 5, id: 'congenital', prefix: 'CONG', file: 'data/ch05-congenital.json', title: 'Congenital' },
  { order: 6, id: 'hf', prefix: 'HFTX', file: 'data/ch06-hf-vad-tx.json', title: 'HF/VAD/transplant' },
  { order: 7, id: 'arrhythmia', prefix: 'ARRH', file: 'data/ch07-arrhythmia.json', title: 'Arrhythmia surgery' },
  { order: 8, id: 'pericardium', prefix: 'PERI', file: 'data/ch08-pericardium-tumors.json', title: 'Pericardium & tumors' },
  { order: 9, id: 'thoracic', prefix: 'THOR', file: 'data/ch09-thoracic.json', title: 'Thoracic basics' },
  { order: 10, id: 'icu', prefix: 'ICU', file: 'data/ch10-postop-icu.json', title: 'Postop ICU' },
  { order: 11, id: 'anatomy', prefix: 'ANAT', file: 'data/ch11-anatomy-physiology.json', title: 'Anatomy & physiology' },
  { order: 12, id: 'pharm', prefix: 'PHAR', file: 'data/ch12-pharmacology.json', title: 'Pharmacology' },
  { order: 13, id: 'trauma', prefix: 'TRAU', file: 'data/ch13-trauma.json', title: 'Trauma' },
  { order: 99, id: 'demo', prefix: 'DEMO', file: 'data/demo.json', title: 'App tour (demo)', demo: true },
].map((c) => Object.freeze(c)));

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

/**
 * Inline mini-markup problems (§3.5) in one string. Escaped characters and
 * code spans are ignored; arrows are not markers.
 * @param {string} s
 * @returns {string[]}
 */
export function inlineIssues(s) {
  /** @type {string[]} */
  const issues = [];
  let t = s.replace(/\\[\s\S]/g, '  ');
  if ((t.match(/`/g) || []).length % 2) issues.push('unbalanced ` (code) marker; write \\` for a literal backtick');
  t = t.replace(/`[^`]*`/g, ' ').replace(/<->|<-|->|=>/g, '  ');
  /** @type {Array<[RegExp, string, string]>} */
  const markers = [
    [/\*\*/g, '**', 'bold'],
    [/==/g, '==', 'mark'],
    [/\^/g, '^', 'superscript'],
    [/~/g, '~', 'subscript'],
  ];
  for (const [re, marker, name] of markers) {
    if ((t.match(re) || []).length % 2) {
      issues.push(`unbalanced ${marker} (${name}) marker; it will show literally (write \\${marker[0]} for a literal character)`);
    }
  }
  if (/<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i.test(t)) issues.push('looks like HTML; HTML is shown as plain text, use inline markup instead');
  if (s !== s.trim()) issues.push('has leading or trailing spaces');
  return issues;
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
    ctx.err(`${at}.src`, 'is required (a relative path like "data/img/CPB-0001.webp")');
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
 * @param {typeof CHAPTER_TABLE[number]} chapter
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
 * Checks data/index.json against the fixed chapter table.
 * @param {Reporter} rep
 * @param {any} index Parsed index (may be undefined).
 * @param {Map<string, number>} counts Chapter id → question count found in its file.
 */
function checkIndex(rep, index, counts) {
  const f = INDEX_FILE;
  if (index === undefined) return;
  if (!isObj(index)) {
    rep.error(f, '', 'top level must be an object {schemaVersion, chapters}');
    return;
  }
  const ctx = makeCtx(rep, f, '');
  checkKeys(ctx, index, ['schemaVersion', 'chapters'], '');
  if (index.schemaVersion !== SCHEMA_VERSION) rep.error(f, 'schemaVersion', `must be ${SCHEMA_VERSION}`);
  if (!Array.isArray(index.chapters)) {
    rep.error(f, 'chapters', 'must be an array');
    return;
  }

  const byId = new Map();
  index.chapters.forEach((c, i) => {
    const at = `chapters[${i}]`;
    if (!isObj(c) || typeof c.id !== 'string') {
      rep.error(f, at, 'must be an object with an "id"');
      return;
    }
    if (byId.has(c.id)) rep.error(f, at, `duplicate chapter id "${c.id}"`);
    byId.set(c.id, { c, at });
  });

  let lastOrder = -Infinity;
  for (const c of index.chapters) {
    if (isObj(c) && Number.isFinite(c.order)) {
      if (c.order < lastOrder) {
        rep.warn(f, 'chapters', 'are not sorted by "order" (the app sorts them, but keep the file tidy)');
        break;
      }
      lastOrder = c.order;
    }
  }

  for (const t of CHAPTER_TABLE) {
    const found = byId.get(t.id);
    if (!found) {
      rep.error(f, 'chapters', `missing chapter "${t.id}" (${t.title})`);
      continue;
    }
    const { c, at } = found;
    const cat = `${at} (${t.id})`;
    const cctx = makeCtx(rep, f, cat);
    checkKeys(cctx, c, ['id', 'prefix', 'title', 'short', 'file', 'order', 'count', 'demo'], '');
    for (const key of /** @type {const} */ (['prefix', 'file', 'order', 'title'])) {
      if (c[key] !== t[key]) cctx.err(key, `must be ${JSON.stringify(t[key])} (fixed chapter table), got ${JSON.stringify(c[key])}`);
    }
    if (typeof c.short !== 'string' || c.short.trim() === '') cctx.err('short', 'is required (a short title for tight spaces)');
    else if (c.short.length > 14) cctx.warn('short', 'is long for a short title (keep it under 15 characters)');
    if (t.demo) {
      if (c.demo !== true) cctx.err('demo', 'the demo chapter must have "demo": true');
    } else if (c.demo !== undefined && c.demo !== false) {
      cctx.err('demo', 'only the demo chapter may have "demo": true');
    }
    if (!Number.isInteger(c.count) || c.count < 0) {
      cctx.err('count', 'must be a whole number ≥ 0');
    } else if (counts.has(t.id) && counts.get(t.id) !== c.count) {
      cctx.err('count', `is ${c.count} but ${t.file} has ${counts.get(t.id)} question(s)`);
    }
  }
  for (const [id, { at }] of byId) {
    if (!CHAPTER_TABLE.some((t) => t.id === id)) rep.error(f, at, `unknown chapter "${id}" (not in the fixed chapter table)`);
  }
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
    rep.error(f, '', 'must be {"retired": ["CPB-0007", ...]}');
    return out;
  }
  checkKeys(makeCtx(rep, f, ''), data, ['retired'], '');
  const prefixes = new Set(CHAPTER_TABLE.map((t) => t.prefix));
  data.retired.forEach((id, i) => {
    const at = `retired[${i}]`;
    const m = typeof id === 'string' ? QID_RE.exec(id) : null;
    if (!m) {
      rep.error(f, at, `invalid question id ${JSON.stringify(id)}`);
      return;
    }
    if (!prefixes.has(m[1])) rep.warn(f, at, `prefix ${m[1]} belongs to no chapter`);
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
 * @property {string} title
 * @property {string} prefix
 * @property {number} order
 * @property {boolean} demo
 * @property {number} total
 * @property {number} reviewed
 * @property {string} nextId
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

  for (const t of CHAPTER_TABLE) {
    const summary = {
      id: t.id, title: t.title, prefix: t.prefix, order: t.order, demo: Boolean(t.demo),
      total: 0, reviewed: 0, nextId: `${t.prefix}-0001`, positions: [0, 0, 0, 0, 0],
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
    summary.total = data.questions.length;

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
    const file = CHAPTER_TABLE.find((t) => t.id === id)?.file ?? '';
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

  checkIndex(rep, index, counts);

  // JSON files in data/ that the app never loads
  const known = new Set([INDEX_FILE, RETIRED_FILE, ...CHAPTER_TABLE.map((t) => t.file)]);
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
    const titleW = Math.max(...chapters.map((c) => c.title.length), 7);
    log(bold('Question bank'));
    log(dim(`  ${'#'.padStart(3)}  ${'Chapter'.padEnd(titleW)}  ${'Questions'.padStart(9)}  ${'Reviewed'.padStart(8)}  Next free ID`));
    for (const c of chapters) {
      log(`  ${String(c.order).padStart(3)}  ${c.title.padEnd(titleW)}  ${String(c.total).padStart(9)}  ${String(c.reviewed).padStart(8)}  ${c.nextId}`);
    }
    const real = chapters.filter((c) => !c.demo);
    const total = real.reduce((n, c) => n + c.total, 0);
    const reviewed = real.reduce((n, c) => n + c.reviewed, 0);
    const demo = chapters.filter((c) => c.demo).reduce((n, c) => n + c.total, 0);
    log(`  Total: ${bold(String(total))} question${total === 1 ? '' : 's'} (${reviewed} reviewed, ${total - reviewed} not yet reviewed), plus ${demo} demo.`);
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
