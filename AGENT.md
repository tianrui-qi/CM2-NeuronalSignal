# CM2 Agent Context

## Project Shape

CM2 is a research/lab project for building CaImAn/CNMF-E artifacts and inspecting results in a browser.

Target structure:

```text
config/
  mmap.yaml
  cnmfe.yaml
  cache.yaml
  serve.yaml

script/
  mmap.py
  cnmfe.py
  cache.py
  serve.py

src/
  mmap.py
  cnmfe/
    __init__.py
    fit.py
    cnmf.py
    components.py
    traces.py
    quality.py
    background.py
  cache/
  serve.py

web/

data/
  raw/
    Y.tif
  mmap/
    Y_d1_<height>_d2_<width>_d3_1_order_C_frames_<frames>.mmap
  cnmfe/
    Y-corr85-pnr12.hdf5
    Y/
  cache/
    Y/
  serve/
    Y/
```

## Boundaries

- `script/mmap.py` runs `data/raw/<movie>.tif -> data/mmap/<movie>_d1_*_d2_*_d3_1_order_C_frames_*.mmap`.
- `script/cnmfe.py` runs an encoded mmap into one CNMF-E hdf5 model, e.g. `data/cnmfe/Y-corr85-pnr12.hdf5` or another threshold-labeled variant.
- `script/cache.py` builds viewer artifacts from an encoded mmap plus a CNMF-E hdf5 into `data/cache/<model_id>/`.
- `script/serve.py` serves `web/` and one existing cache folder. It must not implicitly rebuild cache.
- `src/mmap.py` is the TIFF-to-mmap implementation. It writes CaImAn encoded C-order `(pixels, frames)` float32 mmap files and does not write JSON sidecars.
- `src/cnmfe/` contains CNMF-E fitting plus read-only helpers for fitted hdf5 results. It should expose analysis-friendly APIs for cache builders, notebooks, and future scripts.
- `src/cache/` imports `src.cnmfe.*` helpers and writes viewer artifacts.
- `src/serve.py` serves browser assets and cache files.
- `web/` is browser frontend code only.

## Data Rules

- `data/raw/Y.tif` is the raw input boundary. Treat it as read-only.
- `data/cnmfe/Y-corr85-pnr12.hdf5` is the current default fitted CNMF-E result for cache/web/serve work. The user may also run other threshold variants in terminal, such as `data/cnmfe/Y-corr70-pnr10.hdf5`; unless explicitly redirected, use the `corr85-pnr12` model for cache, web, and serve tasks.
- Historical notes below that mention `data/cnmfe/Y.hdf5` refer to the pre-rename default model path.
- `script/serve.py` should be read-only with respect to `data/`.
- `script/cache.py` is the explicit entry point for writing `data/cache/<model_id>/`.
- Cache building may read the configured mmap and hdf5 only; it must not modify source mmap or hdf5 model files. All web artifacts belong in `cache_save_fold`.
- Temporary sanity-check outputs must be cleaned up after use.

## Runtime

- Assume local runs start from the repository root with the `cm2` conda environment activated:

```powershell
cd C:\Users\tianrui.qi\Documents\GitHub\CM2
conda activate cm2
python -m script.mmap
python -m script.cnmfe
python -m script.cache
python -m script.serve
```

- Entry points are run as modules from repo root.
- Config paths are interpreted relative to the repository root working directory.
- `src/` is an importable package for entry points.
- Keep entry scripts thin and direct. Do not reintroduce `sys.path` bootstrapping, repo-root path helpers, or `scripts/` plural naming.

## Refactor Notes

- Do not preserve unnecessary historical compatibility if it makes the new structure harder to understand.
- Prefer small sanity checks after each substantial change.

## Notebooks

- `notebook/hyperparameter.ipynb` is the recommended manual tuning entry point for CNMF-E `method_init: corr_pnr` hyperparameters, specifically `min_corr` and `min_pnr`.
- The notebook is read-only with respect to project data: it does not run CNMF-E, does not write `data/`, and does not modify hdf5 model files. It reads the encoded mmap and computes CaImAn summary images.
- Current notebook inputs are `MMAP_PATH`, FIJI ROI coordinates (`ROI_X=785`, `ROI_Y=1940`, `ROI_WIDTH=300`, `ROI_HEIGHT=300`), and `GSIG=(3, 3)`.
- It reads only the selected ROI and sampled frames from the CaImAn encoded mmap, avoiding full-FOV movie loads into memory, then calls `cm.summary_images.correlation_pnr(...)` to compute correlation and PNR images.
- The notebook UI is an interactive dashboard for choosing thresholds. Sliders control `min_corr` and `min_pnr`; the dashboard shows ROI/mask/approximate seeds, correlation and PNR maps, histograms with threshold lines, PNR-vs-correlation density with crosshair, `corr x PNR` score map, candidate fraction grid, current pass ratio/candidate pixels/approximate seed count, and a copy-ready YAML snippet.
- Recent dashboard layout choices: large first-row images, figure size `(16.5, 12.0)`, dashboard image min-height `980px`, GridSpec height ratios `[1.85, 0.95, 0.8]`, no global title, no ticks/axis labels on the first row, tightened constrained-layout whitespace, and tighter corr/PNR colorbar spacing.
- Latest side-chat validation reported a valid notebook and Python syntax across 13 code cells.

## Current CNMF-E Task

- The current CNMF-E implementation skipped CaImAn's full-FOV ring-background `W` recomputation to avoid memory blowups, then attached only `b0`. That creates an incomplete hdf5 for downstream DF/F/background work.
- The active goal is to make `script/cnmfe.py` produce a full CNMF-E hdf5 from the existing encoded mmap, including a correct ring-background `W`, while keeping memory bounded on this workstation.
- Temporary cropped/profile data and helper scripts may be created during development, but must be removed before the final full `Y` CNMF-E run.
- Do not delete `data/raw/Y.tif` or the encoded mmap. The first formal full `Y` rebuild with `n_processes: 6` showed safe patch-stage memory, but later hit the native CaImAn dense `A.toarray()` ring-background branch and the main process rose to ~51GB RSS; that run was stopped before writing `Y.hdf5`. The fix makes CaImAn skip native full-FOV `compute_W` before the branch is reached by setting the fit-time `init.nb` to 1, while forcing `run_CNMF_patches(..., gnb=0)` so patch initialization remains CNMF-E/ring-background style. A synthetic sanity test patched native `caiman...cnmf.compute_W` to raise if called; `fit.run` completed and saved hdf5 with streaming `W` and `b0`, confirming the dense native branch is no longer reached.
- A second formal full `Y` rebuild still exceeded memory before saving, now during CaImAn's patch aggregation/all-results collection. The current fix replaces CaImAn's in-memory `run_CNMF_patches` aggregation with `src/cnmfe/patches.py`, a disk-backed aggregator that streams patch results to `CAIMAN_TEMP/patch_results`, embeds them into global outputs using memmaps for large temporal arrays, and avoids storing explicit zero entries in `A`. On a synthetic test, original CaImAn aggregation and disk-backed aggregation produced identical `A/C/YrA` before merge (`A` matrix difference exactly zero; `C` and `YrA` max diff 0). `fit.py` clears patch `optional_outputs` before hdf5 save.
- Patch result streaming uses `Pool.imap_unordered` with explicit patch ids on multiprocessing backends so completed patch results do not accumulate behind one slow early patch. A Windows spawn sanity test with `n_processes=2` completed and saved hdf5 with streaming `W`.
- Historical note: a full run with disk-backed aggregation and `n_processes=6` still tripped the memory guard during heavy patch computation before hdf5 save. User later chose to remove the project-side worker-count heuristic and rely on CaImAn's native `setup_cluster(n_processes=None)` auto behavior instead.
- With `n_processes: 2`, the fit phase completed and saved a no-W `data/cnmfe/Y.hdf5`, but the first fresh-process attach attempt still hit the memory guard during `ring(W)` (`attach_w` RSS about 54 GiB, free physical memory about 1.3 GiB at only ~3% W progress). The issue was not W's final sparse size alone; the attach code used `np.memmap` row reads and built full CSR arrays in memory, which let Windows grow the process working set while scanning the full movie.
- The current attach strategy writes `W` directly into a temporary hdf5 (`*.with_w.tmp.hdf5`) in CaImAn's sparse HDF5 format, then atomically replaces the final hdf5 after success. It uses `COrderMmapRowReader` to read mmap rows through normal file I/O instead of memory-mapping the whole movie, computes `b0` by streaming blocks, counts ring entries, fills temporary flat memmap arrays for CSC `data/indices`, writes `estimates/W/{data,indices,indptr,shape}`, and deletes temporary arrays. CaImAn reads `W` as CSC and converts it back to CSR, matching native `compute_W`.
- Sanity checks passed: tiny synthetic direct-HDF5 W exactly matched the old in-memory CSR writer (`max_abs_W=0`, `max_abs_b0=0`), and a real `96x96x1788` crop with synthetic A/C wrote 478,584 W entries in 4.67 s with end RSS about 0.734 GiB. Full-image W has about 573,072,960 entries, so the output hdf5 will grow by several GiB and W writing is expected to take on the order of 1-2 hours on this workstation.
- The formal attach run finished successfully on 2026-06-13. It reused the completed no-W fit output, ran only `CM2_CNMFE_PHASE=attach_w`, and produced `data/cnmfe/Y.hdf5` (5,002,831,512 bytes). The W compute phase took about 1 h 42 min, used stable memory during monitoring (roughly 1.6 -> 5.4 GiB RSS, with >50 GiB free physical memory), then wrote HDF5 datasets and atomically replaced the no-W file. Final validation with CaImAn `load_CNMF` succeeded: `W` loads as CSR, shape `(9551216, 9551216)`, `nnz=570591480`, dtype `float32`; `b0` shape `(9551216,)`, dtype `float32`; `A` shape `(9551216, 6288)`, `C/YrA` shape `(6288, 1788)`, and `init.nb=0`.
- Runtime temp policy: `config/cnmfe.yaml` no longer declares `caiman_temp`. `script/cnmfe.py` derives the runtime temp directory from `cnmfe_save_path + ".temp"`; for the default model this is `data/cnmfe/Y.hdf5.temp/`. A normal top-level `python -m script.cnmfe` removes any old temp directory before starting, keeps all project-side and CaImAn temp artifacts there (`patch_results/`, fit tmp hdf5, attach tmp hdf5, `W_data.float32.tmp`, `W_indices.int32.tmp`), deletes the whole temp directory only after both fit and attach succeed, and preserves it on failure for debugging.
- `script/cnmfe.py` runs fit and attach-W in fresh child Python processes. The parent must forward `sys.argv[1:]` Hydra overrides to both child phases; otherwise a command such as `python -m script.cnmfe cnmfe_save_path=data/cnmfe/Y-corr70-pnr10.hdf5 ...` would create/use the default `Y-corr85-pnr12.hdf5.temp` in the children.
- Runtime resource policy: `config/cnmfe.yaml` no longer exposes `n_processes` or W batch/backend knobs. `src/cnmfe/fit.py` passes `n_processes=None` to `caiman.cluster.setup_cluster`, so CaImAn chooses its own worker count (`psutil.cpu_count() - 1`; currently 31 on this workstation). `params.merging.merge_parallel` is enabled. `params.preprocess.n_pixels_per_process` is `null`, so CaImAn keeps its internal preprocess pixel-block auto logic. Attach-W intentionally stays on the CPU reference path; GPU float32 was faster but numerically drifted from the CaImAn/CPU result on real data, and GPU float64 hybrid was slower. `src/cnmfe/resources.py` only auto-selects W `pixel_batch_size` from available system memory; on this workstation it selects `16384`.
- Current profiling task: build temporary crop data under `temp/` only, profile CNMF-E fit worker counts and attach-W batch sizes on cropped `Y.tif` data, record timing/peak memory artifacts, then tune the auto resource heuristics from measured behavior. Do not modify `data/raw/Y.tif`, the encoded full mmap, or the completed `data/cnmfe/Y.hdf5`.
- Active profile run started on 2026-06-13 in `temp/cnmfe_profile_20260613_132026` using a high-component-density `768 x 768 x 1788` crop from `data/raw/Y.tif` (`row0=1408`, `col0=2048`). The run profiles fit worker counts, patch geometries (`rf/stride`), and attach-W pixel batch sizes. It is temporary-only and must not touch the formal full `data/cnmfe/Y.hdf5`.
- CaImAn patch semantics: `rf` is half patch width, patch side is `2*rf + 1`; `stride` is effectively the overlap parameter, because patch center step is `2*rf - stride` and adjacent overlap is about `stride + 1` pixels. To profile larger patches with approximately fixed ~21 px overlap, keep `stride: 20` and vary `rf` (`40/20`, `60/20`, `80/20`, `100/20`). Do not use `rf-stride=20` as fixed overlap; that actually increases overlap with patch size.
- User decided not to change CNMF-E patch size for now. The active profile run in `temp/cnmfe_profile_20260613_132026` was restarted with `--skip-patch-profile`, profiling only `n_processes` (`1,2,3,4,6,8`) and attach-W `pixel_batch_size` (`32,64,128,256,512,1024`) on the existing `768 x 768 x 1788` crop.
- Current active task shifted to W attach performance only. The user manually stopped a fresh attach run after fit succeeded, so `data/cnmfe/Y.hdf5` is currently the no-W fit result (~358MB) and `data/cnmfe/Y.hdf5.temp/` contains interrupted attach artifacts (`Y.hdf5.with_w.tmp.hdf5`, full-size preallocated `W_data.float32.tmp`, `W_indices.int32.tmp`, and old `patch_results/`). The partial W data cannot be trusted/resumed because the current implementation does not persist the CSC `cursor`; it can only be overwritten/reused as temp allocation. Keep the formal implementation clean: CPU reference W solve, automatic memory-based batch size, and no user-facing cnmfe.yaml knobs.
- W attach profiling summary: pure Torch CUDA float32 reached roughly 1.3x-1.6x speedup in small windows but differed from the CPU/CaImAn result by about `1e-3` to `4e-3` on real data; GPU float64 hybrid preserved precision but was slower than CPU. Multiprocessing over W chunks had poor scaling because each worker repeats movie/residual work and competes for I/O/memory bandwidth. The stable improvement is `pixel_batch_size=16384` plus setting BLAS/OpenMP thread env vars to `1` before NumPy loads; short real-data windows show `batch=16384` around `3.3k-4.1k px/s` versus the old small-batch path around `2.2k px/s`.

## Current Cache/Serve Task

- Cache/web/serve work should use `data/cnmfe/Y-corr85-pnr12.hdf5` unless the user explicitly switches models. The user may run other CNMF-E variants, such as `Y-corr70-pnr10.hdf5`, in terminal; do not interfere with those runs.
- `config/cache.yaml` currently reads `data/mmap/Y_d1_2692_d2_3548_d3_1_order_C_frames_1788.mmap` and `data/cnmfe/Y-corr85-pnr12.hdf5`, and writes `data/cache/Y`.
- CNMF-E hdf5 files may contain placeholder/empty `estimates/SNR_comp` and `estimates/r_values`. `script/cache.py` now computes these in memory during cache build from the configured mmap+hdf5, then writes them into `profile.csv/profile.json`; it does not save them back into the hdf5.
- Component quality follows the CaImAn CNMF-E demo intent: use SNR and spatial correlation metrics, with CNN disabled for 1p data. The implementation keeps CaImAn's temporal SNR and activity-interval logic, but computes spatial `r_value` with sparse footprints and mmap row reads to avoid dense full-FOV component vectors.
- Viewer background cache follows the old save/web visual convention: compute a time-STD projection from the configured mmap, write both `backgrounds/std.png` and ImageJ-style FFT `backgrounds/bandpass.png` with ImageJ auto contrast, and make `bandpass` the default background. Do not regress to STD-only unless the user asks.
- A cache rebuild on 2026-06-13 produced finite `snr` and `r_value` for all 6288 components in `data/cache/Y/profile.csv`. Serve was started with `python -m script.serve` on `http://127.0.0.1:8765`; `/health` and `/` returned HTTP 200.
