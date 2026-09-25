#!/usr/bin/env node
/**
 * Écrit un résumé lisible du dernier run dans l'onglet « Summary » de GitHub Actions.
 * Usage : node scripts/summary.js   (ne fait rien hors Actions)
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const out = process.env.GITHUB_STEP_SUMMARY;

function read(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8'));
  } catch {
    return null;
  }
}

const meta = read('last_run_meta.json') || {};
const build = read('build.json') || {};
const n = (v) => (v == null ? '—' : Number(v).toLocaleString('fr-FR'));
const status = meta.ok ? '✅ succès' : meta.status ? `⚠️ ${meta.status}` : '—';
const dl = meta.downloadStats || {};

const lines = [
  `## Canary Pulse — build ${build.buildNumber || meta.buildNumber || '?'}`,
  '',
  '| | |',
  '|---|---|',
  `| Statut | ${status}${meta.reason ? ` (${meta.reason})` : ''} |`,
  `| Version hash | \`${String(build.versionHash || meta.versionHash || '—').slice(0, 12)}\` |`,
  `| Expériences | ${n(meta.experiments)} |`,
  `| Strings | ${n(meta.strings)} |`,
  `| Routes | ${n(meta.routes)} |`,
  `| Assets JS | ${n(build.assetCount)} |`,
  `| Durée | ${meta.durationMs ? (meta.durationMs / 1000).toFixed(1) + ' s' : '—'} |`,
];
if (dl && Object.keys(dl).length) {
  lines.push(`| Téléchargements | ${n(dl.ok ?? dl.downloaded)} OK · ${n(dl.failed)} échecs · ${n(dl.http429)} × 429 |`);
}
lines.push('');

const md = lines.join('\n');
if (out) fs.appendFileSync(out, md + '\n');
else console.log(md);
