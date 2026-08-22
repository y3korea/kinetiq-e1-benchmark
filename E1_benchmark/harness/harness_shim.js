/**
 * harness_shim.js — execution environment for the verbatim production core
 * =========================================================================
 *
 * kinetiq_core.generated.js contains production code lifted byte-for-byte from
 * index.html. That code expects a browser app around it: a global `APP` state
 * object, DOM nodes to write into, a speech synthesiser, photo capture, i18n.
 *
 * This shim supplies that environment for offline benchmarking. Two rules
 * govern every line below:
 *
 *   RULE 1 — Never alter control flow.
 *     Stubs record their calls and return neutral values. No branch inside
 *     detectPhase() or completeRep() may depend on a stub's return value.
 *     verify_shim.cjs asserts this empirically by re-running the pipeline with
 *     randomised stub return values and requiring identical output.
 *
 *   RULE 2 — Time is video time, not wall time.
 *     detectPhase()/completeRep() read Date.now() to derive descent/ascent
 *     tempo. Under wall-clock replay those durations would measure how fast the
 *     benchmark machine decodes frames — a meaningless quantity. The shim
 *     therefore installs a VIRTUAL CLOCK driven by the video presentation
 *     timestamp, so tempo reflects the recorded movement exactly as it would
 *     for a live subject performing at that speed.
 *     This substitution is disclosed in results metadata (`clock: "virtual"`).
 *
 * Everything the shim intercepts is logged in `shimCallLog` so a run can be
 * audited for unexpected side-effect usage.
 */

/* eslint-disable */
(function (root) {
'use strict';

// ---------------------------------------------------------------------------
// Virtual clock
// ---------------------------------------------------------------------------
const clock = {
  t: 0,                 // current video time, milliseconds
  realDateNow: Date.now.bind(Date),
  installed: false,
};

/** Advance the virtual clock to a video presentation timestamp (seconds). */
function setVideoTime(seconds) {
  clock.t = seconds * 1000;
}

function installVirtualClock() {
  if (clock.installed) return;
  Date.now = function () { return clock.t; };
  clock.installed = true;
}

function uninstallVirtualClock() {
  if (!clock.installed) return;
  Date.now = clock.realDateNow;
  clock.installed = false;
}

// ---------------------------------------------------------------------------
// Side-effect call log (audit trail)
// ---------------------------------------------------------------------------
const shimCallLog = [];
function note(fn, detail) {
  shimCallLog.push({ t: clock.t, fn, detail: detail === undefined ? null : detail });
}

// ---------------------------------------------------------------------------
// APP state — mirrors the production initial state for the squat module.
// Field names and initial values follow index.html; see APP = {...} there.
// ---------------------------------------------------------------------------
function freshAPP(opts) {
  opts = opts || {};
  return {
    // profile drives getStd()/getACSM() reference ranges
    profile: Object.assign({ squatType: 'bodyweight', bodyType: 'balanced' }, opts.profile || {}),

    isAnalyzing: true,
    landmarks: null,
    smoothAngles: { knee: 180, hip: 180, trunk: 0, ankle: 90 },

    // FSM state
    sqPhase: 'stand',
    prevKneeAngle: 180,
    descentStart: null,
    bottomTimestamp: null,
    ascentStart: null,
    bottomReached: false,
    lastRepTiming: null,

    // ver7-D7.66: personalised rep-completion threshold + true-bottom tracking
    _standPeakKnee: 0,
    _standAt: 0,
    _repTopKnee: 0,
    _repMinKnee: 999,
    _repMinKneeAt: 0,
    _ascentPeak: 0,

    // per-rep accumulators
    currentRepAngles: { knee: [], hip: [], ankle: [], trunk: [] },
    currentBottomCoords: null,
    _lastLandmarkCoords: null,

    // photo capture bookkeeping (stubbed, but the booleans gate real branches)
    standingCaptured: false,
    parallelCaptured: false,
    currentPhaseCapture: { standing: null, parallel: null, bottom: null },
    phaseCaptures: [],
    repSnapshots: [],

    // results
    repCount: 0,
    reps: [],
    repTarget: opts.repTarget != null ? opts.repTarget : 1e9,  // never auto-finish during replay

    _lastVoiceRep: 0,
  };
}

// ---------------------------------------------------------------------------
// DOM stub
//
// completeRep() writes rep count and tempo into three elements. The stub
// records the writes (useful for cross-checking) and swallows everything else.
// ---------------------------------------------------------------------------
const domWrites = {};
// ---------------------------------------------------------------------------
// Frame geometry.
//
// From ver7-D7.67 the production code corrects for the frame aspect ratio before
// computing angles, reading it from the #webcam element. The harness therefore has
// to present that geometry rather than pre-scaling landmarks itself — otherwise the
// benchmark would measure the harness's correction instead of the product's.
//
// Default 0x0 means "geometry unknown", which the production code treats as no
// correction. That keeps Tier 0 and Tier 1.5, whose synthetic landmarks are already
// isotropic, behaving exactly as before.
let FRAME_W = 0, FRAME_H = 0;
function setFrameSize(w, h) { FRAME_W = w | 0; FRAME_H = h | 0; }
function getFrameSize() { return { width: FRAME_W, height: FRAME_H }; }

function makeElementStub(id) {
  return {
    id,
    set textContent(v) { domWrites[id] = v; note('dom.textContent', { id, value: String(v) }); },
    get textContent() { return domWrites[id]; },
    set innerHTML(v) { note('dom.innerHTML', { id }); },
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild() {}, remove() {}, querySelectorAll() { return []; },
  };
}

function installDOMStub() {
  if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
    // Real browser (harness page): wrap getElementById so missing nodes are
    // synthesised rather than throwing.
    const realGet = document.getElementById.bind(document);
    document.getElementById = function (id) {
      const el = realGet(id) || makeElementStub(id);
      if (id === 'webcam' || id === 'stsWebcam') { el.videoWidth = FRAME_W; el.videoHeight = FRAME_H; }
      return el;
    };
    return;
  }
  root.document = {
    getElementById: function (id) {
      const el = makeElementStub(id);
      if (id === 'webcam' || id === 'stsWebcam') { el.videoWidth = FRAME_W; el.videoHeight = FRAME_H; }
      return el;
    },
    createElement: () => makeElementStub('created'),
    querySelectorAll: () => [],
  };
}

// ---------------------------------------------------------------------------
// UI / audio / capture stubs
//
// Return values are neutral. Verified non-influential by verify_shim.cjs.
// `stubReturns` exists solely so the verifier can perturb them.
// ---------------------------------------------------------------------------
const stubReturns = { capturePhasePhoto: null };

function installUIStubs() {
  root.capturePhasePhoto = function (knee, hip, trunk, ankle) {
    note('capturePhasePhoto', { knee, hip, trunk, ankle });
    return stubReturns.capturePhasePhoto;
  };
  root.captureSnapshot = function (canvas, knee, hip, trunk, ankle) {
    note('captureSnapshot', { knee, hip, trunk, ankle });
    // Production pushes a snapshot that completeRep() reads back via
    // APP.repSnapshots[last].angles. Preserve that data path exactly — it is
    // measurement-relevant, not a side effect.
    root.APP.repSnapshots.push({ angles: { knee, hip, trunk, ankle }, t: clock.t });
  };
  // onPoseResults rendering/HUD calls — pure output, no measurement effect
  root.drawPose = function () { note('drawPose'); };
  root.drawMirroredText = function () { note('drawMirroredText'); };
  root.updateBar = function (n, a, r) { note('updateBar', { joint: n, angle: a }); };
  root.updateLiveFeedback = function (knee, hip, trunk, ankle) {
    note('updateLiveFeedback', { knee, hip, trunk, ankle });
  };

  root.updatePI = function (cls, text) { note('updatePI', { cls, text: String(text) }); };
  root.speak = function (msg) { note('speak', { msg: String(msg) }); };
  root.showRepPopup = function (n) { note('showRepPopup', { n }); };
  root.finishExercise = function () { note('finishExercise'); };
  root.voiceCue = function () {};
  root.voiceResetGoodStreak = function () {};
  root.voiceEncouragementOnGoodRep = function () {};
  root.t = function (key) { return String(key); };            // i18n passthrough
  if (typeof root.setTimeout !== 'function') root.setTimeout = function (fn) { return 0; };
}

// ---------------------------------------------------------------------------
// Canvas / context stubs
//
// onPoseResults() sizes the canvas and clears the 2D context before any
// measurement happens. In the browser harness a real (offscreen) canvas is
// used; under Node a minimal stub suffices. Canvas dimensions do not enter any
// angle computation: calcAngle/calcTrunk operate on MediaPipe's normalised
// landmark coordinates, so they are resolution-independent.
// ---------------------------------------------------------------------------
function makeCanvasStub(w, h) {
  return {
    width: w || 1280, height: h || 720,
    clientWidth: w || 1280, clientHeight: h || 720,
  };
}
function makeCtxStub() {
  return {
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    arc() {}, fill() {}, fillText() {}, strokeText() {}, save() {}, restore() {},
    translate() {}, scale() {}, drawImage() {},
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set font(v) {},
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function install(opts) {
  root.APP = freshAPP(opts);
  installDOMStub();
  installUIStubs();
  installVirtualClock();
  shimCallLog.length = 0;
  return root.APP;
}

function reset(opts) {
  root.APP = freshAPP(opts);
  shimCallLog.length = 0;
  for (const k in domWrites) delete domWrites[k];
  clock.t = 0;
  return root.APP;
}

// ver7-D7.71: presentation-only callbacks the measurement chain invokes.
// The alignment METRIC is extracted and benchmarked; only its rendering is stubbed.
if (typeof root.updateViewGuide !== 'function') root.updateViewGuide = function(){};
if (typeof root.kqSessionViewQuality !== 'function') root.kqSessionViewQuality = function(){ return null; };

const api = {
  install, reset, freshAPP,
  setVideoTime,
  setFrameSize, getFrameSize,
  makeCanvasStub, makeCtxStub,
  installVirtualClock, uninstallVirtualClock,
  shimCallLog, domWrites, stubReturns,
  get virtualNow() { return clock.t; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
root.KinetiQShim = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
