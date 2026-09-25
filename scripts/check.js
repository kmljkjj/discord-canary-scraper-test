#!/usr/bin/env node
/**
 * Vérifie la syntaxe de TOUS les fichiers JS du projet (src/, test/, docs/, scripts/).
 * Remplace l'ancienne liste manuelle dans package.json qui oubliait des fichiers.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['src', 'test', 'docs', 'scripts'];

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = DIRS.flatMap((d) => walk(path.join(ROOT, d), [])).sort();
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`✗ ${path.relative(ROOT, f)}\n${r.stderr}`);
  }
}
console.log(`syntax check: ${files.length - failed}/${files.length} OK`);
process.exit(failed ? 1 : 0);
