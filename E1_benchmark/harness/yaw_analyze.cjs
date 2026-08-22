#!/usr/bin/env node
/**
 * yaw_analyze.cjs — accuracy vs camera viewing angle, and the calibration of the
 * alignment metric against real degrees
 * =====================================================================
 *
 * Consumes the rendered viewpoints from yaw_sweep.py and runs each through the
 * production measurement chain, producing:
 *
 *   1. knee / hip angle error as a continuous function of yaw
 *   2. repetition counting reliability as a function of yaw
 *   3. score validity (AUC against physiotherapist labels) as a function of yaw
 *   4. the openness metric as a function of yaw — which converts the metric's
 *      thresholds from interpolated guesses into stated angles
 *
 * Reference is the 3D anatomical angle, so the value at yaw = 0 is the floor that
 * monocular projection imposes even under perfect alignment, not zero.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

require('./harness_shim.js');
require('./kinetiq_core.generated.js');
require('./replay.js');

const shim = globalThis.KinetiQShim;
const Core = globalThis.KinetiQCore;
const Replay = globalThis.KinetiQReplay;

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const inDir = path.resolve(arg('--in', path.join(os.homedir(), 'KinetiQ_datasets/REHAB24-6/yaw_sweep')));
const outDir = path.resolve(arg('--out', path.join(__dirname, '..', 'results')));
const TOL = 0.75, FPS = 30;
fs.mkdirSync(outDir, { recursive: true });

const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const absA = a => a.map(Math.abs);
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : NaN; };
const pct = (a, q) => { const b = [...absA(a)].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * q)] : NaN; };
function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const a = [...pos.map(v => [v, 1]), ...neg.map(v => [v, 0])].sort((x, y) => x[0] - y[0]);
  const rk = new Array(a.length);
  for (let i = 0; i < a.length;) { let j = i; while (j + 1 < a.length && a[j + 1][0] === a[i][0]) j++;
    const m = (i + j + 2) / 2; for (let t = i; t <= j; t++) rk[t] = m; i = j + 1; }
  const rp = a.reduce((s, x, i) => s + (x[1] === 1 ? rk[i] : 0), 0);
  return (rp - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}

shim.setFrameSize(1280, 960);   // production geometry; the app applies its own correction

const files = fs.readdirSync(inDir).filter(f => f.endsWith('_yaw.json')).sort();
if (!files.length) { console.error(`no _yaw.json in ${inDir}`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(path.join(inDir, 'manifest.json'), 'utf8'));
const VIEWS = manifest.viewpoints
  || manifest.yaws.map(y => ({ yaw: y, pitch: 0, key: String(y) }));

console.log(`viewpoint sweep — KinetiQ ${Core.KINETIQ_PROVENANCE.engine_version}`);
console.log(`${files.length} recordings x ${VIEWS.length} viewpoints, reference = 3D anatomical angle`);
console.log('='.repeat(84));

const per = {};
for (const v of VIEWS) per[v.key] = { ...v, knee: [], hip: [], open: [], matched: 0, fp: 0, ann: 0, good: [], bad: [] };

for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(path.join(inDir, f), 'utf8'));
  const ann = doc.annotated_repetitions.filter(a => !a.mocap_erroneous);

  for (const v of VIEWS) {
    const view = doc.views[v.key];
    if (!view) continue;
    const out = Replay.replay(view.frames);
    const P = per[v.key];
    P.ann += ann.length;

    // the alignment metric at this viewpoint, from the same landmarks the app sees
    for (let i = 0; i < view.frames.length; i += 10) {
      const o = Core.kqViewOpenness(view.frames[i].landmarks, 1280 / 960);
      if (o !== null) P.open.push(o);
    }

    const used = new Set();
    for (const a of ann) {
      const lo = a.first_frame / FPS, hi = a.last_frame / FPS + TOL;
      const idx = out.repEvents.findIndex((e, j) => !used.has(j) && e.atTime >= lo && e.atTime <= hi);
      if (idx < 0) continue;
      used.add(idx); P.matched++;
      const e = out.repEvents[idx];
      const seg = arr => arr.slice(a.first_frame, a.last_frame + 1);
      P.knee.push(e.knee - Math.min(...seg(doc.reference_3d.knee_left)));
      P.hip.push(e.hip - Math.min(...seg(doc.reference_3d.hip_left)));
      (a.correctness ? P.good : P.bad).push(e.score);
    }
    P.fp += out.repEvents.length - used.size;
  }
}

const rows = [];
function tabulate(subset, axisLabel, axisOf) {
  console.log(`\n${axisLabel.padStart(5)} |  knee MAE  bias   p95 |  hip MAE | recall  prec | openness | score AUC`);
  console.log('-'.repeat(84));
  for (const v of subset) {
    const r = rows.find(x => x.key === v.key);
    if (!r) continue;
    console.log(` ${String(axisOf(v)).padStart(4)} | ${String(r.knee_mae).padStart(8)}° ${String(r.knee_bias).padStart(6)}° ${String(r.knee_p95).padStart(6)}° |` +
                ` ${String(r.hip_mae).padStart(7)}° | ${r.recall.toFixed(3)}  ${r.precision.toFixed(3)} |` +
                ` ${r.openness.toFixed(3)}    | ${Number.isFinite(r.auc) ? r.auc.toFixed(3) : '  --  '}`);
  }
}
for (const v of VIEWS) {
  const P = per[v.key];
  const kMAE = mean(absA(P.knee)), kBias = mean(P.knee), kP95 = pct(P.knee, 0.95);
  const hMAE = mean(absA(P.hip));
  const recall = P.matched / P.ann, prec = P.matched / (P.matched + P.fp);
  const open = mean(P.open);
  const A = auc(P.good, P.bad);
  rows.push({ key: v.key, yaw: v.yaw, pitch: v.pitch,
              knee_mae: r2(kMAE), knee_bias: r2(kBias), knee_p95: r2(kP95),
              hip_mae: r2(hMAE), recall: r3(recall), precision: r3(prec),
              openness: r3(open), openness_sd: r3(sd(P.open)), auc: r3(A), n: P.knee.length });
}

const yawRows = VIEWS.filter(v => v.pitch === 0).sort((a, b) => a.yaw - b.yaw);
const pitchRows = VIEWS.filter(v => v.yaw === 0).sort((a, b) => a.pitch - b.pitch);
console.log('\n[A] YAW sweep  (camera level, rotating around the subject)');
tabulate(yawRows, 'yaw', v => v.yaw);
if (pitchRows.length > 1) {
  console.log('\n[B] PITCH sweep  (aligned sideways, camera raised or lowered)');
  console.log('     negative = camera low, looking up (phone on the floor)');
  tabulate(pitchRows, 'pitch', v => v.pitch);
}

// ---- where does accuracy actually break down? -----------------------------
const yawCurve = rows.filter(r => r.pitch === 0).sort((a, b) => a.yaw - b.yaw);
const pitchCurve = rows.filter(r => r.yaw === 0).sort((a, b) => a.pitch - b.pitch);
const base = yawCurve[0].knee_mae;
console.log(`\n기준선 (yaw 0°, 완전 측면): 무릎 MAE ${base}°  <- 단안 투영의 하한, 0 이 아니다`);
for (const mult of [2, 3, 5]) {
  const hit = yawCurve.find(r => r.knee_mae >= base * mult);
  console.log(`  기준선의 ${mult}배(${r2(base * mult)}°) 도달: ${hit ? `yaw ${hit.yaw}°` : '90° 이내 없음'}`);
}
const r5 = yawCurve.find(r => r.knee_mae >= 5), r10 = yawCurve.find(r => r.knee_mae >= 10);
console.log(`  절대 5° 초과: ${r5 ? `yaw ${r5.yaw}°` : '없음'}   절대 10° 초과: ${r10 ? `yaw ${r10.yaw}°` : '없음'}`);

// ---- calibrate the alignment metric into degrees ---------------------------
console.log(`\n정렬 지표(openness) -> 실제 각도 캘리브레이션`);
const GOOD = Core.KQ_VIEW_GOOD, WARN = Core.KQ_VIEW_WARN;
function yawAt(openTarget) {
  for (let i = 1; i < yawCurve.length; i++) {
    const a = yawCurve[i - 1], b = yawCurve[i];
    if ((a.openness - openTarget) * (b.openness - openTarget) <= 0 && a.openness !== b.openness) {
      const t = (openTarget - a.openness) / (b.openness - a.openness);
      return a.yaw + t * (b.yaw - a.yaw);
    }
  }
  return null;
}
const yGood = yawAt(GOOD), yWarn = yawAt(WARN);
console.log(`  현재 임계 good <= ${GOOD}  ->  yaw ${yGood === null ? '?' : r2(yGood) + '°'} 이내`);
console.log(`  현재 임계 warn <= ${WARN}  ->  yaw ${yWarn === null ? '?' : r2(yWarn) + '°'} 이내`);
function maeAtYaw(y) {
  if (y === null) return null;
  for (let i = 1; i < yawCurve.length; i++) {
    const a = yawCurve[i - 1], b = yawCurve[i];
    if (y >= a.yaw && y <= b.yaw) {
      const t = (b.yaw === a.yaw) ? 0 : (y - a.yaw) / (b.yaw - a.yaw);
      return r2(a.knee_mae + t * (b.knee_mae - a.knee_mae));
    }
  }
  return null;
}
console.log(`  -> 'good' 경계에서의 무릎 MAE: ${maeAtYaw(yGood)}°`);
console.log(`  -> 'fair/poor' 경계에서의 무릎 MAE: ${maeAtYaw(yWarn)}°`);

fs.writeFileSync(path.join(outDir, 'yaw_sweep.json'), JSON.stringify({
  experiment: 'accuracy as a continuous function of camera viewing angle',
  generated: new Date().toISOString(),
  engine_version: Core.KINETIQ_PROVENANCE.engine_version,
  method: 'OptiTrack 3D skeleton projected through a virtual camera orbiting in yaw; '
        + 'landmarks fed to the production chain; reference is the 3D anatomical angle',
  scope: 'projection geometry only — MediaPipe perception error at these angles is NOT '
       + 'included, since landmarks are projected from mocap rather than detected from pixels',
  frame: manifest.frame,
  yaws: manifest.yaws,
  pitches: manifest.pitches || [],
  curve: yawCurve,
  pitch_curve: pitchCurve,
  all_viewpoints: rows,
  baseline_sagittal_knee_mae: base,
  metric_calibration: {
    good_threshold: GOOD, good_within_yaw_deg: yGood === null ? null : r2(yGood), good_boundary_knee_mae: maeAtYaw(yGood),
    warn_threshold: WARN, warn_within_yaw_deg: yWarn === null ? null : r2(yWarn), warn_boundary_knee_mae: maeAtYaw(yWarn),
  },
}, null, 2));
const cols = Object.keys(rows[0]);
fs.writeFileSync(path.join(outDir, 'yaw_sweep.csv'),
  [cols.join(',')].concat(rows.map(r => cols.map(c => r[c]).join(','))).join('\n') + '\n');
console.log('\nwritten: results/yaw_sweep.json + yaw_sweep.csv');
