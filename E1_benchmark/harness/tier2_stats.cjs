#!/usr/bin/env node
/**
 * tier2_stats.cjs — Tier 2 의 통계적 보강 (JBHI 수준)
 * ====================================================
 *
 * tier2_prod_verify.cjs 와 동일한 재생·매칭 위에 통계를 얹는다. 점추정치가
 * tier2_production.json 과 일치하는지 스스로 검증한다 — 다르면 매칭이
 * 어긋난 것이므로 결과를 쓰지 않고 실패한다.
 *
 * 1. 녹화 단위 부트스트랩 95% CI (B=10,000, 시드 고정)
 *    반복이 아니라 녹화가 독립 단위다 — 한 녹화의 반복들은 같은 사람·같은
 *    카메라·같은 습관을 공유한다 (dev/test 분리와 같은 원칙).
 * 2. Bland-Altman 합치도: bias, SD(diff), LoA = bias ± 1.96·SD
 *    전체 + 시상면/사면 층화. LoA 의 CI 도 녹화 부트스트랩.
 * 3. SRD (smallest real difference) = 1.96·√2·SD(diff)
 *    주의: test-retest 가 아니라 mocap 대비 오차 산포에서 유도한 값이다.
 *    원고에서 반드시 이 구분을 유지할 것 (scope_note 참조).
 * 4. per-rep 쌍을 CSV 로 보존 → Bland-Altman 그림과 재분석의 원천.
 *
 * Usage: node tier2_stats.cjs [--corpus <dir>] [--ref <dir>] [--B 10000]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

require('./harness_shim.js');
require('./kinetiq_core.generated.js');
require('./replay.js');
const shim = globalThis.KinetiQShim, Core = globalThis.KinetiQCore, Replay = globalThis.KinetiQReplay;

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const dir = path.resolve(arg('--corpus', path.join(os.homedir(), 'KinetiQ_datasets/REHAB24-6/tier2_corpus')));
const refd = path.resolve(arg('--ref', path.join(os.homedir(), 'KinetiQ_datasets/REHAB24-6/tier2_ref')));
const outDir = path.resolve(arg('--out', path.join(__dirname, '..', 'results')));
const B = parseInt(arg('--B', '10000'), 10);
const TOL = 0.75;
const FRAME_W = 1080, FRAME_H = 1920;
shim.setFrameSize(FRAME_W, FRAME_H);

const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
const sd = v => { const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); };
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;
const absA = v => v.map(Math.abs);

// 재현 가능한 부트스트랩: mulberry32 고정 시드
function mulberry32(seed) { return function () {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const SEED = 42;

function auc(pos, neg) {
  let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
}

// limb 선택 — tier2_prod_verify 와 **규칙이 다르다**. 여기는 세 랜드마크(hip/knee/ankle)
// 가시성의 전체 평균을 비교하고, tier2_prod_verify 는 네 랜드마크에 대한 프레임 단위
// 다수결을 쓴다. 아홉 녹화 모두 양쪽이 'left' 를 반환해 발표된 수치에는 영향이 없으나,
// 동일하다고 적어 두면 다음 사람이 한쪽만 고치게 된다.
function chosenSide(c) {
  let L = 0, R = 0, n = 0;
  for (const r of c.landmarks) { if (!r) continue;
    L += (r[23][3] + r[25][3] + r[27][3]) / 3; R += (r[24][3] + r[26][3] + r[28][3]) / 3; n++; }
  return { side: L / n >= R / n ? 'left' : 'right' };
}

// ── 재생 + per-rep 수집 (매칭 로직은 tier2_prod_verify 와 동일해야 한다) ──
const files = fs.readdirSync(dir).filter(f => f.endsWith('_corpus.json')).sort();
const perRec = {};   // rec -> { rows[], matched, ann, fp, good[], bad[] }
const allRows = [];

for (const f of files) {
  const rec = f.replace('_corpus.json', '');
  const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const ref = JSON.parse(fs.readFileSync(path.join(refd, `${rec}_ref.json`), 'utf8'));
  const cs = chosenSide(c);
  const frames = [];
  for (let i = 0; i < c.landmarks.length; i++) { const r = c.landmarks[i]; if (!r) continue;
    frames.push({ t: i / 30, landmarks: r.map(p => ({ x: p[0], y: p[1], z: p[2], visibility: p[3] })) }); }
  const out = Replay.replay(frames);
  const A = ref.annotated_repetitions.filter(a => !a.mocap_erroneous);
  const R = perRec[rec] = { rows: [], matched: 0, ann: A.length, fp: 0, good: [], bad: [] };
  const used = new Set();
  for (let ai = 0; ai < A.length; ai++) {
    const a = A[ai];
    const lo = a.first_frame / 30, hi = a.last_frame / 30 + TOL;
    const i = out.repEvents.findIndex((e, j) => !used.has(j) && e.atTime >= lo && e.atTime <= hi);
    if (i < 0) continue;
    used.add(i); R.matched++;
    const e = out.repEvents[i], seg = arr => arr.slice(a.first_frame, a.last_frame + 1);
    const refKnee = Math.min(...seg(ref.reference_2d[cs.side].knee));
    const refHip = Math.min(...seg(ref.reference_2d[cs.side].hip));
    const refTrunk = Math.max(...seg(ref.reference_2d[cs.side].trunk));
    const row = { rec, rep: ai + 1, view: a.cam18_sagittal ? 'sagittal' : 'oblique',
      correctness: a.correctness ? 1 : 0,
      app_knee: r2(e.knee), ref_knee: r2(refKnee), err_knee: r2(e.knee - refKnee),
      app_hip: r2(e.hip), ref_hip: r2(refHip), err_hip: r2(e.hip - refHip),
      app_trunk: r2(e.trunk), ref_trunk: r2(refTrunk), err_trunk: r2(e.trunk - refTrunk),
      score: e.score };
    R.rows.push(row); allRows.push(row);
    (a.correctness ? R.good : R.bad).push(e.score);
  }
  R.fp = out.repEvents.length - used.size;
}
const recs = Object.keys(perRec);

// ── 자기 검증: 점추정치가 게이트와 일치하는가 ──
const gate = JSON.parse(fs.readFileSync(path.join(outDir, 'tier2_production.json'), 'utf8'));
const kneeErrs = allRows.map(r => r.err_knee);
const myKneeMAE = r2(mean(absA(kneeErrs)));
const myMatched = recs.reduce((s, r) => s + perRec[r].matched, 0);
const myAnn = recs.reduce((s, r) => s + perRec[r].ann, 0);
if (Math.abs(myKneeMAE - gate.knee.mae) > 0.02 || myMatched !== gate.counting.matched) {
  console.error(`자기 검증 실패: knee MAE ${myKneeMAE} vs 게이트 ${gate.knee.mae}, matched ${myMatched} vs ${gate.counting.matched}`);
  console.error('매칭 로직이 tier2_prod_verify 와 어긋났다 — 결과를 쓰지 않는다.');
  process.exit(1);
}
console.log(`자기 검증 OK — knee MAE ${myKneeMAE}° / matched ${myMatched} 가 게이트와 일치\n`);

// ── 통계 유틸: 주어진 녹화 집합(중복 허용)에서 지표 계산 ──
function metrics(sample) {
  const rows = [], good = [], bad = [];
  let matched = 0, ann = 0, fp = 0;
  for (const r of sample) { const R = perRec[r];
    rows.push(...R.rows); good.push(...R.good); bad.push(...R.bad);
    matched += R.matched; ann += R.ann; fp += R.fp; }
  const by = k => rows.map(r => r[k]);
  const view = v => rows.filter(r => r.view === v).map(r => r.err_knee);
  const sagg = view('sagittal'), obl = view('oblique');
  return {
    knee_mae: mean(absA(by('err_knee'))), knee_bias: mean(by('err_knee')),
    hip_mae: mean(absA(by('err_hip'))), hip_bias: mean(by('err_hip')),
    trunk_mae: mean(absA(by('err_trunk'))), trunk_bias: mean(by('err_trunk')),
    sag_knee_mae: sagg.length ? mean(absA(sagg)) : NaN,
    obl_knee_mae: obl.length ? mean(absA(obl)) : NaN,
    recall: matched / ann, precision: matched / (matched + fp),
    auc: (good.length && bad.length) ? auc(good, bad) : NaN,
  };
}

// ── 부트스트랩 (녹화 단위, B회) ──
const rng = mulberry32(SEED);
const keys = Object.keys(metrics(recs));
const dist = Object.fromEntries(keys.map(k => [k, []]));
for (let b = 0; b < B; b++) {
  const sample = Array.from({ length: recs.length }, () => recs[Math.floor(rng() * recs.length)]);
  const m = metrics(sample);
  for (const k of keys) if (!Number.isNaN(m[k])) dist[k].push(m[k]);
}
const point = metrics(recs);
const ci = k => { const v = dist[k].slice().sort((a, b) => a - b);
  return { lo: r3(v[Math.floor(v.length * 0.025)]), hi: r3(v[Math.floor(v.length * 0.975)]), n_boot: v.length }; };


// ── ICC(2,1): 2원 확률효과, 절대일치, 단일 측정 (Shrout & Fleiss 1979) ──
// Table V 의 비교 대상 세 행이 ICC(2,1) 로 특성화돼 있는데 본 연구만 없어서
// 같은 잣대로 읽히지 않는다. 앱과 기준을 두 '평가자'로 놓고 반복을 행으로 둔다.
// 주의: 비교 문헌들과 동일하게 반복 단위로 pool 하므로 녹화 내 군집을 무시한다.
// 군집을 반영한 불확실성은 위 recording-level 부트스트랩이 담당한다.
function icc21(pairs) {
  const n = pairs.length, k = 2;
  if (n < 3) return null;
  const gm = mean(pairs.flat());
  const rowM = pairs.map(p => (p[0] + p[1]) / 2);
  const colM = [mean(pairs.map(p => p[0])), mean(pairs.map(p => p[1]))];
  const MSR = k * rowM.reduce((s, m) => s + (m - gm) ** 2, 0) / (n - 1);
  const MSC = n * colM.reduce((s, m) => s + (m - gm) ** 2, 0) / (k - 1);
  let ss = 0;
  pairs.forEach((p, i) => p.forEach((y, j) => { ss += (y - rowM[i] - colM[j] + gm) ** 2; }));
  const MSE = ss / ((n - 1) * (k - 1));
  return r3((MSR - MSE) / (MSR + (k - 1) * MSE + (k * (MSC - MSE)) / n));
}
// ── Bland-Altman + SRD (전체 / 시상면 / 사면, 무릎·고관절) ──
function blandAltman(rows, errKey) {
  const d = rows.map(r => r[errKey]);
  const bias = mean(d), s = sd(d);
  return { n: d.length, bias: r2(bias), sd_diff: r2(s),
    loa_lower: r2(bias - 1.96 * s), loa_upper: r2(bias + 1.96 * s),
    srd: r2(1.96 * Math.SQRT2 * s) };
}
function baBoot(filter, errKey) {
  const rng2 = mulberry32(SEED + 1);
  const biases = [], los = [], his = [];
  for (let b = 0; b < B; b++) {
    const sample = Array.from({ length: recs.length }, () => recs[Math.floor(rng2() * recs.length)]);
    const rows = sample.flatMap(r => perRec[r].rows).filter(filter);
    if (rows.length < 5) continue;
    const ba = blandAltman(rows, errKey);
    biases.push(ba.bias); los.push(ba.loa_lower); his.push(ba.loa_upper);
  }
  const q = (v, p) => { const s2 = v.slice().sort((a, b) => a - b); return r2(s2[Math.floor(s2.length * p)]); };
  return { bias_ci: [q(biases, 0.025), q(biases, 0.975)],
    loa_lower_ci: [q(los, 0.025), q(los, 0.975)], loa_upper_ci: [q(his, 0.025), q(his, 0.975)] };
}
const strata = [
  ['all', () => true], ['sagittal', r => r.view === 'sagittal'], ['oblique', r => r.view === 'oblique'],
];
const iccKnee = {};
for (const [name, f] of strata) {
  const rows = recs.flatMap(r => perRec[r].rows).filter(f);
  iccKnee[name] = { n: rows.length, icc21: icc21(rows.map(r => [r.app_knee, r.ref_knee])) };
}

const ba = {};
for (const [name, f] of strata) {
  ba[name] = {
    knee: { ...blandAltman(allRows.filter(f), 'err_knee'), ...baBoot(f, 'err_knee') },
    hip: { ...blandAltman(allRows.filter(f), 'err_hip'), ...baBoot(f, 'err_hip') },
  };
}

// ── 출력 ──
console.log(`Tier 2 통계 보강 — ${Core.KINETIQ_PROVENANCE.engine_version}, 부트스트랩 B=${B} (녹화 단위, 시드 ${SEED})`);
console.log('='.repeat(78));
console.log('지표                    점추정      95% CI');
for (const [label, k, fmt] of [
  ['무릎 MAE (°)', 'knee_mae', r2], ['무릎 bias (°)', 'knee_bias', r2],
  ['고관절 MAE (°)', 'hip_mae', r2], ['몸통 MAE (°)', 'trunk_mae', r2],
  ['시상면 무릎 MAE (°)', 'sag_knee_mae', r2], ['사면 무릎 MAE (°)', 'obl_knee_mae', r2],
  ['카운팅 recall', 'recall', r3], ['카운팅 precision', 'precision', r3], ['점수 AUC', 'auc', r3],
]) {
  const c = ci(k);
  console.log(`  ${label.padEnd(20)} ${String(fmt(point[k])).padStart(8)}   [${c.lo}, ${c.hi}]`);
}
console.log('\nBland-Altman (앱 − mocap 기준, 무릎)');
for (const [name] of strata) {
  const k = ba[name].knee;
  console.log(`  ${name.padEnd(9)} n=${String(k.n).padStart(3)}  bias ${k.bias}° [${k.bias_ci}]  LoA [${k.loa_lower}, ${k.loa_upper}]°  SRD ${k.srd}°`);
}

// ── 저장 ──
fs.writeFileSync(path.join(outDir, 'tier2_stats.json'), JSON.stringify({
  experiment: 'Tier 2 statistical strengthening: recording-level bootstrap CIs, Bland-Altman agreement, SRD',
  generated: new Date().toISOString(),
  engine_version: Core.KINETIQ_PROVENANCE.engine_version,
  bootstrap: { B, unit: 'recording', seed: SEED, n_recordings: recs.length, n_matched_reps: allRows.length },
  point_estimates_verified_against: 'tier2_production.json',
  estimates: Object.fromEntries(keys.map(k => [k, { point: r3(point[k]), ci95: ci(k) }])),
  bland_altman: ba,
  icc_knee: iccKnee,
  icc_note: 'ICC(2,1) two-way random effects, absolute agreement, single measurement (Shrout & Fleiss). '
    + 'Application and reference are the two raters, repetitions the rows. Pooled per repetition as the '
    + 'Table V comparators do, so within-recording clustering is ignored here; the recording-level '
    + 'bootstrap above carries the clustered uncertainty.',
  scope_note: 'SRD is derived from the dispersion of error against mocap-derived reference angles, '
    + 'NOT from test-retest repeated measurement; it bounds detectable change under this error model only. '
    + 'One dataset, one camera geometry. Not a clinical validation study.',
}, null, 2));

const cols = Object.keys(allRows[0]);
fs.writeFileSync(path.join(outDir, 'tier2_per_rep.csv'),
  cols.join(',') + '\n' + allRows.map(r => cols.map(c => r[c]).join(',')).join('\n'));
console.log(`\nwritten: results/tier2_stats.json + tier2_per_rep.csv (${allRows.length} reps)`);
