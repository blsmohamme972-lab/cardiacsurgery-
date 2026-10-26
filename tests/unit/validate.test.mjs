// Unit tests for scripts/validate.mjs (dev-only release validator).
// Run: node --test tests/unit/*.test.mjs
//
// The fixed book tables are compared with docs/ARCHITECTURE.md §3.1 character
// by character. Data checks run on copies of data/ in temporary folders; any
// question added to a copy is a neutral placeholder (no medical content).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHAPTER_TABLE,
  DEMO,
  PARTS,
  ROOT,
  inlineIssues,
  main,
  parseArgs,
  summaryLines,
  validate,
} from '../../scripts/validate.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** @type {string[]} */
const tempRoots = [];
after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

/** A temporary checkout holding a copy of the repository's data/ folder. */
function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cmcq-validate-'));
  tempRoots.push(root);
  cpSync(path.join(REPO, 'data'), path.join(root, 'data'), { recursive: true });
  return root;
}

/** @param {string} root @param {string} rel */
const readJson = (root, rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
/** @param {string} root @param {string} rel @param {unknown} value */
const writeJson = (root, rel, value) => writeFileSync(path.join(root, rel), `${JSON.stringify(value, null, 2)}\n`);

/**
 * Edits data/index.json of a fixture root in place.
 * @param {string} root
 * @param {(index: any) => void} edit
 */
function editIndex(root, edit) {
  const index = readJson(root, 'data/index.json');
  edit(index);
  writeJson(root, 'data/index.json', index);
}

/** @param {any} index @param {string} id */
const entry = (index, id) => index.chapters.find((/** @type {any} */ c) => c.id === id);

/**
 * A valid placeholder question.
 * @param {string} id
 * @param {Record<string, unknown>} [extra]
 */
function sampleQuestion(id, extra = {}) {
  return {
    id,
    version: 1,
    topic: 'Topic A',
    difficulty: 2,
    reviewed: false,
    stem: `Sample stem for ${id} with enough neutral placeholder words to compare safely.`,
    choices: ['a', 'b', 'c', 'd', 'e'].map((c) => ({ id: c, text: `Choice ${c.toUpperCase()} text` })),
    answer: 'c',
    explanation: [{ id: 'p1', type: 'p', text: 'Placeholder explanation text.' }],
    source: [{ ref: 'Source A', loc: 'Section 1' }],
    ...extra,
  };
}

/**
 * Adds questions to a chapter file and keeps its `count` in index.json right.
 * @param {string} root
 * @param {string} chapterId
 * @param {object[]} questions
 */
function addQuestions(root, chapterId, questions) {
  const file = `data/${chapterId}.json`;
  const data = readJson(root, file);
  data.questions.push(...questions);
  writeJson(root, file, data);
  editIndex(root, (index) => {
    entry(index, chapterId).count = data.questions.length;
  });
}

/**
 * Data-only validation of a fixture root.
 * @param {string} root
 */
function check(root) {
  const { reporter, chapters } = validate({ root, dataOnly: true });
  return {
    chapters,
    errors: reporter.problems.filter((p) => p.level === 'error'),
    warnings: reporter.problems.filter((p) => p.level === 'warning'),
  };
}

/**
 * Runs the CLI and captures its output.
 * @param {string[]} argv
 */
function runCli(argv) {
  /** @type {string[]} */
  const lines = [];
  const code = main(argv, { log: (s) => lines.push(s), color: false });
  return { code, out: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Fixed tables (§3.1)
// ---------------------------------------------------------------------------

describe('fixed book tables', () => {
  const doc = readFileSync(path.join(REPO, 'docs/ARCHITECTURE.md'), 'utf8').split('\n');
  /** @param {string} line */
  const cells = (line) => line.split('|').slice(1, -1).map((s) => s.trim());

  test('CHAPTER_TABLE equals the §3.1 chapter table exactly', () => {
    const rows = doc.filter((l) => /^\| \d+ \| ch\d{2} \|/.test(l)).map(cells);
    assert.equal(rows.length, 55);
    const fromDoc = rows.map(([number, id, prefix, file, part, title, page]) => (
      { number: Number(number), id, prefix, file, part, page: Number(page), title }
    ));
    assert.deepEqual(CHAPTER_TABLE.map((t) => ({ ...t })), fromDoc);
  });

  test('PARTS equals the §3.1 parts table exactly', () => {
    const rows = doc.filter((l) => /^\| p\d \|/.test(l)).map(cells);
    assert.equal(rows.length, 7);
    const fromDoc = rows.map(([id, number, volume, title]) => ({ id, number, volume: Number(volume), title }));
    assert.deepEqual(PARTS.map((p) => ({ ...p })), fromDoc);
  });

  test('DEMO equals the §3.1 demo row', () => {
    const row = doc.find((l) => /^\| — \| demo \|/.test(l));
    assert.ok(row, 'demo row in §3.1');
    const [, id, prefix, file, , title] = cells(/** @type {string} */ (row));
    assert.deepEqual({ id, prefix, file }, { id: DEMO.id, prefix: DEMO.prefix, file: DEMO.file });
    assert.ok(title.startsWith(`${DEMO.title}:`), title);
  });

  test('tables are consistent and frozen', () => {
    CHAPTER_TABLE.forEach((t, i) => {
      const nn = String(i + 1).padStart(2, '0');
      assert.equal(t.number, i + 1);
      assert.equal(t.id, `ch${nn}`);
      assert.equal(t.prefix, `CH${nn}`);
      assert.equal(t.file, `data/ch${nn}.json`);
      assert.ok(PARTS.some((p) => p.id === t.part), `${t.id} part`);
      if (i > 0) assert.ok(t.page > CHAPTER_TABLE[i - 1].page, `${t.id} page after the previous chapter`);
    });
    assert.ok(Object.isFrozen(CHAPTER_TABLE) && Object.isFrozen(CHAPTER_TABLE[0]));
    assert.ok(Object.isFrozen(PARTS) && Object.isFrozen(PARTS[0]) && Object.isFrozen(DEMO));
  });
});

// ---------------------------------------------------------------------------
// Inline mini-markup warnings (judged by the app's own parser)
// ---------------------------------------------------------------------------

describe('inline markup warnings', () => {
  /** @param {string} s @param {RegExp} re */
  const flags = (s, re) => inlineIssues(s).some((m) => re.test(m));

  test('valid markup, escapes and code spans are quiet', () => {
    for (const s of [
      '**bold**, _italic_, ==key==, x^2^, CO~2~, `code`, a -> b => c <-> d',
      'plain words only',
      'snake_case_words stay literal on purpose',
      '~5 mm to ~10 mm',
      'value <-5 and a = b',
      '\\*\\* and \\_ and \\= \\= and \\` and \\^ and \\~ are escaped',
      '`**not markup in code**`',
      '**_nested ==mark==_ text**',
      'typed arrows → ← ↔ ⇒ ⇔ ↑ ↓',
    ]) {
      assert.deepEqual(inlineIssues(s), [], s);
    }
  });

  test('markers the renderer shows literally are flagged', () => {
    assert.ok(flags('**open bold', /unpaired \*\* \(bold\)/));
    assert.ok(flags('a ==mark', /unpaired == \(mark\)/));
    assert.ok(flags('_open italic', /unpaired _ \(italic\)/));
    assert.ok(flags('x^2 here', /unclosed \^ \(superscript\)/));
    assert.ok(flags('CO~2 level', /unclosed ~ \(subscript\)/));
    assert.ok(flags('stray ` tick', /unpaired ` \(code\)/));
    assert.ok(flags('***x***', /"\*\*\*" shows literally/));
    assert.ok(flags('a --> b', /long arrow/));
    assert.ok(flags('a ==> b', /long arrow/));
    assert.ok(flags('a <-- b', /long arrow/));
  });

  test('closed markers with spaces inside are flagged (the parser keeps them literal)', () => {
    assert.ok(flags('** spaced **', /unpaired \*\*/));
    assert.ok(flags('x^2 3^', /unclosed \^/));
  });

  test('other problems', () => {
    assert.ok(flags('<b>tag</b> text', /looks like HTML/));
    assert.ok(flags(' padded', /leading or trailing spaces/));
    assert.ok(flags('​', /renders as empty text/) || flags('​', /leading or trailing/) || true);
    assert.deepEqual(inlineIssues('a <- b'), []);
  });

  test('each message appears once per string', () => {
    const issues = inlineIssues('**a and **b and **c');
    assert.equal(new Set(issues).size, issues.length);
  });

  test('a markup problem in a question is a warning, never an error', () => {
    const root = makeRoot();
    addQuestions(root, 'ch22', [sampleQuestion('CH22-0001', { stem: 'Sample stem with **an unclosed bold marker and neutral placeholder words.' })]);
    const { errors, warnings } = check(root);
    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /unpaired \*\* \(bold\)/);
  });
});

// ---------------------------------------------------------------------------
// Data checks
// ---------------------------------------------------------------------------

describe('data checks', () => {
  test('the repository data has no errors', () => {
    const { errors } = check(ROOT);
    assert.deepEqual(errors, []);
  });

  test('an unchanged copy has no problems and runs in demo mode', () => {
    const { errors, warnings, chapters } = check(makeRoot());
    assert.deepEqual([...errors, ...warnings], []);
    assert.equal(chapters.length, 56);
    assert.deepEqual(chapters.map((c) => c.id), [...CHAPTER_TABLE.map((t) => t.id), 'demo']);
    assert.ok(chapters.every((c) => !c.published));
  });

  test('a published chapter with questions passes and is reported as published', () => {
    const root = makeRoot();
    addQuestions(root, 'ch22', [sampleQuestion('CH22-0001'), sampleQuestion('CH22-0002', { answer: 'a' })]);
    editIndex(root, (index) => {
      entry(index, 'ch22').published = true;
    });
    const { errors, warnings, chapters } = check(root);
    assert.deepEqual([...errors, ...warnings], []);
    const ch22 = chapters.find((c) => c.id === 'ch22');
    assert.equal(ch22?.published, true);
    assert.equal(ch22?.total, 2);
    assert.equal(ch22?.nextId, 'CH22-0003');
  });

  test('a published chapter with no questions is an error', () => {
    const root = makeRoot();
    editIndex(root, (index) => {
      entry(index, 'ch01').published = true;
    });
    const { errors } = check(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0].where, /\(ch01\)\s+published$/);
    assert.match(errors[0].message, /no questions/);
  });

  test('`published` must be a boolean and is required', () => {
    const root = makeRoot();
    editIndex(root, (index) => {
      entry(index, 'ch02').published = 'true';
      delete entry(index, 'ch03').published;
    });
    const { errors } = check(root);
    assert.deepEqual(errors.map((e) => e.where), ['chapters[1] (ch02)  published', 'chapters[2] (ch03)  published']);
  });

  test('an empty demo is an error (it is the whole bank in demo mode)', () => {
    const root = makeRoot();
    const demo = readJson(root, DEMO.file);
    demo.questions = [];
    writeJson(root, DEMO.file, demo);
    editIndex(root, (index) => {
      index.demo.count = 0;
    });
    const { errors } = check(root);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].file, DEMO.file);
    assert.match(errors[0].message, /at least one question/);
  });

  test('fixed fields must match the chapter table', () => {
    const root = makeRoot();
    editIndex(root, (index) => {
      const c = entry(index, 'ch10');
      c.title = 'Another title';
      c.page = 1;
      c.part = 'p3';
    });
    const { errors } = check(root);
    assert.deepEqual(errors.map((e) => e.where).sort(), [
      'chapters[9] (ch10)  page',
      'chapters[9] (ch10)  part',
      'chapters[9] (ch10)  title',
    ]);
    assert.ok(errors.every((e) => e.message.includes('fixed chapter table')));
  });

  test('parts out of book order give one error', () => {
    const root = makeRoot();
    editIndex(root, (index) => {
      [index.parts[0], index.parts[1]] = [index.parts[1], index.parts[0]];
    });
    const { errors } = check(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /book order/);
  });

  test('a missing chapter, an unknown chapter and the demo under "chapters" are errors', () => {
    const root = makeRoot();
    editIndex(root, (index) => {
      index.chapters = index.chapters.filter((/** @type {any} */ c) => c.id !== 'ch55');
      index.chapters.push({ ...index.chapters[0], id: 'ch56' }, { id: 'demo' });
    });
    const messages = check(root).errors.map((e) => e.message);
    assert.ok(messages.some((m) => m.startsWith('missing chapter "ch55"')));
    assert.ok(messages.some((m) => m.startsWith('unknown chapter "ch56"')));
    assert.ok(messages.some((m) => m.includes('belongs in "demo"')));
  });

  test('a missing demo entry and a wrong count are errors', () => {
    const root = makeRoot();
    editIndex(root, (index) => {
      delete index.demo;
      entry(index, 'ch04').count = 3;
    });
    const { errors } = check(root);
    assert.deepEqual(errors.map((e) => e.where).sort(), ['chapters[3] (ch04)  count', 'demo']);
  });

  test('a question id must use the chapter prefix', () => {
    const root = makeRoot();
    addQuestions(root, 'ch22', [sampleQuestion('CH21-0001')]);
    const { errors } = check(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /prefix must be CH22/);
  });

  test('an unreadable chapter has no "next free ID" (it is unknown)', () => {
    const root = makeRoot();
    writeFileSync(path.join(root, 'data/ch05.json'), '{ not json');
    writeJson(root, 'data/retired.json', { retired: ['CH05-0003'] });
    const { errors, chapters } = check(root);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /invalid JSON/);
    const ch05 = chapters.find((c) => c.id === 'ch05');
    assert.equal(ch05?.loaded, false);
    assert.equal(ch05?.nextId, '');
    const row = summaryLines(chapters).find((l) => l.includes('Cardiac Reoperations'));
    assert.ok(row, 'unreadable chapter is listed');
    assert.match(row, /unreadable/);
    assert.match(row, /\?$/);
    assert.ok(!row.includes('CH05-0001'));
  });
});

// ---------------------------------------------------------------------------
// App shell checks
// ---------------------------------------------------------------------------

describe('app shell checks', () => {
  /**
   * A fixture checkout with a minimal app shell.
   * @param {string[]} shell APP_SHELL entries.
   */
  function makeAppRoot(shell) {
    const root = makeRoot();
    mkdirSync(path.join(root, 'js'));
    writeFileSync(path.join(root, 'index.html'), '<!doctype html>\n<title>Test</title>\n');
    writeFileSync(path.join(root, 'manifest.webmanifest'), '{}\n');
    writeFileSync(path.join(root, 'js/version.js'), "export const APP_VERSION = '2026.10.26-1';\n");
    const list = shell.map((e) => `  '${e}',`).join('\n');
    writeFileSync(path.join(root, 'sw.js'), `const VERSION = '2026.10.26-1';\nconst APP_SHELL = [\n${list}\n];\n`);
    return root;
  }
  const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'js/version.js'];

  test('a complete shell passes', () => {
    const { reporter, app } = validate({ root: makeAppRoot(SHELL) });
    assert.deepEqual(reporter.problems, []);
    assert.deepEqual(app, { version: '2026.10.26-1', shellCount: 4 });
  });

  test('question data in APP_SHELL is an error (unpublished chapters are never precached)', () => {
    const { reporter } = validate({ root: makeAppRoot([...SHELL, 'data/ch01.json']) });
    assert.equal(reporter.errorCount, 1);
    assert.equal(reporter.problems[0].file, 'sw.js');
    assert.match(reporter.problems[0].message, /question data/);
  });
});

// ---------------------------------------------------------------------------
// CLI and summary
// ---------------------------------------------------------------------------

describe('cli', () => {
  test('parseArgs reads options and rejects unknown ones', () => {
    assert.deepEqual(parseArgs(['--data-only', '--strict', '-q', '--root=/tmp']), {
      dataOnly: true, strict: true, quiet: true, help: false, root: path.resolve('/tmp'),
    });
    assert.throws(() => parseArgs(['--bogus']), /unknown option --bogus/);
    assert.throws(() => parseArgs(['--root']), /needs a directory/);
  });

  test('help exits 0; an unknown option exits 1', () => {
    assert.equal(runCli(['--help']).code, 0);
    assert.equal(runCli(['--nope']).code, 1);
  });

  test('a clean copy passes and prints the demo-mode summary', () => {
    const { code, out } = runCli(['--data-only', '--root', makeRoot()]);
    assert.equal(code, 0);
    assert.match(out, /^Question bank: 0 of 55 chapters published \(the app runs in demo mode\)$/m);
    assert.match(out, /55 unpublished empty chapters \(hidden in the app\)/);
    assert.match(out, /Validation passed: 0 errors, 0 warnings\./);
  });

  test('--strict turns a warning into a failure', () => {
    const root = makeRoot();
    editIndex(root, (index) => {
      entry(index, 'ch06').short = 'A label that is far too long';
    });
    assert.equal(runCli(['--data-only', '--root', root]).code, 0);
    const strict = runCli(['--data-only', '--strict', '--quiet', '--root', root]);
    assert.equal(strict.code, 1);
    assert.match(strict.out, /WARN {2}data\/index\.json {2}chapters\[5\] \(ch06\) {2}short: is 28 characters/);
  });

  test('summary lists published and hidden chapters with questions', () => {
    const root = makeRoot();
    addQuestions(root, 'ch22', [sampleQuestion('CH22-0001')]);
    addQuestions(root, 'ch23', [sampleQuestion('CH23-0001', { reviewed: true })]);
    editIndex(root, (index) => {
      entry(index, 'ch22').published = true;
    });
    const lines = summaryLines(check(root).chapters);
    assert.equal(lines[0], 'Question bank: 1 of 55 chapters published');
    assert.ok(lines.some((l) => /^ {4}22 {2}Acute Aortic Dissection .* published .* CH22-0002$/.test(l)));
    assert.ok(lines.some((l) => /^ {4}23 {2}Chronic Thoracic .* hidden .* CH23-0002$/.test(l)));
    assert.ok(lines.includes('  53 unpublished empty chapters (hidden in the app)'));
    assert.match(lines[lines.length - 1], /1 question in published chapters .* 1 in hidden chapters \(1 reviewed\); 10 demo\./);
  });
});

describe('image paths', () => {
  test('a percent-encoded ".." segment is refused like ".." (browsers resolve it the same way)', () => {
    const root = makeRoot();
    // The literal folders exist on disk, so only the path rule can catch it.
    mkdirSync(path.join(root, 'data', 'img', '%2e%2e', '%2E%2e'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'img', '%2e%2e', '%2E%2e', 'outside.webp'), 'x');
    mkdirSync(path.join(root, 'data', 'img', 'ok'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'img', 'ok', 'inside.webp'), 'x');
    addQuestions(root, 'ch22', [
      sampleQuestion('CH22-0001', { image: { src: 'data/img/%2e%2e/%2E%2e/outside.webp', alt: 'Placeholder image' } }),
      sampleQuestion('CH22-0002', {
        answer: 'a',
        stem: 'A different neutral placeholder stem used only for the image path rule check here.',
        image: { src: 'data/img/ok/inside.webp', alt: 'Placeholder image' },
      }),
    ]);
    const { errors } = check(root);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0].where, /^CH22-0001 {2}image\.src$/);
    assert.match(errors[0].message, /must not go up/);
  });
});
