'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { murmur3, intervalsToPct } = require('../src/lib/guild_decode');

test('murmur3 (x86_32, seed 0) = vecteurs de référence', () => {
  assert.equal(murmur3(''), 0);
  assert.equal(murmur3('hello'), 613153351);
  assert.equal(murmur3('The quick brown fox jumps over the lazy dog'), 776992547);
});

test('murmur3 est stable et non signé', () => {
  const a = murmur3('2026-09_test:123456789012345678');
  assert.equal(a, murmur3('2026-09_test:123456789012345678'));
  assert.ok(a >= 0 && a <= 0xffffffff);
});

test('intervalsToPct : formats objet/tableau, échelle 10000, borné à 100', () => {
  assert.equal(intervalsToPct([]), 0);
  assert.equal(intervalsToPct(null), 0);
  assert.equal(intervalsToPct([{ start: 0, end: 500 }, [1000, 1500]]), 10);
  assert.equal(intervalsToPct([{ s: 0, e: 10000 }]), 100);
  assert.equal(intervalsToPct([[0, 20000]]), 100);
  assert.equal(intervalsToPct([[500, 100]]), 0, 'intervalle inversé ignoré');
});
