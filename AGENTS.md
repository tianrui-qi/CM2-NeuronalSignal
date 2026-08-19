# CM2 Repository Instructions

## Scope

These instructions apply to the whole repository. For `web/**`, also read
`web/AGENTS.md`; it owns frontend composition, interaction, accessibility,
and browser verification. For `site/**`, also read `site/AGENTS.md`; it owns
the Sites deployment adapter. This file owns repository safety, pipeline,
cache, serve, profile, and scientific boundaries.

CM2 is a calcium-imaging project built around CaImAn CNMF-E. Its four explicit
terminal stages produce an mmap, a CNMF-E HDF5 model, a browser cache, and a
local Flask viewer.

## Data Safety

- Treat `data/raw/**`, `data/mmap/**`, and `data/cnmfe/*.hdf5` as read-only
  inputs unless the user explicitly requests the corresponding pipeline stage.
- Never modify or delete raw/source data merely to diagnose, test, or rebuild a
  downstream artifact.
- `data/cache/**` is rebuildable, but replace a cache only when the user has
  requested that replacement. A cache contains static scientific artifacts
  only.
- Default viewer profiles are source-controlled under `data/serve/**`.
  Browser state belongs in browser `localStorage`; neither belongs in a cache
  tree.
- Put temporary outputs under `temp/` or an OS temporary directory.
- Preserve unrelated changes in a dirty worktree. Do not clean, reset, stash,
  or overwrite them for convenience.

## Quick Start And Stage Ownership

Run from the repository root in the `cm2` conda environment:

```powershell
conda activate cm2
python -m script.mmap
python -m script.cnmfe
python -m script.cache
python -m script.serve
```

The canonical configuration, entry point, and implementation pairs are:

```text
config/mmap.yaml    script/mmap.py    src/mmap.py
config/cnmfe.yaml   script/cnmfe.py   src/cnmfe/
config/cache.yaml   script/cache.py   src/cache/
config/serve.yaml   script/serve.py   src/serve/
```

Hydra configuration is the source of truth. Use command-line overrides when
needed; do not duplicate dataset paths or scientific parameters in code. The
currently configured viewer target is `Y-corr85-pnr12`.

### Mmap

`src/mmap.py` converts TIFF input to the CaImAn-compatible C-order mmap. The
encoded filename is authoritative:

```text
<prefix>_d1_<height>_d2_<width>_d3_1_order_C_frames_<frames>.mmap
```

Prefixes may contain underscores; parse dimensions from the encoded tokens.

### CNMF-E

`script.cnmfe` runs the fit and ring-background attachment phases implemented
under `src/cnmfe/`. Preserve CaImAn fitting, patch, merge, process-count, and
numeric semantics unless the user explicitly requests a scientific change.
The memory-bounded attachment path and saved `W`/`b0` are required downstream.
Its configured `.temp` workspace is retained after failure and removed only
after both phases succeed.

### Cache

`src/cache/builder.py` builds only from the configured mmap and CNMF-E HDF5.
Serve never builds cache. `src/cache/publisher.py` builds a complete sibling
staging generation, validates it, promotes it, and restores the prior cache on
an ordinary promotion failure. Publication rejects link targets, unsafe or
non-cache destinations, and targets containing an input artifact.

## Canonical Cache Contract

There is one strict, unversioned cache layout with no compatibility names or
extra entries:

```text
metadata.json
point.json
background/
  mean.uint16
  std.uint16
  bandpass.uint16
temporal/
  f.float64
  c.float32
  c_plus_yra.float32
```

Wire constants live in `src/cache/contract/spec.py`; Python validation lives in
`src/cache/contract/validation.py`; browser validation and decoding live in
`web/js/infrastructure/cache/adapter.js`. Keep them synchronized.

Contract and scientific invariants:

- Images are `[height, width]` in `YX`, top-left origin, x-right/y-down,
  zero-based coordinates. Spatial flattening follows Fortran order.
- `point.json` has exactly `id`, `trace_row`, `x`, `y`, and `metrics`.
  `trace_row` is a complete permutation linking stable point IDs to temporal
  rows.
- `c.float32` and `c_plus_yra.float32` are component-major little-endian
  float32 matrices. Time is zero-based frames with a positive finite sample
  rate.
- `f.float64` contains one row-aligned little-endian float64 DF/F denominator
  per component: the exact finite-sample median of the projected ring
  background computed from mmap plus CNMF-E.
- Browser temporal values are `C - bl` and `C - bl + YrA`. The residual sign
  is plus; there is no additional running-baseline detrend. DF/F divides by
  `f` via `trace_row`; denominators with absolute value `<= 1e-6` yield `NaN`.
- Background sources are `Mean`, `STD`, and `STD + Bandpass`, with Bandpass as
  the viewer default. Files are row-major little-endian uint16 and decode as
  `value_offset + code * value_scale`. Metadata owns the outward integer range
  and ImageJ-style P0.35/P99.65 automatic display range; brightness/contrast is
  a browser transform.
- Quality metrics remain raw: do not add log transforms or Z-standardization.
  Missing or non-finite metric values serialize as JSON `null`; the browser's
  current numeric coercion treats that value as `Number(null) === 0`, so
  changing missing-value handling is a scientific contract change.
- ROI boxes are half-open, QC lower bounds inclusive and upper bounds
  exclusive, and Region polygon boundaries inclusive.
- Metadata and nested payloads use exact keys. Missing, extra, unsafe, linked,
  malformed, or byte-size-mismatched artifacts reject the complete cache.

## Serve And Default Profiles

`src/serve/__init__.py` exposes `create_app` and `serve`;
`src/serve/app.py` composes these routes:

- `static_routes.py`: viewer and installed Plotly asset;
- `cache_routes.py`: `/cache/*` allowlist and `/health`;
- `ui_state_routes.py`: `/api/ui-state` GET/PUT/POST.

Serve validates the cache before startup and never mutates it. `/cache/*`
serves only the canonical root JSON files plus metadata-declared binary
artifacts and uses `no-store`. Profile/UI-state files are never cache routes.

`config/serve.yaml` names a `.json` `serve_path`, currently
`data/serve/Y-corr85-pnr12.json`. It must remain outside cache and read-only
raw/mmap/CNMF-E roots. A present Default Profile is one complete strict
17-field UI-state snapshot; missing or extra fields, or malformed values,
reject the profile.

Ordinary `python -m script.serve` behavior:

- a complete browser `localStorage` state is authoritative at
  `cm2.ui-state:v1:<serve_path stem>` for the current origin; keep profile
  stems unique for datasets served from the same origin;
- only an absent local state seeds from the Default Profile, or from Factory
  State when no profile exists;
- an existing malformed local state is rejected and replaced by Factory State,
  not by the Default Profile;
- subsequent changes write only the complete local state, with no merge;
- Clear All writes Factory State without deleting the local key; Restore
  Default writes the configured profile.

`python -m script.serve edit_default=true` ignores `localStorage` and atomically
writes complete UI changes to `serve_path`. It is loopback-only. Each page load
claims a writer epoch, and increasing revisions prevent stale PUT/pagehide
beacon requests from rolling the profile back. Clear/Restore controls are
ordinary-browser-mode UI only.

## Sites Deployment

`site/` adapts the existing viewer to a read-only Cloudflare Worker surface for
OpenAI Sites. It copies `web/**`, the validated cache, the tracked Default
Profile, and the pinned Plotly bundle into a derived deployment build. It does
not replace or participate in the four terminal pipeline stages.

The deployed API always matches ordinary browser mode: the Default Profile is
read-only, individual changes remain in browser `localStorage`, and
`edit_default` writes are unavailable. Deployment-only trace chunks work
around static-asset size limits but stream the exact canonical bytes at the
unchanged `/cache/temporal/*.float32` paths. Do not track generated site assets
or alter the scientific cache layout for hosting convenience.

## Web Boundary

The frontend is native HTML/CSS/ES modules plus Plotly. Follow `web/AGENTS.md`
for state ownership, feature boundaries, layout, gestures, focus, dialogs,
tooltips, and real-browser checks. UI-only work must not change metric values,
ROI/Region membership, coordinate orientation, temporal formulas, or export
mapping incidentally.

## Verification

Use checks proportional to the change and do not rebuild scientific artifacts
as a test unless the user requested a rebuild.

```powershell
python -B -c "from pathlib import Path; files=[*Path('script').rglob('*.py'), *Path('src').rglob('*.py')]; [compile(p.read_bytes(), str(p), 'exec') for p in files]; print(f'{len(files)} Python files OK')"
Get-ChildItem web -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
git diff --check
```

If `node` is not on `PATH`, use the Node runtime returned by the workspace
dependency loader.

For cache or serve changes, validate every in-scope cache, start the configured
server, check `/health`, and request the root page, CSS/JS, metadata, point,
background, temporal, and UI-state routes. For frontend changes, also test the
actual viewer at `http://127.0.0.1:8765/`; syntax checks do not prove rendering,
persistence, gestures, focus, or accessibility.

## Change Discipline

- Preserve public imports and keyword-only call signatures unless the task
  explicitly changes the contract.
- Keep domain calculations pure and state mutations behind the existing
  command/facade boundaries.
- Do not add dependencies, build systems, or committed test workspaces unless
  requested.
- Update the relevant `AGENTS.md` only when a durable rule or current contract
  changes; keep it factual rather than a changelog.
