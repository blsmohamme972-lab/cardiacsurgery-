// Unit tests for js/features/explain/inline.js (inline mini-markup parser). Run: node --test tests/unit/*.test.mjs
//
// Table-driven: every rule of docs/ARCHITECTURE.md §3.5 has positive and
// negative cases. Then: every string in data/demo.json, seeded property tests
// (random input never breaks the parser, escaping round-trips, generated
// well-formed markup parses back to the tree it came from) and timing limits.
// Fixtures use neutral placeholder text only.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseInline, inlineToPlain, MAX_NESTING } from '../../js/features/explain/inline.js';

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/** @param {string} v */
const T = (v) => ({ t: 'text', v });
/** @param {string} v */
const A = (v) => ({ t: 'arrow', v });
/** Strings become text tokens. */
const kids = (/** @type {any[]} */ c) => c.map((x) => (typeof x === 'string' ? T(x) : x));
const node = (/** @type {string} */ t) => (/** @type {any[]} */ ...c) => ({ t, c: kids(c) });
const S = node('strong');
const E = node('em');
const M = node('mark');
const SUP = node('sup');
const SUB = node('sub');
/** @param {string} v */
const C = (v) => ({ t: 'code', c: [T(v)] });

const CONTAINERS = new Set(['strong', 'em', 'mark', 'sup', 'sub', 'code']);
const ARROW_CHARS = new Set(['→', '←', '↔', '⇒', '⇔', '↑', '↓']);

/**
 * Checks the structural contract of a token list; returns the nesting depth
 * of strong/em/mark tokens.
 * @param {any[]} tokens
 * @param {string} [ctx]
 * @returns {number}
 */
function checkTokens(tokens, ctx = 'root') {
  assert.ok(Array.isArray(tokens), `${ctx}: tokens must be an array`);
  let depth = 0;
  tokens.forEach((tok, i) => {
    assert.equal(typeof tok, 'object', `${ctx}[${i}] is an object`);
    if (tok.t === 'text') {
      assert.deepEqual(Object.keys(tok).sort(), ['t', 'v'], `${ctx}[${i}] text keys`);
      assert.equal(typeof tok.v, 'string');
      assert.notEqual(tok.v, '', `${ctx}[${i}] text is not empty`);
      if (i > 0) assert.notEqual(tokens[i - 1].t, 'text', `${ctx}[${i}] adjacent text tokens are merged`);
    } else if (tok.t === 'arrow') {
      assert.deepEqual(Object.keys(tok).sort(), ['t', 'v'], `${ctx}[${i}] arrow keys`);
      assert.ok(ARROW_CHARS.has(tok.v), `${ctx}[${i}] arrow value ${JSON.stringify(tok.v)}`);
    } else {
      assert.ok(CONTAINERS.has(tok.t), `${ctx}[${i}] unknown token type ${JSON.stringify(tok.t)}`);
      assert.deepEqual(Object.keys(tok).sort(), ['c', 't'], `${ctx}[${i}] container keys`);
      assert.ok(tok.c.length > 0, `${ctx}[${i}] container is not empty`);
      if (tok.t === 'code') {
        assert.equal(tok.c.length, 1, `${ctx}[${i}] code has one child`);
        assert.equal(tok.c[0].t, 'text', `${ctx}[${i}] code child is text`);
      }
      if (tok.t === 'sup' || tok.t === 'sub') {
        for (const k of tok.c) {
          assert.ok(k.t === 'text' || k.t === 'arrow', `${ctx}[${i}] ${tok.t} holds text and arrows only`);
          if (k.t === 'text') assert.ok(!/\s/.test(k.v), `${ctx}[${i}] ${tok.t} has no whitespace`);
        }
      }
      const inner = checkTokens(tok.c, `${ctx}[${i}].${tok.t}`);
      const own = tok.t === 'strong' || tok.t === 'em' || tok.t === 'mark' ? 1 : 0;
      depth = Math.max(depth, inner + own);
    }
  });
  return depth;
}

/** Visible text of a token list. @param {any[]} tokens @returns {string} */
function plainOf(tokens) {
  return tokens.map((t) => (t.c ? plainOf(t.c) : t.v)).join('');
}

/** Backslash-escapes every escapable character. @param {string} s */
function escapeAll(s) {
  return s.replace(/[\\*_=^~`<>-]/g, '\\$&');
}

/**
 * Small seeded PRNG (mulberry32) so property tests are reproducible.
 * @param {number} seed
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @template X @param {() => number} rand @param {X[]} arr @returns {X} */
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

/**
 * Registers one test per [input, expected tokens] row.
 * @param {Array<[string, any[]]>} rows
 */
function table(rows) {
  for (const [input, expected] of rows) {
    test(JSON.stringify(input), () => {
      const tokens = parseInline(input);
      assert.deepEqual(tokens, kids(expected));
      checkTokens(tokens);
      assert.equal(inlineToPlain(input), plainOf(tokens), 'inlineToPlain matches the tokens');
    });
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe('API basics', () => {
  test('empty string gives no tokens', () => {
    assert.deepEqual(parseInline(''), []);
    assert.equal(inlineToPlain(''), '');
  });

  test('non-strings give [] and \'\' (never throw)', () => {
    for (const v of [undefined, null, 0, 42, NaN, true, false, {}, [], ['**a**'], () => '**a**', Symbol('s'), 10n]) {
      assert.deepEqual(parseInline(v), [], String(typeof v));
      assert.equal(inlineToPlain(v), '', String(typeof v));
    }
  });

  test('plain text is returned as one token, unchanged', () => {
    const s = '  Sample stem one,\twith  spaces\nand a new line. ';
    assert.deepEqual(parseInline(s), [T(s)]);
    assert.equal(inlineToPlain(s), s);
  });

  test('every call returns a fresh tree', () => {
    const a = parseInline('**Choice A text** -> b');
    const b = parseInline('**Choice A text** -> b');
    assert.notEqual(a, b);
    assert.notEqual(a[0], b[0]);
    a[0].c[0].v = 'changed';
    a.push(T('extra'));
    assert.deepEqual(parseInline('**Choice A text** -> b'), b);
  });

  test('MAX_NESTING is a small positive integer', () => {
    assert.ok(Number.isInteger(MAX_NESTING) && MAX_NESTING >= 3 && MAX_NESTING <= 16);
  });

  describe('characters that are never markup on their own', () => {
    table([
      ['<b>not html</b>', ['<b>not html</b>']],
      ['a > b and c < d', ['a > b and c < d']],
      ['a - b - c', ['a - b - c']],
      ['5 * 3 = 15', ['5 * 3 = 15']],
      ['p < 0.05*', ['p < 0.05*']],
      ['a = b; c >= d; e <= f', ['a = b; c >= d; e <= f']],
      ['Topic A / Topic B (option)', ['Topic A / Topic B (option)']],
      ['&lt;script&gt;', ['&lt;script&gt;']],
    ]);
  });
});

describe('**strong**', () => {
  table([
    ['**Bold**', [S('Bold')]],
    ['a **b** c', ['a ', S('b'), ' c']],
    ['**two words**', [S('two words')]],
    ['**a** and **b**', [S('a'), ' and ', S('b')]],
    ['x**y**z', ['x', S('y'), 'z']],
    ['**a**b**c**', [S('a'), 'b', S('c')]],
    ['**a\nb**', [S('a\nb')]],
    ['**B**ookmark', [S('B'), 'ookmark']],
    ['("**quoted**")', ['("', S('quoted'), '")']],
    // flanking: opener needs a non-space after it, closer a non-space before it
    ['a ** b', ['a ** b']],
    ['a ** b **', ['a ** b **']],
    ['** a**', ['** a**']],
    ['**a **', ['**a **']],
    ['2 ** 3', ['2 ** 3']],
    // unclosed / unopened
    ['**a', ['**a']],
    ['a**', ['a**']],
    ['**a **b', ['**a **b']],
    // only a run of exactly two asterisks is a marker
    ['*a*', ['*a*']],
    ['***a***', ['***a***']],
    ['****', ['****']],
    ['**a****b**', [S('a****b')]],
    ['**\\*\\***', [S('**')]],
  ]);
});

describe('_em_ (word boundaries)', () => {
  table([
    ['_Finish_', [E('Finish')]],
    ['tap _Finish_.', ['tap ', E('Finish'), '.']],
    ['(_a_)', ['(', E('a'), ')']],
    ['_two words_', [E('two words')]],
    ['"_quoted_"', ['"', E('quoted'), '"']],
    ['_é_', [E('é')]],
    // inside words: literal
    ['snake_case_words', ['snake_case_words']],
    ['file_1_2', ['file_1_2']],
    ['x_1_', ['x_1_']],
    ['1_a_', ['1_a_']],
    ['café_x_', ['café_x_']],
    ['Ω_x_ y', ['Ω_x_ y']],
    ['_a_b', ['_a_b']],
    ['a_b_', ['a_b_']],
    ['x _y_z', ['x _y_z']],
    ['https://example.com/some_path_here?a_b=c_d', ['https://example.com/some_path_here?a_b=c_d']],
    // underscores inside an em span stay literal
    ['_a_b_', [E('a_b')]],
    ['see _snake_case_ here', ['see ', E('snake_case'), ' here']],
    // runs of underscores (blanks, dunders) are literal
    ['____', ['____']],
    ['The ___ placeholder', ['The ___ placeholder']],
    ['__init__', ['__init__']],
    ['__a__', ['__a__']],
    // flanking and unclosed
    ['_ a_', ['_ a_']],
    ['_a _', ['_a _']],
    ['_a', ['_a']],
    ['a_', ['a_']],
    ['a _ b _ c', ['a _ b _ c']],
  ]);
});

describe('==mark==', () => {
  table([
    ['==key==', [M('key')]],
    ['the ==key point== here', ['the ', M('key point'), ' here']],
    ['a==b==c', ['a', M('b'), 'c']],
    ['a == b', ['a == b']],
    ['x = y', ['x = y']],
    ['==a', ['==a']],
    ['a==', ['a==']],
    ['== a==', ['== a==']],
    ['==a ==', ['==a ==']],
    ['===a===', ['===a===']],
    ['====', ['====']],
  ]);
});

describe('^sup^ and ~sub~', () => {
  table([
    ['x^2^', ['x', SUP('2')]],
    ['1^st^ time', ['1', SUP('st'), ' time']],
    ['Na^+^', ['Na', SUP('+')]],
    ['^99m^Tc', [SUP('99m'), 'Tc']],
    ['10^-3^', ['10', SUP('-3')]],
    ['CO~2~', ['CO', SUB('2')]],
    ['~2~', [SUB('2')]],
    ['x~1~, y~1~', ['x', SUB('1'), ', y', SUB('1')]],
    ['HCO~3~^-^', ['HCO', SUB('3'), SUP('-')]],
    ['P~a~O~2~', ['P', SUB('a'), 'O', SUB('2')]],
    ['a^b^c^d', ['a', SUP('b'), 'c^d']],
    // content must be non-empty and contain no whitespace
    ['~5 mm to ~10 mm', ['~5 mm to ~10 mm']],
    ['5 ~ 10', ['5 ~ 10']],
    ['x^2 3^', ['x^2 3^']],
    ['x^ 2^', ['x^ 2^']],
    ['x^2 ^', ['x^2 ^']],
    ['x^a\u00a0b^', ['x^a\u00a0b^']],
    ['x~a\nb~', ['x~a\nb~']],
    ['x^^', ['x^^']],
    // unclosed
    ['~5', ['~5']],
    ['x^2', ['x^2']],
    // only single markers count
    ['~~strike~~', ['~~strike~~']],
    ['^^a^^', ['^^a^^']],
    ['x^a^^', ['x^a^^']],
    // a closer inside one word closes (escape it when it means "about")
    ['range ~5-~10', ['range ', SUB('5-'), '10']],
    ['range ~5-\\~10', ['range ~5-~10']],
    // content is plain text plus arrows: other markers are literal
    ['x^**2**^', ['x', SUP('**2**')]],
    ['x~_i_~', ['x', SUB('_i_')]],
    ['x^`a`^', ['x', SUP('`a`')]],
    ['x^==a==^', ['x', SUP('==a==')]],
    ['x~a^b~', ['x', SUB('a^b')]],
    ['x^->^', ['x', SUP(A('→'))]],
    ['T~1↓~', ['T', SUB('1', A('↓'))]],
    ['x^a<->b^', ['x', SUP('a', A('↔'), 'b')]],
    ['x^a\\^b^', ['x', SUP('a^b')]],
    ['x^a\\ b^', ['x^a\\ b^']],
  ]);
});

describe('`code`', () => {
  table([
    ['`code`', [C('code')]],
    ['press `D` now', ['press ', C('D'), ' now']],
    ['a`b`c', ['a', C('b'), 'c']],
    ['`a` b `c`', [C('a'), ' b ', C('c')]],
    ['`x = 0.5`', [C('x = 0.5')]],
    // content is literal: no markup, no arrows
    ['`a **b** _c_ ==d== x^2^ CO~2~`', [C('a **b** _c_ ==d== x^2^ CO~2~')]],
    ['`->` and `→`', [C('->'), ' and ', C('→')]],
    ['`<-5 <-> =>`', [C('<-5 <-> =>')]],
    // escapes still apply inside code
    ['`a\\`b`', [C('a`b')]],
    ['`a\\\\`', [C('a\\')]],
    ['`a\\*b`', [C('a*b')]],
    ['`C:\\Users`', [C('C:\\Users')]],
    // flanking, unclosed, runs
    ['` a`', ['` a`']],
    ['`a `', ['`a `']],
    ['`a ` b`', [C('a ` b')]],
    ['`a', ['`a']],
    ['a`', ['a`']],
    ['``a``', ['``a``']],
    ['`a``b`', [C('a``b')]],
    // code binds before strong/em/mark
    ['**a `b** c`', ['**a ', C('b** c')]],
    ['_a `b_ c`', ['_a ', C('b_ c')]],
    ['**`x`**', [S(C('x'))]],
    ['==`x` y==', [M(C('x'), ' y')]],
  ]);
});

describe('arrows', () => {
  table([
    ['a -> b', ['a ', A('→'), ' b']],
    ['a <- b', ['a ', A('←'), ' b']],
    ['a <-> b', ['a ', A('↔'), ' b']],
    ['a => b', ['a ', A('⇒'), ' b']],
    ['a <=> b', ['a ', A('⇔'), ' b']],
    ['a->b', ['a', A('→'), 'b']],
    ['->->', [A('→'), A('→')]],
    ['<->', [A('↔')]],
    ['<=>', [A('⇔')]],
    ['<->5', [A('↔'), '5']],
    ['=>5', [A('⇒'), '5']],
    ['5->10', ['5', A('→'), '10']],
    // typed arrow characters are arrow tokens too
    ['↑ ↓ → ←', [A('↑'), ' ', A('↓'), ' ', A('→'), ' ', A('←')]],
    ['↔ ⇒ ⇔', [A('↔'), ' ', A('⇒'), ' ', A('⇔')]],
    ['HR↑', ['HR', A('↑')]],
    // a `-` or `=` inside a longer run is not an arrow
    ['-->', ['-->']],
    ['--->', ['--->']],
    ['<--', ['<--']],
    ['<-->', ['<-->']],
    ['a ==> b', ['a ==> b']],
    ['<==', ['<==']],
    // `<-` before a digit means "less than minus"
    ['<-5', ['<-5']],
    ['x <-0.5', ['x <-0.5']],
    ['<- 5', [A('←'), ' 5']],
    // not arrows
    ['<=', ['<=']],
    ['>=', ['>=']],
    ['>-', ['>-']],
    ['- >', ['- >']],
    ['< -', ['< -']],
    ['= >', ['= >']],
    ['=<', ['=<']],
    // escaped characters never form an arrow
    ['\\->', ['->']],
    ['-\\>', ['->']],
    ['<\\-', ['<-']],
    ['\\<-', ['<-']],
    ['\\=>', ['=>']],
    ['=\\>', ['=>']],
    ['<=\\>', ['<=>']],
    ['\\<->', ['<', A('→')]],
    ['<\\->', ['<->']],
    ['\\→', ['\\', A('→')]],
    // arrows inside and between other tokens
    ['**a -> b**', [S('a ', A('→'), ' b')]],
    ['_x_->_y_', [E('x'), A('→'), E('y')]],
    ['==a=>b==', [M('a', A('⇒'), 'b')]],
    ['**->**', [S(A('→'))]],
    ['a=>==b==', ['a', A('⇒'), M('b')]],
  ]);
});

describe('backslash escapes', () => {
  table([
    ['\\*', ['*']],
    ['\\_', ['_']],
    ['\\=', ['=']],
    ['\\^', ['^']],
    ['\\~', ['~']],
    ['\\`', ['`']],
    ['\\\\', ['\\']],
    ['\\-', ['-']],
    ['\\<', ['<']],
    ['\\>', ['>']],
    ['\\*\\*not bold\\*\\*', ['**not bold**']],
    ['\\**not bold**', ['**not bold**']],
    ['\\_not em\\_', ['_not em_']],
    ['\\==not mark\\==', ['==not mark==']],
    ['x\\^2\\^', ['x^2^']],
    ['CO\\~2\\~', ['CO~2~']],
    ['\\`not code\\`', ['`not code`']],
    ['**a\\**', ['**a**']],
    // a backslash before any other character is kept
    ['a\\b', ['a\\b']],
    ['\\n and \\t', ['\\n and \\t']],
    ['C:\\Data', ['C:\\Data']],
    ['end\\', ['end\\']],
    ['\\', ['\\']],
    ['\\ ', ['\\ ']],
    // an escaped backslash does not escape what follows
    ['\\\\**a**', ['\\', S('a')]],
    ['\\\\\\*', ['\\*']],
    ['\\\\\\\\', ['\\\\']],
    ['a\\*b', ['a*b']],
  ]);
});

describe('nesting and precedence', () => {
  table([
    ['**bold _em_ text**', [S('bold ', E('em'), ' text')]],
    ['_em **bold** text_', [E('em ', S('bold'), ' text')]],
    ['==**key** point==', [M(S('key'), ' point')]],
    ['**_both_**', [S(E('both'))]],
    ['_**both**_', [E(S('both'))]],
    ['==_**all**_==', [M(E(S('all')))]],
    ['**==a==**', [S(M('a'))]],
    ['**a ==b _c_ d== e**', [S('a ', M('b ', E('c'), ' d'), ' e')]],
    ['**PaCO~2~**', [S('PaCO', SUB('2'))]],
    ['==10^9^/L==', [M('10', SUP('9'), '/L')]],
    ['_T~1/2~_', [E('T', SUB('1/2'))]],
    // same kind nests too
    ['**a **b** c**', [S('a ', S('b'), ' c')]],
    ['_a _b_ c_', [E('a ', E('b'), ' c')]],
    // crossing pairs: the first closed pair wins, the rest is literal
    ['**a _b** c_', [S('a _b'), ' c_']],
    ['_a **b_ c**', [E('a **b'), ' c**']],
    ['==a **b== c**', [M('a **b'), ' c**']],
    ['**a ==b _c** d== e_', [S('a ==b _c'), ' d== e_']],
    // unclosed inner or outer markers
    ['**a _b c**', [S('a _b c')]],
    ['**a _b_ c', ['**a ', E('b'), ' c']],
    ['_a **b** c', ['_a ', S('b'), ' c']],
    ['**a** **b', [S('a'), ' **b']],
  ]);

  test(`nesting deeper than MAX_NESTING (${MAX_NESTING}) renders the inner markers literally`, () => {
    const extra = 2;
    const levels = MAX_NESTING + extra;
    const input = '**a '.repeat(levels) + 'x' + ' b**'.repeat(levels);
    const tokens = parseInline(input);
    assert.equal(checkTokens(tokens), MAX_NESTING);
    const expectedPlain =
      'a '.repeat(MAX_NESTING) + '**a '.repeat(extra) + 'x' + ' b**'.repeat(extra) + ' b'.repeat(MAX_NESTING);
    assert.equal(inlineToPlain(input), expectedPlain);
    assert.equal(plainOf(tokens), expectedPlain);
  });

  test('very deep nesting never overflows the stack', () => {
    const levels = 20000;
    const input = '**a _b ==c '.repeat(levels) + 'x' + ' c== b_ a**'.repeat(levels);
    let tokens;
    assert.doesNotThrow(() => {
      tokens = parseInline(input);
    });
    assert.ok(checkTokens(/** @type {any} */ (tokens)) <= MAX_NESTING);
    assert.doesNotThrow(() => inlineToPlain(input));
  });
});

describe('text merging and Unicode', () => {
  table([
    ['a\\*b', ['a*b']],
    ['**a', ['**a']],
    ['a _b c', ['a _b c']],
    ['**a _b** c', [S('a _b'), ' c']],
    ['x ** y ** z', ['x ** y ** z']],
    ['😀**a**😀', ['😀', S('a'), '😀']],
    ['_😀_', [E('😀')]],
    ['x^😀^', ['x', SUP('😀')]],
    ['\ud800**a**\udc00', ['\ud800', S('a'), '\udc00']],
    ['\u0000**a**', ['\u0000', S('a')]],
    ['日本_語_', ['日本_語_']],
    ['日本 _語_', ['日本 ', E('語')]],
    // letters outside the BMP (surrogate pairs) count as word characters
    ['𝑥_a_', ['𝑥_a_']],
    ['_a_𝑥', ['_a_𝑥']],
    ['𝑥 _a_ 𝑥', ['𝑥 ', E('a'), ' 𝑥']],
    ['😀_a_', ['😀', E('a')]],
    ['a\udc00_x_', ['a\udc00', E('x')]],
    ['_x_\ud800b', [E('x'), '\ud800b']],
    ['\\*😀\\*', ['*😀*']],
    ['**😀**', [S('😀')]],
    ['`😀`', [C('😀')]],
  ]);
});

describe('inlineToPlain', () => {
  const rows = [
    ['**Key** -> CO~2~', 'Key → CO2'],
    ['_Settings_ -> _Data_', 'Settings → Data'],
    ['==a== <=> b', 'a ⇔ b'],
    ['x^2^ + y~i~', 'x2 + yi'],
    ['`**raw**`', '**raw**'],
    ['\\*\\*', '**'],
    ['snake_case', 'snake_case'],
    ['a <- b <-> c => d', 'a ← b ↔ c ⇒ d'],
    ['HR ↑, BP ↓', 'HR ↑, BP ↓'],
    ['  keep   spaces\n', '  keep   spaces\n'],
    ['**a _b** c_', 'a _b c_'],
    ['<-5 and -->', '<-5 and -->'],
    ['Sample stem one', 'Sample stem one'],
  ];
  for (const [input, expected] of rows) {
    test(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      assert.equal(inlineToPlain(input), expected);
    });
  }

  test('a string without markup characters is returned as is', () => {
    const s = 'Choice A text (option 1), 50% [note] {x} | y.';
    assert.equal(inlineToPlain(s), s);
  });
});

// ---------------------------------------------------------------------------
// Real data
// ---------------------------------------------------------------------------

describe('data/demo.json', async () => {
  const demo = JSON.parse(await readFile(new URL('../../data/demo.json', import.meta.url), 'utf8'));
  /** @type {string[]} */
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(demo);

  test('has strings with markup to check', () => {
    assert.ok(strings.length > 100);
    assert.ok(strings.some((s) => s.includes('**')));
  });

  test('every string parses into valid tokens', () => {
    for (const s of strings) {
      const tokens = parseInline(s);
      checkTokens(tokens, JSON.stringify(s));
      assert.equal(inlineToPlain(s), plainOf(tokens), JSON.stringify(s));
    }
  });

  test('plain text never keeps markers of balanced markup', () => {
    for (const s of strings) {
      const plain = inlineToPlain(s);
      for (const marker of ['**', '==', '`', '^', '~', '->', '<-', '=>', '\\']) {
        assert.ok(!plain.includes(marker), `${JSON.stringify(marker)} left in ${JSON.stringify(plain)}`);
      }
      assert.ok(!/(^|[^\p{L}\p{N}])_\S/u.test(plain), `_ left in ${JSON.stringify(plain)}`);
    }
  });

  test('uses every token type at least once', () => {
    /** @type {Set<string>} */
    const seen = new Set();
    const visit = (/** @type {any[]} */ tokens) => {
      for (const t of tokens) {
        seen.add(t.t);
        if (t.c) visit(t.c);
      }
    };
    strings.forEach((s) => visit(parseInline(s)));
    for (const t of ['text', 'arrow', 'strong', 'em', 'mark', 'sup', 'sub', 'code']) assert.ok(seen.has(t), t);
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('properties', () => {
  const ALPHABET = [
    ...['*', '**', '_', '=', '==', '^', '~', '`', '\\', '-', '>', '<'],
    ...['a', 'b', '1', ' ', '\n', '→', '↑', 'é', '😀', '\u00a0'],
  ];

  test('every string of up to 4 symbols parses without breaking the contract', () => {
    const symbols = ['*', '_', '=', '^', '~', '`', '\\', '-', '<', '>', 'a', ' ', '→'];
    /** @param {string} s */
    const check = (s) => {
      const tokens = parseInline(s);
      checkTokens(tokens, JSON.stringify(s));
      const plain = inlineToPlain(s);
      assert.equal(plain, plainOf(tokens), JSON.stringify(s));
      assert.ok(plain.length <= s.length, JSON.stringify(s));
    };
    /** @param {string} prefix @param {number} left */
    const all = (prefix, left) => {
      if (prefix) check(prefix);
      if (left === 0) return;
      for (const c of symbols) all(prefix + c, left - 1);
    };
    all('', 4);
  });

  test('random strings: valid tokens, plain text never longer than the input', () => {
    const rand = rng(20261026);
    for (let n = 0; n < 4000; n++) {
      let s = '';
      const len = 1 + Math.floor(rand() * 40);
      for (let i = 0; i < len; i++) s += pick(rand, ALPHABET);
      const tokens = parseInline(s);
      checkTokens(tokens, JSON.stringify(s));
      const plain = inlineToPlain(s);
      assert.equal(plain, plainOf(tokens), JSON.stringify(s));
      assert.ok(plain.length <= s.length, JSON.stringify(s));
    }
  });

  test('escaping every markup character always gives back the exact text', () => {
    const rand = rng(7);
    for (let n = 0; n < 3000; n++) {
      let s = '';
      const len = Math.floor(rand() * 30);
      for (let i = 0; i < len; i++) s += pick(rand, ALPHABET);
      const escaped = escapeAll(s);
      const tokens = parseInline(escaped);
      for (const t of tokens) assert.ok(t.t === 'text' || t.t === 'arrow', JSON.stringify(s));
      assert.equal(inlineToPlain(escaped), s, JSON.stringify(s));
    }
  });

  test('generated well-formed markup parses back to its tree', () => {
    const rand = rng(1234);
    const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'one', 'two', 'x1', 'Topic'];
    const LETTERS = ['a', 'b', 'c', 'n', 'x'];
    const ARROWS = [
      ['->', '→'],
      ['<-', '←'],
      ['<->', '↔'],
      ['=>', '⇒'],
      ['<=>', '⇔'],
      ['↑', '↑'],
      ['↓', '↓'],
    ];
    const CODE_CHARS = ['a', 'b', '*', '_', '=', '^', '~', '-', '>', '<', ' ', '1', '→'];

    /**
     * One piece of markup and its expected tokens.
     * @param {number} depth
     * @returns {{ src: string, tokens: any[] }}
     */
    const piece = (depth) => {
      const r = rand();
      if (r < 0.3 || depth >= 3) {
        const w = pick(rand, WORDS);
        return { src: w, tokens: [T(w)] };
      }
      if (r < 0.4) {
        const [src, v] = pick(rand, ARROWS);
        return { src, tokens: [A(v)] };
      }
      if (r < 0.5) {
        const w = pick(rand, WORDS);
        const kind = rand() < 0.5 ? 'sup' : 'sub';
        const mark = kind === 'sup' ? '^' : '~';
        let src = pick(rand, LETTERS);
        const inner = [T(src)];
        if (rand() < 0.4) {
          const [a, v] = pick(rand, ARROWS);
          const tail = pick(rand, LETTERS);
          src += a + tail;
          inner.push(A(v), T(tail));
        }
        return { src: `${w}${mark}${src}${mark}`, tokens: [T(w), { t: kind, c: inner }] };
      }
      if (r < 0.6) {
        let content = pick(rand, ['a', 'b', '1']);
        const len = Math.floor(rand() * 6);
        for (let i = 0; i < len; i++) content += pick(rand, CODE_CHARS);
        content += pick(rand, ['a', 'b', '1']);
        return { src: `\`${content}\``, tokens: [C(content)] };
      }
      const [type, mark] = pick(rand, [
        ['strong', '**'],
        ['em', '_'],
        ['mark', '=='],
      ]);
      const inner = sequence(depth + 1, true);
      return { src: `${mark}${inner.src}${mark}`, tokens: [{ t: type, c: inner.tokens }] };
    };

    /**
     * Pieces joined by spaces. Inside a container it starts and ends with a
     * plain word, so markers never touch markers of the same kind.
     * @param {number} depth
     * @param {boolean} inContainer
     */
    const sequence = (depth, inContainer) => {
      const count = 1 + Math.floor(rand() * 4);
      const parts = [];
      for (let i = 0; i < count; i++) parts.push(piece(depth));
      if (inContainer) {
        const w1 = pick(rand, WORDS);
        const w2 = pick(rand, WORDS);
        parts.unshift({ src: w1, tokens: [T(w1)] });
        parts.push({ src: w2, tokens: [T(w2)] });
      }
      /** @type {any[]} */
      const tokens = [];
      const add = (/** @type {any} */ tok) => {
        const last = tokens[tokens.length - 1];
        if (tok.t === 'text' && last && last.t === 'text') last.v += tok.v;
        else tokens.push(tok.t === 'text' ? { ...tok } : tok);
      };
      parts.forEach((p, i) => {
        if (i > 0) add(T(' '));
        p.tokens.forEach(add);
      });
      return { src: parts.map((p) => p.src).join(' '), tokens };
    };

    for (let n = 0; n < 2000; n++) {
      const { src, tokens } = sequence(0, false);
      assert.deepEqual(parseInline(src), tokens, src);
      assert.equal(inlineToPlain(src), plainOf(tokens), src);
    }
  });
});

// ---------------------------------------------------------------------------
// Performance (linear time, no catastrophic backtracking)
// ---------------------------------------------------------------------------

describe('performance', () => {
  const SIZE = 50_000;
  const LIMIT_MS = 50;
  /** @param {string} unit */
  const fill = (unit) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);

  /**
   * Best of three runs (after one warm-up) so a busy machine doesn't fail the test.
   * @param {string} s
   */
  const bestTime = (s) => {
    parseInline(s.slice(0, 2000));
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      parseInline(s);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  };

  const inputs = {
    'mixed markers': fill('**a _b ==c ^d ~e `f -> <- <-> => <=> x^2^ CO~2~ `k` \\* ↑ snake_case '),
    'unclosed openers': fill('**a _b ==c '),
    'closers only': fill('a** b_ c== '),
    'crossing pairs': fill('**a _b ==c ').slice(0, SIZE / 2) + fill('d** e_ f== ').slice(0, SIZE / 2),
    'deep nesting': fill('**a _b ==c ').slice(0, SIZE / 2) + fill(' c== b_ a**').slice(0, SIZE / 2),
    'sup/sub without closers': fill('^ab ~cd '),
    'long sup scan': `x^${'a'.repeat(SIZE)}`,
    'many sup/sub': fill('x^a^y~b~'),
    'unclosed code': fill('`a '),
    'many code spans': fill('`a`'),
    'backslashes': fill('\\'),
    'escapes': fill('\\*\\_\\=\\^\\~\\`\\\\\\-\\<\\>'),
    'arrow soup': fill('<-->=><=>-<->=>'),
    'one long run': '*'.repeat(SIZE),
  };

  for (const [name, s] of Object.entries(inputs)) {
    test(`${name}: ${Math.round(s.length / 1000)} KB parses in < ${LIMIT_MS} ms`, () => {
      const ms = bestTime(s);
      assert.ok(ms < LIMIT_MS, `${name} took ${ms.toFixed(1)} ms`);
      checkTokens(parseInline(s));
    });
  }

  test(`inlineToPlain on 50 KB of mixed markers takes < ${LIMIT_MS} ms`, () => {
    const s = inputs['mixed markers'];
    inlineToPlain(s.slice(0, 2000));
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      inlineToPlain(s);
      best = Math.min(best, performance.now() - t0);
    }
    assert.ok(best < LIMIT_MS, `took ${best.toFixed(1)} ms`);
  });
});
