'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs-extra');

const os = require('os');

// Répertoire temporaire isolé : ne JAMAIS toucher au vrai data/notify_dedupe.json
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-test-'));
const DEDUPE = path.join(DATA, 'notify_dedupe.json');
process.env.NOTIFY_DEDUPE_FILE = DEDUPE;

async function freshModule() {
  await fs.ensureDir(DATA);
  if (await fs.pathExists(DEDUPE)) await fs.remove(DEDUPE);
  const modPath = require.resolve('../src/lib/webhook_dedupe');
  delete require.cache[modPath];
  return require('../src/lib/webhook_dedupe');
}

test('claim → markPosted: wasPosted true, second claim blocked', async () => {
  const d = await freshModule();
  const fp = 'test:sent:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  await d.markPosted(fp);
  assert.equal(await d.wasPosted(fp), true);
  assert.equal(await d.claimPosted(fp), false, 'already sent must not re-claim');
});

test('claim → markFailed: immediately re-claimable, wasPosted false', async () => {
  const d = await freshModule();
  const fp = 'test:fail:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  await d.markFailed(fp, 'HTTP 400');
  assert.equal(await d.wasPosted(fp), false);
  assert.equal(await d.claimPosted(fp), true, 'failed must be re-claimable');
});

test('pending claim blocks concurrent claim until stale', async () => {
  const d = await freshModule();
  const fp = 'test:pending:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  assert.equal(await d.claimPosted(fp), false, 'pending must block');
  assert.equal(await d.wasPosted(fp), false, 'pending must NOT count as sent');
});

test('stale pending is re-claimable', async () => {
  const d = await freshModule();
  const fp = 'test:stale:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  const data = await fs.readJson(DEDUPE);
  data.fps[fp] = {
    ts: Date.now() - (d.CLAIM_STALE_MS + 1000),
    status: 'pending',
  };
  await fs.writeJson(DEDUPE, data);
  assert.equal(await d.wasPosted(fp), false);
  assert.equal(await d.claimPosted(fp), true, 'stale pending re-claimable');
});

test('failed reservation is not treated as sent', async () => {
  const d = await freshModule();
  const fp = 'test:notsent:' + Date.now();
  assert.equal(await d.claimPosted(fp), true);
  await d.markFailed(fp, 'network');
  assert.equal(await d.wasPosted(fp), false);
  assert.equal(await d.claimPosted(fp), true);
  await d.markPosted(fp);
  assert.equal(await d.wasPosted(fp), true);
});
