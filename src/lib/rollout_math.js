/**
 * Pure rollout interval math — no I/O, no tokens.
 * SCALE is Discord-style hash bucket space (0 .. SCALE-1).
 */

const DEFAULT_SCALE = 10000;

function mergeIntervals(intervals) {
  if (!intervals || !intervals.length) return [];
  const sorted = intervals
    .map((pair) => {
      const a = Number(pair[0]);
      const b = Number(pair[1]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return [Math.min(a, b), Math.max(a, b)];
    })
    .filter(Boolean)
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  if (!sorted.length) return [];
  const out = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    // inclusive adjacency: [0,10]+[11,20] → [0,20]
    if (s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

function intervalsCoverage(intervals, scale = DEFAULT_SCALE) {
  const merged = mergeIntervals(intervals);
  const raw = merged.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
  return Math.min(scale, Math.max(0, raw));
}

function coveragePercent(intervals, scale = DEFAULT_SCALE) {
  if (!scale || scale <= 0) return null;
  const cov = intervalsCoverage(intervals, scale);
  return Math.round((cov / scale) * 10000) / 100;
}

/** Discrete observed points → intervals with gap-fill, then merge. */
function pointsToIntervals(points, gapFill, scale = DEFAULT_SCALE) {
  const gap = Math.max(1, Number(gapFill) || 1);
  const pts = [
    ...new Set(
      (points || [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= 0 && n < scale),
    ),
  ].sort((a, b) => a - b);
  if (!pts.length) return [];
  const intervals = [];
  let start = pts[0];
  let prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i] - prev <= gap) prev = pts[i];
    else {
      intervals.push([start, prev]);
      start = prev = pts[i];
    }
  }
  intervals.push([start, prev]);
  return mergeIntervals(intervals);
}

function estimateFromPoints(points, totalOk, scale = DEFAULT_SCALE) {
  const samples = (points || []).length;
  if (samples < 3) {
    return {
      percentage: null,
      status: 'insufficient_data',
      confidence: 'low',
      coverage: 0,
      sampleCount: samples,
      ranges: [],
      observed: null,
    };
  }
  const gapFill = Math.max(
    1,
    Math.min(80, Math.floor(scale / Math.max(totalOk * 2, 40))),
  );
  const ranges = pointsToIntervals(points, gapFill, scale);
  const covered = intervalsCoverage(ranges, scale);
  const percentage = Math.min(
    100,
    Math.max(0, Math.round((covered / scale) * 10000) / 100),
  );
  const nums = points.map(Number).filter(Number.isFinite);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = Math.max(1, max - min + 1);
  const density = samples / span;
  let confidence = 'low';
  if (samples >= 30 && density >= 0.02) confidence = 'high';
  else if (samples >= 12) confidence = 'medium';
  const status =
    confidence === 'low' || samples < 8 ? 'degraded' : 'estimated';
  return {
    percentage,
    status,
    confidence,
    coverage: Math.round((covered / scale) * 1000) / 1000,
    sampleCount: samples,
    ranges,
    observed: [min, max],
    gapFill,
    sourceKind: 'estimated_from_samples',
  };
}

/**
 * Marge de bruit (en points de %) pour la différence entre deux estimations
 * indépendantes faites chacune sur `samples` tirages.
 * z * sqrt(2 · p(1-p) / n) · 100  (z = 2 ≈ 95 %).
 * Ex. p = 10 %, n = 150 → ≈ 6,9 pts : un passage 10 % → 12 % est du bruit.
 */
function noiseMargin(pct, samples, z = 2) {
  const n = Number(samples);
  const p = Number(pct) / 100;
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(p) || z <= 0) return 0;
  const q = Math.min(1, Math.max(0, p));
  // plancher à 1/n pour ne pas annuler la marge aux extrêmes (0 % / 100 %)
  const v = Math.max(q * (1 - q), 1 / n);
  return Math.round(z * Math.sqrt((2 * v) / n) * 10000) / 100;
}

/** Classify old→new percentage (null-safe). minDelta in percent points. */
function classifyChange(oldPct, newPct, minDelta = 1) {
  const o = oldPct == null || !Number.isFinite(Number(oldPct)) ? null : Number(oldPct);
  const n = newPct == null || !Number.isFinite(Number(newPct)) ? null : Number(newPct);
  if (o == null && n == null) return { changeType: null, change: null };
  if (o == null && n != null) {
    if (n <= 0) return { changeType: 'ROLLOUT_STARTED', change: n };
    if (n >= 100) return { changeType: 'ROLLOUT_COMPLETED', change: n };
    return { changeType: 'ROLLOUT_STARTED', change: n };
  }
  if (o != null && n == null) {
    return { changeType: 'ROLLOUT_DATA_DEGRADED', change: null };
  }
  const delta = Math.round((n - o) * 100) / 100;
  if (Math.abs(delta) < minDelta) return { changeType: null, change: 0 };
  if (o > 0 && n <= 0) return { changeType: 'ROLLOUT_REMOVED', change: delta };
  if (o < 100 && n >= 100) return { changeType: 'ROLLOUT_COMPLETED', change: delta };
  if (delta > 0) return { changeType: 'ROLLOUT_INCREASED', change: delta };
  if (delta < 0) return { changeType: 'ROLLOUT_DECREASED', change: delta };
  return { changeType: 'ROLLOUT_CHANGED', change: delta };
}

function stableChangeFingerprint(parts) {
  const crypto = require('crypto');
  const payload = JSON.stringify(parts, Object.keys(parts).sort());
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function normalizeRanges(ranges) {
  return mergeIntervals(ranges || []).map(([a, b]) => [a, b]);
}

module.exports = {
  noiseMargin,
  DEFAULT_SCALE,
  mergeIntervals,
  intervalsCoverage,
  coveragePercent,
  pointsToIntervals,
  estimateFromPoints,
  classifyChange,
  stableChangeFingerprint,
  normalizeRanges,
};
