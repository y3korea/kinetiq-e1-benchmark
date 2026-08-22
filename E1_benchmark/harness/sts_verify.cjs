#!/usr/bin/env node
/**
 * sts_verify.cjs — Tier 0 for the sit-to-stand (30-second chair stand) module
 * ==========================================================================
 *
 * REHAB24-6 contains no sit-to-stand exercise, so this chain cannot be checked against
 * that mocap ground truth the way squats were. It is checked instead against synthetic
 * kinematics whose true angles and true repetition count hold by construction — the
 * same Tier 0 approach used for squats, and enough to answer the questions actually at
 * issue:
 *
 *   S1  Does the aspect-ratio defect fixed in the squat chain (ver7-D7.67) also
 *       affect this one? Landmarks are built in PIXEL space at a true angle, then
 *       normalised by width and height separately — exactly what MediaPipe emits —
 *       so any anisotropy shows up as angle error.
 *
 *   S2  Does the module count what the 30-second chair stand test counts? The
 *       protocol (Rikli & Jones) scores the number of times the person comes to
 *       FULL STAND within 30 s. A finite-state machine that increments on the
 *       return to sitting scores completed sit-stand-sit CYCLES instead, which is
 *       not the same number.
 *
 *   S3  Does repetition counting survive the angle distortion, as it did not in the
 *       squat chain?
 *
 * The module is driven through its real entry point, onSTSResults(), so the smoothing,
 * the limb choice and the phase machine all run as shipped.
 */
const fs = require('fs');
const path = require('path');

require('./harness_shim.js');
require('./kinetiq_core.generated.js');
// The generated files load as ESM here, so `module.exports` never runs and require()
// yields an empty namespace; the globalThis assignment is the one that takes effect.
const Core = globalThis.KinetiQCore;

// The STS chain calls calcAngle/drawPose as free variables, exactly as it does inside
// index.html where everything shares one script scope. Publish the core's functions as
// globals so the extracted code resolves them the same way it does in the browser.
for (const name of ['calcAngle', 'calcTrunk', 'drawPose', 'drawMirroredText', 'smooth', 'speak']) {
  if (typeof globalThis[name] === 'undefined' && Core && typeof Core[name] === 'function') {
    globalThis[name] = Core[name];
  }
}
if (typeof globalThis.calcAngle !== 'function') {
  throw new Error('calcAngle not available to the STS chain — extraction incomplete');
}
// Presentation-layer callbacks the chain invokes. They are stubbed rather than
// extracted because they only write to the DOM and speak — they carry no measurement.
// Calls are recorded so the test can still assert on what the user would be told.
const uiCalls = [];
globalThis.updateSTSPI = (cls, txt) => { uiCalls.push({ fn: 'updateSTSPI', cls, txt }); };
globalThis.updateSTSFeedback = (knee) => { uiCalls.push({ fn: 'updateSTSFeedback', knee }); };
if (typeof globalThis.speak !== 'function') globalThis.speak = (txt) => { uiCalls.push({ fn: 'speak', txt }); };
if (typeof globalThis.drawPose !== 'function') globalThis.drawPose = () => {};
if (typeof globalThis.drawMirroredText !== 'function') globalThis.drawMirroredText = () => {};

require('./kinetiq_sts.generated.js');

const shim = globalThis.KinetiQShim;
const STS = globalThis.KinetiQSTS.STS;
const onSTSResults = globalThis.KinetiQSTS.onSTSResults;
const PROV = globalThis.KinetiQSTS.KINETIQ_STS_PROVENANCE;

const outDir = path.resolve(path.join(__dirname, '..', 'results'));
fs.mkdirSync(outDir, { recursive: true });
const r2 = x => Math.round(x * 100) / 100;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;

shim.install();
const canvas = shim.makeCanvasStub(), ctx = shim.makeCtxStub();

/**
 * Build a planar leg + trunk at a prescribed TRUE knee angle, in pixel space, then
 * hand back MediaPipe-style normalised coordinates for a frame of the given size.
 * Normalising x by width and y by height is where the anisotropy enters.
 */
function angleAt(a, b, c) {                       // degrees, at vertex b
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const d = (v1[0] * v2[0] + v1[1] * v2[1]) /
            (Math.hypot(...v1) * Math.hypot(...v2));
  return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
}

function frameAt(kneeDeg, hipDeg, W, H) {
  const cx = W * 0.5, kneeY = H * 0.62, hipY = H * 0.40, shoulderY = H * 0.16;
  const SHANK = H * 0.20, THIGH = H * 0.20;
  const half = (180 - kneeDeg) * Math.PI / 180;
  const ax = cx + SHANK * Math.sin(half), ay = kneeY + SHANK * Math.cos(half);
  const hx = cx - THIGH * Math.sin((180 - hipDeg) * Math.PI / 180) * 0.15;

  // The prescribed angle is only a construction parameter; the geometry that lands on
  // the image is what the app sees, so the reference is measured from those pixels
  // rather than assumed equal to the parameter. Without this the harness reports its
  // own construction error as though it were the app's.
  const truth = {
    knee: angleAt([hx, hipY], [cx, kneeY], [ax, ay]),
    hip: angleAt([cx, shoulderY], [hx, hipY], [cx, kneeY]),
  };

  const P = (x, y, v) => ({ x: x / W, y: y / H, z: 0, visibility: v });
  const lm = Array.from({ length: 33 }, () => P(cx, hipY, 0.5));
  lm[11] = P(cx, shoulderY, 0.99); lm[12] = P(cx, shoulderY, 0.40);
  lm[23] = P(hx, hipY, 0.99);      lm[24] = P(hx, hipY, 0.40);
  lm[25] = P(cx, kneeY, 0.99);     lm[26] = P(cx, kneeY, 0.40);
  lm[27] = P(ax, ay, 0.99);        lm[28] = P(ax, ay, 0.40);
  lm[31] = P(ax + W * 0.04, ay + H * 0.01, 0.9); lm[32] = P(ax + W * 0.04, ay + H * 0.01, 0.4);
  lm.__truth = truth;
  return lm;
}

function resetSTS() {
  STS.phase = 'sit'; STS.prevKnee = 90; STS.repCount = 0; STS.reps = [];
  STS.smoothK = 90; STS.smoothH = 90; STS.isRunning = true;
  STS.startTime = 0; STS.lastRepTime = 0;
}

/** Drive N full sit->stand->sit cycles, ending STANDING (as a 30 s test typically does). */
function runCycles(n, W, H, { endStanding = true, sitKnee = 90, standKnee = 175, fps = 30 } = {}) {
  resetSTS();
  shim.setFrameSize(W, H);
  const observed = [];
  const feed = (kneeDeg) => {
    const lm = frameAt(kneeDeg, kneeDeg, W, H);
    onSTSResults({ poseLandmarks: lm }, canvas, ctx);
    observed.push({ true_knee: lm.__truth.knee, app_knee: STS.smoothK });
    STS.prevKnee = STS.smoothK;
  };
  for (let i = 0; i < 15; i++) feed(sitKnee);              // settle, seated
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < 20; i++) feed(sitKnee + (standKnee - sitKnee) * i / 19);   // rise
    for (let i = 0; i < 8; i++) feed(standKnee);                                    // stand
    const last = (r === n - 1);
    if (last && endStanding) break;
    for (let i = 0; i < 20; i++) feed(standKnee - (standKnee - sitKnee) * i / 19);  // sit down
    for (let i = 0; i < 8; i++) feed(sitKnee);
  }
  return { repCount: STS.repCount, observed };
}

console.log(`E1 — sit-to-stand chain, KinetiQ ${PROV.engine_version}`);
console.log('synthetic kinematics; true angles and true counts hold by construction');
console.log('='.repeat(76));

// --- S1  aspect-ratio sensitivity -----------------------------------------
console.log('\nS1  Angle accuracy vs frame geometry');
const s1 = [];
for (const [label, W, H] of [['square 960x960', 960, 960], ['4:3 1280x960 (production)', 1280, 960],
                             ['16:9 1280x720', 1280, 720], ['9:16 1080x1920', 1080, 1920]]) {
  resetSTS();
  shim.setFrameSize(W, H);   // the app reads this and corrects for it itself
  const errs = [];
  for (const k of [90, 110, 130, 150, 170]) {
    let truth = 0;
    for (let i = 0; i < 40; i++) {                 // settle the smoother, then read it
      const lm = frameAt(k, k, W, H);
      truth = lm.__truth.knee;
      onSTSResults({ poseLandmarks: lm }, canvas, ctx);
      STS.prevKnee = STS.smoothK;
    }
    errs.push(STS.smoothK - truth);
  }
  const mae = mean(errs.map(Math.abs));
  s1.push({ frame: label, mae: r2(mae), bias: r2(mean(errs)),
            per_angle: errs.map(r2) });
  console.log(`  ${label.padEnd(26)} MAE ${String(r2(mae)).padStart(6)}°  bias ${String(r2(mean(errs))).padStart(7)}°  ` +
              `by angle: ${errs.map(e => r2(e)).join(', ')}` +
              (label.startsWith('square') ? '   <- harness sanity, must be ~0' : ''));
}

// --- S2  does it count what the 30 s chair stand test counts? --------------
console.log('\nS2  Repetition semantics vs the 30-second chair stand protocol');
console.log('    protocol scores the number of times the person reaches FULL STAND');
const s2 = [];
for (const n of [1, 5, 10, 15]) {
  const ending = runCycles(n, 1280, 960, { endStanding: true });
  const cycles = runCycles(n, 1280, 960, { endStanding: false });
  s2.push({ true_stands: n, counted_when_ending_standing: ending.repCount,
            counted_when_returning_to_sit: cycles.repCount });
  console.log(`  ${String(n).padStart(2)} stands  ->  ending standing: counted ${String(ending.repCount).padStart(2)}` +
              `   |  returning to sit: counted ${String(cycles.repCount).padStart(2)}`);
}
const undercount = s2.every(r => r.counted_when_ending_standing === r.true_stands - 1);

// --- S3  does counting survive the distortion? -----------------------------
console.log('\nS3  Repetition counting across frame geometries (10 stands, ending seated)');
const s3 = [];
for (const [label, W, H] of [['square 960x960', 960, 960], ['4:3 1280x960 (production)', 1280, 960],
                             ['16:9 1280x720', 1280, 720], ['9:16 1080x1920', 1080, 1920]]) {
  const out = runCycles(10, W, H, { endStanding: false });
  s3.push({ frame: label, expected: 10, counted: out.repCount });
  console.log(`  ${label.padEnd(26)} expected 10  counted ${out.repCount}` +
              (out.repCount === 10 ? '' : '   *** MISCOUNT ***'));
}

console.log('\n' + '='.repeat(76));
console.log('FINDINGS');
const prodS1 = s1.find(x => x.frame.startsWith('4:3'));
console.log(`  S1  production 4:3 frame: knee MAE ${prodS1.mae}° (bias ${prodS1.bias}°)` +
            (prodS1.mae > 2 ? '  -> aspect-ratio defect PRESENT' : '  -> no aspect defect'));
console.log(`  S2  ${undercount
  ? 'UNDERCOUNTS BY ONE. The machine increments on the return to sitting, so a stand\n' +
    '      that has not been followed by sitting back down is not scored. The 30 s test\n' +
    '      ends wherever the clock ends, usually standing.'
  : 'counting matches the protocol.'}`);
const miscounts = s3.filter(x => x.counted !== x.expected);
console.log(`  S3  ${miscounts.length ? `counting breaks on: ${miscounts.map(m => m.frame).join(', ')}`
  : 'counting holds across all tested frame geometries'}`);

fs.writeFileSync(path.join(outDir, 'sts_report.json'), JSON.stringify({
  experiment: 'E1 Tier 0 — sit-to-stand chain',
  generated: new Date().toISOString(),
  engine_version: PROV.engine_version,
  provenance: PROV.definitions,
  ground_truth: 'synthetic kinematics; angles and counts true by construction',
  dataset_note: 'REHAB24-6 has no sit-to-stand exercise, so no mocap comparison is possible here',
  S1_aspect: s1,
  S2_protocol_semantics: { rows: s2, undercounts_by_one: undercount,
    protocol: 'Rikli & Jones 30-second chair stand: score = number of full stands in 30 s' },
  S3_counting: s3,
}, null, 2));
console.log('\nwritten: results/sts_report.json');
