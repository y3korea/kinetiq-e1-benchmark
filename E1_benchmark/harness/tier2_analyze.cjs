#!/usr/bin/env node
/**
 * tier2_analyze.cjs — Tier 2 end-to-end product accuracy, with perception isolated
 * ================================================================================
 *
 * Two conditions, ONE reference (the dataset's published projection of OptiTrack
 * mocap joints into camera 18):
 *
 *   CONTROL   camera-18 mocap joints  -> production core     (perfect perception)
 *   TIER 2    camera-18 video -> MediaPipe -> production core (real perception)
 *
 * Because both are scored in the same image plane against the same reference,
 *
 *      perception contribution  =  Tier 2 error  -  control error
 *
 * is a clean decomposition rather than an approximation.
 *
 * Repetitions are stratified by view. The dataset states that facing camera 17
 * puts the subject in profile for camera 18, so `cam18_sagittal` marks the
 * sagittal stratum; the remainder are oblique and are reported separately,
 * because off-axis viewing is the field condition the app cannot control.
 *
 * Usage
 *   node tier2_analyze.cjs --t2 <dir of *_t2.json> --ref <dir of *_ref.json> [--out ../results]
 */

const fs = require('fs');
const path = require('path');

require('./harness_shim.js');
require('./kinetiq_core.generated.js');
require('./replay.js');

const Core = globalThis.KinetiQCore;
const Replay = globalThis.KinetiQReplay;

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const t2Dir = path.resolve(arg('--t2', ''));
const refDir = path.resolve(arg('--ref', ''));
const outDir = path.resolve(arg('--out', path.join(__dirname, '..', 'results')));
const TOL_S = parseFloat(arg('--tol', '0.75'));
if (!t2Dir || !refDir) { console.error('--t2 and --ref required'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : NaN; };
const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
const absA = a => a.map(Math.abs);
const pct = (a, q) => { const b = [...absA(a)].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * q)] : NaN; };

/** Match detected repetitions to annotations and score each against the reference. */
function scoreRun(repEvents, refRoot, space, annotations, side, label) {
  const ref = refRoot[space];
  const rows = [];
  const missed = [];
  const used = new Set();

  for (const a of annotations) {
    if (a.mocap_erroneous) continue;
    const lo = a.first_frame / 30, hi = a.last_frame / 30 + TOL_S;
    const idx = repEvents.findIndex((e, i) => !used.has(i) && e.atTime >= lo && e.atTime <= hi);
    const seg = arr => arr.slice(a.first_frame, a.last_frame + 1);

    const refKnee = Math.min(...seg(ref[side].knee));
    const refHip = Math.min(...seg(ref[side].hip));
    const refTrunk = Math.max(...seg(ref[side].trunk));
    const k = seg(ref[side].knee);
    const iMin = k.indexOf(Math.min(...k));
    const trueDescent = iMin / 30;

    if (idx < 0) { missed.push({ rep: a.repetition_number, sagittal: a.cam18_sagittal ? 1 : 0, ref_min_knee: r2(refKnee) }); continue; }
    used.add(idx);
    const e = repEvents[idx];
    rows.push({
      condition: label, rep: a.repetition_number,
      sagittal: a.cam18_sagittal ? 1 : 0,
      correctness: a.correctness ? 1 : 0,
      ref_min_knee: r2(refKnee), app_knee: r2(e.knee), knee_err: r2(e.knee - refKnee),
      ref_min_hip: r2(refHip), app_hip: r2(e.hip), hip_err: r2(e.hip - refHip),
      ref_max_trunk: r2(refTrunk), app_trunk: r2(e.trunk), trunk_err: r2(e.trunk - refTrunk),
      true_descent_s: r3(trueDescent), app_descent_s: r3(e.descentTime),
      descent_ratio: trueDescent > 0 ? r3(e.descentTime / trueDescent) : null,
      app_score: e.score,
    });
  }
  const fp = repEvents.length - used.size;
  return { rows, missed, fp, detected: repEvents.length };
}

function stat(rows, key) {
  const v = rows.map(r => r[key]).filter(x => x !== null && Number.isFinite(x));
  if (!v.length) return null;
  return { n: v.length, mae: r2(mean(absA(v))), bias: r2(mean(v)), sd: r2(sd(v)),
           rmse: r2(Math.sqrt(mean(v.map(x => x * x)))), p95: r2(pct(v, 0.95)), max: r2(Math.max(...absA(v))) };
}

// ---------------------------------------------------------------------------
const t2Files = fs.readdirSync(t2Dir).filter(f => f.endsWith('_t2.json')).sort();
console.log(`Tier 2 — KinetiQ ${Core.KINETIQ_PROVENANCE.engine_version}`);
console.log('REHAB24-6 camera-18 video -> MediaPipe -> production core');
console.log('='.repeat(78));
console.log(`${t2Files.length} recordings\n`);

const all = { control: [], tier2: [], control_app: [], tier2_app: [] };
const missedAll = { control: [], tier2: [] };
let fpAll = { control: 0, tier2: 0 }, detAll = { control: 0, tier2: 0 };
let annTotal = 0;
const mpStats = [];
const sideChoice = [];

for (const f of t2Files) {
  const rec = f.replace('_t2.json', '');
  const t2 = JSON.parse(fs.readFileSync(path.join(t2Dir, f), 'utf8'));
  const refPath = path.join(refDir, `${rec}_ref.json`);
  const ctlPath = path.join(refDir, `${rec}_control.json`);
  if (!fs.existsSync(refPath)) { console.log(`  ${rec}: no reference, skipped`); continue; }
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
  const ann = ref.annotated_repetitions;
  annTotal += ann.filter(a => !a.mocap_erroneous).length;
  mpStats.push({ rec, ...t2.mediapipe });

  // CONTROL: replay mocap joints from the same camera through the core.
  const ctl = JSON.parse(fs.readFileSync(ctlPath, 'utf8'));
  const ctlOut = Replay.replay(ctl.frames);

  // 2x2 design: two conditions x two reference spaces.
  //
  //                     reference_2d (true pixels)   reference_2d_appspace
  //   control           = aspect-ratio distortion    = ~0 (sanity check)
  //   tier 2            = end-to-end product error   = MediaPipe perception error
  //
  // The app computes angles from MediaPipe's normalised coordinates (x/W, y/H).
  // That scaling is anisotropic whenever W != H, so it does not preserve angles.
  // Scoring against the app's own space isolates perception; scoring against
  // true pixels gives the anatomically meaningful product error.
  const sc = scoreRun(ctlOut.repEvents, ref, 'reference_2d', ann, 'left', 'control_vs_pixel');
  const scApp = scoreRun(ctlOut.repEvents, ref, 'reference_2d_appspace', ann, 'left', 'control_vs_appspace');

  // Under Tier 2 the limb is chosen inside the app from MediaPipe's visibilities,
  // which we do not observe. Both limbs are scored and the better-agreeing one is
  // used, with the left/right gap reported so the assumption stays visible.
  const pick = (a, b) => {
    const e = rr => rr.rows.length ? mean(absA(rr.rows.map(x => x.knee_err))) : Infinity;
    return e(a) <= e(b) ? { r: a, side: 'left', gap: r2(Math.abs(e(a) - e(b))), l: r2(e(a)), rr: r2(e(b)) }
                        : { r: b, side: 'right', gap: r2(Math.abs(e(a) - e(b))), l: r2(e(a)), rr: r2(e(b)) };
  };
  const chosen = pick(
    scoreRun(t2.repEvents, ref, 'reference_2d', ann, 'left', 'tier2_vs_pixel'),
    scoreRun(t2.repEvents, ref, 'reference_2d', ann, 'right', 'tier2_vs_pixel'));
  const st = chosen.r;
  const stApp = scoreRun(t2.repEvents, ref, 'reference_2d_appspace', ann, chosen.side, 'tier2_vs_appspace');

  all.control_app.push(...scApp.rows);
  all.tier2_app.push(...stApp.rows);
  sideChoice.push({ rec, chosen: chosen.side, knee_mae_left: chosen.l, knee_mae_right: chosen.rr, gap: chosen.gap });

  all.control.push(...sc.rows); all.tier2.push(...st.rows);
  missedAll.control.push(...sc.missed); missedAll.tier2.push(...st.missed);
  fpAll.control += sc.fp; fpAll.tier2 += st.fp;
  detAll.control += sc.detected; detAll.tier2 += st.detected;

  console.log(`  ${rec}: detection ${(100 * t2.mediapipe.detection_rate).toFixed(1)}%  ` +
              `reps control ${sc.rows.length}/${ann.length} · tier2 ${st.rows.length}/${ann.length}`);
}

// ---------------------------------------------------------------------------
function report(label, rows, missed, fp, detected) {
  const recall = rows.length / annTotal, precision = rows.length / (rows.length + fp);
  console.log(`\n${label}`);
  console.log(`  counting   matched ${rows.length}/${annTotal}  missed ${missed.length}  FP ${fp}  ` +
              `recall ${r3(recall)}  precision ${r3(precision)}`);
  for (const [nm, key] of [['knee', 'knee_err'], ['hip', 'hip_err'], ['trunk', 'trunk_err']]) {
    const s = stat(rows, key);
    if (s) console.log(`  ${nm.padEnd(6)} n=${String(s.n).padStart(3)}  MAE ${String(s.mae).padStart(6)}°  ` +
                       `bias ${String(s.bias).padStart(7)}°  RMSE ${String(s.rmse).padStart(6)}°  p95 ${String(s.p95).padStart(6)}°`);
  }
  const rt = rows.map(r => r.descent_ratio).filter(Number.isFinite);
  if (rt.length) console.log(`  tempo  ratio mean ${r3(mean(rt))}  median ${r3(med(rt))}`);
  return { recall, precision, matched: rows.length, missed: missed.length, fp,
           knee: stat(rows, 'knee_err'), hip: stat(rows, 'hip_err'), trunk: stat(rows, 'trunk_err'),
           tempo_ratio_mean: r3(mean(rt)) };
}

const ctlRep = report('CONTROL  (camera-18 mocap joints -> core; perfect perception)',
                      all.control, missedAll.control, fpAll.control, detAll.control);
const t2Rep = report('TIER 2   (camera-18 video -> MediaPipe -> core; real perception)',
                     all.tier2, missedAll.tier2, fpAll.tier2, detAll.tier2);

const ctlAppRep = report('CONTROL vs APP-SPACE reference  (sanity check; expect ~0)',
                         all.control_app, [], 0, 0);
const t2AppRep = report('TIER 2 vs APP-SPACE reference   (MediaPipe perception error, aspect removed)',
                        all.tier2_app, [], 0, 0);

console.log('\nERROR DECOMPOSITION');
for (const j of ['knee', 'hip', 'trunk']) {
  if (ctlRep[j] && t2Rep[j] && ctlAppRep[j] && t2AppRep[j]) {
    console.log(`  ${j}`);
    console.log(`    harness sanity (control vs app-space)   ${String(ctlAppRep[j].mae).padStart(6)}°  (should be ~0)`);
    console.log(`    aspect-ratio distortion (control)       ${String(ctlRep[j].mae).padStart(6)}°  bias ${ctlRep[j].bias}°`);
    console.log(`    MediaPipe perception (tier2, app-space) ${String(t2AppRep[j].mae).padStart(6)}°  bias ${t2AppRep[j].bias}°`);
    console.log(`    END-TO-END product error (tier2 vs px)  ${String(t2Rep[j].mae).padStart(6)}°  bias ${t2Rep[j].bias}°`);
  }
}

console.log('\nPERCEPTION CONTRIBUTION  (Tier 2 - control, same reference and image plane)');
for (const j of ['knee', 'hip', 'trunk']) {
  if (ctlRep[j] && t2Rep[j]) {
    console.log(`  ${j.padEnd(6)} MAE ${String(ctlRep[j].mae).padStart(6)}° -> ${String(t2Rep[j].mae).padStart(6)}°   ` +
                `(+${r2(t2Rep[j].mae - ctlRep[j].mae)}° from MediaPipe)`);
  }
}
console.log(`  recall ${r3(ctlRep.recall)} -> ${r3(t2Rep.recall)}   precision ${r3(ctlRep.precision)} -> ${r3(t2Rep.precision)}`);

console.log('\nLIMB SELECTION (Tier 2; app chooses internally from MediaPipe visibilities)');
for (const sc2 of sideChoice) {
  console.log(`  ${sc2.rec}: chosen ${sc2.chosen.padEnd(5)}  knee MAE left ${String(sc2.knee_mae_left).padStart(6)}°  ` +
              `right ${String(sc2.knee_mae_right).padStart(6)}°  gap ${sc2.gap}°`);
}
const gaps = sideChoice.map(x => x.gap).filter(Number.isFinite);
const allRight = sideChoice.every(x => x.chosen === 'right');
console.log(`  mean left/right gap ${r2(mean(gaps))}°`);
if (mean(gaps) > 5) {
  console.log('  CAVEAT: the gap is large, so the limb choice materially changes the result.');
  console.log('  The limb was selected here by best agreement, which biases the reported error');
  console.log('  DOWNWARD. MediaPipe visibilities were not retained, so the app\'s actual choice');
  console.log('  was not observed. Treat Tier 2 angle error as a LOWER BOUND until a run that');
  console.log('  records the selected limb per frame is available.');
  if (allRight) console.log('  (the same limb won in all recordings, which is consistent with a fixed camera side)');
}

console.log('\nVIEW STRATIFICATION (Tier 2)');
for (const [nm, want] of [['sagittal', 1], ['oblique (half-profile)', 0]]) {
  const sub = all.tier2.filter(r => r.sagittal === want);
  const s = stat(sub, 'knee_err');
  if (s) console.log(`  ${nm.padEnd(24)} n=${String(s.n).padStart(3)}  knee MAE ${String(s.mae).padStart(6)}°  ` +
                     `bias ${String(s.bias).padStart(7)}°  p95 ${s.p95}°`);
}

// score validity
function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const a = [...pos.map(v => [v, 1]), ...neg.map(v => [v, 0])].sort((x, y) => x[0] - y[0]);
  const rk = new Array(a.length);
  for (let i = 0; i < a.length;) { let j = i; while (j + 1 < a.length && a[j + 1][0] === a[i][0]) j++;
    const m = (i + j + 2) / 2; for (let t = i; t <= j; t++) rk[t] = m; i = j + 1; }
  const rp = a.reduce((s, x, i) => s + (x[1] === 1 ? rk[i] : 0), 0);
  return (rp - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
const good = all.tier2.filter(r => r.correctness === 1).map(r => r.app_score);
const bad = all.tier2.filter(r => r.correctness === 0).map(r => r.app_score);
console.log(`\nSCORE vs PHYSIOTHERAPIST LABEL (Tier 2)`);
console.log(`  correct (n=${good.length}) ${r2(mean(good))}  ·  incorrect (n=${bad.length}) ${r2(mean(bad))}  ·  AUC ${r3(auc(good, bad))}`);

// ---------------------------------------------------------------------------
const rows = [...all.control, ...all.tier2];
const cols = Object.keys(rows[0] || {});
if (rows.length) fs.writeFileSync(path.join(outDir, 'tier2_reps.csv'),
  [cols.join(',')].concat(rows.map(r => cols.map(c => r[c] === null ? '' : r[c]).join(','))).join('\n') + '\n');

fs.writeFileSync(path.join(outDir, 'tier2_report.json'), JSON.stringify({
  experiment: 'E1 Tier 2 — end-to-end product accuracy with perception isolated',
  generated: new Date().toISOString(),
  engine_version: Core.KINETIQ_PROVENANCE.engine_version,
  source_sha256: Core.KINETIQ_PROVENANCE.source_sha256,
  dataset: { name: 'REHAB24-6', doi: '10.5281/zenodo.13305826', license: 'CC BY-NC 4.0',
             camera: 'Camera18 (transposed 1080x1920, 30 fps)', exercise: 'Ex6 Squats',
             annotated_repetitions: annTotal, recordings: t2Files.length },
  mediapipe: mpStats,
  limb_selection: {
    per_recording: sideChoice,
    caveat: 'The limb was chosen by best agreement because MediaPipe visibilities were not '
          + 'retained, so the app\'s actual selection was not observed. With a mean left/right '
          + 'gap of this size the choice matters, and the reported Tier 2 angle error is '
          + 'therefore a LOWER BOUND.',
  },
  control_vs_pixel: ctlRep, tier2_vs_pixel: t2Rep,
  control_vs_appspace: ctlAppRep, tier2_vs_appspace: t2AppRep,
  aspect_note: 'KinetiQ computes angles from MediaPipe normalised coordinates (x/W, y/H). That scaling is anisotropic when W != H and does not preserve angles. control_vs_appspace ~0 confirms the app is faithful to its own convention; control_vs_pixel is the resulting distortion.',
  perception_contribution: Object.fromEntries(['knee', 'hip', 'trunk']
    .filter(j => ctlRep[j] && t2Rep[j])
    .map(j => [j, { control_mae: ctlRep[j].mae, tier2_mae: t2Rep[j].mae,
                    delta_mae: r2(t2Rep[j].mae - ctlRep[j].mae) }])),
  view_stratification: Object.fromEntries([['sagittal', 1], ['oblique', 0]]
    .map(([nm, w]) => [nm, stat(all.tier2.filter(r => r.sagittal === w), 'knee_err')])),
  score_validity: { auc: r3(auc(good, bad)), correct_mean: r2(mean(good)), incorrect_mean: r2(mean(bad)) },
  scope_note: 'Tier 2 is the end-to-end product figure for a single sagittal camera on ' +
              'this dataset. It is a benchmark against mocap-derived reference angles, not a ' +
              'clinical validation study, and generalises only to comparable conditions.',
}, null, 2));
console.log(`\nwritten: results/tier2_report.json + tier2_reps.csv`);
