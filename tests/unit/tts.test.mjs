// Unit tests for the pure parts of js/features/tts.js. Run: node --test tests/unit/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  pickBestVoice,
  rankVoices,
  voiceTier,
  isEnglishVoice,
  questionSpeechText,
  speechText,
  splitForSpeech,
  isTtsSupported,
  MAX_UTTERANCE_CHARS,
} from '../../js/features/tts.js';

/** Minimal SpeechSynthesisVoice stand-in. */
const v = (name, lang, extra = {}) => ({ name, lang, voiceURI: extra.voiceURI ?? name, localService: true, default: false, ...extra });

describe('isEnglishVoice', () => {
  test('accepts en and en-* (any case, underscores) only', () => {
    assert.ok(isEnglishVoice(v('x', 'en-US')));
    assert.ok(isEnglishVoice(v('x', 'en_GB')));
    assert.ok(isEnglishVoice(v('x', 'EN')));
    assert.ok(!isEnglishVoice(v('x', 'eng')));
    assert.ok(!isEnglishVoice(v('x', 'fr-FR')));
    assert.ok(!isEnglishVoice(v('x', '')));
    assert.ok(!isEnglishVoice(null));
  });
});

describe('pickBestVoice ranking', () => {
  const any = v('Plain voice', 'en-IN', { localService: false });
  const localUs = v('Device voice', 'en-US');
  const quality = v('Samantha', 'en-US');
  const google = v('Google UK English Female', 'en-GB', { localService: false });
  const neural = v('Microsoft Aria Online (Natural) - English (United States)', 'en-US', { localService: false });
  const enhanced = v('Daniel (Enhanced)', 'en-GB');
  const premium = v('Ava', 'en-US', { voiceURI: 'com.apple.voice.premium.en-US.Ava' });
  const french = v('Amélie (Premium)', 'fr-CA');
  const novelty = v('Bubbles', 'en-US');

  test('Premium > Enhanced > Neural/Natural > quality names > local en-US/en-GB > any English', () => {
    const order = [any, localUs, quality, neural, enhanced, premium];
    for (let i = 0; i < order.length; i++) {
      const pool = order.slice(0, i + 1).reverse();
      assert.equal(pickBestVoice(pool), order[i], `step ${i}`);
    }
    assert.deepEqual(rankVoices([any, localUs, quality, neural, enhanced, premium]), [
      premium,
      enhanced,
      neural,
      quality,
      localUs,
      any,
    ]);
  });

  test('Google voices count as quality voices', () => {
    assert.equal(voiceTier(google), 3);
    assert.equal(pickBestVoice([localUs, google]), google);
  });

  test('never picks a non-English voice, even a Premium one', () => {
    assert.equal(pickBestVoice([french, any]), any);
    assert.equal(pickBestVoice([french]), null);
    assert.equal(pickBestVoice([]), null);
    assert.equal(pickBestVoice(null), null);
  });

  test("the user's saved voice wins when present and English", () => {
    assert.equal(pickBestVoice([premium, localUs], { preferredURI: 'Device voice' }), localUs);
    // Missing or non-English saved voice → best English voice.
    assert.equal(pickBestVoice([premium, localUs], { preferredURI: 'gone' }), premium);
    assert.equal(pickBestVoice([premium, french], { preferredURI: french.voiceURI }), premium);
  });

  test('novelty voices rank last', () => {
    assert.equal(voiceTier(novelty), 0);
    assert.equal(pickBestVoice([novelty, any]), any);
    assert.equal(pickBestVoice([novelty]), novelty);
  });

  test('ties: on-device first, then en-US, en-GB, other English, then default, then input order', () => {
    const a = v('Voice A', 'en-AU');
    const b = v('Voice B', 'en-GB', { localService: false });
    const c = v('Voice C', 'en-ZA', { default: true });
    const d = v('Voice D', 'en-ZA');
    assert.deepEqual(rankVoices([d, b, c, a]), [c, d, a, b]);
    const q1 = v('Karen', 'en-AU');
    const q2 = v('Daniel', 'en-GB');
    const q3 = v('Samantha', 'en-US');
    assert.deepEqual(rankVoices([q1, q2, q3]), [q3, q2, q1]);
  });

  test('is pure (input untouched)', () => {
    const list = [any, premium, localUs];
    const copy = [...list];
    rankVoices(list);
    pickBestVoice(list);
    assert.deepEqual(list, copy);
  });
});

describe('speechText', () => {
  test('removes markup and reads arrows as words', () => {
    assert.equal(speechText('**Alpha** -> _Bravo_'), 'Alpha leads to Bravo');
    assert.equal(speechText('Alpha → Bravo ⇒ Charlie'), 'Alpha leads to Bravo leads to Charlie');
    assert.equal(speechText('↑ Alpha, ↓ Bravo'), 'increased Alpha, decreased Bravo');
    assert.equal(speechText('Alpha <- Bravo'), 'Alpha comes from Bravo');
    assert.equal(speechText('Alpha <=> Bravo'), 'Alpha is equivalent to Bravo');
    assert.equal(speechText('CO~2~ and x^2^'), 'CO2 and x2');
    assert.equal(speechText(42), '');
  });
});

describe('questionSpeechText', () => {
  const q = {
    id: 'DEMO-9002',
    stem: 'Sample **stem** -> next',
    choices: [
      { id: 'a', text: 'Alpha step' },
      { id: 'b', text: 'Bravo step' },
      { id: 'c', text: 'Charlie step.' },
    ],
    answer: 'b',
    explanation: [
      { id: 'h', type: 'heading', text: 'Sample heading' },
      { id: 'p', type: 'p', text: 'Sample ==paragraph==' },
      { id: 'l', type: 'list', items: ['First item', { text: 'Second item', items: ['Nested item'] }] },
      { id: 't', type: 'table', caption: 'Sample table', head: ['', 'Col one', 'Col two'], rows: [['Row one', 'x', 'y']] },
      { id: 'f', type: 'flow', title: 'Sample flow', steps: [{ text: 'Start' }, { text: 'Middle', label: 'if yes' }, { branches: [{ label: 'left', text: 'L' }, { text: 'R' }] }] },
      { id: 'm', type: 'mindmap', center: 'Hub', branches: [{ text: 'Branch', children: ['Leaf one', 'Leaf two'] }, { text: 'Lone' }] },
      { id: 'c', type: 'callout', kind: 'pearl', title: 'Sample title', items: ['Point one'] },
      { id: 'q', type: 'quote', text: 'Sample quote', ref: 'Sample ref, p. 1' },
      { id: 'i', type: 'image', src: 'x.webp', alt: 'Sample picture' },
      { id: 'z', type: 'unknown', text: 'skipped' },
    ],
  };

  test('stem then lettered choices in display order', () => {
    assert.deepEqual(questionSpeechText(q, { choiceOrder: ['c', 'a', 'b'] }), [
      'Sample stem leads to next.',
      'A. Charlie step.',
      'B. Alpha step.',
      'C. Bravo step.',
    ]);
  });

  test('data order when choiceOrder is missing; unknown ids ignored', () => {
    assert.deepEqual(questionSpeechText(q, { choiceOrder: ['x'] }).slice(1), ['A. Alpha step.', 'B. Bravo step.', 'C. Charlie step.']);
  });

  test('with the explanation: answer line then one chunk per block', () => {
    const chunks = questionSpeechText(q, { choiceOrder: ['a', 'b', 'c'], includeExplanation: true });
    assert.deepEqual(chunks.slice(4), [
      'The correct answer is B. Bravo step.',
      'Sample heading.',
      'Sample paragraph.',
      'First item. Second item. Nested item.',
      'Sample table. Row one, Col one: x, Col two: y.',
      'Sample flow. Start. if yes, leads to Middle. Then, either left: L, or R.',
      'Hub. Branch: Leaf one, Leaf two. Lone.',
      'Pearl: Sample title. Point one.',
      'Sample quote. Source: Sample ref, p. 1.',
      'Image: Sample picture.',
    ]);
  });

  test('no explanation by default; empty parts skipped; malformed input safe', () => {
    assert.equal(questionSpeechText(q).length, 4);
    assert.deepEqual(questionSpeechText({ stem: '', choices: [{ id: 'a', text: '' }] }), []);
    assert.deepEqual(questionSpeechText(null), []);
    assert.doesNotThrow(() => questionSpeechText({ choices: 'x', explanation: [null, 5] }, { includeExplanation: true }));
  });
});

describe('splitForSpeech', () => {
  test('short text stays one chunk; whitespace collapsed', () => {
    assert.deepEqual(splitForSpeech('  Alpha   bravo. '), ['Alpha bravo.']);
    assert.deepEqual(splitForSpeech(''), []);
  });

  test('splits at sentences, then phrases, then words; every chunk fits', () => {
    const s = 'Alpha sentence one is here. '.repeat(20) + 'word, '.repeat(80) + 'x'.repeat(500);
    const parts = splitForSpeech(s);
    assert.ok(parts.length > 3);
    for (const p of parts) assert.ok(p.length <= MAX_UTTERANCE_CHARS, `too long: ${p.length}`);
    assert.ok(parts[0].endsWith('.'));
    assert.equal(parts.join('').replace(/\s/g, ''), s.replace(/\s/g, ''));
  });

  test('respects a custom max', () => {
    for (const p of splitForSpeech('one two three four five six', 9)) assert.ok(p.length <= 9);
  });
});

describe('isTtsSupported', () => {
  test('false in Node', () => {
    assert.equal(isTtsSupported(), false);
  });
});
