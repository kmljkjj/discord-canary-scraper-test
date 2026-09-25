/**
 * Webhook dedupe — claim BEFORE HTTP so concurrent GHA runs cannot double-post.
 * States: pending | sent | failed
 * - pending: in-flight (stale after CLAIM_STALE_MS → re-claimable)
 * - sent: delivered OK (blocked for WINDOW_MS)
 * - failed: HTTP failed → immediately re-claimable
 * Legacy status "done" is treated as "sent".
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
// NOTIFY_DEDUPE_FILE permet aux tests d'utiliser un fichier temporaire
// (sinon ils écrasaient le vrai data/notify_dedupe.json → doubles notifications).
const DEDUPE_FILE =
  process.env.NOTIFY_DEDUPE_FILE ||
  path.join(__dirname, '..', '..', 'data', 'notify_dedupe.json');
const WINDOW_MS = 24 * 3600 * 1000;
const CLAIM_STALE_MS = 5 * 60 * 1000;

async function load() {
  try {
    if (!(await fs.pathExists(DEDUPE_FILE))) return { fps: {} };
    const d = await fs.readJson(DEDUPE_FILE);
    d.fps = d.fps || {};
    return d;
  } catch {
    return { fps: {} };
  }
}

async function save(d) {
  try {
    const cut = Date.now() - WINDOW_MS;
    for (const [k, v] of Object.entries(d.fps || {})) {
      const ts = typeof v === 'object' ? Number(v.ts || 0) : Number(v);
      if (ts < cut) delete d.fps[k];
    }
    const keys = Object.keys(d.fps || {});
    if (keys.length > 800) {
      keys
        .sort((a, b) => {
          const ta = typeof d.fps[a] === 'object' ? d.fps[a].ts : d.fps[a];
          const tb = typeof d.fps[b] === 'object' ? d.fps[b].ts : d.fps[b];
          return Number(ta) - Number(tb);
        })
        .slice(0, keys.length - 800)
        .forEach((k) => delete d.fps[k]);
    }
    await fs.ensureDir(path.dirname(DEDUPE_FILE));
    const tmp = DEDUPE_FILE + '.tmp';
    await fs.writeJson(tmp, d);
    await fs.move(tmp, DEDUPE_FILE, { overwrite: true });
  } catch (e) {
    console.warn('dedupe save fail', e.message);
  }
}

function entryTs(v) {
  if (v == null) return 0;
  if (typeof v === 'object') return Number(v.ts || 0);
  return Number(v);
}

function entryStatus(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    const s = v.status || 'sent';
    if (s === 'done') return 'sent';
    return s;
  }
  return 'sent';
}

/** True only if successfully sent within window — NOT pending/failed. */
async function wasPosted(fp) {
  try {
    const d = await load();
    const v = d.fps[fp];
    if (!v) return false;
    if (entryStatus(v) !== 'sent') return false;
    const age = Date.now() - entryTs(v);
    return age < WINDOW_MS;
  } catch {
    return false;
  }
}

/**
 * Claim fingerprint for sending.
 * Returns false if already sent (within window) or pending (not stale).
 * failed and stale pending are re-claimable.
 */
async function claimPosted(fp) {
  try {
    const d = await load();
    const v = d.fps[fp];
    if (v) {
      const age = Date.now() - entryTs(v);
      const st = entryStatus(v);
      if (st === 'sent' && age < WINDOW_MS) return false;
      if (st === 'pending' && age < CLAIM_STALE_MS) return false;
    }
    d.fps[fp] = { ts: Date.now(), status: 'pending' };
    await save(d);
    return true;
  } catch (e) {
    console.warn('claimPosted fail (allow send)', e.message);
    return true;
  }
}

async function markPosted(fp) {
  try {
    const d = await load();
    d.fps[fp] = { ts: Date.now(), status: 'sent' };
    await save(d);
  } catch (e) {
    console.warn('markPosted fail', e.message);
  }
}

async function markFailed(fp, error) {
  try {
    const d = await load();
    d.fps[fp] = {
      ts: Date.now(),
      status: 'failed',
      error: String(error || '').slice(0, 500),
    };
    await save(d);
  } catch (e) {
    console.warn('markFailed fail', e.message);
  }
}

function stableExpKey(bn, exp) {
  const pack = (arr) =>
    (arr || [])
      .map((e) => String(typeof e === 'string' ? e : e.id || ''))
      .filter(Boolean)
      .sort()
      .join(',');
  const raw = [
    'exp',
    String(bn),
    'a:' + pack(exp.added),
    'm:' + pack(exp.modified),
    'r:' + pack(exp.removed),
    'c:' + pack(exp.categoryChanged),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function stableMapKey(bn, kind, diff) {
  const ids = (o) => Object.keys(o || {}).sort().join(',');
  const raw = [
    kind,
    String(bn),
    'a:' + ids(diff.added),
    'm:' + ids(diff.modified),
    'r:' + ids(diff.removed),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

function payloadFingerprint(body) {
  const embeds = body.embeds || [];
  const core = embeds.map((e) => ({
    t: e.title || '',
    d: String(e.description || '').slice(0, 240),
    f: (e.fields || [])
      .map((x) => String(x.name || '') + ':' + String(x.value || '').slice(0, 80))
      .join('|')
      .slice(0, 400),
  }));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ u: body.username, core }))
    .digest('hex')
    .slice(0, 20);
}

module.exports = {
  wasPosted,
  markPosted,
  markFailed,
  claimPosted,
  payloadFingerprint,
  stableExpKey,
  stableMapKey,
  WINDOW_MS,
  CLAIM_STALE_MS,
};
