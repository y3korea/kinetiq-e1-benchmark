#!/usr/bin/env python3
"""
uiprmd_sweep.py — UI-PRMD 딥스쿼트를 배포 체인 주입 형식으로 변환
==================================================================

두 번째 데이터셋 검증(외적 타당도). REHAB24-6 yaw 스윕과 **동일한 투영·주입
기계**(yaw_sweep 의 smoothed_lateral / project / to_landmarks 를 import)를
yaw 0°(시상면)에서 사용한다. 주의: REHAB 의 T1.5 대조값(tier15_matched.csv)은
tier15_export.py 의 다른 투영 코드(rehab24_6.project_to_sagittal, 등방 정규화,
프레임 기하 미지정)로 만들어졌다. 스윕은 yaw 0° 에서 T1.5 를 0.01° 안에서
재현하므로(무릎 MAE 2.41° vs 2.42°) 두 코호트는 비교 가능하지만, "같은 코드"가
아니라 "같은 결과를 내는 것이 검증된 코드"다. 원고·README 에 그렇게 쓴다.

구성:
  - 피험자별 2개 스트림 (correct 10회 / incorrect 10회)
  - 세그먼트 사이 1.2s 스탠딩 홀드 (해당 세그먼트의 마지막 프레임 유지)
  - 스트림 맨 앞: 첫 세그먼트의 서기 프레임 1.2s 리드인.
    일부 세그먼트가 하강 중에 시작하기 때문(s02 e01 서기 127°) — FSM 은
    서기에서 무장(arm)되므로, 녹화 자신의 서기 프레임으로 워밍업한다.
    리드인·홀드는 채점 창(window) 밖이다.
  - 홀드 프레임 = 기본은 세그먼트의 마지막 프레임. 단, 마지막 프레임이
    기립이 아니고(3D 무릎 < 150°) 첫 프레임은 기립이면 첫 프레임 (가드 —
    아래 배제 규칙 뒤에는 적용되는 파일이 없다). episodes[].hold_frame 기록.
  - **단일 반복으로 채점 불가능한 파일의 배제 (참값만으로 판정, 앱 출력 무관)**:
      R1. 마지막 프레임이 기립(3D 무릎 ≥ 150°)이 아니면 반복이 파일 안에서
          완결되지 않는다 → 제외.
      R2. 첫 프레임이 기립이 아니고, 전역 최저점 *이전에* 기립 구간이 있으면
          파일이 앞 동작의 꼬리를 담고 있다 → 제외. (하강 중에 시작하지만
          최저점과 복귀를 담은 파일, 예: s02 e01 시작 127° 는 유지된다.)
    200 파일 중 2개(s07 incorrect e04·e05)만 해당한다. 원시 궤적을 보면
    e04 = 반복 A 의 하강(1.13 s, 113° 에서 끝), e05 = 반복 A 의 상승 + 기립
    ~1.3 s(최대 171°) + 반복 B 전체(최저 105°) — 데이터셋 분할이 한 동작을 둘로 쪼개고
    둘째 파일에 반복을 하나 더 넣었다. 배포 체인은 이 구간에서 반복 2회를
    검출했는데(13.5 s, 16.0 s), 이는 파일 단위 참값으로는 "FP 1 + 고관절
    오차 94°" 로 나타났었다 (2026-08-22 조사, README §14.5). 배제 목록과
    사유는 manifest.json 의 excluded 에 기록한다.

기준각: 3D 해부학적 각(모노큘러 투영 하한 포함)과 2D 투영각(체인-대-투영,
FSM/EMA 만 분리) 둘 다 기록한다 — REHAB 분석과 동일한 이중 기준.

Usage: python3 uiprmd_sweep.py [--data ~/KinetiQ_datasets/UI-PRMD] [--out <dir>]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "analysis" / "gt_adapters"))

import yaw_sweep as YS                    # noqa: E402 — 투영 기계 재사용 (검증된 원본)
from uiprmd import load_episode, OUT_FPS  # noqa: E402
from rehab24_6 import JOINTS              # noqa: E402

FPS = OUT_FPS
HOLD_S = 1.2
STAND_DEG = 150.0     # 3D 무릎각이 이 이상이면 '기립'으로 본다 (홀드 프레임 선택에만 사용)
FRAME_W, FRAME_H = YS.FRAME_W, YS.FRAME_H


def angle2d_px(xy: np.ndarray, a: int, b: int, c: int) -> np.ndarray:
    """정규화 좌표 → 픽셀 공간 각도 (등방·이미지 평면 참값)."""
    P = np.stack([xy[:, :, 0] * FRAME_W, xy[:, :, 1] * FRAME_H], axis=2)
    v1 = P[:, a] - P[:, b]
    v2 = P[:, c] - P[:, b]
    cos = np.einsum("ij,ij->i", v1, v2) / np.clip(
        np.linalg.norm(v1, axis=1) * np.linalg.norm(v2, axis=1), 1e-9, None)
    return np.degrees(np.arccos(np.clip(cos, -1, 1)))


def scorable(k3: np.ndarray) -> tuple[bool, str]:
    """파일 1개가 단일 반복으로 채점 가능한가 — 3D 무릎각 궤적만으로 판정."""
    ends_standing = bool(k3[-1] >= STAND_DEG)
    starts_standing = bool(k3[0] >= STAND_DEG)
    imin = int(np.argmin(k3))
    prior_stand = bool((k3[:imin] >= STAND_DEG).any())
    if not ends_standing:
        return False, f"R1 ends below standing (last knee {k3[-1]:.1f}°): repetition not completed in file"
    if not starts_standing and prior_stand:
        return False, (f"R2 starts below standing (first knee {k3[0]:.1f}°) with a standing interval before "
                       f"the global minimum ({k3[imin]:.1f}°): file contains the tail of a previous movement")
    return True, ""


def build_stream(files: list[Path]) -> dict:
    """세그먼트 목록 → 홀드 이어붙인 스트림 + 세그먼트별 기준값. 채점 불가 파일은 배제."""
    episodes, j3d_parts, excluded = [], [], []
    lead = None
    t = 0.0
    for f in files:
        ep = load_episode(f)
        j = ep["j3d"]
        k3 = ep["knee3d"]["left"]
        ok, why = scorable(k3)
        if not ok:
            excluded.append({"file": f.name, "reason": why,
                             "knee3d_first": round(float(k3[0]), 2), "knee3d_last": round(float(k3[-1]), 2),
                             "knee3d_min": round(float(k3.min()), 2), "duration_s": round(len(k3) / FPS, 2)})
            continue
        hold_frame = "first" if (k3[-1] < STAND_DEG <= k3[0]) else "last"   # 가드: 배제 뒤에는 항상 last
        hold_src = j[:1] if hold_frame == "first" else j[-1:]
        if lead is None:                     # 스트림 리드인: 첫 세그먼트의 서기 프레임
            lead = np.repeat(hold_src, int(HOLD_S * FPS), axis=0)
            j3d_parts.append(lead)
            t += len(lead) / FPS
        t0 = t
        j3d_parts.append(j)
        t += len(j) / FPS
        t1 = t
        hold = np.repeat(hold_src, int(HOLD_S * FPS), axis=0)
        j3d_parts.append(hold)
        t += len(hold) / FPS
        episodes.append({
            "file": f.name, "t0": round(t0, 3), "t1": round(t1, 3),
            "hold_frame": hold_frame,
            "knee3d_first": round(float(k3[0]), 2), "knee3d_last": round(float(k3[-1]), 2),
            "gt3d_min_knee": {s: round(float(ep["knee3d"][s].min()), 2) for s in ("left", "right")},
            "gt3d_min_hip": {s: round(float(ep["hip3d"][s].min()), 2) for s in ("left", "right")},
        })
    j3d = np.concatenate(j3d_parts, axis=0)
    return {"j3d": j3d, "episodes": episodes, "excluded": excluded}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=Path.home() / "KinetiQ_datasets" / "UI-PRMD")
    ap.add_argument("--out", type=Path, default=Path.home() / "KinetiQ_datasets" / "UI-PRMD" / "streams")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)

    cor_dir = next(a.data.glob("extracted/*/Vicon/Positions"))
    inc_dir = next(a.data.glob("extracted_inc/*/Vicon/Positions"))
    manifest, excluded_all, files_total = [], [], []
    for subj in range(1, 11):
        for label, d, suffix in (("correct", cor_dir, ""), ("incorrect", inc_dir, "_inc")):
            files = sorted(d.glob(f"m01_s{subj:02d}_e*_positions{suffix}.txt"))
            files_total.extend(files)
            if len(files) != 10:
                print(f"  경고: s{subj:02d} {label} 파일 {len(files)}개 (기대 10)")
            if not files:
                continue
            st = build_stream(files)
            j3d = st["j3d"]
            lateral = YS.smoothed_lateral(j3d)
            xy = YS.project(j3d, lateral, yaw_deg=0.0)
            frames = YS.to_landmarks(xy, near="left")

            # 세그먼트별 2D 투영 기준각 (좌측 = near, 체인이 고를 쪽)
            k2d = angle2d_px(xy, JOINTS["LeftUpLeg"], JOINTS["LeftLeg"], JOINTS["LeftFoot"])
            for ep in st["episodes"]:
                i0, i1 = int(round(ep["t0"] * FPS)), int(round(ep["t1"] * FPS))   # t 는 프레임/30 을 3자리로 반올림한 값
                ep["gt2d_min_knee_left"] = round(float(k2d[i0:i1].min()), 2)

            name = f"s{subj:02d}_{label}"
            out = {
                "dataset": "UI-PRMD m01 deep squat (Vicon markers)",
                "subject": subj, "label": label, "fps": FPS,
                "frame": {"w": FRAME_W, "h": FRAME_H},
                "projection": "yaw 0 (sagittal), same machinery as yaw_sweep",
                "episodes": st["episodes"],
                "landmarks": frames,
            }
            (a.out / f"{name}.json").write_text(json.dumps(out))
            gts = [e["gt3d_min_knee"]["left"] for e in st["episodes"]]
            for x in st["excluded"]:
                excluded_all.append({"stream": name, "subject": subj, "label": label, **x})
            print(f"  {name}: {len(st['episodes'])}세그 {len(frames)}fr  "
                  f"GT3D 무릎최저 중앙 {np.median(gts):.1f}°"
                  + (f"  제외 {[x['file'] for x in st['excluded']]}" if st["excluded"] else ""))
            manifest.append(name)
    (a.out / "manifest.json").write_text(json.dumps({
        "streams": manifest, "fps": FPS, "files_total": len(files_total), "excluded": excluded_all,
        "exclusion_rules": {"R1": "last frame below standing (3-D knee < 150°): repetition not completed in file",
                            "R2": "first frame below standing and a standing interval precedes the global minimum: file contains the tail of a previous movement"},
    }, indent=1))
    print(f"  제외 파일 {len(excluded_all)}개: " + ", ".join(f"{x['file']} ({x['reason'].split(':')[0]})" for x in excluded_all))
    print(f"\nwritten: {a.out}  ({len(manifest)} streams)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
