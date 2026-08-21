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
- `interaction-command-registry.js` owns shortcut metadata and routing;
  `interaction-context-stack.js` resolves the highest-priority active input
  context. Dynamic controls declare `data-interaction-command` so ARIA,
  tooltips, and Shortcut Help use the same metadata.
- Each `js/features/<feature>/model.js` owns pure feature rules; `panel.js`,
  plot views, and editors own DOM; `facade.js` is the public orchestration port.
- `js/infrastructure/cache/` owns strict browser DTO validation and binary
  decoding. `ui-state/` owns persistence transport. `plot-image.js` owns
  shared export mechanics.
- `js/shell/` owns workflow chrome, responsive sheet state, scrolling, and
  overlay resizing.
- `js/shared/ui/` owns reusable popovers, tooltips, dual-range routing,
  confirmed plot taps, and confirmation dialogs.

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
  `cm2.ui-state:{storageKey}` is authoritative for the current origin.
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

Persist through feature commands and the save coordinator. Responsive-sheet
detents, input context, fixed inspectors, scroll observation, hover, preview,
loading, and other presentation-only state must not create persistence writes.

## Visual, Interaction, And Accessibility Contracts

`css/tokens.css` is authoritative for shared geometry and neutral surfaces:

- `--surface-background` is the panel/body base.
- `--surface-interactive` is a resting clickable target.
- `--surface-selected` is persistent selection, never a hover substitute.
- `--elevation-overlay` is for popovers, dialogs, tooltips, and status.
- `--edge-fallback-color` is the settled representative grayscale sampled from
  the currently displayed top and bottom Map edges. Safari cannot sample the
  WebGL canvas when it synthesizes an opaque browser-chrome or overscroll
  extension, so the root background supplies that content-derived solid
  fallback. Continuous pan, pinch, or range previews must not recolor the
  native surface on every frame. The noninteractive Map surface uses the large
  viewport so Safari can reveal actual Map pixels wherever its translucent
  chrome exposes page content.
  Controls remain constrained by the visual viewport and the four
  `safe-area-inset-*` boundaries; never place required interaction in those
  visual-only regions.
- Hover and pressed layers apply only to the direct hit target; selected state
  remains visible beneath them. Apply hover presentation only inside
  `@media (hover: hover)`; every hover function needs a visible touch and
  keyboard path.

Use native buttons and inputs with stable accessible names, visible mint
keyboard focus, and concise `data-control-description` help. Sibling actions
must not be nested inside another interactive target. Scientific colors, ROI
identity, danger, disabled state, focus, plots, and slider colors remain
distinct from the neutral surface system.

Shared sliders use tokenized track/thumb/hit geometry. Color Map endpoints are
solid. QC Threshold keeps interval meaning through shape: inclusive lower is
solid and exclusive upper is hollow, including their `N/A` sentinel stops.
Expose formatted units through `aria-valuetext`. The shared dual-range owner
routes rail presses to the nearest thumb, alternates overlapping thumbs,
preserves native Tab order and Arrow/Page/Home/End behavior, and provides a
44 px coarse hit band. Pointer and keyboard previews are transient; successful
completion commits once, while cancellation restores the starting value
without persistence. A vertical touch gesture over a slider belongs to sheet
scrolling and must not change the range.

- `anchored-popover.js` places Background, Metric, and ROI Color popovers
  within the workflow scrollport, flipping or internally scrolling as needed.
  Background and Metric keep the same fixed trigger and natural menu widths in
  wide and bottom layouts; bottom sheets must not stretch either menu.
- `control-tooltip.js` owns one delegated tooltip. Mouse help appears after
  exactly 700 ms; keyboard focus is immediate. Escape, pointer down, leaving,
  scroll, and resize dismiss it. A tooltip hosted by a native dialog must not
  change the dialog client box or create scrollbars.
- `confirmation-dialog.js` owns destructive confirmation, Cancel-first focus,
  Escape/backdrop dismissal, busy submission, and focus restoration. ROI Box
  uses the same native-dialog shell and focus treatment; Box Clear/Save remain
  neutral while destructive confirmation stays danger-colored. Dialogs use
  the visual viewport, safe areas, an internal scrollport, and sticky actions
  so the software keyboard cannot hide their controls.

Workflow titles, in order, are `Background`, `Neuron Filter by Metric`,
`Neuron Filter by Region`, `ROI`, `Temporal: Heatmap`, and `Temporal: Trace`.
Headers contain only titles. Desktop Factory/reset width is the supported
minimum, 340 px. Its persisted Factory value is `overlayWidth: null`;
double-clicking the right resize edge restores that null-backed width.

Responsive layout is runtime-only:

- the left sidebar has a 340 px minimum. Its current maximum plus the two
  surrounding `--ui-spacing` gaps equals half the CSS viewport width. Use it
  whenever that inset maximum can still satisfy the minimum (712 px with the
  current 8 px token); otherwise use the bottom sheet. This rule is geometric
  and independent of pointer type or orientation. Drag the
  sidebar's right separator to resize, double-click it to restore 340 px, and
  retain its keyboard resize path. A short workflow stack sits at the bottom
  of the available sidebar; an overflowing stack starts at the top and scrolls
  normally;
- otherwise use one fixed-width bottom sheet inset by `--ui-spacing` from both
  safe-area edges. That outer bottom inset is the sole space below the final
  workflow action row; do not add a second inner bottom margin;
- the bottom sheet has runtime-measured Middle and safe-area Full detents.
  Middle is the exact height needed for the handle, structural gaps,
  every workflow section header in its collapsed geometry, and the current
  Clear/Restore action row. It is measured from live DOM and CSS without
  changing or persisting `openSections`, recomputes for viewport, width, and
  font changes, and is capped by Full. The grabber uses the same layered base
  surface and control shadow as the standalone Clear All action.
  Its only visible size control is the transparent horizontal grab area above
  Background. The grab area and workflow scrollport keep one structural
  `--ui-spacing` gap throughout active dragging and settled detents. Drag it
  vertically between Middle and Full. Active and settled geometry share the
  same visual-viewport and safe-area bounds, including when browser chrome or
  the software keyboard changes the usable viewport.
  The workflow scrollport itself owns pointer hit testing and `pan-y`; do not
  delegate touch scrolling through a `pointer-events: none` scroll container.
  When that scrollport is already at its top, a downward touch or Pencil pull
  may collapse Full to Middle. A downward pull at Middle remains at Middle and
  does not claim the gesture. Upward and in-content scrolling remain native;
  nested scrollports retain their own gestures. Multiple contacts,
  cancellation, focus or visibility loss, orientation changes, and viewport
  changes restore the starting detent without committing.

The context priority is `Dialog > Popover > Text Input > Region Draw > Plot
Inspector > Map > Global`. Native buttons keep Enter/Space. The command
registry owns `?` Help; context-scoped Escape; Map Arrow/Shift+Arrow, `+`, `-`,
and `0`; and Region Enter, Escape, Backspace, and Ctrl/Cmd+Z. Never intercept
browser-modified navigation, reload, find, save, tab, or window shortcuts.
Keyboard page-zoom shortcuts remain browser-owned; Ctrl+wheel over the Map is
the explicit pointer-centered Map zoom gesture. Coarse pointers keep a 44 px
slider input surface without enlarging the 18 px visible slider row. Dual and
single sliders share the 30 px label-plus-rail rhythm, 14 px thumb, and 4 px
track. Trace delete retains its 44 px coarse hit target. Region and ROI use the
same row, table-column, preview-count, palette, and compact-control geometry
across pointer capabilities. Shared panel controls and headers keep the
established desktop visual geometry.

## Feature Contracts

### Background

`features/background/` owns metadata-order-preserving selection, its picker,
and integer dual-thumb Color Map state. Default source is `STD + Bandpass`.
The cache-provided full range owns the rail; Auto owns default endpoints.
Moving either endpoint creates a manual override. Double-activating a thumb
restores only that endpoint; matching both Auto endpoints removes the override.

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
- Histogram point taps pin bin details; a confirmed blank tap or context-scoped
  Escape closes them without treating sheet scrolling as a tap.

The compact rows remain aligned: Metric shares a row with Threshold. Color Map
shares a footer with SVG/PNG until the viewport is extremely narrow, then Color
Map occupies the first row and the fixed download group sits right-aligned on
the second. The picker width equals the complete download action group, using
`--plot-action-column-width`.

### Region And ROI

Region scope is applied before metric filters. Region membership is
edge-inclusive and overlapping active polygons form a union. Adjacent repeated
vertices form zero-length edges under the membership rule; changing
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

Add Region establishes the Region Draw context and disables neuron/ROI taps.
Touch or Pencil tap adds one polygon vertex; a second pointer owns Map pan/pinch
and cannot add a vertex. The sticky Undo Vertex, Finish, and Cancel actions are
always visible; the Region section cannot collapse while drawing. Fine-mouse
double-click may finish, but touch never depends on double-tap. Region rows
support pinned tap/focus preview without losing fine pointer hover.
Region and ROI deliberately do not enlarge row heights, table columns, preview
counts, swatches, drawing actions, or box/clear/delete controls for coarse
pointers. They use the same geometry as fine-pointer layouts. ROI entries
always remain a single row at every viewport width; do not add a narrow two-row
reflow. Keep the ROI/Neuron #/Selected column header visible, using the shared
pointer-independent narrow columns rather than hiding it at extreme widths.
Precise box coordinates remain dialog-only.

### Full-FOV Map

`features/map/model.js` owns visibility and shapes; `background-layer.js` owns
the WebGL background; `interactions.js` owns coordinates and gestures;
`facade.js` owns Plotly and injected feature ports.

Keep the pointer-inert background canvas aligned with Plotly using top-left,
row-major image orientation, x-right, reversed y, and zero-based coordinates.
Do not transpose or normalize coordinates. Pan, zoom, resize, ROI hit testing,
and Region drawing must retain this alignment. The ROI activation hit band is
8 px for fine pointers and 22 px for touch/Pencil.

Two-finger horizontal/vertical scrolling pans in screen space. Trackpad pinch
and Ctrl+wheel over the Map zoom around the pointer. Plotly generic scroll zoom
remains disabled. Coalesce wheel work by animation frame. Plotly does not own
automatic resize; the Map ResizeObserver and application render boundary are
the only resize owners.

Mouse keeps Plotly hover/drag pan and fine-pointer double-click Fit; a neuron
click only toggles selection and never pins details. Trackpad scroll pans and
trackpad pinch zooms around the pointer. Touch/Pencil is captured before Plotly:
one finger pans and two fingers pinch and translate. With no fixed details, a
neuron tap only pins its inspector, ROI-border tap activates that ROI, and blank
tap is a no-op. A second direct tap on the same neuron within the bounded
double-tap time and screen-space slop toggles selection and refreshes the same
inspector. Any other next direct tap only dismisses the current inspector and
returns without activating its neuron, ROI, or blank target. This recognition
lives in Pointer tap state, not a synthetic `dblclick`; pointer cancellation,
drag, pinch, visibility loss, and orientation change clear its candidate.
Escape also closes fixed details. With Map focus, Arrow keys pan, `+`/`-` zoom,
`0` fits the full field of view, and `?` opens Help/Shortcuts. The Plotly
modebar is hidden for a coarse/no-hover primary pointer. Gesture frames do not
persist or fetch, and their trailing synthetic click is suppressed. Touch
relayout is single-flight and latest-wins so a slow Plotly frame cannot build a
queue of stale pan/pinch updates. Coarse touch screens reserve the left and
right safe-area gutters for browser or operating-system navigation gestures
rather than Map manipulation.

Neuron preview uses `hover-card.js`, not native Plotly labels. Mouse hover and
pinned touch/Pencil inspection share `temporal.describeNeuronTrace()` so source,
mode, scale, denominators, baselines, and guides match Temporal: Trace. The card
is pointer-inert and has no close button; direct Map tap semantics above or
context-scoped Escape dismiss fixed details. Preview work is animation-frame
coalesced and does not persist or fetch data. Its pointer-inert trace is drawn
directly from the shared Plotly-independent Temporal descriptor on Canvas2D;
do not construct a second Plotly graph for this static preview. Bottom layout
fixes the card to the safe-area top across the available width; wide/sidebar
layout always places it beside the neuron and avoids the workflow overlay,
independent of input modality.

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
- Workflow plots are inspection-only on touch so vertical gestures scroll the
  sheet. Heatmap cell taps pin details. Trace shows the same baseline-aligned
  delete-X action on mouse hover or after a touch/pen tap; its fine-pointer
  size is 20 px and its coarse-pointer hit target is 44 px. A confirmed blank
  tap or Escape closes a pinned action without changing selection.
- Heatmap uses the fixed Magma scale. Trace keeps per-row zero baselines and a
  dotted 5% guide in DF/F mode. Screen and SVG/PNG exports must use the same
  scientific state and membership.
- Both Temporal panels use one content-container threshold, set immediately
  before the longest source label would wrap. At or below that threshold, the
  source/value controls stack; Heatmap places its full-width Color Map above
  right-aligned downloads, while Trace places its two scale sliders above
  right-aligned downloads. Labels never wrap; wider controls keep the
  established single-row layout.

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
