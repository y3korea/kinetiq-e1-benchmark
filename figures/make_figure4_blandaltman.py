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
PER_REP = HERE.parent.parent / "E1_benchmark" / "results" / "tier2_per_rep.csv"
STATS = HERE.parent.parent / "E1_benchmark" / "results" / "tier2_stats.json"

rows = list(csv.DictReader(open(PER_REP, encoding="utf-8")))
stats = json.load(open(STATS, encoding="utf-8"))
ba = stats["bland_altman"]

import sys
sys.path.insert(0, str(HERE))
import ieee_style as S
S.apply()

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
                xycoords=("axes fraction", "data"), xytext=(0, 2), textcoords="offset points",
                fontsize=7, va="bottom", ha="left", zorder=4)
    for loa in (k["loa_lower"], k["loa_upper"]):
        ax.axhline(loa, color=S.INK, lw=0.7, ls="--", zorder=3)
    ax.text(0.99, 0.03,
            "LoA [%.1f, %.1f]$\\degree$\nSRD %.1f$\\degree$" % (k["loa_lower"], k["loa_upper"], k["srd"]),
            transform=ax.transAxes, va="bottom", ha="right", fontsize=7)
    ax.set_xlabel("Mean of app and reference knee angle (deg)")
    S.panel_label(ax, "(%s) %s view, n=%d" % ("a" if view == "sagittal" else "b",
                                              view.capitalize(), k["n"]), x=0.0)

axes[0].set_ylabel("App $-$ reference (deg)")
fig.tight_layout(pad=0.6, w_pad=1.6)

for ext in ("svg", "pdf", "png"):
    fig.savefig(HERE / f"figure4_blandaltman.{ext}", bbox_inches="tight")
    print(f"  wrote figure4_blandaltman.{ext}")
sub300 = HERE / "submission_300dpi"
sub300.mkdir(exist_ok=True)
fig.savefig(sub300 / "figure4_blandaltman_300dpi.png", dpi=300, bbox_inches="tight")
fig.savefig(sub300 / "figure4_blandaltman.pdf", bbox_inches="tight")
print("  wrote submission_300dpi/figure4_blandaltman_{300dpi.png,.pdf}")
