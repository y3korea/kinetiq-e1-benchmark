#!/usr/bin/env node
/**
 * tier2_prod_verify.cjs — replay the persisted Tier 2 corpus through whatever the
 * production code currently is, with no correction applied by the harness.
 *
 * From ver7-D7.67 the app corrects for frame aspect ratio itself, so the harness
 * only presents the frame geometry (via the #webcam stub) and feeds raw MediaPipe
 * landmarks. Anything else would measure the harness rather than the product.
 *
 * This is the end-to-end product figure, and it runs in seconds because MediaPipe
 * already ran once and its output was kept.
 */
const fs = require('fs'); const path = require('path'); const os = require('os');
require('./harness_shim.js'); require('./kinetiq_core.generated.js'); require('./replay.js');
const shim = globalThis.KinetiQShim, Core = globalThis.KinetiQCore, Replay = globalThis.KinetiQReplay;

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const dir = path.resolve(arg('--corpus', path.join(os.homedir(), 'KinetiQ_datasets/REHAB24-6/tier2_corpus')));
const refd = path.resolve(arg('--ref', path.join(os.homedir(), 'KinetiQ_datasets/REHAB24-6/tier2_ref')));
const outDir = path.resolve(arg('--out', path.join(__dirname, '..', 'results')));
const TOL = 0.75;
const FRAME_W = 1080, FRAME_H = 1920;

const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const absA = a => a.map(Math.abs);
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
/** The limb the app analyses is a pure function of visibilities — recover it, don't assume it. */
function chosenSide(c) {
  let L = 0, R = 0;
  for (const r of c.landmarks) { if (!r) continue;
    const l = (r[11][3] + r[23][3] + r[25][3] + r[27][3]) / 4;
    const q = (r[12][3] + r[24][3] + r[26][3] + r[28][3]) / 4;
    if (l > q) L++; else R++; }
  return { side: L > R ? 'left' : 'right', stability: Math.max(L, R) / (L + R) };
}

shim.setFrameSize(FRAME_W, FRAME_H);
const files = fs.readdirSync(dir).filter(f => f.endsWith('_corpus.json')).sort();
let matched = 0, fp = 0, ann = 0;
const ke = [], he = [], te = [], good = [], bad = [], sag = [], obl = [], sides = {};

for (const f of files) {
  const rec = f.replace('_corpus.json', '');
  const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const ref = JSON.parse(fs.readFileSync(path.join(refd, `${rec}_ref.json`), 'utf8'));
  const cs = chosenSide(c); sides[rec] = cs;
  const frames = [];
  for (let i = 0; i < c.landmarks.length; i++) { const r = c.landmarks[i]; if (!r) continue;
    frames.push({ t: i / 30, landmarks: r.map(p => ({ x: p[0], y: p[1], z: p[2], visibility: p[3] })) }); }
  const out = Replay.replay(frames);
  const A = ref.annotated_repetitions.filter(a => !a.mocap_erroneous); ann += A.length;
  const used = new Set();
  for (const a of A) {
    const lo = a.first_frame / 30, hi = a.last_frame / 30 + TOL;
    const i = out.repEvents.findIndex((e, j) => !used.has(j) && e.atTime >= lo && e.atTime <= hi);
    if (i < 0) continue;
    used.add(i); matched++;
    const e = out.repEvents[i], seg = arr => arr.slice(a.first_frame, a.last_frame + 1);
    const kerr = e.knee - Math.min(...seg(ref.reference_2d[cs.side].knee));
    ke.push(kerr);
    he.push(e.hip - Math.min(...seg(ref.reference_2d[cs.side].hip)));
    te.push(e.trunk - Math.max(...seg(ref.reference_2d[cs.side].trunk)));
    (a.cam18_sagittal ? sag : obl).push(kerr);
    (a.correctness ? good : bad).push(e.score);
  }
  fp += out.repEvents.length - used.size;
}

const st = v => ({ n: v.length, mae: r2(mean(absA(v))), bias: r2(mean(v)),
                   rmse: r2(Math.sqrt(mean(v.map(x => x * x)))), p95: r2(pct(v, 0.95)) });
console.log(`Tier 2 — production ${Core.KINETIQ_PROVENANCE.engine_version}, end to end`);
console.log(`frame ${FRAME_W}x${FRAME_H}; app applies its own aspect correction`);
console.log('='.repeat(70));
console.log(`  counting   recall ${r3(matched / ann)}  precision ${r3(matched / (matched + fp))}  (${matched}/${ann}, FP ${fp})`);
for (const [nm, v] of [['knee', ke], ['hip', he], ['trunk', te]]) {
  const s = st(v);
  console.log(`  ${nm.padEnd(5)} MAE ${String(s.mae).padStart(6)}°  bias ${String(s.bias).padStart(7)}°  RMSE ${String(s.rmse).padStart(6)}°  p95 ${s.p95}°`);
}
console.log(`  score AUC  ${r3(auc(good, bad))}   (correct ${r2(mean(good))} vs incorrect ${r2(mean(bad))})`);
console.log(`\n  view: sagittal knee MAE ${st(sag).mae}° (n=${sag.length})  ·  oblique ${st(obl).mae}° (n=${obl.length})`);
console.log(`  limb: ${Object.entries(sides).map(([k, v]) => `${k}=${v.side}`).join(' ')}`);

fs.writeFileSync(path.join(outDir, 'tier2_production.json'), JSON.stringify({
  experiment: 'Tier 2 end-to-end, production code replayed over the persisted landmark corpus',
  generated: new Date().toISOString(),
  engine_version: Core.KINETIQ_PROVENANCE.engine_version,
  source_sha256: Core.KINETIQ_PROVENANCE.source_sha256,
  frame: { width: FRAME_W, height: FRAME_H },
  counting: { recall: r3(matched / ann), precision: r3(matched / (matched + fp)), matched, fp, annotated: ann },
  knee: st(ke), hip: st(he), trunk: st(te),
  view: { sagittal: st(sag), oblique: st(obl) },
  score_validity: { auc: r3(auc(good, bad)), correct_mean: r2(mean(good)), incorrect_mean: r2(mean(bad)) },
  limb_selection: sides,
  limb_note: 'recovered exactly from landmark visibilities, the same rule the app uses',
  scope_note: 'Benchmark against mocap-derived reference angles on one dataset and one '
            + 'camera geometry. Not a clinical validation study.',
}, null, 2));
console.log('\nwritten: results/tier2_production.json');
