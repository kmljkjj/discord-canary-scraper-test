/**
 * Datamining — notify (classic embeds only — reliable on all webhooks)
 * - No backticks around keys
 * - Strings/Routes: key + full text
 * - Batch dedupe marked ONLY after successful webhook post
 */
const fetch = require('node-fetch');

const BOT = process.env.ORBIT_BOT_NAME || process.env.WEBHOOK_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  process.env.WEBHOOK_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/kmljkjj/discord-canary-scraper@main/media/datamining-avatar.png';

const {
  markPosted,
  markFailed,
  claimPosted,
  payloadFingerprint,
  stableExpKey,
  stableMapKey,
} = require('./webhook_dedupe');

const COLOR = {
  build: 0x5865f2,
  added: 0x57f287,
  modified: 0xe67e22,
  removed: 0xed4245,
};

function envEmoji(key) {
  const v = (process.env[key] || '').trim();
  if (/^<a?:[\w~]+:\d+>$/.test(v)) return v;
  return '';
}

const E = {
  added: envEmoji('EMOJI_ADDED'),
  modified: envEmoji('EMOJI_MODIFIED'),
  removed: envEmoji('EMOJI_REMOVED'),
  build: envEmoji('EMOJI_BUILD'),
  exp: envEmoji('EMOJI_EXP'),
  str: envEmoji('EMOJI_STR'),
  route: envEmoji('EMOJI_ROUTE'),
};

function label(emoji, text) {
  return emoji ? `${emoji} ${text}` : text;
}

const FIELD_MAX = 1020;
const LINE_VAL_MAX = 240;
const LINE_VAL_ROUTES = 100;
const MAX_STR_LINES = 80;
const MAX_RT_LINES = 50;

async function notifyAll(opts) {
  const a = await notifyUrgent(opts);
  const b = await notifyNormal(opts);
  return a && b;
}

async function notifyUrgent({ build, expDiff, webhookUrl }) {
  if (!webhookUrl) return true;
  const bn = String(build.buildNumber || '?');
  const ts = new Date().toISOString();
  const exp = normalizeExpDiff(expDiff);
  const nExp =
    exp.added.length + exp.modified.length + exp.removed.length + (exp.categoryChanged || []).length;
  if (!nExp) {
    console.log('Urgent: no experiment diff');
    return true;
  }
  return sendExperiments(webhookUrl, bn, exp, ts);
}

async function notifyNormal({ build, strDiff, rtDiff, webhookUrl }) {
  if (!webhookUrl) return true;
  const bn = String(build.buildNumber || '?');
  const ts = new Date().toISOString();
  const str = normalizeMapDiff(strDiff);
  const rt = normalizeMapDiff(rtDiff);
  const nStr =
    Object.keys(str.added).length +
    Object.keys(str.modified).length +
    Object.keys(str.removed).length;
  const nRt =
    Object.keys(rt.added).length +
    Object.keys(rt.modified).length +
    Object.keys(rt.removed).length;

  let ok = true;
  if (nStr) {
    const r = await sendMapDiff(webhookUrl, bn, str, ts, 'Strings');
    if (!r) ok = false;
  }
  if (nRt) {
    const r = await sendMapDiff(webhookUrl, bn, rt, ts, 'Routes');
    if (!r) ok = false;
  }
  return ok;
}

function normalizeExpDiff(diff) {
  if (diff && (diff.added || diff.modified || diff.removed || diff.categoryChanged)) {
    return {
      added: Array.isArray(diff.added) ? diff.added : [],
      modified: Array.isArray(diff.modified) ? diff.modified : [],
      removed: Array.isArray(diff.removed) ? diff.removed : [],
      categoryChanged: Array.isArray(diff.categoryChanged)
        ? diff.categoryChanged
        : [],
    };
  }
  return { added: [], modified: [], removed: [], categoryChanged: [] };
}

function normalizeMapDiff(diff) {
  if (diff && (diff.added || diff.modified || diff.removed)) {
    return {
      added: diff.added && typeof diff.added === 'object' ? diff.added : {},
      modified:
        diff.modified && typeof diff.modified === 'object' ? diff.modified : {},
      removed:
        diff.removed && typeof diff.removed === 'object' ? diff.removed : {},
    };
  }
  return { added: {}, modified: {}, removed: {} };
}

function cleanText(s, max = LINE_VAL_MAX) {
  return String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function stringLine(prefix, key, value, maxVal) {
  const k = String(key || '').replace(/`/g, "'");
  const v = cleanText(value, maxVal);
  if (!v) return `${prefix} ${k}`;
  return `${prefix} ${k}: ${v}`;
}

function routeLine(prefix, key, value) {
  const k = String(key || '').replace(/`/g, "'");
  const v = cleanText(value, LINE_VAL_ROUTES);
  if (!v) return `${prefix} ${k}`;
  return `${prefix} ${k} → ${v}`;
}

function expLine(e, prefix) {
  const id = typeof e === 'string' ? e : e.id;
  const kind = (e && (e.type || e.kind)) || 'user';
  const system =
    (e && e.system) || (e && e.treatments ? 'legacy' : 'apex');
  const labelTxt = e && e.label ? cleanText(e.label, 80) : null;

  let nVar = null;
  if (e && Array.isArray(e.treatments) && e.treatments.length)
    nVar = e.treatments.length;
  else if (e && e.variations && typeof e.variations === 'object')
    nVar = Object.keys(e.variations).length;
  else if (e && e.variationCount) nVar = e.variationCount;

  let line = `${prefix} ${id}`;
  const meta = [];
  if (kind) meta.push(`Type ${kind}`);
  if (system) meta.push(system);
  if (nVar != null)
    meta.push(`${nVar} variation${nVar === 1 ? '' : 's'}`);
  let pct = null;
  const k = String(kind || '').toLowerCase();
  if ((k === 'guild' || k === 'server') && e && e.guildPercentage && e.guildPercentage.status !== 'unknown') {
    pct = e.guildPercentage;
  } else if (k === 'user' && e && e.userPercentage && e.userPercentage.status !== 'unknown') {
    pct = e.userPercentage;
  } else if (e && e.guildPercentage && e.guildPercentage.status !== 'unknown') {
    pct = e.guildPercentage;
  } else if (e && e.userPercentage && e.userPercentage.status !== 'unknown') {
    pct = e.userPercentage;
  }
  if (pct && pct.value != null) {
    meta.push(`${pct.value}% (${pct.status})`);
  }
  if (meta.length) line += `\n${meta.join(' · ')}`;
  if (labelTxt) line += `\n${labelTxt}`;
  return line;
}

function chunkLines(lines, maxLen = FIELD_MAX) {
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + (buf.length ? 1 : 0);
    if (len + add > maxLen && buf.length) {
      chunks.push(buf.join('\n'));
      buf = [line];
      len = line.length;
    } else {
      buf.push(line);
      len += add;
    }
  }
  if (buf.length) chunks.push(buf.join('\n'));
  return chunks;
}

async function sendSectionEmbeds({ webhookUrl, title, bn, ts, sections }) {
  let ok = true;
  for (const sec of sections) {
    if (!sec.lines.length) continue;
    const chunks = chunkLines(sec.lines, FIELD_MAX);
    const embeds = [];

    const firstFields = chunks.slice(0, 5).map((c, i) => ({
      name: i === 0 ? sec.label : `… (${i + 1})`,
      value: String(c).slice(0, FIELD_MAX),
      inline: false,
    }));

    embeds.push({
      author: { name: BOT, icon_url: AVATAR },
      title,
      description: `Build ${bn} · **${sec.count}**`,
      fields: firstFields,
      color: sec.color,
      footer: { text: `Build ${bn} · Datamining` },
      timestamp: ts,
    });

    let offset = 5;
    while (offset < chunks.length && embeds.length < 8) {
      const slice = chunks.slice(offset, offset + 5);
      embeds.push({
        title: `${title} · suite`,
        fields: slice.map((c, i) => ({
          name: `… (${offset + i + 1})`,
          value: String(c).slice(0, FIELD_MAX),
          inline: false,
        })),
        color: sec.color,
        footer: { text: `Build ${bn} · Datamining` },
        timestamp: ts,
      });
      offset += 5;
    }

    for (let i = 0; i < embeds.length; i += 5) {
      const r = await post(webhookUrl, { embeds: embeds.slice(i, i + 5) });
      if (!r) ok = false;
    }
  }
  return ok;
}

async function sendExperiments(webhookUrl, bn, exp, ts) {
  const batchKey = 'expbatch:' + stableExpKey(bn, exp);
  if (!(await claimPosted(batchKey))) {
    console.log('Experiments batch CLAIM skip', batchKey);
    return true;
  }

  const sections = [];

  if (exp.added.length) {
    const lines = exp.added.slice(0, 40).map((e) => expLine(e, '+'));
    if (exp.added.length > 40)
      lines.push(`… +${exp.added.length - 40} more`);
    sections.push({
      label: label(E.added, `Added · ${exp.added.length}`),
      color: COLOR.added,
      count: exp.added.length,
      lines,
    });
  }
  if (exp.modified.length) {
    const lines = exp.modified.slice(0, 40).map((e) => expLine(e, '~'));
    if (exp.modified.length > 40)
      lines.push(`… +${exp.modified.length - 40} more`);
    sections.push({
      label: label(E.modified, `Modified · ${exp.modified.length}`),
      color: COLOR.modified,
      count: exp.modified.length,
      lines,
    });
  }
  if ((exp.categoryChanged || []).length) {
    const lines = exp.categoryChanged.slice(0, 40).map((e) => {
      const id = e.id || '?';
      const from = e.from || '?';
      const to = e.to || e.kind || '?';
      return `~ ${id} · ${from} → ${to}`;
    });
    if (exp.categoryChanged.length > 40)
      lines.push(`… +${exp.categoryChanged.length - 40} more`);
    sections.push({
      label: label(E.modified, `Category · ${exp.categoryChanged.length}`),
      color: COLOR.modified,
      count: exp.categoryChanged.length,
      lines,
    });
  }
  if (exp.removed.length) {
    const lines = exp.removed.slice(0, 40).map((e) => {
      const id = typeof e === 'string' ? e : e.id;
      return `- ${id}`;
    });
    if (exp.removed.length > 40)
      lines.push(`… +${exp.removed.length - 40} more`);
    sections.push({
      label: label(E.removed, `Removed · ${exp.removed.length}`),
      color: COLOR.removed,
      count: exp.removed.length,
      lines,
    });
  }

  const ok = await sendSectionEmbeds({
    webhookUrl,
    title: label(E.exp, 'Experiments'),
    bn,
    ts,
    sections,
  });

  // Only lock the batch after a successful send (or nothing to send)
  if (ok) await markPosted(batchKey);
  else {
    console.warn('Experiments webhook failed — batch NOT locked');
    await markFailed(batchKey, 'experiments batch send failed');
  }

  console.log('Sent experiments', {
    ok,
    added: exp.added.length,
    modified: exp.modified.length,
    removed: exp.removed.length,
    categoryChanged: (exp.categoryChanged || []).length,
  });
  return ok;
}

async function sendMapDiff(webhookUrl, bn, diff, ts, kind) {
  const batchKey = 'mapbatch:' + stableMapKey(bn, kind, diff);
  if (!(await claimPosted(batchKey))) {
    console.log(kind, 'batch CLAIM skip', batchKey);
    return true;
  }

  const isRoutes = kind === 'Routes';
  const a = Object.keys(diff.added);
  const m = Object.keys(diff.modified);
  const r = Object.keys(diff.removed);
  const sections = [];
  const kindEmoji = isRoutes ? E.route : E.str;
  const maxLines = isRoutes ? MAX_RT_LINES : MAX_STR_LINES;
  const maxVal = isRoutes ? LINE_VAL_ROUTES : LINE_VAL_MAX;

  if (a.length) {
    const lines = a.slice(0, maxLines).map((k) =>
      isRoutes
        ? routeLine('+', k, diff.added[k])
        : stringLine('+', k, diff.added[k], maxVal),
    );
    if (a.length > maxLines) lines.push(`… +${a.length - maxLines} more`);
    sections.push({
      label: label(E.added, `Added · ${a.length}`),
      color: COLOR.added,
      count: a.length,
      lines,
    });
  }

  if (m.length) {
    const lines = m.slice(0, maxLines).map((k) =>
      isRoutes
        ? routeLine('~', k, diff.modified[k])
        : stringLine('~', k, diff.modified[k], maxVal),
    );
    if (m.length > maxLines) lines.push(`… +${m.length - maxLines} more`);
    sections.push({
      label: label(E.modified, `Modified · ${m.length}`),
      color: COLOR.modified,
      count: m.length,
      lines,
    });
  }

  if (r.length) {
    const lines = r.slice(0, maxLines).map((k) =>
      isRoutes
        ? routeLine('-', k, diff.removed[k])
        : stringLine('-', k, diff.removed[k], maxVal),
    );
    if (r.length > maxLines) lines.push(`… +${r.length - maxLines} more`);
    sections.push({
      label: label(E.removed, `Removed · ${r.length}`),
      color: COLOR.removed,
      count: r.length,
      lines,
    });
  }

  const ok = await sendSectionEmbeds({
    webhookUrl,
    title: label(kindEmoji, kind),
    bn,
    ts,
    sections,
  });

  if (ok) await markPosted(batchKey);
  else {
    console.warn(kind, 'webhook failed — batch NOT locked');
    await markFailed(batchKey, kind + ' batch send failed');
  }

  console.log('Sent', kind, {
    ok,
    added: a.length,
    modified: m.length,
    removed: r.length,
  });
  return ok;
}

async function post(url, body) {
  body.username = BOT;
  body.avatar_url = AVATAR;
  const fp = payloadFingerprint(body);
  if (!(await claimPosted(fp))) {
    console.log('webhook CLAIM skip', body.embeds?.[0]?.title || fp);
    return true;
  }
  const payload = JSON.stringify(body);
  let lastErr = null;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        timeout: 20000,
      });
      console.log('webhook', res.status, body.embeds?.[0]?.title || '');
      if (res.ok) {
        await markPosted(fp);
        await sleep(80);
        return true;
      }
      const text = await res.text();
      lastErr = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after') || 0);
        const delay = retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** attempt;
        console.warn('webhook retry', attempt + 1, lastErr, 'wait', delay);
        await sleep(delay);
        continue;
      }
      console.warn('webhook fail', lastErr);
      await markFailed(fp, lastErr);
      return false;
    } catch (e) {
      lastErr = e.message;
      console.warn('webhook error', e.message, 'attempt', attempt + 1);
      await sleep(400 * 2 ** attempt);
    }
  }
  console.warn('webhook gave up', lastErr);
  await markFailed(fp, lastErr);
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { notifyAll, notifyUrgent, notifyNormal, post };
