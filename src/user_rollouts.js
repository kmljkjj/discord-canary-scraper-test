/**
 * User experiment rollouts v8 — ESTIMATED only (honest sampling)
 *
 * Fixes vs previous:
 *  - No more samples/totalSamples as "true %"
 *  - No forced 500-boundary invention as primary truth
 *  - Stronger hash→id map (known ids + experiments + baseline + remote defs)
 *  - Skip notify for unresolved hash:… (or mark clearly)
 *  - announced map anti-spam
 *  - Confidence gate (min samples / ok rate)
 *  - TRANSACTIONAL: announced only advanced AFTER successful webhook
 *    (experiments snapshot still saved for next-run deltas; notify fail → exit 2)
 *
 * Env:
 *   DISCORD_USER_TOKEN(S) / DISCORD_USER_TOKEN_1..5
 *   APEX_WEBHOOK_URL | ROLLOUT_WEBHOOK_URL | DISCORD_WEBHOOK_URL
 *   USER_ROLLOUT_SAMPLES       default 80
 *   USER_ROLLOUT_CONCURRENCY   default 2
 *   USER_ROLLOUT_DELAY_MS      default 300
 *   APEX_MIN_PCT_DELTA         default 3
 *   USER_ROLLOUT_NOTIFY_HASH   default 0 (do not notify unknown hash names)
 *   USER_ROLLOUT_MIN_OK        default 25 (min successful samples before any %)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { sendEmbeds } = require('./lib/webhook');
const {
  mergeIntervals,
  estimateFromPoints,
  classifyChange,
  noiseMargin,
  stableChangeFingerprint,
  DEFAULT_SCALE,
} = require('./lib/rollout_math');

const DATA = path.join(__dirname, '..', 'data');
const STATE = path.join(DATA, 'user_rollouts.json');
const KNOWN = path.join(DATA, 'known_experiment_ids.json');
const EXPS = path.join(DATA, 'experiments.json');
const BASELINE = path.join(DATA, 'baseline_experiments.json');
const APEX_EXP = path.join(DATA, 'apex_experiments.json');

function loadTokens() {
  const out = [];
  const push = (t) => {
    const s = String(t || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  const multi = process.env.DISCORD_USER_TOKENS || '';
  if (multi) multi.split(/[,\n;]+/).forEach(push);
  push(process.env.DISCORD_USER_TOKEN);
  push(process.env.DISCORD_TOKEN);
  for (let i = 1; i <= 8; i++) {
    push(process.env['DISCORD_USER_TOKEN_' + i]);
    push(process.env['DISCORD_USER_TOKENS' + i]);
  }
  return out;
}

const TOKENS = loadTokens();
const WEBHOOK =
  process.env.APEX_WEBHOOK_URL ||
  process.env.ROLLOUT_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;
const SAMPLES = Math.max(20, Math.min(400, Number(process.env.USER_ROLLOUT_SAMPLES || 80)));
const CONC = Math.max(1, Math.min(4, Number(process.env.USER_ROLLOUT_CONCURRENCY || 2)));
const DELAY_MS = Math.max(80, Math.min(5000, Number(process.env.USER_ROLLOUT_DELAY_MS || 300)));
const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || 1);
const MIN_OK = Math.max(10, Number(process.env.USER_ROLLOUT_MIN_OK || 25));
const NOTIFY_HASH = String(process.env.USER_ROLLOUT_NOTIFY_HASH || '0') === '1';
// z du seuil de bruit statistique (0 = désactivé). Évite les annonces 10 % → 12 % → 10 %.
const NOISE_Z = Math.max(0, Number(process.env.USER_ROLLOUT_NOISE_Z ?? 2));
const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/media/datamining-avatar.png';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SCALE = DEFAULT_SCALE;
const DEFS_URL =
  process.env.APEX_DEFS_URL ||
  'https://gist.githubusercontent.com/DiscrapperManager/05962f6137eacd9dbbc589d97c8ece3f/raw/experiments.json';
const WORKERS_URL =
  process.env.APEX_API_URL || 'https://experiments.dscrd.workers.dev/experiments';

function redactSecrets(msg) {
  return String(msg || '')
    .replace(/[\w-]{20,}\.[\w-]{5,}\.[\w-]{10,}/g, '[REDACTED_JWT]')
    .replace(/mfa\.[\w-]{20,}/gi, '[REDACTED_TOKEN]')
    .replace(/Bot\s+[\w.-]{20,}/gi, 'Bot [REDACTED]');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function murmur3(key, seed = 0) {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const bytes = Buffer.from(String(key), 'utf8');
  const len = bytes.length;
  const nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    let k1 =
      bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
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

function tLabel(bucket) {
  const b = Number(bucket);
  if (b === -1) return 'None';
  if (b === 0) return 'Control';
  return 'Variant ' + b;
}

async function loadHashMap() {
  const map = new Map();
  const add = (id, type, title) => {
    if (!id || typeof id !== 'string') return;
    const clean = id.trim();
    if (!clean || clean.startsWith('hash:')) return;
    const h = murmur3(clean);
    if (!map.has(h)) {
      map.set(h, { id: clean, type: type || 'user', title: title || clean });
    }
  };

  for (const f of [EXPS, BASELINE, KNOWN, APEX_EXP]) {
    if (!(await fs.pathExists(f))) continue;
    try {
      const j = await fs.readJson(f);
      const arr = Array.isArray(j)
        ? j
        : j.experiments || j.ids || (typeof j === 'object' ? Object.keys(j) : []);
      for (const e of arr) {
        if (typeof e === 'string') add(e, 'user');
        else if (e && (e.id || e.name)) {
          add(String(e.id || e.name), e.type || e.kind || 'user', e.title || e.label || e.id);
        }
      }
    } catch (_) {}
  }

  for (const url of [DEFS_URL, WORKERS_URL]) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        timeout: 20000,
      });
      if (!res.ok) continue;
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.experiments || [];
      let n = 0;
      for (const e of list) {
        if (typeof e === 'string') {
          add(e, 'user');
          n++;
        } else if (e && (e.id || e.name)) {
          add(String(e.id || e.name), e.type || 'user', e.title || e.label);
          n++;
        }
      }
      console.log('Remote defs', url.split('/').slice(-2).join('/'), n);
    } catch (e) {
      console.warn('Remote defs fail', e.message);
    }
  }

  console.log('Hash map:', map.size, 'ids');
  return map;
}

async function fetchAssignments(extraHeaders = {}, attempt = 0) {
  const res = await fetch('https://canary.discord.com/api/v10/experiments', {
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      'Cache-Control': 'no-cache',
      ...extraHeaders,
    },
    timeout: 25000,
  });
  if (res.status === 429 && attempt < 4) {
    const ra = Number(
      res.headers.get('retry-after') || res.headers.get('x-ratelimit-reset-after') || 2,
    );
    const wait = Math.min(30, Math.max(1, ra)) * 1000 + attempt * 500;
    console.warn('429 → wait', Math.round(wait / 1000) + 's');
    await sleep(wait);
    return fetchAssignments(extraHeaders, attempt + 1);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return {
    fingerprint: data.fingerprint,
    assignments: Array.isArray(data.assignments) ? data.assignments : [],
  };
}

async function sampleFingerprints(n, concurrency) {
  const byHash = new Map();
  let ok = 0;
  let fail = 0;
  let consecutive429 = 0;
  let next = 0;

  async function worker() {
    while (true) {
      const my = next++;
      if (my >= n) break;
      if (consecutive429 > 10) {
        fail++;
        continue;
      }
      try {
        await sleep(DELAY_MS + Math.floor(Math.random() * 100));
        const { assignments } = await fetchAssignments({
          'X-Request-Id': crypto.randomBytes(16).toString('hex'),
        });
        consecutive429 = 0;
        for (const a of assignments) {
          if (!Array.isArray(a) || a.length < 6) continue;
          const hash = Number(a[0]);
          const bucket = Number(a[2]);
          const hr = Number(a[5]);
          if (!Number.isFinite(hash) || !Number.isFinite(hr)) continue;
          if (!byHash.has(hash)) byHash.set(hash, new Map());
          const bm = byHash.get(hash);
          if (!bm.has(bucket)) bm.set(bucket, []);
          bm.get(bucket).push(hr);
        }
        ok++;
      } catch (e) {
        fail++;
        if (String(e.message).includes('429')) consecutive429++;
        if (fail <= 6) console.warn('sample fail', e.message);
        if (consecutive429 > 3) await sleep(3500);
      }
      if (my && my % 25 === 0) console.log('  sampled', my, '/', n, 'ok', ok);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  console.log('Samples ok', ok, 'fail', fail, 'hashes', byHash.size);
  return { byHash, ok, fail };
}

function rangesToTreatments(bucketMap, totalOk) {
  const treatments = [];
  let coveredAll = 0;
  for (const [bucket, hrs] of bucketMap) {
    if (!hrs || !hrs.length) continue;
    const est = estimateFromPoints(hrs, totalOk, SCALE);
    coveredAll += Math.round((est.coverage || 0) * SCALE);
    treatments.push({
      bucket: Number(bucket),
      label: tLabel(bucket),
      percentage: est.percentage,
      pct: est.percentage,
      pctKnown: est.percentage != null && est.status !== 'insufficient_data',
      status: est.status,
      confidence: est.confidence,
      sampleCount: est.sampleCount,
      samples: est.sampleCount,
      coverage: est.coverage,
      intervals: est.ranges,
      ranges: est.ranges,
      observed: est.observed,
      gapFill: est.gapFill,
      sourceKind: est.sourceKind || 'estimated_from_samples',
    });
  }
  treatments.sort((a, b) => a.bucket - b.bucket);
  const sumPct = treatments.reduce(
    (s, t) => s + (t.pctKnown && t.pct != null ? t.pct : 0),
    0,
  );
  let globalStatus = 'estimated';
  if (treatments.every((t) => t.status === 'insufficient_data')) globalStatus = 'insufficient_data';
  else if (
    treatments.some((t) => t.status === 'degraded' || t.status === 'unknown') ||
    sumPct > 105
  )
    globalStatus = 'degraded';
  const conf =
    totalOk > 0
      ? Math.min(
          1,
          treatments.reduce((s, t) => s + t.sampleCount, 0) /
            (totalOk * Math.max(1, treatments.length)),
        )
      : 0;
  return {
    treatments,
    conf,
    status: globalStatus,
    coverage: Math.round((Math.min(coveredAll, SCALE) / SCALE) * 1000) / 1000,
    sumPct: Math.round(sumPct * 100) / 100,
  };
}

function fingerprintOf(treatments) {
  return treatments
    .map((t) => {
      if (!t.pctKnown || t.pct == null || t.status === 'insufficient_data') {
        return t.bucket + ':?';
      }
      const step = t.confidence === 'low' ? 5 : 1;
      const rounded = Math.round(Number(t.pct) / step) * step;
      return t.bucket + ':' + rounded.toFixed(1);
    })
    .sort()
    .join('|');
}

async function fetchTokenSnapshot(hashMap) {
  if (!TOKENS.length) return [];
  const out = [];
  for (const token of TOKENS.slice(0, 5)) {
    try {
      // fetchAssignments gère les 429 (Retry-After) — avant : 1 seul essai, perdu après l'échantillonnage
      const data = await fetchAssignments({ Authorization: token });
      for (const a of data.assignments || []) {
        if (!Array.isArray(a) || a.length < 3) continue;
        const hash = Number(a[0]);
        const meta = hashMap.get(hash) || {
          id: 'hash:' + hash,
          type: 'user',
          title: 'hash:' + hash,
        };
        out.push({
          hash,
          id: meta.id,
          title: meta.title,
          type: meta.type,
          revision: a[1],
          bucket: a[2],
          hash_result: a[5],
        });
      }
      await sleep(400);
    } catch (e) {
      console.warn('Token snapshot fail:', redactSecrets(e.message));
    }
  }
  return out;
}

function buildEmbeds(changes) {
  const embeds = [];
  for (const c of changes.slice(0, 10)) {
    if (c.kind === 'new') {
      const lines = (c.treatments || []).slice(0, 10).map((t) => {
        const band =
          t.observed && t.observed.length === 2
            ? ' · observed `' + t.observed[0] + '–' + t.observed[1] + '`'
            : '';
        const pct = t.pctKnown && t.pct != null ? '`≈' + t.pct + '%`' : '`?%`';
        const st = t.status && t.status !== 'estimated' ? ' · `' + t.status + '`' : '';
        const confL = t.confidence ? ' · conf `' + t.confidence + '`' : '';
        return '• **' + t.label + '** · ' + pct + st + confL + ' · n=' + (t.sampleCount || t.samples || 0) + band;
      });
      embeds.push({
        title: '+ ' + c.id,
        description: [
          '**' + c.title + '**',
          'Type · `user` · **ESTIMATED** (sampling)',
          '',
          lines.join('\n') || '_no treatments_',
        ]
          .join('\n')
          .slice(0, 4000),
        color: 0x57f287,
        footer: { text: 'user sampling · not exact Discord %' },
      });
    } else if (c.kind === 'pct') {
      const lines = (c.deltas || []).slice(0, 12).map((d) => {
        return '• **' + d.label + '** · `' + d.from + '%` → `' + d.to + '%` (est.)';
      });
      embeds.push({
        title: '~ ' + c.id,
        description: [
          '**' + c.title + '**',
          'Type · `user` · **ESTIMATED**',
          '',
          lines.join('\n'),
        ]
          .join('\n')
          .slice(0, 4000),
        color: 0xe67e22,
        footer: { text: 'user sampling · noise possible' },
      });
    } else if (c.kind === 'revision') {
      embeds.push({
        title: '~ ' + c.id + ' revision',
        description:
          '**' +
          c.title +
          '**\nRevision `' +
          c.fromRev +
          '` → `' +
          c.toRev +
          '` · bucket `' +
          c.bucket +
          '`',
        color: 0x5865f2,
        footer: { text: 'assignment revision' },
      });
    }
  }
  return embeds;
}

async function postWebhook(embeds) {
  if (!WEBHOOK || !embeds.length) return { ok: false, status: 0, text: 'skip' };
  return sendEmbeds(
    WEBHOOK,
    { username: BOT.slice(0, 80), avatar_url: AVATAR },
    embeds,
    { label: 'user-rollouts' },
  );
}

function hasName(id) {
  return id && !String(id).startsWith('hash:');
}

async function main() {
  await fs.ensureDir(DATA);
  console.log('📊 User rollouts v8 (ESTIMATED, honest)');
  console.log('Samples:', SAMPLES, 'concurrency:', CONC, 'tokens:', TOKENS.length);
  console.log('Webhook:', WEBHOOK ? 'set' : 'MISSING');
  console.log('Notify unresolved hash:', NOTIFY_HASH ? 'yes' : 'no');

  const hashMap = await loadHashMap();
  const { byHash, ok, fail } = await sampleFingerprints(SAMPLES, CONC);

  if (ok < MIN_OK) {
    console.warn('Too few ok samples', ok, '<', MIN_OK, '— skip estimates (avoid noise)');
  }

  const experiments = [];
  for (const [hash, bucketMap] of byHash) {
    if (ok < MIN_OK) continue;
    const meta = hashMap.get(hash) || {
      id: 'hash:' + hash,
      type: 'user',
      title: 'hash:' + hash,
    };
    const { treatments, conf, status: rollStatus, coverage: rollCov, sumPct } =
      rangesToTreatments(bucketMap, ok);
    if (!treatments.length) continue;
    const nObs = treatments.reduce((s, t) => s + (t.sampleCount || t.samples || 0), 0);
    if (nObs < 3) continue;
    const quality =
      rollStatus === 'estimated'
        ? 'estimated'
        : rollStatus === 'degraded'
          ? 'degraded'
          : 'insufficient_data';
    experiments.push({
      hash,
      id: meta.id,
      title: meta.title,
      type: 'user',
      quality,
      status: rollStatus,
      confidence: Math.round(conf * 1000) / 1000,
      coverage: rollCov,
      sumPct,
      treatments,
      fingerprint: fingerprintOf(treatments),
      source: 'fingerprint-sample',
      named: hasName(meta.id),
    });
  }
  console.log(
    'Estimated user experiments:',
    experiments.length,
    'named',
    experiments.filter((e) => e.named).length,
  );

  const tokenSnap = await fetchTokenSnapshot(hashMap);

  let prev = { experiments: [], token: [], announced: {} };
  if (await fs.pathExists(STATE)) {
    try {
      prev = await fs.readJson(STATE);
    } catch (_) {}
  }
  const announced = prev.announced && typeof prev.announced === 'object' ? { ...prev.announced } : {};
  const isFirst = !(prev.experiments && prev.experiments.length);

  const changes = [];
  if (!isFirst) {
    const pMap = new Map((prev.experiments || []).map((e) => [String(e.hash || e.id), e]));
    for (const n of experiments) {
      if (!n.named && !NOTIFY_HASH) continue;

      const key = String(n.hash);
      const fp = n.fingerprint;
      if (announced[key] === fp) continue;

      const p = pMap.get(key) || pMap.get(n.id);
      if (!p) {
        if (n.status === 'insufficient_data' || n.status === 'unknown') continue;
        changes.push({ kind: 'new', ...n });
        continue;
      }
      if (p.fingerprint === n.fingerprint) continue;
      const deltas = [];
      const pt = new Map((p.treatments || []).map((t) => [t.bucket, t]));
      if (n.status === 'degraded' || n.status === 'insufficient_data' || n.status === 'unknown') {
        continue;
      }
      if (p.status === 'degraded' || p.status === 'insufficient_data') {
        continue;
      }
      for (const t of n.treatments || []) {
        if (!t.pctKnown || t.pct == null) continue;
        if (t.status === 'degraded' || t.status === 'insufficient_data') continue;
        const oldT = pt.get(t.bucket);
        if (!oldT || !oldT.pctKnown || oldT.pct == null) continue;
        const from = Number(oldT.pct);
        const to = Number(t.pct);
        // Estimation par échantillonnage : ignorer les écarts sous la marge de bruit
        const n = Math.min(Number(t.sampleCount || t.samples || 0), Number(oldT.sampleCount || oldT.samples || 0)) || Number(t.sampleCount || 0);
        const margin = t.status === 'estimated' ? noiseMargin(Math.max(from, to), n, NOISE_Z) : 0;
        const { changeType, change } = classifyChange(from, to, Math.max(MIN_DELTA, margin));
        if (!changeType || changeType === 'ROLLOUT_DATA_DEGRADED') continue;
        deltas.push({
          label: t.label,
          bucket: t.bucket,
          from,
          to,
          change,
          changeType,
          observed: t.observed,
          ranges: t.intervals || t.ranges || null,
          confidence: t.confidence,
          status: t.status,
          population: 'user',
          treatment: t.label,
        });
      }
      if (deltas.length) {
        const fp = stableChangeFingerprint({
          id: n.id,
          deltas: deltas.map((d) => [d.bucket, d.from, d.to, d.changeType]),
        });
        changes.push({
          kind: 'pct',
          id: n.id,
          title: n.title,
          deltas,
          named: n.named,
          changeFingerprint: fp,
        });
      }
    }

    const prevTok = new Map((prev.token || []).map((t) => [t.hash, t]));
    for (const t of tokenSnap) {
      if (!hasName(t.id) && !NOTIFY_HASH) continue;
      const p = prevTok.get(t.hash);
      if (p && p.revision !== t.revision) {
        changes.push({
          kind: 'revision',
          id: t.id,
          title: t.title,
          fromRev: p.revision,
          toRev: t.revision,
          bucket: t.bucket,
        });
      }
    }
  }

  async function writeState(announcedMap, extra = {}) {
    const prevHist = Array.isArray(prev.history) ? prev.history : [];
    const histEntry = {
      ts: new Date().toISOString(),
      ok,
      fail,
      experimentCount: experiments.length,
      changeCount: (extra.changes && extra.changes.length) || 0,
    };
    const history = [...prevHist, histEntry].slice(-40);
    await fs.writeJson(
      STATE,
      {
        scrapedAt: new Date().toISOString(),
        version: 8,
        schemaVersion: 8,
        runId:
          extra.runId ||
          new Date().toISOString().replace(/[:.]/g, '-') +
            '_' +
            Math.random().toString(36).slice(2, 8),
        samples: SAMPLES,
        ok,
        fail,
        tokensConfigured: TOKENS.length,
        experiments,
        token: tokenSnap,
        announced: announcedMap,
        history,
        lastChanges: extra.changes || prev.lastChanges || [],
      },
      { spaces: 2 },
    );
  }

  // First run: seed experiments + announced fingerprints WITHOUT webhooks (no flood).
  if (isFirst) {
    const seedAnnounced = { ...announced };
    for (const e of experiments) {
      if (e.named || NOTIFY_HASH) seedAnnounced[String(e.hash)] = e.fingerprint;
    }
    await writeState(seedAnnounced);
    console.log('Seed', experiments.length, '· no notify');
    return;
  }

  // Persist current estimates for next-run deltas, but keep PREV announced.
  // Never advance anti-spam locks before a successful webhook.
  await writeState(announced);

  console.log('Changes', changes.length);
  if (!changes.length) {
    console.log('No significant named user % change');
    return;
  }

  const embeds = buildEmbeds(changes);
  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);

  if (!sent.ok) {
    console.warn(
      'NOTIFY_FAIL user_rollouts — announced NOT advanced; will retry next run',
    );
    process.exitCode = 2;
    return;
  }

  // Success only: lock fingerprints for notified changes
  for (const c of changes) {
    if (c.kind === 'new' && c.hash != null && c.fingerprint) {
      announced[String(c.hash)] = c.fingerprint;
    }
    if (c.kind === 'pct' && c.id) {
      const exp = experiments.find((e) => e.id === c.id);
      if (exp) announced[String(exp.hash)] = exp.fingerprint;
    }
    // revision: no fingerprint lock — re-check next run if needed
  }
  await writeState(announced);
  console.log('✅ Done (announced advanced after webhook OK)');
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });

module.exports = { main, murmur3, loadHashMap, rangesToTreatments, classifyChange, mergeIntervals };
