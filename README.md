# KinetiQ E1 — verbatim-extraction measurement-accuracy benchmark

Harness, extracted measurement core, per-repetition outputs, and figure scripts supporting:

> **Benchmarking the Deployed Artifact: Verbatim-Extraction Testing and Viewing-Angle Error Decomposition of a Browser-Based Markerless Movement Assessment Platform**
> S. Heo, T. Choi, Y. Jang, W. Choi — submitted to *IEEE Journal of Biomedical and Health Informatics*, 2026.

## What this is

Published evaluations of camera-based movement assessment usually test a **research pipeline assembled for the study**, not the code users actually run. This harness closes that gap: `extract_core.cjs` slices the measurement functions out of the deployed single-page application **by line range**, records a SHA-256 for each, and emits a module that the harness executes **unmodified**. The artifact evaluated is byte-identical to the artifact deployed, and `harness/provenance.json` binds every result to one engine version.

Three reference tiers drive it:

| Tier | Input | Reference | Isolates |
|---|---|---|---|
| **T0** | analytic synthetic kinematics | exact by construction | angle math, FSM logic, tempo semantics, frame-rate and noise sensitivity |
| **T1.5** | mocap trajectories injected at the landmark interface (REHAB24-6; UI-PRMD) | mocap 3-D anatomical and 2-D projected angles | measurement logic on real human motion, perception bypassed |
| **T2** | original videos → production MediaPipe → chain | dataset-published 2-D camera projections | end-to-end deployed behaviour, including perception |

A virtual camera orbiting the mocap skeleton (`yaw_sweep.py`) additionally yields accuracy as a continuous function of camera yaw and pitch.

### The guidance layer under test

The sweep is not only a result. Its thresholds are compiled into the deployed application, which tells the user *during* the measurement whether the camera is placed well enough for the angle it is about to report. These are the three yaw-axis states the shipped build renders in that banner:

![The three yaw-axis camera-alignment states rendered by the deployed KinetiQ build](assets/alignment-guidance.png)

| Band | Shipped bound | Camera yaw | Projection-term knee MAE | Banner text, translated (icon omitted) |
|---|---|---|---|---|
| good | `openness ≤ 0.06` | ≤ 10.3° | ≈ 5.7° | "Side alignment good" |
| fair | `openness ≤ 0.13` | ≤ 22.8° | ≈ 13.3° | "Slightly rotated — turn your body a little more to the side" |
| poor | beyond that | > 22.8° | > 13.3° | "You are almost facing the camera head-on — stand so you see the camera from the side" |

`openness` is the **mean** of the shoulder and hip horizontal separations over torso height, `(|Lsh.x − Rsh.x| + |Lhip.x − Rhip.x|) / (2 × torso height)`, computed in the isotropic (aspect-corrected) space; `harness/view_metric.cjs` derives it and shows why the aspect correction matters. The two bounds are `KQ_VIEW_GOOD` and `KQ_VIEW_WARN` in the deployed source. The `openness > 0.3` cut recorded in `results/view_metric.json` is a coarser threshold used only to *select* the metric against the labelled corpus; it is not the shipped banner bound.

The yaw and error columns are linearly interpolated between the 5°-spaced rows of `E1_benchmark/results/yaw_sweep.csv` at `pitch = 0`, which this repository regenerates: `yaw 10° → knee MAE 5.50°` and `15° → 7.94°` bracket the good bound, `20° → 11.11°` and `25° → 14.98°` the fair bound. It is a mean-curve calibration, so per-repetition scatter (`openness_sd` 0.012–0.018) is roughly ±2–3° of yaw about each edge. Perfect alignment does not buy zero error: yaw 0° still costs 2.41°, the monocular projection floor.

> **How this was made.** Rendered 2026-08-24 from the deployed `ver7-D7.88` build; the archived results here are pinned to `ver7-D7.85` (`harness/provenance.json`), in which the `kqViewGrade` thresholds and all three label strings are byte-identical. The banner is drawn by the shipped code path (`kqViewGrade` → `updateViewGuide`) with the metric value supplied directly rather than by a camera, so no participant image and no frame from either licensed dataset appears anywhere in this repository. The three bars are composited from three separate renders; the live banner shows one at a time.
>
> **Scope.** These are the yaw-axis states only. Where the device exposes an orientation sensor the same banner also carries a camera-height axis: `updateViewGuide` shows whichever axis is worse and merges the two into a single line when both are good, so the green state above is what a device without that sensor shows. `kqViewGrade` has a fourth `unknown` state while the median window fills. The application source is **not** part of this repository — see the next section. The on-screen text is Korean in this build; the English column above is a translation, not a screenshot.

## What is *not* here

- **The application source.** Only the measurement functions the benchmark executes are included, as extracted by `extract_core.cjs` (`harness/kinetiq_core.generated.js`, `harness/kinetiq_sts.generated.js`). The full platform is a commercial product and stays closed.
- **The datasets.** No verbatim dataset file is redistributed. Obtain them from the original sources, then verify against the checksums in [`E1_benchmark/data/gt/FETCH.md`](E1_benchmark/data/gt/FETCH.md):
  - **REHAB24-6** — doi:[10.5281/zenodo.13305826](https://doi.org/10.5281/zenodo.13305826) (CC BY-NC 4.0)
  - **UI-PRMD** — University of Idaho, ODC-PDDL v1.0 ([Vakanski et al., *Data* 3(1):2, 2018](https://doi.org/10.3390/data3010002))

  What *is* included is derived: the per-repetition tables in `results/` carry reference angles recomputed from the published trajectories, and for REHAB24-6 the dataset's `correctness` annotation for the 191 squat repetitions analysed. Those tables are Adapted Material under the source licences, not MIT — see [`DATA_LICENSE.md`](DATA_LICENSE.md).
- **Video frames / landmark corpora.** Large intermediates are regenerated by the scripts below.

## Layout

```
E1_benchmark/
├── README.md                     방법론·결과·주장 위생 전문 (Korean)
├── harness/
│   ├── extract_core.cjs          deployed source → measurement core (+ SHA-256)
│   ├── kinetiq_core.generated.js [generated] do not hand-edit — re-extraction overwrites
│   ├── provenance.json           [generated] engine version, line ranges, hashes, patches
│   ├── harness_shim.js           APP state, DOM/UI stubs, virtual (video-time) clock
│   ├── replay.js                 deterministic frame replay driver
│   ├── synth_kinematics.js       analytic ground-truth generator (forward kinematics)
│   ├── tier0_verify.cjs          T0: six software-correctness experiments
│   ├── tier15_export.py          REHAB24-6 mocap → landmark streams
│   ├── tier15_run.cjs            T1.5 replay + matching + statistics
│   ├── uiprmd_sweep.py           UI-PRMD Vicon → landmark streams (exclusion rules R1/R2)
│   ├── uiprmd_run.cjs            external-validity replay, subject-level bootstrap, Bland–Altman
│   ├── yaw_sweep.py              virtual-camera projection sweep (yaw / pitch)
│   ├── tier2_*.{cjs,py,html}     end-to-end video → MediaPipe → chain, statistics
│   └── ...
├── analysis/gt_adapters/         dataset adapters (REHAB24-6, UI-PRMD)
├── data/gt/FETCH.md              how to obtain the datasets (+ SHA-256); no dataset file is shipped
├── results/                      per-repetition CSVs and report JSONs (every number in the paper)
└── device_bench/                 on-device benchmark protocol + analyser
figures/                          figure-generation scripts (consume results/*.json)
assets/                           README images (rendered from the shipped UI, no participant data)
```

## Reproducing

Node ≥ 18 and Python ≥ 3.10 (`numpy`, `matplotlib`, `pypdf`). Datasets are expected under `~/KinetiQ_datasets/`.

```bash
cd E1_benchmark/harness
node extract_core.cjs        # re-extract the measurement core from the shipped source (hash-verified)
node tier0_verify.cjs        # T0: synthetic ground truth
python3 tier15_export.py     # REHAB24-6 → landmark streams
node tier15_run.cjs          # T1.5
python3 uiprmd_sweep.py      # UI-PRMD → landmark streams
node uiprmd_run.cjs          # T1.5 external validity (subject-level bootstrap, B=10,000, seed 42)
python3 yaw_sweep.py         # viewing-angle sweep
node tier2_stats.cjs         # T2 recording-level bootstrap, Bland–Altman, SRD
```

Every script writes into `results/`; figures are regenerated from those files by `figures/make_figure*.py`. Results are deterministic (fixed bootstrap seeds, video-time clock), so a re-run reproduces the committed outputs byte-for-byte.

`E1_benchmark/README.md` documents the full method, the eight defects the benchmark exposed, the corrections, and the **claim-hygiene rules** that govern how these numbers may be described — in particular that Tier 2 is a benchmark against mocap-derived references, **not** a clinical validation study.

## Citation

Cite the paper (details in `CITATION.cff`; DOI added on publication). This archive itself is deposited on Zenodo — cite the DOI of the version you used.

## License

Mixed. **Code is MIT** (see `LICENSE`). **Derived result tables carry the source datasets' licences** — REHAB24-6-derived files are CC BY-NC 4.0 Adapted Material, UI-PRMD-derived files are ODC-PDDL v1.0. Full breakdown per file in [`DATA_LICENSE.md`](DATA_LICENSE.md).
