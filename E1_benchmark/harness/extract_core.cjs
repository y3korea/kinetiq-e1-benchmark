#!/usr/bin/env node
/**
 * extract_core.cjs — KinetiQ E1 benchmark: verbatim production-code extractor
 * ===========================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * A measurement benchmark is only valid if it measures the SHIPPED code. If the
 * harness re-implemented calcAngle()/detectPhase(), we would be validating a
 * re-implementation, and any reviewer would (correctly) reject the result.
 *
 * This script therefore lifts the *exact source text* of the production
 * measurement functions out of squat-app/index.html and emits them, unmodified,
 * into kinetiq_core.generated.js. Every extracted function is hashed (SHA-256)
 * and its source line range recorded, so the provenance of every benchmark run
 * is auditable and any drift in index.html is detectable.
 *
 * WHAT IS AND IS NOT EXTRACTED
 * ----------------------------
 *   EXTRACTED VERBATIM (the measurement chain under test):
 *     STANDARDS, BODY_ADJ   — squat-type / body-type angle reference ranges
 *     getStd, getACSM, dev  — reference range resolution + deviation helper
 *     onPoseResults         — per-frame entry point: visible-side selection and
 *                             the landmark->angle wiring (which joints feed which
 *                             angle). Its drawing/HUD calls are stubbed.
 *     calcAngle             — 2D three-point joint angle (vector dot product)
 *     calcTrunk             — trunk inclination from vertical (atan2)
 *     calcAsymmetry         — bilateral L/R joint angle comparison
 *     smooth                — EMA temporal filter (alpha = 0.3)
 *     detectPhase           — 4-state repetition-counting FSM
 *     completeRep           — per-repetition angle aggregation (min/max)
 *     repScore              — weighted per-repetition technique score
 *
 *   STUBBED (side effects only — never touched by the measurement logic):
 *     UI/DOM writes, audio cues, photo capture. See harness_shim.js.
 *     The stubs record that they were called but return neutral values, so the
 *     control flow through detectPhase()/completeRep() is byte-identical to
 *     production. No branch condition depends on a stub's return value —
 *     this is asserted in verify_shim.cjs.
 *
 * USAGE
 *   node extract_core.cjs [--src <index.html>] [--out <kinetiq_core.generated.js>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
function arg(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const SRC = path.resolve(arg('--src', path.join(__dirname, '..', '..', 'squat-app', 'index.html')));
const OUT = path.resolve(arg('--out', path.join(__dirname, 'kinetiq_core.generated.js')));

// ---------------------------------------------------------------------------
// Targets: what to lift out of index.html.
//   kind 'function' — `function NAME(...) { ... }`, brace-matched
//   kind 'const'    — `const NAME = ...;`, brace/paren-matched to the terminator
// ---------------------------------------------------------------------------
const TARGETS = [
  { name: 'STANDARDS',     kind: 'const'    },
  { name: 'BODY_ADJ',      kind: 'const'    },
  { name: 'getStd',        kind: 'function' },
  { name: 'getACSM',       kind: 'function' },
  { name: 'dev',           kind: 'function' },
  { name: 'onPoseResults', kind: 'function' },
  { name: 'calcAngle',     kind: 'function' },
  { name: 'calcTrunk',     kind: 'function' },
  { name: 'calcAsymmetry', kind: 'function' },
  // ver7-D7.71: camera-alignment metric. It is a measurement function, not chrome —
  // it decides whether the angles this run produces can be trusted — so it is
  // extracted and benchmarked rather than stubbed.
  { name: 'kqViewOpenness', kind: 'function' },
  { name: 'KQ_VIEW_GOOD',   kind: 'const'    },
  { name: 'KQ_VIEW_WARN',   kind: 'const'    },
  { name: 'kqViewGrade',    kind: 'function' },
  { name: 'smooth',        kind: 'function' },
  { name: 'detectPhase',   kind: 'function' },
  { name: 'completeRep',   kind: 'function' },
  { name: 'repScore',      kind: 'function' },
];

const src = fs.readFileSync(SRC, 'utf8');

/** Byte offset -> 1-indexed line number. */
function lineOf(text, idx) {
  return text.slice(0, idx).split('\n').length;
}

/**
 * Brace-matched extraction. Skips over string literals, template literals,
 * regex-ish slashes and comments so that braces inside them do not unbalance
 * the scan. index.html is minified-ish in places, so this matters.
 */
function matchBlock(text, startIdx, openCh, closeCh) {
  let depth = 0;
  let i = startIdx;
  let inS = null;        // active string delimiter: ' " `
  let inLineComment = false;
  let inBlockComment = false;

  for (; i < text.length; i++) {
    const c = text[i];
    const prev = text[i - 1];
    const next = text[i + 1];

    if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (inS) {
      if (c === '\\') { i++; continue; }
      if (c === inS) inS = null;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { inS = c; continue; }

    if (c === openCh) depth++;
    else if (c === closeCh) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${openCh}${closeCh} from offset ${startIdx} (line ${lineOf(text, startIdx)})`);
}

/**
 * `\s*` in the target regexes can swallow blank lines, so the raw match offset
 * may sit a line early. Snap forward to the actual keyword so the recorded line
 * range and the hashed text both start exactly at the definition.
 */
function snapToKeyword(idx, keyword) {
  const at = src.indexOf(keyword, idx);
  return at >= 0 ? at : idx;
}

function extractFunction(name) {
  const re = new RegExp(`(^|\\n)\\s*function\\s+${name}\\s*\\(`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`function ${name} not found in ${SRC}`);
  const start = snapToKeyword(m.index + (m[1] ? m[1].length : 0), 'function');
  const parenOpen = src.indexOf('(', start);
  const parenClose = matchBlock(src, parenOpen, '(', ')');
  const braceOpen = src.indexOf('{', parenClose);
  const braceClose = matchBlock(src, braceOpen, '{', '}');
  return { text: src.slice(start, braceClose + 1), startLine: lineOf(src, start), endLine: lineOf(src, braceClose) };
}

function extractConst(name) {
  const re = new RegExp(`(^|\\n)\\s*const\\s+${name}\\s*=`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`const ${name} not found in ${SRC}`);
  const start = snapToKeyword(m.index + (m[1] ? m[1].length : 0), 'const');
  const eq = src.indexOf('=', start);
  let end;
  const firstNonWs = src.slice(eq + 1).match(/\S/);
  const valStart = eq + 1 + (firstNonWs ? firstNonWs.index : 0);
  const ch = src[valStart];
  if (ch === '{') end = matchBlock(src, valStart, '{', '}');
  else if (ch === '[') end = matchBlock(src, valStart, '[', ']');
  else if (ch === '(') end = matchBlock(src, valStart, '(', ')');
  else end = src.indexOf(';', valStart);
  const semi = src.indexOf(';', end);
  const stop = semi >= 0 && semi - end < 4 ? semi : end;
  return { text: src.slice(start, stop + 1), startLine: lineOf(src, start), endLine: lineOf(src, stop) };
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------
const extracted = [];
for (const tgt of TARGETS) {
  const got = tgt.kind === 'function' ? extractFunction(tgt.name) : extractConst(tgt.name);
  extracted.push({
    name: tgt.name,
    kind: tgt.kind,
    startLine: got.startLine,
    endLine: got.endLine,
    bytes: Buffer.byteLength(got.text, 'utf8'),
    sha256: crypto.createHash('sha256').update(got.text, 'utf8').digest('hex'),
    text: got.text,
  });
}

const srcHash = crypto.createHash('sha256').update(src, 'utf8').digest('hex');
const srcStat = fs.statSync(SRC);

// Production engine version tag, for the provenance record.
const verMatch = src.match(/KINETIQ_VER\s*=\s*['"]([^'"]+)['"]/);
const engineVer = verMatch ? verMatch[1] : 'unknown';

const provenance = {
  generated_by: 'E1_benchmark/harness/extract_core.cjs',
  source_file: path.relative(path.join(__dirname, '..', '..'), SRC),
  source_sha256: srcHash,
  source_bytes: srcStat.size,
  source_mtime: srcStat.mtime.toISOString(),
  engine_version: engineVer,
  node_version: process.version,
  // The measurement chain below is hashed line by line, but until D7.90 the
  // perception model in front of it was loaded from an unversioned CDN path, so
  // nothing here recorded which pose build produced a result. Derived from
  // pose_assets.json rather than hard-coded, so the record cannot drift from
  // what verify_pose_assets.cjs actually checked. Absent in a clean clone that
  // has not run that script yet -- that must not be fatal.
  pose_runtime: (() => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'pose_assets.json'), 'utf8'));
      return {
        package: m.package,
        version: m.version,
        cdn_host: m.cdn_host,
        model_selection: m.model_selection,
        benchmark_run_complexity: m.benchmark_run_complexity,
        benchmark_run_model: m.benchmark_run_model,
        assets: m.assets.map(a => ({ file: a.file, bytes: a.bytes, sha256: a.sha256 })),
        companion_packages: (m.companion_packages || []).map(c => ({
          package: c.package,
          version: c.version,
          assets: c.assets.map(a => ({ file: a.file, bytes: a.bytes, sha256: a.sha256 })),
        })),
        verification: m.verification,
        note: m.latest_note,
      };
    } catch (_) {
      return 'absent — run node verify_pose_assets.cjs';
    }
  })(),
  extracted: extracted.map(({ text, ...meta }) => meta),
};

// ---------------------------------------------------------------------------
// 공개 패치 (disclosed patch): 실험용 임계 오버라이드 훅
// ---------------------------------------------------------------------------
// aspect_experiment / bottom_th_selection 은 detectPhase 의 STAND / BOTTOM_TH /
// PARALLEL_TH 를 조건별로 바꿔 가며 같은 랜드마크를 재생해야 한다. D7.66 시절에는
// 생성 파일을 손으로 패치해 훅을 넣었는데, 이후 재추출이 그 패치를 소리 없이
// 지워 훅이 죽어 있었다 (2026-08-22 발견 — 당시 리포트의 B≠C 가 훅이 작동했다는
// 증거다). 패치를 추출기 안으로 옮겨 재추출에도 살아남게 한다.
//   * globalThis.__E1_TH 가 null/미설정이면 기본식이 그대로 살아 원본과 완전히
//     동일하게 동작한다 (게이트 4종의 결과 불변으로 검증할 것).
//   * 아래 body 의 sha256 은 패치 전 원문(verbatim)의 해시이며, 패치 전문은
//     provenance.patches 에 기록되어 감사 가능하다.
const TH_SRC = 'const STAND=160,BOTTOM_TH=Math.min(ACSM.knee.max+35,145),PARALLEL_TH=150;';
const TH_HOOKED = "const __TH=(typeof globalThis!=='undefined'&&globalThis.__E1_TH)||null;const STAND=__TH?__TH.stand:160,BOTTOM_TH=__TH?__TH.bottom:Math.min(ACSM.knee.max+35,145),PARALLEL_TH=__TH?__TH.parallel:150;";
{
  const dp = extracted.find(e => e.name === 'detectPhase');
  if (!dp) throw new Error('detectPhase not extracted');
  const n = dp.text.split(TH_SRC).length - 1;
  if (n !== 1) throw new Error(`threshold line: detectPhase 안에서 정확히 1회여야 하는데 ${n}회 — 배포 코드가 바뀌었다. TH_SRC 를 갱신하라`);
  dp.text = dp.text.replace(TH_SRC, TH_HOOKED);
  dp.patched = '__E1_TH threshold hook';
  provenance.patches = [{
    function: 'detectPhase',
    hook: '__E1_TH',
    reason: 'experiment scripts override STAND/BOTTOM_TH/PARALLEL_TH per condition; inert when __E1_TH is null',
    original: TH_SRC,
    patched: TH_HOOKED,
  }];
}

const banner = `/**
 * kinetiq_core.generated.js — DO NOT EDIT BY HAND
 * ================================================
 * Generated by E1_benchmark/harness/extract_core.cjs
 *
 * Contains the VERBATIM production measurement code lifted from:
 *   ${provenance.source_file}
 *   sha256 ${srcHash}
 *   engine ${engineVer}
 *
 * Every function below is byte-identical to the shipped implementation. The
 * benchmark therefore measures the product, not a re-implementation. Regenerate
 * (and re-run the benchmark) whenever index.html changes:
 *     node extract_core.cjs
 *
 * Environment contract: these functions reference a global \`APP\` state object
 * and a small number of UI side-effect functions. Both are supplied by
 * harness_shim.js, which stubs side effects WITHOUT altering control flow.
 */

/* eslint-disable */
(function (root) {
'use strict';

const KINETIQ_PROVENANCE = ${JSON.stringify(provenance, null, 2)};

`;

const body = extracted.map(e =>
  `// ${'-'.repeat(74)}\n` +
  `// ${e.name}  [${e.kind}]  index.html:${e.startLine}-${e.endLine}\n` +
  `// sha256 ${e.sha256}\n` +
  (e.patched ? `// PATCHED: ${e.patched} — sha256 은 패치 전 원문 기준. 전문은 provenance.patches 참조\n` : '') +
  `// ${'-'.repeat(74)}\n` +
  e.text + '\n'
).join('\n');

const footer = `
// ---------------------------------------------------------------------------
// Export surface
// ---------------------------------------------------------------------------
const __exports = {
  KINETIQ_PROVENANCE,
${TARGETS.map(t => `  ${t.name},`).join('\n')}
};

if (typeof module !== 'undefined' && module.exports) module.exports = __exports;
root.KinetiQCore = __exports;

})(typeof globalThis !== 'undefined' ? globalThis : this);
`;

fs.writeFileSync(OUT, banner + body + footer, 'utf8');
fs.writeFileSync(
  path.join(path.dirname(OUT), 'provenance.json'),
  JSON.stringify(provenance, null, 2),
  'utf8'
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`source : ${provenance.source_file}`);
console.log(`         sha256 ${srcHash.slice(0, 16)}…  engine ${engineVer}`);
console.log(`output : ${path.relative(process.cwd(), OUT)}`);
console.log('');
console.log('extracted verbatim:');
for (const e of extracted) {
  console.log(`  ${e.name.padEnd(14)} ${String(e.startLine).padStart(5)}-${String(e.endLine).padEnd(5)} ` +
              `${String(e.bytes).padStart(5)}B  ${e.sha256.slice(0, 12)}…`);
}
console.log(`\n${extracted.length} definitions, ${extracted.reduce((a, e) => a + e.bytes, 0)} bytes total`);
