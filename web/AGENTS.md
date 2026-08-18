# CM2 Web Instructions

Last updated: 2026-08-18.

## Scope

These instructions apply to `web/**`. Read `../AGENTS.md` first for
repository-wide data safety, pipeline, cache, serve, and scientific
contracts. This file owns frontend composition, UI state, visual semantics,
feature interactions, accessibility, and real-browser verification.

The viewer is a native-ESM HTML/CSS/JavaScript application served by Flask.
Plotly is the only classic script. There is no React framework, bundler, npm
runtime, generated production build, or committed frontend test workspace.

## Startup And Composition

The browser startup chain is:

```text
index.html -> /app.js -> js/app/bootstrap.js
           -> cache + UI-state load -> feature wiring -> initial render
```

- `web/index.html` is the stable DOM skeleton.
- `web/app.js` is the sole repository-owned ESM entry and performs one
  side-effect import of `js/app/bootstrap.js`.
- `bootstrap.js` is the private composition root. It creates the store,
  commands, selectors, scheduler, feature facades, infrastructure services,
  shell, UI-state controller, and viewer application.
- `viewer-application.js` owns lifecycle registration, cache hydration,
  persisted-state loading, effect wiring, render order, resize coordination,
  and the application error boundary.
- `ui-state-controller.js` owns cross-feature persistence projection and
  hydration order.

Do not expose application state or test installers on `Window`. Cross-feature
calls go through facades and injected ports; do not deep-import another
feature's private model, panel, or view.

The browser may rely on `/cache/*`, `/api/ui-state`, and `/health`, plus the
single strict cache DTO. Server route implementation and cache publication belong to the root
instructions. The viewer must never mutate TIFF, mmap, CNMF-E HDF5, or cache
scientific artifacts.

## State Ownership

- `js/app/viewer-store.js` owns canonical mutable UI state and defaults.
- `commands.js` is the only mutation boundary.
- `selectors.js` owns pure reads and the persisted-state projection.
- Feature models own normalization of their slice during hydration.
- `render-scheduler.js` owns immediate and animation-frame scheduling.
- `infrastructure/ui-state/` owns remote load/save, 250 ms debounce, 1000 ms
  retry, flush, and pagehide beacon behavior.

The canonical state contains exactly the current persisted keys and nested
shapes emitted by `selectors.js`. A missing server state starts from defaults;
any nonempty payload with missing, extra, or malformed fields is rejected as a
whole. Threshold `null` endpoints are the current unbounded semantics.

## Surface And Interaction Contract

`css/tokens.css` is the single source of truth for neutral surfaces:

- `--surface-background`: panel/body background;
- `--surface-interactive`: resting clickable control or row;
- `--surface-selected`: persistent selected/active state;
- `--elevation-overlay`: dropdown, popover, dialog, tooltip, and status
  elevation;
- `--state-hover-layer` and `--state-pressed-layer`: temporary layers applied
  only to the direct hit target.

Scientific colors, ROI identity, danger, preview, focus, disabled state,
canvas, plots, slider tracks, and scrims stay outside this neutral system.
Selected remains visible under Hover/Pressed. Keyboard focus uses its own mint
outline and is not represented by Selected.

Elevated surfaces stay in the same warm-graphite family as the sidebar, using
greater opacity plus border, blur, and shadow for separation instead of a
near-black fill. Dropdowns use one persistent outer surface; resting options
remain transparent and reveal their own shape only for Hover, Focus, Pressed,
or Selected state.

Selected rows and segmented buttons use the same `--surface-selected` fill.
An active ROI row keeps only the ordinary `--border` at rest; Hover may raise
the direct target border. The active/preview Region count uses the same
selected surface instead of a separate amber badge.

All repo-owned sliders share the compact control geometry in `tokens.css`:
14 px thumbs, a 4 px track, and an 18 px input hit band within the 30 px
control row. Color Map and Heatmap range endpoints are both solid. Threshold
uses shape to reinforce interval semantics: the inclusive lower endpoint is
always solid and the exclusive upper endpoint is always hollow, including at
the `null`/N/A sentinel positions. Hover, active, disabled, and mint
focus-visible states are shared across QC, Heatmap, and Trace. Single-value
Trace controls show a leading progress fill and expose their formatted unit
through `aria-valuetext`; dual scientific rails retain their feature-specific
gradients.

Do not let an ancestor hover surface activate merely because the pointer is
over an independent child control. Interactive elements must have clear
native-button semantics, stable accessible names, visible focus, and concise
descriptions.

`js/shared/ui/anchored-popover.js` owns vertical placement for the viewer's
non-modal anchored surfaces. QC Metric and ROI Color popovers use the same
border, radius, elevation, and scrollport-aware collision rules. Placement is
computed against the intersection of the viewport and `#workflow-panel`:
prefer the feature's natural side, flip when the alternate side fits, and use
the larger side with internal scrolling when neither fits. Feature-local
fixed-direction placement is outside the current contract.

### Teaching Tooltip

`js/shared/ui/control-tooltip.js` owns one delegated tooltip for controls with
`data-control-description`, including dynamic and modal controls.

- Mouse hover delay is exactly `700 ms` to filter fly-by movement in the dense
  panel.
- Keyboard focus displays help immediately.
- Leaving/canceling, pointer down, Escape, scroll, and resize retain their
  existing dismissal behavior.
- Copy is a short sentence-style phrase in sentence case without terminal
  punctuation. Say what the control is or does, not how it is implemented.
- Define unfamiliar scientific abbreviations briefly, and keep user-relevant
  destructive or selection-pruning consequences.
- Plotly modebar descriptions remain Plotly-owned.

## Workflow Chrome

Visible panel titles, in order, are:

1. `Background`
2. `Neuron Filter by Metric`
3. `Neuron Filter by Region`
4. `ROI`
5. `Temporal: Heatmap`
6. `Temporal: Trace`

Each header contains only the title; active values, counts, and ROI details
belong in the body. The overlay remains
the compact floating workflow panel over a full-FOV canvas. Preserve the
existing open-section, width, scroll, resize, and persisted-state behavior
unless the task explicitly redesigns it.

## Feature Contracts

### Background

`features/background/` owns metadata-order-preserving selection and its panel.
Available backgrounds come from cache metadata. Current options are `Mean`,
`STD`, and `STD + Bandpass`; default is `STD + Bandpass`.

### Neuron Filter By Metric

`features/quality-control/model.js` owns metric order/availability, raw
extents, automatic presentation domains, cumulative filtering, histogram
values, and raw color math. `panel.js` owns DOM/ARIA/listeners;
`histogram.js` owns Plotly and SVG/PNG export descriptors; `facade.js` owns
orchestration through injected effects.

#### Raw ranges and filtering

- `blueprintColorRanges[metric]` and `qcRanges[metric]` use
  `{ lower, upper }`.
- Color endpoints are finite raw metric values.
- A Threshold endpoint may be `null`: lower `null` is unbounded below and
  upper `null` is unbounded above.
- Active metric filters combine with AND and use `[lower, upper)`.
- The Map consumes saved raw Color Map endpoints directly as Plotly
  `cmin`/`cmax`.
- There is no `STD`/`Raw` mode, Z space, runtime log transform, Gaussian fit,
  sigma guide, or Full/Auto presentation switch.
- Choosing `None` hides the histogram and controls but preserves saved metric
  filters.

Current metric order is `r_value`, `snr`, `bl`, `lam`, `neurons_sn`, `g_0`,
`g_1`, `t_peak`, `t_half`. All live axes and filters use raw linear values.
The picker is the only persistent metric-name label; screen and exported
histograms keep numeric ticks but omit a redundant x-axis metric title.

#### Automatic presentation domain

Histogram x-axis, Color Map slider, and Threshold slider share one automatic
raw-value domain. For effective finite values, form the union of `P1`-`P99`
and the Tukey interval, clipped to the full raw extent:

```text
candidateLower = max(fullMin, min(P1, Q1 - 1.5 * IQR))
candidateUpper = min(fullMax, max(P99, Q3 + 1.5 * IQR))
```

Use that candidate only when sample count is at least `200`, candidate span is
positive and finite, and `fullSpan / candidateSpan >= 2`; otherwise use the
outward-rounded full extent. Use a nice step derived from roughly 200
intervals. Histogram bins cover only the chosen domain; there are no tail bins,
above/below text, or focus-status row.

The Histogram endpoints and both sliders' finite coordinate endpoints must be
identical. The numbers above each slider show its currently selected raw
values, not the rail domain. Threshold's far-left and far-right sentinel stops
remain `N/A` and apply no lower or upper threshold. Saved off-domain values
stay authoritative and visually pin to an edge until that same handle moves;
moving the other handle must not rewrite them. Exports label the saved Color
Map endpoints, while Map coloring and raw filter state remain unchanged.

#### Compact two-row layout

The four QC control rows are intentionally condensed around the full-width
Histogram:

```text
[ Metric picker ][ Threshold slider..................... ]
[ Histogram............................................. ]
[ Color Map slider..................... ][ SVG ][ PNG ]
```

- `.qc-toolbar-row` places `#blueprint-picker` left and Threshold right.
- `.qc-download-row` places Color Map left and the SVG/PNG action group right.
- Both rows use the shared `--plot-action-column-width` for the picker/action
  column. The picker width must equal the complete download group from the left edge of
  SVG to the right edge of PNG, including the inter-button gap.
- The picker and its menu are left-aligned. Threshold fills the flexible right
  column; Color Map fills the flexible left footer column. Neither receives
  the Histogram's Plotly-axis insets;
  they may shrink with the panel, while the action column does not.
- The Histogram remains full width and normally has no range overlay. Only
  while a user actively adjusts Color Map or Threshold, a screen-only range
  preview covers the Histogram data area using the shared raw domain. Preserve
  the selected interval and lightly shade the values outside it; Color Map uses
  a lighter shade than Threshold because out-of-range colors saturate rather
  than being filtered. Finite endpoints receive a thin boundary line.
- A `null` Threshold endpoint extends the preview to that visible domain edge
  without drawing a finite boundary. Two `null` endpoints show no preview.
  Pointer release/cancel, matching keyup, blur, metric change, panel collapse,
  window blur, and document hiding must remove the preview immediately. The
  preview is `aria-hidden`, cannot intercept pointers, is never persisted or
  exported, and must not affect filtering, Map colors, counts, or memberships.
- Each Metric option shows an active raw Threshold at right: `[L, U)` for two
  finite endpoints, `[L, )` for lower-only, `[, U)` for upper-only, and no
  summary for two `null` endpoints. The summary is read-only presentation; it
  never changes filtering or persistence.
- The Metric listbox and ROI color palette both use the shared automatic
  anchored-popover placement and expose keyboard navigation plus Escape focus
  restoration.
- Preserve all control IDs, event wiring, ARIA, selected-value labels,
  slider-domain logic, download behavior, and export mapping during layout
  changes.

### Neuron Filter By Region

`features/region/model.js` owns persisted polygon normalization,
edge-inclusive membership, overlap-union membership/counts, and preview
scopes. `panel.js` owns the table; `drawing.js` owns drawing descriptors and
keyboard/pointer listeners; `facade.js` owns state and cross-feature effects.

Region scope applies before metric filters for point visibility and selection.
An adjacent repeated polygon vertex currently creates a zero-length edge that
`pointOnSegment()` can classify broadly; do not alter that scientific behavior
incidentally during UI work.

### ROI

`features/roi/model.js` owns defaults, first-owner normalization, box
normalization, half-open membership, counts, and selection pruning.
`box-editor.js`, `panel.js`, and `confirmation-dialog.js` own DOM;
`facade.js` owns activation, assignment, persistence, and render effects.

- ROI boxes use `x <= pointX < x + width` and
  `y <= pointY < y + height`.
- A neuron belongs to at most one ROI. A boxed active ROI cannot receive a
  neuron outside its box.
- Each row is a neutral group. The ROI-selection button and Color, Box, Clear,
  and Delete are sibling controls, never nested interactive descendants.
- Hovering the main selection target paints one coherent Hover surface over
  the full row. Hovering an action paints only that action. Active Selected
  remains visible beneath either Hover.
- Color and Add swatch buttons match the other inline actions' outer size,
  border, radius, and hit target; only the inner swatch carries identity color.
- Clear and Delete execute only after explicit modal confirmation. Cancel,
  Escape, and backdrop dismissal do not mutate or persist. Clear retains box
  and color; Delete removes the ROI and assignments.

### Full-FOV Map

`features/map/model.js` owns visibility, marker/hover presentation, ROI shapes,
view ranges, and background descriptors. `interactions.js` owns coordinate
conversion and listeners; `facade.js` owns Plotly and injected feature ports.

Keep the image at `(x=0, y=full_height)`, `yanchor: "bottom"`, with reversed Y.
Do not transpose or normalize coordinates. Preserve pan/zoom, scale anchoring,
ROI overlays, marker selection, Region drawing guards, and the nearest-border
8 px ROI activation hit band.

Map neuron hover uses the noninteractive floating preview owned by
`features/map/hover-card.js`, not Plotly's native hover label. The Map keeps
stable neuron IDs in `customdata`, supplies structured metadata, owns marker
anchoring/collision avoidance, and hides the preview during pan, zoom, pointer
down, Region drawing, render, or unhover. The preview must not mutate state,
persist, change marker emphasis, or fetch data. Rapid hover is animation-frame
coalesced and stale Plotly renders are discarded. ScatterGL points still have
no keyboard-focus path; the preview remains a pointer-only analytical aid.

Trackpad navigation deliberately separates gestures: ordinary two-finger
vertical or horizontal scrolling pans the Map in screen space, while macOS
pinch (`ctrlKey` wheel) zooms both axes around the pointer. Plotly's generic
`scrollZoom` stays disabled so an ordinary two-finger scroll cannot zoom.
Wheel events are animation-frame coalesced; do not change ROI/Region coordinate
math or the reversed-Y layout when refining gesture sensitivity.

### Temporal

`features/temporal/model.js` owns source/value availability, trace-row slicing,
per-component `bl`, projected-background DF/F, ROI memberships,
selection-order descriptors, and range math. `panel.js` owns controls;
`heatmap.js` and `trace-plot.js` own Plotly/DOM lifecycles; `facade.js` owns
orchestration and denominator memoization.

`facade.describeNeuronTrace(neuronId)` is the only Map-facing Temporal port.
It builds the one-neuron preview through the same `buildTracePlotData()` path
as Temporal: Trace, so Source, value mode, per-neuron DF/F denominator, Scale,
zero baseline, and the dotted 5% DF/F guide stay identical. Spacing is an
inter-row offset and therefore has no visible effect for a one-neuron preview;
do not invent a separate spacing transform. The preview may extend its y range
to keep its guides visible without changing the main Trace layout. Its header
is only `Neuron N`; Source/value-mode text and pixel position are intentionally
omitted. Below the trace, all nine metrics are arranged in two aligned columns:
`r_value`, `SNR`, `bl`, `lambda`, and `neurons_sn` on the left; `g_0`, `g_1`,
`t_peak`, and `t_half` on the right. The plot uses the current neuron's actual
range plus zero/5% guides, 6 px vertical breathing room, and a 48 px floor.
Do not use global absolute neuron extrema: rare outliers would flatten almost
every ordinary preview.

Scientific and membership invariants:

- sources are exactly `C - bl` and `C - bl + YrA`;
- modes are exactly `ΔF` and `ΔF/F`, shared by both panels;
- both sources remove the fitted scalar `bl`; neither performs additional
  running-baseline detrending;
- DF/F divides by each neuron's median projected `Ybg`; absolute denominators
  `<= 1e-6` produce `NaN`;
- boxed-ROI Heatmap membership is all Region/QC-eligible neurons in the active
  box; unboxed membership falls back to selected neurons;
- Trace membership is selected neurons only, shown/exported in filtered
  `roi.neuronIds` selection order;
- a neuron is selected individually; there is no bulk-select action, sort
  control, or persisted sort state;
- Heatmap limits use the union of all ROI Heatmap memberships;
- Heatmap and Trace values are never normalized per neuron.

Heatmap UI/rendering:

- fixed exact `HEATMAP_MAGMA_COLORSCALE`; no picker or persisted choice;
- `HEATMAP_ROW_HEIGHT_PX = 0.8`;
- screen Plotly colorbar disabled; exports append a horizontal Magma colorbar
  with the rendered endpoints;
- per-source range is persisted and occupies the left side of the same footer
  row as SVG/PNG;
- Heatmap, Trace, and QC SVG/PNG groups share
  `--plot-action-column-width`; their left-side controls consume the remaining
  footer width;
- unnormalized `ΔF` domain uses outward integer endpoints and zero-anchored
  interior `1/2/5 × 10^n` nice values; `ΔF/F` uses integer-percent controls
  with fractional persisted values.

Trace UI/rendering:

- unnormalized spacing 1,000–30,000 in 1,000-unit steps, default 15,000; label
  intentionally has no `raw` suffix;
- unnormalized scale 1–12 px/1,000 in integer steps, default 3;
- DF/F spacing 5–20% in 1% steps, default 10%;
- DF/F scale 1–12 px/% in integer steps, default 5;
- visible scientific quantities follow SI spacing: put one space between the
  number and unit (`9 %`, `3 px/%`), but no spaces inside a compound unit;
- Spacing and Scale occupy the left side of the SVG/PNG footer row;
- height derives from rendered y span and selected pixel scale, not fixed
  per-neuron height;
- rows have faint zero baselines; DF/F rows also have a dotted 5% guide, with
  only the first guide labeled;
- events may overlap adjacent rows; do not compress them;
- the UI has neither a bottom scale bar nor a heatmap/trace divider border.

When a source is unavailable, skip Plotly rendering, leave stale plot data in
place, and keep downloads disabled. There is no render revision/cancellation
token.

## Infrastructure

- `infrastructure/cache/client.js` owns fixed request phases and strict cache
  acceptance; `adapter.js` validates DTOs and decodes trace binaries.
- `infrastructure/plot-image.js` owns shared QC/Temporal browser export
  mechanics.
- `infrastructure/errors.js` owns typed infrastructure errors and user-visible
  messages.
- `shared/ui/segmented-control.js` is a caller-styled renderer, not a state
  owner.
- `shell/` owns workflow chrome/navigation and overlay resize listeners behind
  abstract effect ports; it must not import private feature models or Plotly.

## Verification

Static checks are necessary but do not prove browser behavior:

```bash
find web -type f -name '*.js' -exec node --check {} \;
git diff --check
```

With the configured safe cache, open `http://127.0.0.1:8765/` and verify the
features touched by the change. Always inspect console errors and failed
requests and reload once when persistence is in scope.

Minimum browser matrix for UI changes:

- panel open/close, overlay scroll/resize, focus order, tooltips, and downloads;
- Background selection and image orientation;
- QC cumulative raw filtering, shared automatic domain, `N/A` sentinels,
  Histogram/export, and reload persistence;
- QC compact layout at normal and minimum overlay widths: picker width equals
  the entire SVG-to-PNG group, both rows stay aligned, and no horizontal
  overflow appears;
- QC transient range preview for pointer and keyboard adjustments: it follows
  the canonical range in Histogram data coordinates, handles one- and two-sided
  `N/A` Thresholds, is absent on focus alone, and disappears immediately on
  every normal or interrupted end path without entering SVG/PNG output;
- QC menu threshold summaries match the saved raw intervals; QC and ROI color
  popovers flip above/below within the workflow scrollport and remain keyboard
  operable;
- Region preview/draw/commit/delete and counts;
- ROI add/activate/color/box/select plus Clear/Delete confirmation and focus;
- shared slider thumb/track geometry, solid Color Map endpoints, solid-inclusive
  and hollow-exclusive Threshold endpoints at both finite and N/A positions,
  formatted `aria-valuetext`, and QC picker/Threshold order;
- selected ROI, Temporal segmented buttons, and Region active/preview counts
  use the canonical selected surface;
- Map marker/ROI alignment, pan/zoom, modebar, resize, and custom neuron hover
  preview; verify native hover text is absent, the `Neuron N` header and two
  columns contain all nine metrics without Position or mode text, the compact
  plot avoids excess vertical space, the card avoids the workflow overlay,
  and Source/Mode/Scale plus baseline/5% guides match Temporal: Trace without
  state or network writes;
- Map two-finger vertical/horizontal scrolling pans, pinch zooms around the
  pointer, and neither gesture scrolls or zooms the surrounding page;
- Temporal source/value sync, fixed Magma, range/spacing/scale controls,
  membership, selection order, plot sizing, and SVG/PNG exports;
- control descriptions remain hidden before 700 ms of pointer hover, appear at
  about 700 ms, appear immediately on keyboard focus, and dismiss correctly.

Use runtime labels deliberately: distinguish code-confirmed behavior from
gestures or rendering actually verified in the browser.
