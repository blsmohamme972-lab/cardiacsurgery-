// Unit tests for the pure parts of js/features/backup.js (validation, merge planning,
// base64, export assembly and import orchestration with an in-memory store adapter).
// Run: node --test tests/unit/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_TYPE,
  BackupError,
  MAX_BACKUP_BYTES,
  RECORD_CHECKS,
  base64ToBytes,
  blobToBase64Parts,
  bytesToBase64,
  bytesToBase64Parts,
  decodeMediaRecord,
  decodeVoiceRecord,
  exportBackup,
  formatBytes,
  importBackup,
  importResultMessage,
  isBase64,
  MEDIA_STORES,
  mediaKeptText,
  planMerge,
  readBackupFile,
  recordTime,
  validateBackup,
} from '../../js/features/backup.js';
import { ALL_STORES } from '../../js/core/store/repo.js';

const TS = Date.UTC(2026, 9, 26, 12, 0, 0);

/** A 1×1 PNG (neutral test image). */
const PNG_1PX = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

/** A scratchpad v2 scene with one image item and one stroke item. */
function sampleScene(mediaId = 'm1') {
  return {
    v: 2,
    page: { w: 2000, h: 3000, bg: 'dots' },
    items: [
      { id: 'i1', type: 'image', media: mediaId, x: 10, y: 10, w: 400, h: 300, rot: 0 },
      { id: 'i2', type: 'stroke', tool: 'pen', color: '#1d4ed8', size: 6, pts: [20, 20, 0.5, 30, 30, 0.5] },
    ],
  };
}

/** Minimal valid records per store. */
function sampleStores() {
  return {
    settings: [
      { key: 'theme', value: 'dark' },
      { key: 'lastRoute', value: '/stats' },
    ],
    qstate: [{ qid: 'DEMO-0001', seen: 2, correct: 1, incorrect: 1, totalMs: 9000, lastChoice: 'a', lastCorrect: true, lastTs: TS, bookmarked: true, srs: null, updated: TS }],
    attempts: [
      { id: 1, qid: 'DEMO-0001', choice: 'a', correct: true, ms: 4000, ts: TS, mode: 'tutor', sessionId: 's1' },
      { id: 2, qid: 'DEMO-0001', choice: 'b', correct: false, ms: 5000, ts: TS + 1, mode: 'tutor', sessionId: 's1' },
    ],
    notes: [{ qid: 'DEMO-0001', text: 'Alpha note', updated: TS }],
    highlights: [{ id: 'h1', qid: 'DEMO-0001', qversion: 1, block: 'stem', quote: 'Sample', prefix: '', suffix: ' stem', start: 0, color: 'yellow', ts: TS }],
    ink: [{ id: 'DEMO-0001|stem', qid: 'DEMO-0001', block: 'stem', qversion: 1, strokes: [{ tool: 'pen', color: '#1d4ed8', size: 0.006, pts: [0.1, 0.2, 0.5, 0.3, 0.4, 0.5] }], updated: TS }],
    voice: [{ id: 'v1', qid: 'DEMO-0001', blob: null, data: bytesToBase64(new Uint8Array([1, 2, 3, 4, 5])), mime: 'audio/webm', durationMs: 1200, ts: TS }],
    media: [{ id: 'm1', qid: 'DEMO-0001', blob: null, data: bytesToBase64(PNG_1PX), mime: 'image/png', width: 1, height: 1, bytes: PNG_1PX.length, ts: TS }],
    reports: [{ id: 'r1', qid: 'DEMO-0001', qversion: 1, reason: 'Other', text: '', ts: TS }],
    reviews: [{ qid: 'DEMO-0001', qversion: 1, status: 'ok', comment: '', ts: TS }],
    sessions: [{ id: 's1', mode: 'tutor', qids: ['DEMO-0001'], updatedAt: TS, finishedAt: null }],
  };
}

function sampleBackup(overrides = {}) {
  return {
    type: BACKUP_TYPE,
    formatVersion: 1,
    appVersion: '2026.10.26-1',
    exportedAt: new Date(TS).toISOString(),
    includesMedia: true,
    stores: sampleStores(),
    ...overrides,
  };
}

/** In-memory StoreAdapter mirroring the repo semantics needed here. */
function memoryAdapter(initial = {}, { failReplaceOn = null, failMergeOn = null } = {}) {
  const db = Object.fromEntries(ALL_STORES.map((n) => [n, [...(initial[n] || [])]]));
  const calls = [];
  return {
    db,
    calls,
    async dump(name) {
      calls.push(['dump', name]);
      return [...db[name]];
    },
    async replace(name, records) {
      calls.push(['replace', name]);
      if (failReplaceOn === name) throw Object.assign(new Error('boom'), { name: 'QuotaExceededError' });
      const keep = name === 'settings' ? db.settings.filter((r) => r.key === 'lastRoute') : [];
      db[name] = [...records.filter((r) => !(name === 'settings' && r.key === 'lastRoute')), ...keep];
      return { written: records.length, skipped: 0 };
    },
    async merge(name, records) {
      calls.push(['merge', name]);
      if (failMergeOn === name) throw new Error('disk error');
      db[name].push(...records);
      return { added: records.length, updated: 0, skipped: 0 };
    },
  };
}

describe('base64', () => {
  test('round-trips random bytes of many lengths, including chunk boundaries', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 100, 30719, 30720, 30721, 65536 * 3 + 7]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 131 + 7) & 255;
      const b64 = bytesToBase64(bytes);
      assert.equal(b64, Buffer.from(bytes).toString('base64'), `len ${len}`);
      assert.deepEqual(base64ToBytes(b64), bytes);
    }
  });

  test('parts concatenate to valid base64', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    const parts = bytesToBase64Parts(bytes);
    assert.ok(parts.length > 1);
    assert.equal(parts.join(''), Buffer.from(bytes).toString('base64'));
  });

  test('blobToBase64Parts reads a Blob in slices', async () => {
    const bytes = new Uint8Array(3 * 262144 + 11).map((_, i) => (i * 7) & 255);
    const parts = await blobToBase64Parts(new Blob([bytes]));
    assert.equal(parts.length, 2);
    assert.equal(parts.join(''), Buffer.from(bytes).toString('base64'));
  });

  test('isBase64 / base64ToBytes reject invalid text', () => {
    assert.equal(isBase64('QUJD'), true);
    assert.equal(isBase64('QUI='), true);
    assert.equal(isBase64(''), true);
    assert.equal(isBase64('QUJ'), false);
    assert.equal(isBase64('QU J'), false);
    assert.equal(isBase64('QUJ*'), false);
    assert.equal(isBase64(42), false);
    assert.throws(() => base64ToBytes('@@@@'), TypeError);
  });

  test('decodeVoiceRecord makes a typed Blob and drops data', async () => {
    const rec = decodeVoiceRecord({ id: 'v', qid: 'Q-1', blob: null, data: 'AQID', mime: 'audio/mp4', ts: 1 });
    assert.equal('data' in rec, false);
    assert.equal(rec.blob.type, 'audio/mp4');
    assert.deepEqual(new Uint8Array(await rec.blob.arrayBuffer()), new Uint8Array([1, 2, 3]));
  });
});

describe('validateBackup', () => {
  test('accepts a valid backup and summarises it', () => {
    const { data, summary } = validateBackup(sampleBackup());
    assert.equal(data.type, BACKUP_TYPE);
    assert.equal(summary.includesMedia, true);
    assert.equal(summary.counts.attempts, 2);
    assert.equal(summary.counts.voice, 1);
    assert.equal(summary.counts.media, 1);
    assert.equal(summary.total, 13);
    assert.equal(summary.appVersion, '2026.10.26-1');
    assert.equal(summary.exportedAtMs, TS);
    for (const s of ALL_STORES) assert.equal(typeof summary.counts[s], 'number');
  });

  test('a backup without the voice and media stores has no media', () => {
    const stores = sampleStores();
    delete stores.voice;
    delete stores.media;
    const { summary } = validateBackup(sampleBackup({ includesMedia: false, stores }));
    assert.equal(summary.includesMedia, false);
    assert.equal(summary.counts.voice, 0);
    assert.equal(summary.counts.media, 0);
  });

  test('an older backup with voice but no media store still counts as having media', () => {
    const stores = sampleStores();
    delete stores.media;
    const { summary } = validateBackup(sampleBackup({ stores }));
    assert.equal(summary.includesMedia, true);
  });

  test('wrong file kinds get plain-language errors', () => {
    const codeOf = (v) => {
      try {
        validateBackup(v);
      } catch (err) {
        assert.ok(err instanceof BackupError);
        assert.ok(err.userMessage.length > 20);
        return err.code;
      }
      return 'ok';
    };
    assert.equal(codeOf(null), 'not-json');
    assert.equal(codeOf([]), 'not-json');
    assert.equal(codeOf({ type: 'something' }), 'wrong-type');
    assert.equal(codeOf({ ...sampleBackup(), type: 'cardiac-mcq-review' }), 'wrong-type');
    assert.equal(codeOf(sampleBackup({ formatVersion: 2 })), 'newer-version');
    assert.equal(codeOf(sampleBackup({ formatVersion: '1' })), 'corrupt');
    assert.equal(codeOf(sampleBackup({ exportedAt: 'yesterday' })), 'corrupt');
    assert.equal(codeOf(sampleBackup({ stores: [] })), 'corrupt');
    assert.equal(codeOf(sampleBackup({ stores: { notes: {} } })), 'corrupt');
  });

  test('review file message says so', () => {
    assert.throws(() => validateBackup({ type: 'cardiac-mcq-review', formatVersion: 1 }), /review file/);
  });

  test('every bad record is detected (per store)', () => {
    const bad = {
      settings: { value: 1 },
      qstate: { qid: 'Q', seen: -1 },
      attempts: { qid: 'Q', ts: 1, correct: 'yes' },
      notes: { qid: 'Q', text: 5, updated: 1 },
      highlights: { id: 'h', qid: 'Q', block: 'stem', quote: 'x', color: 'red', ts: 1 },
      ink: { id: 'wrong', qid: 'Q', block: 'stem', strokes: [{ tool: 'pen', color: '#000000', size: 0.1, pts: [1, 2, 3] }], updated: 1 },
      voice: { id: 'v', qid: 'Q', data: 'not base64!', mime: 'audio/webm', ts: 1 },
      media: { id: 'm', qid: 'Q', data: 'AAAA', mime: 'audio/webm', width: 1, height: 1, ts: 1 },
      reports: { id: 'r', qid: 'Q', reason: '', ts: 1 },
      reviews: { qid: 'Q', status: 'maybe', ts: 1 },
      sessions: { id: 's' },
    };
    for (const [store, rec] of Object.entries(bad)) {
      assert.notEqual(RECORD_CHECKS[store](rec), null, store);
      const stores = sampleStores();
      stores[store] = [...stores[store], rec];
      assert.throws(
        () => validateBackup(sampleBackup({ stores })),
        (err) => err instanceof BackupError && err.code === 'corrupt' && /1 item/.test(err.userMessage),
        store,
      );
    }
  });

  test('sample records all pass their checks', () => {
    for (const [store, records] of Object.entries(sampleStores())) {
      for (const rec of records) assert.equal(RECORD_CHECKS[store](rec), null, store);
    }
  });

  test('ink strokes are checked deeply', () => {
    const ok = sampleStores().ink[0];
    assert.equal(RECORD_CHECKS.ink(ok), null);
    assert.equal(RECORD_CHECKS.ink({ ...ok, strokes: [] }), 'strokes');
    assert.equal(RECORD_CHECKS.ink({ ...ok, strokes: [{ ...ok.strokes[0], pts: [1, 2] }] }), 'strokes');
    assert.equal(RECORD_CHECKS.ink({ ...ok, strokes: [{ ...ok.strokes[0], color: 'blue' }] }), 'strokes');
    assert.equal(RECORD_CHECKS.ink({ ...ok, strokes: [{ ...ok.strokes[0], tool: 'brush' }] }), 'strokes');
  });

  test('ink: scratchpad scenes are accepted and checked', () => {
    const base = { id: 'Q|scratch', qid: 'Q', block: 'scratch', qversion: 1, updated: 1 };
    assert.equal(RECORD_CHECKS.ink({ ...base, strokes: [], scene: sampleScene() }), null, 'scene items alone keep it');
    assert.equal(RECORD_CHECKS.ink({ ...base, scene: sampleScene() }), null, 'strokes may be missing');
    assert.equal(RECORD_CHECKS.ink({ ...base, strokes: [], scene: { ...sampleScene(), items: [] } }), 'strokes', 'empty');
    assert.equal(RECORD_CHECKS.ink({ ...base, scene: { ...sampleScene(), items: 'x' } }), 'scene');
    assert.equal(RECORD_CHECKS.ink({ ...base, scene: { ...sampleScene(), page: null } }), 'scene');
    assert.equal(RECORD_CHECKS.ink({ ...base, scene: { ...sampleScene(), items: [{ id: 'a', type: 'video' }] } }), 'scene');
    assert.equal(RECORD_CHECKS.ink({ ...base, scene: { ...sampleScene(), items: [{ id: 'a', type: 'image' }] } }), 'scene');
    assert.equal(RECORD_CHECKS.ink({ ...base, scene: { ...sampleScene(), items: [{ type: 'text' }] } }), 'scene');
  });

  test('media records are checked', () => {
    const m = sampleStores().media[0];
    assert.equal(RECORD_CHECKS.media(m), null);
    assert.equal(RECORD_CHECKS.media({ ...m, blob: {} }), 'blob');
    assert.equal(RECORD_CHECKS.media({ ...m, data: '' }), 'data');
    assert.equal(RECORD_CHECKS.media({ ...m, data: '***' }), 'data');
    assert.equal(RECORD_CHECKS.media({ ...m, mime: 'audio/webm' }), 'mime');
    assert.equal(RECORD_CHECKS.media({ ...m, width: 0 }), 'size');
    assert.equal(RECORD_CHECKS.media({ ...m, height: 'big' }), 'size');
    assert.equal(RECORD_CHECKS.media({ ...m, bytes: -1 }), 'bytes');
    assert.equal(RECORD_CHECKS.media({ ...m, ts: undefined }), 'ts');
    assert.equal(RECORD_CHECKS.media({ ...m, qid: '' }), 'qid');
  });

  test('voice with a live blob field is rejected', () => {
    const v = sampleStores().voice[0];
    assert.equal(RECORD_CHECKS.voice({ ...v, blob: {} }), 'blob');
    assert.equal(RECORD_CHECKS.voice({ ...v, data: '' }), 'data');
    assert.equal(RECORD_CHECKS.voice({ ...v, mime: 'nope' }), 'mime');
  });

  test('unknown stores are ignored, not fatal', () => {
    const { data, summary } = validateBackup(sampleBackup({ stores: { ...sampleStores(), future: [1, 2] } }));
    assert.deepEqual(summary.ignoredStores, ['future']);
    assert.equal('future' in data.stores, false);
  });
});

describe('planMerge', () => {
  test('attempts are deduplicated by (qid, ts), ids dropped', () => {
    const existing = [{ id: 7, qid: 'Q', ts: 1 }];
    const incoming = [
      { id: 1, qid: 'Q', ts: 1 },
      { id: 2, qid: 'Q', ts: 2 },
      { id: 3, qid: 'Q', ts: 2 },
      { id: 4, qid: 'R', ts: 1 },
    ];
    const plan = planMerge('attempts', existing, incoming);
    assert.equal(plan.added, 2);
    assert.equal(plan.skipped, 2);
    assert.deepEqual(plan.write, [{ qid: 'Q', ts: 2 }, { qid: 'R', ts: 1 }]);
  });

  test('newer updated/ts wins, older is skipped, new keys are added', () => {
    const existing = [
      { qid: 'A', text: 'old', updated: 10 },
      { qid: 'B', text: 'device newer', updated: 50 },
    ];
    const incoming = [
      { qid: 'A', text: 'new', updated: 20 },
      { qid: 'B', text: 'backup older', updated: 40 },
      { qid: 'C', text: 'fresh', updated: 1 },
    ];
    const plan = planMerge('notes', existing, incoming);
    assert.equal(plan.added, 1);
    assert.equal(plan.updated, 1);
    assert.equal(plan.skipped, 1);
    assert.deepEqual(plan.write.map((r) => r.text).sort(), ['fresh', 'new']);
  });

  test('duplicates inside the file resolve to the newest copy', () => {
    const plan = planMerge('reports', [], [
      { id: 'x', qid: 'Q', ts: 1, reason: 'Other' },
      { id: 'x', qid: 'Q', ts: 5, reason: 'Typo or formatting' },
    ]);
    assert.equal(plan.write.length, 1);
    assert.equal(plan.write[0].ts, 5);
  });

  test('settings: only missing keys, never lastRoute', () => {
    const plan = planMerge('settings', [{ key: 'theme', value: 'light' }], [
      { key: 'theme', value: 'dark' },
      { key: 'fontScale', value: 1.2 },
      { key: 'lastRoute', value: '/x' },
    ]);
    assert.deepEqual(plan.write, [{ key: 'fontScale', value: 1.2 }]);
    assert.equal(plan.skipped, 2);
  });

  test('sessions compare updatedAt; qstate compares updated', () => {
    assert.equal(planMerge('sessions', [{ id: 's', updatedAt: 5 }], [{ id: 's', updatedAt: 6 }]).updated, 1);
    assert.equal(planMerge('qstate', [{ qid: 'q', updated: 9 }], [{ qid: 'q', updated: 3 }]).skipped, 1);
    assert.equal(recordTime({ ts: 4 }), 4);
    assert.equal(recordTime(null), 0);
  });

  test('unknown store throws', () => {
    assert.throws(() => planMerge('nope', [], []), TypeError);
  });
});

describe('export → read → import (in memory)', () => {
  test('round trip keeps every record, encodes audio, drops lastRoute', async () => {
    const audio = new Uint8Array(1_000_003).map((_, i) => (i * 13) & 255);
    const device = memoryAdapter({
      ...sampleStores(),
      voice: [{ id: 'v1', qid: 'DEMO-0001', blob: new Blob([audio], { type: 'audio/webm' }), mime: 'audio/webm', durationMs: 900, ts: TS }],
      media: [{ id: 'm1', qid: 'DEMO-0001', blob: new Blob([PNG_1PX], { type: 'image/png' }), mime: 'image/png', width: 1, height: 1, ts: TS }],
    });
    const { blob, filename, counts, skipped } = await exportBackup({ includeMedia: true, now: TS, dump: device.dump });
    assert.equal(filename, 'cardiac-mcq-backup-2026-10-26.json');
    assert.equal(skipped, 0);
    assert.equal(counts.settings, 1, 'lastRoute is not exported');
    assert.equal(counts.voice, 1);

    const { data, summary } = await readBackupFile(blob);
    assert.equal(summary.includesMedia, true);
    assert.equal(summary.counts.attempts, 2);
    assert.equal(data.stores.voice[0].blob, null);
    assert.equal(data.stores.voice[0].data, Buffer.from(audio).toString('base64'));

    const fresh = memoryAdapter({ settings: [{ key: 'lastRoute', value: '/library' }] });
    const result = await importBackup(data, { mode: 'replace', adapter: fresh });
    assert.equal(result.mode, 'replace');
    assert.equal(fresh.db.attempts.length, 2);
    assert.deepEqual(fresh.db.settings.find((r) => r.key === 'lastRoute').value, '/library');
    const v = fresh.db.voice[0];
    assert.ok(v.blob instanceof Blob);
    assert.deepEqual(new Uint8Array(await v.blob.arrayBuffer()), audio);
    assert.equal('data' in v, false);
  });

  test('export without media omits the voice store', async () => {
    const device = memoryAdapter(sampleStores());
    const { blob, counts } = await exportBackup({ includeMedia: false, now: TS, dump: device.dump });
    const parsed = JSON.parse(await blob.text());
    assert.equal(parsed.includesMedia, false);
    assert.equal('voice' in parsed.stores, false);
    assert.equal('voice' in counts, false);
  });

  test('an unreadable voice blob is left out and counted', async () => {
    const device = memoryAdapter({ voice: [{ id: 'v', qid: 'Q', blob: null, mime: 'audio/webm', ts: 1 }] });
    const { blob, skipped } = await exportBackup({ includeMedia: true, now: TS, dump: device.dump });
    assert.equal(skipped, 1);
    assert.deepEqual(JSON.parse(await blob.text()).stores.voice, []);
  });

  test('replace without media keeps the device voice notes', async () => {
    const stores = sampleStores();
    delete stores.voice;
    const { data } = validateBackup(sampleBackup({ includesMedia: false, stores }));
    const device = memoryAdapter({ voice: [{ id: 'mine', qid: 'Q', blob: new Blob(['x']), ts: 1 }], notes: [{ qid: 'Z', text: 'old', updated: 1 }] });
    const result = await importBackup(data, { mode: 'replace', adapter: device });
    assert.equal(result.keptVoice, true);
    assert.equal(device.db.voice.length, 1);
    assert.deepEqual(device.db.notes, stores.notes);
    assert.ok(!device.calls.some(([op, n]) => op === 'replace' && n === 'voice'));
  });

  test('images round trip byte-identical with a scene that references them', async () => {
    const big = new Uint8Array(800_001).map((_, i) => (i * 7) & 255);
    const device = memoryAdapter({
      ink: [{ id: 'DEMO-0001|scratch', qid: 'DEMO-0001', block: 'scratch', qversion: 1, strokes: [], scene: sampleScene('img'), updated: TS }],
      media: [
        { id: 'img', qid: 'DEMO-0001', blob: new Blob([big], { type: 'image/jpeg' }), mime: 'image/jpeg', width: 2048, height: 1536, bytes: big.length, ts: TS },
        { id: 'nomime', qid: 'DEMO-0002', blob: new Blob([PNG_1PX]), width: 1, height: 1, ts: TS },
      ],
    });
    const { blob, counts, skipped } = await exportBackup({ includeMedia: true, now: TS, dump: device.dump });
    assert.equal(skipped, 0);
    assert.equal(counts.media, 2);
    const { data, summary } = await readBackupFile(blob);
    assert.equal(summary.includesMedia, true);
    assert.equal(summary.counts.media, 2);
    const exported = data.stores.media.find((m) => m.id === 'img');
    assert.equal(exported.blob, null);
    assert.equal(exported.data, Buffer.from(big).toString('base64'));
    assert.equal(data.stores.media.find((m) => m.id === 'nomime').mime, 'image/png', 'default image mime');

    const fresh = memoryAdapter();
    await importBackup(data, { mode: 'replace', adapter: fresh });
    const img = fresh.db.media.find((m) => m.id === 'img');
    assert.ok(img.blob instanceof Blob);
    assert.equal(img.blob.type, 'image/jpeg');
    assert.equal(img.bytes, big.length);
    assert.deepEqual(new Uint8Array(await img.blob.arrayBuffer()), big);
    assert.equal('data' in img, false);
    assert.deepEqual(fresh.db.ink[0].scene, sampleScene('img'));
  });

  test('export without media omits voice and images; replace keeps both on the device', async () => {
    const device = memoryAdapter(sampleStores());
    const { blob, counts } = await exportBackup({ includeMedia: false, now: TS, dump: device.dump });
    const parsed = JSON.parse(await blob.text());
    assert.equal('media' in parsed.stores, false);
    assert.equal('media' in counts, false);
    const { data } = await readBackupFile(new Blob([JSON.stringify(parsed)]));
    assert.equal(data.includesMedia, false);
    const target = memoryAdapter({
      voice: [{ id: 'mine', qid: 'Q', blob: new Blob(['x']), ts: 1 }],
      media: [{ id: 'pic', qid: 'Q', blob: new Blob([PNG_1PX], { type: 'image/png' }), mime: 'image/png', width: 1, height: 1, ts: 1 }],
    });
    const result = await importBackup(data, { mode: 'replace', adapter: target });
    assert.equal(result.keptVoice, true);
    assert.equal(result.keptMedia, true);
    assert.equal(target.db.media.length, 1);
    assert.equal(target.db.voice.length, 1);
    assert.ok(!target.calls.some(([op, n]) => op === 'replace' && MEDIA_STORES.includes(n)));
  });

  test('replace with an older backup (voice, no media store) keeps device images only', async () => {
    const stores = sampleStores();
    delete stores.media;
    const { data } = validateBackup(sampleBackup({ stores }));
    const target = memoryAdapter({ media: [{ id: 'pic', qid: 'Q', blob: new Blob([PNG_1PX]), mime: 'image/png', width: 1, height: 1, ts: 1 }] });
    const result = await importBackup(data, { mode: 'replace', adapter: target });
    assert.equal(result.keptVoice, false);
    assert.equal(result.keptMedia, true);
    assert.equal(target.db.media.length, 1);
    assert.equal(target.db.voice.length, 1);
  });

  test('merge: images are added by id, newer ts wins, existing kept', async () => {
    const pic = (id, ts) => ({ id, qid: 'Q', blob: null, data: 'AAAA', mime: 'image/png', width: 1, height: 1, ts });
    const plan = planMerge('media', [pic('a', 5), pic('b', 5)], [pic('a', 9), pic('b', 1), pic('c', 1)]);
    assert.deepEqual(plan.write.map((r) => r.id).sort(), ['a', 'c']);
    assert.equal(plan.added, 1);
    assert.equal(plan.updated, 1);
    assert.equal(plan.skipped, 1);
    // Through importBackup: only the selected images are decoded and written.
    const { data } = validateBackup(sampleBackup());
    const device = memoryAdapter({ media: [{ ...pic('m1', TS + 10), blob: new Blob(['x']) }] });
    const result = await importBackup(data, { mode: 'merge', adapter: device });
    assert.deepEqual(result.stores.media, { added: 0, updated: 0, skipped: 1 });
    assert.ok(!device.calls.some(([op, n]) => op === 'merge' && n === 'media'));
  });

  test('a corrupt image fails before any write, with an image-specific message', async () => {
    const { data } = validateBackup(sampleBackup());
    data.stores.media[0] = { ...data.stores.media[0], data: '!!!!' };
    const device = memoryAdapter({ notes: [{ qid: 'Z', text: 'keep', updated: 1 }] });
    for (const mode of ['replace', 'merge']) {
      await assert.rejects(importBackup(data, { mode, adapter: device }), (err) => {
        assert.equal(err.code, 'corrupt');
        assert.match(err.userMessage, /An image in this backup is damaged/);
        return true;
      });
    }
    assert.ok(!device.calls.some(([op]) => op === 'replace' || op === 'merge'), 'no write at all');
  });

  test('a corrupt image record in the file is rejected by readBackupFile', async () => {
    const backup = sampleBackup();
    backup.stores.media[0].mime = 'text/html';
    await assert.rejects(readBackupFile(new Blob([JSON.stringify(backup)])), (err) => err.code === 'corrupt');
  });

  test('an unreadable image blob is left out and counted', async () => {
    const device = memoryAdapter({ media: [{ id: 'm', qid: 'Q', blob: null, mime: 'image/png', width: 1, height: 1, ts: 1 }] });
    const { blob, skipped } = await exportBackup({ includeMedia: true, now: TS, dump: device.dump });
    assert.equal(skipped, 1);
    assert.deepEqual(JSON.parse(await blob.text()).stores.media, []);
  });

  test('replace rolls back stores already replaced when a write fails', async () => {
    const before = { notes: [{ qid: 'Z', text: 'keep me', updated: 1 }], attempts: [{ id: 9, qid: 'Z', ts: 3, correct: true }] };
    const device = memoryAdapter(before, { failReplaceOn: 'notes' });
    const { data } = validateBackup(sampleBackup());
    await assert.rejects(importBackup(data, { mode: 'replace', adapter: device }), (err) => {
      assert.ok(err instanceof BackupError);
      assert.equal(err.code, 'quota');
      assert.match(err.userMessage, /put back as it was/);
      return true;
    });
    assert.deepEqual(device.db.attempts, before.attempts, 'attempts restored');
    assert.deepEqual(device.db.notes, before.notes, 'failing store untouched');
  });

  test('replace decodes everything before touching storage', async () => {
    const backup = sampleBackup();
    const { data } = validateBackup(backup);
    // Corrupt the audio after validation (simulates a decoder failure).
    data.stores.voice[0] = { ...data.stores.voice[0], data: '!!!!' };
    const device = memoryAdapter({ notes: [{ qid: 'Z', text: 'keep', updated: 1 }] });
    await assert.rejects(importBackup(data, { mode: 'replace', adapter: device }), (err) => err.code === 'corrupt');
    assert.equal(device.calls.length, 0, 'no storage call at all');
  });

  test('merge writes only what the plan selects and reports counts', async () => {
    const device = memoryAdapter({
      attempts: [{ id: 1, qid: 'DEMO-0001', ts: TS, correct: true }],
      notes: [{ qid: 'DEMO-0001', text: 'device newer', updated: TS + 10 }],
      settings: [{ key: 'theme', value: 'light' }],
    });
    const { data } = validateBackup(sampleBackup());
    const result = await importBackup(data, { mode: 'merge', adapter: device });
    assert.equal(device.db.attempts.length, 2);
    assert.equal(device.db.notes[0].text, 'device newer');
    assert.deepEqual(device.db.settings, [{ key: 'theme', value: 'light' }]);
    assert.ok(device.db.voice[0].blob instanceof Blob);
    assert.equal(result.stores.notes.skipped, 1);
    assert.equal(result.stores.attempts.added, 1);
    assert.ok(!device.calls.some(([op]) => op === 'replace'), 'merge never replaces');
    assert.match(importResultMessage(result), /^Backup merged: /);
  });

  test('merge failure says nothing was deleted', async () => {
    const device = memoryAdapter({}, { failMergeOn: 'notes' });
    const { data } = validateBackup(sampleBackup());
    await assert.rejects(importBackup(data, { mode: 'merge', adapter: device }), (err) => {
      assert.equal(err.code, 'import-failed');
      assert.match(err.userMessage, /nothing was deleted/);
      return true;
    });
  });

  test('importBackup validates unvalidated input and checks mode', async () => {
    await assert.rejects(importBackup({ type: 'x' }, { mode: 'merge', adapter: memoryAdapter() }), BackupError);
    await assert.rejects(importBackup(sampleBackup(), { mode: 'wipe', adapter: memoryAdapter() }), TypeError);
    const r = await importBackup(sampleBackup(), { mode: 'merge', adapter: memoryAdapter() });
    assert.ok(r.added > 0);
  });
});

describe('readBackupFile', () => {
  const file = (text) => new Blob([text], { type: 'application/json' });
  const codeOf = async (f) => {
    try {
      await readBackupFile(f);
      return 'ok';
    } catch (err) {
      assert.ok(err instanceof BackupError, String(err));
      return err.code;
    }
  };

  test('classifies bad files', async () => {
    assert.equal(await codeOf(null), 'unreadable');
    assert.equal(await codeOf(file('')), 'empty');
    assert.equal(await codeOf(file('hello')), 'not-json');
    assert.equal(await codeOf(file('{"a":')), 'not-json');
    assert.equal(await codeOf(file(JSON.stringify(sampleBackup()).slice(0, 300))), 'corrupt');
    assert.equal(await codeOf(file('{"type":"other"}')), 'wrong-type');
    assert.equal(await codeOf({ size: MAX_BACKUP_BYTES + 1, text: async () => '' }), 'too-large');
    assert.equal(await codeOf({ size: 10, text: async () => { throw new Error('denied'); } }), 'unreadable');
  });

  test('accepts a BOM and whitespace', async () => {
    assert.equal(await codeOf(file(`﻿  ${JSON.stringify(sampleBackup())}`)), 'ok');
  });
});

describe('helpers', () => {
  test('decodeMediaRecord sets bytes and rejects empty data', async () => {
    const rec = decodeMediaRecord({ id: 'm', qid: 'Q', blob: null, data: bytesToBase64(PNG_1PX), mime: 'image/png', width: 1, height: 1, bytes: 999, ts: 1 });
    assert.equal(rec.bytes, PNG_1PX.length);
    assert.equal(rec.blob.type, 'image/png');
    assert.throws(() => decodeMediaRecord({ id: 'm', data: '', mime: 'image/png' }));
  });

  test('mediaKeptText', () => {
    assert.equal(mediaKeptText(true, true), '');
    assert.match(mediaKeptText(false, false), /Voice notes and images/);
    assert.match(mediaKeptText(true, false), /^Images/);
    assert.match(mediaKeptText(false, true), /^Voice notes on/);
  });

  test('formatBytes', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(3.45 * 1024 * 1024), '3.5 MB');
    assert.equal(formatBytes(2 * 1024 ** 3), '2 GB');
  });

  test('importResultMessage', () => {
    assert.equal(importResultMessage({ mode: 'merge', added: 0, updated: 0 }), 'Nothing new in this backup — your device already had everything.');
    assert.equal(importResultMessage({ mode: 'merge', added: 1, updated: 2 }), 'Backup merged: 1 item added, 2 updated.');
    assert.equal(importResultMessage({ mode: 'replace', added: 1200 }), 'Backup restored: 1,200 items.');
  });
});
