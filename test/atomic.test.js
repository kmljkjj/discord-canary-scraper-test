'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');

const { writeJsonAtomic, writeFileAtomic, envInt } = require('../src/lib/atomic');

test('writeJsonAtomic écrit le JSON et ne laisse aucun fichier .tmp', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-'));
  const file = path.join(dir, 'sub', 'state.json');
  await writeJsonAtomic(file, { a: 1 });
  await writeJsonAtomic(file, { a: 2, b: [1, 2] });
  assert.deepEqual(await fs.readJson(file), { a: 2, b: [1, 2] });
  const leftovers = (await fs.readdir(path.dirname(file))).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeJsonAtomic échoue proprement sans corrompre le fichier existant', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-'));
  const file = path.join(dir, 'state.json');
  await writeJsonAtomic(file, { ok: true });
  const circular = {};
  circular.self = circular;
  await assert.rejects(() => writeJsonAtomic(file, circular));
  assert.deepEqual(await fs.readJson(file), { ok: true });
  const leftovers = (await fs.readdir(dir)).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('writeFileAtomic écrit un buffer', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-'));
  const file = path.join(dir, 'x.bin');
  await writeFileAtomic(file, Buffer.from('hello'));
  assert.equal(await fs.readFile(file, 'utf8'), 'hello');
});

test('envInt borne et valide les valeurs', () => {
  const K = 'ATOMIC_TEST_ENV_INT';
  delete process.env[K];
  assert.equal(envInt(K, 5, 1, 10), 5);
  process.env[K] = '42';
  assert.equal(envInt(K, 5, 1, 10), 10);
  process.env[K] = '-3';
  assert.equal(envInt(K, 5, 1, 10), 1);
  process.env[K] = 'abc';
  assert.equal(envInt(K, 5, 1, 10), 5);
  process.env[K] = '2.5';
  assert.equal(envInt(K, 5, 1, 10), 5);
  delete process.env[K];
});
