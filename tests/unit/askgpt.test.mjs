// Unit tests for the pure parts of js/features/askgpt.js. Run: node --test tests/unit/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPrompt,
  askGptUrl,
  truncateText,
  orderedChoices,
  CHATGPT_URL,
  MAX_PROMPT_CHARS,
} from '../../js/features/askgpt.js';

const question = {
  id: 'DEMO-9001',
  stem: 'Sample stem with **bold** text and an arrow -> here.',
  choices: [
    { id: 'a', text: 'Alpha step' },
    { id: 'b', text: 'Bravo _step_' },
    { id: 'c', text: 'Charlie step' },
    { id: 'd', text: 'Delta step' },
  ],
  answer: 'c',
};

/** Decodes the prompt back out of a ChatGPT URL. */
const promptOf = (url) => decodeURIComponent(url.slice(CHATGPT_URL.length));

describe('buildPrompt', () => {
  test('has role, question, lettered choices in display order, both answers and the request', () => {
    const p = buildPrompt(question, { choiceOrder: ['d', 'c', 'b', 'a'], userChoice: 'b' });
    assert.match(p, /cardiac surgery resident/);
    assert.match(p, /board exam/);
    assert.match(p, /Question:\nSample stem with bold text and an arrow → here\./);
    assert.match(p, /Choices:\nA\. Delta step\nB\. Charlie step\nC\. Bravo step\nD\. Alpha step/);
    assert.match(p, /My answer: C\. Bravo step/);
    assert.match(p, /The app's answer: B\. Charlie step/);
    assert.match(p, /why the app's answer is correct and why each of the other choices is wrong/);
  });

  test('removes inline markup', () => {
    const p = buildPrompt(question, { choiceOrder: ['a', 'b', 'c', 'd'] });
    assert.doesNotMatch(p, /\*\*|_step_/);
  });

  test('says when there is no answer yet', () => {
    const p = buildPrompt(question, { choiceOrder: ['a', 'b', 'c', 'd'], userChoice: null });
    assert.match(p, /My answer: I have not answered yet\./);
  });

  test('falls back to data order and appends choices missing from choiceOrder', () => {
    assert.match(buildPrompt(question, {}), /A\. Alpha step\nB\. Bravo step\nC\. Charlie step\nD\. Delta step/);
    assert.match(
      buildPrompt(question, { choiceOrder: ['c', 'zz', 'c'] }),
      /A\. Charlie step\nB\. Alpha step\nC\. Bravo step\nD\. Delta step/,
    );
  });

  test('ignores an unknown user choice', () => {
    assert.match(buildPrompt(question, { userChoice: 'q' }), /I have not answered yet/);
  });

  test('is pure and deterministic', () => {
    const copy = structuredClone(question);
    const a = buildPrompt(question, { choiceOrder: ['b', 'a', 'c', 'd'], userChoice: 'a' });
    const b = buildPrompt(question, { choiceOrder: ['b', 'a', 'c', 'd'], userChoice: 'a' });
    assert.equal(a, b);
    assert.deepEqual(question, copy);
  });

  test('survives malformed questions', () => {
    assert.doesNotThrow(() => buildPrompt(null));
    assert.doesNotThrow(() => buildPrompt({}));
    assert.match(buildPrompt({ choices: 'x' }), /\(no question text\)/);
  });

  test('a very long stem is shortened so the prompt fits', () => {
    const long = { ...question, stem: 'Sample words '.repeat(800) };
    const p = buildPrompt(long, { choiceOrder: ['a', 'b', 'c', 'd'], userChoice: 'a' });
    assert.ok(p.length <= MAX_PROMPT_CHARS, `length ${p.length}`);
    assert.match(p, /…/);
    // Choices, answers and request survive.
    assert.match(p, /D\. Delta step/);
    assert.match(p, /My answer: A\. Alpha step/);
    assert.match(p, /board exam\.$/);
  });
});

describe('askGptUrl', () => {
  test('encodes the prompt after the ChatGPT address', () => {
    const url = askGptUrl('Hello & bye? #1 / é');
    assert.equal(url, 'https://chatgpt.com/?q=' + encodeURIComponent('Hello & bye? #1 / é'));
    assert.equal(CHATGPT_URL, 'https://chatgpt.com/?q=');
  });

  test('keeps a prompt of exactly 4000 characters as is', () => {
    const p = 'x'.repeat(MAX_PROMPT_CHARS);
    assert.equal(MAX_PROMPT_CHARS, 4000);
    assert.equal(promptOf(askGptUrl(p)), p);
  });

  test('trims a longer prompt to 4000 characters, keeping the final request paragraph', () => {
    const p = 'word '.repeat(2000) + '\n\nPlease explain.';
    const out = promptOf(askGptUrl(p));
    assert.ok(out.length <= MAX_PROMPT_CHARS, `length ${out.length}`);
    assert.ok(out.endsWith('\n\nPlease explain.'));
    assert.match(out, /…\n\nPlease explain\.$/);
  });

  test('trims a long prompt without paragraphs', () => {
    const out = promptOf(askGptUrl('y'.repeat(9000)));
    assert.equal(out.length, MAX_PROMPT_CHARS);
    assert.ok(out.endsWith('…'));
  });

  test('never throws on lone surrogates and never splits a surrogate pair', () => {
    assert.doesNotThrow(() => askGptUrl('bad \uD800 text'));
    const emoji = '😀'.repeat(3000); // 6000 UTF-16 units
    const out = promptOf(askGptUrl(emoji));
    assert.ok(out.length <= MAX_PROMPT_CHARS);
    assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test('handles non-strings', () => {
    assert.equal(askGptUrl(undefined), CHATGPT_URL);
    assert.equal(askGptUrl(42), CHATGPT_URL + '42');
  });
});

describe('helpers', () => {
  test('truncateText cuts at a word boundary and adds an ellipsis', () => {
    assert.equal(truncateText('short', 10), 'short');
    const t = truncateText('alpha bravo charlie delta', 15);
    assert.ok(t.length <= 15);
    assert.equal(t, 'alpha bravo…');
    assert.equal(truncateText('abc', 1), '…');
    assert.equal(truncateText('abc', 0), '');
  });

  test('orderedChoices assigns letters in display order', () => {
    assert.deepEqual(
      orderedChoices(question, ['b', 'a']).map((c) => `${c.letter}${c.id}`),
      ['Ab', 'Ba', 'Cc', 'Dd'],
    );
  });
});
