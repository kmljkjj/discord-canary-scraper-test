'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const { pruneOldBuilds } = require('../src/lib/archive_chunks');

test('pruneOldBuilds garde les N builds les plus récents (tri numérique)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'builds-'));
  for (const bn of ['9', '100', '612234', '613549', '613546', '99999']) {
    await fs.ensureDir(path.join(dir, bn));
  }
  await fs.writeJson(path.join(dir, 'latest.json'), { buildNumber: '613549' });

  await pruneOldBuilds(dir, 3);

  const left = (await fs.readdir(dir)).sort();
  assert.deepEqual(left, ['612234', '613546', '613549', 'latest.json']);
});

test('pruneOldBuilds ne touche pas aux fichiers / dossiers non numériques', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'builds-'));
  await fs.ensureDir(path.join(dir, 'files'));
  await fs.ensureDir(path.join(dir, '1'));
  await fs.writeJson(path.join(dir, 'zip-hint.json'), {});
  await pruneOldBuilds(dir, 0);
  const left = (await fs.readdir(dir)).sort();
  assert.deepEqual(left, ['files', 'zip-hint.json']);
});
