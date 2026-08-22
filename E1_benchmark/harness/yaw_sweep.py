#!/usr/bin/env python3
"""
yaw_sweep.py — accuracy as a continuous function of camera viewing angle
=======================================================================

Tier 2 measured KinetiQ at exactly two viewpoints, because REHAB24-6 films from
exactly two. That left the shape of the curve between them unmeasured, and a
threshold placed in that gap could only be justified by interpolation.

This closes the gap by rendering the viewpoints the dataset does not contain. The
3D OptiTrack skeleton is projected through a virtual camera that orbits the subject
in yaw while holding elevation and distance fixed, and the resulting 2D landmarks
are fed to the production measurement chain. Sweeping yaw from 0 deg (the camera
looking straight down the subject's left-right axis, i.e. a true sagittal view) to
90 deg (facing the subject) produces the curve directly.

The camera orbits WITH the subject rather than sitting in world coordinates: the
subject re-orients between repetitions in this dataset, so a fixed camera would
confound viewing angle with which repetition is being performed. Holding the
relative angle constant is what isolates the variable of interest.

WHAT THIS MEASURES, AND WHAT IT DOES NOT
    Measured : the projection geometry term — how much of the true 3D joint angle
               survives being flattened into an image at a given viewing angle,
               and how the finite-state machine and scoring respond to it.
    NOT measured : MediaPipe's perception error at those angles. Landmarks here are
               projected from mocap, not detected from pixels. Real perception is
               anchored at the two viewpoints the dataset does film (see --anchor
               output), and those anchors bound how much this curve understates
               total error.

Reference is the 3D anatomical joint angle, which is what a clinician means by the
measurement; the yaw = 0 value therefore reports the floor imposed by monocular
projection even under ideal alignment.

Usage
    python yaw_sweep.py --joints3d <dir> --segmentation <csv> --out <dir>
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "analysis" / "gt_adapters"))
from rehab24_6 import FPS, JOINTS, load_segmentation, select  # noqa: E402

# MediaPipe landmark index <- REHAB24-6 joint index
MP_FROM_REHAB = {
    11: JOINTS["LeftShoulder"], 12: JOINTS["RightShoulder"],
    23: JOINTS["LeftUpLeg"],    24: JOINTS["RightUpLeg"],
    25: JOINTS["LeftLeg"],      26: JOINTS["RightLeg"],
    27: JOINTS["LeftFoot"],     28: JOINTS["RightFoot"],
    29: JOINTS["LeftFoot"],     30: JOINTS["RightFoot"],
    31: JOINTS["LeftToeBase"],  32: JOINTS["RightToeBase"],
    0:  JOINTS["Head"],
    13: JOINTS["LeftForeArm"],  14: JOINTS["RightForeArm"],
    15: JOINTS["LeftHand"],     16: JOINTS["RightHand"],
}
LEFT_IDS = {11, 23, 25, 27, 29, 31, 13, 15}
RIGHT_IDS = {12, 24, 26, 28, 30, 32, 14, 16}

FRAME_W, FRAME_H = 1280, 960          # production camera geometry


def angle3d(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """Anatomical joint angle at b, in degrees, per frame."""
    v1, v2 = a - b, c - b
    n1 = np.linalg.norm(v1, axis=-1)
    n2 = np.linalg.norm(v2, axis=-1)
    cos = np.einsum("ij,ij->i", v1, v2) / np.clip(n1 * n2, 1e-9, None)
    return np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))


def smoothed_lateral(j3d: np.ndarray, win: int = 31) -> np.ndarray:
    """
    Unit vector along the subject's left-right axis, in the horizontal plane.

    Smoothed as vectors rather than as angles: averaging headings in degrees breaks
    at the +/-180 wrap, and the subject turns around between repetitions here.
    """
    v = j3d[:, JOINTS["RightUpLeg"], :3] - j3d[:, JOINTS["LeftUpLeg"], :3]
    v[:, 1] = 0.0                                   # Y is vertical in this dataset
    n = np.linalg.norm(v, axis=1, keepdims=True)
    v = v / np.clip(n, 1e-9, None)

    k = np.ones(win) / win
    sm = np.stack([np.convolve(v[:, i], k, mode="same") for i in range(3)], axis=1)
    sm[:, 1] = 0.0
    n = np.linalg.norm(sm, axis=1, keepdims=True)
    # where smoothing cancelled (a genuine turn), fall back to the raw axis
    bad = (n[:, 0] < 1e-6)
    sm[bad] = v[bad]
    n = np.linalg.norm(sm, axis=1, keepdims=True)
    return sm / np.clip(n, 1e-9, None)


def project(j3d: np.ndarray, lateral: np.ndarray, yaw_deg: float,
            pitch_deg: float = 0.0) -> np.ndarray:
    """
    Project to normalised image coordinates for a camera at (`yaw_deg`, `pitch_deg`).

    yaw   = 0   : view direction along the subject's left-right axis (sagittal)
    yaw   = 90  : view direction along the facing axis (frontal)
    pitch = 0   : camera level with the subject's centre of mass
    pitch > 0   : camera raised, looking down  (tripod, table, held at chest height)
    pitch < 0   : camera lowered, looking up   (phone resting on the floor)

    Pitch tilts the image-up axis away from world-vertical, which foreshortens the
    limb segments along the view direction — a different distortion from yaw, and one
    users create constantly by putting the phone on the ground.
    """
    th = math.radians(yaw_deg)
    c, s = math.cos(th), math.sin(th)
    # rotate the view direction about the vertical axis
    vx = lateral[:, 0] * c - lateral[:, 2] * s
    vz = lateral[:, 0] * s + lateral[:, 2] * c
    view = np.stack([vx, np.zeros_like(vx), vz], axis=1)

    up = np.array([0.0, 1.0, 0.0])
    right = np.cross(up[None, :], view)                       # image +x, unaffected by pitch
    right /= np.clip(np.linalg.norm(right, axis=1, keepdims=True), 1e-9, None)

    # image-up axis after tilting the camera about `right`.
    # pitch 0 -> world vertical (identical to the un-pitched case);
    # pitch 90 -> straight down, where image-up maps onto the view direction.
    ph = math.radians(pitch_deg)
    cam_up = up[None, :] * math.cos(ph) - view * math.sin(ph)
    cam_up /= np.clip(np.linalg.norm(cam_up, axis=1, keepdims=True), 1e-9, None)

    pts = j3d[:, :, :3]
    centre = j3d[:, JOINTS["Hips"], :3][:, None, :] if "Hips" in JOINTS else pts.mean(axis=1, keepdims=True)
    rel = pts - centre

    x = np.einsum("fjk,fk->fj", rel, right)
    y = np.einsum("fjk,fk->fj", rel, cam_up)

    # Emit coordinates the way MediaPipe does: pixel position divided by frame WIDTH
    # for x and by frame HEIGHT for y. That normalisation is anisotropic whenever
    # W != H, and the production chain corrects for exactly that (TECH_SPEC 5.1.1).
    # Producing isotropic coordinates here would make the app's correction introduce
    # distortion rather than remove it, and would also put the alignment metric on a
    # different footing than the one it sees in the field.
    #
    # Scale: the subject occupies a fixed fraction of frame height at every yaw, so
    # the sweep varies viewing angle and nothing else.
    subject_m = 2.0
    s_px = 0.85 * FRAME_H / subject_m          # pixels per metre
    px = FRAME_W / 2.0 + s_px * x
    py = FRAME_H / 2.0 - s_px * y
    nx = px / FRAME_W
    ny = py / FRAME_H
    return np.stack([nx, ny], axis=2)


def to_landmarks(xy: np.ndarray, near: str) -> list:
    near_ids, far_ids = (LEFT_IDS, RIGHT_IDS) if near == "left" else (RIGHT_IDS, LEFT_IDS)
    frames = []
    for f in range(xy.shape[0]):
        lm = [{"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 0.1} for _ in range(33)]
        for mp_i, re_i in MP_FROM_REHAB.items():
            vis = 0.99 if mp_i in near_ids else (0.70 if mp_i in far_ids else 0.90)
            lm[mp_i] = {"x": float(xy[f, re_i, 0]), "y": float(xy[f, re_i, 1]),
                        "z": 0.0, "visibility": vis}
        frames.append(lm)
    return frames


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--joints3d", type=Path, required=True)
    ap.add_argument("--segmentation", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--exercise", type=int, default=6)
    ap.add_argument("--yaws", type=str, default="0,5,10,15,20,25,30,35,40,45,50,60,70,80,90")
    ap.add_argument("--pitches", type=str, default="-40,-30,-20,-15,-10,-5,5,10,15,20,30,40",
                    help="pitch angles rendered at yaw=0; 0 is already covered by the yaw sweep")
    a = ap.parse_args()

    yaws = [float(y) for y in a.yaws.split(",")]
    pitches = [float(p) for p in a.pitches.split(",")] if a.pitches.strip() else []
    # yaw sweep at level camera, plus a pitch sweep at the recommended alignment
    viewpoints = [(y, 0.0) for y in yaws] + [(0.0, p) for p in pitches]
    reps = select(load_segmentation(a.segmentation), exercise_id=a.exercise, view=None)
    by_rec: dict[str, list] = {}
    for r in reps:
        by_rec.setdefault(r.video_id, []).append(r)

    a.out.mkdir(parents=True, exist_ok=True)
    manifest = {"yaws": yaws, "pitches": pitches,
                "viewpoints": [{"yaw": y, "pitch": p, "key": f"y{y:g}p{p:g}"} for y, p in viewpoints],
                "recordings": [], "frame": [FRAME_W, FRAME_H]}

    for video_id, rlist in sorted(by_rec.items()):
        cand = list(Path(a.joints3d).rglob(f"{video_id}-30fps.npy"))
        if not cand:
            continue
        j3d = np.load(cand[0])
        lateral = smoothed_lateral(j3d)

        # reference: 3D anatomical angles, independent of any camera
        ref = {
            "knee_left":  angle3d(j3d[:, JOINTS["LeftUpLeg"], :3],  j3d[:, JOINTS["LeftLeg"], :3],  j3d[:, JOINTS["LeftFoot"], :3]),
            "knee_right": angle3d(j3d[:, JOINTS["RightUpLeg"], :3], j3d[:, JOINTS["RightLeg"], :3], j3d[:, JOINTS["RightFoot"], :3]),
            "hip_left":   angle3d(j3d[:, JOINTS["LeftShoulder"], :3],  j3d[:, JOINTS["LeftUpLeg"], :3],  j3d[:, JOINTS["LeftLeg"], :3]),
            "hip_right":  angle3d(j3d[:, JOINTS["RightShoulder"], :3], j3d[:, JOINTS["RightUpLeg"], :3], j3d[:, JOINTS["RightLeg"], :3]),
        }

        payload = {
            "video_id": video_id,
            "fps": FPS,
            "n_frames": int(j3d.shape[0]),
            "reference_3d": {k: [round(float(x), 4) for x in v] for k, v in ref.items()},
            "annotated_repetitions": [
                {"repetition_number": r.repetition_number, "first_frame": r.first_frame,
                 "last_frame": r.last_frame, "correctness": r.correctness,
                 "mocap_erroneous": r.mocap_erroneous}
                for r in sorted(rlist, key=lambda x: x.first_frame)
            ],
            "views": {},
        }
        for y, pch in viewpoints:
            xy = project(j3d, lateral, y, pch)
            payload["views"][f"y{y:g}p{pch:g}"] = {
                "yaw": y, "pitch": pch,
                "frames": [{"t": round(i / FPS, 6), "landmarks": lm}
                           for i, lm in enumerate(to_landmarks(xy, near="left"))]
            }
        (a.out / f"{video_id}_yaw.json").write_text(json.dumps(payload))
        manifest["recordings"].append(video_id)
        print(f"  {video_id}: {len(viewpoints)} viewpoints x {j3d.shape[0]} frames")

    (a.out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"\nwrote {len(manifest['recordings'])} recordings -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
