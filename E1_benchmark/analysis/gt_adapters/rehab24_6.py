#!/usr/bin/env python3
"""
rehab24_6.py — ground-truth adapter for the REHAB24-6 dataset
==============================================================

Dataset
    Cernek A., Sedmidubsky J., Budikova P. "REHAB24-6: Physical Therapy Dataset
    for Analyzing Pose Estimation Methods." SISAP 2024.
    Zenodo 10.5281/zenodo.13305826 · CC BY-NC 4.0 (academic / non-profit only)

Why this dataset for E1
    - OptiTrack, 41 markers -> 26-joint 3D skeleton: marker-based gold standard.
    - The authors also publish the *2D projection of every joint into each
      camera*, so KinetiQ's image-plane angles can be compared against a
      reference computed in the same plane, isolating projection error from
      perception error (see compare.decompose_error).
    - 30 fps, matching the production sampling rate exactly — no resampling.
    - 1,072 repetitions with start/end frames: repetition-count ground truth.
    - Physiotherapist correctness labels (568 correct / 504 incorrect):
      supports a score-validity experiment beyond angle accuracy.

Camera geometry (from the dataset description)
    Two synchronised RGB cameras: Camera17 horizontal (wide FoV), Camera18
    vertical (narrow FoV), in opposite corners. "Facing the horizontal camera
    resulted in a front view for that camera and a profile from the other."

    Therefore, for a SAGITTAL view — which is what KinetiQ's 2D angle
    definitions assume — select:

        cam17_orientation == 'front'   ->  use Camera18   (subject in profile)

    Rows labelled 'half-profile' are oblique in both cameras and are excluded
    from the primary angle analysis; they are retained as a separate
    view-robustness stratum, since off-axis viewing is exactly the condition
    the production app cannot control in the field.

Exercises (exercise_id)
    1 Arm abduction · 2 Arm VW · 3 Push-ups (hands on table) ·
    4 Leg abduction · 5 Leg lunge · 6 Squats

    E1 primary  : Ex6 (Squats), 195 repetitions
    E1 secondary: Ex3 (Push-ups) — note these are TABLE push-ups, so any claim
                  about standard floor push-ups is not supported by this data.

Angle definitions
    Reproduces KinetiQ's definitions exactly (index.html: calcAngle, calcTrunk)
    so that the comparison is like-for-like:

        knee  = interior angle (hip, knee, ankle)
        hip   = interior angle (shoulder, hip, knee)
        ankle = interior angle (knee, ankle, toe)
        trunk = inclination of the shoulder->hip segment from vertical

    Joint correspondence, REHAB 26-joint skeleton -> KinetiQ landmark roles:

        KinetiQ (MediaPipe)      REHAB24-6
        -----------------------  ---------------------------
        shoulder  (11 / 12)      LeftShoulder 6  / RightShoulder 11
        hip       (23 / 24)      LeftUpLeg   16  / RightUpLeg   21
        knee      (25 / 26)      LeftLeg     17  / RightLeg     22
        ankle     (27 / 28)      LeftFoot    18  / RightFoot    23
        foot idx  (31 / 32)      LeftToeBase 19  / RightToeBase 24

    LIMITATION, to be stated in the paper: MediaPipe landmarks are learned
    surface keypoints while REHAB joints are mocap-derived joint centres. The
    shoulder correspondence is the weakest (acromion-like vs skeletal joint),
    which is one reason hip-angle agreement is expected to be poorer than knee
    agreement — consistent with the published MediaPipe validation literature.

Usage
    python rehab24_6.py --inspect <extracted_dir>
    python rehab24_6.py --root <extracted_dir> --exercise 6 --view sagittal \
                        --out ../../data/gt/ref_ex6/
    python rehab24_6.py --selftest
"""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# ---------------------------------------------------------------------------
# Skeleton definition
# ---------------------------------------------------------------------------
JOINTS = {
    "Hips": 0, "Spine": 1, "Spine1": 2, "Neck": 3, "Head": 4, "Head_end": 5,
    "LeftShoulder": 6, "LeftArm": 7, "LeftForeArm": 8, "LeftHand": 9, "LeftHand_end": 10,
    "RightShoulder": 11, "RightArm": 12, "RightForeArm": 13, "RightHand": 14, "RightHand_end": 15,
    "LeftUpLeg": 16, "LeftLeg": 17, "LeftFoot": 18, "LeftToeBase": 19, "LeftToeBase_end": 20,
    "RightUpLeg": 21, "RightLeg": 22, "RightFoot": 23, "RightToeBase": 24, "RightToeBase_end": 25,
}

SIDE_CHAIN = {
    "left":  {"shoulder": 6,  "hip": 16, "knee": 17, "ankle": 18, "toe": 19},
    "right": {"shoulder": 11, "hip": 21, "knee": 22, "ankle": 23, "toe": 24},
}

EXERCISES = {
    1: "Arm abduction", 2: "Arm VW", 3: "Push-ups (table)",
    4: "Leg abduction", 5: "Leg lunge", 6: "Squats",
}

FPS = 30.0


# ---------------------------------------------------------------------------
# Angle computation — mirrors KinetiQ's definitions
# ---------------------------------------------------------------------------
def interior_angle(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> np.ndarray:
    """
    Interior angle at b, in degrees, for stacked frames.
    Works for 2D or 3D input; arrays are (N, D).

    Uses atan2(|cross|, dot) rather than acos(dot/|..|) for numerical stability
    near 0 and 180 degrees. KinetiQ's calcAngle uses the acos form; the two are
    mathematically identical, and the difference is below 1e-9 degrees over the
    working range — verified in selftest().
    """
    ba = np.asarray(a, float) - np.asarray(b, float)
    bc = np.asarray(c, float) - np.asarray(b, float)
    dot = np.einsum("ij,ij->i", ba, bc)
    if ba.shape[1] == 2:
        cross = np.abs(ba[:, 0] * bc[:, 1] - ba[:, 1] * bc[:, 0])
    else:
        cross = np.linalg.norm(np.cross(ba, bc), axis=1)
    return np.degrees(np.arctan2(cross, dot))


def trunk_lean(shoulder: np.ndarray, hip: np.ndarray, vertical_axis: int = 1) -> np.ndarray:
    """
    Inclination of the shoulder->hip segment from vertical, in degrees.

    Mirrors calcTrunk: atan2(|dx|, |dy|) in image coordinates. For 3D input the
    horizontal displacement is the norm over the two non-vertical axes.
    """
    s = np.asarray(shoulder, float)
    h = np.asarray(hip, float)
    d = s - h
    if d.shape[1] == 2:
        horiz = np.abs(d[:, 0])
        vert = np.abs(d[:, 1])
    else:
        axes = [i for i in range(3) if i != vertical_axis]
        horiz = np.linalg.norm(d[:, axes], axis=1)
        vert = np.abs(d[:, vertical_axis])
    return np.degrees(np.arctan2(horiz, vert))


def project_to_sagittal(joints: np.ndarray, vertical_axis: int = 1,
                        smooth_frames: int = 15) -> np.ndarray:
    """
    Project 3D mocap joints onto the subject's own sagittal plane.

    The sagittal plane is perpendicular to the medio-lateral axis, estimated
    PER FRAME from the left-hip -> right-hip vector and flattened to horizontal,
    then smoothed over `smooth_frames` to suppress marker jitter.

    Per-frame estimation is essential, not a refinement: REHAB24-6 subjects
    change facing direction within a recording (each exercise is performed in
    two directions). A single trial-averaged axis is then a meaningless
    compromise between two orientations, and the resulting projection distorts
    the two legs by different amounts — observed as an implausible ~32 deg
    left/right disagreement in the projected knee angle before this fix.

    Returns (N, 26, 2) as (anterior, vertical): the plane in which KinetiQ's 2D
    angle definitions are meaningful.
    """
    j = np.asarray(joints, float)
    horiz = [i for i in range(3) if i != vertical_axis]

    ml = j[:, JOINTS["RightUpLeg"], :] - j[:, JOINTS["LeftUpLeg"], :]
    ml_h = ml[:, horiz]                                   # (N, 2)

    if smooth_frames > 1:
        k = np.ones(smooth_frames) / smooth_frames
        ml_h = np.stack([np.convolve(ml_h[:, i], k, mode="same") for i in range(2)], axis=1)

    norms = np.linalg.norm(ml_h, axis=1, keepdims=True)
    if np.any(norms < 1e-9):
        # Fall back to the trial mean only for the degenerate frames.
        mean_axis = ml_h[norms[:, 0] >= 1e-9].mean(axis=0)
        mean_axis = mean_axis / (np.linalg.norm(mean_axis) or 1.0)
        ml_h = np.where(norms < 1e-9, mean_axis, ml_h)
        norms = np.linalg.norm(ml_h, axis=1, keepdims=True)
    ml_h = ml_h / norms

    # Anterior axis: horizontal, orthogonal to medio-lateral, per frame.
    ant_h = np.stack([-ml_h[:, 1], ml_h[:, 0]], axis=1)    # (N, 2)

    anterior = np.einsum("njd,nd->nj", j[:, :, horiz], ant_h)
    vertical = j[:, :, vertical_axis]
    return np.stack([anterior, vertical], axis=-1)


def to_mediapipe_landmarks(joints_2d: np.ndarray, image_aspect: float = 1.0,
                           analysis_side: str = "left") -> list:
    """
    Pack sagittal-plane joints into MediaPipe's 33-landmark normalised format,
    so that mocap ground truth can be fed straight into the production
    onPoseResults() callback.

    Coordinates are normalised into [0, 1] with y INVERTED, because MediaPipe's
    image frame has y increasing downward while the mocap frame has y up.
    Scale and offset are irrelevant to every angle KinetiQ computes (they are
    invariant to similarity transforms), but the y flip is not — it would mirror
    the trunk-lean sign convention if omitted.

    `analysis_side` is given the higher visibility so that the production
    visible-side selection in onPoseResults() — `lVis > rVis`, which resolves to
    the RIGHT limb on an exact tie — selects the same limb the reference angles
    are computed for. With equal visibilities the app silently measures one leg
    while the reference describes the other.
    """
    j = np.asarray(joints_2d, float)
    x, y = j[:, :, 0], j[:, :, 1]

    x0, x1 = x.min(), x.max()
    y0, y1 = y.min(), y.max()
    span = max(x1 - x0, y1 - y0) or 1.0
    nx = 0.5 + (x - (x0 + x1) / 2) / span * 0.8
    ny = 0.5 - (y - (y0 + y1) / 2) / span * 0.8   # y flip

    mp_from_rehab = {
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

    LEFT_IDS = {11, 23, 25, 27, 29, 31, 13, 15}
    RIGHT_IDS = {12, 24, 26, 28, 30, 32, 14, 16}
    near, far = (LEFT_IDS, RIGHT_IDS) if analysis_side == "left" else (RIGHT_IDS, LEFT_IDS)

    frames = []
    for f in range(j.shape[0]):
        lm = [{"x": 0.5, "y": 0.5, "z": 0.0, "visibility": 0.1} for _ in range(33)]
        for mp_i, re_i in mp_from_rehab.items():
            vis = 0.99 if mp_i in near else (0.70 if mp_i in far else 0.90)
            lm[mp_i] = {"x": float(nx[f, re_i]), "y": float(ny[f, re_i]),
                        "z": 0.0, "visibility": vis}
        frames.append(lm)
    return frames


def compute_reference_angles(joints: np.ndarray, side: str = "left",
                             vertical_axis: int = 1) -> dict:
    """
    joints: (N, 26, D) array of joint positions, D in {2, 3}.
    Returns per-frame knee / hip / ankle / trunk angles in degrees.
    """
    ch = SIDE_CHAIN[side]
    sh = joints[:, ch["shoulder"], :]
    hp = joints[:, ch["hip"], :]
    kn = joints[:, ch["knee"], :]
    an = joints[:, ch["ankle"], :]
    to = joints[:, ch["toe"], :]

    return {
        "knee": interior_angle(hp, kn, an),
        "hip": interior_angle(sh, hp, kn),
        "ankle": interior_angle(kn, an, to),
        "trunk": trunk_lean(sh, hp, vertical_axis=vertical_axis),
    }


# ---------------------------------------------------------------------------
# Segmentation
# ---------------------------------------------------------------------------
@dataclass
class Repetition:
    video_id: str
    repetition_number: int
    exercise_id: int
    person_id: int
    first_frame: int
    last_frame: int
    cam17_orientation: str
    mocap_erroneous: bool
    exercise_subtype: str
    correctness: bool

    @property
    def n_frames(self) -> int:
        return self.last_frame - self.first_frame + 1

    @property
    def duration_s(self) -> float:
        return self.n_frames / FPS

    @property
    def sagittal_camera(self) -> str | None:
        """Which camera sees the subject in profile, or None if neither does."""
        if self.cam17_orientation == "front":
            return "Camera18"
        if self.cam17_orientation == "profile":
            return "Camera17"
        return None  # half-profile: oblique in both


def load_segmentation(path: Path) -> list[Repetition]:
    """Read Segmentation.csv (semicolon-delimited)."""
    reps: list[Repetition] = []
    with Path(path).open() as fh:
        for r in csv.DictReader(fh, delimiter=";"):
            reps.append(Repetition(
                video_id=r["video_id"],
                repetition_number=int(r["repetition_number"]),
                exercise_id=int(r["exercise_id"]),
                person_id=int(r["person_id"]),
                first_frame=int(r["first_frame"]),
                last_frame=int(r["last_frame"]),
                cam17_orientation=r["cam17_orientation"],
                mocap_erroneous=r["mocap_erroneous"] == "1",
                exercise_subtype=r["exercise_subtype"],
                correctness=r["correctness"] == "1",
            ))
    return reps


def select(reps, exercise_id=None, view=None, exclude_erroneous=True,
           person_id=None) -> list[Repetition]:
    """
    Filter repetitions.

    view: 'sagittal'      -> only repetitions with a true profile camera
          'half-profile'  -> the oblique stratum (view-robustness analysis)
          None            -> everything
    """
    out = list(reps)
    if exercise_id is not None:
        out = [r for r in out if r.exercise_id == exercise_id]
    if person_id is not None:
        out = [r for r in out if r.person_id == person_id]
    if exclude_erroneous:
        out = [r for r in out if not r.mocap_erroneous]
    if view == "sagittal":
        out = [r for r in out if r.sagittal_camera is not None]
    elif view == "half-profile":
        out = [r for r in out if r.cam17_orientation == "half-profile"]
    return out


# ---------------------------------------------------------------------------
# Joint-file loading
#
# The archives ship one file per recording. Rather than hard-coding a layout
# that may not match, the loader sniffs the file and reshapes to (N, 26, D),
# failing loudly if the shape cannot be reconciled with 26 joints.
# ---------------------------------------------------------------------------
def load_joint_file(path: Path, n_joints: int = 26) -> np.ndarray:
    p = Path(path)
    suffix = p.suffix.lower()

    if suffix == ".npy":
        arr = np.load(p)
    elif suffix in (".csv", ".txt", ".tsv"):
        delim = "\t" if suffix == ".tsv" else None
        try:
            arr = np.loadtxt(p, delimiter=delim if delim else ",")
        except ValueError:
            arr = np.loadtxt(p)
    else:
        raise ValueError(f"unrecognised joint file type: {p.name}")

    arr = np.asarray(arr, float)

    if arr.ndim == 3:
        if arr.shape[1] != n_joints:
            raise ValueError(f"{p.name}: expected {n_joints} joints, got shape {arr.shape}")
        # REHAB24-6 ships (frames, 26, 4): x, y, z, confidence. Drop the
        # confidence column for geometry; retrieve it via load_confidence().
        if arr.shape[2] == 4:
            return arr[:, :, :3]
        return arr

    if arr.ndim == 2:
        n_frames, n_cols = arr.shape
        # A leading frame-index column is common; drop it if the remainder divides.
        for offset in (0, 1):
            cols = n_cols - offset
            if cols % n_joints == 0:
                d = cols // n_joints
                if d in (2, 3):
                    return arr[:, offset:].reshape(n_frames, n_joints, d)
        raise ValueError(
            f"{p.name}: {n_cols} columns is not {n_joints} joints x 2 or 3 "
            f"(with or without an index column)"
        )

    raise ValueError(f"{p.name}: unexpected array shape {arr.shape}")


def load_confidence(path: Path, n_joints: int = 26) -> np.ndarray | None:
    """Per-joint confidence/validity column, if the file carries one."""
    arr = np.load(Path(path)) if Path(path).suffix.lower() == ".npy" else None
    if arr is not None and arr.ndim == 3 and arr.shape[2] == 4:
        return arr[:, :, 3]
    return None


def find_joint_file(root: Path, video_id: str, camera: str | None = None,
                    fps_tag: str = "30fps") -> Path | None:
    """
    Locate the joint file for a recording.

    REHAB24-6 layout is Ex<N>/<video_id>-<30|120>fps.npy. Segmentation.csv frame
    indices are defined on the 30 fps data ("indexed based only on 30 FPS
    data"), so the 30 fps variant is selected by default — using the 120 fps
    file would silently misalign every repetition boundary by 4x.
    """
    root = Path(root)
    exts = {".npy", ".csv", ".txt", ".tsv"}
    candidates = [p for p in root.rglob("*")
                  if p.is_file() and video_id in p.name and p.suffix.lower() in exts]

    fps_hits = [p for p in candidates if fps_tag in p.name]
    if fps_hits:
        candidates = fps_hits

    if camera:
        cam_hits = [p for p in candidates
                    if camera.lower().replace("camera", "") in p.name.lower()]
        if cam_hits:
            candidates = cam_hits

    return candidates[0] if candidates else None


# ---------------------------------------------------------------------------
# Reference CSV emission (input to compare.py)
# ---------------------------------------------------------------------------
def emit_reference_csv(out_path: Path, angles_2d: dict, angles_3d: dict | None,
                       first_frame: int = 0) -> Path:
    """
    Write t,knee,hip,trunk,ankle[,knee_3d,...] — the format compare.py reads.
    `t` is seconds from the start of the recording, so it aligns with the
    replay timebase when the same recording is fed to the harness.
    """
    n = len(angles_2d["knee"])
    cols = ["t", "knee", "hip", "trunk", "ankle"]
    if angles_3d is not None:
        cols += ["knee_3d", "hip_3d", "trunk_3d", "ankle_3d"]

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        for i in range(n):
            row = [round((first_frame + i) / FPS, 6)]
            row += [round(float(angles_2d[j][i]), 4) for j in ("knee", "hip", "trunk", "ankle")]
            if angles_3d is not None:
                row += [round(float(angles_3d[j][i]), 4) for j in ("knee", "hip", "trunk", "ankle")]
            w.writerow(row)
    return out_path


# ---------------------------------------------------------------------------
# Inspection
# ---------------------------------------------------------------------------
def inspect(root: Path) -> None:
    root = Path(root)
    print(f"inspecting {root}")
    files = [p for p in root.rglob("*") if p.is_file()]
    print(f"  {len(files)} files")

    from collections import Counter
    print("  extensions:", dict(Counter(p.suffix.lower() for p in files)))
    print("\n  first 10 files:")
    for p in files[:10]:
        print(f"    {p.relative_to(root)}  ({p.stat().st_size/1e6:.2f} MB)")

    sample = next((p for p in files if p.suffix.lower() in {".npy", ".csv", ".txt", ".tsv"}), None)
    if sample:
        print(f"\n  parsing sample: {sample.name}")
        try:
            arr = load_joint_file(sample)
            print(f"    -> (frames, joints, dims) = {arr.shape}")
            print(f"    value range: [{arr.min():.2f}, {arr.max():.2f}]")
            ang = compute_reference_angles(arr[: min(200, len(arr))])
            for j, v in ang.items():
                print(f"    {j:6s} range {v.min():7.2f}° .. {v.max():7.2f}°  (mean {v.mean():.2f}°)")
        except Exception as e:
            print(f"    PARSE FAILED: {e}")
            with sample.open("rb") as fh:
                head = fh.read(300)
            print(f"    first bytes: {head[:200]!r}")


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
def selftest() -> int:
    ok = True

    def check(name, got, want, tol):
        nonlocal ok
        good = abs(got - want) < tol
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] {name}: {got:.6f} (expected {want:.6f})")

    print("rehab24_6.py self-test")
    print("-" * 60)

    # Right angle, 2D
    a = np.array([[0.0, 1.0]]); b = np.array([[0.0, 0.0]]); c = np.array([[1.0, 0.0]])
    check("interior_angle 2D right angle", float(interior_angle(a, b, c)[0]), 90.0, 1e-9)

    # Straight line
    a = np.array([[0.0, 2.0]]); b = np.array([[0.0, 1.0]]); c = np.array([[0.0, 0.0]])
    check("interior_angle straight", float(interior_angle(a, b, c)[0]), 180.0, 1e-9)

    # 3D right angle
    a = np.array([[1.0, 0.0, 0.0]]); b = np.array([[0.0, 0.0, 0.0]]); c = np.array([[0.0, 0.0, 1.0]])
    check("interior_angle 3D right angle", float(interior_angle(a, b, c)[0]), 90.0, 1e-9)

    # Agreement with KinetiQ's acos form over the working range
    max_dev = 0.0
    for deg in np.arange(5, 176, 0.5):
        r = np.radians(deg)
        A = np.array([[np.sin(r), np.cos(r)]]); B = np.array([[0.0, 0.0]]); C = np.array([[0.0, 1.0]])
        ours = float(interior_angle(A, B, C)[0])
        ba, bc = A[0] - B[0], C[0] - B[0]
        acos_form = np.degrees(np.arccos(np.clip(np.dot(ba, bc) /
                    (np.linalg.norm(ba) * np.linalg.norm(bc)), -1, 1)))
        max_dev = max(max_dev, abs(ours - acos_form))
    check("max deviation vs KinetiQ acos form", max_dev, 0.0, 1e-8)

    # Trunk lean
    sh = np.array([[0.0, 0.0]]); hp = np.array([[0.0, 1.0]])
    check("trunk_lean vertical", float(trunk_lean(sh, hp)[0]), 0.0, 1e-9)
    sh = np.array([[1.0, 0.0]]); hp = np.array([[0.0, 1.0]])
    check("trunk_lean 45 deg", float(trunk_lean(sh, hp)[0]), 45.0, 1e-9)

    # Camera selection logic
    mk = lambda o: Repetition("V", 1, 6, 1, 0, 10, o, False, "", True)
    for orient, want in [("front", "Camera18"), ("profile", "Camera17"), ("half-profile", None)]:
        got = mk(orient).sagittal_camera
        good = got == want
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] sagittal camera for '{orient}': {got}")

    print("-" * 60)
    print("ALL PASS" if ok else "FAILURES PRESENT")
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="REHAB24-6 ground-truth adapter")
    ap.add_argument("--root", type=Path, help="directory of extracted joint files")
    ap.add_argument("--segmentation", type=Path, help="Segmentation.csv")
    ap.add_argument("--exercise", type=int, default=6, help="exercise_id (6 = squats)")
    ap.add_argument("--view", default="sagittal", choices=["sagittal", "half-profile", "all"])
    ap.add_argument("--side", default="left", choices=["left", "right"])
    ap.add_argument("--out", type=Path, help="output directory for reference CSVs")
    ap.add_argument("--inspect", type=Path, help="inspect an extracted directory and exit")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return selftest()
    if a.inspect:
        inspect(a.inspect)
        return 0
    if not a.segmentation:
        ap.error("--segmentation is required")

    reps = load_segmentation(a.segmentation)
    view = None if a.view == "all" else a.view
    sel = select(reps, exercise_id=a.exercise, view=view)

    print(f"{EXERCISES.get(a.exercise, a.exercise)}: {len(sel)} repetitions "
          f"(view={a.view}, mocap-erroneous excluded)")
    from collections import Counter
    print(f"  subjects   : {sorted({r.person_id for r in sel})}")
    print(f"  recordings : {len({r.video_id for r in sel})}")
    print(f"  correctness: {dict(Counter('correct' if r.correctness else 'incorrect' for r in sel))}")
    print(f"  cameras    : {dict(Counter(r.sagittal_camera for r in sel))}")
    durs = [r.duration_s for r in sel]
    if durs:
        print(f"  duration   : median {np.median(durs):.2f}s  range {min(durs):.2f}-{max(durs):.2f}s")

    if not a.root:
        print("\n(no --root given: listing only; pass --root to emit reference CSVs)")
        return 0

    a.out = a.out or Path("./ref_out")
    written = 0
    missing = []
    for r in sel:
        jf = find_joint_file(a.root, r.video_id, r.sagittal_camera)
        if not jf:
            missing.append(r.video_id)
            continue
        joints = load_joint_file(jf)
        seg = joints[r.first_frame: r.last_frame + 1]
        ang = compute_reference_angles(seg, side=a.side)
        dest = a.out / f"{r.video_id}_rep{r.repetition_number:02d}.csv"
        emit_reference_csv(dest, ang, None, first_frame=r.first_frame)
        written += 1

    print(f"\nwrote {written} reference CSVs to {a.out}")
    if missing:
        print(f"  {len(set(missing))} recordings had no joint file: {sorted(set(missing))[:5]}…")
    return 0


if __name__ == "__main__":
    sys.exit(main())
