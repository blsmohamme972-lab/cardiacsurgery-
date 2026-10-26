#!/usr/bin/env node
/**
 * Static code checks for the app (docs/ARCHITECTURE.md §1, CLAUDE.md "Code quality").
 *
 * Files: js/**\/*.js, sw.js, css/*.css, index.html, tests/fixtures/*.html
 * (inline <script> and <style> blocks of the HTML files are checked too).
 *
 * Rules
 * - imports    Every relative static `import … from '…'`, `export … from '…'`
 *              and literal dynamic `import('…')` resolves to an existing file,
 *              and every named import (and `default`) is exported by the target.
 *              Bare specifiers ("lodash") are errors: browsers can't load them.
 * - css-var    Every `var(--x)` without a fallback is defined in css/*.css or
 *              set from JS (`style.setProperty('--x', …)`, `{ '--x': … }` style
 *              keys, `--x: …` inside a style string). `var(--x, fallback)` is fine.
 * - no-html    No innerHTML / outerHTML / insertAdjacentHTML (code only, not
 *              comments or strings that mention them), except js/ui/icons.js.
 * - relative-url  No URL starting with "/" in fetch(), import, href, src, url().
 *              The app lives under /cardiacsurgery-/, so every path is relative.
 * - no-console-log  No console.log (console.warn/error for real problems only).
 * - module-header   Every JS file under js/ starts with a comment holding `@module`.
 * - app-shell  Every js/ and css/ file is listed in sw.js APP_SHELL (error);
 *              an APP_SHELL entry that does not exist yet is a warning.
 *
 * The checks are regex based on top of a small JS scanner that blanks
 * comments, string contents and regex literals (offsets and line numbers are
 * kept), so commented-out code and strings never cause false reports.
 * Every rule is a pure function on strings, exported for tests/unit/lint.test.mjs.
 *
 * Usage:
 *   node scripts/lint.mjs               # lint the repo
 *   node scripts/lint.mjs --quiet       # problems and the result line only
 *   node scripts/lint.mjs --strict      # warnings also fail
 *   node scripts/lint.mjs --root DIR    # lint another checkout
 *
 * Output: `file:line: message` (warnings say "warning:"). Exit code 1 on any
 * error (or any warning with --strict), else 0.
 * Dev-only (Node 20+, no dependencies). Never loaded by the app.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Repository root (this file lives in scripts/). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The only file allowed to use innerHTML-style APIs (static icon markup, §1). */
export const HTML_API_ALLOWED = Object.freeze(['js/ui/icons.js']);

/**
 * @typedef {'error' | 'warn'} Level
 * @typedef {{ file: string, line: number, level: Level, rule: string, message: string }} Finding
 */

/**
 * @param {string} file
 * @param {number} line
 * @param {string} rule
 * @param {string} message
 * @param {Level} [level]
 * @returns {Finding}
 */
function finding(file, line, rule, message, level = 'error') {
  return { file, line, level, rule, message };
}

// ---------------------------------------------------------------------------
// Line numbers
// ---------------------------------------------------------------------------

/**
 * Returns a function mapping a character offset to a 1-based line number.
 * @param {string} src
 * @param {number} [firstLine] Line number of offset 0 (for blocks inside HTML).
 * @returns {(offset: number) => number}
 */
export function lineMapper(src, firstLine = 1) {
  const starts = [0];
  for (let i = 0; i < src.length; i += 1) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + firstLine;
  };
}

// ---------------------------------------------------------------------------
// JS scanner
// ---------------------------------------------------------------------------

/** Keywords after which a "/" starts a regex literal, not a division. */
const REGEX_AFTER_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

/**
 * @typedef {object} JsScan
 * @property {string} noComments Source with comments blanked (strings and regexes kept).
 * @property {string} code       Source with comments, string/template contents and regex
 *                               bodies blanked (quotes and slashes kept). Same length as the source.
 * @property {{ start: number, end: number, value: string, template: boolean, hasExpr: boolean }[]} strings
 *   String literals and templates (`start` = opening quote, `end` = after the closing quote;
 *   for templates with `${…}`, `value` is the text before the first expression).
 */

/**
 * Scans JavaScript source. Blanked characters become spaces; newlines are kept,
 * so offsets and line numbers match the original source.
 * @param {string} src
 * @returns {JsScan}
 */
export function scanJs(src) {
  const n = src.length;
  const noC = src.split('');
  const code = src.split('');
  /** @type {JsScan['strings']} */
  const strings = [];
  /** @param {string[]} arr @param {number} a @param {number} b */
  const blank = (arr, a, b) => {
    for (let k = a; k < b && k < n; k += 1) if (arr[k] !== '\n' && arr[k] !== '\r') arr[k] = ' ';
  };

  /** Stack of open braces: '{' (code) or '${' (template expression). */
  const braces = [];
  /** Last significant token class: '' (start), 'v' (value), 'w' (identifier), or punctuation. */
  let last = '';
  let i = 0;

  /**
   * Scans template text from `from` (just after "`" or "}") to the closing "`"
   * or the next "${". Blanks the text in `code`.
   * @param {number} from
   * @param {number} quoteAt Offset of the opening "`" (for the strings list).
   * @param {boolean} first True when this is the first chunk of the template.
   * @returns {number} Offset after the chunk.
   */
  const templateChunk = (from, quoteAt, first) => {
    let k = from;
    let value = '';
    while (k < n) {
      const c = src[k];
      if (c === '\\') {
        value += src[k + 1] ?? '';
        k += 2;
        continue;
      }
      if (c === '`') {
        blank(code, from, k);
        if (first) strings.push({ start: quoteAt, end: k + 1, value, template: true, hasExpr: false });
        return k + 1;
      }
      if (c === '$' && src[k + 1] === '{') {
        blank(code, from, k);
        if (first) strings.push({ start: quoteAt, end: k, value, template: true, hasExpr: true });
        braces.push('${');
        return k + 2;
      }
      value += c;
      k += 1;
    }
    blank(code, from, n);
    if (first) strings.push({ start: quoteAt, end: n, value, template: true, hasExpr: false });
    return n;
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      let k = i;
      while (k < n && src[k] !== '\n') k += 1;
      blank(noC, i, k);
      blank(code, i, k);
      i = k;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const k = close === -1 ? n : close + 2;
      blank(noC, i, k);
      blank(code, i, k);
      i = k;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      let value = '';
      while (k < n && src[k] !== c && src[k] !== '\n') {
        if (src[k] === '\\') {
          value += src[k + 1] ?? '';
          k += 2;
        } else {
          value += src[k];
          k += 1;
        }
      }
      const end = src[k] === c ? k + 1 : k;
      blank(code, i + 1, end - (src[k] === c ? 1 : 0));
      strings.push({ start: i, end, value, template: false, hasExpr: false });
      i = end;
      last = 'v';
      continue;
    }
    if (c === '`') {
      i = templateChunk(i + 1, i, true);
      last = 'v';
      continue;
    }
    if (c === '/') {
      const regexAllowed = last === '' || (last !== 'v' && last !== 'w');
      if (regexAllowed) {
        let k = i + 1;
        let inClass = false;
        while (k < n && src[k] !== '\n') {
          const ch = src[k];
          if (ch === '\\') {
            k += 2;
            continue;
          }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) break;
          k += 1;
        }
        blank(code, i + 1, k);
        k += 1;
        while (k < n && /[a-z]/i.test(src[k])) k += 1;
        i = k;
        last = 'v';
        continue;
      }
      last = '/';
      i += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let k = i + 1;
      while (k < n && /[\w$]/.test(src[k])) k += 1;
      const word = src.slice(i, k);
      last = REGEX_AFTER_WORDS.has(word) ? 'op' : 'w';
      i = k;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let k = i + 1;
      while (k < n && /[\w.]/.test(src[k])) k += 1;
      i = k;
      last = 'v';
      continue;
    }
    if (c === '{') {
      braces.push('{');
      last = '{';
      i += 1;
      continue;
    }
    if (c === '}') {
      const top = braces.pop();
      if (top === '${') {
        i = templateChunk(i + 1, i, false);
        last = 'v';
        continue;
      }
      last = '}';
      i += 1;
      continue;
    }
    if (c === ')' || c === ']') {
      last = 'v';
      i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    last = c;
    i += 1;
  }
  return { noComments: noC.join(''), code: code.join(''), strings };
}

/**
 * Blanks CSS comments (offsets kept).
 * @param {string} css
 * @returns {string}
 */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Splits an HTML file into its inline scripts and styles (offsets kept by
 * returning each block's start offset). Scripts with a `src` are skipped.
 * HTML comments are blanked first.
 * @param {string} html
 * @returns {{ markup: string, scripts: { start: number, text: string, module: boolean }[], styles: { start: number, text: string }[] }}
 */
export function splitHtml(html) {
  const markup = html.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ' '));
  /** @type {{ start: number, text: string, module: boolean }[]} */
  const scripts = [];
  /** @type {{ start: number, text: string }[]} */
  const styles = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of markup.matchAll(scriptRe)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    const start = /** @type {number} */ (m.index) + m[0].indexOf('>') + 1;
    scripts.push({ start, text: m[2], module: /type\s*=\s*["']?module/i.test(m[1]) });
  }
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
  for (const m of markup.matchAll(styleRe)) {
    const start = /** @type {number} */ (m.index) + m[0].indexOf('>') + 1;
    styles.push({ start, text: m[1] });
  }
  // Markup without the script/style bodies (so their text isn't read as attributes).
  const blankBody = (/** @type {string} */ m) => m.replace(/>([\s\S]*)</, (inner) => inner.replace(/[^\n<>]/g, ' '));
  const bare = markup.replace(scriptRe, blankBody).replace(styleRe, blankBody);
  return { markup: bare, scripts, styles };
}

// ---------------------------------------------------------------------------
// Rule: imports
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ImportRef
 * @property {string} specifier
 * @property {number} offset    Offset of the `import` / `export` keyword.
 * @property {'static' | 'dynamic' | 'reexport'} kind
 * @property {string[]} names   Imported export names ('default' for default imports;
 *                              empty for side-effect, namespace and dynamic imports).
 * @property {boolean} star     `export * from` (all names forwarded).
 */

/**
 * Names requested by an import clause, e.g. `def, { a as b, c }` → ['default', 'a', 'c'].
 * @param {string} clause
 * @returns {string[]}
 */
export function importClauseNames(clause) {
  const names = [];
  const trimmed = clause.trim();
  const brace = trimmed.indexOf('{');
  const head = (brace === -1 ? trimmed : trimmed.slice(0, brace)).replace(/,\s*$/, '').trim();
  if (head && !head.startsWith('*')) {
    const first = head.split(',')[0].trim();
    if (/^[\w$]+$/.test(first) && first !== 'type') names.push('default');
  }
  if (brace !== -1) {
    const inner = trimmed.slice(brace + 1, trimmed.lastIndexOf('}'));
    for (const part of inner.split(',')) {
      const p = part.trim();
      if (!p) continue;
      const m = /^([\w$]+|"[^"]*"|'[^']*')(?:\s+as\s+[\w$]+)?$/.exec(p);
      if (m) names.push(m[1].replace(/^["']|["']$/g, ''));
    }
  }
  return names;
}

/**
 * Finds static imports, re-exports and literal dynamic imports.
 * @param {string} src JavaScript source.
 * @param {JsScan} [scan]
 * @returns {ImportRef[]}
 */
export function findImports(src, scan = scanJs(src)) {
  const { noComments, code } = scan;
  /** @type {ImportRef[]} */
  const out = [];
  const isCode = (/** @type {number} */ at, /** @type {string} */ word) => code.startsWith(word, at);
  const prevOk = (/** @type {number} */ at) => at === 0 || !/[\w$.]/.test(noComments[at - 1]);

  const staticRe = /\bimport\s*([\w$*{}\s,"']*?)\s*from\s*(['"])([^'"\n]+)\2/g;
  for (const m of noComments.matchAll(staticRe)) {
    const at = /** @type {number} */ (m.index);
    if (!isCode(at, 'import') || !prevOk(at)) continue;
    const clause = m[1];
    out.push({
      specifier: m[3],
      offset: at,
      kind: 'static',
      names: /^\s*\*/.test(clause) ? [] : importClauseNames(clause),
      star: false,
    });
  }
  const sideEffectRe = /\bimport\s*(['"])([^'"\n]+)\1/g;
  for (const m of noComments.matchAll(sideEffectRe)) {
    const at = /** @type {number} */ (m.index);
    if (!isCode(at, 'import') || !prevOk(at)) continue;
    out.push({ specifier: m[2], offset: at, kind: 'static', names: [], star: false });
  }
  const reexportRe = /\bexport\s*(\*\s*(?:as\s+[\w$]+\s*)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g;
  for (const m of noComments.matchAll(reexportRe)) {
    const at = /** @type {number} */ (m.index);
    if (!isCode(at, 'export') || !prevOk(at)) continue;
    const clause = m[1].trim();
    const star = clause.startsWith('*') && !/\bas\b/.test(clause);
    out.push({
      specifier: m[3],
      offset: at,
      kind: 'reexport',
      names: clause.startsWith('{') ? importClauseNames(clause) : [],
      star,
    });
  }
  const dynamicRe = /\bimport\s*\(\s*(['"`])([^'"`\n$]+)\1\s*[,)]/g;
  for (const m of noComments.matchAll(dynamicRe)) {
    const at = /** @type {number} */ (m.index);
    if (!isCode(at, 'import') || !prevOk(at)) continue;
    out.push({ specifier: m[2], offset: at, kind: 'dynamic', names: [], star: false });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/**
 * Names declared by `export const|let|var …` starting at `from` (the first
 * character after the keyword). Handles several declarators and simple
 * destructuring patterns.
 * @param {string} code Scanned code (string contents blanked).
 * @param {number} from
 * @returns {string[]}
 */
function declaratorNames(code, from) {
  const names = [];
  let k = from;
  const n = code.length;
  const skipWs = () => {
    while (k < n && /\s/.test(code[k])) k += 1;
  };
  for (;;) {
    skipWs();
    if (code[k] === '{' || code[k] === '[') {
      // Destructuring: collect identifiers not followed by ":" (keys) at any depth.
      const open = code[k];
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      const start = k;
      for (; k < n; k += 1) {
        if (code[k] === open) depth += 1;
        else if (code[k] === close) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const pattern = code.slice(start + 1, k);
      for (const m of pattern.matchAll(/(?:^|[{,[\s])(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?=[,}\]=]|$)/g)) names.push(m[1]);
      k += 1;
    } else {
      const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(k, k + 200));
      if (!m) break;
      names.push(m[0]);
      k += m[0].length;
    }
    // Skip the initializer to the next top-level "," or the end of the statement.
    let depth = 0;
    let more = false;
    for (; k < n; k += 1) {
      const c = code[k];
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && c === ';') break;
      else if (depth === 0 && c === ',') {
        more = true;
        k += 1;
        break;
      } else if (depth === 0 && c === '\n') {
        // A newline ends the statement unless the expression clearly continues.
        const before = code.slice(from, k).trimEnd();
        const after = code.slice(k).trimStart();
        if (!/[=+\-*/%&|^!?:,(<>.]$/.test(before) && !/^[.?:+\-*/%&|^=<>,)]/.test(after)) break;
      }
    }
    if (!more) break;
  }
  return names;
}

/**
 * Parses the export statements of a module.
 * @param {string} src
 * @param {JsScan} [scan]
 * @returns {{ names: Set<string>, starFrom: string[] }}
 *   `starFrom`: specifiers of `export * from '…'` (their names are forwarded).
 */
export function parseExports(src, scan = scanJs(src)) {
  const { code, noComments } = scan;
  const names = new Set();
  const starFrom = [];
  for (const m of code.matchAll(/(?:^|[^\w$.])export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])export\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/(?:^|[^\w$.])export\s+(?:const|let|var)\s/g)) {
    const from = /** @type {number} */ (m.index) + m[0].length;
    for (const name of declaratorNames(code, from)) names.add(name);
  }
  if (/(?:^|[^\w$.])export\s+default\b/.test(code)) names.add('default');
  for (const m of code.matchAll(/(?:^|[^\w$.])export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const as = /^(?:[\w$]+)\s+as\s+([\w$]+)$/.exec(p);
      names.add(as ? as[1] : p);
    }
  }
  for (const m of noComments.matchAll(/(?:^|[^\w$.])export\s*\*\s*(?:as\s+([\w$]+)\s*)?from\s*(['"])([^'"\n]+)\2/g)) {
    if (m[1]) names.add(m[1]);
    else starFrom.push(m[3]);
  }
  return { names, starFrom };
}

/**
 * Checks the imports of one file.
 * @param {string} file Repo-relative POSIX path of the importing file (used for messages and resolution).
 * @param {string} src
 * @param {{ exists: (rel: string) => boolean,
 *           exportsOf: (rel: string) => Set<string> | null,
 *           scan?: JsScan, lineOf?: (offset: number) => number }} env
 *   `exportsOf` returns every name the module exports (after following `export *`), or null when unreadable.
 * @returns {Finding[]}
 */
export function checkImports(file, src, env) {
  const scan = env.scan ?? scanJs(src);
  const lineOf = env.lineOf ?? lineMapper(src);
  /** @type {Finding[]} */
  const out = [];
  for (const ref of findImports(src, scan)) {
    const line = lineOf(ref.offset);
    const spec = ref.specifier;
    if (spec.startsWith('/')) continue; // reported by relative-url
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
      out.push(finding(file, line, 'imports', `import of an absolute URL "${spec}": the app must work offline with local files only`));
      continue;
    }
    if (!spec.startsWith('./') && !spec.startsWith('../')) {
      out.push(finding(file, line, 'imports', `bare import "${spec}" can't load in the browser; use a relative path like "./x.js"`));
      continue;
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    if (target.startsWith('../')) {
      out.push(finding(file, line, 'imports', `import "${spec}" points outside the repository`));
      continue;
    }
    if (!env.exists(target)) {
      out.push(finding(file, line, 'imports', `import "${spec}" not found (${target})`));
      continue;
    }
    if (ref.names.length === 0) continue;
    const exported = env.exportsOf(target);
    if (!exported) continue;
    for (const name of ref.names) {
      if (!exported.has(name)) {
        const what = name === 'default' ? 'default export' : `export named "${name}"`;
        out.push(finding(file, line, 'imports', `"${spec}" has no ${what}`));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule: css-var
// ---------------------------------------------------------------------------

/**
 * Custom properties defined in CSS (`--x: …` declarations and `@property --x`).
 * @param {string} css
 * @returns {Set<string>}
 */
export function cssVarDefs(css) {
  const text = stripCssComments(css);
  const out = new Set();
  for (const m of text.matchAll(/(?:^|[{;\s])(--[\w-]+)\s*:/g)) out.add(m[1]);
  for (const m of text.matchAll(/@property\s+(--[\w-]+)/g)) out.add(m[1]);
  return out;
}

/**
 * Custom properties set from JavaScript: `setProperty('--x', …)`, style object
 * keys `'--x': …`, and `--x: …` declarations inside style strings.
 * Template keys like `` `--hl-${c}` `` give a prefix (`--hl-`).
 * @param {string} src
 * @param {JsScan} [scan]
 * @returns {{ names: Set<string>, prefixes: Set<string> }}
 */
export function jsVarDefs(src, scan = scanJs(src)) {
  const names = new Set();
  const prefixes = new Set();
  const { noComments } = scan;
  for (const m of noComments.matchAll(/setProperty\(\s*(['"`])(--[\w-]+)\1/g)) names.add(m[2]);
  for (const m of noComments.matchAll(/setProperty\(\s*`(--[\w-]*)\$\{/g)) if (m[1].length > 2) prefixes.add(m[1]);
  for (const m of noComments.matchAll(/(['"`])(--[\w-]+)\1\s*:/g)) names.add(m[2]);
  for (const m of noComments.matchAll(/\[\s*`(--[\w-]*)\$\{[^`]*`\s*\]\s*:/g)) if (m[1].length > 2) prefixes.add(m[1]);
  for (const s of scan.strings) {
    for (const m of s.value.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)) names.add(m[1]);
  }
  return { names, prefixes };
}

/**
 * `var(--x)` uses without a fallback (`var(--x, …)` is always allowed).
 * Works on CSS, JS (with comments removed) and HTML text.
 * @param {string} text
 * @returns {{ name: string, offset: number }[]}
 */
export function varUses(text) {
  const out = [];
  for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
    if (m[2] === ',') continue;
    out.push({ name: m[1], offset: /** @type {number} */ (m.index) });
  }
  return out;
}

/**
 * Checks that every `var(--x)` in `text` is defined.
 * @param {string} file
 * @param {string} text Text to search (comments already blanked).
 * @param {{ names: Set<string>, prefixes?: Set<string> }} defined
 * @param {(offset: number) => number} lineOf
 * @returns {Finding[]}
 */
export function checkVarUses(file, text, defined, lineOf) {
  const out = [];
  const prefixes = [...(defined.prefixes ?? [])];
  for (const use of varUses(text)) {
    if (defined.names.has(use.name)) continue;
    if (prefixes.some((p) => use.name.startsWith(p))) continue;
    out.push(finding(file, lineOf(use.offset), 'css-var', `${use.name} is not defined in css/*.css or set from JS (add it to a stylesheet, or use var(${use.name}, fallback))`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule: no-html
// ---------------------------------------------------------------------------

/**
 * Finds innerHTML / outerHTML / insertAdjacentHTML used in code.
 * @param {string} file
 * @param {string} src
 * @param {{ scan?: JsScan, lineOf?: (offset: number) => number }} [opts]
 * @returns {Finding[]}
 */
export function checkNoHtmlApis(file, src, { scan = scanJs(src), lineOf = lineMapper(src) } = {}) {
  if (HTML_API_ALLOWED.includes(file)) return [];
  const out = [];
  const seen = new Set();
  const add = (/** @type {number} */ at, /** @type {string} */ api) => {
    if (seen.has(at)) return;
    seen.add(at);
    out.push(finding(file, lineOf(at), 'no-html', `${api} is not allowed (build DOM with h()/svg() from js/core/dom.js)`));
  };
  for (const m of scan.code.matchAll(/(?:\.\s*|\b)(innerHTML|outerHTML|insertAdjacentHTML)\b/g)) {
    const at = /** @type {number} */ (m.index) + m[0].indexOf(m[1]);
    add(at, m[1]);
  }
  // el['innerHTML'] = …
  for (const m of scan.noComments.matchAll(/\[\s*(['"`])(innerHTML|outerHTML|insertAdjacentHTML)\1\s*\]/g)) {
    if (scan.code[/** @type {number} */ (m.index)] !== '[') continue;
    add(/** @type {number} */ (m.index), m[2]);
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Rule: relative-url
// ---------------------------------------------------------------------------

const ABS_MSG = (/** @type {string} */ url) =>
  `URL "${url}" starts with "/"; use a relative path (the app lives under /cardiacsurgery-/)`;

/**
 * Finds URLs starting with "/" in fetch(), import, new URL(), Request(),
 * serviceWorker.register(), href/src properties and attributes, and CSS url().
 * @param {string} file
 * @param {string} src
 * @param {'js' | 'css' | 'html'} kind
 * @param {{ scan?: JsScan, lineOf?: (offset: number) => number }} [opts]
 * @returns {Finding[]}
 */
export function checkRelativeUrls(file, src, kind, opts = {}) {
  const lineOf = opts.lineOf ?? lineMapper(src);
  const out = [];
  /** @param {string} text @param {RegExp} re @param {number} group @param {(at: number) => boolean} [ok] */
  const scanRe = (text, re, group, ok = () => true) => {
    for (const m of text.matchAll(re)) {
      const at = /** @type {number} */ (m.index);
      if (!ok(at)) continue;
      out.push(finding(file, lineOf(at), 'relative-url', ABS_MSG(m[group])));
    }
  };
  if (kind === 'js') {
    const scan = opts.scan ?? scanJs(src);
    const isCode = (/** @type {number} */ at) => scan.code[at] === src[at];
    const q = `(['"\`])(\\/[^'"\`\\s]*)\\1?`;
    scanRe(scan.noComments, new RegExp(`\\b(?:fetch|import|Request|register)\\s*\\(\\s*${q}`, 'g'), 2, isCode);
    scanRe(scan.noComments, new RegExp(`\\bnew\\s+URL\\s*\\(\\s*${q}`, 'g'), 2, isCode);
    scanRe(scan.noComments, new RegExp(`\\bfrom\\s*(['"])(\\/[^'"\\s]*)\\1`, 'g'), 2, isCode);
    scanRe(scan.noComments, new RegExp(`(?<![\\w$])(?:href|src|action|poster)\\s*[:=]\\s*${q}`, 'g'), 2, isCode);
    scanRe(scan.noComments, new RegExp(`setAttribute\\(\\s*(['"])(?:href|src|action|poster)\\1\\s*,\\s*(['"\`])(\\/[^'"\`\\s]*)`, 'g'), 3, isCode);
    for (const s of scan.strings) {
      for (const m of s.value.matchAll(/url\(\s*(['"]?)(\/[^'")\s]*)/g)) {
        out.push(finding(file, lineOf(s.start), 'relative-url', ABS_MSG(m[2])));
      }
    }
  } else if (kind === 'css') {
    const text = stripCssComments(src);
    scanRe(text, /url\(\s*(['"]?)(\/[^'")\s]*)/g, 2);
    scanRe(text, /@import\s+(['"])(\/[^'"\s]*)\1/g, 2);
  } else {
    scanRe(src, /\s(?:href|src|action|poster)\s*=\s*(["']?)(\/[^"'\s>]*)/gi, 2);
    scanRe(src, /url\(\s*(['"]?)(\/[^'")\s]*)/g, 2);
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// Rule: no-console-log
// ---------------------------------------------------------------------------

/**
 * @param {string} file
 * @param {string} src
 * @param {{ scan?: JsScan, lineOf?: (offset: number) => number }} [opts]
 * @returns {Finding[]}
 */
export function checkNoConsoleLog(file, src, { scan = scanJs(src), lineOf = lineMapper(src) } = {}) {
  const out = [];
  for (const m of scan.code.matchAll(/\bconsole\s*\.\s*log\b/g)) {
    out.push(finding(file, lineOf(/** @type {number} */ (m.index)), 'no-console-log', 'console.log is not allowed (use console.warn/error for real problems only)'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule: module-header
// ---------------------------------------------------------------------------

/**
 * The file must start (after whitespace) with a block comment containing `@module`.
 * @param {string} file
 * @param {string} src
 * @returns {Finding[]}
 */
export function checkModuleHeader(file, src) {
  const text = src.replace(/^﻿/, '').replace(/^#![^\n]*\n/, '');
  const m = /^\s*\/\*([\s\S]*?)\*\//.exec(text);
  if (m && /@module\b/.test(m[1])) return [];
  const msg = m
    ? 'the header comment has no @module tag (add " * @module path/name" to the first comment)'
    : 'file must start with a header comment containing @module';
  return [finding(file, 1, 'module-header', msg)];
}

// ---------------------------------------------------------------------------
// Rule: app-shell
// ---------------------------------------------------------------------------

/**
 * Reads the APP_SHELL array of sw.js.
 * @param {string} swSrc
 * @returns {{ entries: { path: string, line: number }[], line: number } | null} null when not found.
 */
export function parseAppShell(swSrc) {
  const scan = scanJs(swSrc);
  const m = /\bAPP_SHELL\s*=\s*\[/.exec(scan.code);
  if (!m) return null;
  const lineOf = lineMapper(swSrc);
  const open = /** @type {number} */ (m.index) + m[0].length;
  const close = scan.code.indexOf(']', open);
  const end = close === -1 ? swSrc.length : close;
  const entries = scan.strings
    .filter((s) => s.start >= open && s.start < end && !s.hasExpr)
    .map((s) => ({ path: s.value, line: lineOf(s.start) }));
  return { entries, line: lineOf(/** @type {number} */ (m.index)) };
}

/**
 * Compares APP_SHELL with the app files on disk.
 * @param {{ path: string, line: number }[]} entries APP_SHELL entries.
 * @param {string[]} appFiles Repo-relative js/ and css/ files that must be precached.
 * @param {(rel: string) => boolean} exists
 * @returns {Finding[]}
 */
export function checkAppShell(entries, appFiles, exists) {
  const out = [];
  const listed = new Set(entries.map((e) => e.path.replace(/^\.\//, '')));
  for (const e of entries) {
    const rel = e.path.replace(/^\.\//, '');
    if (rel === '') continue; // './' = start page
    if (rel.startsWith('/')) {
      out.push(finding('sw.js', e.line, 'app-shell', ABS_MSG(e.path)));
      continue;
    }
    if (!exists(rel)) out.push(finding('sw.js', e.line, 'app-shell', `APP_SHELL entry "${e.path}" does not exist yet`, 'warn'));
  }
  for (const file of appFiles) {
    if (!listed.has(file)) out.push(finding(file, 1, 'app-shell', 'missing from sw.js APP_SHELL; without it the app breaks offline'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Repository walk
// ---------------------------------------------------------------------------

/**
 * Repo-relative POSIX paths of files under `dir` matching `test` (recursive).
 * Dot-folders and node_modules are skipped.
 * @param {string} root
 * @param {string} dir
 * @param {(name: string) => boolean} test
 * @param {boolean} [recursive]
 * @returns {string[]}
 */
function listFiles(root, dir, test, recursive = true) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (recursive) out.push(...listFiles(root, rel, test, true));
    } else if (entry.isFile() && test(entry.name)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/**
 * Lints a checkout.
 * @param {{ root?: string }} [options]
 * @returns {{ findings: Finding[], files: number }}
 */
export function lintRepo({ root = ROOT } = {}) {
  const read = (/** @type {string} */ rel) => readFileSync(path.join(root, rel), 'utf8');
  const exists = (/** @type {string} */ rel) => {
    try {
      return statSync(path.join(root, rel)).isFile();
    } catch {
      return false;
    }
  };

  const jsFiles = listFiles(root, 'js', (n) => n.endsWith('.js'));
  const cssFiles = listFiles(root, 'css', (n) => n.endsWith('.css'), false);
  const htmlFiles = [
    ...(exists('index.html') ? ['index.html'] : []),
    ...listFiles(root, 'tests/fixtures', (n) => n.endsWith('.html'), false),
  ];
  const swFiles = exists('sw.js') ? ['sw.js'] : [];

  /** @type {Map<string, JsScan>} */
  const scans = new Map();
  const scanOf = (/** @type {string} */ rel) => {
    let s = scans.get(rel);
    if (!s) {
      s = scanJs(read(rel));
      scans.set(rel, s);
    }
    return s;
  };

  /** @type {Map<string, Set<string> | null>} */
  const exportCache = new Map();
  /** @param {string} rel @param {Set<string>} [visiting] @returns {Set<string> | null} */
  const exportsOf = (rel, visiting = new Set()) => {
    if (exportCache.has(rel)) return /** @type {Set<string> | null} */ (exportCache.get(rel));
    if (visiting.has(rel)) return new Set();
    visiting.add(rel);
    let result = null;
    try {
      const src = read(rel);
      const { names, starFrom } = parseExports(src, scanOf(rel));
      result = new Set(names);
      for (const spec of starFrom) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        const sub = exists(target) ? exportsOf(target, visiting) : null;
        if (sub) for (const name of sub) if (name !== 'default') result.add(name);
      }
    } catch {
      result = null;
    }
    exportCache.set(rel, result);
    return result;
  };

  // Custom properties defined anywhere in the app.
  const defined = { names: new Set(), prefixes: new Set() };
  for (const rel of cssFiles) for (const name of cssVarDefs(read(rel))) defined.names.add(name);
  for (const rel of [...jsFiles, ...swFiles]) {
    const d = jsVarDefs(read(rel), scanOf(rel));
    for (const name of d.names) defined.names.add(name);
    for (const p of d.prefixes) defined.prefixes.add(p);
  }

  /** @type {Finding[]} */
  const findings = [];

  /**
   * Every JS rule for one script.
   * @param {string} file
   * @param {string} src
   * @param {(offset: number) => number} lineOf
   * @param {{ names: Set<string>, prefixes: Set<string> }} vars
   * @param {JsScan} scan
   */
  const lintScript = (file, src, lineOf, vars, scan) => {
    findings.push(...checkImports(file, src, { exists, exportsOf: (rel) => exportsOf(rel), scan, lineOf }));
    findings.push(...checkVarUses(file, scan.noComments, vars, lineOf));
    findings.push(...checkNoHtmlApis(file, src, { scan, lineOf }));
    findings.push(...checkRelativeUrls(file, src, 'js', { scan, lineOf }));
    findings.push(...checkNoConsoleLog(file, src, { scan, lineOf }));
  };

  for (const rel of [...jsFiles, ...swFiles]) {
    const src = read(rel);
    lintScript(rel, src, lineMapper(src), defined, scanOf(rel));
    if (rel.startsWith('js/')) findings.push(...checkModuleHeader(rel, src));
  }

  for (const rel of cssFiles) {
    const src = read(rel);
    const lineOf = lineMapper(src);
    findings.push(...checkVarUses(rel, stripCssComments(src), defined, lineOf));
    findings.push(...checkRelativeUrls(rel, src, 'css', { lineOf }));
  }

  for (const rel of htmlFiles) {
    const html = read(rel);
    const lineOf = lineMapper(html);
    const { markup, scripts, styles } = splitHtml(html);
    // Definitions local to this page (inline <style> and style="" attributes).
    const local = { names: new Set(defined.names), prefixes: new Set(defined.prefixes) };
    for (const st of styles) for (const name of cssVarDefs(st.text)) local.names.add(name);
    for (const m of markup.matchAll(/\sstyle\s*=\s*(["'])([^"']*)\1/gi)) {
      for (const name of cssVarDefs(`{${m[2]}}`)) local.names.add(name);
    }
    for (const sc of scripts) {
      const d = jsVarDefs(sc.text);
      for (const name of d.names) local.names.add(name);
      for (const p of d.prefixes) local.prefixes.add(p);
    }
    findings.push(...checkRelativeUrls(rel, markup, 'html', { lineOf }));
    findings.push(...checkVarUses(rel, markup, local, lineOf));
    for (const st of styles) {
      const blockLine = lineMapper(st.text, lineOf(st.start));
      findings.push(...checkVarUses(rel, stripCssComments(st.text), local, blockLine));
      findings.push(...checkRelativeUrls(rel, st.text, 'css', { lineOf: blockLine }));
    }
    for (const sc of scripts) {
      const blockLine = lineMapper(sc.text, lineOf(sc.start));
      // Imports in an inline script resolve relative to the HTML file.
      lintScript(rel, sc.text, blockLine, local, scanJs(sc.text));
    }
  }

  if (swFiles.length) {
    const shell = parseAppShell(read('sw.js'));
    if (!shell) findings.push(finding('sw.js', 1, 'app-shell', 'APP_SHELL array not found'));
    else findings.push(...checkAppShell(shell.entries, [...jsFiles, ...cssFiles], exists));
  }

  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { findings, files: jsFiles.length + cssFiles.length + htmlFiles.length + swFiles.length };
}

/**
 * One output line: `file:line: message` (warnings marked).
 * @param {Finding} f
 * @returns {string}
 */
export function formatFinding(f) {
  return `${f.file}:${f.line}: ${f.level === 'warn' ? 'warning: ' : ''}${f.message} [${f.rule}]`;
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, quiet: boolean, strict: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const opts = { root: ROOT, quiet: false, strict: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].split('=', 2);
    if (name === '--quiet' || name === '-q') opts.quiet = true;
    else if (name === '--strict') opts.strict = true;
    else if (name === '--root') {
      const value = inline !== undefined ? inline : argv[++i];
      if (!value) throw new Error('--root needs a folder');
      opts.root = path.resolve(value);
    } else if (name === '--help' || name === '-h') {
      opts.help = true;
    } else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return opts;
}

/**
 * CLI entry.
 * @param {string[]} argv
 * @param {{ log?: (s: string) => void }} [io]
 * @returns {number} Exit code.
 */
export function main(argv, { log = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log('Usage: node scripts/lint.mjs [--quiet] [--strict] [--root DIR]');
    return 0;
  }
  const { findings, files } = lintRepo({ root: opts.root });
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warn');
  for (const f of findings) log(formatFinding(f));
  const failed = errors.length > 0 || (opts.strict && warnings.length > 0);
  if (!opts.quiet || findings.length) {
    log(`lint: ${files} files, ${errors.length} error(s), ${warnings.length} warning(s) → ${failed ? 'FAILED' : 'OK'}`);
  }
  return failed ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`lint: ${(err && err.message) || err}\n`);
    process.exitCode = 1;
  }
}
