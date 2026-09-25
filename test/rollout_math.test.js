/** Node-native tests for rollout_math — run: node test/rollout_math.test.js */
const assert = require('assert');
const {
  mergeIntervals,
  coveragePercent,
  intervalsCoverage,
  estimateFromPoints,
  classifyChange,
} = require('../src/lib/rollout_math');

function test(name, fn) {
  try {
    fn();
    console.log('ok', name);
  } catch (e) {
    console.error('FAIL', name, e.message);
    process.exitCode = 1;
  }
}

test('merge overlapping 0-20 + 15-40 → 0-40 = 41 buckets ≈ 0.41%', () => {
  const m = mergeIntervals([
    [0, 20],
    [15, 40],
  ]);
  assert.deepStrictEqual(m, [[0, 40]]);
  assert.strictEqual(intervalsCoverage(m), 41);
});

test('disjoint 0-20 + 40-60 → 42 buckets not 61', () => {
  const m = mergeIntervals([
    [0, 20],
    [40, 60],
  ]);
  assert.deepStrictEqual(m, [
    [0, 20],
    [40, 60],
  ]);
  assert.strictEqual(intervalsCoverage(m), 21 + 21);
});

test('nested 0-100 + 20-40 → 0-100', () => {
  const m = mergeIntervals([
    [0, 100],
    [20, 40],
  ]);
  assert.deepStrictEqual(m, [[0, 100]]);
});

test('adjacent inclusive 0-10 + 11-20 → 0-20', () => {
  assert.deepStrictEqual(
    mergeIntervals([
      [0, 10],
      [11, 20],
    ]),
    [[0, 20]],
  );
});

test('coveragePercent 0-2499 of 10000 = 25%', () => {
  assert.strictEqual(coveragePercent([[0, 2499]]), 25);
});

test('coveragePercent full 0-9999 = 100%', () => {
  assert.strictEqual(coveragePercent([[0, 9999]]), 100);
});

test('coveragePercent empty = 0%', () => {
  assert.strictEqual(coveragePercent([]), 0);
});

test('1% band', () => {
  // 100 buckets of 10000 = 1%
  assert.strictEqual(coveragePercent([[0, 99]]), 1);
});

test('classify 20→21 INCREASED', () => {
  const c = classifyChange(20, 21, 1);
  assert.strictEqual(c.changeType, 'ROLLOUT_INCREASED');
  assert.strictEqual(c.change, 1);
});

test('classify 50→49 DECREASED', () => {
  assert.strictEqual(classifyChange(50, 49, 1).changeType, 'ROLLOUT_DECREASED');
});

test('classify 99→100 COMPLETED', () => {
  assert.strictEqual(classifyChange(99, 100, 1).changeType, 'ROLLOUT_COMPLETED');
});

test('classify 100→0 REMOVED', () => {
  assert.strictEqual(classifyChange(100, 0, 1).changeType, 'ROLLOUT_REMOVED');
});

test('classify 50→50 ignored under minDelta', () => {
  assert.strictEqual(classifyChange(50, 50.4, 1).changeType, null);
});

test('classify null→40 STARTED', () => {
  assert.strictEqual(classifyChange(null, 40, 1).changeType, 'ROLLOUT_STARTED');
});

test('classify 40→null DATA_DEGRADED', () => {
  assert.strictEqual(classifyChange(40, null, 1).changeType, 'ROLLOUT_DATA_DEGRADED');
});

test('estimateFromPoints insufficient', () => {
  const e = estimateFromPoints([1, 2], 50);
  assert.strictEqual(e.status, 'insufficient_data');
  assert.strictEqual(e.percentage, null);
});

test('invalid intervals ignored', () => {
  assert.deepStrictEqual(mergeIntervals([[NaN, 10], [0, 5]]), [[0, 5]]);
});

if (process.exitCode) {
  console.error('Some tests failed');
  process.exit(1);
} else {
  console.log('All rollout_math tests passed');
}

// --- noiseMargin (node:test) ---
{
  const nodeTest = require('node:test');
  const a = require('node:assert/strict');
  const { noiseMargin, classifyChange: cc } = require('../src/lib/rollout_math');
  nodeTest('noiseMargin : 10 % sur 150 tirages ≈ 6,9 pts → 10→12 ignoré', () => {
    const m = noiseMargin(12, 150);
    a.ok(m > 6 && m < 8, String(m));
    a.equal(cc(10, 12, Math.max(1, m)).changeType, null);
    a.equal(cc(10, 25, Math.max(1, m)).changeType, 'ROLLOUT_INCREASED');
  });
  nodeTest('noiseMargin : plus de tirages → marge plus petite, z=0 → désactivé', () => {
    a.ok(noiseMargin(10, 1000) < noiseMargin(10, 150));
    a.equal(noiseMargin(10, 150, 0), 0);
    a.equal(noiseMargin(10, 0), 0);
    a.ok(noiseMargin(0, 150) > 0, 'plancher aux extrêmes');
  });
}
