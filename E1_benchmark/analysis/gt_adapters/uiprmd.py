"""
uiprmd.py — UI-PRMD Vicon 마커 데이터 → REHAB24-6 호환 관절 배열
=================================================================

목적: 두 번째 공개 데이터셋(UI-PRMD, 딥스쿼트 m01)을 기존 E1 주입 기계
(yaw_sweep 의 smoothed_lateral / project / to_landmarks)에 **그대로** 통과시키기
위해, REHAB24-6 와 동일한 관절 인덱스 배치(JOINTS)·단위(m)·축(Y-up)·프레임률
(30fps)로 변환한다. 투영·주입 코드를 재사용해야 두 데이터셋의 차이가
"데이터"의 차이이지 "방법"의 차이가 되지 않는다.

원 데이터 (실측으로 확인, 2026-08-22):
  - 117 컬럼 = 39 마커 × (x,y,z), 절대 실험실 좌표, mm, Z-up, 100 Hz
  - 세그먼트 파일 1개 = 반복 1회 (스탠딩 시작 → 딥스쿼트 → 스탠딩 복귀)

관절 중심 근사 (마커 → 관절):
  - 고관절 중심: (ASI+PSI)/2 (측면 각도 목적의 표준적 근사)
  - 무릎/발목/어깨/발끝: 해당 외측 마커 (LKNE, LANK, LSHO, LTOE …)
  - Head: 4개 머리 마커 평균, Hips: 4개 골반 마커 평균

인용: Vakanski et al., "A Data Set of Human Body Movements for Physical
Rehabilitation Exercises," Data 3(1):2, 2018. doi:10.3390/data3010002
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from rehab24_6 import JOINTS  # noqa: E402  — 동일 레이아웃을 강제하는 원천

MARKERS = [
    "LFHD", "RFHD", "LBHD", "RBHD", "C7", "T10", "CLAV", "STRN", "RBAK",
    "LSHO", "LUPA", "LELB", "LFRM", "LWRA", "LWRB", "LFIN",
    "RSHO", "RUPA", "RELB", "RFRM", "RWRA", "RWRB", "RFIN",
    "LASI", "RASI", "LPSI", "RPSI",
    "LTHI", "LKNE", "LTIB", "LANK", "LHEE", "LTOE",
    "RTHI", "RKNE", "RTIB", "RANK", "RHEE", "RTOE",
]
MI = {n: i for i, n in enumerate(MARKERS)}

SRC_FPS = 100.0
OUT_FPS = 30.0
N_JOINTS = max(JOINTS.values()) + 1


def _to_yup_m(m: np.ndarray) -> np.ndarray:
    """(frames, markers, 3) mm Z-up → m Y-up. (x, y, z)→(x, z, y): 오른손계 유지보다
    수직축 정합이 중요하다 — 투영은 수직축과 골반 좌우축만 사용한다."""
    out = np.empty_like(m, dtype=float)
    out[..., 0] = m[..., 0]
    out[..., 1] = m[..., 2]
    out[..., 2] = m[..., 1]
    return out / 1000.0


def load_episode(path: str | Path) -> dict:
    """세그먼트 1개(반복 1회) → REHAB 레이아웃 j3d(30fps, m, Y-up) + 3D 기준각."""
    D = np.loadtxt(path, delimiter=",")
    if D.ndim == 1:
        D = D[None, :]
    assert D.shape[1] == 117, f"컬럼 {D.shape[1]} != 117: {path}"
    M = _to_yup_m(D.reshape(len(D), 39, 3))

    def mk(*names):
        return np.mean([M[:, MI[n]] for n in names], axis=0)

    j3d = np.zeros((len(M), N_JOINTS, 3))
    put = lambda joint, arr: j3d.__setitem__((slice(None), JOINTS[joint]), arr)
    put("Hips",          mk("LASI", "RASI", "LPSI", "RPSI"))
    put("Head",          mk("LFHD", "RFHD", "LBHD", "RBHD"))
    put("LeftShoulder",  mk("LSHO"))
    put("RightShoulder", mk("RSHO"))
    put("LeftUpLeg",     mk("LASI", "LPSI"))
    put("RightUpLeg",    mk("RASI", "RPSI"))
    put("LeftLeg",       mk("LKNE"))
    put("RightLeg",      mk("RKNE"))
    put("LeftFoot",      mk("LANK"))
    put("RightFoot",     mk("RANK"))
    put("LeftToeBase",   mk("LTOE"))
    put("RightToeBase",  mk("RTOE"))
    put("LeftForeArm",   mk("LELB"))
    put("RightForeArm",  mk("RELB"))
    put("LeftHand",      mk("LWRA", "LWRB"))
    put("RightHand",     mk("RWRA", "RWRB"))

    # 100 → 30 fps 선형 보간
    n = len(j3d)
    t_old = np.arange(n) / SRC_FPS
    t_new = np.arange(0.0, t_old[-1] + 1e-9, 1.0 / OUT_FPS)
    flat = j3d.reshape(n, -1)
    res = np.stack([np.interp(t_new, t_old, flat[:, k]) for k in range(flat.shape[1])], axis=1)
    j3d = res.reshape(len(t_new), N_JOINTS, 3)

    def ang(a, b, c):
        v1 = j3d[:, JOINTS[a]] - j3d[:, JOINTS[b]]
        v2 = j3d[:, JOINTS[c]] - j3d[:, JOINTS[b]]
        cos = np.einsum("ij,ij->i", v1, v2) / np.clip(
            np.linalg.norm(v1, axis=1) * np.linalg.norm(v2, axis=1), 1e-9, None)
        return np.degrees(np.arccos(np.clip(cos, -1, 1)))

    return {
        "j3d": j3d,
        "knee3d": {"left": ang("LeftUpLeg", "LeftLeg", "LeftFoot"),
                   "right": ang("RightUpLeg", "RightLeg", "RightFoot")},
        "hip3d": {"left": ang("LeftShoulder", "LeftUpLeg", "LeftLeg"),
                  "right": ang("RightShoulder", "RightUpLeg", "RightLeg")},
    }
