#!/usr/bin/env python3
"""
make_figure3_viewangle.py — Figure 3: accuracy as a function of camera viewing angle

Source data: E1_benchmark/results/yaw_sweep.json, produced by projecting the REHAB24-6
OptiTrack skeleton through a virtual camera orbiting in yaw and running each viewpoint
through the production measurement chain.

Styled for IEEE J-BHI by ieee_style.py (Times New Roman 8 pt, thin black rules, inward
ticks, grayscale-safe series, no in-figure titles — the caption carries them; panel tags
(a)–(d) outside the axes). Vector PDF for LaTeX, 300 dpi PNG for Word, SVG as master.
"""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import ieee_style as S

HERE = Path(__file__).resolve().parent
DATA = HERE.parent.parent / "E1_benchmark" / "results" / "yaw_sweep.json"

d = json.loads(DATA.read_text())
curve = d["curve"]
pitch_curve = d.get("pitch_curve", [])
yaw = [c["yaw"] for c in curve]
knee = [c["knee_mae"] for c in curve]
hip = [c["hip_mae"] for c in curve]
recall = [c["recall"] for c in curve]
aucv = [c["auc"] for c in curve]
openv = [c["openness"] for c in curve]
cal = d["metric_calibration"]

S.apply()
fig, axes2 = plt.subplots(2, 2, figsize=(S.WIDE, 4.15))
axes = [axes2[0, 0], axes2[0, 1], axes2[1, 1]]
ax_pitch = axes2[1, 0]

# --- (a) angle error vs yaw ------------------------------------------------
ax = axes[0]
for lo, hi, shade in [(0, cal["good_within_yaw_deg"], S.BAND[0]),
                      (cal["good_within_yaw_deg"], cal["warn_within_yaw_deg"], S.BAND[1]),
                      (cal["warn_within_yaw_deg"], 90, S.BAND[2])]:
    ax.axvspan(lo, hi, color=shade, lw=0, zorder=0)
ax.plot(yaw, knee, "o-", color=S.SERIES[0], label="Knee")
ax.plot(yaw, hip, "s--", color=S.SERIES[1], label="Hip")
ax.axhline(d["baseline_sagittal_knee_mae"], color=S.GRAY, ls=":", lw=0.8)
ax.annotate("monocular floor %.1f$\\degree$" % d["baseline_sagittal_knee_mae"],
            xy=(70, d["baseline_sagittal_knee_mae"]), xytext=(52, 9.5),
            fontsize=7, color=S.GRAY,
            arrowprops=dict(arrowstyle="->", color=S.GRAY, lw=0.6))

ax.set_xlabel("Camera yaw from sagittal (deg)")
ax.set_ylabel("Joint-angle MAE (deg)")
ax.set_xlim(0, 90); ax.set_ylim(0, 65)
ax.xaxis.set_major_locator(MultipleLocator(15))
ax.legend(loc="upper left")
S.panel_label(ax, "(a)")

# --- (b) counting and score validity vs yaw --------------------------------
ax = axes[1]
ax.plot(yaw, recall, "o-", color=S.SERIES[0], label="Repetition recall")
ax.plot(yaw, aucv, "^--", color=S.SERIES[1], label="Score AUC")
ax.axhline(0.5, color=S.GRAY, ls=":", lw=0.8)
ax.text(2, 0.53, "chance", fontsize=7, color=S.GRAY, ha="left")
ax.set_xlabel("Camera yaw from sagittal (deg)")
ax.set_ylabel("Recall / AUC")
ax.set_xlim(0, 90); ax.set_ylim(0, 1.05)
ax.xaxis.set_major_locator(MultipleLocator(15))
ax.legend(loc="lower left")
S.panel_label(ax, "(b)")

# --- (d) metric calibration ------------------------------------------------
ax = axes[2]
ax.plot(yaw, openv, "o-", color=S.SERIES[0])
for key, label, ytext in [("good", "good 0.06 (10$\\degree$, knee 5.7$\\degree$)", 0.078),
                          ("warn", "fair 0.13 (23$\\degree$, knee 13.3$\\degree$)", 0.148)]:
    thr = cal["%s_threshold" % key]; deg = cal["%s_within_yaw_deg" % key]
    mae = cal["%s_boundary_knee_mae" % key]
    ax.axhline(thr, color=S.GRAY, ls="--", lw=0.8)
    ax.plot([deg], [thr], "o", color=S.INK, ms=4, mec="white", mew=0.8, zorder=5)
    ax.text(88, thr + 0.012, label, fontsize=7, color=S.INK, ha="right", va="bottom")
ax.set_xlabel("Camera yaw from sagittal (deg)")
ax.set_ylabel("Alignment metric (openness)")
ax.set_xlim(0, 90); ax.set_ylim(0, 0.38)
ax.xaxis.set_major_locator(MultipleLocator(15))
S.panel_label(ax, "(d)")

# --- (c) pitch --------------------------------------------------------------
pyaw = [c["pitch"] for c in pitch_curve]
pknee = [c["knee_mae"] for c in pitch_curve]
phip = [c["hip_mae"] for c in pitch_curve]
popen = [c["openness"] for c in pitch_curve]
ax = ax_pitch
ax.plot(pyaw, pknee, "o-", color=S.SERIES[0], label="Knee")
ax.plot(pyaw, phip, "s--", color=S.SERIES[1], label="Hip")
ax.axvline(0, color=S.GRAY, ls=":", lw=0.8)
ax.text(-43, 33.5, "camera low", fontsize=7, color=S.GRAY, va="top")
ax.text(43, 33.5, "camera high", fontsize=7, color=S.GRAY, va="top", ha="right")
axo = ax.twinx()
axo.plot(pyaw, popen, "-.", color=S.SERIES[2], lw=0.9, label="Alignment metric")
axo.set_ylim(0, 0.38)
axo.set_ylabel("Openness", fontsize=8)
axo.tick_params(axis="y", labelsize=7.5)
axo.spines["top"].set_visible(False)
axo.annotate("alignment metric flat:\npitch is invisible to it",
             xy=(8, popen[min(range(len(pyaw)), key=lambda i: abs(pyaw[i] - 8))]),
             xytext=(-43, 0.235), fontsize=7, color=S.SERIES[2], va="center",
             arrowprops=dict(arrowstyle="->", color=S.SERIES[2], lw=0.6,
                             connectionstyle="arc3,rad=-0.12"))
ax.set_xlabel("Camera pitch (deg)")
ax.set_ylabel("Joint-angle MAE (deg)")
ax.set_xlim(-45, 45); ax.set_ylim(0, 40)
ax.xaxis.set_major_locator(MultipleLocator(15))
ax.legend(loc="upper center", ncol=2, columnspacing=1.0)
S.panel_label(ax, "(c)")

for ax in axes + [ax_pitch]:
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.set_axisbelow(True)

fig.tight_layout(pad=0.6, w_pad=1.6, h_pad=1.4)
for ext, kw in [("pdf", {}), ("svg", {}), ("png", {"dpi": 300})]:
    out = HERE / f"figure3_viewangle.{ext}"
    fig.savefig(out, bbox_inches="tight", **kw)
    print(f"  wrote {out.name}")

sub = HERE / "submission_300dpi"
sub.mkdir(exist_ok=True)
fig.savefig(sub / "figure3_viewangle_300dpi.png", dpi=300, bbox_inches="tight")
fig.savefig(sub / "figure3_viewangle.pdf", bbox_inches="tight")
print("  wrote submission_300dpi/figure3_viewangle_{300dpi.png,.pdf}")
