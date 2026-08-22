# KinetiQ 논문용 아키텍처 그림 (국·영 혼용, 국내 학회용)

> **2026-08-22 J-BHI 원고 번호 매핑** — 8쪽 제한을 맞추기 위해 J-BHI 원고에서는 `figure1_architecture`(아키텍처)를 **싣지 않는다**. 파일명은 그대로 두고 원고 번호만 당겨서 `figure2_pipeline` = **Fig. 1**, `figure3_viewangle` = **Fig. 2**, `figure4_blandaltman` = **Fig. 3**, `figure5_external` = **Fig. 4**. 빌드 스크립트(`build/build_ieee_draft.cjs`)가 이 매핑의 정본이다. `figure2_pipeline.svg` 는 2026-08-22 **영문 + IEEE 조판판**으로 교체(한국어 원본 `figure2_pipeline_ko.svg`).

> **IEEE J-BHI 그림 규약 (2026-08-22 도입)** — 모든 그림은 `ieee_style.py` 를 따른다: Times New Roman 8pt(본문과 동일), 축선 0.6pt·눈금 안쪽, 위/오른쪽 축 제거, 그림 안 제목 없음(캡션이 담당), 패널 태그 `(a)`–`(d)` 는 축 바깥, 범례 테두리 없음, **흑백 인쇄 가능**(계열마다 선 모양·마커가 다르고 색은 무채색), PDF 폰트 Type 42 임베드. 그림은 **배치 크기 그대로 제작**한다 — 폭 7.16 in(양단) = 687 px @96 dpi, 원고 빌드가 1:1 로 넣으므로 라벨이 8pt 로 유지된다. 파이프라인 SVG 는 viewBox 폭 687 에 font-size 10.7 px(=8pt)·9.3 px(=7pt).
>
> 재출력: `python3 make_figure3_viewangle.py` (4·5 도 동일) / SVG 는 `@page{size:687px 108px}` 래퍼로 Chrome 헤드리스 `--window-size=687,108 --force-device-scale-factor=3` → PNG 2061×324 + PDF, `submission_300dpi/` 에 복사.

생성: 2026-05-31 · 기준 코드 버전: ver7-D7.65 · 출처: TECH_SPEC.md §3.2/§3.3, CES_BRIEF.md §3

## 파일 목록

| 파일 | 용도 | 비고 |
|---|---|---|
| `figure1_architecture.svg` | **마스터 (편집본)** — 계층형 아키텍처 | Inkscape/Illustrator/텍스트에디터로 수정 |
| `figure1_architecture.png` | HWP·MS Word 삽입용 | 3360×2220 px (3×, ~291 DPI @ 폭 11.7in) |
| `figure1_architecture.pdf` | **LaTeX `\includegraphics` 용** | 벡터, 840×555 pt 타이트 크롭 |
| `figure2_pipeline.svg` | **마스터 (편집본)** — 처리 파이프라인 | 〃 |
| `figure2_pipeline.png` | HWP·MS Word 삽입용 | 3540×696 px (3×) |
| `figure2_pipeline.pdf` | LaTeX 용 | 벡터, 885×174 pt |

> SVG가 진짜 원본입니다. 색·문구·박스를 바꾸면 SVG를 고친 뒤 PNG/PDF를 다시 내보내세요(아래 명령).

## 바로 붙여넣을 그림 캡션

**그림 1.** KinetiQ 시스템 아키텍처(계층형 뷰). 본 시스템은 표준 웹 브라우저에서 동작하는 무설치 클라이언트 사이드 단일 페이지 애플리케이션(PWA)으로, 프레젠테이션·추론·분석/점수·영속화·출력/연동의 5개 계층으로 구성된다. 포즈 추정 추론은 단말 내(in-browser, WebAssembly)에서 수행되어 원본 영상이 외부로 전송되지 않으며, 클라우드 동기화(Supabase)와 LLM 코칭(Gemini)만 선택적으로 네트워크를 사용한다.
*Fig. 1.* System architecture of KinetiQ (layered view): an installation-free, client-side single-page web application (PWA) running entirely in the browser. All pose-estimation inference is performed on-device, so raw video never leaves the client.

**그림 2.** KinetiQ 처리 파이프라인. 웹캠 캡처 → MediaPipe Pose(33 keypoints) → 상태머신(detectPhase) 기반 반복 카운팅 → 모듈별 관절각 점수화(5개 모듈) → 통합 Movement Health Score 및 부상위험 산출 → PDF·CSV·AI 코치·FHIR 출력. 점선 구간은 단말 내 실시간 처리로 원본 영상이 전송되지 않는다.
*Fig. 2.* Processing pipeline of KinetiQ, from webcam capture to on-device pose estimation, FSM-based repetition counting, per-module scoring, composite MHS with injury-risk estimation, and report/CSV/AI-coach/FHIR outputs.

## 삽입 크기 가이드

- **2단 논문(double column):** 그림 1은 단일 컬럼 폭(~8.5cm)엔 빽빽하므로 **양단 폭(full width, ~17cm)** 권장. 그림 2는 양단 폭 가로 배치가 자연스러움.
- **1단 논문:** 그림 1 폭 ~12–14cm.
- LaTeX 예시: `\includegraphics[width=\textwidth]{figure1_architecture.pdf}` (2단은 `figure*` 환경).

## SVG 수정 후 재내보내기 (Chrome 헤드리스)

```bash
DIR="$(pwd)"   # paper_figures 폴더에서 실행
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# PNG (3×) — figure1 예시
printf '<!doctype html><meta charset=utf-8><style>@page{size:1120px 740px;margin:0}html,body{margin:0}img{display:block;width:1120px;height:740px}</style><img src="figure1_architecture.svg">' > _w.html
"$CHROME" --headless=new --disable-gpu --virtual-time-budget=3000 --force-device-scale-factor=3 --window-size=1120,740 --screenshot="figure1_architecture.png" _w.html
"$CHROME" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=3000 --print-to-pdf="figure1_architecture.pdf" _w.html
rm _w.html
```

> ⚠️ SVG 편집 시 주의: XML 주석 안에 이중 하이픈(`--`)을 넣으면 `<img>`/브라우저 렌더링이 깨집니다. 주석은 단순하게.

## 정확성 메모

그림 내용은 모두 TECH_SPEC.md(IEEE 1016 SDD)에서 근거. 수치/구성 변경 시 SPEC과 동기화하세요.
- 단일 파일 SPA: index.html 현재 ~1.1 MB (SPEC §1.2는 D7.30 시점 1,015KB로 표기 — 본 그림은 ~1.1MB로 갱신)
- MediaPipe 33 keypoints / detectPhase 4-state FSM: §5.1–5.2
- 5 모듈 + MHS + logistic 부상위험(95% CI): §3.2, §6.3
- Supabase default ON / Gemini RAG: §3.3

---

## 그림 3 — 시야각 대비 정확도 (2026-08-21 추가, 기준 코드 ver7-D7.85 (D7.72 결과와 바이트 동일 — 측정 체인 불변 확인))

| 파일 | 용도 |
|---|---|
| `figure3_viewangle.svg` | **마스터 (편집본)** |
| `figure3_viewangle.pdf` | LaTeX `\includegraphics` 용 (벡터) |
| `figure3_viewangle.png` | HWP·MS Word 삽입용 (300 dpi) |
| `submission_300dpi/figure3_viewangle_300dpi.png` | 투고용 |
| `make_figure3_viewangle.py` | 재생성 스크립트 (`E1_benchmark/results/yaw_sweep.json` 소비) |

### 캡션

**그림 3.** 카메라 시야각에 따른 측정 정확도. REHAB24-6의 OptiTrack 3D 골격을 yaw 방향으로 공전하는 가상 카메라로 투영해 각 시점의 2D 랜드마크를 생성하고, 이를 배포 코드의 측정 체인에 그대로 투입해 얻은 결과다(9개 녹화, 191 반복, 15개 시점). 기준값은 3D 해부학적 관절각이다. **(a)** 무릎·고관절 각도 오차. yaw 0°(완전 측면)에서도 오차가 0이 아니라 2.4°인데, 이는 단안 투영이 부과하는 하한이다. **(b)** 반복 카운팅 재현율과 물리치료사 정오 라벨에 대한 점수 AUC. 각도 오차가 먼저 증가하고 카운팅 붕괴는 yaw 45° 부근에서 뒤따른다. **(c)** 랜드마크에서 산출하는 정렬 지표(openness)의 각도 캘리브레이션. 배경 음영과 점선은 앱이 사용자에게 표시하는 3단계 경계이며, 각 경계는 정확도 목표에서 역산되었다(good ≤ 10° / 무릎 5.7°, fair ≤ 23° / 무릎 13.3°).

*Fig. 3.* Measurement accuracy as a function of camera viewing angle. The REHAB24-6 OptiTrack skeleton was projected through a virtual camera orbiting in yaw, and each viewpoint was passed through the deployed measurement chain (9 recordings, 191 repetitions, 15 viewpoints); the reference is the 3D anatomical joint angle. **(a)** Knee and hip angle error. Error at 0° yaw is 2.4°, not zero: this is the floor imposed by monocular projection. **(b)** Repetition-counting recall and score AUC against physiotherapist correctness labels; angle error degrades well before counting collapses near 45°. **(c)** Angular calibration of the landmark-derived alignment metric, with the three guidance bands the application shows to users, each derived from an accuracy target rather than chosen by inspection.

### 범위 (반드시 함께 기술할 것)

이 그림은 **투영 기하 항**을 측정한다. 랜드마크는 mocap에서 투영된 것이지 픽셀에서 검출된 것이 아니므로, **해당 각도에서의 MediaPipe 지각 오차는 포함되지 않는다**. 실제 지각 오차는 데이터셋이 실제로 촬영한 두 시점에서만 측정되었다(Tier 2: 시상면 무릎 MAE 5.63°, 사면 27.66°). 따라서 (a)의 곡선은 전체 오차의 **하한**이다.

---

## 그림 4 — Bland–Altman 일치도, 시상면 vs 사면 (2026-08-22 추가, 엔진 ver7-D7.85)

| 파일 | 용도 |
|---|---|
| `figure4_blandaltman.svg` / `.pdf` / `.png` | 마스터 / LaTeX 벡터 / Word 삽입 |
| `submission_300dpi/figure4_blandaltman_300dpi.png`, `figure4_blandaltman.pdf` | 투고용 |
| `make_figure4_blandaltman.py` | 재생성 (`E1_benchmark/results/tier2_per_rep.csv` + `tier2_stats.json` 소비) |

### 캡션

**그림 4.** 앱과 모캡 유래 기준값의 Bland–Altman 일치도 (반복당 최저 무릎각, 매칭 171회). 좌: 시상면 — bias +4.4°, LoA [−4.5, +13.4]°, SRD 12.6°. 우: 사면 — bias −25.4°, LoA [−74.2, +23.5]°, SRD 69.1°. 음영 = LoA. 이 대비가 앱 내 정렬 안내의 정량적 근거다.

*Fig. 4.* Bland–Altman agreement between the application and mocap-derived reference (minimum knee angle per repetition, 171 matched repetitions). Left: sagittal view — bias +4.4°, LoA [−4.5, +13.4]°, SRD 12.6°. Right: oblique view — bias −25.4°, LoA [−74.2, +23.5]°, SRD 69.1°. Shaded bands: LoA.

### 범위
Tier 2(영상 → MediaPipe → 체인) end-to-end 수치. SRD 는 검사–재검사가 아니라 기준값 대비 오차 산포에서 유도 — 이 오차 모형 아래의 탐지 가능 변화 하한일 뿐이다.

---

## 그림 5 — 외적 타당도: 두 독립 모캡 코호트의 랜드마크 계층 일치도 (2026-08-22 추가, 엔진 ver7-D7.85)

| 파일 | 용도 |
|---|---|
| `figure5_external.svg` / `.pdf` / `.png` | 마스터 / LaTeX 벡터 / Word 삽입 |
| `submission_300dpi/figure5_external_300dpi.png`, `figure5_external.pdf` | 투고용 |
| `make_figure5_external.py` | 재생성 (`E1_benchmark/results/tier15_matched.csv` + `uiprmd_per_rep.csv` + `uiprmd_report.json` 소비) |

### 캡션

**그림 5.** 두 독립 모캡 코호트에서 배포 체인과 3D 해부학적 최저 무릎각의 Bland–Altman 일치도 (랜드마크 주입, 인지 우회). 좌: REHAB24-6 (OptiTrack; bias +1.9°, LoA [−3.9, +7.7]°). 우: UI-PRMD 딥스쿼트 (Vicon; bias +2.3°, LoA [−6.0, +10.5]°), 피험자별 색. 피험자마다 다른 수직 오프셋은 측정 체인이 아니라 단안 투영 항이다.

*Fig. 5.* Bland–Altman agreement of the deployed chain against the 3-D anatomical minimum knee angle on two independent motion-capture cohorts, landmarks injected at the interface (perception bypassed). Left: REHAB24-6 (OptiTrack; bias +1.9°, LoA [−3.9, +7.7]°). Right: UI-PRMD deep squat (Vicon; bias +2.3°, LoA [−6.0, +10.5]°), coloured by subject; the subject-specific vertical offsets are the monocular projection term, not the measurement chain.

### 범위 (반드시 함께 기술할 것)

두 패널 모두 **T1.5** 다 — MediaPipe 인지 오차가 포함되지 않는다. UI-PRMD 는 RGB 영상을 공개하지 않으므로 이 코호트에서는 end-to-end 측정이 원리적으로 불가능하다. 기준이 3D 해부학각이므로 각 패널은 단안 투영 하한(REHAB 중앙 0.22°, UI-PRMD 0.66°)을 포함한다. 두 패널의 투영 코드는 다르다 — 좌: E1 T1.5 내보내기(`tier15_export.py`, 등방 정규화), 우: `yaw_sweep` 투영(yaw 0°, 1280×960). 스윕이 yaw 0° 에서 T1.5 를 0.01° 안에서 재현하므로(무릎 MAE 2.41° vs 2.42°) 비교가 성립한다. 200 파일 중 2개는 참값 궤적만으로 정한 규칙(R1/R2, `E1_benchmark/README.md` §14.1)으로 배제됐다. 근거 수치: `E1_benchmark/results/uiprmd_report.json`.
