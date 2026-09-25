/**
 * Canary Pulse v11.10 — transactional notify + degraded extract guard
 */
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { fetchBuild } = require('./lib/canary');
const { analyzeAssets } = require('./lib/extract');
const { loadState, makeRunId } = require('./lib/state');
const { notifyUrgent, notifyNormal } = require('./lib/notify');
const { archiveBuildChunks, writeZipHint } = require('./lib/archive_chunks');
const { writeJsonAtomic } = require('./lib/atomic');
const experimentState = require('./lib/experiment_state');
const { publishDataGeneration } = require('./lib/publish_data');
const ALREADY_NOTIFIED = require('./lib/already_notified');

const DATA = path.join(__dirname, '..', 'data');
const ASSETS = path.join(__dirname, '..', 'assets');
const BUILDS = path.join(__dirname, '..', 'builds');
const CACHE = path.join(DATA, 'cache');
const KNOWN_EXP = path.join(DATA, 'known_experiment_ids.json');
const KNOWN_STR = path.join(DATA, 'known_string_keys.json');
const KNOWN_RT = path.join(DATA, 'known_route_keys.json');
const LAST_EXTRACT_STR = path.join(DATA, 'last_extract_strings.json');
const LAST_EXTRACT_RT = path.join(DATA, 'last_extract_routes.json');
const LAST_EXTRACT_EXP = path.join(DATA, 'last_extract_experiments.json');
const ANNOUNCED = path.join(DATA, 'announced_builds.json');
const LAST_RUN_META = path.join(DATA, 'last_run_meta.json');

const MAX_NOTIFY_EXP = 30;
const MAX_NOTIFY_STR = 80;
const MAX_NOTIFY_RT = 40;
const MIN_STRINGS_FOR_DIFF = 200;
const MIN_ROUTES_FOR_DIFF = 50;
const MIN_EXP_FOR_DIFF = 80;

async function loadKnownIds(file, fromAlready) {
  const set = new Set();
  if (fromAlready) for (const id of ALREADY_NOTIFIED) set.add(String(id));
  try {
    if (await fs.pathExists(file)) {
      const d = await fs.readJson(file);
      for (const id of d.ids || d.keys || []) set.add(String(id));
    }
  } catch {}
  return set;
}

async function loadLastMap(file) {
  try {
    if (!(await fs.pathExists(file))) return {};
    const d = await fs.readJson(file);
    const raw =
      d.data && typeof d.data === 'object'
        ? d.data
        : d.strings || d.routes || d.experiments || d || {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'buildNumber' || k === 'updatedAt' || k === 'count' || k === 'data')
        continue;
      out[k] = v;
    }
    return out;
  } catch (e) {
    console.warn('loadLastMap fail', file, e.message);
    return {};
  }
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = stableObject(value[key]);
        return out;
      }, {});
  }
  return value;
}

function expFingerprint(e) {
  if (!e || typeof e !== 'object') return '';
  const type = e.type === 'guild' || e.kind === 'guild' ? 'guild' : 'user';
  let keys = [];
  if (e.variations && typeof e.variations === 'object')
    keys = Object.keys(e.variations).sort((a, b) => Number(a) - Number(b));
  else if (Array.isArray(e.treatments))
    keys = e.treatments.map((_, i) => String(i));
  else if (typeof e.variationCount === 'number' && e.variationCount > 0)
    keys = Array.from({ length: e.variationCount }, (_, i) => String(i));
  const payload = stableObject({
    type,
    label: e.label || null,
    keys,
    variationCount: keys.length || e.variationCount || 0,
    variations: e.variations || null,
  });
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

function expSnapshot(e) {
  return {
    id: e.id,
    type: e.type || e.kind || 'user',
    kind: e.kind || e.type || 'user',
    label: e.label || null,
    variationCount:
      e.variationCount || (e.variations ? Object.keys(e.variations).length : 0) || 0,
    variations: e.variations || null,
    fp: expFingerprint(e),
  };
}

function buildGap(prevBuild, remoteBuild) {
  const a = parseInt(String(prevBuild || ''), 10);
  const b = parseInt(String(remoteBuild || ''), 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, b - a);
}


function computeExpDiff(findingsExps, lastExp, knownExp, opts) {
  // Build next snapshots for last_extract persistence
  const nextExpSnap = {};
  const currentRaw = [];
  for (const e of findingsExps || []) {
    if (!e || !e.id || String(e.id).startsWith('hash:')) continue;
    const id = String(e.id);
    nextExpSnap[id] = expSnapshot(e);
    currentRaw.push(e);
  }

  const previousList = [];
  for (const [id, e] of Object.entries(lastExp || {})) {
    if (!e) continue;
    previousList.push(
      experimentState.normalizeExperiment({
        ...(typeof e === 'object' ? e : {}),
        id: (e && e.id) || id,
      }),
    );
  }
  const previous = previousList.filter(Boolean);
  const current = currentRaw
    .map((e) => experimentState.normalizeExperiment(e))
    .filter(Boolean);

  const lastExpCount = previous.length;
  const extractedExpCount = current.length;

  // Guard: not enough data for a reliable diff (same thresholds as before)
  if (extractedExpCount < MIN_EXP_FOR_DIFF || lastExpCount < 40) {
    return {
      expDiff: {
        added: [],
        modified: [],
        removed: [],
        categoryChanged: [],
      },
      nextExpSnap,
      coverage: experimentState.assessCoverage({
        currentCount: extractedExpCount,
        previousCount: lastExpCount,
        extractionStatus: 'incomplete',
      }),
    };
  }

  const coverage = experimentState.assessCoverage({
    currentCount: extractedExpCount,
    previousCount: lastExpCount,
    extractionStatus: 'complete',
  });

  // Unique source of truth
  const rawDiff = experimentState.diffExperiments(
    previous,
    current,
    coverage.reliable,
    {
      knownIds: knownExp,
      maxAdded: MAX_NOTIFY_EXP,
      maxModified: 20,
      maxRemoved: 15,
      maxCategoryChanged: 20,
    },
  );

  const expDiff = experimentState.toNotifyExpDiff(rawDiff);
  return { expDiff, nextExpSnap, coverage, rawDiff };
}

async function main() {
  const t0 = Date.now();
  console.log('=== Canary Pulse v11.10 ===');
  await fs.ensureDir(DATA);
  await fs.ensureDir(ASSETS);
  await fs.ensureDir(BUILDS);
  await fs.ensureDir(CACHE);

  const [prev, knownExp, knownStr, knownRt, lastStr, lastRt, lastExp] =
    await Promise.all([
      loadState(DATA),
      loadKnownIds(KNOWN_EXP, true),
      loadKnownIds(KNOWN_STR, false),
      loadKnownIds(KNOWN_RT, false),
      loadLastMap(LAST_EXTRACT_STR),
      loadLastMap(LAST_EXTRACT_RT),
      loadLastMap(LAST_EXTRACT_EXP),
    ]);

  console.log('Known / last', {
    knownExp: knownExp.size,
    lastExp: Object.keys(lastExp).length,
    lastStr: Object.keys(lastStr).length,
    lastRt: Object.keys(lastRt).length,
  });

  let build;
  try {
    build = await fetchBuild();
  } catch (e) {
    console.error('fetchBuild failed', e.message);
    process.exit(1);
  }

  const prevBuildNum = prev.build && prev.build.buildNumber;
  const gap = buildGap(prevBuildNum, build.buildNumber);
  const isCatchUp = gap > 1;

  console.log(
    'STATE',
    JSON.stringify({
      remote: build.buildNumber,
      prevBuild: prevBuildNum,
      gap,
      catchUp: isCatchUp,
      t_html: Date.now() - t0 + 'ms',
    }),
  );

  if (!build.buildNumber || build.buildNumber === 'unknown') {
    console.error('No BUILD_NUMBER');
    process.exit(1);
  }

  const isNewBuild =
    !prev.build ||
    !prev.build.buildNumber ||
    String(prev.build.buildNumber) !== String(build.buildNumber);

  const needsExtractSeed =
    Object.keys(lastStr).length < 50 ||
    Object.keys(lastRt).length < 20 ||
    Object.keys(lastExp).length < 40;

  try {
    if (await fs.pathExists(LAST_RUN_META)) {
      const meta = await fs.readJson(LAST_RUN_META);
      const same = String(meta.buildNumber || '') === String(build.buildNumber);
      const age = Date.now() - Number(meta.ts || 0);
      if (same && age >= 0 && age < 3 * 60 * 1000 && meta.ok && !needsExtractSeed) {
        console.log('COOLDOWN SKIP', build.buildNumber, Math.round(age / 1000) + 's since last success');
        process.exit(0);
      }
    }
  } catch (e) {
    console.warn('last_run_meta read', e.message);
  }

  if (
    !isNewBuild &&
    prev.initialized &&
    !needsExtractSeed &&
    Object.keys(lastExp).length > 40
  ) {
    console.log('FAST SKIP', build.buildNumber, Date.now() - t0 + 'ms');
    process.exit(0);
  }

  let alreadyBuild = await wasBuildAnnounced(build.buildNumber);
  if (isNewBuild && alreadyBuild) {
    console.log('BUILD already announced', build.buildNumber);
  }

  let findings;
  let urgentSent = false;
  try {
    findings = await analyzeAssets(build, {
      forceRefresh: isNewBuild || needsExtractSeed,
      assetsDir: ASSETS,
      cacheDir: CACHE,
      onCore: async ({ experiments }) => {
        if (needsExtractSeed && !isNewBuild) return;
        if (!process.env.DISCORD_WEBHOOK_URL) return;
        const coreCount = (experiments || []).length;
        const lastCount = Object.keys(lastExp || {}).length;
        // CORE is web.* only — never treat incomplete CORE as a full diff.
        // Only pure ADDS (id absent from lastExp) are safe here.
        // Modified/removed wait for the full chunk extract.
        const { expDiff } = computeExpDiff(experiments, lastExp, knownExp, {
          skipKnownFilter: isCatchUp,
        });
        const pureAdded = (expDiff.added || []).filter((e) => {
          const id = String(e && e.id != null ? e.id : e);
          return id && !(id in (lastExp || {}));
        });
        if (lastCount >= 40 && coreCount < lastCount * 0.85) {
          console.log('URGENT: CORE incomplete vs lastExp — adds only', {
            coreCount,
            lastCount,
            ratio: Math.round((coreCount / Math.max(lastCount, 1)) * 1000) / 1000,
            pureAdded: pureAdded.length,
            strippedModified: (expDiff.modified || []).length,
            strippedRemoved: (expDiff.removed || []).length,
          });
        }
        const urgentDiff = {
          added: pureAdded,
          modified: [],
          removed: [],
          categoryChanged: [],
        };
        if (!urgentDiff.added.length) {
          console.log('URGENT: no safe pure-add delta', Date.now() - t0 + 'ms');
          return;
        }
        console.log('URGENT experiments', {
          added: urgentDiff.added.length,
          modified: 0,
          removed: 0,
          coreOnly: true,
          t: Date.now() - t0 + 'ms',
        });
        const ok = await notifyUrgent({
          build,
          expDiff: urgentDiff,
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
          isNewBuild,
          catchUp: isCatchUp,
          prevBuild: prevBuildNum,
        });
        if (ok) {
          urgentSent = true;
          // In-memory only until publishDataGeneration — no early disk write
          for (const e of urgentDiff.added) knownExp.add(String(e.id || e));
        } else {
          console.warn('URGENT webhook failed — NOT marking known exp');
        }
      },
    });
  } catch (e) {
    console.error('analyzeAssets failed', e);
    process.exit(1);
  }
  console.log('Extract done', Date.now() - t0 + 'ms');

  {
    const expN = (findings.experiments || []).length;
    const strN = Object.keys(findings.strings || {}).length;
    const rtN = Object.keys(findings.routes || {}).length;
    const ds = findings.downloadStats || {};
    const baseExp = Object.keys(lastExp).length;
    const baseStr = Object.keys(lastStr).length;
    const baseRt = Object.keys(lastRt).length;
    console.log('Integrity check', {
      expN,
      strN,
      rtN,
      baseExp,
      baseStr,
      baseRt,
      downloadStats: ds,
    });

    if (expN === 0 && strN < 50 && baseExp > 40) {
      try {
        await fs.writeJson(LAST_RUN_META, {
          schemaVersion: 1,
          buildNumber: String(build.buildNumber),
          ts: Date.now(),
          status: 'failed',
          ok: false,
          reason: 'EXTRACTION_EMPTY',
          downloadStats: ds,
        });
      } catch {}
      console.error(
        'EXTRACTION_ERROR: empty extract vs non-empty baseline — refuse state update',
      );
      process.exit(1);
    }

    const solidBaseline = baseExp >= 80 && baseStr >= 200;
    if (solidBaseline) {
      const ratioExp = expN / Math.max(baseExp, 1);
      const ratioStr = strN / Math.max(baseStr, 1);
      const ratioRt = baseRt >= 50 ? rtN / Math.max(baseRt, 1) : 1;
      const degraded =
        (ratioExp < 0.6 && ratioStr < 0.7) ||
        (ratioStr < 0.6 && ratioExp < 0.7) ||
        ratioExp < 0.5 ||
        ratioStr < 0.5;
      if (degraded) {
        try {
          await fs.writeJson(LAST_RUN_META, {
            schemaVersion: 1,
            buildNumber: String(build.buildNumber),
            ts: Date.now(),
            status: 'failed',
            ok: false,
            reason: 'EXTRACTION_DEGRADED',
            ratios: {
              exp: Math.round(ratioExp * 1000) / 1000,
              str: Math.round(ratioStr * 1000) / 1000,
              rt: Math.round(ratioRt * 1000) / 1000,
            },
            counts: { expN, strN, rtN, baseExp, baseStr, baseRt },
            downloadStats: ds,
            coverage: findings.coverage || null,
          });
        } catch {}
        console.error(
          'EXTRACTION_ERROR: degraded extract vs solid baseline — refuse state update',
          { ratioExp, ratioStr, ratioRt, expN, strN, baseExp, baseStr },
        );
        process.exit(1);
      }
    }

    // Chunk coverage from extract.js — incomplete scan must not look like a valid diff.
    const cov = findings.coverage || null;
    if (cov && cov.degraded) {
      try {
        await fs.writeJson(LAST_RUN_META, {
          schemaVersion: 1,
          buildNumber: String(build.buildNumber),
          ts: Date.now(),
          status: 'failed',
          ok: false,
          reason: 'EXTRACTION_COVERAGE_DEGRADED',
          coverage: cov,
          downloadStats: ds,
          counts: { expN, strN, rtN, baseExp, baseStr, baseRt },
        });
      } catch {}
      console.error(
        'EXTRACTION_ERROR: chunk coverage degraded — refuse state update',
        cov.degradedReasons || [],
        {
          scanRatio: cov.scanRatio,
          oversize: cov.skippedOversize,
          readErrors: cov.readErrors,
          jsOnDisk: cov.jsOnDisk,
          mapped: cov.chunkUrlsMapped,
        },
      );
      process.exit(1);
    }
  }

  try {
    const manifest = await archiveBuildChunks({
      build,
      assetsDir: ASSETS,
      buildsDir: BUILDS,
    });
    if (manifest) await writeZipHint(BUILDS, build.buildNumber, manifest);
  } catch (e) {
    console.warn('archive chunks failed', e.message);
  }

  const extractedStrings = { ...(findings.strings || {}) };
  const nextRt = { ...(findings.routes || {}) };
  const extractedStrCount = Object.keys(extractedStrings).length;
  const extractedRtCount = Object.keys(nextRt).length;
  const extractedExpCount = (findings.experiments || []).length;

  console.log(
    'EXTRACT',
    JSON.stringify({
      experiments: extractedExpCount,
      strings: extractedStrCount,
      routes: extractedRtCount,
    }),
  );

  if (extractedExpCount < 20 && extractedStrCount < 100) {
    console.warn('empty extract — abort without state advance');
    process.exit(1);
  }

  const {
    expDiff,
    nextExpSnap,
    rawDiff,
  } = computeExpDiff(
    findings.experiments,
    lastExp,
    knownExp,
    { skipKnownFilter: isCatchUp },
  );

  const strDiff = { added: {}, modified: {}, removed: {} };
  const lastStrCount = Object.keys(lastStr).length;
  if (extractedStrCount >= MIN_STRINGS_FOR_DIFF && lastStrCount >= 50) {
    for (const [k, v] of Object.entries(extractedStrings)) {
      if (!(k in lastStr)) {
        if (isCatchUp || !knownStr.has(k)) strDiff.added[k] = v;
      } else if (String(lastStr[k]) !== String(v)) strDiff.modified[k] = v;
    }
    const ratio = extractedStrCount / Math.max(lastStrCount, 1);
    if (ratio >= 0.75 && ratio <= 1.35) {
      for (const [k, v] of Object.entries(lastStr)) {
        if (!(k in extractedStrings)) strDiff.removed[k] = v;
      }
      if (Object.keys(strDiff.removed).length > 120) strDiff.removed = {};
    }
    const ak = Object.keys(strDiff.added);
    if (ak.length > MAX_NOTIFY_STR) {
      const keep = {};
      for (const k of ak.slice(0, MAX_NOTIFY_STR)) keep[k] = strDiff.added[k];
      strDiff.added = keep;
    }
  }

  const rtDiff = { added: {}, modified: {}, removed: {} };
  const lastRtCount = Object.keys(lastRt).length;
  if (extractedRtCount >= MIN_ROUTES_FOR_DIFF && lastRtCount >= 20) {
    for (const [k, v] of Object.entries(nextRt)) {
      if (!(k in lastRt)) {
        if (isCatchUp || !knownRt.has(k)) rtDiff.added[k] = v;
      } else if (String(lastRt[k]) !== String(v)) rtDiff.modified[k] = v;
    }
    const ratio = extractedRtCount / lastRtCount;
    if (ratio >= 0.75 && ratio <= 1.35) {
      for (const [k, v] of Object.entries(lastRt)) {
        if (!(k in nextRt)) rtDiff.removed[k] = v;
      }
      if (Object.keys(rtDiff.removed).length > 40) rtDiff.removed = {};
    }
    const rk = Object.keys(rtDiff.added);
    if (rk.length > MAX_NOTIFY_RT) {
      const keep = {};
      for (const k of rk.slice(0, MAX_NOTIFY_RT)) keep[k] = rtDiff.added[k];
      rtDiff.added = keep;
    }
  }

  if (!isNewBuild && needsExtractSeed) {
    expDiff.added = [];
    expDiff.modified = [];
    expDiff.removed = [];
    expDiff.categoryChanged = [];
    strDiff.added = {};
    strDiff.modified = {};
    strDiff.removed = {};
    rtDiff.added = {};
    rtDiff.modified = {};
    rtDiff.removed = {};
  }

  console.log('TRUE DIFF', {
    urgentSent,
    exp: {
      added: expDiff.added.length,
      modified: expDiff.modified.length,
      removed: expDiff.removed.length,
      categoryChanged: (expDiff.categoryChanged || []).length,
    },
    str: {
      added: Object.keys(strDiff.added).length,
      modified: Object.keys(strDiff.modified).length,
      removed: Object.keys(strDiff.removed).length,
    },
    rt: {
      added: Object.keys(rtDiff.added).length,
      modified: Object.keys(rtDiff.modified).length,
      removed: Object.keys(rtDiff.removed).length,
    },
  });

  alreadyBuild =
    (typeof alreadyBuild !== 'undefined' && alreadyBuild) ||
    (await wasBuildAnnounced(build.buildNumber));

  let okN = true;
  if (process.env.DISCORD_WEBHOOK_URL) {
    try {
      if (!urgentSent) {
        const okU = await notifyUrgent({
          build,
          expDiff,
          webhookUrl: process.env.DISCORD_WEBHOOK_URL,
          isNewBuild,
          catchUp: isCatchUp,
          prevBuild: prevBuildNum,
        });
        if (okU) {
          for (const e of expDiff.added) knownExp.add(String(e.id || e));
        } else {
          console.warn('URGENT retry path failed — NOT marking known exp');
        }
      } else {
        // CORE already announced pure adds — still send full-extract residual
        // (modified / removed / category) without re-sending added.
        const residual = {
          added: [],
          modified: expDiff.modified || [],
          removed: expDiff.removed || [],
          categoryChanged: expDiff.categoryChanged || [],
        };
        const nRes =
          residual.modified.length +
          residual.removed.length +
          residual.categoryChanged.length;
        if (nRes) {
          console.log('URGENT residual after CORE', {
            modified: residual.modified.length,
            removed: residual.removed.length,
            categoryChanged: residual.categoryChanged.length,
          });
          const okR = await notifyUrgent({
            build,
            expDiff: residual,
            webhookUrl: process.env.DISCORD_WEBHOOK_URL,
            isNewBuild,
            catchUp: isCatchUp,
            prevBuild: prevBuildNum,
          });
          if (!okR) {
            console.warn('URGENT residual webhook failed');
          }
        } else {
          console.log('URGENT already sent — no residual mod/removed');
        }
      }

      okN = await notifyNormal({
        build,
        isNewBuild: false,
        strDiff,
        rtDiff,
        webhookUrl: process.env.DISCORD_WEBHOOK_URL,
      });
      if (okN) {
        for (const k of Object.keys(strDiff.added)) knownStr.add(k);
        for (const k of Object.keys(rtDiff.added)) knownRt.add(k);
      } else {
        console.warn('NORMAL webhook failed — NOT marking known str/rt');
      }
      if (isNewBuild && !alreadyBuild && okN) {
        await markBuild(build.buildNumber);
        alreadyBuild = true;
        console.log('BUILD marked after successful notifies', build.buildNumber);
      } else if (isNewBuild && !alreadyBuild && !okN) {
        console.warn('BUILD NOT marked — normal webhook failed (will retry)');
      }
    } catch (e) {
      console.warn('notify failed', e.message);
    }
  } else {
    for (const e of expDiff.added) knownExp.add(String(e.id || e));
    for (const k of Object.keys(strDiff.added)) knownStr.add(k);
    for (const k of Object.keys(rtDiff.added)) knownRt.add(k);
    if (isNewBuild && !alreadyBuild) {
      await markBuild(build.buildNumber);
      alreadyBuild = true;
    }
  }
  console.log('Notify done', Date.now() - t0 + 'ms');

  // Full transactional gate: nothing durable advances if normal notify failed
  // when there was something to announce (strings/routes). Experiments last_extract
  // and saveState are also gated so the next run can retry webhooks.
  const strRtOk = typeof okN === 'undefined' ? true : okN;
  const hadNormalDiff =
    Object.keys(strDiff.added).length +
      Object.keys(strDiff.modified).length +
      Object.keys(strDiff.removed).length +
      Object.keys(rtDiff.added).length +
      Object.keys(rtDiff.modified).length +
      Object.keys(rtDiff.removed).length >
    0;
  const notifyCriticalOk = !process.env.DISCORD_WEBHOOK_URL
    ? true
    : strRtOk || !hadNormalDiff;

  if (!notifyCriticalOk) {
    console.warn(
      'NOTIFY_FAIL: skipping ALL state advance (last_extract + saveState) — will retry next run',
    );
    try {
      await fs.writeJson(LAST_RUN_META, {
        schemaVersion: 1,
        buildNumber: String(build.buildNumber),
        ts: Date.now(),
        status: 'notify_failed',
        ok: false,
        reason: 'WEBHOOK_NORMAL_FAILED',
        durationMs: Date.now() - t0,
        experiments: (findings.experiments || []).length,
        strings: Object.keys(extractedStrings || {}).length,
        routes: Object.keys(nextRt || {}).length,
        downloadStats: findings.downloadStats || null,
      });
    } catch {}
    // Do not advance known_* on notify failure — next run must still see new items
    process.exit(2);
  }

  // --- Atomic data generation (all-or-nothing after successful notify) ---
  const runId = makeRunId(build.buildNumber);
  const bn = String(build.buildNumber);
  const tsIso = new Date().toISOString();

  const knownExpIds = [...knownExp]
    .filter((id) => id && !String(id).startsWith('hash:'))
    .sort();
  const knownStrIds = [...knownStr].filter(Boolean).sort();
  const knownRtIds = [...knownRt].filter(Boolean).sort();
  // knownExp is append-only — never truncate
  if (knownStrIds.length > 50000) knownStrIds.splice(0, knownStrIds.length - 50000);
  if (knownRtIds.length > 10000) knownRtIds.splice(0, knownRtIds.length - 10000);

  const normalized = (findings.experiments || [])
    .map(experimentState.normalizeExperiment)
    .filter(Boolean);
  const previousCurrent = await experimentState.loadCurrentExperiments(DATA);
  const previousRemoved = await experimentState.loadRemovedExperiments(DATA);
  const cov = experimentState.assessCoverage({
    currentCount: normalized.length,
    previousCount: previousCurrent.length,
    extractionStatus: 'complete',
  });
  console.log('EXP_STATE coverage', cov);
  const nextKnown = experimentState.mergeKnownIds(knownExpIds, normalized);
  const nextRemoved = experimentState.updateRemovedExperiments({
    previousCurrent,
    current: normalized,
    existingRemoved: previousRemoved,
    allowRemovals: !!cov.reliable,
    buildNumber: bn,
    confirmedRemovedIds: (
      (rawDiff && (rawDiff.removedAll || rawDiff.removed)) ||
      expDiff.removed ||
      []
    ).map((e) => String(typeof e === 'string' ? e : e && e.id)),
  });

  const allExps = findings.experiments || [];
  const apexList = allExps
    .filter((e) => e.system !== 'legacy')
    .map((e) => ({
      kind: e.kind || e.type || 'user',
      name: e.id,
      defaultConfig: e.defaultConfig || null,
      variations: e.variations || null,
      label: e.label || null,
    }));
  const legacyList = allExps.filter((e) => e.system === 'legacy');

  let mergedExps = mergeExp(prev.experiments, findings.experiments);
  if (expDiff.removed.length) {
    const drop = new Set(expDiff.removed.map((e) => String(e.id || e)));
    mergedExps = mergedExps.filter((e) => !drop.has(String(e.id)));
  }
  const mergedStrings = { ...(prev.strings || {}), ...extractedStrings };
  for (const k of Object.keys(strDiff.removed)) delete mergedStrings[k];
  const mergedRoutes = { ...(prev.routes || {}), ...nextRt };
  for (const k of Object.keys(rtDiff.removed)) delete mergedRoutes[k];

  const stamp = { runId, buildNumber: bn };
  const files = {
    'known_experiment_ids.json': {
      ...stamp,
      updatedAt: tsIso,
      count: nextKnown.length,
      ids: nextKnown,
    },
    'known_string_keys.json': {
      ...stamp,
      updatedAt: tsIso,
      count: knownStrIds.length,
      ids: knownStrIds,
    },
    'known_route_keys.json': {
      ...stamp,
      updatedAt: tsIso,
      count: knownRtIds.length,
      ids: knownRtIds,
    },
    'last_extract_experiments.json': {
      ...stamp,
      updatedAt: tsIso,
      count: Object.keys(nextExpSnap || {}).length,
      data: nextExpSnap || {},
    },
    'last_extract_strings.json': {
      ...stamp,
      updatedAt: tsIso,
      count: Object.keys(extractedStrings || {}).length,
      data: extractedStrings || {},
    },
    'last_extract_routes.json': {
      ...stamp,
      updatedAt: tsIso,
      count: Object.keys(nextRt || {}).length,
      data: nextRt || {},
    },
    'current_experiments.json': {
      ...stamp,
      updatedAt: tsIso,
      count: normalized.length,
      experiments: normalized,
    },
    'removed_experiments.json': {
      ...stamp,
      updatedAt: tsIso,
      count: nextRemoved.length,
      experiments: nextRemoved,
    },
    'apex_experiments.json': apexList,
    'experiments.json': {
      ...stamp,
      scrapedAt: tsIso,
      totals: {
        all: mergedExps.length,
        legacy: legacyList.length,
        apex: apexList.length,
      },
      // Always full merge — legacy-only broke baseline load (6 vs 360)
      experiments: mergedExps,
      legacyExperiments: legacyList,
    },
    'build.json': {
      ...stamp,
      versionHash: build.versionHash || null,
      releaseChannel: build.releaseChannel || 'canary',
      scrapedAt: build.scrapedAt || tsIso,
      assetCount: Array.isArray(build.assets) ? build.assets.length : null,
      cssCount: Array.isArray(build.cssAssets) ? build.cssAssets.length : null,
    },
    'findings.json': {
      ...stamp,
      scrapedAt: tsIso,
      totals: { all: mergedExps.length },
      experiments: mergedExps,
    },
    'strings.json': mergedStrings,
    'routes.json': mergedRoutes,
    'meta.json': {
      ...stamp,
      initialized: true,
      updatedAt: tsIso,
      experimentCount: mergedExps.length,
      stringCount: Object.keys(mergedStrings).length,
      routeCount: Object.keys(mergedRoutes).length,
      lastBuild: bn,
    },
    'last_run_meta.json': {
      schemaVersion: 1,
      runId,
      buildNumber: bn,
      ts: Date.now(),
      status: 'success',
      ok: true,
      versionHash: build.versionHash || null,
      durationMs: Date.now() - t0,
      experiments: (findings.experiments || []).length,
      strings: Object.keys(extractedStrings || {}).length,
      routes: Object.keys(nextRt || {}).length,
      downloadStats: findings.downloadStats || null,
    },
  };

  try {
    await publishDataGeneration(DATA, {
      runId,
      buildNumber: bn,
      files,
    });
    console.log('EXP_STATE published', {
      current: normalized.length,
      known: nextKnown.length,
      removed: nextRemoved.length,
      reliable: cov.reliable,
    });
  } catch (e) {
    console.error('DATA_PUBLISH failed — baseline not advanced', e.message);
    try {
      await fs.writeJson(LAST_RUN_META, {
        schemaVersion: 1,
        runId,
        buildNumber: bn,
        ts: Date.now(),
        status: 'publish_failed',
        ok: false,
        reason: String(e.message || e).slice(0, 500),
        durationMs: Date.now() - t0,
      });
    } catch {}
    process.exit(1);
  }

  console.log('=== Done', Date.now() - t0 + 'ms ===');
}

function mergeExp(prev, next) {
  const map = new Map();
  for (const e of prev || []) {
    if (e == null) continue;
    if (typeof e === 'object') {
      if (!e.id) continue;
      map.set(String(e.id), e);
    } else if (e !== '') {
      map.set(String(e), { id: String(e) });
    }
  }
  for (const e of next || []) {
    if (!e || typeof e !== 'object' || !e.id) continue;
    map.set(String(e.id), e);
  }
  return [...map.values()].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
}

async function markBuild(buildNumber) {
  let data = { builds: [] };
  try {
    if (await fs.pathExists(ANNOUNCED)) data = await fs.readJson(ANNOUNCED);
  } catch {}
  const set = new Set((data.builds || []).map(String));
  set.add(String(buildNumber));
  await writeJsonAtomic(ANNOUNCED, {
    builds: [...set].slice(-300),
    updatedAt: new Date().toISOString(),
  });
}

async function wasBuildAnnounced(buildNumber) {
  try {
    if (!(await fs.pathExists(ANNOUNCED))) return false;
    const data = await fs.readJson(ANNOUNCED);
    return (data.builds || []).map(String).includes(String(buildNumber));
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
