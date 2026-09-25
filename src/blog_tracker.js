/**
 * Discord Blog + Zendesk tracker (maxed)
 * Sources: discord.com/blog RSS + article HTML, Zendesk help centers
 * State: data/blog_tracker.json
 * Webhook: BLOG_WEBHOOK_URL (fallback DISCORD_WEBHOOK_URL)
 */
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { sendWebhook } = require('./lib/webhook');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'blog_tracker.json');

const WEBHOOK =
  process.env.BLOG_WEBHOOK_URL ||
  process.env.ZENDESK_WEBHOOK_URL ||
  process.env.DISCORD_WEBHOOK_URL ||
  null;

const BOT_NAME =
  process.env.ORBIT_BOT_NAME || process.env.WEBHOOK_BOT_NAME || 'Datamining';
const AVATAR =
  process.env.ORBIT_AVATAR_URL ||
  process.env.WEBHOOK_AVATAR_URL ||
  'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/1f4f0.png';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BLOG_RSS = 'https://discord.com/blog/rss.xml';

const COLORS = {
  added: 0x57f287,
  updated: 0xfee75c,
  removed: 0xed4245,
  blog: 0x5865f2,
};

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function firstImage(html) {
  const m = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

function truncate(s, n) {
  const t = String(s || '');
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + '…';
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: opts.accept || 'text/html,application/json,*/*',
      ...(opts.headers || {}),
    },
    timeout: opts.timeout || 30000,
  });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status + ' ' + url);
    err.status = res.status;
    throw err;
  }
  return res.text();
}

async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, {
    ...opts,
    accept: 'application/json',
  });
  return JSON.parse(text);
}

function parseRssItems(xml) {
  const items = [];
  const blocks = String(xml).split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const chunk = block.split(/<\/item>/i)[0] || '';
    const get = (tag) => {
      const m = chunk.match(
        new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i'),
      );
      if (m) return m[1].trim();
      const m2 = chunk.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
      return m2 ? m2[1].trim() : null;
    };
    const title = get('title');
    const link = get('link') || get('guid');
    const pubDate = get('pubDate') || get('dc:date');
    const description = get('description') || get('content:encoded') || '';
    if (!link) continue;
    items.push({
      id: link,
      title: stripHtml(title || link),
      link,
      pubDate,
      description: stripHtml(description).slice(0, 500),
    });
  }
  return items;
}

async function fetchBlogPostBody(link) {
  try {
    const html = await fetchText(link, { timeout: 25000 });
    let body = null;
    const rich = html.match(
      /<article[^>]*class="[^"]*w-richtext[^"]*"[^>]*>([\s\S]*?)<\/article>/i,
    );
    if (rich) body = rich[1];
    if (!body) {
      const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      if (main) body = main[1];
    }
    if (!body) body = html;
    const text = stripHtml(body);
    const thumb = firstImage(body) || firstImage(html);
    return { bodyHash: sha256(text), bodyPreview: truncate(text, 400), thumb };
  } catch (e) {
    console.warn('blog body fail', link, String(e.message || e).slice(0, 80));
    return { bodyHash: null, bodyPreview: null, thumb: null };
  }
}

async function fetchBlog(oldById) {
  const xml = await fetchText(BLOG_RSS, {
    accept: 'application/rss+xml, application/xml, text/xml, */*',
  });
  const items = parseRssItems(xml);
  console.log('Blog RSS items:', items.length);

  const out = [];
  const limit = Math.min(items.length, 40);
  const queue = items.slice(0, limit);
  let i = 0;
  const workers = 4;
  async function worker() {
    while (i < queue.length) {
      const idx = i++;
      const it = queue[idx];
      const old = oldById[it.id];
      let bodyHash = old && old.bodyHash;
      let bodyPreview = old && old.bodyPreview;
      let thumb = old && old.thumb;
      const needBody = !bodyHash || !old;
      if (needBody) {
        await sleep(200);
        const b = await fetchBlogPostBody(it.link);
        bodyHash = b.bodyHash || bodyHash;
        bodyPreview = b.bodyPreview || bodyPreview;
        thumb = b.thumb || thumb;
      }
      out.push({
        id: it.id,
        title: it.title,
        link: it.link,
        pubDate: it.pubDate,
        description: it.description,
        bodyHash,
        bodyPreview,
        thumb,
        source: 'blog',
      });
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));

  for (const [id, old] of Object.entries(oldById)) {
    if (out.some((x) => x.id === id)) continue;
    if (old && old.source === 'blog') out.push(old);
  }
  return out;
}

async function fetchZendeskArticles(sourceKey) {
  const urls = [
    'https://support.discord.com/api/v2/help_center/en-us/articles.json?per_page=100&sort_by=updated_at&sort_order=desc',
    'https://discord.zendesk.com/api/v2/help_center/en-us/articles.json?per_page=100&sort_by=updated_at&sort_order=desc',
  ];
  let articles = [];
  for (const url of urls) {
    try {
      let page = url;
      let pages = 0;
      const seen = new Set();
      while (page && pages < 15) {
        pages++;
        const data = await fetchJson(page, { timeout: 30000 });
        const list = data.articles || [];
        for (const a of list) {
          if (seen.has(a.id)) continue;
          seen.add(a.id);
          const body = a.body || '';
          const text = stripHtml(body);
          articles.push({
            id: String(a.id),
            title: a.title || String(a.id),
            link:
              a.html_url ||
              'https://support.discord.com/hc/en-us/articles/' + a.id,
            updatedAt: a.updated_at || a.edited_at || null,
            createdAt: a.created_at || null,
            sectionId: a.section_id != null ? String(a.section_id) : null,
            bodyHash: sha256(text),
            bodyPreview: truncate(text, 400),
            thumb: firstImage(body),
            source: sourceKey,
            label: 'Support',
          });
        }
        page = data.next_page || null;
        if (list.length < 30) break;
        await sleep(150);
      }
      if (articles.length) {
        console.log('Zendesk', sourceKey, 'articles:', articles.length);
        return articles;
      }
    } catch (e) {
      console.warn('Zendesk fetch fail', sourceKey, String(e.message || e).slice(0, 100));
    }
  }
  return articles;
}

function indexById(list) {
  const m = {};
  for (const e of list || []) {
    if (e && e.id != null && e.id !== '') m[String(e.id)] = e;
  }
  return m;
}

function computeDiff(oldList, newList, source) {
  const oldM = indexById(oldList);
  const newM = indexById(newList);
  const added = [];
  const updated = [];
  const removed = [];
  for (const [id, n] of Object.entries(newM)) {
    const o = oldM[id];
    if (!o) {
      added.push(n);
      continue;
    }
    const changes = [];
    if (n.title && o.title && n.title !== o.title) {
      changes.push({ kind: 'title', label: 'Titre', before: o.title, after: n.title });
    }
    if (n.bodyHash && o.bodyHash && n.bodyHash !== o.bodyHash) {
      const before = (o.bodyPreview || '').trim();
      const after = (n.bodyPreview || '').trim();
      if (before && after && before !== after) {
        changes.push({
          kind: 'body',
          label: 'Contenu',
          before: o.bodyPreview || null,
          after: n.bodyPreview || null,
        });
      }
    }
    if (
      n.description &&
      o.description &&
      n.description !== o.description &&
      !changes.some((c) => c.kind === 'body')
    ) {
      changes.push({
        kind: 'description',
        label: 'Résumé RSS',
        before: o.description,
        after: n.description,
      });
    }
    if (n.link && o.link && n.link !== o.link) {
      changes.push({ kind: 'link', label: 'Lien', before: o.link, after: n.link });
    }
    if (n.thumb && o.thumb && n.thumb !== o.thumb) {
      changes.push({ kind: 'thumb', label: 'Image', before: o.thumb, after: n.thumb });
    }
    if (changes.length) {
      updated.push({
        ...n,
        _changes: changes,
        _previous: { title: o.title, bodyPreview: o.bodyPreview },
      });
    }
  }
  for (const [id, o] of Object.entries(oldM)) {
    if (!newM[id] && o.source === source) removed.push(o);
  }
  const byDate = (a, b) => {
    const da = Date.parse(a.updatedAt || a.pubDate || a.createdAt || 0) || 0;
    const db = Date.parse(b.updatedAt || b.pubDate || b.createdAt || 0) || 0;
    return db - da;
  };
  added.sort(byDate);
  updated.sort(byDate);
  return { added, updated, removed };
}

function actionMeta(action, isBlog) {
  if (action === 'added') {
    return {
      color: isBlog ? COLORS.blog : COLORS.added,
      headline: isBlog
        ? 'Nouvel article sur le blog Discord'
        : 'Nouvel article dans le centre d\'aide',
      what: isBlog
        ? 'Un nouvel article vient d\'être publié sur discord.com/blog.'
        : 'Un nouvel article d\'aide a été publié sur le support Discord.',
    };
  }
  if (action === 'updated') {
    return {
      color: COLORS.updated,
      headline: isBlog ? 'Article blog modifié' : 'Article d\'aide mis à jour',
      what: isBlog
        ? 'Des éléments de cet article blog ont changé (détail ci-dessous).'
        : 'Des éléments de cet article d\'aide ont changé (détail ci-dessous).',
    };
  }
  return {
    color: COLORS.removed,
    headline: isBlog ? 'Article blog retiré du flux' : 'Article d\'aide retiré',
    what: isBlog
      ? 'Cet article n\'apparaît plus dans le suivi (retiré du RSS ou du catalogue).'
      : 'Cet article n\'est plus listé dans le centre d\'aide Discord.',
  };
}

function formatDateFr(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 40);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    return dd + '/' + mm + '/' + yyyy + ' ' + hh + ':' + mi + ' UTC';
  } catch (_) {
    return String(iso).slice(0, 40);
  }
}

function formatChangeLines(changes) {
  if (!changes || !changes.length) return null;
  const lines = [];
  for (const c of changes) {
    if (c.kind === 'title') {
      lines.push('• **Titre**');
      lines.push('　~~' + truncate(c.before || '—', 120) + '~~');
      lines.push('　→ **' + truncate(c.after || '—', 120) + '**');
    } else if (c.kind === 'body') {
      lines.push('• **Contenu du texte** modifié');
      if (c.before) lines.push('　_Avant_ · ' + truncate(c.before, 180));
      if (c.after) lines.push('　_Après_ · ' + truncate(c.after, 180));
    } else if (c.kind === 'description') {
      lines.push('• **Résumé RSS** modifié');
      lines.push('　_Avant_ · ' + truncate(c.before || '—', 150));
      lines.push('　_Après_ · ' + truncate(c.after || '—', 150));
    } else if (c.kind === 'link') {
      lines.push('• **Lien** changé');
      lines.push(
        '　`' +
          truncate(c.before || '—', 80) +
          '` → `' +
          truncate(c.after || '—', 80) +
          '`',
      );
    } else if (c.kind === 'thumb') {
      lines.push('• **Image / miniature** changée');
    } else {
      lines.push('• **' + (c.label || c.kind) + '** modifié');
    }
  }
  return lines.join('\n');
}

/** Components V2 — blog only: image top, linked title, short excerpt, no emoji */
const IS_COMPONENTS_V2 = 1 << 15; // 32768

function buildBlogMessageV2(entry, action) {
  const title = truncate(entry.title || 'Sans titre', 200);
  const link = entry.link || '';
  const preview = truncate(
    (entry.bodyPreview || entry.description || '').trim(),
    280,
  );
  const color =
    action === 'added'
      ? COLORS.blog
      : action === 'updated'
        ? COLORS.updated
        : COLORS.removed;

  const blocks = [];

  // 1) Image tout en haut
  if (entry.thumb && /^https?:\/\//i.test(String(entry.thumb))) {
    blocks.push({
      type: 12, // MediaGallery
      items: [{ media: { url: String(entry.thumb) } }],
    });
  }

  // 2) Titre cliquable (bleu via markdown link)
  const titleMd = link
    ? '### [' + title.replace(/\]/g, '') + '](' + link + ')'
    : '### ' + title;
  blocks.push({ type: 10, content: titleMd }); // TextDisplay

  // 3) Petite partie du contenu
  if (preview) {
    blocks.push({ type: 10, content: preview });
  }

  // 4) Updated: une ligne minimale (pas d'emoji, pas de bruit)
  if (action === 'updated' && entry._changes && entry._changes.length) {
    const labels = entry._changes.map((c) => {
      if (c.kind === 'title') return 'titre';
      if (c.kind === 'body') return 'contenu';
      if (c.kind === 'description') return 'résumé';
      if (c.kind === 'thumb') return 'image';
      if (c.kind === 'link') return 'lien';
      return String(c.label || c.kind);
    });
    blocks.push({
      type: 10,
      content: 'Modifié · ' + labels.join(', '),
    });
  }

  return {
    flags: IS_COMPONENTS_V2,
    components: [
      {
        type: 17, // Container
        accent_color: color,
        components: blocks,
      },
    ],
  };
}

/** Classic embed — Zendesk (et fallback) */
function buildEmbed(entry, action) {
  const isBlog = entry.source === 'blog';
  const meta = actionMeta(action, isBlog);
  const sourceLabel = isBlog ? 'Blog Discord' : entry.label || 'Centre d\'aide Discord';
  const changes = entry._changes || [];

  const title = truncate(entry.title || 'Sans titre', 256);

  const lines = [];
  lines.push('**' + meta.headline + '**');
  lines.push(meta.what);
  lines.push('');
  lines.push('**Source** · ' + sourceLabel);
  if (entry.link) lines.push('**Lien** · [Ouvrir l\'article](' + entry.link + ')');

  if (action === 'updated' && changes.length) {
    lines.push('');
    lines.push('**Ce qui a changé**');
    const changeText = formatChangeLines(changes);
    if (changeText) lines.push(changeText);
  }

  const preview = entry.bodyPreview || entry.description || null;
  if (preview && action !== 'updated') {
    lines.push('');
    lines.push('**Aperçu**');
    lines.push(truncate(preview, 900));
  } else if (preview && action === 'updated' && !changes.some((c) => c.kind === 'body')) {
    lines.push('');
    lines.push('**Aperçu actuel**');
    lines.push(truncate(preview, 500));
  }

  const fields = [];
  if (action === 'updated' && changes.length) {
    const kinds = changes.map((c) => {
      if (c.kind === 'title') return 'Titre';
      if (c.kind === 'body') return 'Contenu';
      if (c.kind === 'description') return 'Résumé';
      if (c.kind === 'link') return 'Lien';
      if (c.kind === 'thumb') return 'Image';
      return c.label || c.kind;
    });
    fields.push({
      name: 'Éléments modifiés',
      value: kinds.map((k) => '`' + k + '`').join(' · '),
      inline: false,
    });
  } else {
    fields.push({
      name: 'Type de changement',
      value:
        action === 'added'
          ? 'Ajout (nouveau contenu)'
          : action === 'updated'
            ? 'Mise à jour'
            : 'Suppression (plus listé)',
      inline: false,
    });
  }

  const pub = formatDateFr(entry.pubDate);
  const upd = formatDateFr(entry.updatedAt);
  if (pub) fields.push({ name: 'Date de publication', value: pub, inline: true });
  if (upd) fields.push({ name: 'Dernière modification', value: upd, inline: true });
  if (entry.sectionId)
    fields.push({ name: 'Section', value: '`' + entry.sectionId + '`', inline: true });
  if (entry.id) {
    fields.push({
      name: isBlog ? 'URL / ID' : 'ID article',
      value: '`' + truncate(String(entry.id), 60) + '`',
      inline: false,
    });
  }

  return {
    author: {
      name: 'Datamining · ' + sourceLabel,
      icon_url: AVATAR,
    },
    title,
    url: entry.link || undefined,
    description: lines.join('\n').slice(0, 4090),
    color: meta.color,
    fields: fields.slice(0, 8),
    image: entry.thumb ? { url: entry.thumb } : undefined,
    footer: {
      text:
        'Datamining · ' +
        sourceLabel +
        ' · ' +
        (action === 'added'
          ? 'ajout'
          : action === 'updated'
            ? 'mise à jour' + (changes.length ? ' (' + changes.length + ')' : '')
            : 'suppression'),
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Post webhook payload.
 * - Blog: { flags, components } (Components V2)
 * - Zendesk: { embeds: [...] }
 */
async function postWebhook(payload) {
  if (!WEBHOOK) {
    console.warn('No BLOG_WEBHOOK_URL / DISCORD_WEBHOOK_URL');
    return false;
  }
  const body = {
    username: BOT_NAME,
    avatar_url: AVATAR,
    ...payload,
  };
  const r = await sendWebhook(WEBHOOK, body, { label: 'blog' });
  return r.ok;
}

async function notifyAll(diffs) {
  let sent = 0;
  let failed = 0;
  const queue = [];
  const notifyRemoved = process.env.BLOG_NOTIFY_REMOVED === '1';
  for (const [source, d] of Object.entries(diffs)) {
    for (const e of d.added || []) queue.push({ e, action: 'added', source });
    for (const e of d.updated || []) queue.push({ e, action: 'updated', source });
    if (notifyRemoved) {
      for (const e of d.removed || []) queue.push({ e, action: 'removed', source });
    }
  }
  const batch = queue.slice(0, 20);
  console.log('Notify queue:', queue.length, 'batch:', batch.length);
  const okKeys = new Set();
  const failKeys = new Set();
  for (const item of batch) {
    let ok = false;
    if (item.e.source === 'blog') {
      const payload = buildBlogMessageV2(item.e, item.action);
      ok = await postWebhook(payload);
    } else {
      const embed = buildEmbed(item.e, item.action);
      ok = await postWebhook({ embeds: [embed] });
    }
    const key = item.source + ':' + item.action + ':' + String(item.e.id);
    if (ok) {
      sent++;
      okKeys.add(key);
      console.log('sent', item.action, item.source, item.e.title);
    } else {
      failed++;
      failKeys.add(key);
      console.warn('NOTIFY_FAIL', item.action, item.source, item.e.id);
    }
    await sleep(450);
  }
  return {
    sent,
    failed,
    pending: Math.max(0, queue.length - batch.length),
    okKeys,
    failKeys,
    batch,
  };
}

function mergeStateAfterNotify(previousList, newList, result, source) {
  const prevM = indexById(previousList);
  const failedAdded = new Set();
  for (const item of result.batch || []) {
    if (item.source !== source) continue;
    if (item.action !== 'added') continue;
    const key = item.source + ':' + item.action + ':' + String(item.e.id);
    if (result.failKeys && result.failKeys.has(key)) {
      failedAdded.add(String(item.e.id));
    }
  }
  const out = [];
  for (const e of newList || []) {
    const id = String(e.id);
    if (failedAdded.has(id)) {
      if (prevM[id]) out.push(prevM[id]);
      continue;
    }
    out.push(e);
  }
  for (const [id, o] of Object.entries(prevM)) {
    if (out.some((x) => String(x.id) === id)) continue;
    if (o && o.source === source) out.push(o);
  }
  return out;
}

async function main() {
  await fs.ensureDir(DATA_DIR);
  console.log('Blog + Zendesk tracker');
  console.log(
    'Webhook:',
    WEBHOOK ? (process.env.BLOG_WEBHOOK_URL ? 'BLOG_WEBHOOK_URL' : 'fallback') : 'MISSING',
  );

  let previous = { blog: [], zendesk: [], scrapedAt: null };
  if (await fs.pathExists(STATE_FILE)) {
    try {
      previous = await fs.readJson(STATE_FILE);
    } catch (e) {
      console.warn('state read fail', e.message);
    }
  }
  const isFirst =
    !previous.scrapedAt && !(previous.blog || []).length && !(previous.zendesk || []).length;

  const oldBlogById = indexById(previous.blog || []);
  let blog = [];
  let zendesk = [];

  const [blogRes, zdRes] = await Promise.all([
    fetchBlog(oldBlogById).catch((e) => {
      console.error('blog fail', e.message);
      return previous.blog || [];
    }),
    fetchZendeskArticles('support').catch((e) => {
      console.error('zendesk fail', e.message);
      return previous.zendesk || [];
    }),
  ]);
  blog = blogRes;
  zendesk = zdRes;

  console.log('Blog entries:', blog.length, '| Zendesk:', zendesk.length);

  const diffs = {
    blog: computeDiff(previous.blog || [], blog, 'blog'),
    zendesk: computeDiff(previous.zendesk || [], zendesk, 'support'),
  };

  console.log(
    'Diff blog a/u/r',
    diffs.blog.added.length,
    diffs.blog.updated.length,
    diffs.blog.removed.length,
  );
  console.log(
    'Diff zendesk a/u/r',
    diffs.zendesk.added.length,
    diffs.zendesk.updated.length,
    diffs.zendesk.removed.length,
  );

  let nextBlog = blog;
  let nextZendesk = zendesk;

  if (isFirst) {
    console.log('First run — seed state, no notify flood');
  } else {
    const result = await notifyAll(diffs);
    console.log(
      'Notify done sent',
      result.sent,
      'failed',
      result.failed,
      'pending',
      result.pending,
    );
    nextBlog = mergeStateAfterNotify(previous.blog || [], blog, result, 'blog');
    nextZendesk = mergeStateAfterNotify(
      previous.zendesk || [],
      zendesk,
      result,
      'support',
    );
    if (result.failed > 0) process.exitCode = 2;
  }

  await fs.writeJson(
    STATE_FILE,
    {
      scrapedAt: new Date().toISOString(),
      blog: nextBlog,
      zendesk: nextZendesk,
      counts: { blog: nextBlog.length, zendesk: nextZendesk.length },
    },
    { spaces: 2 },
  );
  console.log(
    'State written',
    STATE_FILE,
    'blog',
    nextBlog.length,
    'zendesk',
    nextZendesk.length,
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
