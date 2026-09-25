/**
 * Discord Mobile Version Tracker — PAUSED
 * Set MOBILE_VERSIONS_PAUSED=0 to re-enable notifications.
 */

const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { sendWebhook } = require('./lib/webhook');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'mobile_versions.json');
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || null;

// ── PAUSE ─────────────────────────────────────────────
// true = no version scrape notifications (requested)
const PAUSED =
  process.env.MOBILE_VERSIONS_PAUSED === '1' ||
  process.env.MOBILE_VERSIONS_PAUSED === 'true';
// ──────────────────────────────────────────────────────

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IOS_APP_ID = '985746746';
const BOT_NAME = process.env.ORBIT_BOT_NAME || 'Datamining';
const BOT_AVATAR =
  process.env.ORBIT_BOT_AVATAR ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

function parseVersion(v) {
  const parts = String(v)
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((x) => parseInt(x, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function cmpVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function channelKey(c) {
  return `${c.platform}/${c.channel}`;
}

function versionFingerprint(c) {
  if (!c || !c.version) return null;
  return `${c.platform}|${c.channel}|${c.version}`;
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    timeout: 22000,
    headers: { 'User-Agent': UA, Accept: '*/*', ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

async function fetchJson(url, opts = {}) {
  return JSON.parse(await fetchText(url, opts));
}

async function postWebhook(payload) {
  if (!WEBHOOK_URL) return false;
  const body = {
    username: BOT_NAME,
    avatar_url: BOT_AVATAR,
    ...payload,
  };
  const r = await sendWebhook(WEBHOOK_URL, body, { label: 'mobile', timeoutMs: 30000, minGapMs: 400 });
  if (r.ok) {
    console.log('Webhook OK');
    return true;
  }
  if (r.status >= 400 && r.status < 500 && r.status !== 429) {
    throw new Error('Webhook HTTP ' + r.status);
  }
  throw new Error('Webhook failed after retries');
}

async function iosStable() {
  const data = await fetchJson(
    `https://itunes.apple.com/lookup?id=${IOS_APP_ID}&country=us`,
  );
  const r = data.results?.[0];
  if (!r) throw new Error('iTunes: no result');
  return {
    platform: 'ios',
    channel: 'stable',
    version: r.version,
    build: null,
    releaseDate: r.currentVersionReleaseDate || null,
    releaseNotes: (r.releaseNotes || '').slice(0, 400) || null,
    storeUrl: r.trackViewUrl || `https://apps.apple.com/app/id${IOS_APP_ID}`,
    source: 'itunes_lookup',
    available: true,
  };
}

async function probeOta(platform, centerMajor) {
  const found = [];
  const seen = new Set();
  const majors = [];
  for (let m = centerMajor + 15; m >= Math.max(180, centerMajor - 12); m--)
    majors.push(m);
  const minors =
    platform === 'android'
      ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 21, 22, 25, 30]
      : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 20];

  let emptyMajors = 0;
  for (const major of majors) {
    let hits = 0;
    const batchSize = 6;
    for (let i = 0; i < minors.length; i += batchSize) {
      const slice = minors.slice(i, i + batchSize);
      const results = await Promise.all(
        slice.map(async (minor) => {
          const version = `${major}.${minor}`;
          try {
            const data = await fetchJson(
              `https://discord.com/${platform}/${version}/manifest.json`,
            );
            const meta = data.metadata || data || {};
            return {
              version,
              build:
                meta.build != null
                  ? String(meta.build)
                  : meta.native_build != null
                    ? String(meta.native_build)
                    : null,
              commit: meta.commit || null,
              releaseName: meta.release_name || null,
            };
          } catch {
            return null;
          }
        }),
      );
      for (const r of results) {
        if (!r || seen.has(r.version)) continue;
        seen.add(r.version);
        found.push(r);
        hits++;
      }
    }
    if (hits === 0) {
      emptyMajors++;
      if (found.length && emptyMajors >= 3) break;
    } else emptyMajors = 0;
  }
  found.sort((a, b) => cmpVersion(b.version, a.version));
  return found;
}

async function androidFromStores() {
  const sources = [
    {
      name: 'apkcombo',
      url: 'https://apkcombo.com/discord/com.discord/',
      patterns: [
        /softwareVersion["'\s:>]+(\d+\.\d+(?:\.\d+)?)/i,
        /itemprop=["']version["'][^>]*content=["'](\d+\.\d+(?:\.\d+)?)["']/i,
        /(?:Version|version)[^\d]{0,40}(\d{2,3}\.\d+(?:\.\d+)?)/,
      ],
    },
    {
      name: 'apkpure',
      url: 'https://apkpure.com/discord-talk-chat-hang-out/com.discord',
      patterns: [
        /(\d{2,3}\.\d+\.\d+)\s*<\/span>/,
        /version["'\s:>]+(\d{2,3}\.\d+(?:\.\d+)?)/i,
      ],
    },
    {
      name: 'play_html',
      url: 'https://play.google.com/store/apps/details?id=com.discord&hl=en&gl=US',
      patterns: [
        /\[\[\["(\d+\.\d+\.\d+)"\]/,
        /Current Version[^\d]{0,80}(\d+\.\d+(?:\.\d+)?)/i,
      ],
    },
  ];

  for (const src of sources) {
    try {
      const html = await fetchText(src.url);
      for (const re of src.patterns) {
        const m = html.match(re);
        if (m && /^\d{2,3}\./.test(m[1])) {
          return {
            platform: 'android',
            channel: 'stable',
            version: m[1],
            build: null,
            source: src.name,
            storeUrl: 'https://play.google.com/store/apps/details?id=com.discord',
            available: true,
          };
        }
      }
    } catch (e) {
      console.warn(src.name, e.message);
    }
  }
  return null;
}

async function collectAll() {
  const checkedAt = new Date().toISOString();
  const channels = [];
  const otaIndex = { ios: [], android: [] };

  let iosS;
  try {
    iosS = await iosStable();
    channels.push({ ...iosS, checkedAt });
    console.log('iOS stable', iosS.version);
  } catch (e) {
    console.warn('iOS stable fail', e.message);
    channels.push({
      platform: 'ios',
      channel: 'stable',
      version: null,
      available: false,
      note: e.message,
      checkedAt,
    });
  }

  const centerMajor = iosS ? parseVersion(iosS.version)[0] : 340;

  try {
    const iosOta = await probeOta('ios', centerMajor);
    otaIndex.ios = iosOta.slice(0, 30);
    const latest = iosOta[0];
    if (latest) {
      const newerThanStore =
        iosS && cmpVersion(latest.version, iosS.version) > 0;
      if (newerThanStore) {
        channels.push({
          platform: 'ios',
          channel: 'beta',
          version: latest.version,
          build: latest.build,
          commit: latest.commit,
          source: 'discord_ota_manifest',
          storeUrl: 'https://testflight.apple.com/join/gdE4pRzI',
          available: true,
          note: 'OTA newer than App Store stable',
          checkedAt,
        });
      } else {
        channels.push({
          platform: 'ios',
          channel: 'beta',
          version: null,
          available: false,
          note: 'OTA not ahead of App Store',
          checkedAt,
        });
      }
      console.log('iOS OTA latest', latest.version, latest.build);
    }
  } catch (e) {
    console.warn('iOS OTA fail', e.message);
    channels.push({
      platform: 'ios',
      channel: 'beta',
      version: null,
      available: false,
      note: e.message,
      checkedAt,
    });
  }

  let androidOtaLatest = null;
  try {
    const andOta = await probeOta('android', centerMajor);
    otaIndex.android = andOta.slice(0, 40);
    androidOtaLatest = andOta[0] || null;
    if (androidOtaLatest) {
      console.log('Android OTA latest', androidOtaLatest.version, androidOtaLatest.build);
    }
  } catch (e) {
    console.warn('Android OTA fail', e.message);
  }

  let androidStore = null;
  try {
    androidStore = await androidFromStores();
    if (androidStore) console.log('Android store', androidStore.version, androidStore.source);
  } catch (e) {
    console.warn('Android store fail', e.message);
  }

  let androidStable = null;
  if (androidOtaLatest && androidStore) {
    const cmp = cmpVersion(androidOtaLatest.version, androidStore.version);
    if (cmp >= 0) {
      androidStable = {
        platform: 'android',
        channel: 'stable',
        version: androidOtaLatest.version,
        build: androidOtaLatest.build,
        commit: androidOtaLatest.commit,
        releaseName: androidOtaLatest.releaseName,
        source: 'discord_ota_manifest',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.discord',
        available: true,
        checkedAt,
      };
    } else {
      androidStable = { ...androidStore, checkedAt };
    }
  } else if (androidOtaLatest) {
    androidStable = {
      platform: 'android',
      channel: 'stable',
      version: androidOtaLatest.version,
      build: androidOtaLatest.build,
      commit: androidOtaLatest.commit,
      releaseName: androidOtaLatest.releaseName,
      source: 'discord_ota_manifest',
      storeUrl: 'https://play.google.com/store/apps/details?id=com.discord',
      available: true,
      checkedAt,
    };
  } else if (androidStore) {
    androidStable = { ...androidStore, checkedAt };
  } else {
    androidStable = {
      platform: 'android',
      channel: 'stable',
      version: null,
      available: false,
      note: 'No public Android version source',
      checkedAt,
    };
  }
  channels.push(androidStable);

  const higher =
    androidOtaLatest && androidStable?.version
      ? otaIndex.android.filter(
          (x) => cmpVersion(x.version, androidStable.version) > 0,
        )
      : [];
  if (higher.length) {
    channels.push({
      platform: 'android',
      channel: 'alpha',
      version: higher[0].version,
      build: higher[0].build,
      commit: higher[0].commit,
      source: 'discord_ota_manifest',
      available: true,
      note: 'OTA version ahead of selected stable',
      checkedAt,
    });
  } else {
    channels.push({
      platform: 'android',
      channel: 'beta',
      version: null,
      available: false,
      note: 'Play beta not public',
      checkedAt,
    });
    channels.push({
      platform: 'android',
      channel: 'alpha',
      version: null,
      available: false,
      note: 'Play alpha not public',
      checkedAt,
    });
  }

  return { scrapedAt: checkedAt, channels, otaIndex };
}

function detectChanges(previous, snapshot) {
  const changes = [];
  const notified = new Set((previous?.notifiedFingerprints || []).map(String));
  const prevMap = new Map();
  for (const c of previous?.channels || []) {
    if (c && c.version) prevMap.set(channelKey(c), c);
  }

  for (const c of snapshot.channels) {
    if (!c.version) continue;
    const key = channelKey(c);
    const fp = versionFingerprint(c);
    if (!fp) continue;
    if (notified.has(fp)) continue;

    const prev = prevMap.get(key);
    if (!prev || !prev.version) {
      changes.push({ type: 'new', channel: c, previous: null, fp });
      continue;
    }
    if (cmpVersion(c.version, prev.version) > 0) {
      changes.push({ type: 'updated', channel: c, previous: prev, fp });
    }
  }

  return { changes, notified };
}

function colorFor(channel) {
  if (channel === 'alpha') return 0xed4245;
  if (channel === 'beta') return 0xfee75c;
  return 0x5865f2;
}

async function notify(changes) {
  if (!WEBHOOK_URL || !changes.length) return;

  const summaryLines = changes.map((ch) => {
    const c = ch.channel;
    const arrow =
      ch.type === 'updated' && ch.previous
        ? `${ch.previous.version} → **${c.version}**`
        : `**${c.version}**`;
    return `• **${c.platform}/${c.channel}** ${arrow}${c.build ? ` · build \`${c.build}\`` : ''}`;
  });

  await postWebhook({
    embeds: [
      {
        title: 'New Discord Mobile Build',
        description: summaryLines.join('\n'),
        color: 0x5865f2,
        footer: { text: 'Mobile · versions' },
        timestamp: new Date().toISOString(),
      },
    ],
  });

  for (const ch of changes) {
    const c = ch.channel;
    const lines = [
      `**${c.platform.toUpperCase()}** · \`${c.channel}\``,
      ch.type === 'updated'
        ? `* ${ch.previous.version} → **${c.version}**`
        : `* Version **${c.version}**`,
    ];
    if (c.build) lines.push(`* Build **${c.build}**`);
    if (c.commit) lines.push(`* Commit \`${String(c.commit).slice(0, 12)}\``);
    if (c.releaseName) lines.push(`* \`${c.releaseName}\``);
    if (c.source) lines.push(`Source: **${c.source}**`);
    if (c.releaseDate) lines.push(`Released: ${c.releaseDate}`);
    if (c.note) lines.push(c.note.slice(0, 180));
    if (c.storeUrl) lines.push(c.storeUrl);

    await postWebhook({
      embeds: [
        {
          title: `Mobile ${c.platform.toUpperCase()} · ${c.channel}`,
          description: lines.join('\n'),
          color: colorFor(c.channel),
          footer: { text: `Mobile · ${c.platform} · ${c.channel}` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }
}

async function main() {
  if (PAUSED) {
    console.log('=== Mobile Versions ===');
    console.log('PAUSED — no scrape / no webhooks');
    console.log('Set MOBILE_VERSIONS_PAUSED=0 to re-enable');
    console.log('=== Mobile versions done (paused) ===');
    return;
  }

  await fs.ensureDir(DATA_DIR);
  let previous = null;
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch {}
  }

  console.log('=== Mobile Versions ===');
  const snapshot = await collectAll();

  const hadPriorState =
    previous &&
    ((previous.notifiedFingerprints && previous.notifiedFingerprints.length) ||
      (previous.channels || []).some((c) => c && c.version));

  const { changes, notified } = detectChanges(previous, snapshot);

  for (const fp of previous?.notifiedFingerprints || []) {
    notified.add(String(fp));
  }

  const history = previous?.history || [];
  const willNotify = hadPriorState && changes.length > 0 && !!WEBHOOK_URL;

  for (const c of snapshot.channels) {
    console.log(
      `  ${c.platform}/${c.channel}: ${c.version || 'n/a'}${c.build ? ` [${c.build}]` : ''}`,
    );
  }
  console.log(
    'Candidates:',
    changes.length,
    '| hadPriorState:',
    !!hadPriorState,
    '| prior fingerprints:',
    notified.size,
  );

  if (!hadPriorState) {
    console.log('Seed run - no webhook; recording fingerprints');
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  } else if (willNotify) {
    try {
      await notify(changes);
    } catch (e) {
      snapshot.history = history.slice(0, 100);
      snapshot.previousScrapedAt = previous?.scrapedAt || null;
      snapshot.notifiedFingerprints = [...notified].sort().slice(-2000);
      snapshot.changes = [];
      snapshot.paused = false;
      snapshot.notifyOk = false;
      await fs.writeJson(STATE_FILE, snapshot, { spaces: 2 });
      console.warn('NOTIFY_FAIL:', e.message, '- fingerprints NOT advanced');
      process.exit(2);
    }
    for (const ch of changes) {
      if (ch.fp) notified.add(ch.fp);
      history.unshift({
        at: snapshot.scrapedAt,
        key: channelKey(ch.channel),
        from: ch.previous?.version || null,
        to: ch.channel.version,
        build: ch.channel.build || null,
      });
    }
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  } else {
    console.log('No version bumps - no webhook');
    for (const c of snapshot.channels) {
      const fp = versionFingerprint(c);
      if (fp) notified.add(fp);
    }
  }

  snapshot.history = history.slice(0, 100);
  snapshot.previousScrapedAt = previous?.scrapedAt || null;
  snapshot.notifiedFingerprints = [...notified].sort().slice(-2000);
  snapshot.changes = willNotify
    ? changes.map((c) => ({
        type: c.type,
        key: channelKey(c.channel),
        from: c.previous?.version || null,
        to: c.channel.version,
        build: c.channel.build || null,
      }))
    : [];
  snapshot.paused = false;
  snapshot.notifyOk = true;

  await fs.writeJson(STATE_FILE, snapshot, { spaces: 2 });
  console.log('=== Mobile versions done ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
