/**
 * Extract from Discord Canary assets.
 *
 * Pipeline:
 *  1) Clear assetsDir (no stale web.* from previous build)
 *  2) Download web.* (robust: atomic, retry, 429)
 *  3) Parallel core extract → onCore (URGENT experiments)
 *  4) Parse webpack chunk map → download ALL chunks
 *  5) en-US locales → strings
 *  6) Scan every JS for routes + experiments enrichment
 */
const fs = require('fs-extra');
const path = require('path');
const {
  downloadList,
  assertWebBundle,
  clearAssetsDir,
  getDownloadStats,
  resetDownloadStats,
  DOWNLOAD_CONCURRENCY,
} = require('./download');

// Priority path still starts with web.*; full chunks after unless disabled
const FULL_CHUNKS = process.env.SCRAPE_FULL_CHUNKS !== '0';
const DOWNLOAD_CSS = process.env.SCRAPE_CSS === '1';
const MAX_CHUNK_SCAN_BYTES = Number(process.env.MAX_CHUNK_SCAN_BYTES || 6_000_000);
const ASSET_BASE = 'https://canary.discord.com/assets/';

function matchEnd(m) {
  return m.index + m[0].length;
}

async function analyzeAssets(build, { forceRefresh, assetsDir, cacheDir, onCore }) {
  await fs.ensureDir(assetsDir);
  if (cacheDir) await fs.ensureDir(cacheDir);
  await clearAssetsDir(assetsDir);
  resetDownloadStats();

  const htmlAssets = [...(build.assets || [])];
  const cssAssets = [...(build.cssAssets || [])];

  const cssInventory = {};
  for (const url of cssAssets) {
    const name = path.basename(String(url).split('?')[0]);
    const m = name.match(/^(.+)\.([a-f0-9]{8,})\.css$/i);
    if (m) cssInventory[m[1]] = m[2];
    else cssInventory[name] = name;
  }
  console.log('CSS listed from HTML:', Object.keys(cssInventory).length);

  let webAssets = htmlAssets.filter((u) => /\/web\./i.test(u));
  if (!webAssets.length) {
    // Guessing random HTML assets produces partial extracts and false "removed".
    throw new Error(
      'WEB_BUNDLE_NOT_FOUND: no web.* in HTML assets — refuse extract (was: silent first-5 fallback)',
    );
  }
  console.log('PRIORITY: download web.* (' + webAssets.length + ')');
  await downloadList(webAssets, assetsDir, !!forceRefresh);
  await assertWebBundle(assetsDir);

  const webFiles = (await fs.readdir(assetsDir)).filter((f) => /^web\./i.test(f));
  let webContent = '';
  for (const f of webFiles) {
    webContent += await fs.readFile(path.join(assetsDir, f), 'utf8');
  }

  const strings = {};
  const routes = {};
  const expSet = new Map();

  if (webContent) {
    try {
      await extractCoreParallel(webContent, { routes, expSet, strings });
    } catch (e) {
      console.error('web extract error', e.message);
      throw e;
    }
  }

  if (typeof onCore === 'function') {
    const experiments = [...expSet.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    console.log('CORE ready', {
      experiments: experiments.length,
      routes: Object.keys(routes).length,
      stringsWeb: Object.keys(strings).length,
    });
    await onCore({
      experiments,
      routes: { ...routes },
      stringsWeb: { ...strings },
    });
  }

  const chunkUrls = resolveAllChunkUrls(webContent);
  const htmlRest = htmlAssets.filter((u) => !/\/web\./i.test(u));
  const allUrls = dedupeUrls([...chunkUrls, ...htmlRest]);
  console.log('Webpack chunks mapped:', chunkUrls.length, '| HTML extras:', htmlRest.length, '| total unique:', allUrls.length);

  if (FULL_CHUNKS && allUrls.length) {
    console.log('FULL DOWNLOAD: all chunks (concurrency', DOWNLOAD_CONCURRENCY + ')');
    await downloadList(allUrls, assetsDir, false);
  } else if (!FULL_CHUNKS) {
    console.log('SCRAPE_FULL_CHUNKS=0 — skip mass chunk download');
  }

  const localeUrls = resolveEnUsLocaleUrls(webContent);
  console.log('en-US locale chunks:', localeUrls.length);
  if (localeUrls.length) {
    await downloadList(localeUrls, assetsDir, true);
    let fromLocale = 0;
    for (const url of localeUrls) {
      const name = path.basename(url.split('?')[0]);
      const fp = path.join(assetsDir, name);
      try {
        if (!(await fs.pathExists(fp))) continue;
        const content = await fs.readFile(fp, 'utf8');
        const before = Object.keys(strings).length;
        extractLocaleStrings(content, strings);
        fromLocale += Object.keys(strings).length - before;
      } catch (e) {
        console.warn('locale', name, e.message);
      }
    }
    console.log('Strings from en-US locales +', fromLocale, 'total', Object.keys(strings).length);
  }

  const jsFiles = (await fs.readdir(assetsDir)).filter((f) => f.endsWith('.js'));
  console.log('Scanning', jsFiles.length, 'JS files for routes/experiments');

  // Coverage: distinguish downloaded vs actually parsed (false "removed" risk).
  const coverage = {
    jsOnDisk: jsFiles.length,
    webFiles: 0,
    scanned: 0,
    skippedEmpty: 0,
    skippedOversize: 0,
    skippedWeb: 0,
    readErrors: 0,
    bytesScanned: 0,
    bytesSkippedOversize: 0,
    maxScanBytes: MAX_CHUNK_SCAN_BYTES,
    chunkUrlsMapped: chunkUrls.length,
    localeUrlsMapped: localeUrls.length,
    fullChunks: !!FULL_CHUNKS,
  };

  for (const f of jsFiles) {
    if (/^web\./i.test(f)) {
      coverage.webFiles++;
      coverage.skippedWeb++;
      continue; // already extracted in core path
    }
    const fp = path.join(assetsDir, f);
    try {
      const st = await fs.stat(fp);
      if (st.size === 0) {
        coverage.skippedEmpty++;
        continue;
      }
      if (st.size > MAX_CHUNK_SCAN_BYTES) {
        coverage.skippedOversize++;
        coverage.bytesSkippedOversize += st.size;
        continue;
      }
      const content = await fs.readFile(fp, 'utf8');
      extractRoutes(content, routes);
      extractExperiments(content, expSet);
      if (st.size < 500_000) extractStrings(content, strings);
      coverage.scanned++;
      coverage.bytesScanned += st.size;
    } catch (e) {
      coverage.readErrors++;
      if (coverage.readErrors <= 8) {
        console.warn('chunk read error', f, e && e.message ? e.message : e);
      }
    }
  }

  const secondaryCandidates =
    coverage.jsOnDisk - coverage.webFiles - coverage.skippedEmpty;
  const scannedDenom = Math.max(secondaryCandidates, 1);
  coverage.scanRatio =
    Math.round((coverage.scanned / scannedDenom) * 1000) / 1000;
  coverage.oversizeRatio =
    Math.round(
      (coverage.skippedOversize / Math.max(coverage.jsOnDisk - coverage.webFiles, 1)) *
        1000,
    ) / 1000;

  coverage.degraded = false;
  coverage.degradedReasons = [];
  if (FULL_CHUNKS && coverage.chunkUrlsMapped >= 40) {
    if (coverage.jsOnDisk < coverage.chunkUrlsMapped * 0.5) {
      coverage.degraded = true;
      coverage.degradedReasons.push('JS_ON_DISK_LT_HALF_MAPPED_CHUNKS');
    }
  }
  if (coverage.oversizeRatio > 0.15 && coverage.skippedOversize >= 3) {
    coverage.degraded = true;
    coverage.degradedReasons.push('TOO_MANY_OVERSIZE_SKIPPED');
  }
  if (coverage.readErrors >= 10) {
    coverage.degraded = true;
    coverage.degradedReasons.push('TOO_MANY_READ_ERRORS');
  }
  if (
    secondaryCandidates >= 20 &&
    coverage.scanRatio < 0.7 &&
    coverage.skippedOversize + coverage.readErrors > 0
  ) {
    coverage.degraded = true;
    coverage.degradedReasons.push('LOW_SCAN_RATIO');
  }

  console.log('Scanned extra chunks:', coverage.scanned, '| coverage', coverage);

  console.log('Extract totals', {
    strings: Object.keys(strings).length,
    routes: Object.keys(routes).length,
    experiments: expSet.size,
    css: Object.keys(cssInventory).length,
    jsOnDisk: jsFiles.length,
    coverage,
  });

  if (DOWNLOAD_CSS && cssAssets.length) {
    console.log('Downloading CSS:', cssAssets.length);
    await downloadList(cssAssets, assetsDir, !!forceRefresh);
  }

  console.log('Download integrity summary', getDownloadStats());
  return {
    experiments: [...expSet.values()].sort((a, b) => a.id.localeCompare(b.id)),
    strings,
    routes,
    css: cssInventory,
    downloadStats: getDownloadStats(),
    coverage,
  };
}

async function extractCoreParallel(webContent, { routes, expSet, strings }) {
  await Promise.all([
    Promise.resolve().then(() => extractRoutes(webContent, routes)),
    Promise.resolve().then(() => extractExperiments(webContent, expSet)),
    Promise.resolve().then(() => extractStrings(webContent, strings)),
  ]);
}

function resolveAllChunkUrls(webContent) {
  if (!webContent) return [];
  const hashById = new Map();
  const re1 = /(\d{1,7}):["']([a-f0-9]{16,22})["']/g;
  let m;
  while ((m = re1.exec(webContent)) !== null) {
    hashById.set(m[1], m[2]);
  }
  const reSci = /(\d+e\d+):["']([a-f0-9]{16,22})["']/gi;
  while ((m = reSci.exec(webContent)) !== null) {
    const id = String(Number(m[1]));
    if (Number.isFinite(Number(id))) hashById.set(id, m[2]);
  }
  const reFile = /["']([a-f0-9]{16,22})\.js["']/g;
  const looseHashes = new Set();
  while ((m = reFile.exec(webContent)) !== null) looseHashes.add(m[1]);
  const urls = [];
  const seen = new Set();
  for (const hash of hashById.values()) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    urls.push(ASSET_BASE + hash + '.js');
  }
  for (const hash of looseHashes) {
    if (seen.has(hash)) continue;
    seen.add(hash);
    urls.push(ASSET_BASE + hash + '.js');
  }
  return urls;
}

function resolveEnUsLocaleUrls(webContent) {
  if (!webContent) return [];
  const chunkMap = {};
  const reMap = /(\d{3,6}):["']([a-f0-9]{16,22})["']/g;
  let m;
  while ((m = reMap.exec(webContent)) !== null) chunkMap[m[1]] = m[2];
  const chunkIds = new Set();
  const reEn = /["']en-US["']\s*:\s*\(\)\s*=>\s*n\.e\(["'](\d+)["']\)/g;
  while ((m = reEn.exec(webContent)) !== null) chunkIds.add(m[1]);
  const reJson = /\.\/en-US\.json["']\s*:\s*["'](\d+)["']/g;
  while ((m = reJson.exec(webContent)) !== null) chunkIds.add(m[1]);
  const urls = [];
  const seen = new Set();
  for (const id of chunkIds) {
    const hash = chunkMap[id];
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);
    urls.push(ASSET_BASE + hash + '.js');
  }
  return urls;
}

function dedupeUrls(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

function extractLocaleStrings(content, out) {
  const reParse = /JSON\.parse\('((?:\\'|[^'])*)'\)/g;
  let m;
  while ((m = reParse.exec(content)) !== null) {
    let raw = m[1];
    try {
      raw = raw
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        );
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        if (!isGoodStringKey(k)) continue;
        const text = flattenIcu(v);
        if (isGoodStringVal(text)) out[k] = text;
      }
    } catch {
      extractStringsFromLocaleBlob(raw, out);
    }
  }
  extractStringsFromLocaleBlob(content, out);
  extractStrings(content, out);
}

function flattenIcu(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((part) => {
        if (typeof part === 'string') return part;
        if (Array.isArray(part) && part.length >= 2) return '{' + part[1] + '}';
        return '';
      })
      .join('');
  }
  return null;
}

function extractStringsFromLocaleBlob(content, out) {
  const reArr =
    /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*\[\s*([\s\S]*?)\s*\]/g;
  let m;
  while ((m = reArr.exec(content)) !== null) {
    if (!isGoodStringKey(m[1])) continue;
    const inner = m[2];
    const parts = [];
    const rePart =
      /["']([^"'\\]*(?:\\.[^"'\\]*)*)["']|\[\s*\d+\s*,\s*["']([^"']+)["']\s*\]/g;
    let p;
    while ((p = rePart.exec(inner)) !== null) {
      if (p[1] != null) {
        try {
          parts.push(JSON.parse('"' + p[1] + '"'));
        } catch {
          parts.push(p[1]);
        }
      } else if (p[2] != null) {
        parts.push('{' + p[2] + '}');
      }
    }
    if (!parts.length) continue;
    const text = parts.join('');
    if (isGoodStringVal(text)) out[m[1]] = text;
  }
}

function inferType(id) {
  const s = String(id || '').toLowerCase();
  if (/guild|server|role|channel_list|community|moderat|automod|raid/.test(s))
    return 'guild';
  return 'user';
}

function isGoodStringKey(k) {
  if (typeof k !== 'string' || k.length !== 6) return false;
  if (!/^[A-Za-z0-9+/_-]{6}$/.test(k)) return false;
  if (/^[0-9a-f]{6}$/i.test(k)) return false;
  return true;
}

function isGoodStringVal(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 1 || s.length > 800) return false;
  if (/^discord_web-/i.test(s) || /^release:/i.test(s)) return false;
  return true;
}

function extractStrings(content, out) {
  const re =
    /["']([A-Za-z0-9+/_-]{6})["']\s*:\s*["']([^"'\\]*(?:\\.[^"'\\]*)*)["']/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    let val = m[2];
    try {
      val = JSON.parse('"' + val + '"');
    } catch {}
    if (isGoodStringKey(m[1]) && isGoodStringVal(val)) out[m[1]] = val;
  }
}

function isValidRouteKey(key) {
  if (typeof key !== 'string') return false;
  if (!/^[A-Z][A-Z0-9_]{2,120}$/.test(key)) return false;
  if (/^(GET|PUT|POST|PATCH|DELETE|HEAD|OPTIONS|TRUE|FALSE|NULL)$/.test(key))
    return false;
  return true;
}

function normalizePath(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p.startsWith('/')) return null;
  if (p.length < 2 || p.length > 300) return null;
  p = p.replace(/\$\{[^}]+\}/g, ':param');
  if (/\.(js|css|map|png|jpg|webp|svg|woff2?)$/i.test(p)) return null;
  if (p.startsWith('/assets/')) return null;
  return p;
}

function extractRoutes(content, out) {
  const re =
    /\b([A-Z][A-Z0-9_]{2,100})\s*:\s*["'`](\/[a-zA-Z0-9_\-./{}@:$]+)["'`]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re2 =
    /["']([A-Z][A-Z0-9_]{2,100})["']\s*:\s*["'](\/[^"']{1,250})["']/g;
  while ((m = re2.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re3 =
    /\.([A-Z][A-Z0-9_]{2,100})\s*=\s*["'](\/[a-zA-Z0-9_\-./{}@:$]+)["']/g;
  while ((m = re3.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re4 =
    /(?:Endpoints|Routes|API_ENDPOINTS|APIRoutes)\s*(?:\.|\[)\s*["']?([A-Z][A-Z0-9_]{2,100})["']?\s*(?:\])?\s*=\s*["'`](\/[^"'`]{1,250})["'`]/g;
  while ((m = re4.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
  const re5 =
    /\b([A-Z][A-Z0-9_]{2,100})\s*:\s*(?:\([^)]*\)\s*=>\s*)?["'`](\/[a-zA-Z0-9_\-./{}@:$]+)["'`]/g;
  while ((m = re5.exec(content)) !== null) {
    const p = normalizePath(m[2]);
    if (isValidRouteKey(m[1]) && p) out[m[1]] = p;
  }
}

function extractExperiments(content, map) {
  const reNK =
    /\{\s*name\s*:\s*["'](20[2-3]\d-(?:0[1-9]|1[0-2])[_-][a-z0-9][a-z0-9_\-]{2,90})["']\s*,\s*kind\s*:\s*["'](user|guild)["']/gi;
  let m;
  while ((m = reNK.exec(content)) !== null) {
    upsertExp(map, m[1], m[2].toLowerCase(), content, matchEnd(m));
  }
  const reKN =
    /\{\s*kind\s*:\s*["'](user|guild)["']\s*,\s*name\s*:\s*["'](20[2-3]\d-(?:0[1-9]|1[0-2])[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  while ((m = reKN.exec(content)) !== null) {
    upsertExp(map, m[2], m[1].toLowerCase(), content, matchEnd(m));
  }

  const reId = /["'](20[2-3]\d-(?:0[1-9]|1[0-2])[_-][a-z0-9][a-z0-9_\-]{2,90})["']/gi;
  while ((m = reId.exec(content)) !== null) {
    const id = m[1];
    if (/^20\d{2}-\d{2}$/.test(id)) continue;
    if (map.has(id)) continue;
    const start = Math.max(0, m.index - 180);
    const end = Math.min(content.length, m.index + id.length + 280);
    const ctx = content.slice(start, end);
    const looksExp =
      /kind\s*:\s*["'](user|guild)["']/i.test(ctx) ||
      /\b(experiment|experiments|getExperiment|useExperiment|Exposure)\b/i.test(ctx) ||
      /variations\s*:/i.test(ctx) ||
      /treatments\s*:/i.test(ctx);
    if (!looksExp) continue;
    let type = null;
    if (/kind\s*:\s*["']guild["']/i.test(ctx)) type = 'guild';
    else if (/kind\s*:\s*["']user["']/i.test(ctx)) type = 'user';
    else type = inferType(id);
    const variations = countVariationsNear(content, m.index);
    map.set(id, {
      id,
      type,
      kind: type,
      label: extractLabelNear(content, m.index) || null,
      system: 'apex',
      defaultConfig: extractDefaultConfigNear(content, m.index),
      variations,
      variationCount: variations ? Object.keys(variations).length : 0,
      source: 'discord',
    });
  }
}

function extractDefaultConfigNear(content, from) {
  const window = content.slice(from, from + 2800);
  const m = window.match(/defaultConfig\s*:\s*\{/);
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  for (; i < window.length && depth > 0; i++) {
    if (window[i] === '{') depth++;
    else if (window[i] === '}') depth--;
  }
  const body = window.slice(start, i - 1);
  const out = {};
  const re = /([A-Za-z_][\w]*)\s*:\s*(true|false|null|\d+|["'][^"']*["'])/g;
  let x;
  while ((x = re.exec(body)) !== null) {
    let v = x[2];
    if (v === 'true') v = true;
    else if (v === 'false') v = false;
    else if (v === 'null') v = null;
    else if (/^\d+$/.test(v)) v = Number(v);
    else v = v.replace(/^["']|["']$/g, '');
    out[x[1]] = v;
  }
  return Object.keys(out).length ? out : null;
}

function extractLabelNear(content, from) {
  const window = content.slice(Math.max(0, from - 200), from + 1200);
  const m =
    window.match(/label\s*:\s*["']([^"']{3,120})["']/) ||
    window.match(/title\s*:\s*["']([^"']{3,120})["']/);
  return m ? m[1] : null;
}

function upsertExp(map, id, kind, content, posAfter) {
  if (!id || /^20\d{2}-\d{2}$/.test(id)) return;
  const variations = countVariationsNear(content, posAfter);
  const defaultConfig = extractDefaultConfigNear(content, posAfter);
  const label = extractLabelNear(content, posAfter);
  const hasTreatmentsArray = /treatments\s*:\s*\[/.test(
    content.slice(posAfter, posAfter + 2800),
  );
  const system = hasTreatmentsArray ? 'legacy' : 'apex';
  const existing = map.get(id);
  if (existing) {
    if (kind === 'guild') {
      existing.type = 'guild';
      existing.kind = 'guild';
    }
    if (
      variations &&
      (!existing.variations ||
        Object.keys(variations).length >
          Object.keys(existing.variations || {}).length)
    ) {
      existing.variations = variations;
      existing.variationCount = Object.keys(variations).length;
    }
    if (defaultConfig && !existing.defaultConfig) existing.defaultConfig = defaultConfig;
    if (label && !existing.label) existing.label = label;
    if (!existing.system) existing.system = system;
    return;
  }
  map.set(id, {
    id,
    type: kind,
    kind,
    label: label || null,
    system,
    defaultConfig: defaultConfig || null,
    variations,
    variationCount: variations ? Object.keys(variations).length : 0,
    source: 'discord',
  });
}

function countVariationsNear(content, from) {
  const window = content.slice(from, from + 2800);
  let m = window.match(/variations\s*:\s*\{/);
  if (!m) m = window.match(/treatments\s*:\s*\[/);
  if (!m) m = window.match(/treatments\s*:\s*\{/);
  if (!m) return null;

  const isArray = /treatments\s*:\s*\[/.test(m[0]);
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  for (; i < window.length && depth > 0; i++) {
    if (window[i] === open) depth++;
    else if (window[i] === close) depth--;
  }
  const body = window.slice(start, i - 1);
  const out = {};
  if (isArray) {
    const ids = [...body.matchAll(/\bid\s*:\s*(\d+)/g)].map((x) => x[1]);
    if (ids.length) {
      for (const k of ids) out[k] = { id: Number(k) };
    } else {
      let n = 0;
      let d = 0;
      for (const ch of body) {
        if (ch === '{') {
          if (d === 0) n++;
          d++;
        } else if (ch === '}') d = Math.max(0, d - 1);
      }
      if (n <= 0) return null;
      for (let k = 0; k < n && k < 40; k++) out[String(k)] = { id: k };
    }
  } else {
    const keys = [...body.matchAll(/(?:^|[,{])\s*(\d+)\s*:/g)].map((x) => x[1]);
    if (!keys.length) return null;
    for (const k of keys) {
      const entry = { id: Number(k) };
      const re = new RegExp('(?:^|[,{])\s*' + k + '\s*:\s*\{([^}]{0,400})\}');
      const block = body.match(re);
      if (block) {
        const inner = block[1];
        const pct =
          inner.match(/percentage\s*:\s*([0-9.]+)/i) ||
          inner.match(/percent\s*:\s*([0-9.]+)/i) ||
          inner.match(/rate\s*:\s*([0-9.]+)/i);
        if (pct) {
          const n = Number(pct[1]);
          if (Number.isFinite(n)) entry.percentage = n;
        }
        const start = inner.match(/(?:start|min|from)\s*:\s*([0-9.]+)/i);
        const end = inner.match(/(?:end|max|to)\s*:\s*([0-9.]+)/i);
        if (start && end) {
          entry.start = Number(start[1]);
          entry.end = Number(end[1]);
        }
        const enabled = inner.match(/enabled\s*:\s*([0-9.]+)/i);
        const total = inner.match(/total\s*:\s*([0-9.]+)/i);
        if (enabled && total) {
          entry.enabled = Number(enabled[1]);
          entry.total = Number(total[1]);
        }
      }
      out[k] = entry;
    }
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  analyzeAssets,
  getDownloadStats,
  isGoodStringKey,
  isGoodStringVal,
  extractRoutes,
  isValidRouteKey,
  normalizePath,
  inferType,
  resolveEnUsLocaleUrls,
  resolveAllChunkUrls,
  extractLocaleStrings,
  extractExperiments,
  extractCoreParallel,
};
