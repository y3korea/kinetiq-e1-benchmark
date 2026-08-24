#!/usr/bin/env python3
"""
Figure 5 — External validity at the landmark tier: two independent mocap cohorts
================================================================================
Bland-Altman agreement of the deployed chain against the 3-D anatomical knee
angle (minimum per repetition), with landmarks injected from motion capture
(perception bypassed, sagittal projection, production 4:3 geometry):

  left  — REHAB24-6 (OptiTrack, 9 recordings, 187 matched reps; E1 Tier 1.5 export:
          rehab24_6.project_to_sagittal + isotropic normalised landmarks)
  right — UI-PRMD deep squat (Vicon, 10 subjects, 190 matched reps; yaw_sweep.py
          projection at yaw 0°, production 1280x960 geometry)

The two cohorts went through different projection code; the sweep reproduces the
T1.5 export at yaw 0° to within 0.01° (knee MAE 2.41° vs 2.42°), which is what
makes the panels comparable. The reference here is the 3-D anatomical angle, so
each panel includes the monocular projection floor.

Inputs (all produced by the E1 harness):
  E1_benchmark/results/tier15_matched.csv   (app_knee, ref_min_knee_3d)
  E1_benchmark/results/uiprmd_per_rep.csv   (app_knee, gt3d_knee, subject)
  E1_benchmark/results/uiprmd_report.json   (bland_altman, rehab24_6_t15_reference)
Scope: NOT end-to-end — UI-PRMD publishes no RGB video, so MediaPipe perception
is not exercised on that cohort.
"""
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = Path(__file__).resolve().parent
# Reproducibility: read the hash-pinned copy the analysis notebook uses (input/),
# so a figure can never be built from a results file the notebook did not see.
# Falls back to the live harness output when the pinned copy is absent.
# Layout-independent so the script works both here and in the public release,
# where figures/ sits at the repository root instead of under IEEE_JBHI/.
# Order matters: the hash-pinned copy the notebook uses wins when it exists, so
# a figure can never be built from a results file the notebook did not see.
_CANDIDATES = (
    HERE.parent / "input",                                  # IEEE_JBHI/input (hash-pinned)
    HERE.parent.parent / "E1_benchmark" / "results",        # <repo>/IEEE_JBHI/figures/..
    HERE.parent / "E1_benchmark" / "results",               # <repo>/figures/..  (public release)
)
RESULTS = next((c for c in _CANDIDATES if c.is_dir()), None)
if RESULTS is None:
    raise SystemExit(
        "results directory not found; looked in:\n  " + "\n  ".join(str(c) for c in _CANDIDATES))
RES = RESULTS
rehab = list(csv.DictReader(open(RES / "tier15_matched.csv", encoding="utf-8")))
ui = list(csv.DictReader(open(RES / "uiprmd_per_rep.csv", encoding="utf-8")))
rep = json.load(open(RES / "uiprmd_report.json", encoding="utf-8"))

import sys
sys.path.insert(0, str(HERE))
import ieee_style as S
S.apply()
plt.rcParams["svg.hashsalt"] = "figure5_external"      # deterministic SVG ids
META = {"svg": {"Date": None}, "pdf": {"CreationDate": None}}   # deterministic SVG/PDF (no timestamp)

panels = [
    ("REHAB24-6  (OptiTrack, 9 recordings)",
     [(float(r["app_knee"]) + float(r["ref_min_knee_3d"])) / 2 for r in rehab],
     [float(r["app_knee"]) - float(r["ref_min_knee_3d"]) for r in rehab],
     rep["rehab24_6_t15_reference"]["knee_vs_3d"], S.SERIES[0], None),
    ("UI-PRMD deep squat  (Vicon, 10 subjects)",
     [(float(r["app_knee"]) + float(r["gt3d_knee"])) / 2 for r in ui],
     [float(r["app_knee"]) - float(r["gt3d_knee"]) for r in ui],
     rep["bland_altman"]["knee_vs_3d"], S.SERIES[0], [int(r["subject"]) for r in ui]),
]

fig, axes = plt.subplots(1, 2, figsize=(S.WIDE, 2.75), sharey=True)
MARKERS = ["o", "s", "^", "v", "D", "<", ">", "P", "X", "*"]
for ax, (title, x, y, k, col, subj) in zip(axes, panels):
    ax.axhspan(k["loa_lower"], k["loa_upper"], color=S.BAND[1], lw=0, zorder=0)
    if subj is None:
        ax.scatter(x, y, s=9, marker="o", facecolors="none", edgecolors=col,
                   linewidths=0.5, zorder=2)
    else:   # UI-PRMD: one marker per subject, so the projection term is legible in grayscale
        for i, sj in enumerate(sorted(set(subj))):
            xs = [a for a, b in zip(x, subj) if b == sj]; ys = [a for a, b in zip(y, subj) if b == sj]
            ax.scatter(xs, ys, s=9, marker=MARKERS[i % len(MARKERS)], facecolors="none",
                       edgecolors=S.INK, linewidths=0.45, zorder=2)
        ps = rep["per_subject"]["10"]      # the offset cluster: almost entirely projection
        ax.annotate("subject 10: chain %+.1f$\\degree$,\nprojection %+.1f$\\degree$"
                    % (ps["chain_bias_2d"], ps["projection_floor"]),
                    xy=(82, 13.0), xytext=(0.03, 0.95), textcoords="axes fraction", fontsize=7,
                    ha="left", va="top", bbox=S.HALO, zorder=5,
                    arrowprops=dict(arrowstyle="-", color=S.GRAY, lw=0.6))
    ax.axhline(0, color=S.GRAY, lw=0.6, ls=":", zorder=1)
    ax.axhline(k["bias"], color=S.INK, lw=0.9, zorder=3)
    ax.annotate("bias %+.1f$\\degree$" % k["bias"], xy=(0.015, k["bias"]),
                xycoords=("axes fraction", "data"), xytext=(0, 2.5), textcoords="offset points",
                fontsize=7, va="bottom", ha="left", zorder=5, bbox=S.HALO)
    for loa in (k["loa_lower"], k["loa_upper"]):
        ax.axhline(loa, color=S.INK, lw=0.7, ls="--", zorder=3)
    ax.set_xlabel("Mean of app and 3-D reference knee angle (deg)")
    ax.text(0.99, 0.03, "MAE %.2f$\\degree$\nLoA [%.1f, %.1f]$\\degree$\nSRD %.1f$\\degree$"
            % (k["mae"], k["loa_lower"], k["loa_upper"], k["srd"]),
            transform=ax.transAxes, va="bottom", ha="right", fontsize=7,
            linespacing=1.35, zorder=5, bbox=S.HALO)
    S.panel_label(ax, "(%s) %s, n=%d" % ("a" if subj is None else "b", title.split("  (")[0], k["n"]), x=0.0)
axes[0].set_ylabel("App $-$ 3-D anatomical reference (deg)")
fig.tight_layout(pad=0.6, w_pad=1.6)

for ext in ("svg", "pdf", "png"):
    fig.savefig(HERE / f"figure5_external.{ext}", bbox_inches="tight", metadata=META.get(ext))
    print(f"  wrote figure5_external.{ext}")
sub300 = HERE / "submission_300dpi"
sub300.mkdir(exist_ok=True)
fig.savefig(sub300 / "figure5_external_300dpi.png", dpi=300, bbox_inches="tight")
# IEEE TRANS-JOUR: high-contrast line figures need 600 dpi; 300 dpi is the
# photograph/grayscale figure. These panels are line art with light gray bands,
# so the submission attaches the vector PDF, with a 600 dpi raster as fallback.
sub600 = HERE / "submission_600dpi"; sub600.mkdir(exist_ok=True)
fig.savefig(sub600 / "figure5_external_600dpi.png", dpi=600, bbox_inches="tight")
print("  wrote submission_600dpi/figure5_external_600dpi.png")
fig.savefig(sub300 / "figure5_external.pdf", bbox_inches="tight", metadata=META["pdf"])
print("  wrote submission_300dpi/figure5_external_{300dpi.png,.pdf}")
for title, *_rest in panels:
    pass
print("REHAB knee_vs_3d:", rep["rehab24_6_t15_reference"]["knee_vs_3d"])
print("UI-PRMD knee_vs_3d:", {k: v for k, v in rep["bland_altman"]["knee_vs_3d"].items() if not k.endswith("_ci")})
