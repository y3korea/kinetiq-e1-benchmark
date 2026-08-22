#!/usr/bin/env node
/**
 * uiprmd_run.cjs — UI-PRMD 딥스쿼트 스트림을 배포 체인(원문 추출)으로 재생
 * ======================================================================
 *
 * 외적 타당도 검증: REHAB24-6 에서 확정한 오차 프로파일이 다른 피험자·다른
 * 실험실·다른 모캡(Vicon)·다른 동작 패턴(딥스쿼트)에서 재현되는가.
 *
 * 계층: T1.5 (랜드마크 주입, 인지 우회) — UI-PRMD 는 RGB 영상을 공개하지
 * 않으므로 MediaPipe 인지 오차는 이 결과에 포함되지 않는다. 이 숫자는
 * "측정 체인 + 투영 기하"의 숫자다. 원고에서 반드시 이 범위를 지킬 것.
 *
 * 지표:
 *   - 무릎 최저각 오차 vs 3D 해부학각 (모노큘러 하한 포함) — REHAB yaw0 의 2.41° 와 대조
 *   - 무릎 최저각 오차 vs 2D 투영각 (FSM/EMA 만 분리)
 *   - Bland–Altman (bias · LoA · SRD), 3D/2D 기준 각각 — Tier 2 의 tier2_stats 와 같은 정의
 *   - 카운팅 recall/precision (세그먼트당 정확히 1회 기대) + 깊이 게이트 조건부 recall
 *   - repScore 의 correct/incorrect 판별 AUC (데이터셋 라벨) + 구성개념 대조 (STANDARDS 무릎 범위)
 *   - 피험자 단위 부트스트랩 95% CI (n=10, B=10,000, 시드 고정)
 *   - 피험자별 분해: 체인 항(2D 기준 bias) 과 투영 항(2D−3D 기준각)
 *   - REHAB24-6 T1.5 의 동일 정의(3D 기준) 대조값을 tier15_matched.csv 에서 같이 계산
 *
 * Usage: node uiprmd_run.cjs [--in ~/KinetiQ_datasets/UI-PRMD/streams] [--out ../results] [--B 10000]
 *        REHAB24-6 대조값은 --out 과 무관하게 ../results/tier15_matched.csv 에서 읽는다 (없으면 경고).
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
const inDir = path.resolve(arg('--in', path.join(os.homedir(), 'KinetiQ_datasets/UI-PRMD/streams')));
const outDir = path.resolve(arg('--out', path.join(__dirname, '..', 'results')));
const B = parseInt(arg('--B', '10000'), 10);
const TOL = 0.75;

const manifest = JSON.parse(fs.readFileSync(path.join(inDir, 'manifest.json'), 'utf8'));
shim.setFrameSize(1280, 960);   // 투영 기하와 동일 (yaw_sweep 과 같은 production geometry)

// 깊이 게이트 — detectPhase 가 bodyweight 프로파일에서 도출하는 식 그대로: min(knee.max+35, 145)
const STD = (Core.STANDARDS && Core.STANDARDS.bodyweight) || { knee: [80, 100] };
const GATE = Math.min(STD.knee[1] + 35, 145);

const mean = v => v.reduce((a, b) => a + b, 0) / v.length;
const sd = v => { const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); };
const median = v => { const s = v.slice().sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;
const absA = v => v.map(Math.abs);
function mulberry32(seed) { return function () {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function auc(pos, neg) { let w = 0; for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0; return w / (pos.length * neg.length); }
const ba = v => { const b = mean(v), s = sd(v); return { n: v.length, bias: b, sd: s, lo: b - 1.96 * s, hi: b + 1.96 * s, srd: 1.96 * Math.SQRT2 * s, mae: mean(absA(v)) }; };

// ── 재생 ──
const perSubj = {};   // subj -> { rows[], eps[], matched, ann, fp, scores:{correct[], incorrect[]} }
const rows = [], unmatched = [];
for (const name of manifest.streams) {
  const d = JSON.parse(fs.readFileSync(path.join(inDir, `${name}.json`), 'utf8'));
  const S = perSubj[d.subject] = perSubj[d.subject] || { rows: [], eps: [], matched: 0, ann: 0, fp: 0, scores: { correct: [], incorrect: [] } };
  shim.reset();
  const frames = d.landmarks.map((lm, i) => ({ t: i / d.fps, landmarks: lm }));
  const out = Replay.replay(frames);
  const used = new Set();
  S.ann += d.episodes.length;
  for (const ep of d.episodes) {
    const i = out.repEvents.findIndex((e, j) => !used.has(j) && e.atTime >= ep.t0 && e.atTime <= ep.t1 + TOL);
    const rec = { subject: d.subject, label: d.label, file: ep.file, gt2d: ep.gt2d_min_knee_left, gt3d: ep.gt3d_min_knee.left, matched: i >= 0, hold_frame: ep.hold_frame || 'last' };
    S.eps.push(rec);
    if (i < 0) { unmatched.push(rec); continue; }
    used.add(i); S.matched++;
    const e = out.repEvents[i];
    const row = { subject: d.subject, label: d.label, file: ep.file,
      app_knee: r2(e.knee), gt3d_knee: ep.gt3d_min_knee.left, gt2d_knee: ep.gt2d_min_knee_left,
      err3d: r2(e.knee - ep.gt3d_min_knee.left), err2d: r2(e.knee - ep.gt2d_min_knee_left),
      floor: r2(ep.gt2d_min_knee_left - ep.gt3d_min_knee.left),
      app_hip: r2(e.hip), gt3d_hip: ep.gt3d_min_hip.left, err3d_hip: r2(e.hip - ep.gt3d_min_hip.left),
      score: e.score, hold_frame: ep.hold_frame || 'last' };
    S.rows.push(row); rows.push(row);
    S.scores[d.label].push(e.score);
  }
  S.fp += out.repEvents.length - used.size;
}
const subjects = Object.keys(perSubj);

// ── 지표 (피험자 집합 → 풀링) ──
function metrics(sample) {
  const R = [], E = [], pos = [], neg = []; let m = 0, a = 0, fp = 0;
  for (const s of sample) { const S = perSubj[s]; R.push(...S.rows); E.push(...S.eps); pos.push(...S.scores.correct); neg.push(...S.scores.incorrect); m += S.matched; a += S.ann; fp += S.fp; }
  const by = k => R.map(r => r[k]);
  const cor = R.filter(r => r.label === 'correct'), inc = R.filter(r => r.label === 'incorrect');
  const b3 = ba(by('err3d')), b2 = ba(by('err2d')), bh = ba(by('err3d_hip'));
  const below = E.filter(e => e.gt2d < GATE), belowM = below.filter(e => e.matched).length;
  return {
    knee_mae_3d: b3.mae, knee_bias_3d: b3.bias, knee_sd_3d: b3.sd, knee_loa_lo_3d: b3.lo, knee_loa_hi_3d: b3.hi, knee_srd_3d: b3.srd,
    knee_mae_2d: b2.mae, knee_bias_2d: b2.bias, knee_sd_2d: b2.sd, knee_loa_lo_2d: b2.lo, knee_loa_hi_2d: b2.hi, knee_srd_2d: b2.srd,
    hip_mae_3d: bh.mae, hip_bias_3d: bh.bias, hip_sd_3d: bh.sd, hip_loa_lo_3d: bh.lo, hip_loa_hi_3d: bh.hi, hip_srd_3d: bh.srd,
    knee_mae_3d_correct: cor.length ? mean(absA(cor.map(r => r.err3d))) : NaN,
    knee_mae_3d_incorrect: inc.length ? mean(absA(inc.map(r => r.err3d))) : NaN,
    recall: m / a, precision: m / (m + fp),
    recall_below_gate: below.length ? belowM / below.length : NaN,
    auc: (pos.length && neg.length) ? auc(pos, neg) : NaN,
  };
}
const point = metrics(subjects);
const keys = Object.keys(point), dist = Object.fromEntries(keys.map(k => [k, []]));
const rng = mulberry32(42);
for (let b = 0; b < B; b++) {
  const sample = Array.from({ length: subjects.length }, () => subjects[Math.floor(rng() * subjects.length)]);
  const m = metrics(sample); for (const k of keys) if (!Number.isNaN(m[k])) dist[k].push(m[k]);
}
const ci = k => { const v = dist[k].slice().sort((a, b) => a - b); return [r3(v[Math.floor(v.length * 0.025)]), r3(v[Math.floor(v.length * 0.975)])]; };

// ── 하니스 sanity: 투영 하한 (3D 대 2D 기준의 차이는 체인과 무관한 기하) ──
const floor = rows.map(r => r.floor);
const pearson = (a, b) => { const ma = mean(a), mb = mean(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return sab / Math.sqrt(saa * sbb); };
const floorDepthCorr = pearson(floor, rows.map(r => r.gt3d_knee));

// ── 게이트 조건부 카운팅 ──
const allEps = subjects.flatMap(s => perSubj[s].eps);
const below = allEps.filter(e => e.gt2d < GATE), above = allEps.filter(e => e.gt2d >= GATE);
const totAnn = allEps.length, totM = rows.length, totFP = subjects.reduce((s, k) => s + perSubj[k].fp, 0);
const excluded = manifest.excluded || [];

// ── 점수 구성개념 대조 ──
const cor = rows.filter(r => r.label === 'correct'), inc = rows.filter(r => r.label === 'incorrect');
const scoreConstruct = {
  standards_knee_range_deg: STD.knee, note: 'repScore rewards a bottom knee angle inside STANDARDS (parallel-depth norm); UI-PRMD "correct" deep squats are deeper than that range, so the label and the score answer different questions',
  correct: { n: cor.length, gt3d_knee_median: r2(median(cor.map(r => r.gt3d_knee))), score_mean: r2(mean(cor.map(r => r.score))) },
  incorrect: { n: inc.length, gt3d_knee_median: r2(median(inc.map(r => r.gt3d_knee))), score_mean: r2(mean(inc.map(r => r.score))) },
};

// ── REHAB24-6 T1.5 대조 (같은 정의: app − 3D 해부학각, tier15_matched.csv) ──
let rehabRef = null;
const RESULTS = path.join(__dirname, '..', 'results');   // 대조값은 정본 results/ 에서 — --out 과 무관
const t15 = path.join(RESULTS, 'tier15_matched.csv');
if (!fs.existsSync(t15)) console.warn(`경고: ${t15} 없음 — rehab24_6_t15_reference 를 null 로 기록한다 (figure 5 스크립트가 이 블록을 요구함)`);
if (fs.existsSync(t15)) {
  const L = fs.readFileSync(t15, 'utf8').trim().split('\n'); const H = L[0].split(',');
  const col = n => H.indexOf(n);
  const recs = L.slice(1).map(l => l.split(','));
  const d3 = recs.map(r => +r[col('app_knee')] - +r[col('ref_min_knee_3d')]);
  const d2 = recs.map(r => +r[col('knee_err')]);
  const fl = recs.map(r => +r[col('ref_min_knee_2d')] - +r[col('ref_min_knee_3d')]);
  const f3 = ba(d3), f2 = ba(d2);
  rehabRef = { source: 'tier15_matched.csv (REHAB24-6 Ex6, OptiTrack, E1 T1.5 export: rehab24_6.project_to_sagittal + isotropic normalised landmarks, frame geometry not applied; engine ' + Core.KINETIQ_PROVENANCE.engine_version + ')',
    method_note: 'Different projection code from the yaw sweep that UI-PRMD uses; the sweep reproduces this tier at yaw 0° (knee MAE 2.41° vs 2.42°, bias 1.91° vs 1.92°, identical recall/precision/AUC), see rehab24_6_yaw0_reference.',
    knee_vs_3d: { n: f3.n, mae: r2(f3.mae), bias: r2(f3.bias), sd: r2(f3.sd), loa_lower: r2(f3.lo), loa_upper: r2(f3.hi), srd: r2(f3.srd) },
    knee_vs_2d: { n: f2.n, mae: r2(f2.mae), bias: r2(f2.bias), sd: r2(f2.sd), loa_lower: r2(f2.lo), loa_upper: r2(f2.hi), srd: r2(f2.srd) },
    projection_floor_deg: { median: r2(median(fl)), mean: r2(mean(fl)) } };
}

// ── 출력 ──
const eng = Core.KINETIQ_PROVENANCE.engine_version;
console.log(`UI-PRMD 딥스쿼트 — 배포 체인 ${eng} (T1.5: 랜드마크 주입, 인지 우회)`);
console.log(`${subjects.length} 피험자 · ${rows.length} 반복 매칭 / ${totAnn} 에피소드 (파일 ${manifest.files_total || '?'}개 중 ${excluded.length}개 배제) · FP ${totFP} · 부트스트랩 B=${B} (피험자 단위) · 깊이 게이트 ${GATE}°`);
console.log('='.repeat(78));
const line = (label, k, fmt) => console.log(`  ${label.padEnd(36)} ${String(fmt(point[k])).padStart(7)}   [${ci(k).join(', ')}]`);
line('무릎 MAE vs 3D 해부학각 (°)', 'knee_mae_3d', r2);
line('무릎 bias vs 3D (°)', 'knee_bias_3d', r2);
line('무릎 LoA 하한 vs 3D (°)', 'knee_loa_lo_3d', r2);
line('무릎 LoA 상한 vs 3D (°)', 'knee_loa_hi_3d', r2);
line('무릎 SRD vs 3D (°)', 'knee_srd_3d', r2);
line('무릎 MAE vs 2D 투영각 (°)', 'knee_mae_2d', r2);
line('무릎 bias vs 2D (°)', 'knee_bias_2d', r2);
line('무릎 LoA vs 2D 하한/상한 (°)', 'knee_loa_lo_2d', r2); line('', 'knee_loa_hi_2d', r2);
line('고관절 MAE vs 3D (°)', 'hip_mae_3d', r2);
line('고관절 bias vs 3D (°)', 'hip_bias_3d', r2);
line('무릎 MAE 3D — correct 만', 'knee_mae_3d_correct', r2);
line('무릎 MAE 3D — incorrect 만', 'knee_mae_3d_incorrect', r2);
line('카운팅 recall (전체)', 'recall', r3);
line(`카운팅 recall (게이트 ${GATE}° 이하 세그먼트)`, 'recall_below_gate', r3);
line('카운팅 precision', 'precision', r3);
line('repScore AUC (correct vs incorrect)', 'auc', r3);
console.log(`\n  투영 하한 (2D−3D 기준각, 체인 무관): 중앙 ${r2(median(floor))}°  평균 ${r2(mean(floor))}°  깊이(GT3D 무릎)와의 Pearson r ${r3(floorDepthCorr)}`);
console.log(`  게이트 위(2D 최저 무릎 ≥ ${GATE}°) 세그먼트 ${above.length}개 — 매칭 ${above.filter(e => e.matched).length}개: ${above.map(e => `${e.file}(${e.gt2d})`).join(', ')}`);
console.log(`  점수 구성개념: correct GT3D 무릎 중앙 ${scoreConstruct.correct.gt3d_knee_median}° (score ${scoreConstruct.correct.score_mean}) vs incorrect ${scoreConstruct.incorrect.gt3d_knee_median}° (score ${scoreConstruct.incorrect.score_mean}); STANDARDS 무릎 [${STD.knee}]`);
if (rehabRef) console.log(`  대조 — REHAB24-6 T1.5 내보내기 (같은 정의, 다른 투영 코드): 무릎 MAE vs 3D ${rehabRef.knee_vs_3d.mae}°, bias ${rehabRef.knee_vs_3d.bias}°, LoA [${rehabRef.knee_vs_3d.loa_lower}, ${rehabRef.knee_vs_3d.loa_upper}], SRD ${rehabRef.knee_vs_3d.srd}°; vs 2D MAE ${rehabRef.knee_vs_2d.mae}°; 투영 하한 중앙 ${rehabRef.projection_floor_deg.median}°`);
console.log(`  대조 — REHAB24-6 yaw 0° 스윕 (UI-PRMD 와 같은 투영 코드): 무릎 MAE vs 3D 2.41°, bias 1.91°, 고관절 3.25°, recall 0.979, AUC 0.716`);
console.log('\n피험자별 (체인 항 = 2D 기준 bias, 투영 항 = 2D−3D 기준각):');
const perSubject = {};
for (const s of subjects) {
  const S = perSubj[s]; const e3 = S.rows.map(r => r.err3d), e2 = S.rows.map(r => r.err2d), fl = S.rows.map(r => r.floor);
  perSubject[s] = { matched: S.matched, ann: S.ann, fp: S.fp, knee_mae_3d: r2(mean(absA(e3))), bias_3d: r2(mean(e3)), chain_bias_2d: r2(mean(e2)), projection_floor: r2(mean(fl)),
    score_correct: S.scores.correct.length ? r2(mean(S.scores.correct)) : null, score_incorrect: S.scores.incorrect.length ? r2(mean(S.scores.incorrect)) : null };
  const p = perSubject[s];
  console.log(`  s${String(s).padStart(2, '0')}  매칭 ${S.matched}/${S.ann}  FP ${S.fp}  무릎 MAE3D ${p.knee_mae_3d}°  bias3D ${p.bias_3d}° = 체인 ${p.chain_bias_2d}° + 투영 ${p.projection_floor}°  score correct ${p.score_correct ?? '-'} / incorrect ${p.score_incorrect ?? '-'}`);
}
if (unmatched.length) { console.log('\n미매칭 세그먼트:'); for (const u of unmatched) console.log(`  s${String(u.subject).padStart(2, '0')} ${u.label} ${u.file}  2D 최저 무릎 ${u.gt2d}°  3D ${u.gt3d}°  ${u.gt2d >= GATE ? '(게이트 위)' : ''}`); }

const est = Object.fromEntries(keys.map(k => [k, { point: r3(point[k]), ci95: ci(k) }]));
const baOut = (pre, lab) => ({ n: rows.length, mae: r2(point[pre + 'mae' + lab]), bias: r2(point[pre + 'bias' + lab]), sd: r2(point[pre + 'sd' + lab]), loa_lower: r2(point[pre + 'loa_lo' + lab]), loa_upper: r2(point[pre + 'loa_hi' + lab]), srd: r2(point[pre + 'srd' + lab]),
  bias_ci: ci(pre + 'bias' + lab), loa_lower_ci: ci(pre + 'loa_lo' + lab), loa_upper_ci: ci(pre + 'loa_hi' + lab) });
fs.writeFileSync(path.join(outDir, 'uiprmd_report.json'), JSON.stringify({
  experiment: 'External validity — UI-PRMD deep squat (Vicon) through the deployed chain, landmark-interface injection (T1.5)',
  generated: new Date().toISOString(),
  engine_version: eng,
  source_sha256: Core.KINETIQ_PROVENANCE.source_sha256,
  dataset: { name: 'UI-PRMD', movement: 'm01 deep squat', source: 'Vicon markers (39), 100 Hz → 30 fps', subjects: subjects.length, files_total: manifest.files_total || (totAnn + excluded.length), episodes_scored: totAnn,
    exclusion_rules: manifest.exclusion_rules || null,
    excluded_files: excluded,
    exclusion_note: 'Exclusion is decided from the reference trajectory alone (3-D knee angle), never from application output. The raw trajectory of the excluded pair shows two full repetitions (minima 113° and 105°, separated by ~1.3 s above 150° with a 171° peak) that the dataset segmentation split across the two files — one file holds only a descent, the next an ascent plus a complete second repetition; the deployed chain detected both.',
    labels: 'correct / incorrect as performed by the subjects (healthy volunteers simulating incorrect execution)', license: 'ODC Public Domain Dedication and License v1.0 (as stated by the dataset authors)',
    citation: 'A. Vakanski, H.-P. Jun, D. Paul, R. Baker, "A data set of human body movements for physical rehabilitation exercises," Data, vol. 3, no. 1, 2, 2018, doi:10.3390/data3010002' },
  injection: { tier: 'T1.5', projection: 'yaw 0 sagittal, yaw_sweep machinery', frame: '1280x960', near_side: 'left',
    holds: '1.2 s standing holds between episodes; lead-in = first episode standing frame; hold frame = last frame (guard: first frame if the last is not standing — applies to no scored file)',
    hip_centre: 'ASI/PSI midpoint per side' },
  bootstrap: { B, unit: 'subject', seed: 42 },
  depth_gate_deg: GATE,
  n_matched_reps: rows.length,
  counting: { annotated: totAnn, matched: totM, false_positives: totFP, recall: r3(totM / totAnn), precision: r3(totM / (totM + totFP)),
    below_gate: { n: below.length, matched: below.filter(e => e.matched).length, recall: r3(below.filter(e => e.matched).length / below.length) },
    above_gate: { n: above.length, matched: above.filter(e => e.matched).length, segments: above.map(e => ({ file: e.file, gt2d_min_knee: e.gt2d, gt3d_min_knee: e.gt3d })) } },
  estimates: est,
  bland_altman: { knee_vs_3d: baOut('knee_', '_3d'), knee_vs_2d: baOut('knee_', '_2d'), hip_vs_3d: baOut('hip_', '_3d') },
  projection_floor_deg: { median: r2(median(floor)), mean: r2(mean(floor)), pearson_r_vs_gt3d_knee: r3(floorDepthCorr), note: 'weak positive: deeper reps carry slightly more out-of-plane projection term' },
  score_construct: scoreConstruct,
  rehab24_6_yaw0_reference: { knee_mae_3d: 2.41, recall: 0.979, auc: 0.716 },
  rehab24_6_t15_reference: rehabRef,
  per_subject: perSubject,
  unmatched_segments: unmatched.map(u => ({ subject: u.subject, label: u.label, file: u.file, gt2d_min_knee: u.gt2d, gt3d_min_knee: u.gt3d, above_gate: u.gt2d >= GATE })),
  scope_note: 'Landmark injection from Vicon markers; MediaPipe perception bypassed. Measures the measurement chain and '
    + 'projection geometry on an independent cohort, not end-to-end accuracy. Hip centres approximated as ASI/PSI midpoints. '
    + 'Score AUC compares a parallel-depth scoring norm against a deep-squat correctness label (construct mismatch); it is reported, not claimed.',
}, null, 2));
const cols = Object.keys(rows[0]);
fs.writeFileSync(path.join(outDir, 'uiprmd_per_rep.csv'), cols.join(',') + '\n' + rows.map(r => cols.map(c => r[c]).join(',')).join('\n'));
console.log(`\nwritten: ${path.relative(process.cwd(), path.join(outDir, 'uiprmd_report.json'))} + ${path.relative(process.cwd(), path.join(outDir, 'uiprmd_per_rep.csv'))}`);
