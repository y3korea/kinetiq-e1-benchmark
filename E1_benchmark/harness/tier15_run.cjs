#!/usr/bin/env node
/**
 * tier15_run.cjs — Tier 1.5: whole-recording mocap replay through the core
 * =========================================================================
 *
 * Replays each REHAB24-6 recording end to end through the verbatim production
 * measurement chain, with OptiTrack mocap standing in for MediaPipe landmarks.
 * Perception is bypassed, so anything that goes wrong here is application logic
 * meeting real human movement.
 *
 * Whole recordings are replayed rather than isolated repetition windows: the
 * production FSM is a continuous-session state machine, and starting it
 * mid-movement lets the EMA warm-up transient manufacture phantom repetitions.
 *
 * Detected repetitions are matched to the dataset's annotated intervals by the
 * frame at which the app completes each repetition, which must fall inside the
 * annotated interval (with a tolerance for the FSM's return-to-standing
 * requirement). Unmatched detections are false positives; unmatched
 * annotations are misses.
 *
 * Usage: node tier15_run.cjs --in <dir> [--out ../results] [--tol 0.5]
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
const inDir = path.resolve(arg('--in', ''));
const outDir = path.resolve(arg('--out', path.join(__dirname, '..', 'results')));
const TOL_S = parseFloat(arg('--tol', '0.75'));   // seconds past the annotated end
if (!inDir) { console.error('--in <dir> required'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : NaN; };
const median = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
const absA = a => a.map(Math.abs);

// Optional dev/test split, so a parameter tuned on one subset can be reported on
// the other. Recordings are the unit — repetitions within a recording are not
// independent.
const only = arg('--only', '');
const onlyList = only ? only.split(',').map(x => x.trim()) : null;

let files = fs.readdirSync(inDir).filter(f => f.endsWith('.json') && f !== 'manifest.json').sort();
if (onlyList) files = files.filter(f => onlyList.includes(f.replace('.json', '')));

console.log(`Tier 1.5 — KinetiQ ${Core.KINETIQ_PROVENANCE.engine_version}`);
console.log('REHAB24-6 OptiTrack mocap into the production core (perception bypassed)');
console.log('whole-recording replay, continuous session');
console.log('='.repeat(76));

const matched = [];      // annotated rep <-> detected rep
const missedRows = [];   // annotated with no detection
const fpRows = [];       // detection matching no annotation
let totalAnnotated = 0, totalDetected = 0;

for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(inDir, f), 'utf8'));
  const fps = d.fps;
  const out = Replay.replay(d.frames);
  const ann = d.annotated_repetitions.filter(a => !a.mocap_erroneous);
  totalAnnotated += ann.length;
  totalDetected += out.repEvents.length;

  const ref2d = d.reference_2d_sagittal, ref3d = d.reference_3d;
  const used = new Set();

  for (const a of ann) {
    // The app completes a repetition on return to standing, which occurs at or
    // shortly after the annotated end frame.
    const lo = a.first_frame / fps;
    const hi = a.last_frame / fps + TOL_S;
    const cand = out.repEvents.filter((e, i) => !used.has(i) && e.atTime >= lo && e.atTime <= hi);
    const seg = (arr) => arr.slice(a.first_frame, a.last_frame + 1);

    const refKnee = Math.min(...seg(ref2d.knee));
    const refHip = Math.min(...seg(ref2d.hip));
    const refTrunk = Math.max(...seg(ref2d.trunk));
    const refKnee3d = Math.min(...seg(ref3d.knee));

    // True eccentric / concentric duration from the reference signal.
    const k = seg(ref2d.knee);
    const iMin = k.indexOf(Math.min(...k));
    const trueDescentS = iMin / fps;
    const trueAscentS = (k.length - 1 - iMin) / fps;

    if (!cand.length) {
      missedRows.push({
        video_id: d.video_id, person_id: d.person_id, rep: a.repetition_number,
        correctness: a.correctness ? 1 : 0,
        ref_min_knee: r2(refKnee),
        ref_max_knee_in_rep: r2(Math.max(...k)),
        window_max_knee: r2(Math.max(...seg(ref2d.knee))),
        crosses_bottom_th: refKnee < 115 ? 1 : 0,
      });
      continue;
    }
    const idx = out.repEvents.indexOf(cand[0]);
    used.add(idx);
    const e = cand[0];
    matched.push({
      video_id: d.video_id, person_id: d.person_id, rep: a.repetition_number,
      correctness: a.correctness ? 1 : 0,
      cam17_orientation: a.cam17_orientation,
      sagittal: a.sagittal_camera ? 1 : 0,
      ref_min_knee_2d: r2(refKnee), app_knee: r2(e.knee), knee_err: r2(e.knee - refKnee),
      ref_min_hip_2d: r2(refHip), app_hip: r2(e.hip), hip_err: r2(e.hip - refHip),
      ref_max_trunk_2d: r2(refTrunk), app_trunk: r2(e.trunk), trunk_err: r2(e.trunk - refTrunk),
      ref_min_knee_3d: r2(refKnee3d), projection_knee: r2(refKnee - refKnee3d),
      true_descent_s: r3(trueDescentS), app_descent_s: r3(e.descentTime),
      true_ascent_s: r3(trueAscentS), app_ascent_s: r3(e.ascentTime),
      descent_ratio: trueDescentS > 0 ? r3(e.descentTime / trueDescentS) : null,
      app_score: e.score,
    });
  }

  out.repEvents.forEach((e, i) => {
    if (!used.has(i)) fpRows.push({ video_id: d.video_id, at_time_s: r2(e.atTime), knee: r2(e.knee) });
  });
}

// ---------------------------------------------------------------------------
function stat(key, rows = matched) {
  const v = rows.map(r => r[key]).filter(x => x !== null && Number.isFinite(x));
  return { n: v.length, mae: r2(mean(absA(v))), bias: r2(mean(v)), sd: r2(sd(v)),
           rmse: r2(Math.sqrt(mean(v.map(x => x * x)))), p95: r2([...absA(v)].sort((a, b) => a - b)[Math.floor(v.length * 0.95)]),
           max: r2(Math.max(...absA(v))) };
}

const recall = matched.length / totalAnnotated;
const precision = matched.length / (matched.length + fpRows.length);

console.log(`\nREPETITION COUNTING  (${files.length} recordings, ${totalAnnotated} annotated repetitions)`);
console.log(`  detected total  : ${totalDetected}`);
console.log(`  matched         : ${matched.length}`);
console.log(`  missed          : ${missedRows.length}   (recall ${r3(recall)})`);
console.log(`  false positives : ${fpRows.length}   (precision ${r3(precision)})`);

console.log('\nANGLE AGREEMENT vs mocap sagittal reference');
for (const [label, key] of [['knee (min)', 'knee_err'], ['hip (min)', 'hip_err'], ['trunk (max)', 'trunk_err']]) {
  const s = stat(key);
  console.log(`  ${label.padEnd(12)} n=${s.n}  MAE ${String(s.mae).padStart(6)}°  bias ${String(s.bias).padStart(7)}°  ` +
              `RMSE ${String(s.rmse).padStart(6)}°  p95 ${String(s.p95).padStart(6)}°  max ${s.max}°`);
}
const proj = matched.map(r => r.projection_knee).filter(Number.isFinite);
console.log(`\n  monocular projection term (knee 2D-3D): mean ${r2(mean(proj))}°  sd ${r2(sd(proj))}°  ` +
            `p95|.| ${r2([...absA(proj)].sort((a, b) => a - b)[Math.floor(proj.length * 0.95)])}°`);

console.log('\nTEMPO on real human movement');
const td = matched.map(r => r.true_descent_s).filter(Number.isFinite);
const ad = matched.map(r => r.app_descent_s).filter(Number.isFinite);
const ratios = matched.map(r => r.descent_ratio).filter(Number.isFinite);
console.log(`  true eccentric : median ${r2(median(td))}s   range ${r2(Math.min(...td))}-${r2(Math.max(...td))}s`);
console.log(`  app-reported   : median ${r2(median(ad))}s   range ${r2(Math.min(...ad))}-${r2(Math.max(...ad))}s`);
console.log(`  ratio          : mean ${r3(mean(ratios))}  sd ${r3(sd(ratios))}`);
const atFloor = ad.filter(x => x <= 0.301).length;
console.log(`  at the 0.3s clamp floor: ${atFloor}/${ad.length} repetitions (${r2(100 * atFloor / ad.length)}%)`);

console.log('\nMISSED REPETITIONS — why');
if (missedRows.length) {
  const deep = missedRows.filter(r => r.crosses_bottom_th === 1);
  console.log(`  ${missedRows.length} missed; ${deep.length} were deep enough to be countable ` +
              `(below the ${115}° threshold) yet not counted`);
  const byRec = {};
  for (const r of missedRows) byRec[r.video_id] = (byRec[r.video_id] || 0) + 1;
  console.log('  by recording:', JSON.stringify(byRec));
  const maxk = missedRows.map(r => r.ref_max_knee_in_rep);
  console.log(`  peak knee extension within the missed repetitions: median ${r2(median(maxk))}°  ` +
              `(STAND threshold = 160°; ${maxk.filter(x => x < 160).length}/${maxk.length} never reach it)`);
} else {
  console.log('  none');
}

console.log('\nSCORE vs PHYSIOTHERAPIST CORRECTNESS LABEL');
const good = matched.filter(r => r.correctness === 1).map(r => r.app_score);
const bad = matched.filter(r => r.correctness === 0).map(r => r.app_score);
function auc(pos, neg) {
  const all = [...pos.map(v => [v, 1]), ...neg.map(v => [v, 0])].sort((a, b) => a[0] - b[0]);
  const ranks = new Array(all.length);
  for (let i = 0; i < all.length;) {
    let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++;
    const mid = (i + j + 2) / 2;
    for (let t = i; t <= j; t++) ranks[t] = mid;
    i = j + 1;
  }
  const rPos = all.reduce((s, a, i) => s + (a[1] === 1 ? ranks[i] : 0), 0);
  return (rPos - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
const A = auc(good, bad);
console.log(`  correct   (n=${good.length}): mean ${r2(mean(good))}  sd ${r2(sd(good))}`);
console.log(`  incorrect (n=${bad.length}): mean ${r2(mean(bad))}  sd ${r2(sd(bad))}`);
console.log(`  AUC = ${r3(A)}   (0.5 = chance)`);

// ---------------------------------------------------------------------------
function writeCSV(name, rows) {
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(path.join(outDir, name),
    [cols.join(',')].concat(rows.map(r => cols.map(c => r[c] === null ? '' : r[c]).join(','))).join('\n') + '\n');
  return name;
}
writeCSV('tier15_matched.csv', matched);
writeCSV('tier15_missed.csv', missedRows);
writeCSV('tier15_false_positives.csv', fpRows);

const report = {
  experiment: 'E1 Tier 1.5 — REHAB24-6 mocap into verbatim production core (perception bypassed)',
  generated: new Date().toISOString(),
  engine_version: Core.KINETIQ_PROVENANCE.engine_version,
  source_sha256: Core.KINETIQ_PROVENANCE.source_sha256,
  dataset: {
    name: 'REHAB24-6', doi: '10.5281/zenodo.13305826', license: 'CC BY-NC 4.0',
    citation: 'Cernek A., Sedmidubsky J., Budikova P. REHAB24-6. SISAP 2024.',
    exercise: 'Ex6 Squats', recordings: files.length, annotated_repetitions: totalAnnotated,
    reference: 'OptiTrack 41-marker mocap -> 26-joint skeleton, 30 fps',
  },
  method: {
    replay_unit: 'whole recording (continuous session)',
    matching: `detection time within [annotated_start, annotated_end + ${TOL_S}s]`,
    projection: 'anatomical sagittal plane, perpendicular to the hip-to-hip axis',
    perception: 'bypassed — mocap joints substituted for MediaPipe landmarks',
  },
  rep_counting: { annotated: totalAnnotated, detected: totalDetected, matched: matched.length,
                  missed: missedRows.length, false_positives: fpRows.length,
                  recall: r3(recall), precision: r3(precision) },
  angle_agreement: { knee: stat('knee_err'), hip: stat('hip_err'), trunk: stat('trunk_err') },
  projection_term_knee: { mean: r2(mean(proj)), sd: r2(sd(proj)) },
  tempo: { true_median_s: r2(median(td)), app_median_s: r2(median(ad)),
           ratio_mean: r3(mean(ratios)), ratio_sd: r3(sd(ratios)),
           at_clamp_floor_pct: r2(100 * atFloor / ad.length) },
  score_validity: { correct_mean: r2(mean(good)), incorrect_mean: r2(mean(bad)), auc: r3(A),
                    n_correct: good.length, n_incorrect: bad.length },
  scope_note: 'Perception bypassed. Establishes application-logic behaviour on real human ' +
              'movement with an ideal input. NOT a measurement-validity study of the deployed ' +
              'camera pipeline; that requires Tier 2 (video through MediaPipe).',
};
fs.writeFileSync(path.join(outDir, 'tier15_report.json'), JSON.stringify(report, null, 2));
console.log(`\nwritten: results/tier15_report.json + tier15_{matched,missed,false_positives}.csv`);
