'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const {
  sendWebhook,
  sendEmbeds,
  chunkEmbeds,
  embedChars,
  maskWebhook,
  isWebhookUrl,
  _resetBucket,
} = require('../src/lib/webhook');

/** Petit serveur HTTP local qui rejoue une liste de réponses. */
async function withServer(responses, fn) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, body: body ? JSON.parse(body) : null });
      const r = responses[Math.min(hits.length - 1, responses.length - 1)];
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers || {}) });
      res.end(r.body ? JSON.stringify(r.body) : '');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/api/webhooks/1/tok`;
  try {
    return await fn(url, hits);
  } finally {
    server.close();
    _resetBucket();
  }
}

const FAST = { baseDelayMs: 5, maxDelayMs: 50, minGapMs: 0, timeoutMs: 2000 };

test('succès direct (204)', async () => {
  await withServer([{ status: 204 }], async (url, hits) => {
    const r = await sendWebhook(url, { content: 'hi' }, FAST);
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 1);
    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0].body, { content: 'hi' });
  });
});

test('429 avec retry_after JSON puis succès', async () => {
  await withServer(
    [{ status: 429, body: { retry_after: 0.02, global: false } }, { status: 204 }],
    async (url, hits) => {
      const t0 = Date.now();
      const r = await sendWebhook(url, { content: 'x' }, FAST);
      assert.equal(r.ok, true);
      assert.equal(r.attempts, 2);
      assert.equal(hits.length, 2);
      assert.ok(Date.now() - t0 >= 20, 'doit attendre retry_after');
    },
  );
});

test('500 est réessayé, 400 ne l’est pas', async () => {
  await withServer([{ status: 502 }, { status: 204 }], async (url) => {
    const r = await sendWebhook(url, { content: 'x' }, FAST);
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 2);
  });
  await withServer([{ status: 400, body: { message: 'Invalid Form Body' } }], async (url, hits) => {
    const r = await sendWebhook(url, { content: 'x' }, FAST);
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(hits.length, 1);
  });
});

test('abandonne après maxAttempts', async () => {
  await withServer([{ status: 503 }], async (url, hits) => {
    const r = await sendWebhook(url, { content: 'x' }, { ...FAST, maxAttempts: 3 });
    assert.equal(r.ok, false);
    assert.equal(r.attempts, 3);
    assert.equal(hits.length, 3);
  });
});

test('erreur réseau → échec propre, pas d’exception', async () => {
  const r = await sendWebhook('http://127.0.0.1:1/api/webhooks/1/x', { content: 'x' }, { ...FAST, maxAttempts: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 0);
});

test('url manquante', async () => {
  const r = await sendWebhook('', { content: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 0);
});

test('chunkEmbeds respecte 10 embeds et 6000 caractères', () => {
  const small = Array.from({ length: 25 }, (_, i) => ({ title: 'e' + i }));
  assert.deepEqual(chunkEmbeds(small).map((g) => g.length), [10, 10, 5]);

  const big = Array.from({ length: 4 }, () => ({ description: 'x'.repeat(2500) }));
  const groups = chunkEmbeds(big);
  assert.deepEqual(groups.map((g) => g.length), [2, 2]);
  for (const g of groups) {
    assert.ok(g.reduce((n, e) => n + embedChars(e), 0) <= 6000);
  }
});

test('embedChars compte titre, description, champs, footer, auteur', () => {
  const n = embedChars({
    title: 'ab',
    description: 'cde',
    fields: [{ name: 'f', value: 'gh' }],
    footer: { text: 'i' },
    author: { name: 'jk' },
  });
  assert.equal(n, 2 + 3 + 3 + 1 + 2);
});

test('sendEmbeds découpe et envoie tous les groupes', async () => {
  await withServer([{ status: 204 }], async (url, hits) => {
    const embeds = Array.from({ length: 12 }, (_, i) => ({ title: 't' + i }));
    const r = await sendEmbeds(url, { username: 'bot' }, embeds, FAST);
    assert.equal(r.ok, true);
    assert.equal(r.sent, 12);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].body.username, 'bot');
    assert.equal(hits[0].body.embeds.length, 10);
    assert.equal(hits[1].body.embeds.length, 2);
  });
});

test('sendEmbeds s’arrête au premier échec', async () => {
  await withServer([{ status: 204 }, { status: 404 }], async (url, hits) => {
    const embeds = Array.from({ length: 25 }, (_, i) => ({ title: 't' + i }));
    const r = await sendEmbeds(url, {}, embeds, FAST);
    assert.equal(r.ok, false);
    assert.equal(r.sent, 10);
    assert.equal(hits.length, 2);
  });
});

test('maskWebhook et isWebhookUrl', () => {
  const u = 'https://discord.com/api/webhooks/123456/AbC-def_ghi';
  assert.equal(maskWebhook(u), 'https://discord.com/api/webhooks/123456/***');
  assert.equal(isWebhookUrl(u), true);
  assert.equal(isWebhookUrl('https://canary.discord.com/api/v10/webhooks/1/x'), true);
  assert.equal(isWebhookUrl('https://example.com/api/webhooks/1/x'), false);
  assert.equal(isWebhookUrl(''), false);
});
