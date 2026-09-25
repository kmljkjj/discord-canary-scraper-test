/**
 * Archive downloaded Discord assets per build number.
 * - builds/{build}/manifest.json  (always)
 * - builds/{build}/web.*.js       (main bundle, committed to git)
 * - builds/{build}/files/*        (all chunks on disk for zip/release)
 *
 * Env:
 *   ARCHIVE_CHUNKS=1          enable (default 1)
 *   ARCHIVE_KEEP_BUILDS=8     how many build folders to keep in repo
 *   ARCHIVE_COPY_ALL=1        copy every JS into builds/{bn}/files/
 */
const fs = require('fs-extra');
const path = require('path');

const ENABLED = process.env.ARCHIVE_CHUNKS !== '0';
const KEEP = Math.max(2, Number(process.env.ARCHIVE_KEEP_BUILDS || 8));
const COPY_ALL = process.env.ARCHIVE_COPY_ALL !== '0';

async function archiveBuildChunks({ build, assetsDir, buildsDir }) {
  if (!ENABLED) {
    console.log('ARCHIVE_CHUNKS=0 — skip');
    return null;
  }
  if (!build || !build.buildNumber || build.buildNumber === 'unknown') {
    console.warn('archive: no build number');
    return null;
  }

  const bn = String(build.buildNumber);
  const outDir = path.join(buildsDir, bn);
  const filesDir = path.join(outDir, 'files');
  await fs.ensureDir(outDir);
  if (COPY_ALL) await fs.ensureDir(filesDir);

  const names = (await fs.readdir(assetsDir)).filter(
    (f) => f.endsWith('.js') || f.endsWith('.css'),
  );

  const files = [];
  let totalBytes = 0;
  let copied = 0;

  for (const name of names) {
    const src = path.join(assetsDir, name);
    let st;
    try {
      st = await fs.stat(src);
    } catch {
      continue;
    }
    if (!st.size) continue;

    const entry = {
      name,
      size: st.size,
      url: `https://canary.discord.com/assets/${name}`,
      kind: /^web\./i.test(name)
        ? 'web'
        : name.endsWith('.css')
          ? 'css'
          : 'chunk',
    };

    // Always keep web.* next to manifest (for git)
    if (entry.kind === 'web') {
      const dest = path.join(outDir, name);
      try {
        await fs.copy(src, dest, { overwrite: true });
        entry.archived = true;
        copied++;
      } catch (e) {
        console.warn('copy web fail', name, e.message);
      }
    } else if (COPY_ALL) {
      const dest = path.join(filesDir, name);
      try {
        // skip if already same size
        if (await fs.pathExists(dest)) {
          const dst = await fs.stat(dest);
          if (dst.size === st.size) {
            entry.archived = true;
            copied++;
          } else {
            await fs.copy(src, dest, { overwrite: true });
            entry.archived = true;
            copied++;
          }
        } else {
          await fs.copy(src, dest, { overwrite: true });
          entry.archived = true;
          copied++;
        }
      } catch (e) {
        if (copied < 5) console.warn('copy fail', name, e.message);
      }
    }

    files.push(entry);
    totalBytes += st.size;
  }

  files.sort((a, b) => a.name.localeCompare(b.name));

  const manifest = {
    buildNumber: bn,
    versionHash: build.versionHash || null,
    releaseChannel: build.releaseChannel || 'canary',
    scrapedAt: build.scrapedAt || new Date().toISOString(),
    archivedAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes,
    totalMB: Math.round((totalBytes / 1024 / 1024) * 100) / 100,
    web: files.filter((f) => f.kind === 'web').map((f) => f.name),
    files,
  };

  await fs.writeJson(path.join(outDir, 'manifest.json'), manifest, { spaces: 2 });

  // Latest pointer
  await fs.writeJson(
    path.join(buildsDir, 'latest.json'),
    {
      buildNumber: bn,
      versionHash: build.versionHash || null,
      path: `builds/${bn}`,
      fileCount: files.length,
      totalMB: manifest.totalMB,
      updatedAt: manifest.archivedAt,
    },
    { spaces: 2 },
  );

  console.log('Archived build', bn, {
    files: files.length,
    copied,
    totalMB: manifest.totalMB,
    out: outDir,
  });

  await pruneOldBuilds(buildsDir, KEEP);
  return manifest;
}

async function pruneOldBuilds(buildsDir, keep) {
  const entries = await fs.readdir(buildsDir);
  const dirs = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const p = path.join(buildsDir, name);
    const st = await fs.stat(p);
    if (st.isDirectory()) dirs.push({ name, n: Number(name) });
  }
  dirs.sort((a, b) => b.n - a.n);
  const drop = dirs.slice(keep);
  for (const d of drop) {
    try {
      await fs.remove(path.join(buildsDir, d.name));
      console.log('Pruned old build archive', d.name);
    } catch (e) {
      console.warn('prune fail', d.name, e.message);
    }
  }
}

/** Write a marker file listing zip path for the workflow */
async function writeZipHint(buildsDir, buildNumber, manifest) {
  await fs.writeJson(
    path.join(buildsDir, 'zip-hint.json'),
    {
      buildNumber: String(buildNumber),
      folder: `builds/${buildNumber}`,
      filesDir: `builds/${buildNumber}/files`,
      manifest: `builds/${buildNumber}/manifest.json`,
      totalMB: manifest && manifest.totalMB,
      fileCount: manifest && manifest.fileCount,
    },
    { spaces: 2 },
  );
}

module.exports = {
  archiveBuildChunks,
  writeZipHint,
  pruneOldBuilds,
};
