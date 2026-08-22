#!/usr/bin/env node
/**
 * bottom_th_selection.cjs — choose the depth gate for the aspect-corrected space
 * =============================================================================
 *
 * Correcting the aspect ratio raises every measured knee angle at the bottom of a
 * squat, so the depth gate that decides "this counts as a repetition"
 * (BOTTOM_TH, today min(knee.max + 15, 125) = 115 deg) no longer sits where it did.
 * Left alone it drops recall from 0.926 to 0.858 — not because counting got worse,
 * but because the gate was calibrated against distorted angles.
 *
 * Choosing the replacement on the same recordings used to report it would repeat the
 * mistake that put the thresholds where they are: the code comment "ver2: thresholds
 * widened so partial squats register reliably" is exactly this kind of fit, made
 * without a held-out check. So the value is selected on DEV recordings and reported
 * on TEST recordings that played no part in choosing it.
 *
 * Recordings, not repetitions, are the unit of splitting: repetitions within one
 * recording share a person, a camera placement, and a movement habit, so splitting
 * at the repetition level would leak.
 *
 * Note on what this threshold is FOR: it gates detection, not quality. Whether a
 * squat was deep enough to be GOOD is judged separately by repScore() against the
 * ACSM/NASM ranges in STANDARDS. A permissive gate paired with strict scoring
 * counts a shallow repetition and then scores it poorly, which is the intended
 * behaviour; a strict gate silently drops it and tells the user nothing.
 *
 * Usage
 *   node bottom_th_selection.cjs --corpus <dir> --ref <dir>
 */

const fs = require('fs');
const path = require('path');

require('./harness_shim.js');
require('./kinetiq_core.generated.js');
require('./replay.js');

const Replay = globalThis.KinetiQReplay;
const Core = globalThis.KinetiQCore;

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const corpusDir = path.resolve(arg('--corpus', ''));
const refDir = path.resolve(arg('--ref', ''));
const outDir = path.resolve(arg('--out', path.join(__dirname, '..', 'results')));
const TOL_S = 0.75;
const ASPECT = 1080 / 1920;

const DEV = ['PM_008', 'PM_022', 'PM_029', 'PM_038', 'PM_043'];
const TEST = ['PM_105', 'PM_113', 'PM_118', 'PM_126'];
const CANDIDATES = [115, 120, 125, 130, 135, 140, 145];

const r3 = x => Math.round(x * 1000) / 1000;

const loaded = {};
function load(rec) {
  if (loaded[rec]) return loaded[rec];
  const c = JSON.parse(fs.readFileSync(path.join(corpusDir, `${rec}_corpus.json`), 'utf8'));
  const ref = JSON.parse(fs.readFileSync(path.join(refDir, `${rec}_ref.json`), 'utf8'));
  loaded[rec] = { c, ref };
  return loaded[rec];
}

function frames(c, correct) {
  const out = [];
  for (let i = 0; i < c.landmarks.length; i++) {
    const r = c.landmarks[i];
    if (!r) continue;
    out.push({ t: i / 30, landmarks: r.map(p => ({
      x: correct ? p[0] * ASPECT : p[0], y: p[1], z: p[2], visibility: p[3] })) });
  }
  return out;
}

function evaluate(recs, correct, th) {
  globalThis.__E1_TH = th;
  let matched = 0, fp = 0, ann = 0;
  for (const rec of recs) {
    const { c, ref } = load(rec);
    const out = Replay.replay(frames(c, correct));
    const A = ref.annotated_repetitions.filter(a => !a.mocap_erroneous);
    ann += A.length;
    const used = new Set();
    for (const a of A) {
      const lo = a.first_frame / 30, hi = a.last_frame / 30 + TOL_S;
      const i = out.repEvents.findIndex((e, j) => !used.has(j) && e.atTime >= lo && e.atTime <= hi);
      if (i >= 0) { used.add(i); matched++; }
    }
    fp += out.repEvents.length - used.size;
  }
  globalThis.__E1_TH = null;
  const recall = matched / ann, precision = matched / (matched + fp);
  return { recall, precision, f1: 2 * recall * precision / (recall + precision), matched, fp, ann };
}

const fmt = r => `recall ${r3(r.recall).toFixed(3)}  precision ${r3(r.precision).toFixed(3)}  ` +
                 `F1 ${r3(r.f1).toFixed(3)}  (${r.matched}/${r.ann}, FP ${r.fp})`;

const have = new Set(fs.readdirSync(corpusDir).filter(f => f.endsWith('_corpus.json'))
  .map(f => f.replace('_corpus.json', '')));
const dev = DEV.filter(r => have.has(r)), test = TEST.filter(r => have.has(r));

console.log(`BOTTOM_TH selection — KinetiQ ${Core.KINETIQ_PROVENANCE.engine_version}`);
console.log(`dev  ${dev.join(', ')}`);
console.log(`test ${test.join(', ')}`);
console.log('='.repeat(74));

console.log('\nDEV — selection (aspect-corrected; STAND=160 held, PARALLEL=max(130, BOTTOM+15))');
const devBase = evaluate(dev, false, { stand: 160, bottom: 115, parallel: 130 });
console.log(`  as-is baseline  BOTTOM=115 : ${fmt(devBase)}`);
let best = null;
const devRows = [];
for (const b of CANDIDATES) {
  const r = evaluate(dev, true, { stand: 160, bottom: b, parallel: Math.max(130, b + 15) });
  devRows.push({ bottom: b, ...r });
  console.log(`  corrected       BOTTOM=${String(b).padStart(3)} : ${fmt(r)}`);
  if (!best || r.f1 > best.f1) best = { bottom: b, ...r };
}
// Prefer the smallest threshold within noise of the best: a lower depth gate is the
// more conservative choice, since raising it admits shallower movements as repetitions.
const near = devRows.filter(r => r.f1 >= best.f1 - 0.005);
const chosen = near.reduce((a, b) => (b.bottom < a.bottom ? b : a), near[0]);
console.log(`\n  best F1 ${r3(best.f1)} at BOTTOM=${best.bottom}; within 0.005 F1: ${near.map(r => r.bottom).join(', ')}`);
console.log(`  -> chosen BOTTOM_TH = ${chosen.bottom}  (smallest of the tied set: a lower gate`);
console.log('     admits fewer shallow movements as repetitions)');

console.log('\nTEST — held out, played no part in the choice');
const testBase = evaluate(test, false, { stand: 160, bottom: 115, parallel: 130 });
const testNew = evaluate(test, true, { stand: 160, bottom: chosen.bottom, parallel: Math.max(130, chosen.bottom + 15) });
console.log(`  as-is        BOTTOM=115 : ${fmt(testBase)}`);
console.log(`  corrected    BOTTOM=${String(chosen.bottom).padStart(3)} : ${fmt(testNew)}`);

const dRecall = testNew.recall - testBase.recall;
const dPrec = testNew.precision - testBase.precision;
console.log(`\n  held-out delta: recall ${dRecall >= 0 ? '+' : ''}${r3(dRecall)}  precision ${dPrec >= 0 ? '+' : ''}${r3(dPrec)}`);
console.log(dRecall >= -0.02 && dPrec >= -0.03
  ? '  -> counting holds on unseen recordings. The correction can ship with this gate.'
  : '  -> counting does NOT hold out of sample. Do not ship on this evidence.');

fs.writeFileSync(path.join(outDir, 'bottom_th_selection.json'), JSON.stringify({
  experiment: 'BOTTOM_TH re-derivation for the aspect-corrected coordinate space',
  generated: new Date().toISOString(),
  engine_version: Core.KINETIQ_PROVENANCE.engine_version,
  split: { unit: 'recording', dev, test },
  candidates: CANDIDATES,
  dev_baseline_as_is: devBase,
  dev_sweep: devRows,
  chosen: chosen.bottom,
  selection_rule: 'highest F1 on dev; among values within 0.005 F1 of the best, the '
                + 'smallest, because a lower depth gate admits fewer shallow movements',
  test_as_is: testBase,
  test_corrected: testNew,
  note: 'BOTTOM_TH gates detection, not quality. Squat depth adequacy is judged '
      + 'separately by repScore() against the ACSM/NASM ranges in STANDARDS.',
}, null, 2));
console.log('\nwritten: results/bottom_th_selection.json');
