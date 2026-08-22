/**
 * synth_kinematics.js — analytically exact synthetic squat kinematics
 * ====================================================================
 *
 * PURPOSE
 * -------
 * Generates MediaPipe-format landmark frames for a sagittal-plane squat whose
 * joint angles are known EXACTLY, because the skeleton is constructed *from*
 * those angles by forward kinematics rather than measured from an image.
 *
 * This supplies Tier 0 of the E1 error decomposition:
 *
 *   Tier 0  synthetic landmarks -> KinetiQ core
 *           isolates the app's own angle math + FSM. Ground truth is exact to
 *           machine precision. Any error here is a software defect, not a
 *           perception limit.
 *
 *   Tier 1  rendered video -> MediaPipe -> KinetiQ core
 *           adds pose-estimation error against a still-exact ground truth.
 *
 *   Tier 2  real dataset video -> MediaPipe -> KinetiQ core
 *           the end-to-end product error, ground truth from marker mocap.
 *
 * CONSTRUCTION AND ITS GUARANTEE
 * ------------------------------
 * Working in image coordinates (x right, y DOWN — the MediaPipe convention),
 * the chain is built distally from the ankle:
 *
 *   ankle A            placed directly
 *   knee  K = A + L_shank * u(phi_shank)
 *   hip   H = K + L_thigh * rot(unit(A - K), +theta_knee)
 *   shoulder S = H + L_trunk * rot(unit(K - H), +theta_hip)
 *   foot  F = A + L_foot  * rot(unit(K - A), +theta_ankle)
 *
 * Because each distal segment is placed by rotating the *incoming* segment
 * direction by the prescribed interior angle, the identity
 *
 *      angle(H, K, A) === theta_knee      (and likewise for hip, ankle)
 *
 * holds by construction, independent of any angle-measuring code. The app's
 * calcAngle() is therefore tested against a value it had no part in producing.
 *
 * Trunk lean is the one DERIVED quantity: it falls out of theta_hip and the
 * thigh orientation. Its ground truth is computed here with an atan2 formula
 * over the constructed shoulder/hip positions and is flagged `derived: true`.
 *
 * All lengths are in normalised image units (0..1), matching MediaPipe's
 * landmark space, so the output is resolution-independent — exactly like the
 * production pipeline, whose angle math never sees pixels.
 */

/* eslint-disable */
(function (root) {
'use strict';

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Anthropometry (normalised image units). Proportions follow Winter (2009)
// segment-length fractions of stature, scaled so a standing figure occupies
// ~0.8 of frame height.
// ---------------------------------------------------------------------------
const DEFAULT_SEGMENTS = {
  foot:  0.055,
  shank: 0.220,
  thigh: 0.225,
  trunk: 0.280,
  shoulderWidth: 0.070,
  hipWidth: 0.055,
};

/** Unit vector at `deg` from vertical-up, in a y-DOWN image frame. */
function unitFromVertical(deg) {
  const r = deg * DEG;
  return { x: Math.sin(r), y: -Math.cos(r) };
}

function unit(v) {
  const m = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / m, y: v.y / m };
}

function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function add(p, v, s) { return { x: p.x + v.x * s, y: p.y + v.y * s }; }

/** Rotate v by `deg`. Positive = clockwise on screen in a y-down frame. */
function rot(v, deg) {
  const r = deg * DEG, c = Math.cos(r), s = Math.sin(r);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/**
 * Interior angle at b, computed independently of the app's calcAngle():
 * cross/dot with atan2 rather than a normalised dot product with acos.
 * Used to self-check the construction and to derive trunk lean.
 */
function interiorAngle(a, b, c) {
  const ba = sub(a, b), bc = sub(c, b);
  const cross = ba.x * bc.y - ba.y * bc.x;
  const dot = ba.x * bc.x + ba.y * bc.y;
  return Math.abs(Math.atan2(cross, dot)) / DEG;
}

/** Trunk inclination from vertical, y-down frame. Mirrors calcTrunk's semantics. */
function trunkLean(shoulder, hip) {
  return Math.atan2(Math.abs(shoulder.x - hip.x), Math.abs(shoulder.y - hip.y)) / DEG;
}

// ---------------------------------------------------------------------------
// Pose construction
// ---------------------------------------------------------------------------
/**
 * Build one sagittal pose from prescribed interior angles.
 *
 * @param {object} spec
 *   kneeDeg   interior angle hip-knee-ankle   (180 = straight leg)
 *   hipDeg    interior angle shoulder-hip-knee(180 = straight torso/thigh line)
 *   ankleDeg  interior angle knee-ankle-foot  (~90 = neutral)
 *   shankDeg  shank orientation from vertical (forward shin travel)
 *   facing    +1 = subject faces +x (screen right), -1 = faces -x
 *   ankleAt   {x, y} ankle position in normalised units
 * @returns {object} joints + exact ground-truth angles
 */
function buildPose(spec) {
  const S = Object.assign({}, DEFAULT_SEGMENTS, spec.segments || {});
  const facing = spec.facing === undefined ? 1 : spec.facing;
  const A = spec.ankleAt || { x: 0.5, y: 0.88 };

  // Shank: ankle -> knee, leaning `shankDeg` toward the facing direction.
  const shankDir = unitFromVertical(facing * spec.shankDeg);
  const K = add(A, shankDir, S.shank);

  // Thigh: rotate the knee->ankle direction by the prescribed knee angle.
  const kneeToAnkle = unit(sub(A, K));
  const thighDir = rot(kneeToAnkle, facing * spec.kneeDeg);
  const H = add(K, thighDir, S.thigh);

  // Trunk: rotate the hip->knee direction by the prescribed hip angle.
  const hipToKnee = unit(sub(K, H));
  const trunkDir = rot(hipToKnee, -facing * spec.hipDeg);
  const Sh = add(H, trunkDir, S.trunk);

  // Foot: rotate the ankle->knee direction by the prescribed ankle angle.
  const ankleToKnee = unit(sub(K, A));
  const footDir = rot(ankleToKnee, -facing * spec.ankleDeg);
  const F = add(A, footDir, S.foot);

  const gt = {
    // exact by construction
    knee: interiorAngle(H, K, A),
    hip: interiorAngle(Sh, H, K),
    ankle: interiorAngle(K, A, F),
    // derived from the constructed geometry
    trunk: trunkLean(Sh, H),
  };

  return { joints: { ankle: A, knee: K, hip: H, shoulder: Sh, foot: F }, gt };
}

// ---------------------------------------------------------------------------
// MediaPipe landmark packing
// ---------------------------------------------------------------------------
const LM = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_FOOT: 31, R_FOOT: 32,
};

/**
 * Pack a constructed pose into a 33-point MediaPipe landmark array.
 *
 * `side` selects which limb carries the pose. The opposite limb is given a
 * small lateral offset and LOWER visibility, so the production visible-side
 * selection in onPoseResults() picks the intended side — exercising that
 * selection logic rather than bypassing it.
 */
function toLandmarks(pose, opts) {
  opts = opts || {};
  const side = opts.side || 'left';
  const visNear = opts.visNear === undefined ? 0.95 : opts.visNear;
  const visFar = opts.visFar === undefined ? 0.60 : opts.visFar;
  const dz = opts.lateralOffset === undefined ? 0.02 : opts.lateralOffset;

  const J = pose.joints;
  const lm = new Array(33);
  for (let i = 0; i < 33; i++) lm[i] = { x: 0.5, y: 0.5, z: 0, visibility: 0.1 };

  const near = { v: visNear, o: 0 };
  const far = { v: visFar, o: dz };
  const L = side === 'left' ? near : far;
  const R = side === 'left' ? far : near;

  const put = (idx, p, cfg, zOff) => {
    lm[idx] = { x: p.x + cfg.o, y: p.y, z: zOff || 0, visibility: cfg.v };
  };

  put(LM.L_SHOULDER, J.shoulder, L); put(LM.R_SHOULDER, J.shoulder, R);
  put(LM.L_HIP, J.hip, L);           put(LM.R_HIP, J.hip, R);
  put(LM.L_KNEE, J.knee, L);         put(LM.R_KNEE, J.knee, R);
  put(LM.L_ANKLE, J.ankle, L);       put(LM.R_ANKLE, J.ankle, R);
  put(LM.L_FOOT, J.foot, L);         put(LM.R_FOOT, J.foot, R);

  // Heels: behind the ankle along the reversed foot direction.
  const footDir = unit(sub(J.foot, J.ankle));
  const heel = add(J.ankle, footDir, -0.035);
  put(LM.L_HEEL, heel, L); put(LM.R_HEEL, heel, R);

  // Head/arms: not used by any measured angle, but present so the frame is a
  // well-formed pose (and renderable for Tier 1).
  const up = unit(sub(J.shoulder, J.hip));
  put(LM.NOSE, add(J.shoulder, up, 0.10), { v: 0.9, o: 0 });
  const armDown = { x: 0, y: 1 };
  put(LM.L_ELBOW, add(J.shoulder, armDown, 0.11), L);
  put(LM.R_ELBOW, add(J.shoulder, armDown, 0.11), R);
  put(LM.L_WRIST, add(J.shoulder, armDown, 0.21), L);
  put(LM.R_WRIST, add(J.shoulder, armDown, 0.21), R);

  return lm;
}

// ---------------------------------------------------------------------------
// Movement trajectories
// ---------------------------------------------------------------------------
/**
 * Smooth 0->1->0 depth profile for one repetition.
 * `descentS` / `bottomS` / `ascentS` are durations in seconds; the descent and
 * ascent use a raised-cosine (minimum-jerk-like) profile so velocity is zero at
 * the turnarounds, as in real lifting.
 */
function repDepthProfile(t, descentS, bottomS, ascentS) {
  const total = descentS + bottomS + ascentS;
  if (t <= 0) return 0;
  if (t >= total) return 0;
  if (t < descentS) {
    const u = t / descentS;
    return 0.5 * (1 - Math.cos(Math.PI * u));
  }
  if (t < descentS + bottomS) return 1;
  const u = (t - descentS - bottomS) / ascentS;
  return 0.5 * (1 + Math.cos(Math.PI * u));
}

/**
 * Generate a full synthetic squat session.
 *
 * @param {object} cfg
 *   reps          number of repetitions
 *   fps           sampling rate of the generated frames
 *   descentS/bottomS/ascentS/restS  per-rep phase durations (seconds)
 *   standKnee/bottomKnee            knee angle at top and at depth
 *   standHip/bottomHip              hip angle at top and at depth
 *   standAnkle/bottomAnkle          ankle angle at top and at depth
 *   standShank/bottomShank          shank lean at top and at depth
 *   noiseDeg      optional gaussian landmark jitter, in normalised units*1000
 * @returns {{frames: Array, config: object}}
 *   frames[i] = { t, landmarks, gt: {knee, hip, trunk, ankle}, depth }
 */
function generateSession(cfg) {
  const c = Object.assign({
    reps: 5, fps: 30,
    descentS: 2.0, bottomS: 0.4, ascentS: 1.5, restS: 1.2,
    standKnee: 175, bottomKnee: 90,
    standHip: 175, bottomHip: 75,
    standAnkle: 90, bottomAnkle: 75,
    standShank: 2, bottomShank: 22,
    side: 'left', facing: 1,
    noiseDeg: 0,
    seed: 12345,
  }, cfg || {});

  // Deterministic PRNG (mulberry32) so runs are byte-reproducible.
  let s = c.seed >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(1e-9, rand()), v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const repS = c.descentS + c.bottomS + c.ascentS + c.restS;
  const activeS = c.descentS + c.bottomS + c.ascentS;
  const totalS = repS * c.reps;
  const dt = 1 / c.fps;
  const frames = [];
  const lerp = (a, b, u) => a + (b - a) * u;

  for (let t = 0; t <= totalS + 1e-9; t += dt) {
    const inRep = t % repS;
    const depth = inRep <= activeS ? repDepthProfile(inRep, c.descentS, c.bottomS, c.ascentS) : 0;

    const pose = buildPose({
      kneeDeg: lerp(c.standKnee, c.bottomKnee, depth),
      hipDeg: lerp(c.standHip, c.bottomHip, depth),
      ankleDeg: lerp(c.standAnkle, c.bottomAnkle, depth),
      shankDeg: lerp(c.standShank, c.bottomShank, depth),
      facing: c.facing,
      segments: c.segments,
      ankleAt: c.ankleAt,
    });

    let lm = toLandmarks(pose, { side: c.side });
    if (c.noiseDeg > 0) {
      const sd = c.noiseDeg / 1000;
      lm = lm.map(p => ({ x: p.x + gauss() * sd, y: p.y + gauss() * sd, z: p.z, visibility: p.visibility }));
    }

    frames.push({
      t: Math.round(t * 1e6) / 1e6,
      landmarks: lm,
      gt: pose.gt,
      depth,
      repIndex: Math.floor(t / repS),
    });
  }

  return { frames, config: c, repDurationS: repS, totalS };
}

const api = {
  DEFAULT_SEGMENTS, LM,
  buildPose, toLandmarks, generateSession, repDepthProfile,
  interiorAngle, trunkLean,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
root.KinetiQSynth = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
