# CM2 Repository Instructions

Last updated: 2026-08-18.

## Scope And Routing

These instructions apply to the whole repository. For any change under
`web/**`, read and follow `web/AGENTS.md` as the more specific layer. The web
file owns frontend implementation details; this file owns repository-wide
safety, pipeline, cache, serve, and scientific boundaries.

Keep both instruction files concise. Codex merges root-to-current-directory
guidance under a finite context budget, so do not duplicate the detailed web
contract here.

CM2 is a research calcium-imaging project around CaImAn CNMF-E. The terminal
pipeline produces mmap and CNMF-E HDF5 artifacts, an explicit cache build
publishes browser-ready data, and the local web viewer supports metric and
region filtering, ROI assignment, and temporal review.

## Non-Negotiable Data Safety

- Do not modify or delete raw/source data unless the user explicitly asks.
- Treat `data/raw/**`, `data/mmap/**`, and `data/cnmfe/*.hdf5` as read-only
  inputs unless the user explicitly requests that pipeline stage to rerun.
- Cache artifacts under `data/cache/**` are rebuildable, but rebuild them only
  when the user intends a full cache replacement.
- A successful cache publication replaces the whole cache directory and does
  not copy the previous `cookie/ui_state.json`. Preserve or export that file
  first if the user wants to retain selections, regions, ROIs, ranges, and
  panel state.
- Put temporary analysis outputs under `temp/` or `/tmp`; do not mix them into
  source or cache data.
- The worktree may be dirty. Preserve unrelated user changes; never clean,
  reset, stash, or overwrite them as a convenience.

## Commands And Runtime

Run from the repository root in the `cm2` conda environment:

```bash
python -m script.mmap
python -m script.cnmfe
python -m script.cache
python -m script.serve
```

`script/` is the thin user-facing command layer. Implementation belongs in
`src/`. Do not reintroduce plural `scripts/`, `src/cm2/`, `src/estimate/`,
`src/web_cache`, or `src/web_server`.

The four canonical stages align across configuration, entry points, and
implementation:

```text
config/mmap.yaml    script/mmap.py    src/mmap.py
config/cnmfe.yaml   script/cnmfe.py   src/cnmfe/
config/cache.yaml   script/cache.py   src/cache/
config/serve.yaml   script/serve.py   src/serve/
```

Configuration files are the source of truth. Do not copy their changing
values into code or silently switch the selected dataset. The current
cache/viewer target is `Y-corr85-pnr12` unless the user requests another one.

## Pipeline Boundaries

### Mmap

- `src/mmap.py` owns TIFF-to-CaImAn mmap conversion.
- CaImAn-encoded mmap names remain authoritative; do not add a second metadata
  sidecar or a `current` symlink convention.
- The encoded suffix is:

  ```text
  <prefix>_d1_<height>_d2_<width>_d3_1_order_C_frames_<frames>.mmap
  ```

- Prefixes may contain underscores. Parse dimensions from the encoded tokens,
  not by naive underscore position.

### CNMF-E

- `src/cnmfe/fit.py` owns fitting; `src/cnmfe/patches.py` owns the disk-backed
  patch path; `src/cnmfe/attach_w.py` and `ring.py` own the memory-bounded ring
  background attachment.
- Preserve native CaImAn initialization and fit semantics. Patch geometry,
  process counts, merge behavior, and numeric precision can change scientific
  output and must not be tuned merely for cosmetic speed gains.
- Full-FOV dense W recomputation is not viable on this workstation. Preserve
  the streaming CPU path and saved `W`/`b0` needed by downstream DF/F.
- Runtime temporary state belongs at the configured CNMF-E save path plus
  `.temp` and is removed only after full success.

### Cache

- `src/cache/builder.py` builds a complete generation in a unique sibling
  staging directory; `src/cache/publisher.py` validates before promotion and
  restores the prior cache when ordinary promotion fails.
- Serve never rebuilds cache. `python -m script.cache` and
  `python -m script.serve` remain separate operations.
- Reject unsafe replacement targets, direct symlink targets, populated
  non-cache directories, and destinations containing an input artifact.
- Cleanup is restricted to staging/backup paths created by the publication.

### Serve

- `src/serve/__init__.py` is the public `{create_app, serve}` boundary;
  `src/serve/app.py` composes Flask routes.
- `src/serve/static_routes.py` serves the viewer and installed Plotly asset;
  `cache_routes.py` owns `/cache/*` and `/health`; `ui_state_routes.py` owns
  `/api/ui-state` GET/PUT/POST.
- The POST route is required by the pagehide beacon.
- Validate the configured cache before startup. Cache responses remain
  `no-store`.

## Canonical Cache Contract

The repository accepts one strict, unversioned cache shape:

- Python wire constants are in `src/cache/contract/spec.py`.
- Active Python validation is in `src/cache/contract/validation.py`.
- Browser validation and binary decoding are in
  `web/js/infrastructure/cache/adapter.js`.

Contract invariants include:

- image shape `[height, width]`, `YX`, top-left origin, x-right, y-down;
- zero-based coordinates and Fortran-order spatial flattening;
- component-major traces with explicit little-endian `<f4` storage;
- frame-based, zero-indexed time and a positive finite sample rate;
- complete `points.trace_row` permutation from stable point IDs to binary rows;
- half-open ROI boxes, lower-inclusive/upper-exclusive QC bounds, and
  edge-inclusive Region geometry;
- DFF metadata with `baseline_method: "median"` only.
- point rows with exactly `id`, `trace_row`, `x`, `y`, and `metrics`;
- metadata whose top-level and nested keys are rejected when missing or extra.

## Scientific Contracts

### Quality Metrics

- `src/cnmfe/quality.py` and `src/cache/points.py` emit raw metric values.
- Current plotting and filtering do not log-transform or Z-standardize
  `snr`, `lam`, `neurons_sn`, or any other metric.
- Missing/non-finite metric values are serialized as JSON `null`; the browser
  currently preserves JavaScript `Number(null) === 0`. Changing that is a
  scientific/data-contract decision, not a cleanup.
- Cache publication does not generate a profile sidecar or per-point trace
  summary statistics; current viewer features consume the canonical point and
  trace artifacts directly.

### Background

- Background outputs are `Mean`, `STD`, and `STD + Bandpass`; viewer default is
  `STD + Bandpass`.
- Keep image orientation and pixel coordinates consistent with cache metadata.

### MATLAB-Style DF/F

- Cache stores per-neuron projected ring background `ybg_projection`, not
  final pre-divided DF/F traces.
- The browser computes each denominator as the temporal median of that
  projection; the user-facing percentile option was removed.
- Denominators with absolute value `<= 1e-6` produce `NaN`.
- Temporal sources are `C - bl` and `C - bl + YrA`. The viewer removes the
  fitted per-component scalar `bl`; it does not run `detrend_df_f()` or any
  additional running-baseline detrend. The residual sign is plus `YrA`.

## UI State Boundary

The active local viewer state is stored at:

```text
<cache_root>/cookie/ui_state.json
```

It contains the exact current UI-state shape for active panels, metric ranges,
regions, ROIs, selected neuron IDs, and Temporal settings. A missing state file
starts from defaults; any nonempty payload with missing, extra, or malformed
fields is rejected rather than normalized into another shape. The browser uses
only the server transport. A cache rebuild intentionally removes this file
with the old cache tree.

## Web Boundary

The frontend is native HTML/CSS/ES modules plus Plotly. Its detailed
composition, feature ownership, state rules, compact layouts, accessibility,
and browser checks live in `web/AGENTS.md` and apply to `web/**` changes.

Repository-wide web invariants are:

- cache and UI-state API contracts remain separate from rendering;
- QC uses raw `{ lower, upper }` state with `null` threshold endpoints meaning
  unbounded;
- ROI/Region membership and coordinate orientation are scientific behavior;
- Temporal values, memberships, source definitions, and export mappings must
  not change during UI-only work.

## Verification

Use checks proportional to the change and avoid commands that write bytecode
or rebuild scientific artifacts unintentionally.

```bash
python -B -c "from pathlib import Path; files=[*Path('script').rglob('*.py'), *Path('src').rglob('*.py')]; [compile(p.read_bytes(), str(p), 'exec') for p in files]; print(f'{len(files)} Python files OK')"
find web -type f -name '*.js' -exec node --check {} \;
git diff --check
```

For cache/serve work, validate every in-scope cache, start the configured
server, check `/health`, and verify the root, CSS/JS, metadata, trace, and UI
state routes. Rebuild cache only when the output refresh is intentional.

For any frontend change, also follow `web/AGENTS.md` and verify the actual
browser at `http://127.0.0.1:8765/`; syntax checks do not prove layout,
gesture, Plotly, persistence, or accessibility behavior.

## Change Discipline

- Preserve public imports and keyword-only call signatures unless the task
  explicitly changes the contract.
- Use feature/store command boundaries rather than mutating viewer state
  directly.
- Keep calculations pure and testable; keep DOM, Plotly, persistence, and
  cross-feature orchestration at their documented boundaries.
- Do not add dependencies, generated build systems, or automated test
  workspaces unless the user asks. The project intentionally has no committed
  frontend Node workspace or regression harness.
- Update the relevant `AGENTS.md` when a durable ownership rule or invariant
  changes; do not turn it into a changelog, historical narrative, or proposed
  commit message.
