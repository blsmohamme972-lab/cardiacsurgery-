// Unit tests for scripts/lint.mjs (dev-only static checks).
// Run: node --test tests/unit/*.test.mjs
//
// Every rule is tested on small strings; one test lints a tiny temporary
// checkout end to end (exit code, output format).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  checkAppShell,
  checkImports,
  checkModuleHeader,
  checkNoConsoleLog,
  checkNoHtmlApis,
  checkRelativeUrls,
  checkVarUses,
  cssVarDefs,
  findImports,
  formatFinding,
  importClauseNames,
  jsVarDefs,
  lineMapper,
  lintRepo,
  main,
  parseAppShell,
  parseArgs,
  parseExports,
  scanJs,
  splitHtml,
  stripCssComments,
  varUses,
} from '../../scripts/lint.mjs';

const lines = (/** @type {{ line: number }[]} */ fs) => fs.map((f) => f.line);

describe('scanJs', () => {
  test('keeps length and newlines, blanks comments and string contents', () => {
    const src = "const a = 'x // y'; // note\n/* block\n */ const b = `t ${a} u`;\n";
    const s = scanJs(src);
    assert.equal(s.code.length, src.length);
    assert.equal(s.noComments.length, src.length);
    assert.equal(s.code.split('\n').length, src.split('\n').length);
    assert.ok(!s.code.includes('note'));
    assert.ok(!s.code.includes('x // y'));
    assert.ok(s.noComments.includes("'x // y'"));
    assert.ok(!s.noComments.includes('block'));
    assert.ok(s.code.includes('${a}'.slice(2, 3)), 'template expression stays code');
    assert.deepEqual(
      s.strings.map((x) => [x.value, x.template, x.hasExpr]),
      [['x // y', false, false], ['t ', true, true]],
    );
  });

  test('regex literals are blanked; division is not a regex', () => {
    const src = "const r = /\\/\\/ console.log ['\"]/g; const d = a / b / c; x = (y) / 2;";
    const s = scanJs(src);
    assert.ok(!s.code.includes('console.log'));
    assert.ok(s.code.includes('a / b / c'));
    assert.equal(s.strings.length, 0);
  });

  test('regex after return and inside a character class', () => {
    const s = scanJs("function f(){ return /[/]innerHTML/.test(x) }\nel.innerHTML = 1;");
    assert.equal((s.code.match(/innerHTML/g) || []).length, 1);
  });

  test('nested template expressions', () => {
    const src = 'const a = `x ${ {k: `inner ${b}`}.k } y`; console.log(1);';
    const s = scanJs(src);
    assert.ok(s.code.includes('console.log'));
    assert.ok(!s.code.includes('inner'));
  });

  test('escaped quotes', () => {
    const s = scanJs("const a = 'it\\'s'; const b = \"q\\\"\"; console.log(a)");
    assert.deepEqual(s.strings.map((x) => x.value), ["it's", 'q"']);
    assert.ok(s.code.includes('console.log'));
  });
});

describe('lineMapper', () => {
  test('maps offsets to lines, with a start line', () => {
    const at = lineMapper('a\nbc\n\nd');
    assert.equal(at(0), 1);
    assert.equal(at(2), 2);
    assert.equal(at(5), 3);
    assert.equal(at(6), 4);
    assert.equal(lineMapper('x\ny', 10)(2), 11);
  });
});

describe('imports', () => {
  test('importClauseNames', () => {
    assert.deepEqual(importClauseNames('{ a, b as c }'), ['a', 'b']);
    assert.deepEqual(importClauseNames('def, { a }'), ['default', 'a']);
    assert.deepEqual(importClauseNames('def'), ['default']);
    assert.deepEqual(importClauseNames('{ default as x, y, }'), ['default', 'y']);
    assert.deepEqual(importClauseNames('{\n  a,\n  b\n}'), ['a', 'b']);
  });

  test('findImports: static, side effect, re-export, dynamic; skips comments and strings', () => {
    const src = [
      "import { a, b as c } from './x.js';",
      "import d from '../y.js';",
      "import * as ns from './ns.js';",
      "import './side.js';",
      "export { e } from './e.js';",
      "export * from './all.js';",
      "const m = await import('./lazy.js');",
      "const t = import(`./tpl.js`);",
      'const dyn = import(`./${name}.js`);',
      "// import { z } from './commented.js';",
      "const s = \"import { q } from './string.js'\";",
      '/** @type {import(\'./types.js\').T} */',
    ].join('\n');
    const refs = findImports(src);
    assert.deepEqual(
      refs.map((r) => [r.specifier, r.kind, r.names.join(','), r.star]),
      [
        ['./x.js', 'static', 'a,b', false],
        ['../y.js', 'static', 'default', false],
        ['./ns.js', 'static', '', false],
        ['./side.js', 'static', '', false],
        ['./e.js', 'reexport', 'e', false],
        ['./all.js', 'reexport', '', true],
        ['./lazy.js', 'dynamic', '', false],
        ['./tpl.js', 'dynamic', '', false],
      ],
    );
  });

  test('multi-line import clause', () => {
    const refs = findImports("import {\n  one,\n  two,\n} from './m.js';\n");
    assert.deepEqual(refs[0].names, ['one', 'two']);
  });

  test('parseExports covers every form', () => {
    const src = [
      'export function f() {}',
      'export async function g() {}',
      'export function* gen() {}',
      'export class K {}',
      'export const A = 1, B = { x: [1, 2] }, C = (a, b) => a + b;',
      'export let L;',
      'export const { d1, d2: renamed, ...rest } = obj;',
      'export const [e1, e2] = arr;',
      'export const multi = cond',
      '  ? 1',
      '  : 2;',
      'export const after = 3;',
      'const p = 1, q = 2;',
      'export { p, q as Q };',
      'export { p as default };',
      "export * as nsx from './n.js';",
      "export * from './star.js';",
      '// export const commented = 1;',
      "const s = 'export const inString = 1';",
    ].join('\n');
    const { names, starFrom } = parseExports(src);
    for (const n of ['f', 'g', 'gen', 'K', 'A', 'B', 'C', 'L', 'd1', 'renamed', 'rest', 'e1', 'e2', 'multi', 'after', 'p', 'Q', 'default', 'nsx']) {
      assert.ok(names.has(n), `missing ${n}`);
    }
    for (const n of ['commented', 'inString', 'q', 'x', 'd2']) assert.ok(!names.has(n), `unexpected ${n}`);
    assert.deepEqual(starFrom, ['./star.js']);
  });

  test('export default', () => {
    assert.ok(parseExports('export default { async render() {} };').names.has('default'));
    assert.ok(!parseExports('const x = { default: 1 };').names.has('default'));
  });

  test('checkImports resolves paths and names', () => {
    const files = {
      'js/core/dom.js': new Set(['h', 'svg']),
      'js/screens/home.js': new Set(['default']),
    };
    const env = {
      exists: (/** @type {string} */ rel) => rel in files,
      exportsOf: (/** @type {string} */ rel) => files[rel] ?? null,
    };
    const src = [
      "import { h, missing } from '../core/dom.js';",
      "import nope from '../core/dom.js';",
      "import home from './home.js';",
      "import x from './gone.js';",
      "import y from 'bare-package';",
      "import z from '../../../outside.js';",
      "const lazy = () => import('./also-gone.js');",
      "import abs from '/js/core/dom.js';",
    ].join('\n');
    const out = checkImports('js/screens/test.js', src, env);
    assert.deepEqual(
      out.map((f) => [f.line, f.message]),
      [
        [1, '"../core/dom.js" has no export named "missing"'],
        [2, '"../core/dom.js" has no default export'],
        [4, 'import "./gone.js" not found (js/screens/gone.js)'],
        [5, `bare import "bare-package" can't load in the browser; use a relative path like "./x.js"`],
        [6, 'import "../../../outside.js" points outside the repository'],
        [7, 'import "./also-gone.js" not found (js/screens/also-gone.js)'],
      ],
    );
    assert.ok(out.every((f) => f.level === 'error' && f.rule === 'imports'));
  });
});

describe('css-var', () => {
  test('cssVarDefs finds declarations and @property, not uses or comments', () => {
    const css = ':root{--a:1;--b : 2}\n.x{ color: var(--c); --d: var(--a) }\n/* --e: 1 */\n@property --f { syntax: "*"; }';
    assert.deepEqual([...cssVarDefs(css)].sort(), ['--a', '--b', '--d', '--f']);
  });

  test('jsVarDefs: setProperty, style keys, style strings, template prefixes', () => {
    const src = [
      "el.style.setProperty('--kb', '1px');",
      "h('div', { style: { '--value': 3 } });",
      "h('div', { style: 'width: 1px; --ring: 2px' });",
      'el.style.setProperty(`--hl-${c}`, v);',
      "// el.style.setProperty('--commented', 1);",
    ].join('\n');
    const d = jsVarDefs(src);
    assert.deepEqual([...d.names].sort(), ['--kb', '--ring', '--value']);
    assert.deepEqual([...d.prefixes], ['--hl-']);
  });

  test('varUses skips fallbacks', () => {
    assert.deepEqual(
      varUses('a: var(--x); b: var( --y , 1px); c: var(--z)').map((u) => u.name),
      ['--x', '--z'],
    );
    assert.deepEqual(varUses('`var(--hl-${c})`'), []);
  });

  test('checkVarUses reports undefined names with lines', () => {
    const text = '.a { color: var(--ok); }\n.b { color: var(--missing); }\n.c { color: var(--hl-yellow); }';
    const out = checkVarUses('css/x.css', text, { names: new Set(['--ok']), prefixes: new Set(['--hl-']) }, lineMapper(text));
    assert.deepEqual(lines(out), [2]);
    assert.match(out[0].message, /--missing is not defined/);
  });

  test('stripCssComments keeps offsets', () => {
    const css = 'a{}/* x\ny */b{}';
    const out = stripCssComments(css);
    assert.equal(out.length, css.length);
    assert.equal(out.split('\n').length, 2);
    assert.ok(!out.includes('x'));
  });
});

describe('no-html', () => {
  test('flags code uses only', () => {
    const src = [
      '/** innerHTML is refused here. */',
      "const FORBIDDEN = new Set(['innerHTML', 'outerHTML']);",
      "if (key === 'insertAdjacentHTML') throw new TypeError('no');",
      'el.innerHTML = x;',
      'el.outerHTML = y;',
      "el.insertAdjacentHTML('beforeend', z);",
      "el['innerHTML'] = w;",
      '// el.innerHTML = commented;',
    ].join('\n');
    assert.deepEqual(lines(checkNoHtmlApis('js/core/x.js', src)), [4, 5, 6, 7]);
  });

  test('icons.js is allowed', () => {
    assert.deepEqual(checkNoHtmlApis('js/ui/icons.js', 'el.innerHTML = svgText;'), []);
  });
});

describe('relative-url', () => {
  test('js: fetch, import, URL, href/src, setAttribute, url()', () => {
    const src = [
      "fetch('/data/index.json');",
      "fetch('data/index.json');",
      "import x from '/js/x.js';",
      "const m = import('/js/y.js');",
      "new URL('/sw.js', location.href);",
      "a.href = '/settings';",
      "h('img', { src: '/icons/a.png' });",
      "img.setAttribute('src', '/icons/b.png');",
      "h('a', { href: '#/library' });",
      "navigate('/quiz/1');",
      "const css = 'background: url(/img/c.png)';",
      "// fetch('/commented');",
      "const text = 'call fetch(\"/x\") later';",
    ].join('\n');
    assert.deepEqual(lines(checkRelativeUrls('js/a.js', src, 'js')), [1, 3, 4, 5, 6, 7, 8, 11]);
  });

  test('css: url() and @import', () => {
    const css = "@import '/x.css';\na { background: url(/a.png) }\nb { background: url('img/b.png') }\n/* url(/c.png) */";
    assert.deepEqual(lines(checkRelativeUrls('css/a.css', css, 'css')), [1, 2]);
  });

  test('html attributes', () => {
    const html = '<link href="/css/a.css">\n<script src="js/app.js"></script>\n<img src=/x.png>\n<a href="#/x">';
    assert.deepEqual(lines(checkRelativeUrls('index.html', html, 'html')), [1, 3]);
  });
});

describe('no-console-log', () => {
  test('flags console.log in code, not in strings or comments', () => {
    const src = "console.log(1);\nconsole.warn(2);\n// console.log(3)\nconst s = 'console.log';\nconsole . log(4);";
    assert.deepEqual(lines(checkNoConsoleLog('sw.js', src)), [1, 5]);
  });
});

describe('module-header', () => {
  test('requires a first block comment with @module', () => {
    assert.deepEqual(checkModuleHeader('js/a.js', '/**\n * Thing.\n * @module a\n */\nexport const x = 1;'), []);
    assert.deepEqual(checkModuleHeader('js/a.js', '\n/* @module a */'), []);
    assert.equal(checkModuleHeader('js/a.js', 'export const x = 1;').length, 1);
    assert.equal(checkModuleHeader('js/a.js', '/** No tag. */\n/** @module a */').length, 1);
    assert.equal(checkModuleHeader('js/a.js', '// @module a\n').length, 1);
  });
});

describe('app-shell', () => {
  const sw = "const VERSION = '1';\nconst APP_SHELL = [\n  './',\n  'index.html',\n  'js/a.js',\n  // 'js/old.js',\n  'css/b.css',\n];\nconst OTHER = ['js/x.js'];";

  test('parseAppShell reads entries with lines, skips comments', () => {
    const shell = parseAppShell(sw);
    assert.ok(shell);
    assert.deepEqual(shell.entries, [
      { path: './', line: 3 },
      { path: 'index.html', line: 4 },
      { path: 'js/a.js', line: 5 },
      { path: 'css/b.css', line: 7 },
    ]);
    assert.equal(parseAppShell('const X = [];'), null);
  });

  test('missing entries warn; unlisted app files are errors', () => {
    const shell = /** @type {NonNullable<ReturnType<typeof parseAppShell>>} */ (parseAppShell(sw));
    const onDisk = new Set(['index.html', 'js/a.js', 'js/new.js']);
    const out = checkAppShell(shell.entries, ['js/a.js', 'js/new.js'], (rel) => onDisk.has(rel));
    assert.deepEqual(
      out.map((f) => [f.file, f.line, f.level]),
      [
        ['sw.js', 7, 'warn'],
        ['js/new.js', 1, 'error'],
      ],
    );
  });
});

describe('splitHtml', () => {
  test('inline scripts and styles with offsets; src scripts and comments skipped', () => {
    const html = '<!-- <script>bad()</script> -->\n<style>a{--x:1}</style>\n<script src="a.js"></script>\n<script type="module">\nimport a from "./b.js";\n</script>';
    const { scripts, styles, markup } = splitHtml(html);
    assert.equal(styles.length, 1);
    assert.equal(styles[0].text, 'a{--x:1}');
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0].module);
    assert.equal(html.slice(scripts[0].start, scripts[0].start + 7), '\nimport');
    assert.ok(!markup.includes('import a'));
    assert.equal(markup.length, html.length);
  });
});

describe('formatFinding and parseArgs', () => {
  test('format', () => {
    assert.equal(formatFinding({ file: 'a.js', line: 3, level: 'error', rule: 'r', message: 'm' }), 'a.js:3: m [r]');
    assert.equal(formatFinding({ file: 'a.js', line: 3, level: 'warn', rule: 'r', message: 'm' }), 'a.js:3: warning: m [r]');
  });

  test('args', () => {
    assert.deepEqual(parseArgs(['--quiet', '--strict']).quiet, true);
    assert.equal(parseArgs(['--root=/tmp/x']).root, path.resolve('/tmp/x'));
    assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  });
});

describe('lintRepo end to end', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lint-test-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (/** @type {string} */ rel, /** @type {string} */ text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };

  test('clean checkout passes; each problem is reported', () => {
    write('index.html', '<!doctype html><link rel="stylesheet" href="css/a.css"><script type="module" src="js/app.js"></script>');
    write('css/a.css', ':root { --gap: 4px; }\n.x { margin: var(--gap); padding: var(--set-from-js); }');
    write('js/app.js', "/** App. @module app */\nimport { gap } from './lib.js';\nexport const x = gap;\n");
    write('js/lib.js', "/** Lib. @module lib */\nexport const gap = 1;\nexport function setIt(el) { el.style.setProperty('--set-from-js', '1px'); }\n");
    write('sw.js', "const APP_SHELL = [\n  './',\n  'index.html',\n  'css/a.css',\n  'js/app.js',\n  'js/lib.js',\n];\n");
    let out = [];
    assert.equal(main(['--root', dir], { log: (s) => out.push(s) }), 0);
    assert.match(out.at(-1) ?? '', /0 error\(s\), 0 warning\(s\) → OK/);

    write('js/bad.js', "export const y = 1;\nconsole.log(y);\nfetch('/x.json');\ndocument.body.innerHTML = '';\nimport { nope } from './lib.js';\n");
    write('css/a.css', '.x { margin: var(--undefined-var); }\n');
    write('tests/fixtures/g.html', "<script type=\"module\">\nimport { gap } from '../../js/lib.js';\nimport { missing } from '../../js/lib.js';\n</script>\n");
    const { findings } = lintRepo({ root: dir });
    const got = findings.map((f) => `${f.file}:${f.line}:${f.rule}:${f.level}`);
    assert.deepEqual(got, [
      'css/a.css:1:css-var:error',
      'js/bad.js:1:module-header:error',
      'js/bad.js:1:app-shell:error',
      'js/bad.js:2:no-console-log:error',
      'js/bad.js:3:relative-url:error',
      'js/bad.js:4:no-html:error',
      'js/bad.js:5:imports:error',
      'tests/fixtures/g.html:3:imports:error',
    ].sort((a, b) => {
      const [fa, la] = a.split(':');
      const [fb, lb] = b.split(':');
      return fa === fb ? Number(la) - Number(lb) : fa < fb ? -1 : 1;
    }));
    out = [];
    assert.equal(main(['--root', dir, '--quiet'], { log: (s) => out.push(s) }), 1);
    assert.ok(out.some((l) => l.startsWith('js/bad.js:2: console.log is not allowed')));
  });
});
