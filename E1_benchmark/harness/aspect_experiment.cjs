#!/usr/bin/env node
/**
 * aspect_experiment.cjs — does correcting the aspect ratio actually help, and does
 * anything else have to move with it?
 * =============================================================================
 *
 * KinetiQ computes joint angles from MediaPipe's normalised coordinates, where x is
 * divided by frame width and y by frame height. When width != height that scaling is
 * anisotropic, and anisotropic scaling does not preserve angles. Tier 2 measured the
 * consequence: a -23.7 deg knee bias against the true image plane.
 *
 * The fix is one line — make the coordinate space isotropic before computing angles
 * (x' = x * W/H leaves y alone and puts both axes in units of frame height). The real
 * question is what the fix drags with it:
 *
 *   1. Do the angles actually match the image plane afterwards?
 *   2. Does repetition counting survive? The finite-state machine's thresholds
 *      (STAND = 160 deg, BOTTOM_TH = knee.max + 15) were tuned by hand against
 *      DISTORTED angles, so correcting the input moves every angle underneath them.
 *      Tier 2's control condition already showed distortion alone drops recall to
 *      0.707, so this cuts both ways.
 *   3. Do scores move, and in which direction? STANDARDS are literature ranges
 *      (ACSM/NASM) expressed in true anatomical angles, so the app has been comparing
 *      distorted measurements against undistorted norms. Correcting should improve
 *      that match rather than break it — but that is a prediction, and this script
 *      is how it gets tested instead of assumed.
 *
 * Conditions replayed over the SAME persisted landmarks (no MediaPipe re-run):
 *   A  as-is                      current production
 *   B  aspect-corrected           the proposed fix
 *   C  corrected + rescaled FSM   fix, with STAND/BOTTOM re-derived if B breaks counting
 *
 * Usage
 *   node aspect_experiment.cjs --corpus <dir> --ref <dir> [--conditions A,B,C]
 *
 * 2026-08-22 의미론 갱신 (엔진 ver7-D7.85 기준)
 * ------------------------------------------------
 * 이 실험이 처음 돈 D7.66 에서는 배포 코드에 보정이 없었고 BOTTOM_TH 기본값이
 * 115 였다. D7.67 이 보정과 135 게이트를 배포에 넣었으므로, 조건의 의미를
 * 재정의한다 (같은 랜드마크·같은 채점, 라벨만 시대에 맞게):
 *   A  legacy   — 보정 없음 + BOTTOM_TH 115  (= D7.66 당시 배포 재현)
 *   B  fix-only — 보정 + BOTTOM_TH 115       (반사실: 게이트를 안 움직였다면)
 *   C  current  — 보정 + 코어 기본값(135)     (= 현행 D7.85 배포)
 * 임계 오버라이드는 추출기가 공개 패치로 심는 __E1_TH 훅을 쓴다. D7.66 시절
 * 손패치 훅이 재추출로 소실됐던 사고의 재발 방지책이다 (provenance.patches).
 * 주의: 이 스크립트는 setFrameSize 를 부르지 않아 코어 내부 보정이 꺼진(AR=1)
 * 상태로 돌며, 보정은 조건이 외부에서 가한다 — D7.66 과 동일한 주입 방식이다.
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
const corpusDir = path.resolve(arg('--corpus', ''));
const refDir = path.resolve(arg('--ref', ''));
const outDir = path.resolve(arg('--out', path.join(__dirname, '..', 'results')));
const TOL_S = parseFloat(arg('--tol', '0.75'));
if (!corpusDir || !refDir) { console.error('--corpus and --ref required'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const IMG_W = 1080, IMG_H = 1920;
const ASPECT = IMG_W / IMG_H;

const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sd = a => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) : NaN; };
const absA = a => a.map(Math.abs);
const pct = (a, q) => { const b = [...absA(a)].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length * q)] : NaN; };

/** Corpus rows are [x, y, z, visibility]; rebuild the object form the core expects. */
function toFrames(corpus, { correctAspect }) {
  const out = [];
  for (let i = 0; i < corpus.landmarks.length; i++) {
    const row = corpus.landmarks[i];
    if (!row) continue;
    out.push({
      t: i / 30,
      landmarks: row.map(p => ({
        // Isotropic rescale: x and y both end up in units of frame height.
        x: correctAspect ? p[0] * ASPECT : p[0],
        y: p[1], z: p[2], visibility: p[3],
      })),
    });
  }
  return out;
}

/**
 * The limb KinetiQ analyses is a pure function of landmark visibilities, so the
 * choice it made is recoverable exactly from the corpus — no assumption, and no
 * picking whichever limb happens to agree better.
 */
function chosenSide(corpus) {
  let left = 0, right = 0;
  for (const row of corpus.landmarks) {
    if (!row) continue;
    const l = (row[11][3] + row[23][3] + row[25][3] + row[27][3]) / 4;
    const r = (row[12][3] + row[24][3] + row[26][3] + row[28][3]) / 4;
    if (l > r) left++; else right++;
  }
  return { side: left > right ? 'left' : 'right', left_frames: left, right_frames: right,
           stability: Math.max(left, right) / (left + right) };
}

function scoreAgainst(repEvents, ref, annotations, side) {
  const rows = []; let missedN = 0; const used = new Set();
  for (const a of annotations) {
    if (a.mocap_erroneous) continue;
    const lo = a.first_frame / 30, hi = a.last_frame / 30 + TOL_S;
    const idx = repEvents.findIndex((e, i) => !used.has(i) && e.atTime >= lo && e.atTime <= hi);
    if (idx < 0) { missedN++; continue; }
    used.add(idx);
    const e = repEvents[idx];
    const seg = arr => arr.slice(a.first_frame, a.last_frame + 1);
    rows.push({
      rep: a.repetition_number, sagittal: a.cam18_sagittal ? 1 : 0, correctness: a.correctness ? 1 : 0,
      knee_err: e.knee - Math.min(...seg(ref[side].knee)),
      hip_err: e.hip - Math.min(...seg(ref[side].hip)),
      trunk_err: e.trunk - Math.max(...seg(ref[side].trunk)),
      score: e.score,
    });
  }
  return { rows, missed: missedN, fp: repEvents.length - used.size };
}

function stat(rows, key) {
  const v = rows.map(r => r[key]).filter(Number.isFinite);
  if (!v.length) return null;
  return { n: v.length, mae: r2(mean(absA(v))), bias: r2(mean(v)),
           rmse: r2(Math.sqrt(mean(v.map(x => x * x)))), p95: r2(pct(v, 0.95)) };
}

function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const a = [...pos.map(v => [v, 1]), ...neg.map(v => [v, 0])].sort((x, y) => x[0] - y[0]);
  const rk = new Array(a.length);
  for (let i = 0; i < a.length;) { let j = i; while (j + 1 < a.length && a[j + 1][0] === a[i][0]) j++;
    const m = (i + j + 2) / 2; for (let t = i; t <= j; t++) rk[t] = m; i = j + 1; }
  const rp = a.reduce((s, x, i) => s + (x[1] === 1 ? rk[i] : 0), 0);
  return (rp - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}

// ---------------------------------------------------------------------------
const files = fs.readdirSync(corpusDir).filter(f => f.endsWith('_corpus.json')).sort();
if (!files.length) { console.error(`no corpus files in ${corpusDir}`); process.exit(1); }

console.log(`aspect-ratio experiment — KinetiQ ${Core.KINETIQ_PROVENANCE.engine_version}`);
console.log(`${files.length} recordings, replayed offline from persisted landmarks`);
console.log(`frame ${IMG_W}x${IMG_H}  aspect W/H = ${r3(ASPECT)}`);
console.log('='.repeat(78));

const LEGACY_TH = { stand: 160, bottom: 115, parallel: 150 };   // D7.66 당시 배포 기본값
const CONDITIONS = [
  { key: 'A', label: 'legacy: uncorrected + BOTTOM_TH 115 (D7.66 production)', correctAspect: false, th: LEGACY_TH },
  { key: 'B', label: 'fix-only: corrected + BOTTOM_TH 115 (counterfactual)', correctAspect: true, th: LEGACY_TH },
  // th:null -> 코어 기본식 그대로 = min(ACSM.knee.max+35,145) = 135. dev/test 분리로
  // 확정한 값이며 (bottom_th_selection.cjs), 현행 배포가 실제로 쓰는 게이트다.
  { key: 'C', label: 'current: corrected + core default 135 (D7.85 production)', correctAspect: true, th: null },
];

const results = {};
const sides = {};
let annTotal = 0;

for (const cond of CONDITIONS) results[cond.key] = { rows: [], missed: 0, fp: 0, detected: 0 };

for (const f of files) {
  const rec = f.replace('_corpus.json', '');
  const corpus = JSON.parse(fs.readFileSync(path.join(corpusDir, f), 'utf8'));
  const refPath = path.join(refDir, `${rec}_ref.json`);
  if (!fs.existsSync(refPath)) { console.log(`  ${rec}: no reference, skipped`); continue; }
  const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
  const ann = ref.annotated_repetitions;
  annTotal += ann.filter(a => !a.mocap_erroneous).length;

  const cs = chosenSide(corpus);
  sides[rec] = cs;

  const line = [`  ${rec}  limb=${cs.side} (${(100 * cs.stability).toFixed(0)}% stable)`];
  for (const cond of CONDITIONS) {
    globalThis.__E1_TH = cond.th;
    const out = Replay.replay(toFrames(corpus, cond));
    globalThis.__E1_TH = null;
    const sc = scoreAgainst(out.repEvents, ref.reference_2d, ann, cs.side);
    results[cond.key].rows.push(...sc.rows);
    results[cond.key].missed += sc.missed;
    results[cond.key].fp += sc.fp;
    results[cond.key].detected += out.repEvents.length;
    line.push(`${cond.key}:${sc.rows.length}rep`);
  }
  console.log(line.join('  '));
}

console.log(`\n${annTotal} annotated repetitions\n`);

const summary = {};
for (const cond of CONDITIONS) {
  const R = results[cond.key];
  const recall = R.rows.length / annTotal;
  const precision = R.rows.length / (R.rows.length + R.fp);
  const good = R.rows.filter(r => r.correctness === 1).map(r => r.score);
  const bad = R.rows.filter(r => r.correctness === 0).map(r => r.score);
  console.log(`${cond.key}  ${cond.label}`);
  console.log(`   counting  recall ${r3(recall)}  precision ${r3(precision)}  (matched ${R.rows.length}, FP ${R.fp})`);
  for (const [nm, key] of [['knee', 'knee_err'], ['hip', 'hip_err'], ['trunk', 'trunk_err']]) {
    const s = stat(R.rows, key);
    if (s) console.log(`   ${nm.padEnd(5)} vs image plane  MAE ${String(s.mae).padStart(6)}°  bias ${String(s.bias).padStart(7)}°  p95 ${s.p95}°`);
  }
  console.log(`   score  correct ${r2(mean(good))} vs incorrect ${r2(mean(bad))}   AUC ${r3(auc(good, bad))}\n`);
  summary[cond.key] = { label: cond.label, recall: r3(recall), precision: r3(precision),
    matched: R.rows.length, fp: R.fp,
    knee: stat(R.rows, 'knee_err'), hip: stat(R.rows, 'hip_err'), trunk: stat(R.rows, 'trunk_err'),
    auc: r3(auc(good, bad)), score_correct: r2(mean(good)), score_incorrect: r2(mean(bad)) };
}

const A = summary.A, B = summary.B, C = summary.C;
console.log('VERDICT   (A = D7.66 legacy, C = D7.85 production)');
console.log(`  knee MAE   ${A.knee.mae}° -> ${C.knee.mae}°    bias ${A.knee.bias}° -> ${C.knee.bias}°`);
console.log(`  hip  MAE   ${A.hip.mae}° -> ${C.hip.mae}°`);
console.log(`  trunk MAE  ${A.trunk.mae}° -> ${C.trunk.mae}°`);
console.log(`  recall     ${A.recall} -> ${C.recall}     (B, gate untouched: ${B.recall})`);
console.log(`  precision  ${A.precision} -> ${C.precision}`);
console.log(`  score AUC  ${A.auc} -> ${C.auc}`);
const angleBetter = C.knee.mae < A.knee.mae;
const countingHeld = C.recall >= A.recall - 0.02 && C.precision >= A.precision - 0.03;
if (angleBetter && countingHeld) {
  console.log('  -> D7.67 의 수정(보정+게이트 이동)이 유효함을 재확인: 각도 개선, 카운팅 유지.');
  console.log('     B 가 보여주듯 보정만 단독으론 카운팅이 무너진다 — 게이트가 함께 움직여야 한다.');
} else if (angleBetter) {
  console.log('  -> angles improve but counting still degrades. Do not ship yet.');
} else {
  console.log('  -> correction does NOT improve agreement. Re-examine the premise.');
}

fs.writeFileSync(path.join(outDir, 'aspect_experiment.json'), JSON.stringify({
  experiment: 'aspect-ratio correction, replayed offline over persisted Tier 2 landmarks',
  generated: new Date().toISOString(),
  engine_version: Core.KINETIQ_PROVENANCE.engine_version,
  source_sha256: Core.KINETIQ_PROVENANCE.source_sha256,
  frame: { width: IMG_W, height: IMG_H, aspect: r3(ASPECT) },
  limb_selection: sides,
  limb_note: 'recovered exactly from landmark visibilities, which is what the app uses; '
           + 'this removes the lower-bound caveat that applied to the first Tier 2 run',
  annotated_repetitions: annTotal,
  conditions: summary,
}, null, 2));
console.log(`\nwritten: results/aspect_experiment.json`);
