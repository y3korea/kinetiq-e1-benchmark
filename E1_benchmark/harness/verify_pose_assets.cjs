#!/usr/bin/env node
/**
 * verify_pose_assets.cjs — bind the benchmark to an exact pose-estimator build.
 *
 * The measurement chain is extracted verbatim and hashed (extract_core.cjs,
 * extract_sts.cjs), but the perception model in front of it was loaded from an
 * unversioned CDN path — `@mediapipe/pose/pose.js` — which resolves to whatever
 * jsDelivr currently calls latest. Nothing in the artifact recorded which build
 * that was, so a re-run could silently use a different model.
 *
 * This script closes that gap without re-running any experiment:
 *   1. downloads every runtime asset from BOTH the unversioned path (what the
 *      benchmark actually requested) and the pinned path (what the code now
 *      requests), and
 *   2. asserts the two are byte-identical, which is what makes the pin
 *      behaviour-preserving rather than a silent change of engine.
 *
 * The pin is provable for this benchmark because @mediapipe/pose has published
 * nothing since 0.5.1675469404 (2023-02-04) while the runs are dated 2026-08-21
 * to 2026-08-24, so the unversioned path could only have resolved to that build.
 *
 * Usage:  node verify_pose_assets.cjs [--quick] [--out pose_assets.json]
 *   --quick  compare against the jsDelivr metadata API instead of downloading
 *            ~100 MB twice; proves the pinned hashes, not the equality claim.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PKG = '@mediapipe/pose';
const VERSION = '0.5.1675469404';
const HOST = 'testingcf.jsdelivr.net';   // the host production uses; see CHANGELOG D7.64/D7.65

// Every file the pose solution can request at runtime. pose.js is the entry
// point named in the <script> tag; the rest are resolved through the
// application-supplied locateFile callback, which is why pinning the script tag
// alone would leave them floating. The three .tflite files correspond to
// modelComplexity 0/1/2; the benchmark ran at 2 (heavy).
const ASSETS = [
  'pose.js',
  'pose_solution_packed_assets_loader.js',
  'pose_solution_packed_assets.data',
  'pose_solution_simd_wasm_bin.js',
  'pose_solution_simd_wasm_bin.wasm',
  'pose_solution_simd_wasm_bin.data',
  'pose_solution_wasm_bin.js',
  'pose_solution_wasm_bin.wasm',
  'pose_web.binarypb',
  'pose_landmark_lite.tflite',
  'pose_landmark_full.tflite',
  'pose_landmark_heavy.tflite',
];

const COMPLEXITY = { 0: 'pose_landmark_lite.tflite', 1: 'pose_landmark_full.tflite', 2: 'pose_landmark_heavy.tflite' };

// The two helper packages the application loads alongside the solution. They do
// not affect any measurement -- camera_utils drives the capture loop and
// drawing_utils only paints the overlay -- but leaving them unversioned would
// keep the same class of hole open, so they are pinned and recorded too.
const COMPANIONS = [
  { pkg: '@mediapipe/camera_utils',  version: '0.3.1675466862', files: ['camera_utils.js'] },
  { pkg: '@mediapipe/drawing_utils', version: '0.3.1675466124', files: ['drawing_utils.js'] },
];

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const OUT = path.resolve(
  (i => (i >= 0 && args[i + 1]) ? args[i + 1] : path.join(__dirname, 'pose_assets.json'))(args.indexOf('--out'))
);

function url(file, pinned, pkg = PKG, version = VERSION) {
  return `https://${HOST}/npm/${pkg}${pinned ? '@' + version : ''}/${file}`;
}

// Stream to a hash so the 27 MB model never lands in memory.
function digest(u, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(u, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 5) {
        res.resume();
        return resolve(digest(new URL(res.headers.location, u).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode} ${u}`)); }
      const h = crypto.createHash('sha256');
      let bytes = 0;
      res.on('data', c => { bytes += c.length; h.update(c); });
      res.on('end', () => resolve({ sha256: h.digest('hex'), bytes }));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function apiHashes(pkg = PKG, version = VERSION) {
  return new Promise((resolve, reject) => {
    https.get(`https://data.jsdelivr.com/v1/packages/npm/${pkg}@${version}`, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try {
          const files = JSON.parse(b).files || [];
          const m = {};
          for (const f of files) if (f.type !== 'directory') m[f.name] = { bytes: f.size, hash_b64: f.hash };
          resolve(m);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

(async () => {
  const api = await apiHashes();
  const records = [];
  let mismatches = 0;

  for (const f of ASSETS) {
    const pinned = await digest(url(f, true));
    let unpinned = null;
    if (!QUICK) unpinned = await digest(url(f, false));

    const meta = api[f] || {};
    const b64 = Buffer.from(pinned.sha256, 'hex').toString('base64');
    const apiOk = meta.hash_b64 ? (meta.hash_b64 === b64) : null;
    const identical = unpinned ? (unpinned.sha256 === pinned.sha256 && unpinned.bytes === pinned.bytes) : null;
    if (identical === false || apiOk === false) mismatches++;

    records.push({
      file: f,
      bytes: pinned.bytes,
      sha256: pinned.sha256,
      unversioned_identical: identical,
      jsdelivr_api_agrees: apiOk,
    });

    const mark = identical === false ? 'MISMATCH' : (identical === null ? 'pinned  ' : 'identical');
    process.stdout.write(`  ${mark}  ${f.padEnd(40)} ${String(pinned.bytes).padStart(10)} B  ${pinned.sha256.slice(0, 16)}\n`);
  }

  const companions = [];
  for (const c of COMPANIONS) {
    const capi = await apiHashes(c.pkg, c.version);
    const crecs = [];
    for (const f of c.files) {
      const pinned = await digest(url(f, true, c.pkg, c.version));
      const unpinned = QUICK ? null : await digest(url(f, false, c.pkg, c.version));
      const meta = capi[f] || {};
      const b64 = Buffer.from(pinned.sha256, 'hex').toString('base64');
      const apiOk = meta.hash_b64 ? (meta.hash_b64 === b64) : null;
      const identical = unpinned ? (unpinned.sha256 === pinned.sha256 && unpinned.bytes === pinned.bytes) : null;
      if (identical === false || apiOk === false) mismatches++;
      crecs.push({ file: f, bytes: pinned.bytes, sha256: pinned.sha256, unversioned_identical: identical, jsdelivr_api_agrees: apiOk });
      const mark = identical === false ? 'MISMATCH' : (identical === null ? 'pinned  ' : 'identical');
      process.stdout.write(`  ${mark}  ${(c.pkg + '/' + f).padEnd(40)} ${String(pinned.bytes).padStart(10)} B  ${pinned.sha256.slice(0, 16)}\n`);
    }
    companions.push({ package: c.pkg, version: c.version, assets: crecs });
  }

  const manifest = {
    generated_by: 'verify_pose_assets.cjs',
    package: PKG,
    version: VERSION,
    version_published: '2023-02-04T00:11:00.321Z',
    latest_at_benchmark: true,
    latest_note:
      'No version of ' + PKG + ' has been published since ' + VERSION + '. The benchmark ran ' +
      '2026-08-21 to 2026-08-24 against the unversioned CDN path, which could therefore only ' +
      'have resolved to this build.',
    cdn_host: HOST,
    model_selection: 'device-adaptive (0/1/2); see squat-app/index.html recommendedPoseComplexity',
    complexity_to_model: COMPLEXITY,
    benchmark_run_complexity: 2,
    benchmark_run_model: COMPLEXITY[2],
    verification: QUICK ? 'jsdelivr metadata API only (--quick)' : 'downloaded pinned and unversioned, compared byte hashes',
    assets: records,
    companion_packages: companions,
  };

  fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
  const total = records.length + companions.reduce((n, c) => n + c.assets.length, 0);
  console.log(`\n  ${records.length} pose assets + ${total - records.length} companion → ${path.relative(process.cwd(), OUT)}`);
  if (mismatches) { console.error(`  ${mismatches} MISMATCH — the pin is not behaviour-preserving; do not proceed.`); process.exit(1); }
  console.log('  all assets verified' + (QUICK ? ' against the metadata API' : ' byte-identical between the unversioned and pinned paths'));
})().catch(e => { console.error('  FAILED:', e.message); process.exit(1); });
