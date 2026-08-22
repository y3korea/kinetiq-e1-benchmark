#!/usr/bin/env python3
"""
tier2_reference.py — Tier 2 reference angles from the dataset's own 2D projections
==================================================================================

Tier 2 compares KinetiQ's image-plane angles against a reference computed in the
SAME image plane. REHAB24-6 publishes the projection of every mocap joint into
each camera, so the reference needs no projection assumptions of our own — this
is what makes Tier 2 stronger than Tier 1.5, where the sagittal plane had to be
estimated anatomically.

Camera 18 is used: the dataset states that facing the horizontal camera (17)
yields a profile view from the other, so `cam17_orientation == 'front'` marks the
repetitions that camera 18 sees sagittally. Repetitions labelled 'half-profile'
are oblique in both cameras and form a separate view-robustness stratum rather
than being discarded.

Side selection: KinetiQ picks the limb with the higher mean landmark visibility,
which under a profile view is the camera-near limb. Because that choice is made
inside the app from MediaPipe's visibilities, the reference is emitted for BOTH
limbs and the analysis reports against each, rather than assuming one.

Usage
    python tier2_reference.py --joints2d <dir> --segmentation <csv> --out <dir>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "analysis" / "gt_adapters"))
from rehab24_6 import (  # noqa: E402
    FPS, EXERCISES, JOINTS, load_segmentation, select, compute_reference_angles,
)

CAMERA = "c18"


IMG_W_EARLY = 1080.0


def load_2d(path: Path) -> np.ndarray:
    """(frames, 26, 2) pixel coordinates in the transposed camera-18 image."""
    a = np.load(path)
    if a.ndim != 3 or a.shape[1] != 26:
        raise ValueError(f"{path.name}: unexpected shape {a.shape}")
    return a[:, :, :2].astype(float)


# Camera-18 transposed frame size, per the dataset description.
IMG_W, IMG_H = 1080.0, 1920.0

MP_FROM_REHAB = {
    11: JOINTS["LeftShoulder"], 12: JOINTS["RightShoulder"],
    23: JOINTS["LeftUpLeg"],    24: JOINTS["RightUpLeg"],
    25: JOINTS["LeftLeg"],      26: JOINTS["RightLeg"],
    27: JOINTS["LeftFoot"],     28: JOINTS["RightFoot"],
    31: JOINTS["LeftToeBase"],  32: JOINTS["RightToeBase"],
    29: JOINTS["LeftFoot"],     30: JOINTS["RightFoot"],
    0:  JOINTS["Head"],
    13: JOINTS["LeftForeArm"],  14: JOINTS["RightForeArm"],
    15: JOINTS["LeftHand"],     16: JOINTS["RightHand"],
}


def to_landmarks_from_pixels(j2d: np.ndarray, analysis_side: str = "left") -> list:
    """
    Pack camera-18 pixel joints into MediaPipe's normalised landmark format.

    This produces the CONTROL condition for Tier 2: the same image plane and the
    same reference, but with perfect perception. Subtracting its error from the
    Tier 2 error isolates the MediaPipe contribution exactly, which the Tier 1.5
    comparison could only approximate because it used a different (anatomical)
    projection plane.

    No y flip is applied — camera pixel coordinates already increase downward,
    as MediaPipe's do.
    """
    nx = j2d[:, :, 0] / IMG_W
    ny = j2d[:, :, 1] / IMG_H

    LEFT_IDS = {11, 23, 25, 27, 29, 31, 13, 15}
    RIGHT_IDS = {12, 24, 26, 28, 30, 32, 14, 16}
    near, far = (LEFT_IDS, RIGHT_IDS) if analysis_side == "left" else (RIGHT_IDS, LEFT_IDS)

    frames = []
    for f in range(j2d.shape[0]):
        lm = [{"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 0.1} for _ in range(33)]
        for mp_i, re_i in MP_FROM_REHAB.items():
            vis = 0.99 if mp_i in near else (0.70 if mp_i in far else 0.90)
            lm[mp_i] = {"x": float(nx[f, re_i]), "y": float(ny[f, re_i]),
                        "z": 0.0, "visibility": vis}
        frames.append(lm)
    return frames


def export(joints2d_root: Path, segmentation: Path, out_dir: Path,
           exercise: int = 6, emit_control: bool = True) -> dict:
    reps = load_segmentation(segmentation)
    sel = select(reps, exercise_id=exercise, view=None)
    out_dir.mkdir(parents=True, exist_ok=True)

    by_rec: dict[str, list] = {}
    for r in sel:
        by_rec.setdefault(r.video_id, []).append(r)

    written, skipped = [], []
    for video_id, rlist in sorted(by_rec.items()):
        cand = list(Path(joints2d_root).rglob(f"{video_id}-{CAMERA}-30fps.npy"))
        if not cand:
            skipped.append((video_id, "no 2d joint file"))
            continue
        j2d = load_2d(cand[0])

        # Image coordinates: y increases downward, matching MediaPipe's frame and
        # KinetiQ's angle conventions, so no axis handling is needed here.
        # TWO reference spaces, because the app's angles live in a different one
        # than the image does:
        #
        #   reference_2d          true image-plane angles from pixel coordinates.
        #                         The anatomically correct answer, and therefore
        #                         the basis of the end-to-end product error.
        #
        #   reference_2d_appspace the same joints expressed in MediaPipe's
        #                         normalised coordinates (x/W, y/H) — the space
        #                         KinetiQ actually computes in. Because W != H
        #                         this scaling is anisotropic and does not
        #                         preserve angles, so the two references differ
        #                         systematically. Scoring against this one
        #                         isolates perception error from the app's
        #                         coordinate-convention error.
        ref = {side: compute_reference_angles(j2d, side=side) for side in ("left", "right")}

        j_app = j2d.copy()
        j_app[:, :, 0] /= IMG_W
        j_app[:, :, 1] /= IMG_H
        ref_app = {side: compute_reference_angles(j_app, side=side) for side in ("left", "right")}

        payload = {
            "dataset": "REHAB24-6",
            "doi": "10.5281/zenodo.13305826",
            "video_id": video_id,
            "camera": "Camera18 (transposed, 1080x1920)",
            "exercise": EXERCISES.get(exercise),
            "person_id": rlist[0].person_id,
            "fps": FPS,
            "n_frames": int(j2d.shape[0]),
            "reference_note": "dataset-published 2D projection of OptiTrack mocap joints "
                              "into camera 18; no projection assumption of our own",
            "annotated_repetitions": [
                {
                    "repetition_number": r.repetition_number,
                    "first_frame": r.first_frame,
                    "last_frame": r.last_frame,
                    "correctness": r.correctness,
                    "cam17_orientation": r.cam17_orientation,
                    # camera 18 is sagittal exactly when camera 17 sees the front
                    "cam18_sagittal": r.cam17_orientation == "front",
                    "mocap_erroneous": r.mocap_erroneous,
                }
                for r in sorted(rlist, key=lambda x: x.first_frame)
            ],
            "reference_2d": {
                side: {k: [round(float(x), 4) for x in v] for k, v in ref[side].items()}
                for side in ("left", "right")
            },
            "reference_2d_appspace": {
                side: {k: [round(float(x), 4) for x in v] for k, v in ref_app[side].items()}
                for side in ("left", "right")
            },
        }
        dest = out_dir / f"{video_id}_ref.json"
        dest.write_text(json.dumps(payload))
        written.append(dest.name)

        if emit_control:
            ctrl = dict(payload)
            ctrl["tier"] = "2-control (camera-18 mocap joints into the core; perfect perception)"
            ctrl["frames"] = [
                {"t": round(i / FPS, 6), "landmarks": lmf}
                for i, lmf in enumerate(to_landmarks_from_pixels(j2d, analysis_side="left"))
            ]
            (out_dir / f"{video_id}_control.json").write_text(json.dumps(ctrl))

    manifest = {"camera": CAMERA, "recordings": len(written), "skipped": skipped, "files": written}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--joints2d", type=Path, required=True)
    ap.add_argument("--segmentation", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--exercise", type=int, default=6)
    a = ap.parse_args()
    m = export(a.joints2d, a.segmentation, a.out, a.exercise)
    print(f"wrote {m['recordings']} reference files -> {a.out}")
    if m["skipped"]:
        print("  skipped:", m["skipped"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
