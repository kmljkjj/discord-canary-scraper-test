/**
 * Envoi robuste de webhooks Discord, partagé par tous les scripts.
 *
 * - 429 : respecte Retry-After (header), retry_after (JSON) et X-RateLimit-Reset-After
 * - 5xx / erreurs réseau / timeout : backoff exponentiel avec jitter
 * - 4xx (hors 429) : échec immédiat (payload invalide → inutile de réessayer)
 * - X-RateLimit-Remaining: 0 → attend le reset avant la requête suivante
 * - découpe les embeds en messages ≤ 10 embeds ET ≤ 6000 caractères (limites Discord)
 * - masque le token du webhook dans les logs
 */
const fetch = require('node-fetch');

const DEFAULTS = {
  maxAttempts: Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5),
  timeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS || 20000),
  baseDelayMs: 500,
  maxDelayMs: 30000,
  minGapMs: 350,
};

// Limites officielles Discord
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_EMBED_CHARS_PER_MESSAGE = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pause partagée si Discord signale un bucket épuisé
let bucketResetAt = 0;

function maskWebhook(url) {
  return String(url || '').replace(
    /(\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/i,
    '$1***',
  );
}

function isWebhookUrl(url) {
  return /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/i.test(
    String(url || ''),
  );
}

function backoff(attempt, opts) {
  const exp = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

/** Délai demandé par Discord (ms), ou 0 si inconnu. */
function retryAfterMs(res, json) {
  const h = (name) => {
    const v = res && res.headers && res.headers.get(name);
    return v == null || v === '' ? NaN : Number(v);
  };
  const candidates = [
    json && Number(json.retry_after),
    h('retry-after'),
    h('x-ratelimit-reset-after'),
  ].filter((n) => Number.isFinite(n) && n >= 0);
  if (!candidates.length) return 0;
  // Discord renvoie des secondes (float)
  return Math.ceil(Math.max(...candidates) * 1000);
}

/** Longueur « comptée » par Discord pour la limite de 6000 caractères. */
function embedChars(e) {
  if (!e || typeof e !== 'object') return 0;
  let n = 0;
  n += String(e.title || '').length;
  n += String(e.description || '').length;
  if (e.footer) n += String(e.footer.text || '').length;
  if (e.author) n += String(e.author.name || '').length;
  for (const f of e.fields || []) {
    n += String(f.name || '').length + String(f.value || '').length;
  }
  return n;
}

/** Découpe une liste d'embeds en groupes compatibles avec les limites Discord. */
function chunkEmbeds(embeds, maxPerMsg = MAX_EMBEDS_PER_MESSAGE, maxChars = MAX_EMBED_CHARS_PER_MESSAGE) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const e of embeds || []) {
    if (!e) continue;
    const c = embedChars(e);
    if (cur.length && (cur.length >= maxPerMsg || chars + c > maxChars)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(e);
    chars += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Envoie un message webhook.
 * @returns {Promise<{ok:boolean,status:number,text:string,attempts:number,json?:any}>}
 */
async function sendWebhook(url, body, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!url) return { ok: false, status: 0, text: 'no webhook url', attempts: 0 };
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const label = opts.label || '';
  let last = { ok: false, status: 0, text: '', attempts: 0 };

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    const waitBucket = bucketResetAt - Date.now();
    if (waitBucket > 0) await sleep(Math.min(waitBucket, opts.maxDelayMs));

    let res;
    try {
      res = await (opts.fetchImpl || fetch)(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        timeout: opts.timeoutMs,
      });
    } catch (e) {
      last = { ok: false, status: 0, text: String(e.message || e), attempts: attempt + 1 };
      const d = backoff(attempt, opts);
      console.warn(`webhook network error (${attempt + 1}/${opts.maxAttempts}) ${label}`, last.text, `wait ${d}ms`);
      if (attempt + 1 < opts.maxAttempts) await sleep(d);
      continue;
    }

    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    last = { ok: res.ok, status: res.status, text: text.slice(0, 500), attempts: attempt + 1, json };

    const remaining = res.headers && res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const ra = retryAfterMs(res, null);
      if (ra > 0) bucketResetAt = Date.now() + ra;
    }

    if (res.ok) {
      if (opts.minGapMs) await sleep(opts.minGapMs);
      return last;
    }

    if (res.status === 429 || res.status >= 500) {
      const ra = res.status === 429 ? retryAfterMs(res, json) : 0;
      const d = Math.min(opts.maxDelayMs, ra > 0 ? ra + 100 : backoff(attempt, opts));
      console.warn(`webhook ${res.status} (${attempt + 1}/${opts.maxAttempts}) ${label} wait ${d}ms`);
      if (attempt + 1 < opts.maxAttempts) await sleep(d);
      continue;
    }

    // 4xx : payload invalide / webhook supprimé → pas de retry
    console.warn(`webhook fail ${res.status} ${label} ${maskWebhook(url)}`, last.text.slice(0, 300));
    return last;
  }

  console.warn(`webhook gave up after ${last.attempts} attempts ${label}`, last.status, last.text.slice(0, 200));
  return last;
}

/**
 * Envoie une liste d'embeds découpée automatiquement.
 * Arrête au premier échec (retourne le résultat de l'échec).
 */
async function sendEmbeds(url, base, embeds, options = {}) {
  const groups = chunkEmbeds(embeds);
  if (!url || !groups.length) return { ok: false, status: 0, text: 'skip', attempts: 0, sent: 0 };
  let last = { ok: true, status: 204, text: '', attempts: 0 };
  let sent = 0;
  for (const g of groups) {
    last = await sendWebhook(url, { ...base, embeds: g }, options);
    if (!last.ok) return { ...last, sent };
    sent += g.length;
  }
  return { ...last, sent };
}

function _resetBucket() {
  bucketResetAt = 0;
}

module.exports = {
  sendWebhook,
  sendEmbeds,
  chunkEmbeds,
  embedChars,
  retryAfterMs,
  maskWebhook,
  isWebhookUrl,
  MAX_EMBEDS_PER_MESSAGE,
  MAX_EMBED_CHARS_PER_MESSAGE,
  _resetBucket,
};
