# CM2-NeuronalSignal Web Instructions

## Scope And Stack

These instructions apply to `web/**`. Read `../AGENTS.md` first for data
safety, pipeline, cache, serve, and repository-wide scientific contracts.
This file owns frontend architecture, state composition, interaction semantics,
accessibility, and browser verification.

The viewer is native HTML/CSS/ES modules with Plotly, served by Flask. Keep it
dependency-light: do not introduce a framework, bundler, generated build, or
committed frontend test workspace unless the user requests that change.

## Architecture And Ownership

Startup is:

```text
index.html -> /app.js -> js/app/bootstrap.js
           -> cache/profile load -> feature wiring -> initial render
```

- `index.html` is the stable DOM skeleton; `app.js` is the sole owned entry.
- `js/app/bootstrap.js` is the private composition root.
- `viewer-store.js` owns canonical mutable state and Factory State.
- `commands.js` is the only state-mutation boundary.
- `selectors.js` owns pure reads, derived state, and persistence projection.
- `render-scheduler.js` owns immediate and animation-frame scheduling.
- `ui-state-controller.js` owns cross-feature hydration order.
- `viewer-application.js` owns lifecycle, cache/profile hydration, effect
  wiring, render order, resize coordination, and the application error
  boundary.
- Each `js/features/<feature>/model.js` owns pure feature rules; `panel.js`,
  plot views, and editors own DOM; `facade.js` is the public orchestration port.
- `js/infrastructure/cache/` owns strict browser DTO validation and binary
  decoding. `ui-state/` owns persistence transport. `plot-image.js` owns
  shared export mechanics.
- `js/shell/` owns workflow chrome, scrolling, and overlay resizing.
- `js/shared/ui/` owns reusable popovers, tooltips, segmented controls, and
  confirmation dialogs.

Do not expose store state or test installers on `Window`. Cross-feature calls
must use injected facade ports; do not deep-import another feature's private
model, panel, or view. Keep calculations pure and keep DOM, Plotly, transport,
and orchestration at their owners above.

## State And Persistence

The persisted shape is the exact object emitted and validated by
`selectors.js`. Missing, extra, or malformed fields reject the whole payload;
features must not silently merge or normalize a partial payload into a new
shape. `activeWorkflowSection` is runtime-only.

- Ordinary mode: a complete `localStorage` value at
  `cm2.ui-state:v1:<serve_path stem>` is authoritative for the current origin.
  The lowercase `cm2` prefix is a stable persistence namespace and does not
  follow repository display-name changes.
  Keep profile stems unique for datasets served from the same origin. Only an
  absent value seeds from the Default Profile, or from Factory State when no
  profile exists; a malformed existing value resets to Factory State instead.
- `Clear All` persists complete Factory State without deleting the local key.
  `Restore Default` persists the session Default Profile and is shown only
  when current state differs from it.
- `edit_default=true`: local storage is ignored and complete changes use the
  server-issued writer epoch and increasing revisions. Clear/Restore controls
  are not exposed in this mode.
- The two modes are resolved at startup and do not share or merge state.
- `backgroundRanges` stores only manual integer `{ lower, upper }` overrides;
  an absent source key means cache-declared Auto.
- QC threshold `null` endpoints mean unbounded and must survive round trips.

Persist through feature commands and the save coordinator. Scroll observation,
hover, preview, loading, and other presentation-only state must not create
persistence writes.

## Visual, Interaction, And Accessibility Contracts

`css/tokens.css` is authoritative for shared geometry and neutral surfaces:

- `--surface-background` is the panel/body base.
- `--surface-interactive` is a resting clickable target.
- `--surface-selected` is persistent selection, never a hover substitute.
- `--elevation-overlay` is for popovers, dialogs, tooltips, and status.
- Hover and pressed layers apply only to the direct hit target; selected state
  remains visible beneath them.

Use native buttons and inputs with stable accessible names, visible mint
keyboard focus, and concise `data-control-description` help. Sibling actions
must not be nested inside another interactive target. Scientific colors, ROI
identity, danger, disabled state, focus, plots, and slider colors remain
distinct from the neutral surface system.

Shared sliders use tokenized track/thumb/hit geometry. Color Map endpoints are
solid. QC Threshold keeps interval meaning through shape: inclusive lower is
solid and exclusive upper is hollow, including their `N/A` sentinel stops.
Expose formatted units through `aria-valuetext`.

- `anchored-popover.js` places Background, Metric, and ROI Color popovers
  within the workflow scrollport, flipping or internally scrolling as needed.
- `control-tooltip.js` owns one delegated tooltip. Mouse help appears after
  exactly 700 ms; keyboard focus is immediate. Escape, pointer down, leaving,
  scroll, and resize dismiss it. A tooltip hosted by a native dialog must not
  change the dialog client box or create scrollbars.
- `confirmation-dialog.js` owns destructive confirmation, Cancel-first focus,
  Escape/backdrop dismissal, busy submission, and focus restoration. ROI Box
  uses the same native-dialog shell and focus treatment; Box Clear/Save remain
  neutral while destructive confirmation stays danger-colored.

Workflow titles, in order, are `Background`, `Neuron Filter by Metric`,
`Neuron Filter by Region`, `ROI`, `Temporal: Heatmap`, and `Temporal: Trace`.
Headers contain only titles. Desktop Factory/reset width is the supported
minimum, 340 px. Its persisted Factory value is `overlayWidth: null`;
double-clicking the right resize edge restores that null-backed width.

## Feature Contracts

### Background

`features/background/` owns metadata-order-preserving selection, its picker,
and integer dual-thumb Color Map state. Default source is `STD + Bandpass`.
The cache-provided full range owns the rail; Auto owns default endpoints.
Moving either endpoint creates a manual override. Double-click or Enter on a
focused thumb restores only that endpoint; matching both Auto endpoints removes
the override.

Load only the active background binary and memoize it. Range changes update
the WebGL display transform without refetching the image or rerendering Plotly.

### Neuron Filter By Metric

`features/quality-control/model.js` owns raw metric domains, histogram bins,
filtering, and color math. `panel.js` owns controls and ARIA; `histogram.js`
owns Plotly and export descriptors; `facade.js` coordinates effects.

- Metrics are raw linear values in this order: `r_value`, `snr`, `bl`, `lam`,
  `neurons_sn`, `g_0`, `g_1`, `t_peak`, `t_half`.
- Active filters combine with AND and use `[lower, upper)`. A `null` lower or
  upper Threshold endpoint is unbounded. Color Map endpoints are finite raw
  values and feed Map `cmin`/`cmax` directly.
- Histogram, Color Map, and Threshold share one presentation domain:

  ```text
  candidateLower = max(fullMin, min(P1, Q1 - 1.5 * IQR))
  candidateUpper = min(fullMax, max(P99, Q3 + 1.5 * IQR))
  ```

  Use it only for at least 200 finite samples, a positive finite candidate,
  and `fullSpan / candidateSpan >= 2`; otherwise use the outward-rounded full
  extent.
- Saved off-domain endpoints remain authoritative and pin visually to an edge
  until that same handle moves.
- Choosing `None` hides Histogram/range/download presentation while preserving
  saved filters. Empty state must not leave a zero-height child consuming an
  extra layout gap.
- Active slider previews are screen-only: they do not persist, export, change
  membership, or intercept input, and all end/cancel paths remove them.

The compact rows remain aligned: Metric shares a row with Threshold; Color Map
shares a footer with SVG/PNG. The picker width equals the complete download
action group, using `--plot-action-column-width`.

### Region And ROI

Region scope is applied before metric filters. Region membership is
edge-inclusive and overlapping active polygons form a union. Adjacent repeated
vertices form zero-length edges under the current membership rule; changing
their handling changes scientific membership.

ROI boxes use half-open membership:

```text
x <= pointX < x + width
y <= pointY < y + height
```

A neuron has at most one ROI owner. A boxed active ROI cannot receive a neuron
outside its box. Preserve row sibling-button semantics and focus after
rerenders. Region Delete and ROI Clear/Delete require shared confirmation;
Cancel, Escape, or backdrop dismissal never mutates state. ROI Box Save may prune
selected neurons outside the saved box and its description must disclose that.

### Full-FOV Map

`features/map/model.js` owns visibility and shapes; `background-layer.js` owns
the WebGL background; `interactions.js` owns coordinates and gestures;
`facade.js` owns Plotly and injected feature ports.

Keep the pointer-inert background canvas aligned with Plotly using top-left,
row-major image orientation, x-right, reversed y, and zero-based coordinates.
Do not transpose or normalize coordinates. Pan, zoom, resize, ROI hit testing,
and Region drawing must retain this alignment. The ROI activation hit band is
8 px from the nearest border.

Two-finger horizontal/vertical scrolling pans in screen space; macOS pinch
(`ctrlKey` wheel) zooms around the pointer. Plotly generic scroll zoom remains
disabled. Coalesce wheel work by animation frame.

Neuron hover uses `hover-card.js`, not native Plotly labels. It is pointer-only,
noninteractive, animation-frame coalesced, and must not mutate state, persist,
or fetch data. Its trace comes through `temporal.describeNeuronTrace()` so
source, mode, scale, denominators, baselines, and guides match Temporal: Trace.

### Temporal

`features/temporal/model.js` owns source/value math, ranges, trace-row slicing,
and memberships. `heatmap.js` and `trace-plot.js` own Plotly; `facade.js` owns
lazy source loading and orchestration.

- Sources are exactly `C - bl` and `C - bl + YrA`; both remove the fitted
  per-component `bl` and perform no extra detrending.
- Modes are `ΔF` and `ΔF/F`. DF/F divides by the float64 median projected
  background selected by `trace_row`; absolute denominators `<= 1e-6` yield
  `NaN`.
- Boxed-ROI Heatmap membership is every Region/QC-eligible neuron in the active
  box. Unboxed Heatmap membership falls back to selected neurons. Trace uses
  selected neurons only, in filtered `roi.neuronIds` order.
- Heatmap limits use the union of all ROI Heatmap memberships. Temporal values
  are not normalized per neuron.
- Heatmap and Trace share source/mode state. Ranges and scale controls persist;
  loading state does not redefine availability. Lazy `c` and `c_plus_yra`
  buffers are memoized; while loading, retain stale plots and disable export.
- Both Temporal workflow sections are hidden when the active ROI has no
  Region/QC-eligible selected neurons.
- Heatmap uses the fixed Magma scale. Trace keeps per-row zero baselines and a
  dotted 5% guide in DF/F mode. Screen and SVG/PNG exports must use the same
  scientific state and membership.

## Change Discipline

- Preserve public DOM IDs, public imports, facade ports, accessible names, and
  persisted keys unless the task explicitly changes their contract.
- UI-only work must not alter scientific values, membership ordering,
  coordinate orientation, source definitions, or export mapping.
- Guard asynchronous Plotly and hover work against stale completions. Resize
  coordination must cover Map, QC, and visible Temporal plots.
- Preserve unrelated worktree changes. Do not add generated artifacts under
  `web/`.

## Verification

Run static checks for every frontend change:

```powershell
Get-ChildItem web -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }
git diff --check
```

If `node` is not on `PATH`, use the Node runtime returned by the workspace
dependency loader.

Then verify the touched behavior in a real browser at
`http://127.0.0.1:8765/`. Inspect console errors and failed requests; reload
when startup, cache loading, or persistence is in scope. Syntax checks do not
prove layout, gestures, Plotly resizing, focus, or persistence.

Choose the relevant checks rather than running an unrelated exhaustive tour:

- startup/profile precedence, Clear/Restore, reload, and edit-default mode;
- panel collapse/scroll/340 px resize reset, responsive overflow, focus order,
  700 ms tooltips, popover collision, and modal dismissal/focus restoration;
- Background source/range persistence and image/marker/ROI alignment through
  pan, zoom, and resize;
- QC raw filters, shared domain, `N/A`, empty state, transient preview,
  Histogram, and SVG/PNG;
- Region drawing/membership and ROI activation, box, ownership, confirmation,
  and selection pruning;
- Map pan/pinch, modebar, shapes, resize, and hover preview parity with Trace;
- Temporal lazy sources, source/mode sync, memberships, ranges, sizing, hidden
  empty sections, and SVG/PNG.

Report which behavior was actually exercised in the browser separately from
what was confirmed only by code inspection.
