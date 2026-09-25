'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseGlobalEnv, extractAssetUrls, prioritizeAssets } = require('../src/lib/canary');

test('parseGlobalEnv lit BUILD_NUMBER / VERSION_HASH / endpoints', () => {
  const html =
    '<script>window.GLOBAL_ENV = {"API_ENDPOINT":"//canary.discord.com/api","BUILD_NUMBER":"621556","VERSION_HASH":"abc123","RELEASE_CHANNEL":"canary"}</script>';
  const env = parseGlobalEnv(html);
  assert.equal(env.BUILD_NUMBER, '621556');
  assert.equal(env.VERSION_HASH, 'abc123');
  assert.equal(env.RELEASE_CHANNEL, 'canary');
  assert.equal(env.API_ENDPOINT, '//canary.discord.com/api');
});

test('parseGlobalEnv accepte un BUILD_NUMBER numérique non quoté', () => {
  assert.equal(parseGlobalEnv('{"BUILD_NUMBER": 612345}').BUILD_NUMBER, '612345');
  assert.equal(parseGlobalEnv("window.GLOBAL_ENV = { BUILD_NUMBER: '600001' }").BUILD_NUMBER, '600001');
});

test('parseGlobalEnv sans données → objet vide', () => {
  assert.deepEqual(parseGlobalEnv('<html></html>'), {});
});

test('extractAssetUrls : JS + CSS, absolus, sans query, sans doublon, ignore hors /assets/', () => {
  const html = `
    <script src="/assets/web.1234.js"></script>
    <script src="/assets/web.1234.js?v=2"></script>
    <link rel="stylesheet" href="/assets/app.css?x=1">
    <script src="https://cdn.example.com/other.js"></script>
    <script src="https://canary.discord.com/assets/chunk.5.js"></script>`;
  const { js, css } = extractAssetUrls(html);
  assert.deepEqual(js.sort(), [
    'https://canary.discord.com/assets/chunk.5.js',
    'https://canary.discord.com/assets/web.1234.js',
  ]);
  assert.deepEqual(css, ['https://canary.discord.com/assets/app.css']);
});

test('prioritizeAssets met le bundle web en premier', () => {
  const out = prioritizeAssets([
    'https://canary.discord.com/assets/1.js',
    'https://canary.discord.com/assets/web.abc.js',
  ]);
  assert.equal(out[0], 'https://canary.discord.com/assets/web.abc.js');
});
