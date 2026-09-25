'use strict';

/**
 * Test d'intégration de scripts/commit-state.sh avec de vrais dépôts git temporaires.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'commit-state.sh');

function sh(cwd, cmd, env = {}) {
  return execFileSync('bash', ['-c', cmd], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-state-'));
  const cfg = 'git config user.name t && git config user.email t@t';
  sh(root, 'git init -q --bare -b main origin.git && git clone -q origin.git a 2>/dev/null');
  const a = path.join(root, 'a');
  sh(a, `${cfg} && mkdir -p data builds/1 && echo '{"v":0}' > data/s.json && echo base > other.txt && echo 1 > builds/1/f && git add . && git commit -qm init && git push -q origin HEAD:main`);
  sh(root, 'git clone -q origin.git b');
  const b = path.join(root, 'b');
  sh(b, cfg);
  return { a, b };
}

test('aucun changement → exit 0 sans commit', () => {
  const { a } = setup();
  const out = sh(a, `${SCRIPT} "noop" data/s.json`);
  assert.match(out, /aucun changement/);
});

test('push simple + suppression dans un dossier', () => {
  const { a, b } = setup();
  sh(a, `echo '{"v":1}' > data/s.json && rm -rf builds/1 && mkdir -p builds/2 && echo 2 > builds/2/f`);
  sh(a, `${SCRIPT} "state" data/s.json builds`);
  sh(b, 'git pull -q');
  assert.equal(fs.readFileSync(path.join(b, 'data/s.json'), 'utf8').trim(), '{"v":1}');
  assert.ok(!fs.existsSync(path.join(b, 'builds/1')));
  assert.ok(fs.existsSync(path.join(b, 'builds/2/f')));
});

test('conflit : garde NOTRE état sans écraser les autres fichiers distants', () => {
  const { a, b } = setup();
  sh(b, `echo '{"v":"remote"}' > data/s.json && echo remote > other.txt && git commit -qam remote && git push -q`);
  sh(a, `echo '{"v":"local"}' > data/s.json`);
  const out = sh(a, `${SCRIPT} "state" data/s.json`);
  assert.match(out, /push OK/);
  sh(b, 'git pull -q');
  assert.equal(fs.readFileSync(path.join(b, 'data/s.json'), 'utf8').trim(), '{"v":"local"}');
  assert.equal(fs.readFileSync(path.join(b, 'other.txt'), 'utf8').trim(), 'remote');
});

test('commit concurrent sur un autre fichier → simple rebase', () => {
  const { a, b } = setup();
  sh(b, `echo remote > other.txt && git commit -qam remote && git push -q`);
  sh(a, `echo '{"v":2}' > data/s.json`);
  sh(a, `${SCRIPT} "state" data/s.json`);
  sh(b, 'git pull -q');
  assert.equal(fs.readFileSync(path.join(b, 'other.txt'), 'utf8').trim(), 'remote');
  assert.equal(fs.readFileSync(path.join(b, 'data/s.json'), 'utf8').trim(), '{"v":2}');
});
