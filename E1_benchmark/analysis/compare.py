#!/usr/bin/env python3
"""
compare.py — E1 agreement analysis: KinetiQ output vs reference ground truth
============================================================================

Consumes a replay result (per-frame joint angles produced by the verbatim
production core) and a reference series (marker mocap, multi-view 3D, or the
analytic truth of Tier 0), and reports the agreement statistics an IEEE Access /
Sensors reviewer expects for a measurement-accuracy claim:

    MAE, RMSE, bias        magnitude and direction of error
    Pearson r              association
    ICC(2,1)               absolute agreement, two-way random, single measure
                           (Koo & Li 2016 reporting guidance)
    Bland-Altman           bias with 95% limits of agreement, and CIs on both
    proportional bias      regression of difference on mean (Bland-Altman 1999)

Temporal alignment
------------------
Reference and index series rarely share a clock. `align_series` estimates the
constant lag by normalised cross-correlation and resamples the reference onto
the index timebase. The estimated lag is reported: a lag that drifts across a
trial indicates a frame-rate mismatch that must be fixed upstream, not absorbed
here.

2D / 3D decomposition
---------------------
KinetiQ computes angles in the image plane; marker mocap computes them in 3D.
Comparing the two directly conflates two distinct error sources. When a 3D
reference is available, pass both:

    ref_3d  — the true anatomical 3D joint angle
    ref_2d  — that same pose projected onto the camera's sagittal plane

`decompose_error` then splits total error into a projection term
(ref_3d - ref_2d, irreducible for a single camera) and a perception+pipeline
term (ref_2d - index). Reviewers reward this split because it separates a
fundamental limitation of monocular capture from implementation quality.

Usage
    python compare.py --index replay.json --ref gt.csv --joint knee --out results/
    python compare.py --selftest
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path

import numpy as np

try:
    from scipy import stats as _sps
except ImportError:  # scipy is optional; only the t-quantiles need it
    _sps = None


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------
def _t_quantile(p: float, df: int) -> float:
    """Two-sided t quantile; falls back to the normal quantile without scipy."""
    if _sps is not None:
        return float(_sps.t.ppf(p, df))
    return 1.959963984540054


def icc21(a: np.ndarray, b: np.ndarray) -> dict:
    """
    ICC(2,1) — two-way random effects, single measurement, absolute agreement.

    Targets are the n paired observations; the k = 2 "raters" are the index
    (KinetiQ) and reference measurements. Returns the point estimate with its
    95% confidence interval (Shrout & Fleiss 1979; McGraw & Wong 1996).
    """
    m = np.column_stack([np.asarray(a, float), np.asarray(b, float)])
    n, k = m.shape
    if n < 2:
        return {"icc": float("nan"), "ci_low": float("nan"), "ci_high": float("nan"), "n": int(n)}

    grand = m.mean()
    row_means = m.mean(axis=1)
    col_means = m.mean(axis=0)

    ss_rows = k * ((row_means - grand) ** 2).sum()
    ss_cols = n * ((col_means - grand) ** 2).sum()
    ss_total = ((m - grand) ** 2).sum()
    ss_err = ss_total - ss_rows - ss_cols

    df_rows, df_cols, df_err = n - 1, k - 1, (n - 1) * (k - 1)
    ms_rows = ss_rows / df_rows
    ms_cols = ss_cols / df_cols
    ms_err = ss_err / df_err if df_err > 0 else float("nan")

    denom = ms_rows + (k - 1) * ms_err + k * (ms_cols - ms_err) / n
    icc = (ms_rows - ms_err) / denom if denom != 0 else float("nan")

    # Confidence interval (McGraw & Wong 1996, ICC(A,1))
    try:
        f_obs = ms_rows / ms_err
        fl = f_obs / _f_quantile(0.975, df_rows, df_err)
        fu = f_obs * _f_quantile(0.975, df_err, df_rows)
        a_l = k * icc / (k * (1 - icc)) if icc != 1 else np.inf
        lo = (fl - 1) / (fl + (k - 1))
        hi = (fu - 1) / (fu + (k - 1))
        del a_l
    except Exception:
        lo, hi = float("nan"), float("nan")

    return {
        "icc": float(icc),
        "ci_low": float(lo),
        "ci_high": float(hi),
        "n": int(n),
        "interpretation": _icc_label(icc),
    }


def _f_quantile(p: float, df1: int, df2: int) -> float:
    if _sps is None:
        raise RuntimeError("scipy required for ICC confidence intervals")
    return float(_sps.f.ppf(p, df1, df2))


def _icc_label(icc: float) -> str:
    """Koo & Li (2016) reporting bands."""
    if not np.isfinite(icc):
        return "undefined"
    if icc < 0.50:
        return "poor"
    if icc < 0.75:
        return "moderate"
    if icc < 0.90:
        return "good"
    return "excellent"


def bland_altman(index: np.ndarray, ref: np.ndarray) -> dict:
    """
    Bland-Altman agreement: bias, 95% limits of agreement, confidence intervals
    on each, and a test for proportional bias.
    """
    x = np.asarray(index, float)
    y = np.asarray(ref, float)
    diff = x - y
    avg = (x + y) / 2.0
    n = diff.size

    bias = float(diff.mean())
    sd = float(diff.std(ddof=1)) if n > 1 else float("nan")
    loa_low, loa_high = bias - 1.96 * sd, bias + 1.96 * sd

    t = _t_quantile(0.975, n - 1) if n > 1 else float("nan")
    se_bias = sd / np.sqrt(n) if n > 1 else float("nan")
    se_loa = np.sqrt(3.0) * sd / np.sqrt(n) if n > 1 else float("nan")

    # Proportional bias: regress difference on mean.
    prop = {}
    if n > 2 and np.ptp(avg) > 0:
        slope, intercept = np.polyfit(avg, diff, 1)
        pred = slope * avg + intercept
        ss_res = float(((diff - pred) ** 2).sum())
        ss_tot = float(((diff - diff.mean()) ** 2).sum())
        r2 = 1 - ss_res / ss_tot if ss_tot > 0 else float("nan")
        se_slope = np.sqrt(ss_res / (n - 2) / ((avg - avg.mean()) ** 2).sum())
        t_slope = slope / se_slope if se_slope > 0 else float("nan")
        p_slope = (
            2 * (1 - _sps.t.cdf(abs(t_slope), n - 2)) if _sps is not None and np.isfinite(t_slope) else float("nan")
        )
        prop = {
            "slope": float(slope),
            "intercept": float(intercept),
            "r_squared": float(r2),
            "p_value": float(p_slope),
            "present": bool(np.isfinite(p_slope) and p_slope < 0.05),
        }

    return {
        "n": int(n),
        "bias": bias,
        "bias_ci": [bias - t * se_bias, bias + t * se_bias] if n > 1 else [float("nan")] * 2,
        "sd_diff": sd,
        "loa_lower": float(loa_low),
        "loa_upper": float(loa_high),
        "loa_lower_ci": [loa_low - t * se_loa, loa_low + t * se_loa] if n > 1 else [float("nan")] * 2,
        "loa_upper_ci": [loa_high - t * se_loa, loa_high + t * se_loa] if n > 1 else [float("nan")] * 2,
        "proportional_bias": prop,
    }


def basic_errors(index: np.ndarray, ref: np.ndarray) -> dict:
    x = np.asarray(index, float)
    y = np.asarray(ref, float)
    d = x - y
    r = float(np.corrcoef(x, y)[0, 1]) if x.size > 1 and np.std(x) > 0 and np.std(y) > 0 else float("nan")
    return {
        "n": int(d.size),
        "mae": float(np.abs(d).mean()),
        "rmse": float(np.sqrt((d ** 2).mean())),
        "bias": float(d.mean()),
        "sd": float(d.std(ddof=1)) if d.size > 1 else float("nan"),
        "max_abs_error": float(np.abs(d).max()),
        "p95_abs_error": float(np.percentile(np.abs(d), 95)),
        "pearson_r": r,
    }


# ---------------------------------------------------------------------------
# Temporal alignment
# ---------------------------------------------------------------------------
@dataclass
class Alignment:
    lag_seconds: float
    correlation: float
    method: str
    n_overlap: int
    warnings: list = field(default_factory=list)


def align_series(
    t_index: np.ndarray, v_index: np.ndarray,
    t_ref: np.ndarray, v_ref: np.ndarray,
    max_lag_s: float = 2.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, Alignment]:
    """
    Estimate a constant lag between the two series by normalised
    cross-correlation, then resample the reference onto the index timebase.

    Returns (t_common, index_values, ref_values_aligned, Alignment).
    """
    t_index = np.asarray(t_index, float)
    v_index = np.asarray(v_index, float)
    t_ref = np.asarray(t_ref, float)
    v_ref = np.asarray(v_ref, float)

    warnings: list[str] = []

    dt = float(np.median(np.diff(t_index))) if t_index.size > 1 else 1 / 30
    max_lag_frames = int(round(max_lag_s / dt))

    # Work on a uniform grid covering the overlap.
    t0 = max(t_index[0], t_ref[0])
    t1 = min(t_index[-1], t_ref[-1])
    if t1 <= t0:
        raise ValueError("index and reference series do not overlap in time")
    grid = np.arange(t0, t1, dt)
    gi = np.interp(grid, t_index, v_index)
    gr = np.interp(grid, t_ref, v_ref)

    zi = (gi - gi.mean()) / (gi.std() or 1)
    zr = (gr - gr.mean()) / (gr.std() or 1)

    best_lag, best_corr = 0, -np.inf
    for lag in range(-max_lag_frames, max_lag_frames + 1):
        if lag < 0:
            a, b = zi[-lag:], zr[: len(zr) + lag]
        elif lag > 0:
            a, b = zi[: len(zi) - lag], zr[lag:]
        else:
            a, b = zi, zr
        if a.size < 10:
            continue
        c = float((a * b).mean())
        if c > best_corr:
            best_corr, best_lag = c, lag

    lag_s = best_lag * dt
    if abs(lag_s) > 0.8 * max_lag_s:
        warnings.append(
            f"estimated lag {lag_s:.3f}s is near the {max_lag_s}s search bound; "
            "verify the clocks are genuinely offset by a constant"
        )
    if best_corr < 0.9:
        warnings.append(
            f"peak cross-correlation is only {best_corr:.3f}; the series may not "
            "describe the same movement, or the lag may be drifting"
        )

    ref_aligned = np.interp(grid, t_ref - lag_s, v_ref)
    return grid, gi, ref_aligned, Alignment(
        lag_seconds=float(lag_s), correlation=float(best_corr),
        method="normalised cross-correlation", n_overlap=int(grid.size),
        warnings=warnings,
    )


# ---------------------------------------------------------------------------
# Error decomposition
# ---------------------------------------------------------------------------
def decompose_error(index: np.ndarray, ref_2d: np.ndarray, ref_3d: np.ndarray) -> dict:
    """
    Split total error into the monocular projection term and the
    perception + pipeline term.

        total       = index - ref_3d
        projection  = ref_2d - ref_3d      (irreducible for one camera)
        pipeline    = index  - ref_2d      (what the implementation controls)
    """
    index = np.asarray(index, float)
    ref_2d = np.asarray(ref_2d, float)
    ref_3d = np.asarray(ref_3d, float)

    total = index - ref_3d
    projection = ref_2d - ref_3d
    pipeline = index - ref_2d

    var_total = float(total.var()) or float("nan")
    return {
        "total": {"mae": float(np.abs(total).mean()), "rmse": float(np.sqrt((total ** 2).mean())), "bias": float(total.mean())},
        "projection_term": {
            "mae": float(np.abs(projection).mean()),
            "rmse": float(np.sqrt((projection ** 2).mean())),
            "bias": float(projection.mean()),
            "share_of_variance": float(projection.var() / var_total) if np.isfinite(var_total) else float("nan"),
        },
        "pipeline_term": {
            "mae": float(np.abs(pipeline).mean()),
            "rmse": float(np.sqrt((pipeline ** 2).mean())),
            "bias": float(pipeline.mean()),
            "share_of_variance": float(pipeline.var() / var_total) if np.isfinite(var_total) else float("nan"),
        },
        "note": (
            "The projection term is a property of single-camera capture, not of the "
            "implementation. Report both: total error is the honest end-to-end product "
            "figure; the pipeline term is what engineering work can reduce."
        ),
    }


# ---------------------------------------------------------------------------
# Top-level analysis
# ---------------------------------------------------------------------------
def analyse(
    t_index, v_index, t_ref, v_ref,
    joint: str = "knee",
    ref_3d=None,
    align: bool = True,
) -> dict:
    if align:
        t, xi, xr, al = align_series(t_index, v_index, t_ref, v_ref)
        alignment = asdict(al)
    else:
        t = np.asarray(t_index, float)
        xi = np.asarray(v_index, float)
        xr = np.asarray(v_ref, float)
        alignment = {"method": "none (series assumed synchronous)"}

    out = {
        "joint": joint,
        "alignment": alignment,
        "errors": basic_errors(xi, xr),
        "icc_2_1": icc21(xi, xr),
        "bland_altman": bland_altman(xi, xr),
    }

    if ref_3d is not None:
        r3 = np.interp(t, np.asarray(t_ref, float), np.asarray(ref_3d, float))
        out["error_decomposition"] = decompose_error(xi, xr, r3)

    return out


def summarise(res: dict) -> str:
    e, icc, ba = res["errors"], res["icc_2_1"], res["bland_altman"]
    lines = [
        f"{res['joint']}  (n = {e['n']})",
        f"  MAE      {e['mae']:.2f}°     RMSE {e['rmse']:.2f}°     bias {e['bias']:+.2f}°",
        f"  ICC(2,1) {icc['icc']:.3f} [{icc['ci_low']:.3f}, {icc['ci_high']:.3f}]  ({icc['interpretation']})",
        f"  B-A      bias {ba['bias']:+.2f}°, LoA [{ba['loa_lower']:+.2f}, {ba['loa_upper']:+.2f}]",
    ]
    pb = ba.get("proportional_bias") or {}
    if pb.get("present"):
        lines.append(f"  proportional bias present (slope {pb['slope']:+.4f}, p = {pb['p_value']:.4f})")
    if res["alignment"].get("warnings"):
        for w in res["alignment"]["warnings"]:
            lines.append(f"  WARNING  {w}")
    if "error_decomposition" in res:
        d = res["error_decomposition"]
        lines += [
            f"  decomposition   total MAE {d['total']['mae']:.2f}°"
            f"  =  projection {d['projection_term']['mae']:.2f}°"
            f"  +  pipeline {d['pipeline_term']['mae']:.2f}°",
        ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------
def selftest() -> int:
    """Validate the statistics against cases with analytically known answers."""
    rng = np.random.default_rng(20260821)
    ok = True

    def check(name, got, want, tol):
        nonlocal ok
        good = abs(got - want) < tol
        ok &= good
        print(f"  [{'PASS' if good else 'FAIL'}] {name}: got {got:.4f}, expected ~{want:.4f}")

    print("compare.py self-test")
    print("-" * 60)

    # Perfect agreement -> ICC = 1, zero error
    x = np.linspace(80, 175, 200)
    check("ICC, identical series", icc21(x, x)["icc"], 1.0, 1e-9)
    check("MAE, identical series", basic_errors(x, x)["mae"], 0.0, 1e-12)

    # Constant offset -> bias recovered exactly, ICC degraded
    off = x + 5.0
    check("B-A bias, +5° offset", bland_altman(off, x)["bias"], 5.0, 1e-9)
    check("MAE, +5° offset", basic_errors(off, x)["mae"], 5.0, 1e-9)

    # Known gaussian noise -> sd of differences recovered
    noisy = x + rng.normal(0, 2.0, x.size)
    check("sd of differences, sigma=2", bland_altman(noisy, x)["sd_diff"], 2.0, 0.35)

    # Proportional bias detected when injected
    prop = x * 1.10
    pb = bland_altman(prop, x)["proportional_bias"]
    got = 1 if pb.get("present") else 0
    ok &= got == 1
    print(f"  [{'PASS' if got else 'FAIL'}] proportional bias detected when injected (slope {pb['slope']:+.4f})")

    # Alignment recovers an injected lag
    t = np.arange(0, 10, 1 / 60)
    sig = 130 + 45 * np.sin(2 * np.pi * 0.5 * t)
    lag = 0.25
    t_shift = t + lag
    _, _, _, al = align_series(t, sig, t_shift, sig)
    check("recovered lag", al.lag_seconds, lag, 1 / 30)

    # Decomposition is exact by construction
    idx = np.array([100.0, 110.0, 120.0])
    r2d = np.array([102.0, 111.0, 123.0])
    r3d = np.array([105.0, 115.0, 125.0])
    d = decompose_error(idx, r2d, r3d)
    check("decomposition total MAE", d["total"]["mae"], np.abs(idx - r3d).mean(), 1e-12)
    check("decomposition projection MAE", d["projection_term"]["mae"], np.abs(r2d - r3d).mean(), 1e-12)
    check("decomposition pipeline MAE", d["pipeline_term"]["mae"], np.abs(idx - r2d).mean(), 1e-12)

    print("-" * 60)
    print("ALL PASS" if ok else "FAILURES PRESENT")
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _load_index(path: Path, joint: str):
    """Read a replay.js result JSON and return (t, values) for `joint`."""
    data = json.loads(path.read_text())
    series = data["series"] if isinstance(data, dict) and "series" in data else data
    t = np.array([s["t"] for s in series], float)
    v = np.array([s[joint] for s in series], float)
    return t, v


def _load_ref(path: Path, joint: str):
    """Read a reference CSV with columns: t, <joint> (and optionally <joint>_3d)."""
    import csv

    ts, vs, v3 = [], [], []
    with path.open() as fh:
        for row in csv.DictReader(fh):
            ts.append(float(row["t"]))
            vs.append(float(row[joint]))
            key3 = f"{joint}_3d"
            if key3 in row and row[key3] not in ("", None):
                v3.append(float(row[key3]))
    return np.array(ts), np.array(vs), (np.array(v3) if len(v3) == len(ts) else None)


def main() -> int:
    ap = argparse.ArgumentParser(description="E1 agreement analysis")
    ap.add_argument("--index", type=Path, help="replay result JSON (KinetiQ output)")
    ap.add_argument("--ref", type=Path, help="reference CSV with columns t,<joint>[,<joint>_3d]")
    ap.add_argument("--joint", default="knee", choices=["knee", "hip", "trunk", "ankle"])
    ap.add_argument("--out", type=Path, help="directory to write the result JSON into")
    ap.add_argument("--no-align", action="store_true", help="treat the series as already synchronous")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()

    if a.selftest:
        return selftest()
    if not a.index or not a.ref:
        ap.error("--index and --ref are required (or use --selftest)")

    t_i, v_i = _load_index(a.index, a.joint)
    t_r, v_r, v_r3 = _load_ref(a.ref, a.joint)

    res = analyse(t_i, v_i, t_r, v_r, joint=a.joint, ref_3d=v_r3, align=not a.no_align)
    res["inputs"] = {"index": str(a.index), "reference": str(a.ref)}

    print(summarise(res))
    if a.out:
        a.out.mkdir(parents=True, exist_ok=True)
        dest = a.out / f"agreement_{a.joint}.json"
        dest.write_text(json.dumps(res, indent=2))
        print(f"\nwritten: {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
