'use strict';

/**
 * Non-regression: partial batch failure then recovery.
 * Simulates multiple embed posts; fails after first success; retries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs-extra');
const Module = require('module');

const os = require('os');

// Répertoire temporaire isolé : ne JAMAIS toucher au vrai data/notify_dedupe.json
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-test-'));
const DEDUPE = path.join(DATA, 'notify_dedupe.json');
process.env.NOTIFY_DEDUPE_FILE = DEDUPE;

let fetchImpl = null;
const originalLoad = Module._load;

function installFetchMock() {
  Module._load = function (request, parent, isMain) {
    if (request === 'node-fetch') {
      return function mockFetch(url, opts) {
        if (typeof fetchImpl === 'function') return fetchImpl(url, opts);
        return Promise.resolve({
          ok: true,
          status: 204,
          text: async () => '',
          headers: { get: () => null },
        });
      };
    }
    return originalLoad(request, parent, isMain);
  };
}

function uninstallFetchMock() {
  Module._load = originalLoad;
}

function clearNotifyModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.includes('webhook_dedupe') || key.includes('notify.js')) {
      delete require.cache[key];
    }
  }
}

async function loadNotify() {
  await fs.ensureDir(DATA);
  if (await fs.pathExists(DEDUPE)) await fs.remove(DEDUPE);
  clearNotifyModules();
  return require('../src/lib/notify');
}

function okRes() {
  return {
    ok: true,
    status: 204,
    text: async () => '',
    headers: { get: () => null },
  };
}

function failRes(status = 400) {
  return {
    ok: false,
    status,
    text: async () => 'fail',
    headers: { get: () => null },
  };
}

test('partial batch: success then fail, retry skips sent and retries failed', async (t) => {
  installFetchMock();
  t.after(() => uninstallFetchMock());

  const httpCalls = [];
  let phase = 'first';

  fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const title =
      (body.embeds && body.embeds[0] && body.embeds[0].title) || '';
    const field =
      (body.embeds &&
        body.embeds[0] &&
        body.embeds[0].fields &&
        body.embeds[0].fields[0] &&
        body.embeds[0].fields[0].name) ||
      '';
    httpCalls.push({ phase, title, field });
    if (phase === 'first') {
      if (httpCalls.filter((c) => c.phase === 'first').length === 1) return okRes();
      return failRes(400);
    }
    return okRes();
  };

  const { notifyUrgent } = await loadNotify();

  const bn = 'TEST-BATCH-' + Date.now();
  const expDiff = {
    added: [
      { id: 'exp_added_1', kind: 'user', label: 'A1' },
      { id: 'exp_added_2', kind: 'user', label: 'A2' },
    ],
    modified: [],
    removed: [{ id: 'exp_removed_1', kind: 'guild' }],
    categoryChanged: [],
  };

  const first = await notifyUrgent({
    build: { buildNumber: bn },
    expDiff,
    webhookUrl: 'https://example.test/webhook',
  });
  assert.equal(first, false, 'first run must fail overall after partial success');

  const firstCount = httpCalls.filter((c) => c.phase === 'first').length;
  assert.ok(firstCount >= 2, 'expected at least 2 HTTP attempts on first run, got ' + firstCount);

  phase = 'retry';
  const second = await notifyUrgent({
    build: { buildNumber: bn },
    expDiff,
    webhookUrl: 'https://example.test/webhook',
  });
  assert.equal(second, true, 'retry must succeed');

  const retryHttp = httpCalls.filter((c) => c.phase === 'retry');
  assert.ok(
    retryHttp.length < firstCount,
    `retry should HTTP less than first run (skip sent). first=${firstCount} retry=${retryHttp.length}`,
  );
  assert.ok(retryHttp.length >= 1, 'failed segment must be retried over HTTP');

  phase = 'done';
  const before = httpCalls.length;
  const third = await notifyUrgent({
    build: { buildNumber: bn },
    expDiff,
    webhookUrl: 'https://example.test/webhook',
  });
  assert.equal(third, true);
  const doneHttp = httpCalls.length - before;
  assert.equal(doneHttp, 0, 'fully sent batch must not re-POST embeds, got ' + doneHttp);
});

test('pending claim is not treated as successfully sent', async (t) => {
  installFetchMock();
  t.after(() => uninstallFetchMock());

  let posts = 0;
  fetchImpl = async () => {
    posts++;
    return okRes();
  };

  const dedupePath = require.resolve('../src/lib/webhook_dedupe');
  delete require.cache[dedupePath];
  const dedupe = require('../src/lib/webhook_dedupe');

  await fs.ensureDir(DATA);
  if (await fs.pathExists(DEDUPE)) await fs.remove(DEDUPE);

  const fp = 'manual-pending-' + Date.now();
  assert.equal(await dedupe.claimPosted(fp), true);
  assert.equal(await dedupe.wasPosted(fp), false);
  assert.equal(await dedupe.claimPosted(fp), false);
  assert.equal(await dedupe.wasPosted(fp), false);
  assert.equal(posts, 0, 'no HTTP involved in claim-only path');
});
