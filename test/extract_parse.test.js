'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractRoutes,
  normalizePath,
  isValidRouteKey,
  extractExperiments,
  resolveAllChunkUrls,
  resolveEnUsLocaleUrls,
  extractLocaleStrings,
} = require('../src/lib/extract');

test('normalizePath / isValidRouteKey', () => {
  assert.equal(normalizePath('/channels/${id}'), '/channels/:param');
  assert.equal(normalizePath('/assets/a.js'), null);
  assert.equal(normalizePath('/img/logo.png'), null);
  assert.equal(normalizePath('relative/path'), null);
  assert.equal(normalizePath('/'), null);
  assert.equal(isValidRouteKey('USER_PROFILE'), true);
  assert.equal(isValidRouteKey('GET'), false);
  assert.equal(isValidRouteKey('lower'), false);
  assert.equal(isValidRouteKey('AB'), false);
});

test('extractRoutes : objets, arrow functions, affectations Endpoints.X', () => {
  const out = {};
  extractRoutes(
    'E={CHANNEL:"/channels/${id}",GUILD_SETTINGS:(e)=>"/guilds/{guildId}/settings",ASSET:"/assets/a.png",GET:"/x"};Endpoints.USER_PROFILE="/users/@me/profile"',
    out,
  );
  assert.deepEqual(out, {
    CHANNEL: '/channels/:param',
    GUILD_SETTINGS: '/guilds/{guildId}/settings',
    USER_PROFILE: '/users/@me/profile',
  });
});

// Extrait fidèle du format minifié réel de Discord
const REAL = [
  '(0,i.C)({kind:"user",name:"2026-03-content-inventory-memberlist-and-ranker",defaultConfig:{enabled:!0,impressionCappingEnabled:!0},variations:{0:{enabled:!1,impressionCappingEnabled:!1}}}),',
  'o=(0,i.C)({kind:"user",id:"2025-09_hotwheels_nvidia_boost",label:"Next iteration of the activity feed ranking model.",defaultConfig:{},treatments:[{id:16,label:"ML model V3 - Nvidia small boost",config:{}},{id:17,label:"ML model V3 - Nvidia big boost",config:{}}]});',
  'let g=(0,n(600975).C)({kind:"guild",id:"2025-08_portkey_enabled",label:"GameServer Enabled",defaultConfig:{enabled:!1},treatments:[{id:1,label:"Enable GameServer",config:{enabled:!0}}]});',
  'let h=(0,i.C)({kind:"user",name:"2026-06-other",defaultConfig:{a:1},variations:{0:{a:1},1:{a:2},2:{a:3}}});',
].join('');

test('extractExperiments : ne vole pas le label de la voisine', () => {
  const m = new Map();
  extractExperiments(REAL, m);
  assert.equal(m.get('2026-03-content-inventory-memberlist-and-ranker').label, null);
  assert.equal(
    m.get('2025-09_hotwheels_nvidia_boost').label,
    'Next iteration of the activity feed ranking model.',
  );
  assert.equal(m.get('2025-08_portkey_enabled').label, 'GameServer Enabled');
});

test('extractExperiments : variations/treatments de la bonne expérience', () => {
  const m = new Map();
  extractExperiments(REAL, m);
  assert.deepEqual(Object.keys(m.get('2025-08_portkey_enabled').variations), ['1']);
  assert.deepEqual(Object.keys(m.get('2025-09_hotwheels_nvidia_boost').variations), ['16', '17']);
  assert.deepEqual(Object.keys(m.get('2026-06-other').variations), ['0', '1', '2']);
});

test('extractExperiments : kind + defaultConfig minifié (!0 / !1)', () => {
  const m = new Map();
  extractExperiments(REAL, m);
  assert.equal(m.get('2025-08_portkey_enabled').kind, 'guild');
  assert.equal(m.get('2026-06-other').kind, 'user');
  assert.deepEqual(m.get('2025-08_portkey_enabled').defaultConfig, { enabled: false });
  assert.deepEqual(m.get('2026-03-content-inventory-memberlist-and-ranker').defaultConfig, {
    enabled: true,
    impressionCappingEnabled: true,
  });
});

test('extractExperiments ignore les ids sans contexte d’expérience', () => {
  const m = new Map();
  extractExperiments('const date = "2026-07-some_random_text"; foo(bar);', m);
  assert.equal(m.size, 0);
});

test('resolveAllChunkUrls : map id→hash, notation scientifique, fichiers libres, dédup', () => {
  const urls = resolveAllChunkUrls(
    '{123:"0123456789abcdef01",4e3:"fedcba9876543210ab",9:"0123456789abcdef01"} "aaaaaaaaaaaaaaaaaa.js"',
  );
  assert.deepEqual(urls, [
    'https://canary.discord.com/assets/0123456789abcdef01.js',
    'https://canary.discord.com/assets/fedcba9876543210ab.js',
    'https://canary.discord.com/assets/aaaaaaaaaaaaaaaaaa.js',
  ]);
  assert.deepEqual(resolveAllChunkUrls(''), []);
});

test('resolveEnUsLocaleUrls trouve le chunk en-US', () => {
  assert.deepEqual(
    resolveEnUsLocaleUrls('{12345:"0123456789abcdef01",23456:"ffffffffffffffffff"} "en-US":()=>n.e("12345")'),
    ['https://canary.discord.com/assets/0123456789abcdef01.js'],
  );
});

test('extractLocaleStrings : JSON.parse(...) + filtre des clés', () => {
  const out = {};
  extractLocaleStrings(`JSON.parse('{"5UxMLx":"Buy Nitro","abcdef":"nope"}')`, out);
  assert.equal(out['5UxMLx'], 'Buy Nitro');
  assert.equal(out.abcdef, undefined);
});
