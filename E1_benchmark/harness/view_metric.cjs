#!/usr/bin/env node
/**
 * view_metric.cjs — can camera alignment be detected from the landmarks themselves?
 * ===============================================================================
 *
 * Tier 2 found the app's knee error is 5.63 deg when the camera sees the subject
 * side-on and 27.66 deg when it does not (§16.4). Telling users to stand side-on is
 * therefore worth more than most algorithmic work — but only if the app can actually
 * tell which case it is in, live, from the same landmarks it already has.
 *
 * The geometric idea: under a true sagittal view the left and right shoulders (and
 * hips) lie almost on the camera axis and project to nearly the same image point, so
 * their horizontal separation collapses. Face the camera and that separation is
 * maximal. Normalising by torso height makes it scale- and distance-invariant.
 *
 *      openness = (|Lsh.x - Rsh.x| + |Lhip.x - Rhip.x|) / (2 * torsoHeight)
 *
 * This script does not assume that works. It computes candidate metrics over the
 * persisted Tier 2 corpus, where every repetition carries the dataset's own view
 * label, and asks three questions:
 *
 *   1. Does the metric separate sagittal from oblique repetitions? (AUC)
 *   2. Does it predict the ERROR the user would actually get? (correlation)
 *   3. Where should the warning threshold sit, chosen on dev and checked on test?
 *
 * A metric that separates labels but does not predict error would be useless here —
 * the point is to warn when the measurement is about to be bad, not to classify poses.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

require('./harness_shim.js');
require('./kinetiq_core.generated.js');
require('./replay.js');

const shim = globalThis.KinetiQShim;
const Replay = globalThis.KinetiQReplay;

const dir = path.join(os.homedir(), 'KinetiQ_datasets/REHAB24-6/tier2_corpus');
const refd = path.join(os.homedir(), 'KinetiQ_datasets/REHAB24-6/tier2_ref');
const outDir = path.resolve(path.join(__dirname, '..', 'results'));
const TOL = 0.75, FPS = 30;
const DEV = ['PM_008','PM_022','PM_029','PM_038','PM_043'];
const TEST = ['PM_105','PM_113','PM_118','PM_126'];

const r2 = x => Math.round(x*100)/100, r3 = x => Math.round(x*1000)/1000;
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : NaN;
const absA = a => a.map(Math.abs);
const med = a => { const b=[...a].sort((x,y)=>x-y); return b.length? b[Math.floor(b.length/2)] : NaN; };

function auc(pos, neg) {
  if (!pos.length || !neg.length) return NaN;
  const a=[...pos.map(v=>[v,1]),...neg.map(v=>[v,0])].sort((x,y)=>x[0]-y[0]);
  const rk=new Array(a.length);
  for(let i=0;i<a.length;){let j=i;while(j+1<a.length&&a[j+1][0]===a[i][0])j++;
    const m=(i+j+2)/2;for(let t=i;t<=j;t++)rk[t]=m;i=j+1;}
  const rp=a.reduce((s,x,i)=>s+(x[1]===1?rk[i]:0),0);
  return (rp-pos.length*(pos.length+1)/2)/(pos.length*neg.length);
}
function pearson(x, y) {
  const n=x.length, mx=mean(x), my=mean(y);
  let num=0, dx=0, dy=0;
  for(let i=0;i<n;i++){const a=x[i]-mx,b=y[i]-my;num+=a*b;dx+=a*a;dy+=b*b;}
  return num/Math.sqrt(dx*dy);
}

/** Candidate view metrics from one frame's landmarks (row = [x,y,z,vis]). */
function frameMetrics(row) {
  const P = i => ({ x: row[i][0], y: row[i][1], v: row[i][3] });
  const Lsh=P(11), Rsh=P(12), Lhip=P(23), Rhip=P(24);
  const midShY=(Lsh.y+Rsh.y)/2, midHipY=(Lhip.y+Rhip.y)/2;
  const torso=Math.abs(midHipY-midShY);
  if (!(torso > 1e-4)) return null;
  const shW=Math.abs(Lsh.x-Rsh.x), hipW=Math.abs(Lhip.x-Rhip.x);
  return {
    shoulder: shW/torso,
    hip: hipW/torso,
    openness: (shW+hipW)/(2*torso),
    // visibility asymmetry: under a profile view one side is occluded
    visGap: Math.abs(((Lsh.v+Lhip.v)/2) - ((Rsh.v+Rhip.v)/2)),
  };
}

// ---------------------------------------------------------------------------
shim.setFrameSize(1080, 1920);
const files = fs.readdirSync(dir).filter(f=>f.endsWith('_corpus.json')).sort();
const rows = [];

for (const f of files) {
  const rec = f.replace('_corpus.json','');
  const c = JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
  const ref = JSON.parse(fs.readFileSync(path.join(refd,`${rec}_ref.json`),'utf8'));

  // side the app analyses, recovered from visibilities (same rule the app uses)
  let L=0,R=0;
  for(const r of c.landmarks){ if(!r) continue;
    const l=(r[11][3]+r[23][3]+r[25][3]+r[27][3])/4, q=(r[12][3]+r[24][3]+r[26][3]+r[28][3])/4;
    if(l>q)L++; else R++; }
  const side = L>R ? 'left' : 'right';

  const frames=[];
  for(let i=0;i<c.landmarks.length;i++){const r=c.landmarks[i];if(!r)continue;
    frames.push({t:i/FPS,landmarks:r.map(p=>({x:p[0],y:p[1],z:p[2],visibility:p[3]}))});}
  const out = Replay.replay(frames);

  const used=new Set();
  for (const a of ref.annotated_repetitions.filter(a=>!a.mocap_erroneous)) {
    const lo=a.first_frame/FPS, hi=a.last_frame/FPS+TOL;
    const idx=out.repEvents.findIndex((e,j)=>!used.has(j)&&e.atTime>=lo&&e.atTime<=hi);
    if(idx<0) continue;
    used.add(idx);
    const e=out.repEvents[idx];

    // metric averaged over the repetition's frames
    const per=[];
    for(let i=a.first_frame;i<=a.last_frame && i<c.landmarks.length;i++){
      const r=c.landmarks[i]; if(!r) continue;
      const m=frameMetrics(r); if(m) per.push(m);
    }
    if(!per.length) continue;

    const seg = arr => arr.slice(a.first_frame, a.last_frame+1);
    rows.push({
      rec, dev: DEV.includes(rec)?1:0,
      sagittal: a.cam18_sagittal?1:0,
      shoulder: mean(per.map(p=>p.shoulder)),
      hip: mean(per.map(p=>p.hip)),
      openness: mean(per.map(p=>p.openness)),
      visGap: mean(per.map(p=>p.visGap)),
      knee_err: e.knee - Math.min(...seg(ref.reference_2d[side].knee)),
    });
  }
}

console.log('view-alignment metric — validated on the Tier 2 corpus');
console.log(`${rows.length} repetitions (sagittal ${rows.filter(r=>r.sagittal).length}, oblique ${rows.filter(r=>!r.sagittal).length})`);
console.log('='.repeat(76));

console.log('\n1) 라벨 분리력 — 지표가 시상면/사면을 구분하는가');
const METRICS=['shoulder','hip','openness','visGap'];
const sep={};
for(const m of METRICS){
  const sag=rows.filter(r=>r.sagittal).map(r=>r[m]);
  const obl=rows.filter(r=>!r.sagittal).map(r=>r[m]);
  const a=auc(obl,sag);           // higher metric should mean more oblique
  sep[m]={auc:r3(a), sag_median:r3(med(sag)), obl_median:r3(med(obl))};
  console.log(`   ${m.padEnd(9)} AUC ${r3(a).toFixed(3)}   시상면 중앙값 ${r3(med(sag)).toFixed(3)}  사면 중앙값 ${r3(med(obl)).toFixed(3)}`);
}

console.log('\n2) 오차 예측력 — 지표가 실제 무릎 오차를 예측하는가 (핵심)');
const err=rows.map(r=>Math.abs(r.knee_err));
const corr={};
for(const m of METRICS){
  const c=pearson(rows.map(r=>r[m]), err);
  corr[m]=r3(c);
  console.log(`   ${m.padEnd(9)} |knee_err| 와 상관 r = ${r3(c).toFixed(3)}`);
}

const best='openness';
console.log(`\n3) 임계값 선택 — '${best}' 기준, dev 에서 고르고 test 에서 검증`);
const devRows=rows.filter(r=>r.dev), testRows=rows.filter(r=>!r.dev);
const cands=[0.30,0.35,0.40,0.45,0.50,0.55,0.60];
let pick=null;
for(const th of cands){
  const flagged=devRows.filter(r=>r[best]>th), ok=devRows.filter(r=>r[best]<=th);
  if(!flagged.length||!ok.length) continue;
  const eF=mean(absA(flagged.map(r=>r.knee_err))), eO=mean(absA(ok.map(r=>r.knee_err)));
  const gain=eF-eO;
  console.log(`   th ${th.toFixed(2)}  경고 ${String(flagged.length).padStart(3)}건(MAE ${r2(eF).toFixed(2)}°)  통과 ${String(ok.length).padStart(3)}건(MAE ${r2(eO).toFixed(2)}°)  차이 ${r2(gain).toFixed(2)}°`);
  if(!pick||gain>pick.gain) pick={th,gain,eF,eO};
}
console.log(`\n   dev 선택: th = ${pick.th.toFixed(2)} (경고군과 통과군의 오차 차이 ${r2(pick.gain)}° 로 최대)`);

const tf=testRows.filter(r=>r[best]>pick.th), to=testRows.filter(r=>r[best]<=pick.th);
const teF=mean(absA(tf.map(r=>r.knee_err))), teO=mean(absA(to.map(r=>r.knee_err)));
console.log(`\n   held-out test: 경고 ${tf.length}건 MAE ${r2(teF)}°  ·  통과 ${to.length}건 MAE ${r2(teO)}°  차이 ${r2(teF-teO)}°`);
console.log(teF-teO > 3
  ? '   -> 지표가 미학습 녹화에서도 나쁜 측정을 예측한다. 안내 UX 의 근거로 쓸 수 있다.'
  : '   -> 예측력이 약하다. 이 지표로 사용자를 경고하면 안 된다.');

fs.writeFileSync(path.join(outDir,'view_metric.json'), JSON.stringify({
  experiment: 'camera-alignment metric derived from landmarks, validated against Tier 2 error',
  generated: new Date().toISOString(),
  engine_version: globalThis.KinetiQCore.KINETIQ_PROVENANCE.engine_version,   // 2026-08-22: 스탬프 누락 보완
  n_reps: rows.length,
  label_separation: sep,
  error_correlation: corr,
  chosen: { metric: best, threshold: pick.th, basis: 'dev split, max error gap' },
  dev: { flagged_mae: r2(pick.eF), passed_mae: r2(pick.eO) },
  test: { flagged_n: tf.length, flagged_mae: r2(teF), passed_n: to.length, passed_mae: r2(teO), gap: r2(teF-teO) },
}, null, 2));
console.log('\nwritten: results/view_metric.json');
