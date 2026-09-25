/**
 * Apex rollouts v6 — EXACT guild % (Discord wire) + optional advaith cache
 * User global % is handled by user_rollouts.js (ESTIMATED).
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'apex_rollouts.json');
const ADVAITH_CACHE = path.join(DATA_DIR, 'advaith_cache.json');
const LOCAL_EXP = path.join(DATA_DIR, 'experiments.json');
const KNOWN_EXP = path.join(DATA_DIR, 'known_experiment_ids.json');
const DEFS_URL =
  process.env.APEX_DEFS_URL ||
  'https://gist.githubusercontent.com/DiscrapperManager/05962f6137eacd9dbbc589d97c8ece3f/raw/experiments.json';
const WORKERS_URL =
  process.env.APEX_API_URL || 'https://experiments.dscrd.workers.dev/experiments';

const WEBHOOK =
  process.env.APEX_WEBHOOK_URL ||
  process.env.ROLLOUT_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;
const BOT = process.env.ORBIT_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/media/datamining-avatar.png';
const MIN_DELTA = Number(process.env.APEX_MIN_PCT_DELTA || '1');
const YEAR_MIN = Number(process.env.APEX_RECENT_YEAR || '2024');
const SCALE = 10000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function loadUserTokens() {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const s = String(t || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const part of String(process.env.DISCORD_USER_TOKENS || '').split(/[,;\n]+/)) push(part);
  for (let i = 1; i <= 10; i++) push(process.env['DISCORD_USER_TOKEN_' + i]);
  push(process.env.DISCORD_USER_TOKEN);
  push(process.env.DISCORD_TOKEN);
  return out;
}
const USER_TOKENS = loadUserTokens();

function murmur3(key, seed = 0) {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51,
    c2 = 0x1b873593;
  const bytes = Buffer.from(String(key), 'utf8');
  const len = bytes.length,
    nblocks = len >> 2;
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
  let k1 = 0,
    off = nblocks * 4,
    tail = len & 3;
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

function isRecent(id) {
  const m = String(id).match(/^(\d{4})-/);
  return m ? Number(m[1]) >= YEAR_MIN : false;
}

function rangesToPct(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return 0;
  const iv = [];
  for (const r of ranges) {
    let a, b;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      a = Number(r.s ?? r.start);
      b = Number(r.e ?? r.end);
    } else if (Array.isArray(r) && r.length >= 2) {
      a = Number(r[0]);
      b = Number(r[1]);
    } else continue;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    iv.push([a, b]);
  }
  if (!iv.length) return 0;
  iv.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged = [];
  let cs = iv[0][0],
    ce = iv[0][1];
  for (let i = 1; i < iv.length; i++) {
    const [a, b] = iv[i];
    if (a <= ce) ce = Math.max(ce, b);
    else {
      merged.push([cs, ce]);
      cs = a;
      ce = b;
    }
  }
  merged.push([cs, ce]);
  let c = 0;
  for (const [a, b] of merged) c += b - a;
  return Math.min(100, Math.round((c / SCALE) * 1000) / 10);
}

function decodeGuildWire(tuple, hashMap) {
  if (!Array.isArray(tuple) || tuple.length < 4) return null;
  const hash = tuple[0];
  const key = tuple[1];
  const revision = tuple[2];
  const pops = tuple[3] || [];
  const ovs = tuple[4] || [];
  let id =
    (typeof key === 'string' && key.trim() && key) ||
    hashMap.get(Number(hash)) ||
    hashMap.get(String(hash)) ||
    'hash:' + hash;

  const byBucket = new Map();
  for (const pop of pops) {
    if (!Array.isArray(pop)) continue;
    const positions = pop[0] || [];
    for (const pos of positions) {
      if (!Array.isArray(pos)) continue;
      const bucket = pos[0];
      const ranges = pos[1] || [];
      if (!byBucket.has(bucket)) byBucket.set(bucket, { bucket, label: tLabel(bucket), intervals: [] });
      for (const r of ranges) {
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          byBucket.get(bucket).intervals.push([Number(r.s ?? r.start), Number(r.e ?? r.end)]);
        } else if (Array.isArray(r) && r.length >= 2) {
          byBucket.get(bucket).intervals.push([Number(r[0]), Number(r[1])]);
        }
      }
    }
  }
  const treatments = [...byBucket.values()]
    .map((t) => ({
      bucket: t.bucket,
      label: t.label,
      pct: rangesToPct(t.intervals.map(([a, b]) => ({ s: a, e: b }))),
    }))
    .sort((a, b) => (a.bucket ?? 9999) - (b.bucket ?? 9999));

  let ovCount = 0;
  if (Array.isArray(ovs)) {
    for (const o of ovs) {
      if (o && typeof o === 'object') ovCount += (o.k || o.ids || []).length || 0;
      else if (Array.isArray(o)) ovCount += (o[1] || []).length || 0;
    }
  }
  const fingerprint = treatments.map((t) => t.bucket + ':' + Number(t.pct).toFixed(1)).join('|');
  return {
    id: String(id),
    type: 'guild',
    quality: 'exact',
    title: String(id),
    treatments,
    overrideIdCount: ovCount,
    populationCount: pops.length,
    fingerprint,
    revision,
    hash: Number(hash),
    recent: isRecent(id),
    source: 'discord',
    hasGlobalPct: treatments.some((t) => t.pct != null && Number.isFinite(t.pct)),
  };
}

async function buildHashMap() {
  const map = new Map();
  const addId = (id) => {
    if (!id || typeof id !== 'string') return;
    const clean = id.trim();
    if (!clean || clean.startsWith('hash:')) return;
    const h = murmur3(clean);
    map.set(h, clean);
    map.set(String(h), clean);
  };
  for (const file of [
    LOCAL_EXP,
    KNOWN_EXP,
    path.join(DATA_DIR, 'apex_experiments.json'),
    path.join(DATA_DIR, 'baseline_experiments.json'),
  ]) {
    try {
      if (!(await fs.pathExists(file))) continue;
      const data = await fs.readJson(file);
      const list = Array.isArray(data)
        ? data
        : data.experiments || data.ids || (typeof data === 'object' ? Object.keys(data) : []);
      for (const x of list) {
        if (typeof x === 'string') addId(x);
        else if (x && (x.id || x.name)) addId(String(x.id || x.name));
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
      let n = 0;
      for (const e of Array.isArray(data) ? data : data.experiments || []) {
        if (typeof e === 'string') {
          addId(e);
          n++;
        } else if (e && (e.id || e.name)) {
          addId(String(e.id || e.name));
          n++;
        }
      }
      console.log('Defs remote:', n);
    } catch (e) {
      console.warn('Defs:', e.message);
    }
  }
  console.log('Hash map:', Math.floor(map.size / 2), 'ids');
  return map;
}

function clientHeaders(token) {
  const superProps = Buffer.from(
    JSON.stringify({
      os: 'Windows',
      browser: 'Chrome',
      device: '',
      system_locale: 'en-US',
      browser_user_agent: UA,
      browser_version: '131.0.0.0',
      os_version: '10',
      release_channel: 'stable',
      client_build_number: 360000,
    }),
  ).toString('base64');
  const h = {
    'User-Agent': UA,
    Accept: '*/*',
    'X-Super-Properties': superProps,
    'X-Discord-Locale': 'en-US',
  };
  if (token) h.Authorization = token;
  return h;
}

async function fetchDiscordGuild(hashMap) {
  const urls = [
    'https://discord.com/api/v9/experiments?with_guild_experiments=true',
    'https://canary.discord.com/api/v9/experiments?with_guild_experiments=true',
  ];
  const tokens = USER_TOKENS.length ? USER_TOKENS : [null];
  console.log('User tokens:', USER_TOKENS.length);
  const byId = new Map();
  for (const token of tokens.slice(0, 5)) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: clientHeaders(token), timeout: 25000 });
        if (!res.ok) {
          console.warn('Discord', res.status, url.includes('canary') ? 'canary' : 'stable');
          continue;
        }
        const data = await res.json();
        const ge = data.guild_experiments || [];
        console.log('Discord guild_experiments:', ge.length);
        for (const t of ge) {
          const e = decodeGuildWire(t, hashMap);
          if (e && e.hasGlobalPct && !String(e.id).startsWith('hash:')) byId.set(e.id, e);
        }
        break;
      } catch (e) {
        console.warn('Discord fail', e.message);
      }
    }
  }
  return [...byId.values()];
}

async function loadAdvaithCache(hashMap) {
  if (!(await fs.pathExists(ADVAITH_CACHE))) return [];
  try {
    const data = await fs.readJson(ADVAITH_CACHE);
    const list = Array.isArray(data) ? data : data.experiments || data.data || [];
    const out = [];
    for (const raw of list) {
      if (!raw) continue;
      if (raw.data && Array.isArray(raw.data.rollout)) {
        const e = decodeGuildWire(raw.data.rollout, hashMap);
        if (e) {
          e.source = 'advaith';
          e.title = String(raw.data.title || e.id);
          if (e.hasGlobalPct) out.push(e);
        }
      }
    }
    console.log('Advaith cache:', out.length);
    return out;
  } catch (e) {
    console.warn('Advaith cache', e.message);
    return [];
  }
}

function pctKey(e) {
  return (e.treatments || [])
    .filter((t) => t && t.pct != null)
    .map((t) => t.bucket + ':' + Number(t.pct).toFixed(1))
    .sort()
    .join('|');
}

function diffExperiments(prev, next) {
  const pMap = new Map(prev.map((e) => [e.id, e]));
  const nMap = new Map(next.map((e) => [e.id, e]));
  const added = [],
    removed = [],
    changed = [];
  for (const [id, n] of nMap) {
    if (!n.hasGlobalPct || String(id).startsWith('hash:')) continue;
    const treatments = (n.treatments || []).filter((t) => t && t.pct != null);
    if (!treatments.length) continue;
    const p = pMap.get(id);
    if (!p) {
      added.push(n);
      continue;
    }
    const deltas = [];
    const pt = new Map((p.treatments || []).map((t) => [String(t.bucket ?? t.label), t]));
    let maxAbs = 0;
    for (const t of treatments) {
      const k = String(t.bucket ?? t.label);
      const old = pt.get(k);
      const from = old && old.pct != null ? Number(old.pct) : 0;
      const to = Number(t.pct);
      const d = Math.round((to - from) * 10) / 10;
      if (Math.abs(d) >= MIN_DELTA) {
        deltas.push({ label: t.label, bucket: t.bucket, from, to, delta: d });
        maxAbs = Math.max(maxAbs, Math.abs(d));
      }
    }
    if (deltas.length) changed.push({ after: n, deltas, maxAbs });
  }
  for (const [id, p] of pMap) {
    if (!nMap.has(id) && p.hasGlobalPct && !String(id).startsWith('hash:')) removed.push(p);
  }
  changed.sort((a, b) => b.maxAbs - a.maxAbs);
  return { added, changed, removed };
}

function fmtTreat(ts, max = 12) {
  const lines = (ts || [])
    .slice(0, max)
    .map((t) => '• **' + (t.label || 'Bucket ' + t.bucket) + '** · `' + t.pct + '%`');
  if ((ts || []).length > max) lines.push('_+' + (ts.length - max) + '_');
  return lines.join('\n') || '_—_';
}

function buildEmbeds(diff) {
  const embeds = [];
  for (const e of diff.added.slice(0, 8)) {
    embeds.push({
      title: '+ ' + e.id,
      description: ['**' + e.title + '**', 'Type · `guild` · **EXACT**', '', fmtTreat(e.treatments)]
        .join('\n')
        .slice(0, 4000),
      color: 0x57f287,
      footer: { text: 'EXACT · ' + (e.source || 'discord') },
    });
  }
  for (const c of diff.changed.slice(0, 10)) {
    const e = c.after;
    const lines = c.deltas.slice(0, 12).map(
      (d) =>
        '• **' +
        (d.label || 'bucket') +
        '** · `' +
        d.from +
        '%` → `' +
        d.to +
        '%` (`' +
        (d.delta > 0 ? '+' : '') +
        d.delta +
        '`)',
    );
    embeds.push({
      title: '~ ' + e.id,
      description: ['**' + e.title + '**', 'Type · `guild` · **EXACT**', '', lines.join('\n')]
        .join('\n')
        .slice(0, 4000),
      color: 0xe67e22,
      footer: { text: 'EXACT · Δ max ' + c.maxAbs + '%' },
    });
  }
  for (const e of diff.removed.slice(0, 4)) {
    embeds.push({
      title: '- ' + e.id,
      description: '**' + e.title + '** · `guild`',
      color: 0xed4245,
      footer: { text: 'Retiré' },
    });
  }
  return embeds.slice(0, 10);
}

async function postWebhook(embeds) {
  if (!WEBHOOK || !embeds.length) return { ok: false, status: 0, text: 'skip' };
  let last = { ok: true, status: 204, text: '' };
  for (let i = 0; i < embeds.length; i += 10) {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: BOT.slice(0, 80),
        avatar_url: AVATAR,
        embeds: embeds.slice(i, i + 10),
      }),
    });
    const text = await res.text().catch(() => '');
    last = { ok: res.ok, status: res.status, text: text.slice(0, 300) };
    if (!res.ok) return last;
    await new Promise((r) => setTimeout(r, 400));
  }
  return last;
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('📊 Apex rollouts v6 (EXACT guild % + stronger name map)');
  console.log('Webhook:', WEBHOOK ? 'set' : 'MISSING');
  console.log('Tokens:', USER_TOKENS.length);

  const hashMap = await buildHashMap();
  const fromDiscord = await fetchDiscordGuild(hashMap);
  const fromCache = await loadAdvaithCache(hashMap);
  const byId = new Map();
  for (const e of [...fromCache, ...fromDiscord]) {
    if (!e || !e.id || !e.hasGlobalPct) continue;
    if (String(e.id).startsWith('hash:')) continue;
    byId.set(e.id, e);
  }
  const experiments = [...byId.values()];
  console.log('Live exact:', experiments.length, {
    discord: fromDiscord.length,
    advaith: fromCache.length,
  });

  let previous = { experiments: [], announced: {} };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (_) {}
  }
  const announced =
    previous.announced && typeof previous.announced === 'object' ? { ...previous.announced } : {};
  const prev = previous.experiments || [];
  const isFirst = !prev.length;

  if (!isFirst && prev.length >= 20 && experiments.length < Math.max(5, prev.length * 0.4)) {
    console.error('APEX_DEGRADED: collection too small vs previous', {
      prev: prev.length,
      now: experiments.length,
    });
    process.exit(1);
  }

  let diff = diffExperiments(prev, experiments);
  if (!isFirst) {
    const filter = (arr, getId, getKey) =>
      arr.filter((x) => {
        const id = getId(x);
        const key = getKey(x);
        if (!id || !key) return false;
        if (announced[id] === key) return false;
        return true;
      });
    diff = {
      added: filter(diff.added, (e) => e.id, (e) => pctKey(e)),
      changed: filter(diff.changed, (c) => c.after && c.after.id, (c) => pctKey(c.after)),
      removed: diff.removed.filter((e) => e && e.id && announced[e.id] !== 'REMOVED'),
    };
  }

  console.log('Diff', {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    first: isFirst,
  });

  const compact = experiments.map((e) => ({
    id: e.id,
    type: e.type,
    title: e.title,
    fingerprint: pctKey(e),
    treatments: (e.treatments || [])
      .filter((t) => t && t.pct != null)
      .map((t) => ({ bucket: t.bucket, label: t.label, pct: Math.round(Number(t.pct) * 10) / 10 })),
    revision: e.revision,
    recent: !!e.recent,
    hash: e.hash,
    source: e.source,
    hasGlobalPct: true,
    quality: 'exact',
  }));

  async function writeState(announcedMap) {
    await fs.writeJson(
      STATE_FILE,
      {
        scrapedAt: new Date().toISOString(),
        count: compact.length,
        experiments: compact,
        announced: announcedMap,
      },
      { spaces: 2 },
    );
  }

  if (isFirst) {
    const seedAnn = { ...announced };
    for (const e of compact) {
      if (e.id && e.fingerprint) seedAnn[e.id] = e.fingerprint;
    }
    await writeState(seedAnn);
    console.log('Seed', compact.length, '- no notify');
    return;
  }

  if (!(diff.added.length || diff.changed.length || diff.removed.length)) {
    await writeState(announced);
    console.log('No significant % change');
    return;
  }

  if (!WEBHOOK) {
    await writeState(announced);
    console.warn('No webhook - state saved without advancing announced');
    return;
  }

  const embeds = buildEmbeds(diff);
  const sent = await postWebhook(embeds);
  console.log('Webhook', sent.status, sent.ok ? 'OK' : sent.text);
  if (sent.ok) {
    const nextAnn = { ...announced };
    for (const e of diff.added) if (e && e.id) nextAnn[e.id] = pctKey(e);
    for (const c of diff.changed) if (c.after && c.after.id) nextAnn[c.after.id] = pctKey(c.after);
    for (const e of diff.removed) if (e && e.id) nextAnn[e.id] = 'REMOVED';
    for (const e of compact) {
      if (e.id && e.fingerprint && nextAnn[e.id] !== 'REMOVED') {
        if (!(e.id in nextAnn) || nextAnn[e.id] === e.fingerprint) nextAnn[e.id] = e.fingerprint;
      }
    }
    await writeState(nextAnn);
    console.log('Done - announced advanced after successful webhook');
  } else {
    await writeState(announced);
    console.warn('Webhook failed - announced NOT advanced (will retry next run)');
    process.exit(2);
  }
}

if (require.main === module)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
module.exports = { main, decodeGuildWire, rangesToPct, murmur3 };
