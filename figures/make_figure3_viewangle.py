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
DATA = RESULTS / "yaw_sweep.json"

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
plt.rcParams["svg.hashsalt"] = "figure3_viewangle"          # deterministic SVG element ids
META = {"svg": {"Date": None}, "pdf": {"CreationDate": None}}   # no timestamps → byte-stable

fig, axes2 = plt.subplots(2, 2, figsize=(S.WIDE, 3.62))   # 4.15 -> 3.62 (D7.90 원고 8쪽 유지; 글꼴은 절대 크기라 8pt 유지)
axes = [axes2[0, 0], axes2[0, 1], axes2[1, 1]]
ax_pitch = axes2[1, 0]

# --- (a) angle error vs yaw ------------------------------------------------
ax = axes[0]
for lo, hi, shade in [(-2.5, cal["good_within_yaw_deg"], S.BAND[0]),
                      (cal["good_within_yaw_deg"], cal["warn_within_yaw_deg"], S.BAND[1]),
                      (cal["warn_within_yaw_deg"], 92.5, S.BAND[2])]:
    ax.axvspan(lo, hi, color=shade, lw=0, zorder=0)
ax.plot(yaw, knee, "o-", color=S.SERIES[0], label="Knee")
ax.plot(yaw, hip, "s--", color=S.SERIES[1], label="Hip")
ax.axhline(d["baseline_sagittal_knee_mae"], color=S.GRAY, ls=":", lw=0.8)
ax.annotate("monocular floor %.1f$\\degree$" % d["baseline_sagittal_knee_mae"],
            xy=(70, d["baseline_sagittal_knee_mae"]), xytext=(52, 9.5),
            fontsize=7, color=S.GRAY, bbox=S.HALO, zorder=5,
            arrowprops=dict(arrowstyle="->", color=S.GRAY, lw=0.6, shrinkB=2))

ax.set_xlabel("Camera yaw from sagittal (deg)")
ax.set_ylabel("Joint-angle MAE (deg)")
ax.set_xlim(-2.5, 92.5); ax.set_xticks(range(0, 91, 15)); ax.set_ylim(0, 65)
ax.xaxis.set_major_locator(MultipleLocator(15))
ax.legend(loc="upper left")
S.panel_label(ax, "(a)")

# --- (b) counting and score validity vs yaw --------------------------------
ax = axes[1]
ax.plot(yaw, recall, "o-", color=S.SERIES[0], label="Repetition recall")
ax.plot(yaw, aucv, "^--", color=S.SERIES[1], label="Score AUC")
ax.axhline(0.5, color=S.GRAY, ls=":", lw=0.8)
ax.text(2, 0.515, "chance", fontsize=7, color=S.GRAY, ha="left", va="bottom", bbox=S.HALO, zorder=5)
ax.set_xlabel("Camera yaw from sagittal (deg)")
ax.set_ylabel("Recall / AUC")
ax.set_xlim(-2.5, 92.5); ax.set_xticks(range(0, 91, 15)); ax.set_ylim(0, 1.05)
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
    ax.text(88, thr + 0.010, label, fontsize=7, color=S.INK, ha="right", va="bottom", bbox=S.HALO, zorder=5)
ax.set_xlabel("Camera yaw from sagittal (deg)")
ax.set_ylabel("Alignment metric (openness)")
ax.set_xlim(-2.5, 92.5); ax.set_xticks(range(0, 91, 15)); ax.set_ylim(-0.012, 0.38); ax.set_yticks([0, 0.1, 0.2, 0.3])
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
ax.text(-43, 33.5, "camera low", fontsize=7, color=S.GRAY, va="top", bbox=S.HALO, zorder=5)
ax.text(43, 33.5, "camera high", fontsize=7, color=S.GRAY, va="top", ha="right", bbox=S.HALO, zorder=5)
axo = ax.twinx()
axo.plot(pyaw, popen, "-.", color=S.SERIES[2], lw=0.9, label="Alignment metric")
axo.set_ylim(0, 0.38)
axo.set_ylabel("Openness", fontsize=8)
axo.tick_params(axis="y", labelsize=7.5)
axo.spines["top"].set_visible(False)
# The label sits in the empty band between the alignment-metric line and the rising
# MAE curves, so its leader no longer crosses either curve.
_i30 = min(range(len(pyaw)), key=lambda i: abs(pyaw[i] - 30))
axo.annotate("alignment metric\nis blind to pitch",
             xy=(pyaw[_i30], popen[_i30]),
             xytext=(43, 0.074), fontsize=7, color=S.SERIES[2], va="top", ha="right",
             bbox=S.HALO, zorder=5,
             arrowprops=dict(arrowstyle="->", color=S.SERIES[2], lw=0.6, shrinkB=2))
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

fig.tight_layout(pad=0.5, w_pad=1.6, h_pad=0.9)
for ext, kw in [("pdf", {}), ("svg", {}), ("png", {"dpi": 300})]:
    out = HERE / f"figure3_viewangle.{ext}"
    fig.savefig(out, bbox_inches="tight", metadata=META.get(ext), **kw)
    print(f"  wrote {out.name}")

sub = HERE / "submission_300dpi"
sub.mkdir(exist_ok=True)
fig.savefig(sub / "figure3_viewangle_300dpi.png", dpi=300, bbox_inches="tight")
# IEEE TRANS-JOUR: high-contrast line figures need 600 dpi; 300 dpi is the
# photograph/grayscale figure. These panels are line art with light gray bands,
# so the submission attaches the vector PDF, with a 600 dpi raster as fallback.
sub600 = HERE / "submission_600dpi"; sub600.mkdir(exist_ok=True)
fig.savefig(sub600 / "figure3_viewangle_600dpi.png", dpi=600, bbox_inches="tight")
print("  wrote submission_600dpi/figure3_viewangle_600dpi.png")
fig.savefig(sub / "figure3_viewangle.pdf", bbox_inches="tight", metadata=META["pdf"])
print("  wrote submission_300dpi/figure3_viewangle_{300dpi.png,.pdf}")
