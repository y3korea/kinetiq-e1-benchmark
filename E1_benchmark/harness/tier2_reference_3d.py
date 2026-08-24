#!/usr/bin/env python3
"""
tier2_reference_3d.py — score the same Tier 2 app output against a 3-D reference.

Table V places this work's sagittal knee MAE next to published single-view and
multi-camera systems. Those systems do not all use the same reference: some
score against a 3-D model-based angle, some against 2-D marker coordinates, and
the radiographic rows against a plane that coincides with the camera's. This
work's headline 5.63 deg is measured against the dataset's own published 2-D
projection into camera 18, which is the plane MediaPipe actually sees and
therefore carries no projection assumption of ours -- but it also removes the
monocular projection term that a 3-D reference would charge us for.

So that the comparison can be read either way, this script recomputes the SAME
application outputs against the 3-D anatomical knee angle, at the same
repetition extremum -- the same statistic the paper reports -- and reports it
alongside the published figure. A frame-wise comparison is NOT computed here:
tier2_per_rep.csv stores one angle per repetition, not the application's
per-frame trajectory, so a frame-wise figure cannot be derived from it. It reproduces the published 5.63 deg first: if that check fails, no
derived number here should be trusted.

Inputs (not redistributed -- see FETCH.md):
  ~/KinetiQ_datasets/REHAB24-6/extracted/3d_joints/Ex6/PM_*-30fps.npy   (T,26,4)
  ~/KinetiQ_datasets/REHAB24-6/extracted/2d_joints/Ex6/PM_*-c18-30fps.npy (T,26,2)
  ~/KinetiQ_datasets/REHAB24-6/tier2_ref/PM_*_ref.json                 rep windows
  ../results/tier2_per_rep.csv                                          app output

Usage:  python3 tier2_reference_3d.py [--data DIR] [--out ../results/tier2_reference_3d.json]
"""
import argparse, csv, json, os, sys
import numpy as np

# 26-joint REHAB24-6 skeleton; identical to analysis/gt_adapters/rehab24_6.py
# JOINTS/SIDE_CHAIN and to the dataset's own joints_names.txt.
HIP, KNEE, ANKLE = 16, 17, 18          # LeftUpLeg / LeftLeg / LeftFoot
# All nine recordings selected the left limb (tier2_production.json limb_selection),
# recovered from landmark visibilities, so the right chain is not needed here.

PUBLISHED = {"sagittal_mae": 5.63, "sagittal_bias": 4.44, "sagittal_n": 97,
             "all_mae": 15.16, "all_bias": -8.46, "all_n": 171}
TOL = 0.02   # deg; the published figures are rounded to 2 dp


def angle(a, b, c):
    u, v = a - b, c - b
    cos = (u * v).sum(-1) / (np.linalg.norm(u, axis=-1) * np.linalg.norm(v, axis=-1))
    return np.degrees(np.arccos(np.clip(cos, -1.0, 1.0)))


def summarize(errors):
    e = np.asarray(errors, dtype=float)
    return {"n": int(e.size), "mae": round(float(np.abs(e).mean()), 2),
            "bias": round(float(e.mean()), 2),
            "rmse": round(float(np.sqrt((e ** 2).mean())), 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.expanduser("~/KinetiQ_datasets/REHAB24-6"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "results", "tier2_reference_3d.json"))
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    rows = list(csv.DictReader(open(os.path.join(here, "..", "results", "tier2_per_rep.csv"))))
    recs = sorted({r["rec"] for r in rows})

    per_rep, missing = [], 0
    for rec in recs:
        j3 = np.load(f"{a.data}/extracted/3d_joints/Ex6/{rec}-30fps.npy")[:, :, :3]
        j2 = np.load(f"{a.data}/extracted/2d_joints/Ex6/{rec}-c18-30fps.npy")
        k3 = angle(j3[:, HIP], j3[:, KNEE], j3[:, ANKLE])
        k2 = angle(j2[:, HIP], j2[:, KNEE], j2[:, ANKLE])
        windows = {w["repetition_number"]: w
                   for w in json.load(open(f"{a.data}/tier2_ref/{rec}_ref.json"))["annotated_repetitions"]}

        for r in [x for x in rows if x["rec"] == rec]:
            w = windows.get(int(r["rep"]))
            if w is None:
                missing += 1
                continue
            lo, hi = w["first_frame"], min(w["last_frame"], len(k2) - 1)
            seg2, seg3 = k2[lo:hi + 1], k3[lo:hi + 1]
            f = int(np.argmin(seg2))          # extremum = deepest knee flexion, as published
            app = float(r["app_knee"])
            per_rep.append({
                "rec": rec, "rep": int(r["rep"]), "view": r["view"],
                "app_knee": app,
                "ref_2d_published": float(r["ref_knee"]),
                "ref_2d_recomputed": round(float(seg2[f]), 2),
                "ref_3d_extremum": round(float(seg3[f]), 2),
                "err_2d": round(app - float(r["ref_knee"]), 2),
                "err_3d": round(app - float(seg3[f]), 2),
            })

    sag = [p for p in per_rep if p["view"] == "sagittal"]
    out = {
        "experiment": "Tier 2 rescored against a 3-D anatomical reference (Table V like-for-like)",
        "joint_indices": {"hip": HIP, "knee": KNEE, "ankle": ANKLE,
                          "source": "analysis/gt_adapters/rehab24_6.py JOINTS/SIDE_CHAIN; cross-checked against data/gt/joints_names.txt"},
        "limb": "left for all nine recordings (tier2_production.json limb_selection)",
        "extremum": "minimum knee angle within the dataset's annotated [first_frame, last_frame]",
        "repetitions_without_window": missing,
        "sagittal": {
            "vs_2d_published_projection": summarize([p["err_2d"] for p in sag]),
            "vs_3d_anatomical_extremum": summarize([p["err_3d"] for p in sag]),
        },
        "all_views": {
            "vs_2d_published_projection": summarize([p["err_2d"] for p in per_rep]),
            "vs_3d_anatomical_extremum": summarize([p["err_3d"] for p in per_rep]),
        },
        "projection_term_deg": None,   # filled below: 2-D reference minus 3-D reference
        "per_rep": per_rep,
    }

    # The projection term is what a 3-D reference charges and a 2-D reference does not.
    out["projection_term_deg"] = round(
        out["sagittal"]["vs_3d_anatomical_extremum"]["bias"] - out["sagittal"]["vs_2d_published_projection"]["bias"], 2)

    # Reproduce the published figures before trusting anything derived.
    checks, ok = [], True
    for label, got, want in [
        ("sagittal MAE", out["sagittal"]["vs_2d_published_projection"]["mae"], PUBLISHED["sagittal_mae"]),
        ("sagittal bias", out["sagittal"]["vs_2d_published_projection"]["bias"], PUBLISHED["sagittal_bias"]),
        ("sagittal n", out["sagittal"]["vs_2d_published_projection"]["n"], PUBLISHED["sagittal_n"]),
        ("all MAE", out["all_views"]["vs_2d_published_projection"]["mae"], PUBLISHED["all_mae"]),
        ("all bias", out["all_views"]["vs_2d_published_projection"]["bias"], PUBLISHED["all_bias"]),
        ("all n", out["all_views"]["vs_2d_published_projection"]["n"], PUBLISHED["all_n"]),
    ]:
        good = abs(got - want) <= (TOL if isinstance(want, float) else 0)
        ok &= good
        checks.append({"check": label, "got": got, "published": want, "pass": bool(good)})
        print(f"  {'OK ' if good else '** '}{label:16s} {got}  (published {want})")
    out["reproduces_published"] = {"pass": bool(ok), "checks": checks}

    with open(a.out, "w") as fh:
        json.dump(out, fh, indent=2)
    s = out["sagittal"]
    print(f"\n  sagittal vs 2-D published : MAE {s['vs_2d_published_projection']['mae']}°  bias {s['vs_2d_published_projection']['bias']:+}°  n={s['vs_2d_published_projection']['n']}")
    print(f"  sagittal vs 3-D extremum  : MAE {s['vs_3d_anatomical_extremum']['mae']}°  bias {s['vs_3d_anatomical_extremum']['bias']:+}°")
    print(f"  monocular projection term : {out['projection_term_deg']:+}°  (2-D reference minus 3-D reference)")
    print(f"\n  → {os.path.relpath(a.out)}")
    if not ok:
        print("\n  published figures NOT reproduced — do not use the derived numbers.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
