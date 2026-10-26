// Unit tests for js/features/search.js. Run: node --test tests/unit/*.test.mjs
//
// tokenize / buildIndex / queryIndex / makeSnippet are pure. search() and
// its memoized index are exercised through setTestBackend with an in-memory
// study bank. Neutral placeholder text only (no medical content).
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize,
  buildIndex,
  queryIndex,
  makeSnippet,
  search,
  prepareSearchIndex,
  clearSearchIndex,
  setTestBackend,
  FIELD_WEIGHTS,
  PHRASE_BONUS,
  MAX_COUNTED_REPEATS,
  MAX_QUERY_TERMS,
  DEFAULT_LIMIT,
  SNIPPET_LENGTH,
  TITLE_LENGTH,
} from '../../js/features/search.js';
import { seededRandom } from '../../js/core/util.js';

const HYPHEN_2010 = String.fromCharCode(0x2010);
const NB_HYPHEN = String.fromCharCode(0x2011);
const EN_DASH = String.fromCharCode(0x2013);
const FI_LIGATURE = String.fromCharCode(0xfb01);
const COMBINING_ACUTE = String.fromCharCode(0x0301);

/**
 * A question with neutral placeholder text.
 * @param {string} id
 * @param {object} [fields]
 */
function question(id, fields = {}) {
  const { choices = ['Choice A text', 'Choice B text', 'Choice C text', 'Choice D text'], ...rest } = fields;
  return {
    id,
    version: 1,
    chapterId: 'ch01',
    topic: 'Topic Z',
    tags: [],
    difficulty: 2,
    reviewed: false,
    stem: `Sample stem ${id}`,
    choices: choices.map((text, i) => ({ id: 'abcde'[i], text })),
    answer: 'a',
    explanation: [],
    source: [{ ref: 'Source', loc: 'p. 1' }],
    ...rest,
  };
}

/** @param {string} text @param {string} [id] */
const p = (text, id = 'p1') => ({ id, type: 'p', text });

/** @param {ReturnType<typeof queryIndex>} hits */
const ids = (hits) => hits.map((h) => h.qid);

/** @param {{ text: string, match: boolean }[]} segs */
const marked = (segs) => segs.filter((s) => s.match).map((s) => s.text);

/** @param {{ text: string }[]} segs */
const joined = (segs) => segs.map((s) => s.text).join('');

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  test('lowercases and splits on spaces and punctuation', () => {
    assert.deepEqual(tokenize('Hello, World! How are you? (Fine.) [ok] {yes}'), [
      'hello',
      'world',
      'how',
      'are',
      'you',
      'fine',
      'ok',
      'yes',
    ]);
  });

  test('strips inline markup characters', () => {
    assert.deepEqual(tokenize('**Kilo** _lima_ ==mike== `oscar` \\*papa\\* romeo^2^ sierra~3~'), [
      'kilo',
      'lima',
      'mike',
      'oscar',
      'papa',
      'romeo',
      '2',
      'sierra',
      '3',
    ]);
  });

  test('keeps digits, including single digits; drops other one-character tokens', () => {
    assert.deepEqual(tokenize('a 2 b 10 I x 3 7.5'), ['2', '10', '3', '7', '5']);
  });

  test('hyphenated words give their parts and the joined form', () => {
    assert.deepEqual(tokenize('Kilo-lima'), ['kilo', 'lima', 'kilolima']);
    assert.deepEqual(tokenize('one-two-three'), ['one', 'two', 'three', 'onetwothree']);
    assert.deepEqual(tokenize('X-ray'), ['ray', 'xray']);
    assert.deepEqual(tokenize('3-way'), ['3', 'way', '3way']);
    assert.deepEqual(tokenize(`kilo${HYPHEN_2010}lima`), ['kilo', 'lima', 'kilolima']);
    assert.deepEqual(tokenize(`kilo${NB_HYPHEN}lima`), ['kilo', 'lima', 'kilolima']);
  });

  test('dashes, double hyphens and spaced hyphens are separators', () => {
    assert.deepEqual(tokenize(`kilo${EN_DASH}lima`), ['kilo', 'lima']);
    assert.deepEqual(tokenize('kilo--lima'), ['kilo', 'lima']);
    assert.deepEqual(tokenize('kilo - lima -mike tango-'), ['kilo', 'lima', 'mike', 'tango']);
  });

  test('folds accents, compatibility forms and Greek letters', () => {
    assert.deepEqual(tokenize('Café naïve ÅNGSTRÖM x² ' + FI_LIGATURE + 'ne'), ['cafe', 'naive', 'angstrom', 'x2', 'fine']);
    assert.deepEqual(tokenize(`cafe${COMBINING_ACUTE} done`), ['cafe', 'done']);
    assert.deepEqual(tokenize('β-kilo Δ μ'), ['beta', 'kilo', 'betakilo', 'delta', 'mu']);
  });

  test('apostrophes, underscores and arrows separate tokens', () => {
    assert.deepEqual(tokenize("kilo's snake_case kilo->lima kilo => lima kilo→lima"), [
      'kilo',
      'snake',
      'case',
      'kilo',
      'lima',
      'kilo',
      'lima',
      'kilo',
      'lima',
    ]);
  });

  test('keeps letters of other scripts', () => {
    assert.deepEqual(tokenize('Привет мир'), ['привет', 'мир']);
  });

  test('non-string input gives no tokens', () => {
    for (const v of [null, undefined, 42, {}, ['kilo']]) assert.deepEqual(tokenize(v), []);
    assert.deepEqual(tokenize(''), []);
    assert.deepEqual(tokenize('  ,.;  '), []);
  });

  test('keeps repeats in reading order', () => {
    assert.deepEqual(tokenize('kilo lima kilo'), ['kilo', 'lima', 'kilo']);
  });
});

// ---------------------------------------------------------------------------
// buildIndex
// ---------------------------------------------------------------------------

describe('buildIndex', () => {
  test('indexes questions in bank order and skips malformed entries and repeated ids', () => {
    const q1 = question('T-0001');
    const q2 = question('T-0002');
    const index = buildIndex([q1, null, { id: '' }, { stem: 'no id' }, 'x', q2, { ...q1, stem: 'Another stem' }]);
    assert.equal(index.size, 2);
    assert.deepEqual(
      index.docs.map((d) => d.qid),
      ['T-0001', 'T-0002'],
    );
    assert.equal(index.docs[0].chapterId, 'ch01');
    assert.deepEqual(ids(queryIndex(index, 'another')), []);
  });

  test('the vocabulary is sorted and unique, and every posting points at a real question', () => {
    const index = buildIndex([
      question('T-0001', { stem: 'kilo lima mike' }),
      question('T-0002', { stem: 'lima mike oscar', explanation: [p('kilo kilo kilo kilo')] }),
    ]);
    const vocab = [...index.vocab];
    assert.deepEqual(vocab, [...new Set(vocab)].sort());
    assert.equal(index.offsets.length, vocab.length + 1);
    assert.equal(index.offsets[0], 0);
    assert.equal(index.offsets[vocab.length], index.postings.length);
    for (let i = 0; i < vocab.length; i++) {
      assert.ok(index.offsets[i] < index.offsets[i + 1], `token ${vocab[i]} has postings`);
      let prev = -1;
      for (let k = index.offsets[i]; k < index.offsets[i + 1]; k++) {
        const pos = index.postings[k] >>> 7;
        assert.ok(pos > prev && pos < index.size, 'positions ascending and in range');
        prev = pos;
      }
    }
    assert.ok(Object.isFrozen(index));
  });

  test('empty or missing input gives an empty index', () => {
    for (const input of [[], null, undefined, 42]) {
      const index = buildIndex(/** @type {any} */ (input));
      assert.equal(index.size, 0);
      assert.deepEqual(queryIndex(index, 'kilo'), []);
    }
  });

  test('accepts any iterable', () => {
    const index = buildIndex(new Set([question('T-0001', { stem: 'kilo' })]));
    assert.deepEqual(ids(queryIndex(index, 'kilo')), ['T-0001']);
  });

  test('handles a question with missing or odd fields', () => {
    const index = buildIndex([
      { id: 'T-0001' },
      { id: 'T-0002', stem: 42, choices: 'x', explanation: { type: 'p' }, choiceNotes: [], tags: [1, 'kilo'] },
    ]);
    assert.equal(index.size, 2);
    assert.deepEqual(ids(queryIndex(index, 'kilo')), ['T-0002']);
  });
});

// ---------------------------------------------------------------------------
// queryIndex: matching
// ---------------------------------------------------------------------------

describe('queryIndex: matching', () => {
  const bank = [
    question('T-0001', { stem: 'Kilo lima valves here' }),
    question('T-0002', { stem: 'Kilo only' }),
    question('T-0003', { stem: 'Lima only' }),
    question('T-0004', { stem: 'Valvular word', topic: 'Topic Kilo' }),
    question('T-0005', { stem: 'The hotel-india pair' }),
    question('T-0006', { stem: 'The hotelindia joined' }),
    question('T-0007', { stem: 'The hotel and the india apart' }),
    question('T-0008', { stem: 'The β-receptor note and Löffler text' }),
  ];
  const index = buildIndex(bank);

  test('every term must match (AND)', () => {
    assert.deepEqual(ids(queryIndex(index, 'kilo lima')), ['T-0001']);
    assert.deepEqual(ids(queryIndex(index, 'lima kilo')), ['T-0001']);
    assert.deepEqual(ids(queryIndex(index, 'kilo lima zulu')), []);
  });

  test('the last term matches as a prefix', () => {
    assert.deepEqual(ids(queryIndex(index, 'valv')), ['T-0001', 'T-0004']);
    assert.deepEqual(ids(queryIndex(index, 'kilo valv')), ['T-0001', 'T-0004']);
  });

  test('only the last term is a prefix', () => {
    assert.deepEqual(ids(queryIndex(index, 'valv kilo')), []);
    assert.deepEqual(ids(queryIndex(index, 'valves kilo')), ['T-0001']);
  });

  test('a trailing space keeps the last word a prefix (phone keyboards add one)', () => {
    assert.deepEqual(ids(queryIndex(index, 'valv ')), ['T-0001', 'T-0004']);
  });

  test('a dropped one-letter last word leaves the previous term as the prefix', () => {
    assert.deepEqual(ids(queryIndex(index, 'valv x')), ['T-0001', 'T-0004']);
  });

  test('a hyphenated query word matches the joined form or all of its parts', () => {
    assert.deepEqual(ids(queryIndex(index, 'hotel-india')), ['T-0005', 'T-0006', 'T-0007']);
    assert.deepEqual(ids(queryIndex(index, 'hotelindia')), ['T-0005', 'T-0006']);
    assert.deepEqual(ids(queryIndex(index, 'hotel india')), ['T-0005', 'T-0007']);
    assert.deepEqual(ids(queryIndex(index, 'hotel-ind')), ['T-0005', 'T-0006', 'T-0007']);
  });

  test('accents and Greek letters are folded on both sides', () => {
    assert.deepEqual(ids(queryIndex(index, 'loffler')), ['T-0008']);
    assert.deepEqual(ids(queryIndex(index, 'LÖFFLER')), ['T-0008']);
    assert.deepEqual(ids(queryIndex(index, 'beta-receptor')), ['T-0008']);
    assert.deepEqual(ids(queryIndex(index, 'β receptor')), ['T-0008']);
    assert.deepEqual(ids(queryIndex(index, 'betareceptor')), ['T-0008']);
  });

  test('case and punctuation in the query do not matter', () => {
    assert.deepEqual(ids(queryIndex(index, '  KILO,   "lima"!  ')), ['T-0001']);
  });

  test('empty, blank, punctuation-only and one-letter queries find nothing', () => {
    for (const q of ['', '   ', '?!', 'a', 'x y', null, undefined, 42]) {
      assert.deepEqual(queryIndex(index, /** @type {any} */ (q)), [], JSON.stringify(q));
    }
  });

  test('a single digit is a valid query', () => {
    const idx = buildIndex([question('T-0001', { stem: 'Grade 2 sample' }), question('T-0002', { stem: 'Grade 3 sample' })]);
    assert.deepEqual(ids(queryIndex(idx, 'grade 2')), ['T-0001']);
  });

  test('repeating a word does not change the hits', () => {
    assert.deepEqual(ids(queryIndex(index, 'kilo kilo lima')), ids(queryIndex(index, 'kilo lima')));
    assert.deepEqual(ids(queryIndex(index, 'kilo lima kilo')), ['T-0001']);
  });

  test(`at most ${MAX_QUERY_TERMS} terms are used`, () => {
    const words = Array.from({ length: MAX_QUERY_TERMS + 4 }, (_, i) => `w${i}x`);
    const idx = buildIndex([question('T-0001', { stem: words.slice(0, MAX_QUERY_TERMS).join(' ') })]);
    assert.deepEqual(ids(queryIndex(idx, words.join(' '))), ['T-0001']);
  });

  test('inline markup in the data is read as visible text', () => {
    const idx = buildIndex([
      question('T-0001', { stem: 'Level of CO~2~ and x^10^ here' }),
      question('T-0002', { stem: 'The **Kilo**lima word and the **papa**-romeo word' }),
      question('T-0003', { stem: 'Escaped \\*star\\* and \\_under\\_ text' }),
    ]);
    assert.deepEqual(ids(queryIndex(idx, 'co2')), ['T-0001']);
    assert.deepEqual(ids(queryIndex(idx, 'x10')), ['T-0001']);
    assert.deepEqual(ids(queryIndex(idx, 'kilolima')), ['T-0002']);
    assert.deepEqual(ids(queryIndex(idx, 'paparomeo')), ['T-0002']);
    assert.deepEqual(ids(queryIndex(idx, 'papa-romeo')), ['T-0002']);
    assert.deepEqual(ids(queryIndex(idx, 'star under')), ['T-0003']);
  });

  test('every text field and every explanation block type is searchable', () => {
    const q = question('T-0001', {
      stem: 'Stem word wstem',
      topic: 'Topic wtopic',
      tags: ['wtag'],
      choices: ['Choice wchoice', 'Other choice'],
      choiceNotes: { a: 'Note wnote', zz: 'Orphan wnoteorphan' },
      explanation: [
        { id: 'h', type: 'heading', text: 'Heading wheading' },
        { id: 'p', type: 'p', text: 'Paragraph wpara' },
        { id: 'l', type: 'list', items: ['Item wlist', { text: 'Parent wparent', items: ['Child wchild'] }] },
        { id: 't', type: 'table', caption: 'Caption wcaption', head: ['Head whead'], rows: [['Cell wcell']], emphasis: { col: 0 } },
        { id: 'f', type: 'flow', title: 'Title wflowtitle', steps: [{ text: 'Step wstep', label: 'wlabel' }, { branches: [{ label: 'wbrlabel', text: 'Branch wbranch' }] }] },
        { id: 'm', type: 'mindmap', center: 'Center wcenter', branches: [{ text: 'Branch wmmbranch', children: ['Leaf wleaf'] }] },
        { id: 'c', type: 'callout', kind: 'pearl', title: 'Callout wctitle', text: 'Body wctext', items: ['Point wcitem'] },
        { id: 'q', type: 'quote', text: 'Quoted wquote', ref: 'Ref wref' },
        { id: 'i', type: 'image', src: 'data/img/wsrc.webp', alt: 'Alt walt', caption: 'Caption wimgcap' },
        { id: 'u', type: 'future', label: 'Unknown wunknown' },
      ],
    });
    const idx = buildIndex([q]);
    const words = [
      'wstem', 'wtopic', 'wtag', 'wchoice', 'wnote', 'wnoteorphan', 'wheading', 'wpara', 'wlist', 'wparent',
      'wchild', 'wcaption', 'whead', 'wcell', 'wflowtitle', 'wstep', 'wlabel', 'wbrlabel', 'wbranch', 'wcenter',
      'wmmbranch', 'wleaf', 'wctitle', 'wctext', 'wcitem', 'wquote', 'wref', 'walt', 'wimgcap', 'wunknown',
    ];
    for (const w of words) assert.deepEqual(ids(queryIndex(idx, w)), ['T-0001'], w);
    // Structural fields (block ids, types, callout kinds, image paths) are not text.
    for (const w of ['pearl', 'wsrc', 'webp', 'future', 'mindmap']) assert.deepEqual(ids(queryIndex(idx, w)), [], w);
  });
});

// ---------------------------------------------------------------------------
// queryIndex: ranking
// ---------------------------------------------------------------------------

describe('queryIndex: ranking', () => {
  test('a stem hit outranks hits found only in the explanation, however many', () => {
    const idx = buildIndex([
      question('T-0001', { explanation: [p('kilo kilo kilo kilo kilo kilo kilo kilo')], choiceNotes: { a: 'kilo kilo kilo' } }),
      question('T-0002', { stem: 'One kilo here' }),
    ]);
    const hits = queryIndex(idx, 'kilo');
    assert.deepEqual(ids(hits), ['T-0002', 'T-0001']);
    assert.equal(hits[0].score, FIELD_WEIGHTS.stem);
    assert.equal(hits[1].score, (FIELD_WEIGHTS.explanation + FIELD_WEIGHTS.notes) * MAX_COUNTED_REPEATS);
  });

  test('topic and tags rank like the stem; choices rank between stem and explanation', () => {
    const idx = buildIndex([
      question('T-0001', { explanation: [p('kilo')] }),
      question('T-0002', { choices: ['kilo', 'Choice B text'] }),
      question('T-0003', { tags: ['kilo'] }),
      question('T-0004', { topic: 'Kilo' }),
      question('T-0005', { stem: 'Kilo' }),
    ]);
    const hits = queryIndex(idx, 'kilo');
    assert.deepEqual(ids(hits), ['T-0003', 'T-0004', 'T-0005', 'T-0002', 'T-0001']);
    assert.deepEqual(
      hits.map((h) => h.score),
      [FIELD_WEIGHTS.tags, FIELD_WEIGHTS.topic, FIELD_WEIGHTS.stem, FIELD_WEIGHTS.choices, FIELD_WEIGHTS.explanation],
    );
  });

  test('scores add up over terms and fields', () => {
    const idx = buildIndex([question('T-0001', { stem: 'kilo lima', choices: ['kilo'], explanation: [p('lima lima')] })]);
    const [hit] = queryIndex(idx, 'kilo lima');
    const expected = FIELD_WEIGHTS.stem * 2 + FIELD_WEIGHTS.choices + FIELD_WEIGHTS.explanation * 2 + PHRASE_BONUS;
    assert.equal(hit.score, expected);
  });

  test('ties keep bank order', () => {
    const idx = buildIndex([
      question('T-0003', { stem: 'kilo' }),
      question('T-0001', { stem: 'kilo' }),
      question('T-0002', { stem: 'kilo' }),
    ]);
    const hits = queryIndex(idx, 'kilo');
    assert.deepEqual(ids(hits), ['T-0003', 'T-0001', 'T-0002']);
    assert.deepEqual(
      hits.map((h) => h.pos),
      [0, 1, 2],
    );
  });

  test('an exact phrase in the stem earns a bonus', () => {
    const idx = buildIndex([
      question('T-0001', { stem: 'lima word then kilo' }),
      question('T-0002', { stem: 'the kilo lima pair' }),
      question('T-0003', { stem: 'the kilo limatwo pair' }),
    ]);
    const hits = queryIndex(idx, 'kilo lima');
    assert.deepEqual(ids(hits), ['T-0002', 'T-0003', 'T-0001']);
    assert.equal(hits[0].score - hits[2].score, PHRASE_BONUS);
    assert.equal(hits[1].score - hits[2].score, PHRASE_BONUS, 'the last word of the phrase is a prefix too');
  });

  test('limit: default, custom, Infinity and invalid values', () => {
    const many = Array.from({ length: 70 }, (_, i) => question(`T-${String(i + 1).padStart(4, '0')}`, { stem: 'kilo' }));
    const idx = buildIndex(many);
    assert.equal(queryIndex(idx, 'kilo').length, DEFAULT_LIMIT);
    assert.equal(queryIndex(idx, 'kilo', { limit: 5 }).length, 5);
    assert.equal(queryIndex(idx, 'kilo', { limit: 5.9 }).length, 5);
    assert.equal(queryIndex(idx, 'kilo', { limit: Infinity }).length, 70);
    for (const limit of [0, -1, Number.NaN, '5', null]) {
      assert.equal(queryIndex(idx, 'kilo', { limit: /** @type {any} */ (limit) }).length, DEFAULT_LIMIT, String(limit));
    }
  });
});

// ---------------------------------------------------------------------------
// makeSnippet
// ---------------------------------------------------------------------------

describe('makeSnippet', () => {
  const LONG = `${'Lead words go here. '.repeat(20)}The kilo target sits here. ${'Tail words follow on. '.repeat(20)}`;

  test('empty text gives no segments', () => {
    assert.deepEqual(makeSnippet('', ['kilo']), []);
    assert.deepEqual(makeSnippet('   ', ['kilo']), []);
    assert.deepEqual(makeSnippet(/** @type {any} */ (null), ['kilo']), []);
  });

  test('without a match: the start of the text, cut at a word end', () => {
    const segs = makeSnippet(LONG, ['zulu']);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].match, false);
    assert.ok(segs[0].text.endsWith('…'));
    const body = segs[0].text.slice(0, -1);
    assert.ok(body.length <= SNIPPET_LENGTH);
    assert.ok(LONG.startsWith(body));
    assert.ok(LONG[body.length] === ' ', 'cut at a word end');
    assert.deepEqual(makeSnippet('Short text.', []), [{ text: 'Short text.', match: false }]);
  });

  test('a match near the start: no leading ellipsis', () => {
    const segs = makeSnippet(`The kilo word starts here. ${'More words. '.repeat(30)}`, ['kilo']);
    assert.deepEqual(segs.slice(0, 2), [
      { text: 'The ', match: false },
      { text: 'kilo', match: true },
    ]);
    assert.ok(segs.at(-1).text.endsWith('…'));
  });

  test('a match deep in long text: ellipses on both sides, cut at word boundaries', () => {
    const segs = makeSnippet(LONG, ['kilo']);
    assert.equal(segs[0].match, false);
    assert.ok(segs[0].text.startsWith('…'));
    assert.ok(segs.at(-1).text.endsWith('…'));
    assert.deepEqual(marked(segs), ['kilo']);
    const body = joined(segs).slice(1, -1);
    assert.ok(body.length <= SNIPPET_LENGTH, `length ${body.length}`);
    const at = LONG.indexOf(body);
    assert.ok(at > 0, 'a contiguous slice of the text');
    assert.equal(LONG[at - 1], ' ', 'starts at a word start');
    assert.equal(LONG[at + body.length], ' ', 'ends at a word end');
    // Some context before the match.
    assert.ok(body.indexOf('kilo') >= 20);
  });

  test('a match at the very end shifts the window back', () => {
    const text = `${'Lead words go here. '.repeat(20)}Last kilo`;
    const segs = makeSnippet(text, ['kilo']);
    assert.deepEqual(segs.at(-1), { text: 'kilo', match: true });
    assert.ok(joined(segs).length - 1 >= SNIPPET_LENGTH - 20, 'uses the room before the match');
  });

  test('marks every match inside the cut, case-insensitively and at word starts only', () => {
    const segs = makeSnippet('Kilo and KILOS and skilo and lima-kilo and kil', ['kilo']);
    assert.deepEqual(segs, [
      { text: 'Kilo', match: true },
      { text: ' and ', match: false },
      { text: 'KILO', match: true },
      { text: 'S and skilo and lima-', match: false },
      { text: 'kilo', match: true },
      { text: ' and kil', match: false },
    ]);
  });

  test('several terms; the longer one wins where both match', () => {
    const segs = makeSnippet('kilolima then kilo then lima', ['kilo', 'kilolima', 'lima']);
    assert.deepEqual(marked(segs), ['kilolima', 'kilo', 'lima']);
  });

  test('accents and Greek letters are matched folded and marked as written', () => {
    assert.deepEqual(makeSnippet('Café Löffler crème', ['loffler', 'cre']), [
      { text: 'Café ', match: false },
      { text: 'Löffler', match: true },
      { text: ' ', match: false },
      { text: 'crè', match: true },
      { text: 'me', match: false },
    ]);
    assert.deepEqual(makeSnippet('The β-receptor and δ', ['beta', 'receptor', 'del']), [
      { text: 'The ', match: false },
      { text: 'β', match: true },
      { text: '-', match: false },
      { text: 'receptor', match: true },
      { text: ' and ', match: false },
      { text: 'δ', match: true },
    ]);
    assert.deepEqual(marked(makeSnippet(`x cafe${COMBINING_ACUTE} y`, ['cafe'])), [`cafe${COMBINING_ACUTE}`]);
    assert.deepEqual(marked(makeSnippet(`${FI_LIGATURE}ne word`, ['fine'])), [`${FI_LIGATURE}ne`]);
  });

  test('terms are folded too; non-strings and empty terms are ignored', () => {
    assert.deepEqual(marked(makeSnippet('Kilo word', ['KILO', '', null, 7, '!!'])), ['Kilo']);
  });

  test('segments alternate and rebuild a contiguous slice of the collapsed text', () => {
    const text = 'kilo  lima\n\nmike\tkilo oscar lima';
    const segs = makeSnippet(text, ['kilo', 'lima']);
    for (let i = 1; i < segs.length; i++) assert.notEqual(segs[i].match, segs[i - 1].match);
    assert.equal(joined(segs), 'kilo lima mike kilo oscar lima');
    assert.ok(segs.every((s) => s.text.length > 0));
  });

  test('maxLen is respected (minimum 20)', () => {
    const segs = makeSnippet(LONG, ['kilo'], 40);
    assert.ok(joined(segs).length <= 42);
    assert.deepEqual(marked(segs), ['kilo']);
    const tiny = makeSnippet(LONG, ['kilo'], 1);
    assert.ok(joined(tiny).length <= 22);
    assert.deepEqual(marked(tiny), ['kilo']);
  });

  test('a match longer than maxLen is cut, never lost', () => {
    const word = 'kilo'.repeat(10);
    const segs = makeSnippet(`Start ${word} end`, [word], 20);
    assert.equal(marked(segs).length, 1);
    assert.ok(marked(segs)[0].length <= 20);
  });
});

// ---------------------------------------------------------------------------
// search() over the study bank (test backend)
// ---------------------------------------------------------------------------

describe('search', () => {
  afterEach(() => {
    setTestBackend(null);
    clearSearchIndex();
  });

  /**
   * In-memory data backend that counts its calls.
   * @param {object[]} bank
   * @param {object[]} [chapters]
   */
  function backend(bank, chapters = [{ id: 'ch01', count: bank.length }]) {
    const state = { bank, chapters, studyCalls: 0, bankCalls: 0, fail: null };
    state.data = {
      studyChapters: async () => {
        state.studyCalls++;
        return state.chapters.map((c) => ({ ...c }));
      },
      loadStudyBank: async () => {
        state.bankCalls++;
        if (state.fail) throw state.fail;
        return state.bank.slice();
      },
    };
    setTestBackend({ data: state.data });
    return state;
  }

  const BANK = [
    question('T-0001', {
      stem: `A **kilo** stem that is long enough to need a cut for the title, ${'more words here '.repeat(6)}end`,
      explanation: [p('Explanation with lima.')],
    }),
    question('T-0002', { stem: 'Short _lima_ stem', topic: 'Topic Kilo' }),
    question('T-0003', { stem: 'Nothing to see' }),
  ];

  test('an empty or blank query returns [] without loading anything', async () => {
    const b = backend(BANK);
    for (const q of ['', '   ', '\n', null, undefined, 'a', '?']) assert.deepEqual(await search(/** @type {any} */ (q)), []);
    assert.equal(b.studyCalls + b.bankCalls, 0);
  });

  test('returns qid, chapterId, title, snippet and score, best first', async () => {
    backend(BANK);
    const results = await search('kilo');
    assert.deepEqual(
      results.map((r) => r.qid),
      ['T-0001', 'T-0002'],
    );
    const [first, second] = results;
    assert.equal(first.chapterId, 'ch01');
    assert.equal(first.score, FIELD_WEIGHTS.stem);
    assert.ok(first.title.startsWith('A kilo stem that'), 'markup removed from the title');
    assert.ok(first.title.endsWith('…'));
    assert.ok(first.title.length <= TITLE_LENGTH + 1);
    assert.ok(!first.title.includes('**'));
    assert.deepEqual(marked(first.snippet), ['kilo']);
    assert.equal(second.title, 'Short lima stem');
    // The topic is part of the snippet text, so a topic-only hit is still shown.
    assert.deepEqual(marked(second.snippet), ['Kilo']);
  });

  test('snippets show the explanation when the match is only there', async () => {
    backend(BANK);
    const results = await search('explanation');
    assert.equal(results.length, 1);
    assert.deepEqual(marked(results[0].snippet), ['Explanation']);
    assert.ok(joined(results[0].snippet).includes(' · '), 'parts are separated');
  });

  test('the index is built once and reused', async () => {
    const b = backend(BANK);
    await search('kilo');
    await search('lima');
    await search('stem');
    assert.equal(b.bankCalls, 1);
    assert.equal(b.studyCalls, 3);
  });

  test('concurrent searches share one build', async () => {
    const b = backend(BANK);
    const [r1, r2, r3] = await Promise.all([search('kilo'), search('lima'), prepareSearchIndex()]);
    assert.equal(b.bankCalls, 1);
    assert.equal(r1.length, 2);
    assert.equal(r2.length, 2);
    assert.equal(r3, undefined);
  });

  test('the index is rebuilt when the study chapters or their counts change', async () => {
    const b = backend(BANK);
    assert.equal((await search('nothing')).length, 1);
    b.bank = [...BANK, question('T-0004', { stem: 'Nothing again' })];
    assert.equal((await search('nothing')).length, 1, 'same chapters and counts: memoized');
    b.chapters = [{ id: 'ch01', count: 4 }];
    assert.equal((await search('nothing')).length, 2);
    b.chapters = [{ id: 'ch01', count: 4 }, { id: 'ch02', count: 0 }];
    await search('nothing');
    assert.equal(b.bankCalls, 3);
  });

  test('clearSearchIndex forces a rebuild', async () => {
    const b = backend(BANK);
    await search('kilo');
    clearSearchIndex();
    await search('kilo');
    assert.equal(b.bankCalls, 2);
  });

  test('prepareSearchIndex builds ahead of the first query', async () => {
    const b = backend(BANK);
    await prepareSearchIndex();
    assert.equal(b.bankCalls, 1);
    await search('kilo');
    assert.equal(b.bankCalls, 1);
  });

  test('a load failure rejects with the original error, and the next call retries', async () => {
    const b = backend(BANK);
    const err = Object.assign(new Error("You're offline."), { code: 'offline' });
    b.fail = err;
    await assert.rejects(search('kilo'), (e) => e === err);
    await assert.rejects(prepareSearchIndex(), (e) => e === err);
    b.fail = null;
    assert.equal((await search('kilo')).length, 2);
    assert.equal(b.bankCalls, 3);
  });

  test('only the study bank given by data is searched (the demo only in demo mode)', async () => {
    const demo = [question('DEMO-0001', { chapterId: 'demo', stem: 'Demo kilo stem' })];
    backend(demo, [{ id: 'demo', count: 1 }]);
    assert.deepEqual(
      (await search('kilo')).map((r) => [r.qid, r.chapterId]),
      [['DEMO-0001', 'demo']],
    );
  });

  test('limit is passed through', async () => {
    const bank = Array.from({ length: 80 }, (_, i) => question(`T-${String(i + 1).padStart(4, '0')}`, { stem: 'kilo' }));
    backend(bank);
    assert.equal((await search('kilo')).length, DEFAULT_LIMIT);
    assert.equal((await search('kilo', { limit: 3 })).length, 3);
    assert.equal((await search('kilo', { limit: Infinity })).length, 80);
  });

  test('an empty study bank gives no results', async () => {
    backend([], []);
    assert.deepEqual(await search('kilo'), []);
  });
});

// ---------------------------------------------------------------------------
// Micro-benchmark: 5000 rich placeholder questions
// ---------------------------------------------------------------------------

describe('performance (5000 questions with rich explanations)', () => {
  const rand = seededRandom(20261026);
  const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ru', 'ta', 'vo', 'zi', 'pe', 'sa', 'do', 'fu', 'gi', 'ha', 'je', 'bo'];
  const WORDS = Array.from({ length: 4000 }, (_, i) => {
    let w = '';
    let n = i;
    do {
      w += SYLLABLES[n % SYLLABLES.length];
      n = Math.floor(n / SYLLABLES.length);
    } while (n > 0);
    return i % 9 === 0 ? `${w}-${SYLLABLES[i % 16]}ra` : w;
  });
  const word = () => WORDS[Math.floor(rand() ** 2 * WORDS.length)];
  const words = (n) => Array.from({ length: n }, word).join(' ');

  const bank = Array.from({ length: 5000 }, (_, i) =>
    question(`P${String((i % 50) + 1).padStart(2, '0')}-${String(i + 1).padStart(4, '0')}`, {
      chapterId: `ch${String((i % 50) + 1).padStart(2, '0')}`,
      topic: `Topic ${i % 40}`,
      tags: [`tag${i % 9}`],
      stem: `Sample stem ${i}: ${words(35)}. Which is the **best** choice?`,
      choices: Array.from({ length: 5 }, () => `Choice ${words(4)}`),
      choiceNotes: { a: words(12), b: words(12), c: words(12) },
      explanation: [
        { id: 'h1', type: 'heading', text: `Heading ${words(3)}` },
        { id: 'p1', type: 'p', text: `${words(50)} **${word()}** -> ${word()} ==${word()}==.` },
        { id: 'l1', type: 'list', items: [words(10), words(10), { text: words(8), items: [words(6), words(6)] }] },
        { id: 't1', type: 'table', head: ['Col A', 'Col B', 'Col C'], rows: [[words(3), words(3), words(3)], [words(3), words(3), words(3)]] },
        { id: 'f1', type: 'flow', steps: [{ text: words(5) }, { text: words(5), label: 'then' }, { branches: [{ text: words(4) }, { text: words(4) }] }] },
        { id: 'm1', type: 'mindmap', center: 'Center', branches: [{ text: words(3), children: [words(2), words(2)] }, { text: words(3) }] },
        { id: 'c1', type: 'callout', kind: 'pearl', title: 'Pearl', text: words(20), items: [words(6)] },
        { id: 'q1', type: 'quote', text: words(25), ref: 'Source p. 12' },
      ],
    }),
  );

  /** Median run time of `fn` (ms). */
  const median = (fn, runs = 5) => {
    const times = [];
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      fn();
      times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[Math.floor(runs / 2)];
  };

  test('builds in under 1500 ms and answers queries in under 30 ms', () => {
    const t0 = performance.now();
    const index = buildIndex(bank);
    const buildMs = performance.now() - t0;
    assert.equal(index.size, 5000);
    assert.ok(buildMs < 1500, `build took ${buildMs.toFixed(0)} ms`);

    const common = WORDS[0];
    const queries = [common.slice(0, 2), common, `${WORDS[1]} ${WORDS[2]}`, 'sample stem 12', 'choice ka', WORDS[9], 'topic 3', 'zzzz'];
    for (const q of queries) {
      const ms = median(() => queryIndex(index, q));
      assert.ok(ms < 30, `query ${JSON.stringify(q)} took ${ms.toFixed(1)} ms`);
    }
    assert.ok(queryIndex(index, common).length > 0);
  });

  test('a full search (index memoized) with titles and snippets stays fast', async () => {
    setTestBackend({ data: { studyChapters: async () => [{ id: 'all', count: bank.length }], loadStudyBank: async () => bank } });
    try {
      await prepareSearchIndex();
      const times = [];
      for (const q of [WORDS[0].slice(0, 2), WORDS[3], 'sample stem']) {
        const t = performance.now();
        const results = await search(q);
        times.push(performance.now() - t);
        assert.ok(results.length > 0);
        assert.ok(results.every((r) => r.snippet.some((s) => s.match)), `every result of ${q} has a marked snippet`);
      }
      const worst = Math.max(...times);
      assert.ok(worst < 150, `search took ${worst.toFixed(1)} ms`);
    } finally {
      setTestBackend(null);
      clearSearchIndex();
    }
  });
});
