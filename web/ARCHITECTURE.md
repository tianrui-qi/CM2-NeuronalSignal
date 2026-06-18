# CM2 Neuron Viewer Architecture

This viewer is a static browser UI served by Flask. Heavy CNMF-E and cache-building work happens before the viewer starts; the live app should only load cache artifacts, render plots, and persist lightweight UI state in browser localStorage.

## Runtime Flow

1. `script/cache.py` builds cache files from `data/Y.hdf5` and image products.
2. `script/serve.py` starts Flask via `src/serve.py`.
3. `src/serve.py` validates cache structure, serves `web/`, and exposes `/cache/*`.
4. `web/app.js` loads metadata, points, traces, restores UI state, and renders all panels.

The viewer must not mutate heavy data files. User annotations such as ROI boxes, selected neurons, regions, QC ranges, and panel state live in localStorage under `cm2_web_roi_state_v2`.

## Frontend Files

- `web/index.html`: DOM skeleton and script order.
- `web/app.js`: bootstraps cache loading, state restoration, and first render.
- `web/js/core.js`: shared constants, global state, persistence, ROI helpers, source validation, and small math helpers.
- `web/js/ui.js`: shared generic UI helpers, currently segmented source/value toggles.
- `web/js/cache.js`: browser-side cache fetch and binary trace size validation.
- `web/js/map.js`: Plotly full-FOV map, neuron markers, background image, hover/selection overlays.
- `web/js/qc.js`: metric transforms, QC filter state, histogram, threshold controls.
- `web/js/region.js`: Region polygons, draw flow, Region table counts, and Region hover previews.
- `web/js/roi.js`: ROI list, ROI activation, ROI box editor, ROI selection membership.
- `web/js/trace.js`: temporal heatmap, trace plots, sort/select/deselect, SVG/PNG export, heatmap range controls.
- `web/js/workflow.js`: collapsible section wiring and overlay resizing.
- `web/css/*.css`: tokens, layout, section-specific styling, and responsive rules.

## Cache Contract

`metadata.json` must match `CACHE_VERSION` and include:

- `neuron_count` and `trace_length`.
- `backgrounds` with valid files and a valid `default_background_key`.
- `trace_sources` matching the expected source files in `src/cnmfe/traces.py`.

`points.json` must have `id`, `x`, `y`, metric arrays, and trace stat arrays with `neuron_count` entries. Each trace binary must be exactly `neuron_count * trace_length * 4` bytes.

`src/cache/validators.py` is the Python-side cache boundary. `web/js/cache.js` still validates trace array lengths in the browser because stale browser caches and partial writes are possible.

## Interaction Rules To Preserve

- Region hover is a preview: no hover means normal filtered neurons; hovering summary/region rows previews the matching counts and boundaries.
- ROI hover should not imply activation. ROI activation is explicit via the ROI row or ROI box border.
- Active ROI controls which ROI receives neuron selections, but should not hide the rest of the map by itself.
- Temporal source and value mode are synchronized between Heatmap and Trace panels.
- Heatmap renders all applicable ROI-box neurons for boxed ROIs; for unboxed ROIs it follows selected neurons.
- Trace renders selected neurons in selection/custom order unless a sort mode is active.
- Trace hover shows the single hovered selected-neuron ring while leaving the base neuron layer visible.

## Adding Features Safely

- Prefer small pure helpers before adding more global state.
- If a feature affects both Heatmap and Trace, keep shared state in `core.js` and rendering logic in `trace.js`.
- Keep browser persistence backward-compatible; users may have important annotations in localStorage.
- Do not clear localStorage during QA unless the user explicitly asks.

## Smoke Checks

Run these before handing off viewer changes:

```bash
node --check web/app.js web/js/*.js
python -m py_compile src/serve.py src/cache/validators.py
git diff --check -- web src/cache src/serve.py
```

Then load `http://127.0.0.1:8765/` with the existing browser state and verify:

- background and neuron markers render;
- QC dropdown, histogram, and sliders render;
- Region table hover previews do not persist unwanted state;
- ROI activation and box rendering remain usable;
- Temporal Heatmap and Trace render, sort/select controls work, and SVG/PNG buttons are enabled when data is present.
