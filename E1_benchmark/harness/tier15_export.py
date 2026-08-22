#!/usr/bin/env python3
"""
tier15_export.py — Tier 1.5: mocap ground truth -> production pipeline
======================================================================

Tier 1.5 sits between the synthetic Tier 0 and the end-to-end Tier 2. It feeds
REAL human movement (REHAB24-6 OptiTrack mocap, 30 fps) into the verbatim
production measurement chain, bypassing MediaPipe entirely.

    Tier 0    synthetic kinematics  -> app      (idealised motion, perfect input)
    Tier 1.5  real mocap            -> app      (REAL motion, perfect input)  <-- here
    Tier 2    real video -> MediaPipe -> app    (real motion, real perception)

Why it is worth running on its own: it answers "how does the application behave
on genuine human movement when perception is not the limiting factor?" Anything
that goes wrong here is a logic defect, not a pose-estimation problem, and the
comparison Tier 2 - Tier 1.5 isolates the perception contribution.

Emits one JSON per RECORDING (not per repetition), because the production FSM
is a continuous-session state machine: replaying isolated repetition windows
starts the exponential moving average mid-movement and manufactures phantom
repetitions from its warm-up transient. That is a harness artifact, not app
behaviour, and it was observed before this design was adopted. Whole-recording
replay reproduces how the app is actually used and removes the artifact; the
annotated repetition intervals are then matched against detected repetitions
post hoc.

Note the mocap reference is camera-independent and the sagittal projection here
is anatomically defined (perpendicular to the hip-to-hip axis), so every Ex6
repetition is usable at this tier, not only those with a profile camera. The
camera orientation constrains Tier 2 (video) only.

Usage
    python tier15_export.py --joints <dir> --segmentation <Segmentation.csv> \
                            --exercise 6 --out ../data/tier15/
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "analysis" / "gt_adapters"))
from rehab24_6 import (  # noqa: E402
    FPS, EXERCISES, load_segmentation, select, find_joint_file, load_joint_file,
    project_to_sagittal, to_mediapipe_landmarks, compute_reference_angles,
)


def export(joints_root: Path, segmentation: Path, out_dir: Path,
           exercise: int = 6, view: str = "all", side: str = "left") -> dict:
    reps = load_segmentation(segmentation)
    sel = select(reps, exercise_id=exercise, view=None if view == "all" else view)
    out_dir.mkdir(parents=True, exist_ok=True)

    by_recording: dict[str, list] = {}
    for r in sel:
        by_recording.setdefault(r.video_id, []).append(r)

    written, skipped = [], []
    for video_id, rlist in sorted(by_recording.items()):
        jf = find_joint_file(joints_root, video_id)
        if jf is None:
            skipped.append((video_id, "no joint file"))
            continue
        rec = load_joint_file(jf)

        sag = project_to_sagittal(rec)
        frames = to_mediapipe_landmarks(sag, analysis_side=side)
        ref3d = compute_reference_angles(rec, side=side, vertical_axis=1)
        ref2d = compute_reference_angles(sag, side=side)

        payload = {
            "dataset": "REHAB24-6",
            "doi": "10.5281/zenodo.13305826",
            "license": "CC BY-NC 4.0",
            "video_id": video_id,
            "exercise_id": exercise,
            "exercise": EXERCISES.get(exercise),
            "person_id": rlist[0].person_id,
            "fps": FPS,
            "side": side,
            "n_frames": len(frames),
            "tier": "1.5 (mocap ground truth into production core, perception bypassed)",
            "replay_unit": "whole recording (continuous session, as in production)",
            "annotated_repetitions": [
                {
                    "repetition_number": r.repetition_number,
                    "first_frame": r.first_frame,
                    "last_frame": r.last_frame,
                    "correctness": r.correctness,
                    "cam17_orientation": r.cam17_orientation,
                    "sagittal_camera": r.sagittal_camera,
                    "mocap_erroneous": r.mocap_erroneous,
                }
                for r in sorted(rlist, key=lambda x: x.first_frame)
            ],
            "frames": [
                {"t": round(i / FPS, 6), "landmarks": frames[i]}
                for i in range(len(frames))
            ],
            "reference_3d": {k: [round(float(x), 4) for x in v] for k, v in ref3d.items()},
            "reference_2d_sagittal": {k: [round(float(x), 4) for x in v] for k, v in ref2d.items()},
        }

        dest = out_dir / f"{video_id}.json"
        dest.write_text(json.dumps(payload))
        written.append(dest.name)

    manifest = {
        "dataset": "REHAB24-6",
        "exercise": EXERCISES.get(exercise),
        "view_filter": view,
        "side": side,
        "replay_unit": "whole recording",
        "recordings_written": len(written),
        "repetitions_covered": sum(len(v) for k, v in by_recording.items()
                                   if f"{k}.json" in written),
        "skipped": skipped,
        "files": written,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description="Tier 1.5 export: mocap -> production core")
    ap.add_argument("--joints", type=Path, required=True)
    ap.add_argument("--segmentation", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--exercise", type=int, default=6)
    ap.add_argument("--view", default="all", choices=["sagittal", "half-profile", "all"])
    ap.add_argument("--side", default="left", choices=["left", "right"])
    a = ap.parse_args()

    m = export(a.joints, a.segmentation, a.out, a.exercise, a.view, a.side)
    print(f"{m['exercise']}: wrote {m['recordings_written']} recordings covering "
          f"{m['repetitions_covered']} annotated repetitions -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
