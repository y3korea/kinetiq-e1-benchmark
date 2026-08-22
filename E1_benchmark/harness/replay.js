/**
 * replay.js — deterministic frame-by-frame replay through the production core
 * ============================================================================
 *
 * Feeds a sequence of landmark frames into the *verbatim* production callback
 * onPoseResults(), advancing a virtual clock to each frame's presentation
 * timestamp, and records everything the pipeline produces.
 *
 * Determinism
 * -----------
 * Live operation is frame-rate dependent: under load the browser drops frames
 * and Date.now() advances with wall time. Replay instead visits every supplied
 * frame exactly once with time taken from the frame itself, so a run is
 * bit-reproducible across machines. Reported in metadata as
 * `{ clock: "virtual", replay: "exhaustive" }`.
 *
 * To study the frame-rate sensitivity of the pipeline (a real deployment
 * concern on low-end phones), decimate the frame list before calling replay —
 * see `decimate()`.
 */

/* eslint-disable */
(function (root) {
'use strict';

function requireDep(name, nodePath) {
  if (root[name]) return root[name];
  if (typeof require === 'function') { require(nodePath); return root[name]; }
  throw new Error(`${name} not loaded; include ${nodePath} first`);
}

/**
 * Run frames through the production pipeline.
 *
 * @param {Array} frames  [{ t: seconds, landmarks: [...33] }, ...] time-ordered
 * @param {object} opts
 *   profile   squat profile passed to the shim (drives reference ranges)
 *   canvas    optional real canvas (browser); a stub is used otherwise
 * @returns {object} per-frame series, detected repetitions, and metadata
 */
function replay(frames, opts) {
  opts = opts || {};
  const shim = requireDep('KinetiQShim', './harness_shim.js');
  const core = requireDep('KinetiQCore', './kinetiq_core.generated.js');

  const APP = shim.install({ profile: opts.profile });
  const canvas = opts.canvas || shim.makeCanvasStub(opts.width, opts.height);
  const ctx = opts.ctx || shim.makeCtxStub();

  const series = [];
  const repEvents = [];
  let lastRepCount = 0;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    shim.setVideoTime(f.t);

    // Production entry point, called exactly as the live camera loop calls it.
    core.onPoseResults({ poseLandmarks: f.landmarks }, canvas, ctx);

    series.push({
      i,
      t: f.t,
      // Smoothed angles as the app reports them (EMA alpha = 0.3).
      knee: APP.smoothAngles.knee,
      hip: APP.smoothAngles.hip,
      trunk: APP.smoothAngles.trunk,
      ankle: APP.smoothAngles.ankle,
      phase: APP.sqPhase,
      repCount: APP.repCount,
    });

    if (APP.repCount > lastRepCount) {
      const rep = APP.reps[APP.reps.length - 1];
      repEvents.push({
        rep: rep.rep,
        atFrame: i,
        atTime: f.t,
        knee: rep.knee, hip: rep.hip, trunk: rep.trunk, ankle: rep.ankle,
        descentTime: rep.descentTime,
        ascentTime: rep.ascentTime,
        score: core.repScore(rep),
      });
      lastRepCount = APP.repCount;
    }
  }

  return {
    series,
    reps: APP.reps.slice(),
    repEvents,
    repCount: APP.repCount,
    meta: {
      engine_version: core.KINETIQ_PROVENANCE.engine_version,
      source_sha256: core.KINETIQ_PROVENANCE.source_sha256,
      clock: 'virtual',
      replay: 'exhaustive',
      frames: frames.length,
      duration_s: frames.length ? frames[frames.length - 1].t - frames[0].t : 0,
      profile: opts.profile || { squatType: 'bodyweight', bodyType: 'balanced' },
      shim_calls: shim.shimCallLog.length,
    },
  };
}

/**
 * Keep every n-th frame — used to characterise frame-rate sensitivity
 * (e.g. 30 fps source decimated to 15 / 10 / 6 fps).
 */
function decimate(frames, n) {
  return frames.filter((_, i) => i % n === 0);
}

const api = { replay, decimate };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
root.KinetiQReplay = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
