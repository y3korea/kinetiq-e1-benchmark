#!/usr/bin/env node
/**
 * extract_sts.cjs — pull the sit-to-stand measurement chain out of index.html verbatim
 *
 * Kept separate from extract_core.cjs so the squat core's provenance hash stays stable
 * and the two chains can be reasoned about independently — which matters here, because
 * the whole question is whether STS shares the squat chain's defects or has its own.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Mirrors extract_core.cjs: --src lets the benchmark re-extract from a pinned
// snapshot under squat-app/versions/ rather than silently re-binding to the live
// build, which would move every published hash.
const args = process.argv.slice(2);
function arg(flag, dflt) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

const SRC = path.resolve(arg('--src', path.join(__dirname, '..', '..', 'squat-app', 'index.html')));
const OUT = path.resolve(arg('--out', path.join(__dirname, 'kinetiq_sts.generated.js')));

// Repo-relative label for the banner; blank when --src was not used or points
// outside the repo, so the generated file never carries a machine-specific path.
const REPO = path.join(__dirname, '..', '..');
const rel = path.relative(REPO, SRC);
const SRC_LABEL = (args.includes('--src') && !rel.startsWith('..')) ? rel : '';

const html = fs.readFileSync(SRC, 'utf8');
const lines = html.split('\n');

const VER = (html.match(/const KINETIQ_VER\s*=\s*'([^']+)'/) || [])[1] || 'unknown';

/** Slice from a start pattern to the first line that is exactly the terminator. */
function grab(startRe, endLine) {
  const i = lines.findIndex(l => startRe.test(l));
  if (i < 0) throw new Error(`not found: ${startRe}`);
  let j = i;
  while (j < lines.length && lines[j] !== endLine) j++;
  if (j >= lines.length) throw new Error(`terminator not found for ${startRe}`);
  return { text: lines.slice(i, j + 1).join('\n'), from: i + 1, to: j + 1 };
}

const defs = {
  STS: grab(/^const STS=\{$/, '};'),
  onSTSResults: grab(/^function onSTSResults\(/, '}'),
  detectSTSPhase: grab(/^function detectSTSPhase\(/, '}'),
};

const banner = `// GENERATED — verbatim extraction from squat-app/index.html (${VER})
// Do not edit. Regenerate with: node extract_sts.cjs${SRC_LABEL ? ' --src ' + SRC_LABEL : ''}
//
// The sit-to-stand chain, lifted unmodified so the benchmark exercises the shipping
// code rather than a reimplementation of it.
'use strict';
`;

const body = Object.entries(defs)
  .map(([k, d]) => `// ${k}  (index.html:${d.from}-${d.to})\n${d.text}\n`)
  .join('\n');

const exports_ = `
const KINETIQ_STS_PROVENANCE = {
  engine_version: ${JSON.stringify(VER)},
  extracted_from: 'squat-app/index.html',
  definitions: ${JSON.stringify(Object.fromEntries(
    Object.entries(defs).map(([k, d]) => [k, {
      lines: `${d.from}-${d.to}`, bytes: Buffer.byteLength(d.text, 'utf8'),
      sha256: crypto.createHash('sha256').update(d.text).digest('hex'),
    }])), null, 2)},
};

const __sts_api = { STS, onSTSResults, detectSTSPhase, KINETIQ_STS_PROVENANCE };
if (typeof module !== 'undefined' && module.exports) module.exports = __sts_api;
if (typeof globalThis !== 'undefined') {
  globalThis.KinetiQSTS = __sts_api;
  globalThis.STS = STS;
  globalThis.onSTSResults = onSTSResults;
  globalThis.detectSTSPhase = detectSTSPhase;
}
`;

fs.writeFileSync(OUT, banner + '\n' + body + exports_);
console.log(`output : ${path.basename(OUT)}   engine ${VER}\n`);
for (const [k, d] of Object.entries(defs)) {
  const sha = crypto.createHash('sha256').update(d.text).digest('hex');
  console.log(`  ${k.padEnd(16)} ${String(d.from).padStart(5)}-${String(d.to).padEnd(5)} ` +
              `${String(Buffer.byteLength(d.text, 'utf8')).padStart(5)}B  ${sha.slice(0, 12)}…`);
}
