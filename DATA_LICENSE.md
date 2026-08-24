# Licensing of the data in this repository

This repository is **mixed-licence**. Code is MIT. The per-repetition result
tables are *derived from* two third-party datasets and carry those datasets'
terms, not MIT.

## Code — MIT

Everything under `E1_benchmark/harness/`, `E1_benchmark/analysis/`,
`E1_benchmark/device_bench/`, `figures/`, and the extracted measurement core
(`kinetiq_core.generated.js`, `kinetiq_sts.generated.js`) is MIT, per `LICENSE`.

## Derived data — per source dataset

`E1_benchmark/results/*.csv` and `*.json` contain quantities **computed from**
the reference datasets: per-repetition reference joint angles projected from
mocap, frame indices, camera-view metadata, and (for REHAB24-6) the dataset's
physiotherapist `correctness` annotation for the 191 squat repetitions analysed.

Under CC BY-NC 4.0 these tables are **Adapted Material**. They are released on
the same terms as the source:

| Derived from | Files | Licence | Attribution |
|---|---|---|---|
| REHAB24-6 | `tier15_*.csv`, `tier2_*.csv`, `tier2_report.json`, `tier2_stats.json`, `tier15_report.json` | **CC BY-NC 4.0** | Černek et al., REHAB24-6, doi:10.5281/zenodo.13305826 |
| UI-PRMD | `uiprmd_per_rep.csv`, `uiprmd_report.json` | **ODC-PDDL v1.0** (public domain dedication) | Vakanski et al., *Data* 3(1):2, 2018, doi:10.3390/data3010002 |
| Neither (synthetic / app-internal) | `t0_*.csv`, `tier0_report.json`, `sts_report.json`, `aspect_experiment.json`, `bottom_th_selection.json`, `view_metric.json`, `yaw_sweep.*` | MIT | — |

### What this means for reuse

- The REHAB24-6-derived tables may be reused **for non-commercial purposes**,
  with attribution to the dataset authors, and with changes indicated.
- No verbatim dataset file is redistributed here. To obtain the originals see
  `E1_benchmark/data/gt/FETCH.md`.
- `yaw_sweep.*` is computed from REHAB24-6 skeletons but contains only
  aggregate per-viewpoint statistics, no per-subject records; it is listed
  above as derived-but-aggregate and is likewise offered under CC BY-NC 4.0
  if you consider aggregates adapted material.

### Changes made to the source material

Reference joint angles were recomputed from the published marker/joint
trajectories (2-D sagittal projection and 3-D anatomical angle), resampled
where stated, and joined to per-repetition outputs of the measurement chain
under test. Frame ranges follow the datasets' own segmentation except for two
UI-PRMD files excluded by rules stated in `E1_benchmark/README.md` §14.1.

## History

Until v1.0.0 this repository additionally contained verbatim copies of
`Segmentation.csv`, `marker_names.txt` and `joints_names.txt` from REHAB24-6,
which contradicted both this project's own statement that neither dataset is
redistributed and the CC BY-NC terms of that material. They were removed in
v1.0.1 and replaced by `E1_benchmark/data/gt/FETCH.md`.
