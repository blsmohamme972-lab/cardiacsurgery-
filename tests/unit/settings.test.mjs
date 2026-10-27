// Unit tests for js/core/settings.js: the scratchpad v2 defaults (§5.5) and their validation.
// setSetting keeps values in memory when storage is unavailable (as in Node), so this tests
// validation without IndexedDB.
// Run: node --test tests/unit/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, SCRATCH_TOOLS, getSetting, setSetting } from '../../js/core/settings.js';

// Storage is unavailable in Node; silence the expected "kept for this session only" warning.
console.warn = () => {};

describe('scratchpad settings', () => {
  test('defaults match the contract', () => {
    assert.equal(DEFAULTS.scratchView, 'over');
    assert.equal(DEFAULTS.scratchTool, 'pen');
    assert.equal(DEFAULTS.scratchColor, '#1d4ed8');
    assert.equal(DEFAULTS.scratchSize, 1);
    assert.equal(DEFAULTS.scratchBg, 'dots');
    assert.equal(DEFAULTS.scratchOpacity, 0);
    assert.ok(SCRATCH_TOOLS.includes(DEFAULTS.scratchTool));
  });

  test('valid values are stored (normalised)', async () => {
    await setSetting('scratchView', 'split');
    assert.equal(getSetting('scratchView'), 'split');
    await setSetting('scratchTool', 'select');
    assert.equal(getSetting('scratchTool'), 'select');
    await setSetting('scratchColor', '#ABCDEF');
    assert.equal(getSetting('scratchColor'), '#abcdef');
    await setSetting('scratchSize', '2');
    assert.equal(getSetting('scratchSize'), 2);
    await setSetting('scratchSize', 1.6);
    assert.equal(getSetting('scratchSize'), 2, 'rounded to a whole step');
    await setSetting('scratchSize', 9);
    assert.equal(getSetting('scratchSize'), 2, 'clamped');
    await setSetting('scratchBg', 'grid');
    assert.equal(getSetting('scratchBg'), 'grid');
    await setSetting('scratchOpacity', 0.456);
    assert.equal(getSetting('scratchOpacity'), 0.46);
    await setSetting('scratchOpacity', 1);
    assert.equal(getSetting('scratchOpacity'), 0.9, 'clamped to 0.9');
  });

  test('invalid values are rejected', async () => {
    await assert.rejects(setSetting('scratchView', 'side'), TypeError);
    await assert.rejects(setSetting('scratchTool', 'brush'), TypeError);
    await assert.rejects(setSetting('scratchColor', 'blue'), TypeError);
    await assert.rejects(setSetting('scratchSize', 'big'), TypeError);
    await assert.rejects(setSetting('scratchBg', 'stars'), TypeError);
    await assert.rejects(setSetting('scratchOpacity', NaN), TypeError);
  });
});
