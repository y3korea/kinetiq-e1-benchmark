#!/usr/bin/env node
/**
 * device_bench_analyze.cjs — 기기별 벤치마크 JSON 집계 → 논문 "기기 일반화" 표
 * ============================================================================
 *
 * 입력: 이 디렉터리의 devicebench_*.json (squat-app/devicebench.html 이 내보낸 것)
 * 출력: 콘솔 표 + device_bench_summary.{json,csv}
 *
 * fps → 깊이 저평가 추정
 * ----------------------
 * Tier 0 의 T0.2 방법을 그대로 임의 fps 에서 재계산한다: 합성 무릎 궤적
 * (170°→85°→170°, 하강 descent_s)을 해당 fps 로 샘플링해 배포 코드의
 * EMA(smooth, α=0.3/프레임)에 통과시키고, 참값 최저점 85° 와의 차이를 읽는다.
 * 보간이 아니라 재계산이므로 앵커가 필요 없다. smooth 는 추출 코어에서
 * 가져온다 — 재구현이 아니라 배포 코드 그대로다.
 *
 * Usage:  node device_bench_analyze.cjs [--dir <jsons>] [--descent 1.5]
 */
'use strict';
const fs = require('fs');
const path = require('path');

require('../harness/harness_shim.js');
require('../harness/kinetiq_core.generated.js');
// 하니스 관례: 전역 표면으로 소비한다 (tier2_prod_verify 와 동일)
const Shim = globalThis.KinetiQShim, Core = globalThis.KinetiQCore;
Shim.install();   // globalThis.APP 생성 (smooth 가 참조)

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const dir = path.resolve(arg('--dir', __dirname));
const DESCENT_S = parseFloat(arg('--descent', '1.5'));   // 성인 통제 스쿼트의 전형값

// ── T0.2 재계산: 주어진 fps 에서 EMA 깊이 저평가 ──
function emaDepthBias(fps, descentS = DESCENT_S) {
  const TOP = 170, BOTTOM = 85, holdS = 0.2;
  const dt = 1 / fps;
  // 합성 궤적: 코사인 하강 → 짧은 유지 → 코사인 상승 (T0 과 동일한 형태)
  const kneeAt = t => {
    if (t < descentS) return TOP - (TOP - BOTTOM) * (1 - Math.cos(Math.PI * t / descentS)) / 2;
    if (t < descentS + holdS) return BOTTOM;
    const u = (t - descentS - holdS) / descentS;
    if (u >= 1) return TOP;
    return BOTTOM + (TOP - BOTTOM) * (1 - Math.cos(Math.PI * u)) / 2;
  };
  // 배포 코드의 smooth() 를 그대로: APP.smoothAngles 를 초기화하고 프레임마다 호출
  APP.smoothAngles = { knee: TOP, hip: 0, trunk: 0, ankle: 0 };
  let minSeen = TOP;
  const total = 2 * descentS + holdS;
  for (let t = 0; t <= total; t += dt) {
    const v = Core.smooth('knee', kneeAt(t));
    if (v < minSeen) minSeen = v;
  }
  return minSeen - BOTTOM;   // 양수 = 깊이 저평가 (덜 내려간 것으로 측정)
}

// ── JSON 수집 ──
const files = fs.readdirSync(dir).filter(f => /^devicebench_.*\.json$/.test(f)).sort();
if (!files.length) {
  console.log(`devicebench_*.json 이 없습니다: ${dir}`);
  console.log('각 기기에서 https://wansukchoi-kbu-squat.vercel.app/devicebench.html 을 실행해');
  console.log('내보낸 JSON 을 이 디렉터리에 넣은 뒤 다시 실행하세요.');
  process.exit(0);
}

const rows = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const cam = d.camera || {};
  // DB-1.1: 감지율 기반 유효성. 무효 런(전신 미감지)은 카메라 지표를 신뢰할 수 없다.
  if (cam.valid === false || (cam.trackLossPct != null && cam.trackLossPct > 30 && cam.valid === undefined)) {
    console.log(`  [제외] ${f} — 카메라 런 무효 (감지율 부족: 손실 ${cam.trackLossPct}%). 재측정 필요`);
    continue;
  }
  const fpsMed = cam.fpsMedian || null, fpsP10 = cam.fpsP10 || null;
  const anchors = (d.pitch && d.pitch.anchors) || [];
  const pitchErrs = anchors.filter(a => a.error != null).map(a => a.error);
  rows.push({
    file: f,
    device: d.device_label || '(라벨 없음)',
    inApp: (d.env && d.env.inApp) || null,
    wasmSimd: !!(d.env && d.env.wasmSimd),
    res: cam.res ? `${cam.res.w}x${cam.res.h}` : null,
    fpsMedian: fpsMed, fpsP10,
    depthBiasAtMedian: fpsMed ? +emaDepthBias(fpsMed).toFixed(2) : null,
    depthBiasAtP10: fpsP10 ? +emaDepthBias(fpsP10).toFixed(2) : null,
    trackLossPct: cam.trackLossPct ?? null,
    visibility: cam.visibilityMean ?? null,
    stillJitterSd: cam.stillKneeJitterSd ?? null,
    pitchMaxAbsErr: pitchErrs.length ? +Math.max(...pitchErrs.map(Math.abs)).toFixed(2) : null,
    ttsKo: d.tts ? (d.tts.koVoices ? d.tts.koVoices.length : null) : null,
    ttsHeard: d.tts ? (d.tts.heard ?? null) : null,
    storageWrite: d.storage ? d.storage.write : null,
    generated: d.generated,
  });
}

// ── 출력 ──
const eng = Core.KINETIQ_PROVENANCE.engine_version;
console.log(`기기 일반화 집계 — smooth() 는 ${eng} 추출 코어, 하강 ${DESCENT_S}s 가정`);
console.log('='.repeat(100));
const pad = (s, n) => String(s ?? '-').padEnd(n);
console.log(pad('기기', 26) + pad('fps중앙/느린10%', 16) + pad('깊이편향(중앙/저속)', 20) + pad('지터sd', 8) + pad('pitch|err|max', 14) + pad('TTS', 6) + '인앱');
for (const r of rows) {
  console.log(
    pad(r.device.slice(0, 24), 26) +
    pad(`${r.fpsMedian ?? '-'} / ${r.fpsP10 ?? '-'}`, 16) +
    pad(`${r.depthBiasAtMedian ?? '-'}° / ${r.depthBiasAtP10 ?? '-'}°`, 20) +
    pad(r.stillJitterSd != null ? r.stillJitterSd + '°' : '-', 8) +
    pad(r.pitchMaxAbsErr != null ? r.pitchMaxAbsErr + '°' : '-', 14) +
    pad(r.ttsHeard === true ? '✓' : r.ttsHeard === false ? '✗' : '-', 6) +
    (r.inApp || '-'));
}
console.log('='.repeat(100));
console.log('깊이편향 = 해당 fps 에서 EMA 필터가 스쿼트 깊이를 저평가하는 각도 (T0.2 방법 재계산).');
console.log('참고 곡선: ' + [30, 24, 15, 10, 6].map(f => `${f}fps→${emaDepthBias(f).toFixed(2)}°`).join('  '));

fs.writeFileSync(path.join(dir, 'device_bench_summary.json'), JSON.stringify({
  experiment: 'device generalization — per-device fps/sensor/TTS/storage with EMA depth-bias projection',
  generated: new Date().toISOString(),
  engine_version: eng,
  descent_s_assumed: DESCENT_S,
  reference_curve: Object.fromEntries([30, 24, 15, 10, 6].map(f => [f, +emaDepthBias(f).toFixed(3)])),
  devices: rows,
}, null, 2));
const cols = Object.keys(rows[0]);
fs.writeFileSync(path.join(dir, 'device_bench_summary.csv'),
  cols.join(',') + '\n' + rows.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(',')).join('\n'));
console.log(`\nwritten: device_bench_summary.json + .csv  (${rows.length} 기기)`);
