/**
 * Discord experiment rollout position (user).
 * Official formula (docs.discord.food):
 *   position = murmur3_32("exp_name:user_id") % 10000
 * Range 0..9999 used against population position ranges.
 * Guild experiments hash guild id the same way — not the clicking user.
 */
function murmur3(key, seed = 0) {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const bytes = Buffer.from(String(key), 'utf8');
  const len = bytes.length;
  const nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    let k1 =
      bytes[i * 4] |
      (bytes[i * 4 + 1] << 8) |
      (bytes[i * 4 + 2] << 16) |
      (bytes[i * 4 + 3] << 24);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }
  let k1 = 0;
  const off = nblocks * 4;
  const tail = len & 3;
  if (tail === 3) k1 ^= bytes[off + 2] << 16;
  if (tail >= 2) k1 ^= bytes[off + 1] << 8;
  if (tail >= 1) {
    k1 ^= bytes[off];
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

/** @returns {number} 0..9999 */
function rolloutPosition(expName, resourceId) {
  const key = String(expName || '') + ':' + String(resourceId || '');
  return murmur3(key) % 10000;
}

function treatmentFromRanges(position, treatments) {
  if (!Array.isArray(treatments)) return null;
  const p = Number(position);
  for (const t of treatments) {
    const a = Number(t.min);
    const b = Number(t.max);
    if (Number.isFinite(a) && Number.isFinite(b) && p >= a && p <= b) {
      return t.label || t.name || ('bucket ' + (t.bucket != null ? t.bucket : '?'));
    }
  }
  return null;
}

function bucketCalculatorUrl(expName) {
  const base =
    process.env.BUCKET_CALC_URL ||
    'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper-test@main/public/bucket.html';
  const u = new URL(base);
  if (expName) u.searchParams.set('exp', String(expName));
  return u.toString();
}

/** Discord link button (works on webhooks — no bot interaction endpoint needed). */
function userHashButtonRow(expName) {
  const name = String(expName || '').slice(0, 80);
  if (!name || name.startsWith('hash:')) return null;
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 5,
        label: 'Mon hash / bucket',
        url: bucketCalculatorUrl(name),
      },
    ],
  };
}

module.exports = {
  murmur3,
  rolloutPosition,
  treatmentFromRanges,
  bucketCalculatorUrl,
  userHashButtonRow,
};
