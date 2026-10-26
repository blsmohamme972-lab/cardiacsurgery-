#!/usr/bin/env node
/**
 * Sets a new app version in `sw.js` (VERSION) and `js/version.js` (APP_VERSION)
 * so installed apps detect the update (docs/ARCHITECTURE.md §5.9).
 *
 * Version format: `YYYY.MM.DD-N`. By default the version is today's date
 * (local time); N starts at 1 and goes up when today's date is already used.
 * Versions only move forward: if the current version is dated later than
 * today (clock or time zone differences), its date is kept and N goes up.
 *
 * Usage:
 *   node scripts/bump-version.mjs                    # e.g. 2026.10.26-1 → 2026.10.26-2
 *   node scripts/bump-version.mjs --set 2026.11.01-1 # exact version
 *   node scripts/bump-version.mjs --dry-run          # show the change, write nothing
 *
 * Then run: node scripts/validate.mjs
 *
 * Dev-only (Node 20+, no dependencies). Never loaded by the app.
 * Exit code 1 on any error.
 */

import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (this file lives in scripts/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `YYYY.MM.DD-N` */
export const VERSION_RE = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d{0,5})$/;

/**
 * Files that carry the version. `pattern` must match exactly once; group 2 is the version.
 * @type {ReadonlyArray<{ file: string, pattern: RegExp }>}
 */
export const TARGETS = Object.freeze([
  { file: 'sw.js', pattern: /(^const VERSION = ')([^'\n]*)(';)/m },
  { file: 'js/version.js', pattern: /(^export const APP_VERSION = ')([^'\n]*)(';)/m },
]);

/**
 * Parses and validates a version (real calendar date, N ≥ 1).
 * @param {string} version
 * @returns {{ date: string, year: number, month: number, day: number, n: number } | null}
 */
export function parseVersion(version) {
  const m = VERSION_RE.exec(String(version ?? '').trim());
  if (!m) return null;
  const [, y, mo, d, n] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { date: `${y}.${mo}.${d}`, year, month, day, n: Number(n) };
}

/**
 * Orders two valid versions.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new TypeError(`Invalid version: ${!pa ? a : b}`);
  if (pa.date !== pb.date) return pa.date < pb.date ? -1 : 1;
  if (pa.n !== pb.n) return pa.n < pb.n ? -1 : 1;
  return 0;
}

/**
 * Local calendar date as `YYYY.MM.DD`.
 * @param {Date} [now]
 * @returns {string}
 */
export function dateStamp(now = new Date()) {
  const pad = (/** @type {number} */ v) => String(v).padStart(2, '0');
  return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}`;
}

/**
 * The next version after `current` for the day `now`.
 * @param {string | null} current Current version (null/invalid → start fresh today).
 * @param {Date} [now]
 * @returns {string}
 */
export function nextVersion(current, now = new Date()) {
  const today = dateStamp(now);
  const cur = current ? parseVersion(current) : null;
  if (!cur || cur.date < today) return `${today}-1`;
  return `${cur.date}-${cur.n + 1}`;
}

/**
 * Reads the version from a file's text.
 * @param {string} text
 * @param {RegExp} pattern
 * @param {string} file For error messages.
 * @returns {string}
 */
export function readVersion(text, pattern, file) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const matches = [...text.matchAll(global)];
  if (matches.length !== 1) {
    throw new Error(`${file}: expected exactly one version line, found ${matches.length}.`);
  }
  return matches[0][2];
}

/**
 * Returns `text` with its version replaced.
 * @param {string} text
 * @param {RegExp} pattern
 * @param {string} version
 * @returns {string}
 */
export function writeVersion(text, pattern, version) {
  return text.replace(pattern, (_, before, _old, after) => `${before}${version}${after}`);
}

/**
 * Writes a file atomically (temp file + rename), so a crash never leaves it half written.
 * @param {string} file
 * @param {string} text
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * @param {string[]} argv
 * @returns {{ set: string | null, dryRun: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { set: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--dry-run' || arg === '-n') out.dryRun = true;
    else if (arg === '--set') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) throw new Error('--set needs a version, e.g. --set 2026.10.26-2');
      out.set = value;
      i += 1;
    } else if (arg.startsWith('--set=')) out.set = arg.slice('--set='.length);
    else throw new Error(`Unknown option: ${arg} (try --help)`);
  }
  return out;
}

const HELP = `Sets a new app version in sw.js and js/version.js.

Usage:
  node scripts/bump-version.mjs              today's version (YYYY.MM.DD-N)
  node scripts/bump-version.mjs --set V      exact version, e.g. --set 2026.10.26-2
  node scripts/bump-version.mjs --dry-run    show the change only

Then run: node scripts/validate.mjs`;

/**
 * Runs the command line tool.
 * @param {string[]} argv Arguments after the script name.
 * @param {{ root?: string, now?: Date, log?: (msg: string) => void, warn?: (msg: string) => void }} [env]
 * @returns {Promise<{ from: string[], to: string, changed: boolean }>}
 */
export async function main(argv, { root = ROOT, now = new Date(), log = console.log, warn = console.warn } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    log(HELP);
    return { from: [], to: '', changed: false };
  }

  const files = await Promise.all(
    TARGETS.map(async ({ file, pattern }) => {
      const abs = path.join(root, file);
      const text = await readFile(abs, 'utf8');
      const version = readVersion(text, pattern, file);
      return { file, abs, pattern, text, version };
    }),
  );

  const valid = files.filter((f) => parseVersion(f.version));
  for (const f of files) {
    if (!parseVersion(f.version)) warn(`Warning: ${f.file} has an invalid version "${f.version}".`);
  }
  const distinct = [...new Set(files.map((f) => f.version))];
  if (distinct.length > 1) {
    warn(`Warning: versions differ (${files.map((f) => `${f.file} ${f.version}`).join(', ')}). Both will be set.`);
  }
  const current = valid.length
    ? valid.map((f) => f.version).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
    : null;

  let next;
  if (args.set !== null) {
    const parsed = parseVersion(args.set);
    if (!parsed) throw new Error(`Invalid version "${args.set}". Use YYYY.MM.DD-N with a real date, e.g. ${dateStamp(now)}-1.`);
    next = `${parsed.date}-${parsed.n}`;
    if (current && compareVersions(next, current) <= 0) {
      warn(`Warning: ${next} is not newer than ${current}. Installed apps still update (any change counts), but versions should move forward.`);
    }
  } else {
    next = nextVersion(current, now);
  }

  const from = distinct.length ? distinct.join(' / ') : '(none)';
  const changed = files.some((f) => f.version !== next);
  if (!changed) {
    log(`Version unchanged: ${next}`);
    return { from: distinct, to: next, changed: false };
  }
  if (args.dryRun) {
    log(`Version ${from} → ${next} (dry run, nothing written)`);
    return { from: distinct, to: next, changed: true };
  }

  for (const f of files) {
    const updated = writeVersion(f.text, f.pattern, next);
    if (readVersion(updated, f.pattern, f.file) !== next) throw new Error(`${f.file}: could not write the new version.`);
    if (updated !== f.text) await writeAtomic(f.abs, updated);
  }
  log(`Version ${from} → ${next}`);
  log(`Updated: ${files.map((f) => f.file).join(', ')}. Next: node scripts/validate.mjs`);
  return { from: distinct, to: next, changed: true };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`bump-version: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
