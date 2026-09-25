/**
 * Watch @DiscordNEW8r on X → Discord webhook (free session mode)
 *
 * Secrets (choose one style):
 *
 *   A) Two secrets:
 *      X_AUTH_TOKEN  = cookie auth_token
 *      X_CT0         = cookie ct0
 *
 *   B) One secret (recommended — less copy errors):
 *      X_COOKIE = full Cookie header from browser, e.g.
 *        auth_token=xxx; ct0=yyy; guest_id=zzz; ...
 *
 *   + X_NEWS_WEBHOOK_URL
 *
 * How to copy cookies:
 *   1. x.com logged in
 *   2. F12 → Network → click any request to x.com/i/api/...
 *   3. Request Headers → copy the whole "cookie:" value → secret X_COOKIE
 *   OR Application → Cookies → copy auth_token + ct0 values only
 */
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const { writeJsonAtomic } = require('./lib/atomic');
const { sendWebhook } = require('./lib/webhook');

const DATA = path.join(__dirname, '..', 'data');
const SEEN_FILE = path.join(DATA, 'seen_x_posts.json');
const SCREEN_NAME = process.env.X_SCREEN_NAME || 'DiscordNEW8r';
const USER_ID = process.env.X_USER_ID || '2073982489836584960';
const WEBHOOK =
  process.env.X_NEWS_WEBHOOK_URL ||
  process.env.X_WEBHOOK_URL ||
  process.env.DISCORD_X_WEBHOOK_URL ||
  '';
const BEARER =
  (process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '').trim();

const WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const MAX_NOTIFY = 8;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Query IDs from live main.59435dbf6f40166da.js (Sep 2026)
const QID_USER = [
  'KybxDj9RrADIITXlGG8kpw',
  'sLVLhk0bGj3MVFEKTdax1w',
  'IGgvgiOx4QZndDHuD3x9TQ',
  'AWbeRIdkLtqTRN7yL_H8yw',
];
const QID_TWEETS = [
  'OeFjWKHutsuyWXZGmLr02A',
  '36rb3Xj3iJ64Q-9wKDjCcQ',
  'x3B_xLqC0yZawOB7WQhaVQ',
  'N2tFDY-MlrLxXJ9F_ZxJGA',
  'HeWHY26ItCfUmm1e6ITjeA',
  'V7H0Ap3_Hh2FyS75OCDO3Q',
];

const FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
  hidden_profile_subscriptions_enabled: true,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: false,
};

const RSS_MIRRORS = [
  `https://rsshub.rssforever.com/twitter/user/${SCREEN_NAME}`,
  `https://rsshub.app/twitter/user/${SCREEN_NAME}`,
  `https://nitter.privacyredirect.com/${SCREEN_NAME}/rss`,
  `https://xcancel.com/${SCREEN_NAME}/rss`,
];

function cleanSecret(s) {
  return String(s || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

function loadSession() {
  const full = cleanSecret(
    process.env.X_COOKIE || process.env.TWITTER_COOKIE || '',
  );
  let auth = cleanSecret(
    process.env.X_AUTH_TOKEN || process.env.TWITTER_AUTH_TOKEN || '',
  );
  let ct0 = cleanSecret(process.env.X_CT0 || process.env.TWITTER_CT0 || '');
  let cookieHeader = '';

  if (full) {
    cookieHeader = full.replace(/^cookie:\s*/i, '').trim();
    const map = {};
    for (const part of cookieHeader.split(';')) {
      const i = part.indexOf('=');
      if (i < 1) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k) map[k] = v;
    }
    if (map.auth_token) auth = map.auth_token;
    if (map.ct0) ct0 = map.ct0;
  }

  if (auth && ct0 && !cookieHeader) {
    cookieHeader = `auth_token=${auth}; ct0=${ct0}`;
  } else if (auth && ct0 && cookieHeader) {
    if (!/auth_token=/i.test(cookieHeader))
      cookieHeader += `; auth_token=${auth}`;
    if (!/\bct0=/i.test(cookieHeader)) cookieHeader += `; ct0=${ct0}`;
  }

  return { auth, ct0, cookieHeader };
}

async function main() {
  console.log('=== X News Watch · @' + SCREEN_NAME + ' ===');
  console.log('Webhook:', WEBHOOK ? 'set' : 'MISSING');

  const session = loadSession();
  console.log(
    'Session:',
    session.auth && session.ct0
      ? `auth_token len=${session.auth.length} ct0 len=${session.ct0.length} cookie len=${session.cookieHeader.length}`
      : 'missing',
  );
  console.log('Bearer API:', BEARER ? 'set' : 'missing');

  if (!WEBHOOK) {
    console.warn('Missing X_NEWS_WEBHOOK_URL — soft skip');
    process.exit(0);
  }

  await fs.ensureDir(DATA);
  const seen = await loadSeen();
  console.log('Seen posts:', seen.ids.length);

  let posts = [];
  let source = 'none';

  if (session.auth && session.ct0) {
    if (session.auth.length < 20) {
      console.warn('auth_token looks too short');
    }
    if (session.ct0.length < 20) {
      console.warn('ct0 looks too short');
    }
    try {
      posts = await fetchFromSession(session);
      if (posts.length) source = 'session-cookies';
    } catch (e) {
      console.warn('Session fetch fail:', e.message || e);
    }
  } else {
    console.warn('No session. Add X_COOKIE or X_AUTH_TOKEN + X_CT0');
  }

  if (!posts.length && BEARER) {
    try {
      posts = await fetchFromApi(BEARER);
      if (posts.length) source = 'x-api-v2';
    } catch (e) {
      const msg = String(e.message || e);
      console.warn('API error', msg);
      if (/402|credits depleted/i.test(msg)) await maybeWarnCredits(seen);
    }
  }

  if (!posts.length) {
    posts = await fetchFromRss();
    if (posts.length) source = 'rss';
  }

  console.log('Fetched', posts.length, 'posts via', source);
  if (!posts.length) {
    console.warn(
      'No posts. 401 = need valid auth_token cookie. Network → cookie: → X_COOKIE',
    );
    process.exit(0);
  }

  if (!seen.ids.length) {
    seen.ids = uniq(posts.map((p) => p.id)).slice(-300);
    await saveSeen(seen);
    console.log('Seeded', seen.ids.length, 'ids — no notify on first run');
    return;
  }

  const known = new Set(seen.ids.map(String));
  const fresh = posts
    .filter((p) => p.id && !known.has(String(p.id)))
    .sort((a, b) => String(b.id).localeCompare(String(a.id)));

  console.log('New posts:', fresh.length);
  if (!fresh.length) {
    console.log('Nothing new');
    return;
  }

  let sent = 0;
  for (const p of fresh.slice(0, MAX_NOTIFY)) {
    const ok = await postWebhook(p);
    if (ok) {
      seen.ids.push(String(p.id));
      sent++;
      await sleep(400);
    }
  }

  seen.ids = uniq(seen.ids).slice(-300);
  await saveSeen(seen);
  console.log('Sent', sent, '/', fresh.length, '· seen now', seen.ids.length);
}

function makeClientTransactionId(method, apiPath) {
  const EPOCH = 1682924400;
  const timeNow = Math.floor(Date.now() / 1000) - EPOCH;
  const timeBuf = Buffer.alloc(4);
  timeBuf.writeUInt32LE(timeNow >>> 0, 0);
  const keyBytes = crypto.randomBytes(32);
  const payload = `${(method || 'GET').toUpperCase()}!${apiPath || '/'}!${timeNow}!obfiowerehiring`;
  const hash = crypto
    .createHash('sha256')
    .update(payload)
    .digest()
    .subarray(0, 16);
  const rnd = crypto.randomBytes(1)[0];
  const arr = Buffer.concat([keyBytes, timeBuf, hash, Buffer.from([3])]);
  const out = Buffer.alloc(1 + arr.length);
  out[0] = rnd;
  for (let i = 0; i < arr.length; i++) out[i + 1] = arr[i] ^ rnd;
  return out.toString('base64').replace(/=+$/, '');
}

function sessionHeaders(session, method, apiPath) {
  const tid = makeClientTransactionId(method || 'GET', apiPath || '/');
  return {
    authorization: 'Bearer ' + WEB_BEARER,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-csrf-token': session.ct0,
    'x-twitter-client-language': 'en',
    'x-twitter-active-user': 'yes',
    'content-type': 'application/json',
    'x-client-transaction-id': tid,
    Cookie: session.cookieHeader,
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: `https://x.com/${SCREEN_NAME}`,
    Origin: 'https://x.com',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

async function fetchFromSession(session) {
  let uid = USER_ID;
  let got401 = 0;

  for (const qid of QID_USER) {
    try {
      const variables = {
        screen_name: SCREEN_NAME,
        withSafetyModeUserFields: true,
      };
      const apiPath = `/i/api/graphql/${qid}/UserByScreenName`;
      const url =
        `https://x.com${apiPath}` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
      const headers = sessionHeaders(session, 'GET', apiPath);
      const res = await fetch(url, { headers, timeout: 20000 });
      if (res.status === 401) {
        got401++;
        console.warn('UserByScreenName', qid, 401);
        continue;
      }
      if (!res.ok) {
        console.warn('UserByScreenName', qid, res.status);
        continue;
      }
      const data = await res.json();
      const rest =
        data &&
        data.data &&
        data.data.user &&
        data.data.user.result &&
        data.data.user.result.rest_id;
      if (rest) {
        uid = String(rest);
        console.log('Session resolved user', uid, 'via', qid);
        break;
      }
    } catch (e) {
      console.warn('UserByScreenName fail', qid, e.message);
    }
  }

  for (const qid of QID_TWEETS) {
    try {
      const variables = {
        userId: uid,
        count: 20,
        includePromotedContent: false,
        withQuickPromoteEligibilityTweetFields: true,
        withVoice: true,
        withV2Timeline: true,
      };
      const apiPath = `/i/api/graphql/${qid}/UserTweets`;
      const url =
        `https://x.com${apiPath}` +
        `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
        `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;
      const headers = sessionHeaders(session, 'GET', apiPath);
      const res = await fetch(url, { headers, timeout: 25000 });
      const text = await res.text();
      if (res.status === 401) {
        got401++;
        console.warn('UserTweets', qid, 401, text.slice(0, 100));
        continue;
      }
      if (!res.ok) {
        console.warn('UserTweets', qid, res.status, text.slice(0, 120));
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      if (data.errors) {
        console.warn(
          'UserTweets errors',
          qid,
          JSON.stringify(data.errors).slice(0, 200),
        );
        continue;
      }
      const posts = parseTimelineJson(data);
      if (posts.length) {
        console.log('Session UserTweets OK', posts.length, 'via', qid);
        return posts;
      }
      console.warn('UserTweets empty', qid);
    } catch (e) {
      console.warn('UserTweets fail', qid, e.message);
    }
  }

  if (got401 > 0) {
    throw new Error(
      'HTTP 401 — cookies invalid/expired. Need auth_token. ' +
        `auth_token len=${session.auth.length} ct0 len=${session.ct0.length}`,
    );
  }
  throw new Error('Session GraphQL returned no tweets');
}

function parseTimelineJson(data) {
  const out = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    const legacy = node.legacy;
    const restId = node.rest_id || (legacy && legacy.id_str);
    if (legacy && restId && (legacy.full_text || legacy.text)) {
      const id = String(restId);
      if (!seen.has(id)) {
        seen.add(id);
        let image = null;
        const media =
          (legacy.extended_entities && legacy.extended_entities.media) ||
          (legacy.entities && legacy.entities.media) ||
          [];
        if (media[0]) {
          image = media[0].media_url_https || media[0].media_url || null;
        }
        out.push({
          id,
          text: legacy.full_text || legacy.text || '',
          url: `https://x.com/${SCREEN_NAME}/status/${id}`,
          createdAt: legacy.created_at
            ? new Date(legacy.created_at).toISOString()
            : null,
          image,
        });
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(data);
  return out;
}

async function maybeWarnCredits(seen) {
  const now = Date.now();
  if (seen.creditsWarnedAt && now - seen.creditsWarnedAt < 12 * 3600 * 1000)
    return;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Datamining · X',
        embeds: [
          {
            title: 'X — auth_token manquant / invalide',
            description:
              'Cherche le cookie **auth_token** (pas le Bearer).\n' +
              'Network → cookie: → secret **X_COOKIE**.',
            color: 0xed4245,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      timeout: 12000,
    });
    if (res.ok) {
      seen.creditsWarnedAt = now;
      await saveSeen(seen);
    }
  } catch {}
}

async function fetchFromApi(bearer) {
  let uid = USER_ID;
  try {
    const uRes = await fetch(
      `https://api.twitter.com/2/users/by/username/${SCREEN_NAME}`,
      {
        headers: {
          Authorization: 'Bearer ' + bearer,
          'User-Agent': 'canary-x-news',
        },
        timeout: 15000,
      },
    );
    if (uRes.ok) {
      const uj = await uRes.json();
      if (uj.data && uj.data.id) uid = String(uj.data.id);
    } else {
      const t = await uRes.text();
      if (uRes.status === 402 || /credits depleted/i.test(t))
        throw new Error('API 402 ' + t.slice(0, 200));
    }
  } catch (e) {
    if (/402|credits/i.test(String(e.message))) throw e;
  }

  const url =
    `https://api.twitter.com/2/users/${uid}/tweets` +
    `?max_results=10&exclude=replies` +
    `&tweet.fields=created_at,text,entities,attachments` +
    `&expansions=attachments.media_keys&media.fields=url,preview_image_url,type`;

  const res = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + bearer,
      'User-Agent': 'canary-x-news',
    },
    timeout: 25000,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('API ' + res.status + ' ' + t.slice(0, 250));
  }
  const data = await res.json();
  const mediaMap = {};
  for (const m of (data.includes && data.includes.media) || []) {
    mediaMap[m.media_key] = m.url || m.preview_image_url || null;
  }
  const out = [];
  for (const t of data.data || []) {
    let image = null;
    if (t.attachments && t.attachments.media_keys) {
      for (const k of t.attachments.media_keys) {
        if (mediaMap[k]) {
          image = mediaMap[k];
          break;
        }
      }
    }
    out.push({
      id: String(t.id),
      text: t.text || '',
      url: `https://x.com/${SCREEN_NAME}/status/${t.id}`,
      createdAt: t.created_at || null,
      image,
    });
  }
  return out;
}

async function fetchFromRss() {
  for (const url of RSS_MIRRORS) {
    try {
      console.log('RSS try', url);
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
        timeout: 12000,
      });
      if (!res.ok) {
        console.warn('RSS', res.status, url);
        continue;
      }
      const xml = await res.text();
      if (
        /not yet whitelist|Error 404|403 Forbidden|Making sure you're not a bot|Attention Required|cloudflare/i.test(
          xml,
        ) &&
        !/status\/\d{10,}/i.test(xml)
      ) {
        console.warn('RSS blocked', url);
        continue;
      }
      const posts = parseRss(xml);
      if (posts.length) {
        console.log('RSS OK', posts.length, 'from', url);
        return posts;
      }
    } catch (e) {
      console.warn('RSS fail', url, e.message);
    }
  }
  return [];
}

function parseRss(xml) {
  const items = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const block of blocks) {
    const title = strip(pick(block, 'title'));
    if (/whitelist/i.test(title)) continue;
    const link = strip(pick(block, 'link')) || strip(pick(block, 'guid'));
    if (!link) continue;
    const idMatch =
      link.match(/status\/(\d+)/) ||
      link.match(/statuses\/(\d+)/) ||
      (pick(block, 'guid') || '').match(/(\d{15,})/);
    const id = idMatch ? idMatch[1] : null;
    if (!id) continue;
    items.push({
      id: String(id),
      text: title || '',
      url: `https://x.com/${SCREEN_NAME}/status/${id}`,
      createdAt: strip(pick(block, 'pubDate')) || null,
      image: null,
    });
  }
  return items;
}

function pick(block, tag) {
  const m = block.match(
    new RegExp(
      '<' +
        tag +
        '[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</' +
        tag +
        '>',
      'i',
    ),
  );
  if (!m) return '';
  return m[1] != null && m[1] !== '' ? m[1] : m[2] || '';
}

function strip(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function postWebhook(p) {
  const text = (p.text || '').replace(/\s+/g, ' ').trim().slice(0, 350);
  const embed = {
    author: {
      name: '@' + SCREEN_NAME,
      url: 'https://x.com/' + SCREEN_NAME,
      icon_url:
        'https://pbs.twimg.com/profile_images/2088274756466286592/ZU7Jl8B-_normal.jpg',
    },
    title: 'Nouveau post',
    url: p.url,
    description: text ? text + '\n\n' + p.url : p.url,
    color: 0x1da1f2,
    footer: { text: 'X · @' + SCREEN_NAME },
    timestamp: p.createdAt
      ? new Date(p.createdAt).toISOString()
      : new Date().toISOString(),
  };
  if (p.image) embed.image = { url: p.image };

  const r = await sendWebhook(
    WEBHOOK,
    { username: 'Datamining · X', embeds: [embed], content: p.url },
    { label: 'x-news ' + p.id, timeoutMs: 15000 },
  );
  console.log('webhook', r.status, p.id);
  return r.ok;
}

async function loadSeen() {
  try {
    if (await fs.pathExists(SEEN_FILE)) {
      const d = await fs.readJson(SEEN_FILE);
      return {
        ids: (d.ids || []).map(String),
        creditsWarnedAt: d.creditsWarnedAt || null,
      };
    }
  } catch {}
  return { ids: [], creditsWarnedAt: null };
}

async function saveSeen(seen) {
  await writeJsonAtomic(SEEN_FILE, {
    updatedAt: new Date().toISOString(),
    ids: seen.ids || [],
    creditsWarnedAt: seen.creditsWarnedAt || null,
  });
}

function uniq(arr) {
  return [...new Set(arr.map(String))];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.warn('X news soft error:', e.message || e);
  process.exit(0);
});
