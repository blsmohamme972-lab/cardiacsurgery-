// Unit tests for the pure parts of js/features/explain/render.js. Run: node --test tests/unit/*.test.mjs
//
// The DOM rendering itself is checked in a real browser by tests/visual/render.mjs
// (gallery: tests/fixtures/explain.html). Importing render.js must not touch `document`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isSafeImageSrc, CALLOUT_KINDS } from '../../js/features/explain/render.js';

describe('isSafeImageSrc', () => {
  const safe = [
    'data/img/CH03-0001.webp',
    'img.png',
    './data/img/a.jpg',
    '../icons/icon-512.png',
    'data/img/file name.png',
    'data/img/a.png?v=2',
    'data/img/a:b.png',
  ];
  for (const src of safe) test(`accepts ${JSON.stringify(src)}`, () => assert.equal(isSafeImageSrc(src), true));

  const unsafe = [
    '',
    ' ',
    ' data/img/a.png',
    'data/img/a.png ',
    '/data/img/a.png',
    '//evil.example/a.png',
    'http://example.com/a.png',
    'https://example.com/a.png',
    'HTTPS://example.com/a.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'blob:abc',
    'file:///etc/passwd',
    'data\\img\\a.png',
    '\\\\server\\a.png',
    'data/img/a\n.png',
    'data/img/a\u0000.png',
    'data/img/a\u007f.png',
  ];
  for (const src of unsafe) test(`rejects ${JSON.stringify(src)}`, () => assert.equal(isSafeImageSrc(src), false));

  test('rejects non-strings', () => {
    for (const v of [undefined, null, 1, {}, [], true, ['a.png']]) assert.equal(isSafeImageSrc(v), false);
  });
});

test('CALLOUT_KINDS matches the contract (§3.4) and is frozen', () => {
  assert.deepEqual([...CALLOUT_KINDS].sort(), ['key', 'mnemonic', 'pearl', 'pitfall']);
  assert.ok(Object.isFrozen(CALLOUT_KINDS));
});
