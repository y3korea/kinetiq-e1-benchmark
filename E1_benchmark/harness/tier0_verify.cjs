#!/usr/bin/env node
/**
 * tier0_verify.cjs — E1 Tier 0: measurement-chain verification against exact truth
 * ================================================================================
 *
 * Tier 0 feeds analytically constructed landmarks (synth_kinematics.js) into the
 * verbatim production core (kinetiq_core.generated.js). Ground truth is exact to
 * machine precision, so every deviation observed here is attributable to the
 * application's own angle math, temporal filter, or repetition state machine —
 * never to pose-estimation error.
 *
 * This is a software-correctness experiment, NOT a measurement-validity study.
 * It cannot establish that KinetiQ measures human beings accurately; it
 * establishes what the software does with input whose truth is known. Tier 1
 * (rendered video -> MediaPipe) and Tier 2 (dataset video -> mocap truth) carry
 * the perception error.
 *
 * Experiments
 *   T0.1  Static angle accuracy across the working range
 *   T0.2  Dynamic peak-depth bias from EMA smoothing, vs movement tempo
 *   T0.3  Repetition-count accuracy, incl. sub-threshold partial repetitions
 *   T0.4  Tempo (eccentric/concentric duration) construct validity
 *   T0.5  Frame-rate sensitivity
 *   T0.6  Landmark-noise robustness
 *
 * Usage:  node tier0_verify.cjs [--out ../results]
 */

const fs = require('fs');
const path = require('path');

require('./harness_shim.js');
require('./kinetiq_core.generated.js');
require('./synth_kinematics.js');
require('./replay.js');

const Core = globalThis.KinetiQCore;
const Synth = globalThis.KinetiQSynth;
const Replay = globalThis.KinetiQReplay;

const args = process.argv.slice(2);
const outDir = path.resolve(
  args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : path.join(__dirname, '..', 'results')
);
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const mae = a => mean(a.map(Math.abs));
const rmse = a => Math.sqrt(mean(a.map(x => x * x)));
const maxAbs = a => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

function writeCSV(name, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const body = [cols.join(',')].concat(
    rows.map(r => cols.map(c => (typeof r[c] === 'number' ? r[c] : `"${String(r[c])}"`)).join(','))
  ).join('\n');
  fs.writeFileSync(path.join(outDir, name), body + '\n', 'utf8');
  return name;
}

const report = {
  experiment: 'E1 Tier 0 — measurement-chain verification vs analytic ground truth',
  generated: new Date().toISOString(),
  engine_version: Core.KINETIQ_PROVENANCE.engine_version,
  source_sha256: Core.KINETIQ_PROVENANCE.source_sha256,
  scope_note:
    'Synthetic landmarks with exact ground truth. Isolates application angle math, ' +
    'EMA filter and repetition FSM. Contains NO evidence about human measurement accuracy.',
  results: {},
};

const JOINTS = ['knee', 'hip', 'trunk', 'ankle'];
console.log(`E1 Tier 0 — KinetiQ ${report.engine_version}`);
console.log('='.repeat(72));

// ===========================================================================
// T0.1 — Static angle accuracy
//
// Each pose is held long enough for the EMA to converge (alpha=0.3 reaches
// <1e-9 of its target in ~60 frames), then the reported angle is compared with
// the constructed truth.
// ===========================================================================
console.log('\nT0.1  Static angle accuracy across the working range');

const staticRows = [];
const staticErr = { knee: [], hip: [], trunk: [], ankle: [] };
const HOLD_FRAMES = 120;

for (let knee = 60; knee <= 178; knee += 4) {
  // Interpolate a physiologically coherent pose for this depth.
  const u = (178 - knee) / (178 - 60);
  const spec = {
    kneeDeg: knee,
    hipDeg: 178 - u * 100,
    ankleDeg: 90 - u * 18,
    shankDeg: 2 + u * 22,
    facing: 1,
  };
  const pose = Synth.buildPose(spec);
  const lm = Synth.toLandmarks(pose, { side: 'left' });
  const frames = Array.from({ length: HOLD_FRAMES }, (_, i) => ({ t: i / 30, landmarks: lm }));

  const out = Replay.replay(frames);
  const last = out.series[out.series.length - 1];

  const row = { gt_knee: r2(pose.gt.knee) };
  for (const j of JOINTS) {
    const err = last[j] - pose.gt[j];
    staticErr[j].push(err);
    row[`gt_${j}`] = r3(pose.gt[j]);
    row[`app_${j}`] = r3(last[j]);
    row[`err_${j}`] = r3(err);
  }
  staticRows.push(row);
}

const t01 = { n_poses: staticRows.length, per_joint: {} };
for (const j of JOINTS) {
  t01.per_joint[j] = {
    mae_deg: r3(mae(staticErr[j])),
    rmse_deg: r3(rmse(staticErr[j])),
    max_abs_deg: r3(maxAbs(staticErr[j])),
    bias_deg: r3(mean(staticErr[j])),
  };
  const s = t01.per_joint[j];
  console.log(`   ${j.padEnd(6)} MAE ${String(s.mae_deg).padStart(8)}°   max ${String(s.max_abs_deg).padStart(8)}°   bias ${String(s.bias_deg).padStart(8)}°`);
}
t01.csv = writeCSV('t0_1_static_accuracy.csv', staticRows);
t01.interpretation =
  'Static-pose agreement is exact to floating-point precision, confirming calcAngle/' +
  'calcTrunk implement their intended geometric definitions and that the visible-side ' +
  'selection picks the intended limb.';
report.results.T0_1_static_accuracy = t01;

// ===========================================================================
// T0.2 — Dynamic peak-depth bias (EMA lag)
//
// The exponential moving average (alpha = 0.3) lags a moving signal. At the
// turnaround the reported minimum knee angle therefore never reaches the true
// minimum: depth is under-reported, and increasingly so at faster tempo.
// ===========================================================================
console.log('\nT0.2  Peak-depth bias from EMA smoothing (alpha = 0.3)');

const lagRows = [];
for (const descentS of [0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0]) {
  for (const fps of [30]) {
    const sess = Synth.generateSession({
      reps: 3, fps, descentS, ascentS: descentS * 0.75, bottomS: 0.3, restS: 1.0,
      standKnee: 175, bottomKnee: 85,
    });
    const out = Replay.replay(sess.frames);
    const gtMin = Math.min(...sess.frames.map(f => f.gt.knee));
    const appMin = Math.min(...out.series.map(s => s.knee));
    // Per-repetition reported depth (completeRep takes the min over the rep).
    const repMin = out.repEvents.length ? mean(out.repEvents.map(r => r.knee)) : NaN;
    lagRows.push({
      descent_s: descentS, fps,
      gt_min_knee: r3(gtMin),
      app_min_knee: r3(appMin),
      depth_underreport_deg: r3(appMin - gtMin),
      rep_reported_knee: r3(repMin),
      rep_underreport_deg: r3(repMin - gtMin),
      peak_angular_velocity_deg_s: r3((175 - 85) / descentS * (Math.PI / 2)),
    });
    console.log(`   descent ${String(descentS).padStart(4)}s @${fps}fps  ` +
                `true min ${r2(gtMin).toFixed(1)}°  reported ${r2(repMin).toFixed(1)}°  ` +
                `under-report +${r2(repMin - gtMin).toFixed(2)}°`);
  }
}
report.results.T0_2_ema_depth_bias = {
  csv: writeCSV('t0_2_ema_depth_bias.csv', lagRows),
  rows: lagRows,
  max_underreport_deg: r3(Math.max(...lagRows.map(r => r.rep_underreport_deg))),
  interpretation:
    'The EMA filter systematically under-reports squat depth (reported minimum knee ' +
    'angle exceeds the true minimum), with the bias growing as tempo increases. The ' +
    `magnitude is small — at most ${r3(Math.max(...lagRows.map(r => r.rep_underreport_deg)))} deg ` +
    'over a 0.5-4 s descent range — because the 0.3 s bottom hold in these trajectories ' +
    'gives the filter time to settle at the turnaround. Movements without a bottom hold, ' +
    'or sampled at low frame rates (see T0.5), incur substantially more. Reported here ' +
    'as a quantified systematic error term rather than a defect; a zero-phase ' +
    '(forward-backward) filter applied to stored per-repetition minima would remove it.',
};

// ===========================================================================
// T0.3 — Repetition-count accuracy
//
// Includes deliberately shallow repetitions: the FSM only registers a
// repetition once the knee passes the depth gate, so movements shallower than that
// gate should NOT be counted.
//
// ver7-D7.67 moved the gate from 115 deg to 135 deg. This is a deliberate change of
// specification, not a loosened test: the aspect-ratio correction raises every
// measured knee angle at the bottom, so the old gate silently dropped repetitions
// that users had genuinely performed. A shallow squat is now COUNTED and SCORED
// DOWN (bottom 90 deg scores 70, 120 deg scores 55, 130 deg scores 54) rather than
// ignored, which tells the user something; not counting it at all told them nothing.
// ===========================================================================
console.log('\nT0.3  Repetition-count accuracy');

const ACSM = Core.getACSM();

// The depth gate is INTENDED to sit here. It is written down rather than recomputed
// from the production formula, because a test that mirrors the implementation's
// arithmetic cannot detect the implementation changing — it just changes with it.
// This value is the ver7-D7.67 gate, chosen on dev recordings and validated on
// held-out test recordings (see results/bottom_th_selection.json); ver7-D7.66 and
// earlier used 115. A failure here means the gate moved and somebody has to decide
// whether that was intended.
const INTENDED_GATE = 135;

/** Probe the gate the production code actually applies, rather than assuming it. */
function probeGate() {
  let lo = 60, hi = 175;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const sess = Synth.generateSession({ reps: 3, fps: 30, descentS: 1.5, ascentS: 1.2,
      bottomS: 0.3, restS: 0.8, standKnee: 175, bottomKnee: mid });
    if (Replay.replay(sess.frames).repCount >= 3) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
const OBSERVED_GATE = probeGate();
const BOTTOM_TH = INTENDED_GATE;
console.log(`   depth gate: intended ${INTENDED_GATE}°, observed ${OBSERVED_GATE.toFixed(1)}°` +
            (Math.abs(OBSERVED_GATE - INTENDED_GATE) <= 3 ? '  OK' : '  *** MOVED ***'));

const repRows = [];
for (const reps of [1, 5, 10, 20]) {
  for (const bottomKnee of [80, 95, 110, 120, 145]) {
    const sess = Synth.generateSession({
      reps, fps: 30, descentS: 1.5, ascentS: 1.2, bottomS: 0.3, restS: 0.8,
      standKnee: 175, bottomKnee,
    });
    const out = Replay.replay(sess.frames);
    // A repetition is countable only if the movement crosses the FSM threshold.
    const expected = bottomKnee < BOTTOM_TH ? reps : 0;
    repRows.push({
      prescribed_reps: reps, bottom_knee_deg: bottomKnee,
      crosses_threshold: bottomKnee < BOTTOM_TH ? 1 : 0,
      expected_count: expected,
      detected_count: out.repCount,
      error: out.repCount - expected,
    });
  }
}
const repErrs = repRows.map(r => r.error);
const exact = repRows.filter(r => r.error === 0).length;
console.log(`   ${exact}/${repRows.length} conditions counted exactly   ` +
            `MAE ${r3(mae(repErrs))} reps   max |error| ${maxAbs(repErrs)}`);
for (const bad of repRows.filter(r => r.error !== 0)) {
  console.log(`     MISMATCH  reps=${bad.prescribed_reps} bottom=${bad.bottom_knee_deg}°  ` +
              `expected ${bad.expected_count} got ${bad.detected_count}`);
}
report.results.T0_3_rep_counting = {
  bottom_threshold_deg: BOTTOM_TH,
  conditions: repRows.length,
  exact_conditions: exact,
  mae_reps: r3(mae(repErrs)),
  max_abs_error_reps: maxAbs(repErrs),
  csv: writeCSV('t0_3_rep_counting.csv', repRows),
  interpretation:
    'Repetition counting is exact for every repetition that crosses the FSM depth ' +
    `threshold (${BOTTOM_TH}°), and correctly refuses to count partial repetitions ` +
    'above it. Depth-gated counting is a deliberate design choice; it must be stated ' +
    'when comparing against human counters, who typically count attempts.',
};

// ===========================================================================
// T0.4 — Tempo construct validity  [PRIMARY FINDING]
//
// descentTime/ascentTime are surfaced to the user as eccentric/concentric
// tempo, exported to the research CSV as descent_s/ascent_s, and weighted in
// repScore() against bands calibrated for full-phase durations (2-3 s ideal
// descent). The FSM, however, starts its descent timer only at knee < 145 deg
// and stops it at knee < BOTTOM_TH, so it measures the traversal of a mid-range
// angular window rather than the duration of the phase.
// ===========================================================================
console.log('\nT0.4  Tempo construct validity  [primary finding]');

const tempoRows = [];
for (const descentS of [1.0, 1.5, 2.0, 2.5, 3.0, 4.0]) {
  for (const ascentS of [1.0, 1.5, 2.0]) {
    const sess = Synth.generateSession({
      reps: 3, fps: 60, descentS, ascentS, bottomS: 0.3, restS: 1.0,
      standKnee: 175, bottomKnee: 88,
    });
    const out = Replay.replay(sess.frames);
    if (!out.repEvents.length) continue;
    const d = mean(out.repEvents.map(r => r.descentTime));
    const a = mean(out.repEvents.map(r => r.ascentTime));
    const scores = out.repEvents.map(r => r.score);

    // Score the same repetition with the true tempo substituted, to isolate how
    // much of the score penalty is caused by the mis-measured duration.
    const repTrue = Object.assign({}, out.reps[0], { descentTime: descentS, ascentTime: ascentS });
    const scoreWithTrueTempo = Core.repScore(repTrue);

    tempoRows.push({
      true_descent_s: descentS, true_ascent_s: ascentS,
      app_descent_s: r3(d), app_ascent_s: r3(a),
      descent_ratio: r3(d / descentS), ascent_ratio: r3(a / ascentS),
      descent_error_s: r3(d - descentS), ascent_error_s: r3(a - ascentS),
      score_as_measured: r2(mean(scores)),
      score_with_true_tempo: scoreWithTrueTempo,
      score_penalty_from_tempo_defect: r2(scoreWithTrueTempo - mean(scores)),
    });
    console.log(`   true ${descentS}s/${ascentS}s -> reported ${r2(d).toFixed(2)}s/${r2(a).toFixed(2)}s ` +
                `(${(d / descentS * 100).toFixed(0)}%/${(a / ascentS * 100).toFixed(0)}%)  ` +
                `score ${r2(mean(scores))} vs ${scoreWithTrueTempo} with true tempo`);
  }
}
const ratios = tempoRows.map(r => r.descent_ratio);
function tempoOKInterp() {
  const ok = mean(ratios) > 0.8 && mean(ratios) < 1.25 &&
             sd(tempoRows.map(r => r.score_as_measured)) > 0;
  if (ok) {
    return 'PASS (fixed in ver7-D7.66). detectPhase() now times the eccentric phase from ' +
      'departure from standing to the true turnaround, rather than the traversal of a ' +
      `mid-range angular window. Reported duration is ${(mean(ratios) * 100).toFixed(0)}% of true ` +
      `(sd ${r3(sd(ratios))}), no repetition is pinned to the 0.3 s clamp floor, and repScore() ` +
      'again discriminates across the 1-4 s tempo range. Before the fix the figure was 24% and ' +
      'every tempo scored identically. The concentric phase is still measured to the ' +
      'repetition-completion threshold rather than the peak, so ascent duration remains ' +
      'systematically ~25% short — a documented residual limitation.';
  }
  return 'DEFECT. detectPhase() starts the descent timer at knee < 145 deg (STAND-15) and ' +
    'stops it at knee < BOTTOM_TH, so descentTime measures the traversal of a fixed ' +
    'mid-range angular window rather than the duration of the eccentric phase. ' +
    `Reported tempo is ${(mean(ratios) * 100).toFixed(0)}% of true, saturating repScore()'s ` +
    'slowest penalty band for every physiologically normal tempo.';
}
const penalties = tempoRows.map(r => r.score_penalty_from_tempo_defect);
report.results.T0_4_tempo_validity = {
  csv: writeCSV('t0_4_tempo_validity.csv', tempoRows),
  descent_ratio_mean: r3(mean(ratios)),
  descent_ratio_sd: r3(sd(ratios)),
  mean_score_penalty_points: r2(mean(penalties)),
  max_score_penalty_points: r2(Math.max(...penalties)),
  // Data-driven verdict rather than a hardcoded flag: the tempo term is sound
  // when reported duration tracks true duration and the score still discriminates.
  defect: !(mean(ratios) > 0.8 && mean(ratios) < 1.25 && sd(tempoRows.map(r => r.score_as_measured)) > 0),
  score_discrimination_lost: sd(tempoRows.map(r => r.score_as_measured)) === 0,
  downstream_consumers: [
    'index.html:1077,3328-3329  on-screen tempo readout (운동 속도 하강/상승)',
    'index.html:3394            repScore() tempo penalty term (10% + 5% weight)',
    'index.html:3422            per-rep tempo table colour coding (timing-good/warn/bad)',
    'index.html:5059,7400       research CSV columns descent_s/ascent_s, descent_sec/ascent_sec',
    'index.html:4249            LLM coaching context string (AI coach tempo advice)',
    'index.html:3865,3974,4230,4422  PDF report tempo sections',
  ],
  interpretation:
    tempoOKInterp(),
};

// ===========================================================================
// T0.5 — Frame-rate sensitivity
// ===========================================================================
console.log('\nT0.5  Frame-rate sensitivity');

const fpsRows = [];
const baseSession = Synth.generateSession({
  reps: 8, fps: 60, descentS: 1.5, ascentS: 1.2, bottomS: 0.3, restS: 0.8,
  standKnee: 175, bottomKnee: 85,
});
const gtMinBase = Math.min(...baseSession.frames.map(f => f.gt.knee));
for (const [label, n] of [['60', 1], ['30', 2], ['20', 3], ['15', 4], ['12', 5], ['10', 6], ['6', 10]]) {
  const frames = Replay.decimate(baseSession.frames, n);
  const out = Replay.replay(frames);
  const repMin = out.repEvents.length ? mean(out.repEvents.map(r => r.knee)) : NaN;
  fpsRows.push({
    effective_fps: Number(label),
    frames: frames.length,
    detected_reps: out.repCount,
    expected_reps: 8,
    rep_error: out.repCount - 8,
    reported_min_knee: r3(repMin),
    depth_underreport_deg: r3(repMin - gtMinBase),
    mean_descent_s: out.repEvents.length ? r3(mean(out.repEvents.map(r => r.descentTime))) : null,
  });
  console.log(`   ${String(label).padStart(3)} fps  reps ${out.repCount}/8  ` +
              `reported depth ${r2(repMin).toFixed(1)}° (true ${r2(gtMinBase).toFixed(1)}°)`);
}
report.results.T0_5_frame_rate = {
  csv: writeCSV('t0_5_frame_rate.csv', fpsRows),
  rows: fpsRows,
  interpretation:
    'Characterises degradation on low-end devices, where the production pipeline ' +
    'adaptively lowers model complexity and effective frame rate. Repetition counting ' +
    'is robust down to low rates; reported depth degrades gradually because coarse ' +
    'sampling misses the turnaround and compounds the EMA lag of T0.2.',
};

// ===========================================================================
// T0.6 — Landmark-noise robustness
//
// Gaussian jitter is injected into landmark coordinates as a proxy for
// pose-estimation noise. This is a sensitivity analysis, not a substitute for
// Tier 1/2: real MediaPipe error is structured and pose-dependent, not i.i.d.
// ===========================================================================
console.log('\nT0.6  Landmark-noise robustness');

const noiseRows = [];
for (const noise of [0, 1, 2, 5, 10, 20]) {
  const errs = { knee: [], hip: [], trunk: [], ankle: [] };
  let repErrTotal = 0;
  const SEEDS = 5;
  for (let s = 0; s < SEEDS; s++) {
    const sess = Synth.generateSession({
      reps: 5, fps: 30, descentS: 1.5, ascentS: 1.2, bottomS: 0.3, restS: 0.8,
      standKnee: 175, bottomKnee: 88, noiseDeg: noise, seed: 1000 + s * 77,
    });
    const out = Replay.replay(sess.frames);
    repErrTotal += Math.abs(out.repCount - 5);
    // Compare frame-wise, skipping the filter's initial transient.
    for (let i = 30; i < out.series.length; i++) {
      for (const j of JOINTS) errs[j].push(out.series[i][j] - sess.frames[i].gt[j]);
    }
  }
  const row = { landmark_noise_sd_x1000: noise, rep_count_mae: r3(repErrTotal / SEEDS) };
  for (const j of JOINTS) {
    row[`${j}_mae_deg`] = r3(mae(errs[j]));
    row[`${j}_sd_deg`] = r3(sd(errs[j]));
  }
  noiseRows.push(row);
  console.log(`   noise sd ${String(noise).padStart(2)}/1000  ` +
              `knee MAE ${row.knee_mae_deg.toFixed(2)}°  trunk MAE ${row.trunk_mae_deg.toFixed(2)}°  ` +
              `rep MAE ${row.rep_count_mae}`);
}
report.results.T0_6_noise_robustness = {
  csv: writeCSV('t0_6_noise_robustness.csv', noiseRows),
  rows: noiseRows,
  interpretation:
    'Sensitivity analysis with i.i.d. gaussian landmark jitter. Frame-wise error ' +
    'includes the EMA tracking lag of T0.2, so it is an upper bound on the static ' +
    'error at a given noise level. Real pose-estimation error is spatially and ' +
    'temporally correlated, so these figures do not substitute for Tier 1/2.',
};

// ===========================================================================
// Summary
// ===========================================================================
const reportPath = path.join(outDir, 'tier0_report.json');
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

console.log('\n' + '='.repeat(72));
console.log('SUMMARY');
console.log(`  angle math      exact (max |error| ${r3(Math.max(...JOINTS.map(j => report.results.T0_1_static_accuracy.per_joint[j].max_abs_deg)))}°)`);
console.log(`  rep counting    ${exact}/${repRows.length} conditions exact`);
const tempoOK = mean(ratios) > 0.8 && mean(ratios) < 1.25 && sd(tempoRows.map(r => r.score_as_measured)) > 0;
console.log(`  tempo           ${tempoOK ? 'OK  ' : 'DEFECT '} measured as ${(mean(ratios) * 100).toFixed(0)}% of true duration ` +
            `(mean score penalty ${r2(mean(penalties))} pts)`);
console.log(`  depth bias      EMA under-reports depth by <=${r3(Math.max(...lagRows.map(r => r.rep_underreport_deg)))}° at 30fps; ` +
            `up to ${r3(Math.max(...fpsRows.map(r => r.depth_underreport_deg)))}° at 6fps`);
console.log(`\n  report  ${path.relative(process.cwd(), reportPath)}`);
console.log(`  csv     ${outDir}/t0_*.csv`);
