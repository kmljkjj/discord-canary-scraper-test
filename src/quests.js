/**
 * Suivi des quêtes Discord — Components V2 (média + layout)
 *
 * - flags IS_COMPONENTS_V2 (32768)
 * - Container + TextDisplay + Separator + MediaGallery + link buttons
 * - Vidéo / images CDN dans MediaGallery (plus seulement un lien)
 * - Webhook: ?with_components=true
 *
 * Fallback: embed classique si V2 refuse le payload
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const { sendWebhook } = require('./lib/webhook');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'quests.json');

const WEBHOOK =
  process.env.QUEST_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;
const DISCORD_TOKEN =
  process.env.DISCORD_TOKEN ||
  process.env.DISCORD_USER_TOKEN ||
  process.env.DISCORD_USER_TOKEN_1 ||
  null;
const PUBLIC_QUESTS_URL = 'https://api.discordquest.com/api/quests';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BOT_NAME =
  process.env.ORBIT_BOT_NAME || process.env.WEBHOOK_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  process.env.WEBHOOK_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f50d.png';

const CDN = 'https://cdn.discordapp.com/';
const IS_COMPONENTS_V2 = 1 << 15; // 32768

function assetUrl(questId, filename) {
  if (!filename) return null;
  if (/^https?:\/\//i.test(filename)) return filename;
  if (/^quests\//i.test(filename)) return CDN + filename.replace(/^\//, '');
  if (questId) return CDN + 'quests/' + questId + '/' + filename.replace(/^\//, '');
  return CDN + filename.replace(/^\//, '');
}

function rewardTypeFr(type) {
  const map = {
    1: 'Récompense en jeu',
    2: 'Collectible',
    3: 'Monnaie virtuelle',
    4: 'Orbes',
    5: 'Fraction d\'orbes',
    6: 'Décoration de profil',
    7: 'Effet de profil',
    8: 'Avatar / décoration',
  };
  return map[type] || 'Type ' + type;
}

function formatDurationSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 60) return n + ' s';
  const m = Math.floor(n / 60);
  const s = n % 60;
  if (s === 0) return m + ' min';
  return m + ' min ' + s + ' s';
}

function taskLabelFr(key, val) {
  const raw = String(
    (val && (val.type || val.event_name || val.task_name)) || key || '',
  ).toUpperCase();
  const target =
    val && (val.target != null ? val.target : val.target_seconds);
  const seconds =
    target != null && Number(target) > 0 && Number(target) < 100000
      ? Number(target)
      : null;
  const dur = formatDurationSeconds(seconds);

  const labels = {
    WATCH_VIDEO: 'Regarder la vidéo',
    WATCH_VIDEO_ON_MOBILE: 'Regarder la vidéo (mobile)',
    WATCH_VIDEO_ON_DESKTOP: 'Regarder la vidéo (bureau)',
    PLAY_ON_DESKTOP: 'Jouer sur bureau',
    PLAY_ON_XBOX: 'Jouer sur Xbox',
    PLAY_ON_PLAYSTATION: 'Jouer sur PlayStation',
    PLAY_ACTIVITY: 'Jouer à l’activité',
    STREAM_ON_DESKTOP: 'Streamer sur bureau',
    STREAM_ON_XBOX: 'Streamer sur Xbox',
    STREAM_ON_PLAYSTATION: 'Streamer sur PlayStation',
    ACHIEVEMENT: 'Débloquer un succès',
    ACHIEVEMENT_IN_ACTIVITY: 'Succès dans une activité',
  };

  let label = labels[raw] || null;
  if (!label) {
    if (/WATCH.*VIDEO.*MOBILE/i.test(raw)) label = 'Regarder la vidéo (mobile)';
    else if (/WATCH.*VIDEO/i.test(raw)) label = 'Regarder la vidéo';
    else if (/STREAM/i.test(raw)) label = 'Streamer';
    else if (/PLAY/i.test(raw)) label = 'Jouer';
    else label = String(key).replace(/_/g, ' ').toLowerCase();
  }

  if (dur) label += ' · **' + dur + '**';
  else if (target != null) label += ' · objectif `' + target + '`';

  const videoTitle =
    val && val.messages && (val.messages.video_title || val.messages.title);
  if (videoTitle) label += '\n　_' + String(videoTitle).slice(0, 80) + '_';

  return label;
}

function formatTasks(root) {
  const tc = root.task_config_v2 || root.task_config || {};
  const tasks = tc.tasks || {};
  const lines = [];
  for (const [key, val] of Object.entries(tasks)) {
    lines.push('• ' + taskLabelFr(key, val));
  }
  if (!lines.length) return null;
  const join =
    String(tc.join_operator || tc.operator || '').toUpperCase() === 'OR'
      ? '_Une seule tâche suffit_'
      : '_Toutes les tâches listées_';
  return join + '\n' + lines.join('\n');
}

function extractTaskVideos(root, questId) {
  const tc = root.task_config_v2 || root.task_config || {};
  const tasks = tc.tasks || {};
  const out = [];
  for (const val of Object.values(tasks)) {
    const assets = (val && val.assets) || {};
    for (const ak of ['video', 'video_low_res']) {
      const v = assets[ak];
      const url = v && (v.url || v);
      if (!url || typeof url !== 'string') continue;
      // Prefer mp4 over m3u8 for gallery playback
      if (/\.m3u8(\?|$)/i.test(url)) continue;
      const full = assetUrl(questId, url);
      if (full && !out.includes(full)) out.push(full);
    }
  }
  return out;
}

function formatDateFr(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 19);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi + ' UTC';
  } catch {
    return String(iso).slice(0, 19);
  }
}

function platformsFr(root) {
  const list = root.redeemable_platforms || root.platforms || null;
  if (Array.isArray(list) && list.length) {
    return list
      .map((p) => {
        const s = String(p).toUpperCase();
        if (s.includes('CROSS')) return 'Multiplateforme';
        if (s.includes('DESKTOP') || s.includes('WIN')) return 'Bureau';
        if (s.includes('XBOX')) return 'Xbox';
        if (s.includes('PLAYSTATION') || s.includes('PS5') || s.includes('PS4'))
          return 'PlayStation';
        if (s.includes('MOBILE') || s.includes('IOS') || s.includes('ANDROID'))
          return 'Mobile';
        return String(p);
      })
      .join(', ');
  }
  const tasks = (root.task_config_v2 || root.task_config || {}).tasks || {};
  const keys = Object.keys(tasks).join(' ');
  const bits = [];
  if (/WATCH_VIDEO_ON_MOBILE|MOBILE|IOS|ANDROID/i.test(keys)) bits.push('Mobile');
  if (/DESKTOP|PLAY_ON_DESKTOP|STREAM_ON_DESKTOP|WATCH_VIDEO(?!_ON_MOBILE)/i.test(keys))
    bits.push('Bureau');
  if (/XBOX/i.test(keys)) bits.push('Xbox');
  if (/PLAYSTATION|PS5/i.test(keys)) bits.push('PlayStation');
  return bits.length ? bits.join(', ') : 'Multiplateforme';
}

function normalizeQuest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const root =
    raw.config && typeof raw.config === 'object'
      ? { ...raw.config, id: raw.config.id || raw.id, preview: raw.preview }
      : raw;

  const id = String(root.id || raw.id || '');
  if (!id) return null;

  const messages = root.messages || {};
  const assets = root.assets || {};
  const app = root.application || {};
  const rewards =
    (root.rewards_config && root.rewards_config.rewards) ||
    root.rewards ||
    [];
  const colors = root.colors || {};

  const hero =
    assetUrl(id, assets.hero) ||
    assetUrl(id, assets.quest_bar_hero) ||
    assetUrl(id, assets.game_tile) ||
    assetUrl(id, assets.game_tile_dark) ||
    assetUrl(id, assets.game_tile_light);

  // Une seule vidéo : tâche (à regarder) prioritaire, sinon présentation
  const taskVideos = extractTaskVideos(root, id);
  let videoUrl = null;
  let videoKind = null;
  let videoLabel = null;
  if (taskVideos.length) {
    videoUrl = taskVideos[0];
    videoKind = 'task';
    videoLabel = 'Vidéo à regarder';
  } else {
    for (const key of [
      'hero_video',
      'quest_bar_hero_video',
      'preview_video',
      'video',
    ]) {
      if (assets[key]) {
        videoUrl = assetUrl(id, assets[key]);
        videoKind = 'presentation';
        videoLabel = 'Vidéo de présentation';
        break;
      }
    }
  }

  return {
    id,
    name:
      messages.quest_name ||
      messages.questName ||
      messages.game_title ||
      app.name ||
      'Quête ' + id,
    gameTitle: messages.game_title || messages.gameTitle || app.name || null,
    publisher: messages.game_publisher || messages.gamePublisher || null,
    applicationId: app.id || null,
    applicationName: app.name || null,
    applicationLink: app.link || null,
    startsAt: root.starts_at || root.startsAt || null,
    expiresAt: root.expires_at || root.expiresAt || null,
    heroImage: hero,
    gameTile:
      assetUrl(id, assets.game_tile) ||
      assetUrl(id, assets.game_tile_dark) ||
      assetUrl(id, assets.game_tile_light),
    logotype:
      assetUrl(id, assets.logotype) ||
      assetUrl(id, assets.logotype_dark) ||
      assetUrl(id, assets.logotype_light),
    videoUrl,
    videoKind,
    videoLabel,
    taskVideos: videoUrl && videoKind === 'task' ? [videoUrl] : [],
    primaryColor: colors.primary || null,
    platforms: platformsFr(root),
    features: Array.isArray(root.features)
      ? root.features.map((f) => '`' + f + '`').join(' ')
      : null,
    rewards: (Array.isArray(rewards) ? rewards : []).map((r) => ({
      type: r.type,
      typeLabel: rewardTypeFr(r.type),
      name: (r.messages && (r.messages.name || r.messages.title)) || null,
      skuId: r.sku_id || r.skuId || null,
      orbQuantity:
        r.orb_quantity != null
          ? r.orb_quantity
          : r.orbQuantity != null
            ? r.orbQuantity
            : null,
      asset: assetUrl(id, r.asset),
      assetVideo: assetUrl(id, r.asset_video || r.assetVideo),
      redemptionLink: r.redemption_link || r.redemptionLink || null,
    })),
    tasksText: formatTasks(root),
    preview: !!(raw.preview || root.preview),
  };
}


function isVideoUrl(url) {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url || '');
}

function isImageUrl(url) {
  if (!url) return false;
  if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(url)) return true;
  // Discord quest CDN paths often include asset names without query
  if (/cdn\.discordapp\.com\/(quests|assets|collectibles|avatar)/i.test(url)) {
    if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) return false;
    return true;
  }
  return false;
}

/** Components V2 payload — MediaGallery for hero + video */
function buildQuestComponentsV2(quest) {
  const start = formatDateFr(quest.startsAt);
  const end = formatDateFr(quest.expiresAt);
  let duree = '—';
  if (start && end) duree = start + ' → ' + end;
  else if (start) duree = 'À partir du ' + start;
  else if (end) duree = 'Jusqu’au ' + end;

  const header = [
    '## Nouvelle quête',
    '### ' + String(quest.name).slice(0, 200),
  ];
  if (quest.preview) header.push('⚠️ _Aperçu (preview)_');

  const info = [
    '**Durée**',
    duree,
    '',
    '**Plateformes** · ' + (quest.platforms || 'Multiplateforme'),
  ];
  if (quest.gameTitle) info.push('**Jeu** · ' + String(quest.gameTitle).slice(0, 180));
  if (quest.publisher) info.push('**Éditeur** · ' + String(quest.publisher).slice(0, 120));
  if (quest.applicationName || quest.applicationId) {
    info.push(
      '**Application** · ' +
        (quest.applicationName || 'App') +
        (quest.applicationId ? ' · `' + quest.applicationId + '`' : ''),
    );
  }
  if (quest.features) info.push('**Flags** · ' + quest.features);

  const blocks = [];

  // 1) Photo en haut — une seule image (hero)
  if (quest.heroImage && isImageUrl(quest.heroImage)) {
    blocks.push({
      type: 12,
      items: [
        {
          media: { url: quest.heroImage },
          description: String(quest.name).slice(0, 100),
        },
      ],
    });
  }

  // 2) Texte
  blocks.push({ type: 10, content: header.join('\n').slice(0, 4000) });
  blocks.push({ type: 14, divider: true, spacing: 1 });
  blocks.push({ type: 10, content: info.join('\n').slice(0, 4000) });

  if (quest.tasksText) {
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({
      type: 10,
      content: ('**Tâches**\n' + quest.tasksText).slice(0, 4000),
    });
  }

  const rewards = quest.rewards || [];
  if (rewards.length) {
    const rLines = [];
    for (const r of rewards.slice(0, 8)) {
      let line = '• **' + r.typeLabel + '**';
      if (r.name) line += ' — ' + r.name;
      if (r.orbQuantity != null) line += ' · **' + r.orbQuantity + ' orbes**';
      if (r.skuId) line += '\n　SKU `' + r.skuId + '`';
      rLines.push(line);
    }
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({
      type: 10,
      content: ('**Récompenses**\n' + rLines.join('\n')).slice(0, 4000),
    });

    // Images des récompenses (décorations, collectibles, etc.)
    const rewardMedia = [];
    for (const r of rewards.slice(0, 8)) {
      if (r.asset && isImageUrl(r.asset)) {
        rewardMedia.push({
          media: { url: r.asset },
          description: String(r.name || r.typeLabel || 'Récompense').slice(0, 100),
        });
      }
    }
    if (rewardMedia.length) {
      blocks.push({ type: 14, divider: true, spacing: 1 });
      blocks.push({
        type: 10,
        content: '**Aperçu récompense' + (rewardMedia.length > 1 ? 's' : '') + '**',
      });
      blocks.push({ type: 12, items: rewardMedia.slice(0, 4) });
    }
  }

  blocks.push({ type: 14, divider: true, spacing: 1 });
  blocks.push({
    type: 10,
    content: '**ID** · `' + quest.id + '`' ,
  });

  // 3) Vidéo en bas — une seule (tâche ou présentation)
  if (quest.videoUrl && isVideoUrl(quest.videoUrl)) {
    const vLabel = quest.videoLabel || 'Vidéo';
    blocks.push({ type: 14, divider: true, spacing: 1 });
    blocks.push({
      type: 10,
      content: '**' + vLabel + '**',
    });
    blocks.push({
      type: 12,
      items: [
        {
          media: { url: quest.videoUrl },
          description: vLabel.slice(0, 100),
        },
      ],
    });
  }

  // Link buttons (style 5) — work on non-app webhooks
  const buttons = [];
  if (quest.videoUrl) {
    buttons.push({
      type: 2,
      style: 5,
      label: (quest.videoLabel || 'Vidéo').slice(0, 80),
      url: quest.videoUrl.slice(0, 512),
    });
  }
  if (quest.applicationLink) {
    buttons.push({
      type: 2,
      style: 5,
      label: 'Lien application',
      url: quest.applicationLink.slice(0, 512),
    });
  }
  for (const r of rewards) {
    if (r.redemptionLink && buttons.length < 5) {
      buttons.push({
        type: 2,
        style: 5,
        label: 'Récupérer récompense',
        url: String(r.redemptionLink).slice(0, 512),
      });
      break;
    }
  }
  if (buttons.length) {
    blocks.push({
      type: 1, // Action Row
      components: buttons.slice(0, 5),
    });
  }

  const container = {
    type: 17, // Container
    accent_color: 0,
    components: blocks,
  };

  return {
    flags: IS_COMPONENTS_V2,
    components: [container],
  };
}

/** Fallback classic embed */
function buildQuestEmbed(quest) {
  const start = formatDateFr(quest.startsAt);
  const end = formatDateFr(quest.expiresAt);
  let duree = '—';
  if (start && end) duree = start + ' → ' + end;
  else if (start) duree = 'À partir du ' + start;
  else if (end) duree = 'Jusqu’au ' + end;

  const desc = [];
  desc.push('**Durée**');
  desc.push(duree);
  desc.push('');
  desc.push('**Plateformes** · ' + (quest.platforms || 'Multiplateforme'));
  if (quest.gameTitle) desc.push('**Jeu** · ' + String(quest.gameTitle).slice(0, 180));
  if (quest.publisher) desc.push('**Éditeur** · ' + String(quest.publisher).slice(0, 120));

  const fields = [];
  if (quest.tasksText) {
    fields.push({ name: 'Tâches', value: quest.tasksText.slice(0, 1024) });
  }
  const rewards = quest.rewards || [];
  if (rewards.length) {
    const rLines = rewards.slice(0, 6).map((r) => {
      let line = '• **' + r.typeLabel + '**';
      if (r.name) line += ' — ' + r.name;
      if (r.orbQuantity != null) line += ' · **' + r.orbQuantity + ' orbes**';
      return line;
    });
    fields.push({ name: 'Récompenses', value: rLines.join('\n').slice(0, 1024) });
  }
  if (quest.videoUrl) {
    fields.push({
      name: quest.videoLabel || 'Vidéo',
      value: '[Ouvrir](' + quest.videoUrl + ')',
    });
  }
  fields.push({ name: 'ID', value: '`' + quest.id + '`', inline: true });

  return {
    author: { name: 'Nouvelle quête', icon_url: AVATAR },
    title: String(quest.name).slice(0, 256),
    description: desc.join('\n').slice(0, 4090),
    color: 0x000000,
    fields,
    image: quest.heroImage ? { url: quest.heroImage } : undefined,
    thumbnail: (() => {
      const first =
        (quest.rewards || []).find((r) => r.asset && isImageUrl(r.asset)) || null;
      return first ? { url: first.asset } : undefined;
    })(),
    footer: { text: 'Datamining · Quêtes · ID ' + quest.id },
    timestamp: new Date().toISOString(),
  };
}

function webhookUrlWithComponents() {
  if (!WEBHOOK) return null;
  const u = new URL(WEBHOOK);
  u.searchParams.set('with_components', 'true');
  u.searchParams.set('wait', 'true');
  return u.toString();
}

async function postWebhook(url, body) {
  if (!url) return { ok: false, status: 0, text: 'no webhook' };
  body.username = BOT_NAME;
  body.avatar_url = AVATAR;
  return sendWebhook(url, body, { label: 'quests' });
}

async function sendQuestWebhook(quest) {
  if (!WEBHOOK) {
    console.warn('Pas de QUEST_WEBHOOK_URL / DISCORD_WEBHOOK_URL');
    return false;
  }

  const v2Url = webhookUrlWithComponents();
  const v2Body = buildQuestComponentsV2(quest);
  let res = await postWebhook(v2Url, v2Body);

  if (res.ok) {
    console.log('🔔 Quête V2:', quest.name, '(' + quest.id + ')');
    await new Promise((r) => setTimeout(r, 450));
    return true;
  }

  console.warn('V2 échoué', res.status, res.text, '→ fallback embed');
  res = await postWebhook(WEBHOOK, { embeds: [buildQuestEmbed(quest)] });
  if (res.ok) {
    console.log('🔔 Quête embed:', quest.name);
  } else {
    console.warn('Embed échoué', res.status, res.text);
  }
  await new Promise((r) => setTimeout(r, 450));
  return res.ok;
}

async function fetchPublicQuests() {
  const res = await fetch(PUBLIC_QUESTS_URL, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: 30000,
  });
  if (!res.ok) throw new Error('public quests HTTP ' + res.status);
  const data = await res.json();
  const list = Array.isArray(data) ? data : data.quests || data.data || [];
  return list.map(normalizeQuest).filter(Boolean);
}

async function fetchOfficialQuests() {
  if (!DISCORD_TOKEN) {
    console.log('No DISCORD_TOKEN / DISCORD_USER_TOKEN — official quests skipped');
    return [];
  }
  const endpoints = [
    'https://canary.discord.com/api/v10/quests/@me',
    'https://discord.com/api/v10/quests/@me',
  ];
  const headers = {
    Authorization: DISCORD_TOKEN,
    'User-Agent': UA,
    Accept: 'application/json',
  };
  let lastStatus = 0;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers, timeout: 25000 });
      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) {
        console.warn('official quests auth failed HTTP', res.status, '(check DISCORD_TOKEN secret)');
        return [];
      }
      if (res.status === 429) {
        const ra = Number(res.headers.get('retry-after') || 2);
        console.warn('official quests 429 — wait', ra, 's');
        await new Promise((r) => setTimeout(r, Math.min(15, ra) * 1000));
        continue;
      }
      if (!res.ok) {
        console.warn('official quests HTTP', res.status, url.includes('canary') ? 'canary' : 'stable');
        continue;
      }
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.quests || data.data || [];
      const out = list.map(normalizeQuest).filter(Boolean);
      console.log('Official quests:', out.length, url.includes('canary') ? '(canary)' : '(stable)');
      return out;
    } catch (e) {
      console.warn('official quests error:', String(e.message || e).slice(0, 120));
    }
  }
  if (lastStatus) console.warn('official quests gave up, last HTTP', lastStatus);
  return [];
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('🎮 Récupération des quêtes…');
  console.log('Token officiel:', DISCORD_TOKEN ? 'configured' : 'MISSING');
  console.log(
    'Webhook:',
    WEBHOOK
      ? process.env.QUEST_WEBHOOK_URL
        ? 'QUEST_WEBHOOK_URL'
        : 'DISCORD_WEBHOOK_URL (fallback)'
      : 'MISSING',
  );

  let quests = [];
  let official = [];
  let publicList = [];

  if (DISCORD_TOKEN) {
    try {
      official = await fetchOfficialQuests();
    } catch (e) {
      console.warn('Quêtes officielles:', String(e.message || e).slice(0, 120));
    }
  } else {
    console.log('Tip: set secret DISCORD_TOKEN (user token) for faster official quest detection');
  }

  try {
    publicList = await fetchPublicQuests();
    console.log('API publique:', publicList.length, 'quêtes');
  } catch (e) {
    console.error('API publique échouée:', e.message);
    if (!official.length) process.exitCode = 1;
  }

  {
    const byId = new Map();
    for (const q of official) {
      if (q && q.id) byId.set(q.id, { ...q, source: 'official' });
    }
    for (const q of publicList) {
      if (!q || !q.id) continue;
      const prev = byId.get(q.id);
      if (!prev) {
        byId.set(q.id, { ...q, source: 'public' });
        continue;
      }
      byId.set(q.id, {
        ...prev,
        ...q,
        name: prev.name || q.name,
        heroImage: prev.heroImage || q.heroImage,
        gameTile: prev.gameTile || q.gameTile,
        videoUrl: prev.videoUrl || q.videoUrl,
        rewards:
          (prev.rewards && prev.rewards.length ? prev.rewards : null) ||
          q.rewards ||
          [],
        tasksText: prev.tasksText || q.tasksText,
        source: prev.source === 'official' ? 'official+public' : prev.source,
      });
    }
    quests = Array.from(byId.values());
  }

  console.log(
    'Quêtes fusionnées:',
    quests.length,
    '| official',
    official.length,
    '| public',
    publicList.length,
  );
  const sample = quests.find((q) => q.name && !String(q.name).startsWith('Quête '));
  if (sample) {
    console.log(
      'Sample OK:',
      sample.name,
      '| tasks:',
      !!sample.tasksText,
      '| rewards:',
      (sample.rewards || []).length,
      '| image:',
      !!sample.heroImage,
      '| video:',
      !!sample.videoUrl,
      '| src:',
      sample.source || '?',
    );
  }

  if (!quests.length) {
    console.error('Aucune quête — abort');
    process.exit(1);
  }

  const now = Date.now();
  const active = quests.filter((q) => {
    const exp = q.expiresAt ? Date.parse(q.expiresAt) : null;
    const start = q.startsAt ? Date.parse(q.startsAt) : null;
    if (start && start > now + 14 * 86400000) return false;
    if (exp && exp < now) return false;
    return true;
  });
  console.log('Actives / à venir:', active.length);

  let previous = { ids: [] };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {}
  }
  // Always compare as strings (snowflake id type mismatch caused re-notifies)
  const prevIds = new Set((previous.ids || []).map((x) => String(x)));
  console.log('Known ids loaded:', prevIds.size, 'from', STATE_FILE);
  const isFirstRun = prevIds.size === 0;

  const newQuests = isFirstRun
    ? []
    : active.filter((q) => q && q.id && !prevIds.has(String(q.id)));
  const questSnapshot = active.map((q) => ({
    id: String(q.id),
    name: q.name,
    expiresAt: q.expiresAt,
    videoUrl: q.videoUrl || null,
    heroImage: q.heroImage || null,
    rewardCount: (q.rewards || []).length,
  }));

  async function writeQuestState(ids) {
    const unique = [...new Set((ids || []).map(String))];
    await fs.writeJson(
      STATE_FILE,
      {
        scrapedAt: new Date().toISOString(),
        count: active.length,
        ids: unique,
        quests: questSnapshot,
      },
      { spaces: 2 },
    );
    console.log('State written: ids=', unique.length, 'active=', active.length);
  }

  if (isFirstRun) {
    await writeQuestState(active.map((q) => String(q.id)));
    console.log('Premier run - seed de', active.length, 'ids (pas de flood)');
    return;
  }

  // Keep full history of known ids — never drop (prevents re-spam after failed pushes)
  const known = new Set(prevIds);
  const pending = newQuests.slice();
  const batch = pending.slice(0, 15);
  console.log('Nouvelles quetes:', pending.length, '| notify batch:', batch.length);

  let sentOk = 0;
  let sentFail = 0;
  for (const q of batch) {
    const ok = await sendQuestWebhook(q);
    if (ok) {
      known.add(String(q.id));
      sentOk++;
    } else {
      sentFail++;
      console.warn('NOTIFY_FAIL quest', q.id, '- will retry next run');
    }
  }

  await writeQuestState(Array.from(known));
  console.log(
    'Quetes termine - sent',
    sentOk,
    'failed',
    sentFail,
    'still pending',
    Math.max(0, pending.length - sentOk),
  );
  if (sentFail > 0 && sentOk === 0 && batch.length > 0) {
    process.exitCode = 2;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  normalizeQuest,
  buildQuestEmbed,
  buildQuestComponentsV2,
  main,
};
