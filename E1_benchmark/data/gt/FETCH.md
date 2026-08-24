# Obtaining the reference datasets

This repository does **not** redistribute either dataset. The files this
directory previously held were removed in v1.0.1 because they were verbatim
copies of REHAB24-6 material, which is licensed CC BY-NC 4.0 and cannot be
re-released under this repository's MIT terms.

Download them from the original sources and verify against the SHA-256 values
below before running the harness.

## REHAB24-6

Source: <https://doi.org/10.5281/zenodo.13305826> (CC BY-NC 4.0)

Place into this directory (`E1_benchmark/data/gt/`):

| File | SHA-256 | Used by |
|---|---|---|
| `Segmentation.csv` | `72c70bc7e56eafb132452a850f7a56d21c3cb4a602bab1e98370f9b606567100` | `analysis/gt_adapters/rehab24_6.py --segmentation` |
| `marker_names.txt` | `66864eb0060e27f49ba6de4120d6307a3b0e3edda281c0b9554c20366256afa9` | reference only |
| `joints_names.txt` | `f3aa2491e9fedaeb5af74606135c54bc3b1027ce6daf7f2a21c5c094853b5f5b` | reference only |

Mocap trajectories (`Ex<N>/<video_id>-<30|120>fps.npy`) and the camera-18 videos
are large and were never included; put them under `~/KinetiQ_datasets/` as the
harness README describes.

Verify:

```bash
shasum -a 256 -c <<'SUMS'
72c70bc7e56eafb132452a850f7a56d21c3cb4a602bab1e98370f9b606567100  Segmentation.csv
66864eb0060e27f49ba6de4120d6307a3b0e3edda281c0b9554c20366256afa9  marker_names.txt
f3aa2491e9fedaeb5af74606135c54bc3b1027ce6daf7f2a21c5c094853b5f5b  joints_names.txt
SUMS
```

## UI-PRMD

Source: University of Idaho, <https://webpages.uidaho.edu/ui-prmd/> (ODC-PDDL v1.0)
Cite: Vakanski et al., *Data* 3(1):2, 2018, doi:10.3390/data3010002.

Movement 1 (deep squat), Vicon trajectories. Not redistributed here.
