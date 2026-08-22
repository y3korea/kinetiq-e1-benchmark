// GENERATED — verbatim extraction from squat-app/index.html (ver7-D7.85)
// Do not edit. Regenerate with: node extract_sts.cjs
//
// The sit-to-stand chain, lifted unmodified so the benchmark exercises the shipping
// code rather than a reimplementation of it.
'use strict';

// STS  (index.html:9432-9443)
const STS={
  pose:null,camera:null,isRunning:false,repCount:0,timer:30,timerInterval:null,
  phase:'sit', // sit, rising, stand, sitting
  prevKnee:90,reps:[],startTime:0,lastRepTime:0,
  smoothK:90,smoothH:90,
  // Normative data: Rikli & Jones (2013), Bohannon (2006)
  norms:{
    male:{20:22,30:21,40:20,50:19,60:17,65:15,70:14,75:14,80:12,85:11,90:9},
    female:{20:20,30:19,40:18,50:17,60:15,65:14,70:13,75:12,80:11,85:10,90:8},
  },
  fallRiskThresholds:{60:12,65:11,70:10,75:10,80:8,85:7,90:5,20:15,30:15,40:15,50:15},
};

// onSTSResults  (index.html:9482-9523)
function onSTSResults(results,canvas,ctx){
  canvas.width=canvas.clientWidth;canvas.height=canvas.clientHeight;ctx.clearRect(0,0,canvas.width,canvas.height);
  if(!results.poseLandmarks)return;
  const lm=results.poseLandmarks;
  drawPose(ctx,lm,canvas.width,canvas.height);
  if(!STS.isRunning)return;

  const lVis=(lm[11].visibility+lm[23].visibility+lm[25].visibility+lm[27].visibility)/4;
  const rVis=(lm[12].visibility+lm[24].visibility+lm[26].visibility+lm[28].visibility)/4;
  let shoulder,hip,knee,ankle;
  if(lVis>rVis){shoulder=lm[11];hip=lm[23];knee=lm[25];ankle=lm[27];}
  else{shoulder=lm[12];hip=lm[24];knee=lm[26];ankle=lm[28];}

  // ver7-D7.68: 종횡비 보정 — 스쿼트 경로(D7.67)와 동일 근거. MediaPipe 정규화 좌표는
  // 비등방이라 각도를 보존하지 않는다. E1 S1 실측: 4:3 프레임에서 무릎 MAE 4.09°,
  // 최대 6.73°. 프레임 기하를 못 읽으면 보정하지 않는다.
  const _vEl=document.getElementById('stsWebcam');
  const _vw=(_vEl&&_vEl.videoWidth)||(results.image&&results.image.width)||0;
  const _vh=(_vEl&&_vEl.videoHeight)||(results.image&&results.image.height)||0;
  const _ar=(_vw>0&&_vh>0)?_vw/_vh:1;
  STS._frameAR=_ar;
  const _iso=p=>({x:p.x*_ar,y:p.y,z:p.z,visibility:p.visibility});

  const rawK=calcAngle(_iso(hip),_iso(knee),_iso(ankle));
  const rawH=calcAngle(_iso(shoulder),_iso(hip),_iso(knee));
  const k=STS.smoothK=STS.smoothK*.7+rawK*.3;
  const h=STS.smoothH=STS.smoothH*.7+rawH*.3;

  // Update bars
  document.getElementById('stsKneeVal').textContent=k.toFixed(0)+'°';
  document.getElementById('stsHipVal').textContent=h.toFixed(0)+'°';
  const kb=document.getElementById('stsKneeBar');kb.style.width=Math.min(100,k/180*100)+'%';kb.style.background=k>150?'var(--success)':k>100?'var(--warn)':'var(--primary)';
  const hb=document.getElementById('stsHipBar');hb.style.width=Math.min(100,h/180*100)+'%';hb.style.background=h>150?'var(--success)':'var(--warn)';

  // Angle overlay (ver6.1: mirror-corrected)
  const txt=`무릎: ${k.toFixed(0)}° | ${STS.repCount}회`;
  drawMirroredText(ctx,txt,10,30,{font:'bold 16px sans-serif',strokeStyle:'#000',lineWidth:3,fillStyle:'#f1c40f'});

  // Phase detection for STS
  detectSTSPhase(k,h);
  updateSTSFeedback(k);
}

// detectSTSPhase  (index.html:9525-9569)
function detectSTSPhase(knee,hip){
  const SIT_TH=110; // sitting: knee < 110
  const STAND_TH=155; // standing: knee > 155

  switch(STS.phase){
    case 'sit':
      if(knee>SIT_TH+10&&knee>STS.prevKnee){STS.phase='rising';updateSTSPI('pi-up','일어서는 중...');}
      break;
    case 'rising':
      if(knee>=STAND_TH){
        STS.phase='stand';
        // ver7-D7.68 — 30초 의자 일어서기 검사(Rikli & Jones)는 '완전히 일어선 횟수'를 센다.
        // D7.67 까지는 '다시 앉을 때' 카운트해서, 30초 종료 시점에 서 있으면 그 회차가
        // 통째로 누락됐다(E1 S2: 10회 수행 -> 9회 표시). 검사 특성상 종료 시점에 서 있을
        // 확률이 절반쯤이고, 낙상 위험 분류가 이 카운트의 절대값에 걸려 있어
        // (예: 70세 임계 10회) 1회 누락이 '보통'을 '높음'으로 뒤집는다.
        const now=Date.now();
        const repTime=(now-STS.lastRepTime)/1000;
        STS.lastRepTime=now;
        STS.repCount++;
        STS.reps.push({rep:STS.repCount,time:repTime,knee:knee,timestamp:now});
        document.getElementById('stsRepCount').textContent=STS.repCount;
        const avgT=STS.reps.reduce((s,r)=>s+r.time,0)/STS.reps.length;
        document.getElementById('stsAvgSpeed').textContent=avgT.toFixed(1);
        speak(STS.repCount+'회');
        updateSTSPI('pi-done',`${STS.repCount}회 완료!`);
        const c=document.getElementById('stsVideoContainer'),pp=document.createElement('div');
        pp.className='rep-popup';pp.textContent=STS.repCount+'!';c.appendChild(pp);setTimeout(()=>pp.remove(),800);
      }
      if(knee<SIT_TH){STS.phase='sit';updateSTSPI('pi-bottom','앉기');}
      break;
    case 'stand':
      if(knee<STAND_TH-10&&knee<STS.prevKnee){STS.phase='sitting';updateSTSPI('pi-down','앉는 중...');}
      break;
    case 'sitting':
      // ver7-D7.68: 카운팅은 'rising -> stand' 로 이동했다. 여기서는 상태만 되돌린다.
      if(knee<=SIT_TH){
        STS.phase='sit';
        updateSTSPI('pi-bottom','앉기 완료 — 다시 일어서세요');
      }
      if(knee>STAND_TH){STS.phase='stand';updateSTSPI('pi-done','서기');}
      break;
  }
  STS.prevKnee=knee;
}

const KINETIQ_STS_PROVENANCE = {
  engine_version: "ver7-D7.85",
  extracted_from: 'squat-app/index.html',
  definitions: {
  "STS": {
    "lines": "9432-9443",
    "bytes": 531,
    "sha256": "cafd294afb31f720a6baa158d40e79a141eb2327d477f50aa1e3c05d11d3f886"
  },
  "onSTSResults": {
    "lines": "9482-9523",
    "bytes": 2273,
    "sha256": "b80400dc969ccebd0ec2d900b9ee03fa8141b1c5b9c11fa26d5503272f813188"
  },
  "detectSTSPhase": {
    "lines": "9525-9569",
    "bytes": 2251,
    "sha256": "21005b20916ea8249db5e5fdd8a67e159411c44212cfaffb367bd4fcd03acbca"
  }
},
};

const __sts_api = { STS, onSTSResults, detectSTSPhase, KINETIQ_STS_PROVENANCE };
if (typeof module !== 'undefined' && module.exports) module.exports = __sts_api;
if (typeof globalThis !== 'undefined') {
  globalThis.KinetiQSTS = __sts_api;
  globalThis.STS = STS;
  globalThis.onSTSResults = onSTSResults;
  globalThis.detectSTSPhase = detectSTSPhase;
}
