# CM2 Agent Context

Last updated: 2026-06-14.

This file is the handoff document for future agents. Read it before editing the repo. It records the current project structure, data boundaries, implementation decisions, and viewer design details that should not be accidentally reverted.

This document was last checked against the live implementation, not just conversation memory. When updating it, verify the relevant `config/`, `script/`, `src/`, and `web/` files again before writing.

## One-Line Summary

CM2 is a research/lab calcium-imaging project around CaImAn CNMF-E. The terminal pipeline produces mmap and CNMF-E hdf5 files; an explicit cache build converts one mmap+hdf5 pair into browser-ready artifacts; the web viewer handles QC, ROI/region inspection, and temporal trace review interactively.

## Non-Negotiable Data Rules

- Do not modify or delete raw/source data unless the user explicitly says so.
- Treat these as read-only inputs:
  - `data/raw/Y.tif`
  - `data/mmap/Y_d1_2692_d2_3548_d3_1_order_C_frames_1788.mmap`
  - `data/cnmfe/*.hdf5` unless the user explicitly asks for a CNMF-E rerun or model replacement.
- Cache artifacts under `data/cache/...` are rebuildable and can be deleted/recreated by `python -m script.cache`.
- Viewer/browser-saved user outputs should belong under `data/serve/...` if/when implemented, not mixed into cache.
- Temporary tests/profile outputs should go under `temp/` and be cleaned up when no longer needed.
- Do not touch unrelated user changes. This repo may be dirty.

## Runtime Assumptions

Run commands from the repository root:

```powershell
cd C:\Users\tianrui.qi\Documents\GitHub\CM2
conda activate cm2
```

When scripting from Codex, use the explicit Python if needed:

```powershell
C:\Users\tianrui.qi\miniconda3\envs\cm2\python.exe
```

Entry points are modules in singular `script/`:

```powershell
python -m script.mmap
python -m script.cnmfe
python -m script.cache
python -m script.serve
```

Important conventions:

- The user expects to `cd` to repo root, activate `cm2`, then run `python -m script.<name>`.
- Do not reintroduce plural `scripts/`.
- Do not add complicated repo-root path bootstrapping unless truly necessary.
- `script/` files should stay thin; implementation belongs in `src/`.

## Current Structure

```text
config/
  mmap.yaml
  cnmfe.yaml
  cache.yaml
  serve.yaml

script/
  __init__.py
  mmap.py
  cnmfe.py
  cache.py
  serve.py

src/
  __init__.py
  mmap.py
  serve.py
  cnmfe/
    __init__.py
    fit.py
    attach_w.py
    cnmf.py
    components.py
    traces.py
    quality.py
    background.py
    ring.py
    patches.py
    resources.py
  cache/
    __init__.py
    builder.py
    manifest.py
    validators.py
    points.py
    profile.py
    trace_cache.py
    background_cache.py
    dff_cache.py

web/
  index.html
  app.js
  styles.css
  js/
    cache.js
    core.js
    map.js
    qc.js
    region.js
    roi.js
    trace.js
    workflow.js
  css/
    tokens.css
    base.css
    layout.css
    controls-trace.css
    qc.css
    region.css
    roi.css
    modal.css
    responsive.css

data/
  raw/
    Y.tif
  mmap/
    Y_d1_2692_d2_3548_d3_1_order_C_frames_1788.mmap
  cnmfe/
    Y-corr85-pnr12.hdf5
    other model variants may exist, e.g. Y-corr70-pnr10.hdf5
  cache/
    Y-corr85-pnr12/
  serve/
```

## Config Defaults

Current config files are deliberately flat:

- `config/mmap.yaml`
  - `raw_load_path: data/raw/Y.tif`
  - `mmap_save_stem: data/mmap/Y`
  - `write_block_mib: 128`
- `config/cnmfe.yaml`
  - `mmap_load_path: data/mmap/Y_d1_2692_d2_3548_d3_1_order_C_frames_1788.mmap`
  - `cnmfe_save_path: data/cnmfe/Y-corr85-pnr12.hdf5`
  - CNMF-E `corr_pnr` defaults currently use `min_corr: 0.85`, `min_pnr: 12`.
  - `rf: 40`, `stride: 20`, `only_init: true`, `nb_patch: 0`, `low_rank_background: null`.
  - `merge_parallel: true`.
  - No exposed `n_processes`, `caiman_temp`, or W backend knobs.
- `config/cache.yaml`
  - `mmap_load_path: data/mmap/Y_d1_2692_d2_3548_d3_1_order_C_frames_1788.mmap`
  - `cnmfe_load_path: data/cnmfe/Y-corr85-pnr12.hdf5`
  - `cache_save_fold: data/cache/Y-corr85-pnr12/`
- `config/serve.yaml`
  - `web_dir: web/`
  - `cache_load_fold: data/cache/Y-corr85-pnr12/`
  - `host: 127.0.0.1`
  - `port: 8765`
  - `debug: false`

The user may run other CNMF-E threshold variants manually. Unless explicitly redirected, cache/web/serve work should use `Y-corr85-pnr12`.

## Implementation Verification Snapshot

These are current code facts verified against implementation on 2026-06-14:

- `script/cnmfe.py` is the only script that calls `OmegaConf.resolve(cfg)`. `script/cache.py` and `script/serve.py` pass the Hydra config directly into their implementation functions.
- `script/cnmfe.py` runs two subprocess phases of itself using `CM2_CNMFE_PHASE`:
  - phase `fit`
  - phase `attach_w`
- `script/cnmfe.py` deletes any old `cnmfe_save_path + ".temp"` directory before a top-level run, preserves it on failure, and removes it after both phases succeed.
- `src/cnmfe/fit.py` still has an optional `caiman_temp` argument, but the normal project path passes the automatically derived temp directory from `script/cnmfe.py`.
- `src/cnmfe/fit.py` calls `caiman.cluster.setup_cluster(backend="multiprocessing", n_processes=None)`, so worker count is CaImAn's auto decision, not a project hardcode.
- `src/cnmfe/fit.py` patches CaImAn `run_CNMF_patches` only when streaming ring-W is needed. The patch keeps patch initialization at `gnb=0` and skips dense full-FOV W recomputation.
- In the streaming ring-W fit path, `src/cnmfe/fit.py` temporarily sets `init.nb` to `1` to trigger the necessary CaImAn code path, while the patch wrapper forces patch `gnb=0`; before saving it restores `init.nb` to `0`.
- `src/cnmfe/attach_w.py` reads the saved hdf5, computes streaming ring `W`, and writes it back through a temporary copied hdf5 under the run temp directory.
- `src/cnmfe/attach_w.py` uses `cnm.estimates.C + cnm.estimates.YrA` as the signal term for W/residual computation.
- `src/cnmfe/ring.py` currently supports streaming ring-W only for `ssub=1` and `tsub=1`. Current config satisfies this (`ssub_B: 1`, no temporal downsampling), but changing those settings needs implementation work.
- `src/cnmfe/patches.py` internally sets `preprocess/spatial/temporal.n_pixels_per_process` to `np.prod(rfs) // memory_fact` inside the disk-backed patch path. The config leaves `preprocess.n_pixels_per_process: null`, but the patched implementation may still set internal per-process pixel sizes.
- `src/cnmfe/patches.py` has a hidden recovery mode: `CM2_REUSE_PATCH_RESULTS=1` reads `CAIMAN_TEMP/patch_results`. This is for interrupted CNMF-E patch recovery, not normal cache reuse.
- `src/cnmfe/patches.py` does not support `low_rank_background: false`; current config uses `low_rank_background: null`.
- `src/cache/builder.py` deletes and recreates `cache_save_fold` on every cache build. There is no cache reuse check.
- `src/cache/manifest.py` currently sets `CACHE_VERSION = 11`.
- `src/cache/builder.py` writes trace cache sources `c`, `c_plus_yra`, and `ybg_projection`.
- `src/cache/validators.py` validates core cache files and trace artifacts, but not every human-readable export such as `profile.csv` / `profile.json`.
- `src/cache/dff_cache.py` requires saved `estimates.W` and `estimates.b0`; cache build should fail loudly if the model lacks them.
- `src/cache/dff_cache.py` computes the ring background projection as `a_k^T Ybg(t) / ||a_k||_2^2`, where `Ybg(t)` is built from `W * residual + b0`.
- `web/js/core.js` stores UI state in `cm2_web_roi_state_v2`, but intentionally saves and loads `activeRoiId` as `null`. Active ROI is not restored across page reload.
- `web/js/core.js` exposes only two source labels in Temporal: `C - bl` and `C - bl + YrA`.
- `web/js/core.js` exposes two value modes in Temporal: `ΔF` and `ΔF/F`.
- `web/js/trace.js` still has a generic percentile helper, but `getDffBaselinePercentile()` returns fixed `50`; no user-facing percentile slider exists.
- `web/js/trace.js` computes DF/F in the browser as display trace divided by median projected `Ybg`.
- `web/js/trace.js` uses active ROI for both heatmap and trace; heatmap includes all QC-passing neurons in the active ROI box, trace includes only user-selected neurons.
- `web/js/trace.js` uses spatial sorting by `x` then `y`.
- `web/js/trace.js` sets `HEATMAP_ROW_HEIGHT_PX = 0.8`.
- `web/js/trace.js` sets fixed DF/F row spacing with `TRACE_DFF_ROW_STEP_VALUE = 0.10` and `TRACE_DFF_THRESHOLD_VALUE = 0.05`.
- `web/index.html` places heatmap above trace in the Temporal section.
- `web/css/controls-trace.css` gives `.trace-plot-panel` top padding and no top border, so the first trace/guide is not hidden by a divider.
- `src/serve.py` serves `/cache/*` with `Cache-Control: no-store` and validates `metadata.json` for `/health`.

If future code differs from these facts, update this document immediately; otherwise future agents will confidently preserve the wrong thing.

## Pipeline Boundaries

### `script.mmap`

Purpose: raw TIFF to CaImAn encoded mmap.

```text
data/raw/Y.tif
  -> data/mmap/Y_d1_2692_d2_3548_d3_1_order_C_frames_1788.mmap
```

Key decisions:

- Use CaImAn's encoded mmap filename convention, not a JSON sidecar.
- Current mmap is C-order with flattened pixel rows and time columns.
- Keep `mmap_save_stem` as the user-facing setting; the implementation appends encoded dimensions/frames.
- `write_block_mib` is `128` after memory profiling. Do not casually increase it.
- The implementation in `src/mmap.py` uses block writing to avoid loading the whole TIFF into memory.
- `src/mmap.py` adds `MMAP_OFFSET = 0.0001` to each slab before writing.

### `script.cnmfe`

Purpose: encoded mmap to one CNMF-E hdf5 model.

```text
data/mmap/<encoded>.mmap
  -> data/cnmfe/<movie-or-model-id>.hdf5
```

Key decisions:

- `script/cnmfe.py` orchestrates fit and attach-W as child phases.
- Runtime temp directory is derived automatically as `cnmfe_save_path + ".temp"`, e.g. `data/cnmfe/Y-corr85-pnr12.hdf5.temp/`.
- On successful full completion, temp should be removed.
- On failure/interruption, temp is preserved for debugging.
- Do not put CaImAn temp in a model-looking folder such as `data/cnmfe/Y/`.
- The user considers mmap and CNMF-E flow mostly settled. Do not refactor CNMF-E unless asked.

### `script.cache`

Purpose: one encoded mmap plus one hdf5 model to browser cache.

```text
data/mmap/<encoded>.mmap
data/cnmfe/<model>.hdf5
  -> data/cache/<model-id>/*
```

Key decisions:

- Cache rebuild is explicit. If `cache_save_fold` exists, delete it and rebuild from scratch.
- There are no `background_load_path` or `profile_load_path` reuse paths.
- Cache build must only read `mmap_load_path` and `cnmfe_load_path`; do not mutate either input.
- All viewer artifacts are written into `cache_save_fold`.

### `script.serve`

Purpose: serve static web files and an existing cache folder.

Key decisions:

- Serve is read-only. It must not build or rebuild cache.
- `/cache/*` responses use `Cache-Control: no-store`.
- Normal URL is `http://127.0.0.1:8765/`.
- During recent QA, a temporary server was started on `http://127.0.0.1:8766/`. Treat that as temporary testing state, not project configuration.

## CNMF-E Implementation Notes

The current CNMF-E implementation exists because native CaImAn paths can blow up memory on this workstation.

Important files:

- `src/cnmfe/fit.py`: fit orchestration.
- `src/cnmfe/patches.py`: disk-backed patch aggregation replacing CaImAn's large in-memory aggregation.
- `src/cnmfe/attach_w.py`: attaches ring-background `W` into hdf5.
- `src/cnmfe/ring.py`: memory-bounded ring-background computations.
- `src/cnmfe/resources.py`: automatic memory-aware settings for attach-W.

Important decisions:

- Let CaImAn own worker-count auto-selection where possible (`setup_cluster(n_processes=None)`).
- `params.merging.merge_parallel` is enabled.
- `params.preprocess.n_pixels_per_process` is `null`, allowing CaImAn internal preprocess block logic.
- Attach-W stays CPU/reference; GPU float32 was faster but had unacceptable numerical drift, GPU float64 hybrid was slower.
- Attach-W uses an automatic memory-based `pixel_batch_size`; on this workstation it has selected large batches such as `16384`.
- BLAS/OpenMP thread env vars are kept to `1` for W attach to avoid hidden oversubscription.
- Attach-W currently requires a C-order encoded mmap. Non-C-order mmap input is rejected.
- Streaming ring-W currently requires `ssub=1` and `tsub=1`.
- `W` is written in CaImAn-compatible sparse HDF5 group format under `estimates/W` with `data`, `indices`, `indptr`, and `shape`; `b0` is also written/replaced. CaImAn then loads this as a sparse matrix.

Historical but important:

- Native CaImAn full-FOV ring background tried dense paths and could exceed 50GB RSS.
- The project added a direct-HDF5 W writer so W can be written in CaImAn sparse HDF5 format without holding all final sparse arrays in RAM.
- CaImAn loads saved `W` as CSC/CSR-compatible sparse data. Cache DFF depends on `estimates.W` and `estimates.b0`.
- `CM2_REUSE_PATCH_RESULTS=1` can reuse `patch_results` in the run temp folder for emergency recovery. This is not a normal user-facing workflow.

## Cache Artifacts

Expected cache contents under `data/cache/Y-corr85-pnr12/` include:

- `metadata.json`
- `points.json`
- `profile.csv`
- `profile.json`
- `traces_c.float32.bin`
- `traces_c_plus_yra.float32.bin`
- `traces_ybg_projection.float32.bin`
- `backgrounds/mean.png`
- `backgrounds/std.png`
- `backgrounds/bandpass.png`

`src/cache/builder.py` currently does this:

1. Load CNMF-E hdf5 with `load_cnmf`.
2. Delete/recreate `cache_save_fold`.
3. Build profile rows and metrics. If hdf5 quality fields are missing/empty, compute `snr` and `r_value` from mmap+hdf5 in memory without saving back to hdf5.
4. Write raw trace caches:
   - `c`
   - `c_plus_yra`
5. Write `ybg_projection` trace cache for MATLAB-style DF/F denominator support.
6. Write points payload with component centers/metrics/trace stats.
7. Write background PNGs.
8. Write metadata and validate cache.

Important caution:

- `cache_save_fold` is recursively deleted with `shutil.rmtree` before rebuild. It must always point to a dedicated cache output folder, never to `data/raw`, `data/mmap`, or `data/cnmfe`.

## Component Quality Metrics

`SNR_comp` and `r_values` can be missing or empty in CNMF-E hdf5 output. Cache build should compute them for the profile without modifying hdf5.

- `src/cnmfe/quality.py` owns SNR/r-value helper logic.
- It follows CaImAn CNMF-E demo intent: component evaluation for 1p data with CNN disabled.
- `r_value` must be computed memory-safely with sparse footprints and mmap row reads; avoid dense full-FOV component vectors.

## Background Design

The viewer has a `Background` section above `Quality Control`.

Available backgrounds:

- `Mean`
- `STD`
- `STD + Bandpass`

Current default:

- `STD + Bandpass`

Important design details:

- All backgrounds must have the same XY dimensions as the field of view.
- All backgrounds are auto-contrasted with ImageJ-style auto brightness/contrast.
- Background cache auto contrast uses ImageJ-style `0.35%` saturation (`contrast_mode: imagej_auto_0p35pct`).
- `STD + Bandpass` is generated from the STD projection after ImageJ-style FFT bandpass logic.
- Do not regress back to one STD-only background.
- Background options are metadata-driven from `metadata.backgrounds`; the frontend should not hardcode fixed background buttons when metadata can supply them.
- The main map uses `/cache/${background.file}` as the Plotly background image source.

## MATLAB-Style DF/F Decision

The project currently uses MATLAB CNMF_E-style endoscope DF/F, not CaImAn's detrend-only fallback.

MATLAB source reference concept:

```matlab
Ybg = bsxfun(@times, A_, 1./sum(A_.^2, 1))' * Ybg;
Df = median(Ybg, 2);
C_df = C_ ./ Df;
C_raw_df = obj.C_raw ./ Df;
```

In this project:

- CaImAn `C` includes baseline; display always subtracts `bl`.
- Paper/CNMF_E MATLAB `C` is conceptually equivalent to CaImAn `C - bl`.
- Raw source modes:
  - `C - bl`
  - `C - bl + YrA`
- DF/F modes:
  - `(C - bl) / Df`
  - `(C - bl + YrA) / Df`
- `Df` is the median over time of the projected ring background trace:

```text
Ybg_projection_k(t) = a_k^T Ybg(t) / ||a_k||_2^2
Df_k = median_t(Ybg_projection_k(t))
```

Implementation details:

- `src/cache/dff_cache.py` writes only `ybg_projection` into cache, not final pre-divided DFF traces.
- Browser computes final DF/F dynamically by taking the median of each neuron's `ybg_projection` trace.
- The percentile slider was removed. It is fixed at median/50%.
- `DFF_MIN_BASELINE_ABS = 1e-6`; denominator values with `abs(denominator) <= DFF_MIN_BASELINE_ABS` become `NaN`.
- Do not reintroduce a user-facing percentile control unless explicitly asked.

## Web Viewer Sections

Main workflow sections, in order:

1. `Background`
2. `Quality Control`
3. `Region`
4. `ROI`
5. `Temporal`

The frontend is plain HTML/CSS/JS with Plotly; no React framework.

Important files:

- `web/index.html`: static layout.
- `web/js/core.js`: global state, constants, helpers.
- `web/js/cache.js`: loads cache files.
- `web/js/map.js`: main FOV Plotly map.
- `web/js/qc.js`: QC metric filtering and histograms.
- `web/js/region.js`: region drawing/listing.
- `web/js/roi.js`: ROI table, ROI boxes, selected neurons.
- `web/js/trace.js`: Temporal heatmap/trace rendering.
- `web/js/workflow.js`: workflow section summaries, background control, section toggles.

## Current Temporal Panel Design

This area has had many user-driven refinements. Do not casually revert them.

Controls:

- Source toggle:
  - `C - bl`
  - `C - bl + YrA`
- Value mode toggle:
  - `Delta F`, displayed as `Delta` symbol in UI: `DeltaF` appears visually as `ΔF`
  - `Delta F / F`, displayed as `ΔF/F`

Rendering behavior:

- Temporal is active-ROI scoped.
- Heatmap appears above trace.
- Heatmap shows all neurons in the active ROI's box/range.
- If active ROI has no box, heatmap falls back to selected neurons.
- Trace plot shows only user-selected neurons in the active ROI.
- Switching active ROI immediately refreshes Temporal plots.
- No left-side per-ROI color strips in Temporal; it only shows one ROI at a time.
- Heatmap and trace x widths should align exactly.
- There is no heatmap/trace divider border.

Sorting:

- Current sort is spatial: first x, then y.
- This is intentional for the viewer because Temporal is tied to spatial ROI inspection.
- Other possible future sort modes could be `Spatial | Peak time | Similarity | Metric`, but they are not currently implemented.

Heatmap:

- `HEATMAP_ROW_HEIGHT_PX = 0.8`.
- Heatmap rows are not per-neuron normalized.
- Heatmap color scale is global over the current heatmap matrix: one `zmin/zmax` for all neurons/frames in the active ROI view.
- No per-row min/max, no z-score, no auto contrast per neuron.
- Heatmap colorbar is custom DOM, black-to-white, and displays the current heatmap matrix min/max; Plotly's native colorbar is disabled.

Trace:

- Trace values are not per-neuron normalized.
- For `DeltaF`, row spacing is computed from global p05/p95 over selected traces for the current source.
- For `DeltaF/F`, row spacing is fixed:
  - `TRACE_DFF_ROW_STEP_VALUE = 0.10`
  - Each neuron row represents `10% DeltaF/F`.
  - `TRACE_DFF_THRESHOLD_VALUE = 0.05`.
  - The `5%` dotted guide is exactly half of one row height.
- If a neuron's DF/F exceeds 10%, it is allowed to overlap into adjacent row space; do not compress it.
- Each row has a faint zero baseline line.
- In DF/F mode, each row has a dotted `5%` guide line.
- Only the first `5%` guide is labeled, at the left above the guide line.
- The old bottom scale bar was removed entirely.
- Current Plotly trace margin: `TRACE_PLOT_MARGIN = { l: 0, r: 0, t: 14, b: 8 }`.
- Current DF/F y-range has top padding: top is `rowStep * 0.75`.

Recent Temporal QA facts:

- With fixed `10%` DF/F row spacing, browser measurement showed:
  - row spacing around `52.66 px`
  - `5%` guide distance around `26.33 px`
  - ratio `0.5`, matching `0.05 / 0.10`
- After removing the heatmap/trace divider, CSS reported `.trace-plot-panel` border-top as `none 0px`.
- First DF/F guide had visible top headroom in QA.

## ROI/Region Design Notes

ROI:

- ROI section summary shows the active ROI name, e.g. `ROI 1`.
- If no ROI is active, the summary should be blank.
- ROI rows include neuron count in the ROI box and selected count.
- `Neuron #` is the count of QC-passing neurons in the ROI box; if the ROI has no box, it displays `-`.
- Clicking a ROI row toggles active ROI.
- Selected neurons are user picks; heatmap range neurons are determined by ROI box.
- A neuron can belong to only one ROI at a time; selecting it in one ROI removes it from any other ROI.
- If an active ROI has a box, box-outside neurons cannot be added to it.
- ROI boxes use half-open bounds: `x <= pointX < x + width` and `y <= pointY < y + height`.
- ROI row UI includes color swatch, box button, ROI name, `Neuron #`, `Selected`, clear, and delete.
- ROI color palette is `DEFAULT_ROI_COLORS`; changing a color refreshes map and Temporal.
- Known implementation note: editing or clearing an existing ROI box currently calls `refreshRoiViews()` without `includePlots: true`, so Temporal may not immediately refresh after box edits. If touching ROI editing, decide whether to preserve or fix this deliberately.

Region:

- Region section tracks larger regions/polygons and counts before/after QC.
- Temporal does not use all regions; it is active-ROI scoped.
- Region scope participates in global point filtering: region is checked before metric filters for point visibility/selection.

## QC Design Notes

- QC remains browser-interactive.
- QC filters affect visible/selectable neurons and Temporal heatmap/trace inclusion.
- QC filters are cumulative across all metrics with active ranges, not just the currently selected dropdown metric.
- QC threshold ranges use `[lower, upper)` semantics: lower inclusive, upper exclusive.
- QC UI uses a blueprint picker with `None` plus available metrics; it has both STD/z-score slider labels and absolute-value slider labels.
- `Quality Control` supports metrics such as:
  - `r_value`
  - `snr`
  - `bl`
  - `lam`
  - `neurons_sn`
  - `g_0`
  - `g_1`
  - `t_peak`
  - `t_half`
- `r_value` and `snr` are computed during cache build if missing in hdf5.

## Serve / Browser Notes

- Normal command:

```powershell
python -m script.serve
```

- Normal configured URL:

```text
http://127.0.0.1:8765/
```

- During recent QA, a temporary server was started with:

```powershell
python -m script.serve port=8766
```

- If a browser is on `http://127.0.0.1:8766/`, treat that as temporary QA state.
- Do not make `8766` the default config.
- If `/cache/metadata.json` returns 404 on a stale viewer, restart serve with the current `config/serve.yaml`.

## Hyperparameter Notebook

`notebook/hyperparameter.ipynb` was developed as the manual tuning tool for CNMF-E `method_init: corr_pnr`. In the current checked tree, the `notebook/` folder may be absent; if the user asks about this notebook, search for it or ask whether it was moved before assuming it exists.

Purpose:

- Choose `min_corr` and `min_pnr`.
- Does not run CNMF-E.
- Does not write data.
- Reads encoded mmap and computes summary images.

Current notebook behavior:

- Inputs include:
  - `MMAP_PATH`
  - FIJI ROI: `ROI_X=785`, `ROI_Y=1940`, `ROI_WIDTH=300`, `ROI_HEIGHT=300`
  - `GSIG=(3, 3)`
- Reads only the selected ROI and sampled frames; avoids full-FOV movie load.
- Uses `cm.summary_images.correlation_pnr(...)`.

Dashboard shows:

- ROI plus threshold mask and approximate candidate seeds.
- Correlation map with mask contour.
- PNR map with mask contour.
- Correlation and PNR histograms with threshold lines.
- PNR-vs-correlation density with threshold crosshair.
- `corr x PNR` score map.
- Candidate fraction grid.
- Pass ratio, candidate pixels, approximate seed count.
- Copy-ready YAML snippet.

Recent layout choices:

- Figure size `(16.5, 12.0)`.
- Dashboard image min-height `980px`.
- GridSpec height ratios `[1.85, 0.95, 0.8]`.
- Large first-row plots.
- No global title.
- No ticks/axis labels on first-row images.
- Tight colorbar spacing.

## Mmap/CaImAn Naming

CaImAn encoded mmap naming is required for easy loading:

```text
<prefix>_d1_<height>_d2_<width>_d3_1_order_C_frames_<frames>.mmap
```

Current full movie:

```text
data/mmap/Y_d1_2692_d2_3548_d3_1_order_C_frames_1788.mmap
```

Important:

- Prefix can contain underscores because CaImAn parses from the encoded tokens near the end.
- The project currently avoids JSON sidecars for mmap metadata.
- Cache and CNMF-E should load dimensions/frames from the encoded mmap filename.

## Validation Commands

Static frontend checks:

```powershell
C:\Users\tianrui.qi\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe --check web\js\trace.js
C:\Users\tianrui.qi\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe --check web\js\core.js
C:\Users\tianrui.qi\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe --check web\js\workflow.js
```

Python checks:

```powershell
C:\Users\tianrui.qi\miniconda3\envs\cm2\python.exe -m py_compile src\cache\builder.py src\cache\dff_cache.py src\serve.py
```

Serve health:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/health
```

Cache build:

```powershell
python -m script.cache
```

Serve:

```powershell
python -m script.serve
```

## Recent Web Commit Scope

A useful commit message for the current viewer batch:

```text
Refine viewer temporal QC workflow

- Show heatmap for all neurons in the active ROI while traces show selected neurons only
- Add fixed-scale DeltaF/F trace rendering with 5% guide labels
- Remove per-trace scale bar and simplify temporal plot spacing
- Tighten heatmap row height and align heatmap/trace widths
- Clean up temporal panel layout and ROI-driven refresh behavior
```

## Historical Decisions And Rejected Paths

These are not random leftovers; they explain why the current implementation looks the way it does.

Project structure:

- Early designs used `src/cm2/...`; the user chose a flatter research-project structure with direct `src/...` imports.
- Early designs had `src/estimate/`; the user chose `src/cnmfe/` for both CNMF-E fitting and hdf5 reader/helper code, because the helpers are tightly tied to CNMF-E estimates.
- Early designs used `scripts/`; the project now uses singular `script/`.
- Early designs split config into `pipeline/` and `schema/`; the user decided flat `config/mmap.yaml`, `config/cnmfe.yaml`, `config/cache.yaml`, and `config/serve.yaml` are clearer for this lab project.
- The user considered a per-dataset nested data folder layout, but current implementation uses stage-oriented folders: `data/raw`, `data/mmap`, `data/cnmfe`, `data/cache`, `data/serve`.

Mmap:

- A JSON sidecar for mmap metadata was considered and dropped. The project uses CaImAn encoded mmap names instead.
- A symlink/current-file strategy was considered for easier mmap lookup; current config points directly at the encoded mmap file.
- Larger mmap write blocks were profiled. `write_block_mib: 128` was chosen as a good memory/speed balance on this machine.

CNMF-E:

- Increasing patch size was profiled as a speed idea. It was not adopted because patch geometry can change CNMF-E results; the user chose not to change patch size just for speed.
- Project-side process-count heuristics were explored. They were removed in favor of CaImAn auto `n_processes=None`.
- `merge_parallel: true` is kept because it is a CaImAn-native parallel feature.
- Preprocess process-size tuning is not exposed as a config knob (`n_pixels_per_process: null` in config). In the disk-backed patch path, the implementation may still set internal `n_pixels_per_process` from patch size and `memory_fact`.
- A model-looking temp folder such as `data/cnmfe/Y/` was rejected. Runtime temp is now `cnmfe_save_path + ".temp"` and is removed only after full success.

W/ring background:

- Native CaImAn dense full-FOV W recomputation caused severe memory pressure and was not viable for this workstation.
- GPU W computation was explored. Float32 GPU paths were faster but changed numerical results; float64/hybrid variants were not faster enough and added complexity. The current CPU streaming W path was chosen for correctness and memory control.
- Multiprocessing W/chunk attempts gave limited gains and substantially increased complexity/coordination risk. The current implementation favors one clean memory-bounded streaming path with automatic batch sizing.
- The current W cache path is designed around correctness first: saved `W` and `b0` are required so downstream DF/F can use the full model rather than a reduced hdf5.

Cache:

- `profile_load_path` and `background_load_path` reuse logic was intentionally removed. If the user runs `python -m script.cache`, it means rebuild cache from `mmap_load_path` and `cnmfe_load_path`.
- Serve must not implicitly rebuild cache. Cache rebuild and serve are separate commands so the user can refresh cache while a server is running.
- Precomputing final DF/F traces was considered. Current cache stores `ybg_projection` and lets the browser compute final DF/F, because display logic changed several times and keeping the projection gives more flexibility.

DF/F:

- CaImAn detrend DF/F and MATLAB CNMF_E endoscope DF/F were both investigated. The user chose MATLAB-style DF/F for this project.
- A user-facing DF/F percentile slider was implemented briefly and then removed. The project now uses MATLAB's median case (`df_prctile == 50`) without a visible option.
- The current denominator is the median of projected ring background `Ybg`, not the raw movie median and not per-frame `Ybg` directly.
- `C - bl` is treated as the CNMF_E/paper-style `C`; CaImAn's stored `C` includes `bl`, so display subtracts `bl`.
- `C - bl + YrA` is the raw-residual-inclusive display source. The sign is plus `YrA`, not minus.

Viewer/Temporal:

- The old single background image was replaced with a `Background` section supporting `Mean`, `STD`, and `STD + Bandpass`; default is `STD + Bandpass`.
- The Temporal section was originally named `Trace`, then briefly misspelled `Temperal`; current correct label is `Temporal`.
- Temporal originally mixed multiple ROI color groups. It is now intentionally active-ROI scoped.
- Heatmap originally showed selected traces only; it now shows all QC-passing neurons in the active ROI box, while line traces show only user-selected neurons.
- Heatmap originally appeared below traces; it now appears above traces.
- The left ROI color strip in Temporal was removed because Temporal now displays one active ROI at a time.
- Heatmap row height was reduced to `0.8px` so large ROI heatmaps stay compact.
- Heatmap rows and trace rows are not per-neuron normalized. This matters scientifically; do not turn them into z-scored rows unless explicitly asked.
- DF/F trace auto-scaling by selected neurons was rejected because multiple-neuron plots became visually misleading. Fixed `10%` row spacing is intentional.
- The bottom scale bar was removed. The `5%` DF/F guide label lives on the first dotted guide line instead.
- The heatmap/trace divider border was removed because it could visually clip or obscure the first trace.

## Things Not To Accidentally Revert

- Do not bring back `src/cm2/...`; current package layout is flat `src/...`.
- Do not bring back `estimate/`; CNMF-E hdf5 readers/helpers live under `src/cnmfe/`.
- Do not bring back `scripts/`; current entry folder is singular `script/`.
- Do not split config back into `pipeline/` and `schema/`; current configs are flat.
- Do not make serve rebuild cache implicitly.
- Do not add cache reuse knobs like `profile_load_path` or `background_load_path`.
- Do not remove `Background` section or default `STD + Bandpass`.
- Do not revert Temporal from `C - bl` / `C - bl + YrA`.
- Do not reintroduce the DFF percentile slider.
- Do not reintroduce the bottom trace scale bar.
- Do not normalize heatmap rows individually.
- Do not normalize trace rows individually.
- Do not let DF/F auto-scale row spacing from selected neurons; fixed row spacing is intentional.
- Do not change data/model paths away from `Y-corr85-pnr12` for cache/web unless the user asks.
