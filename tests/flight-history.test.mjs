import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_LIMIT, HISTORY_STORAGE_KEY, addFlight, loadHistory, parseHistory, saveHistory, seedHref } from '../docs/flight-history.mjs';
import { MUTE_STORAGE_KEY } from '../docs/audio.mjs';
import { MAX_SEED } from '../docs/obstacle-generator.mjs';
import { memoryStorage } from './fake-audio.mjs';

const BEST_KEY = 'flappyBatBest';
const flights = (n) => Array.from({ length: n }, (_, i) => ({ score: i, seed: 1000 + i }));

test('storage key and limit: a new key, apart from the best score and mute keys', () => {
  assert.equal(HISTORY_STORAGE_KEY, 'flappyBatRecent');
  assert.notEqual(HISTORY_STORAGE_KEY, BEST_KEY);
  assert.notEqual(HISTORY_STORAGE_KEY, MUTE_STORAGE_KEY);
  assert.equal(HISTORY_LIMIT, 5);
});

test('addFlight puts the newest flight first and does not change its input', () => {
  const empty = [];
  const one = addFlight(empty, { score: 3, seed: 11 });
  const two = addFlight(one, { score: 0, seed: 22 });
  const three = addFlight(two, { score: 9, seed: MAX_SEED });
  assert.deepEqual(empty, []);
  assert.deepEqual(one, [{ score: 3, seed: 11 }]);
  assert.deepEqual(two, [{ score: 0, seed: 22 }, { score: 3, seed: 11 }]);
  assert.deepEqual(three, [{ score: 9, seed: MAX_SEED }, { score: 0, seed: 22 }, { score: 3, seed: 11 }]);
  assert.notEqual(three, two, 'a new array');
});

test('addFlight keeps five: the sixth flight drops the oldest', () => {
  let history = [];
  for (let i = 1; i <= 5; i++) history = addFlight(history, { score: i, seed: i });
  assert.deepEqual(history.map((f) => f.score), [5, 4, 3, 2, 1]);
  const before = structuredClone(history);
  const sixth = addFlight(history, { score: 6, seed: 6 });
  assert.deepEqual(sixth.map((f) => f.score), [6, 5, 4, 3, 2], 'flight 1 (the oldest) is gone');
  assert.equal(sixth.length, HISTORY_LIMIT);
  assert.deepEqual(history, before, 'the input history is unchanged');
});

test('addFlight keeps only score and seed and ignores an invalid flight', () => {
  assert.deepEqual(addFlight([], { score: 2, seed: 5, extra: '<b>x</b>' }), [{ score: 2, seed: 5 }]);
  const history = [{ score: 1, seed: 1 }];
  for (const bad of [null, { score: -1, seed: 1 }, { score: 1.5, seed: 1 }, { score: 1, seed: MAX_SEED + 1 }, { score: '1', seed: 1 }]) {
    assert.deepEqual(addFlight(history, bad), history);
  }
});

test('parseHistory reads a stored history and its round trip through saveHistory', () => {
  const storage = memoryStorage();
  const history = flights(3);
  assert.equal(saveHistory(() => storage, history), true);
  assert.deepEqual(JSON.parse(storage.getItem(HISTORY_STORAGE_KEY)), history);
  assert.deepEqual(parseHistory(storage.getItem(HISTORY_STORAGE_KEY)), history);
  assert.deepEqual(loadHistory(() => storage), history);
});

test('parseHistory gives an empty history for a missing, broken or non-array value', () => {
  for (const raw of [null, undefined, '', '{', 'not json', '[{"score":1', '{"score":1,"seed":2}', '"text"', '42', 'null', 'true']) {
    assert.deepEqual(parseHistory(raw), [], JSON.stringify(raw));
  }
});

test('parseHistory drops each invalid record and keeps only integers', () => {
  const valid = { score: 4, seed: 40 };
  const invalid = [
    null, 7, 'x', [], {}, { score: 1 }, { seed: 1 },
    { score: -1, seed: 1 }, { score: 1.5, seed: 1 }, { score: 1, seed: 2.5 }, { score: 1, seed: -1 },
    { score: 1, seed: MAX_SEED + 1 }, { score: 2 ** 53, seed: 1 },
    { score: '3', seed: 1 }, { score: 1, seed: '<img src=x onerror=alert(1)>' },
    { score: '<script>alert(1)</script>', seed: 1 },
  ];
  const raw = JSON.stringify([...invalid.slice(0, 8), valid, ...invalid.slice(8)]);
  assert.deepEqual(parseHistory(raw), [valid], 'only the valid record is left');
  assert.deepEqual(parseHistory(JSON.stringify(invalid)), [], 'no valid record gives an empty history');
  assert.deepEqual(parseHistory('[{"score":1e400,"seed":1}]'), [], 'Infinity is not a score');
  assert.deepEqual(parseHistory(JSON.stringify([{ score: 0, seed: 0 }, { score: 12, seed: MAX_SEED }])), [{ score: 0, seed: 0 }, { score: 12, seed: MAX_SEED }], 'range ends are valid');
  assert.deepEqual(parseHistory(JSON.stringify([{ score: 1, seed: 2, html: '<b>' }])), [{ score: 1, seed: 2 }], 'extra fields are dropped');
});

test('parseHistory keeps at most five records, the newest (first) ones', () => {
  const stored = flights(8);
  assert.deepEqual(parseHistory(JSON.stringify(stored)), stored.slice(0, 5));
});

test('loadHistory: a throwing getStorage, a throwing getItem or no storage gives an empty history', () => {
  const throwing = () => { throw new DOMException('blocked', 'SecurityError'); };
  assert.deepEqual(loadHistory(throwing), []);
  assert.deepEqual(loadHistory(() => ({ getItem: throwing, setItem() {} })), []);
  assert.deepEqual(loadHistory(() => null), []);
  assert.deepEqual(loadHistory(() => memoryStorage({ [HISTORY_STORAGE_KEY]: '{broken' })), []);
});

test('saveHistory: a throwing getStorage or setItem returns false without throwing', () => {
  const throwing = () => { throw new DOMException('full', 'QuotaExceededError'); };
  const history = flights(2);
  assert.equal(saveHistory(throwing, history), false);
  assert.equal(saveHistory(() => ({ getItem: () => null, setItem: throwing }), history), false);
  assert.equal(saveHistory(() => null, history), false);
  assert.deepEqual(history, flights(2), 'the in-memory history is kept as it was');
  // The game goes on with the memory history: the next flight is still added.
  assert.deepEqual(addFlight(history, { score: 7, seed: 70 })[0], { score: 7, seed: 70 });
});

test('saveHistory writes only the new key; the best score and mute values stay', () => {
  const storage = memoryStorage({ [BEST_KEY]: '12', [MUTE_STORAGE_KEY]: '1' });
  let history = [];
  for (let i = 0; i < 7; i++) {
    history = addFlight(history, { score: i, seed: i * 3 });
    saveHistory(() => storage, history);
  }
  assert.deepEqual([...storage.map.keys()].sort(), [BEST_KEY, HISTORY_STORAGE_KEY, MUTE_STORAGE_KEY].sort());
  assert.equal(storage.getItem(BEST_KEY), '12');
  assert.equal(storage.getItem(MUTE_STORAGE_KEY), '1');
  assert.deepEqual(JSON.parse(storage.getItem(HISTORY_STORAGE_KEY)).map((f) => f.score), [6, 5, 4, 3, 2]);
});

test('seedHref sets only the seed and keeps the other query parameters', () => {
  assert.equal(seedHref('', 42), '?seed=42');
  assert.equal(seedHref('?seed=7', 42), '?seed=42');
  assert.equal(seedHref('?debug=1&seed=7', MAX_SEED), `?debug=1&seed=${MAX_SEED}`);
  assert.equal(seedHref('?a=%3Cb%3E', 0), '?a=%3Cb%3E&seed=0');
});
