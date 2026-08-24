#!/usr/bin/env python3
"""
Figure 4 — Bland-Altman agreement, app vs mocap-derived reference (knee angle)
==============================================================================
Two panels sharing one y-axis: sagittal (left) and oblique (right) repetitions.
Same 171 matched repetitions as Tier 2 (results/tier2_per_rep.csv, produced by
tier2_stats.cjs with recording-level bootstrap CIs).

The figure carries the paper's central practical claim: under a true sagittal
view the app agrees with the reference within clinically interpretable limits
(LoA -4.5..+13.4 deg, SRD 12.6 deg), while an oblique view widens the limits
of agreement to ~±49 deg — the difference between usable and unusable, which
is why the application ships alignment guidance derived from these numbers.
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
PER_REP = RESULTS / "tier2_per_rep.csv"
STATS = RESULTS / "tier2_stats.json"

rows = list(csv.DictReader(open(PER_REP, encoding="utf-8")))
stats = json.load(open(STATS, encoding="utf-8"))
ba = stats["bland_altman"]

import sys
sys.path.insert(0, str(HERE))
import ieee_style as S
S.apply()
plt.rcParams["svg.hashsalt"] = "figure4_blandaltman"          # deterministic SVG element ids
META = {"svg": {"Date": None}, "pdf": {"CreationDate": None}}   # no timestamps → byte-stable


COL = {"sagittal": S.SERIES[0], "oblique": S.SERIES[1]}
MRK = {"sagittal": "o", "oblique": "^"}

fig, axes = plt.subplots(1, 2, figsize=(S.WIDE, 2.75), sharey=True)

for ax, view in zip(axes, ["sagittal", "oblique"]):
    sub = [r for r in rows if r["view"] == view]
    x = [(float(r["app_knee"]) + float(r["ref_knee"])) / 2 for r in sub]
    y = [float(r["err_knee"]) for r in sub]
    k = ba[view]["knee"]

    ax.axhspan(k["loa_lower"], k["loa_upper"], color=S.BAND[1], lw=0, zorder=0)
    ax.scatter(x, y, s=9, marker=MRK[view], facecolors="none",
               edgecolors=COL[view], linewidths=0.5, zorder=2)
    ax.axhline(0, color=S.GRAY, lw=0.6, ls=":", zorder=1)
    ax.axhline(k["bias"], color=S.INK, lw=0.9, zorder=3)
    ax.annotate("bias %+.1f$\\degree$" % k["bias"], xy=(0.015, k["bias"]),
                xycoords=("axes fraction", "data"), xytext=(0, 2.5), textcoords="offset points",
                fontsize=7, va="bottom", ha="left", zorder=5, bbox=S.HALO)
    for loa in (k["loa_lower"], k["loa_upper"]):
        ax.axhline(loa, color=S.INK, lw=0.7, ls="--", zorder=3)
    ax.text(0.99, 0.03,
            "LoA [%.1f, %.1f]$\\degree$\nSRD %.1f$\\degree$" % (k["loa_lower"], k["loa_upper"], k["srd"]),
            transform=ax.transAxes, va="bottom", ha="right", fontsize=7,
            linespacing=1.35, zorder=5, bbox=S.HALO)
    ax.set_xlabel("Mean of app and reference knee angle (deg)")
    S.panel_label(ax, "(%s) %s view, n=%d" % ("a" if view == "sagittal" else "b",
                                              view.capitalize(), k["n"]), x=0.0)

axes[0].set_ylabel("App $-$ reference (deg)")
fig.tight_layout(pad=0.6, w_pad=1.6)

for ext in ("svg", "pdf", "png"):
    fig.savefig(HERE / f"figure4_blandaltman.{ext}", bbox_inches="tight", metadata=META.get(ext))
    print(f"  wrote figure4_blandaltman.{ext}")
sub300 = HERE / "submission_300dpi"
sub300.mkdir(exist_ok=True)
fig.savefig(sub300 / "figure4_blandaltman_300dpi.png", dpi=300, bbox_inches="tight")
# IEEE TRANS-JOUR: high-contrast line figures need 600 dpi; 300 dpi is the
# photograph/grayscale figure. These panels are line art with light gray bands,
# so the submission attaches the vector PDF, with a 600 dpi raster as fallback.
sub600 = HERE / "submission_600dpi"; sub600.mkdir(exist_ok=True)
fig.savefig(sub600 / "figure4_blandaltman_600dpi.png", dpi=600, bbox_inches="tight")
print("  wrote submission_600dpi/figure4_blandaltman_600dpi.png")
fig.savefig(sub300 / "figure4_blandaltman.pdf", bbox_inches="tight", metadata=META["pdf"])
print("  wrote submission_300dpi/figure4_blandaltman_{300dpi.png,.pdf}")
