import {
  buildMapLayout,
  buildMapMarkerStyle,
  buildMapPointTrace,
  buildNeuronPreviewMetadata,
  computeMapCoverRanges,
  isNeuronVisibleOnMap,
  selectCurrentMapViewRange,
  selectVisiblePointIndices,
} from "./model.js";
import {
  COARSE_NEURON_HIT_RADIUS_PX,
  COARSE_ROI_BOX_BORDER_TOLERANCE_PX,
  FINE_NEURON_HIT_RADIUS_PX,
  ROI_BOX_BORDER_CLICK_TOLERANCE_PX,
  axisDataToPlotPixel,
  createMapInteractionController,
  findRoiBoxBorderHit,
  mapEventToDataPoint,
  zoomAxisRange,
} from "./interactions.js";
import { createMapBackgroundLayer } from "./background-layer.js";
import { createMapNeuronHoverCard } from "./hover-card.js";


function buildMapPlotConfig() {
  return {
    responsive: false,
    displayModeBar: true,
    modeBarButtonsToRemove: ["select2d", "lasso2d"],
    displaylogo: false,
    scrollZoom: false,
    doubleClick: false,
  };
}


/**
 * Public Full-FOV Map boundary. The model owns scientific/display policy,
 * interactions own Plotly/DOM input, commands own transient state writes, and
 * this facade preserves the required render and listener ordering. Quality
 * Control supplies raw metric values and finite raw color bounds.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     setMapPlotReady: (ready: boolean) => boolean,
 *     setMapViewportKey: (viewportKey: string) => string,
 *     setMapViewRange: (range: { xRange: number[], yRange: number[] }) => unknown,
 *     clearMapViewRange: () => boolean,
 *   },
 *   document: Document,
 *   window: Window,
 *   plotly: {
 *     react: (plot: HTMLElement, data: any[], layout: any, config: any) => Promise<any>,
 *     relayout: (plot: HTMLElement, update: Record<string, any>) => Promise<any>,
 *     Plots?: { resize: (plot: HTMLElement) => unknown },
 *   },
 *   requestAnimationFrame: (callback: FrameRequestCallback) => number,
 *   background: {
 *     active: () => Record<string, any> | null,
 *     range: () => { lower: number, upper: number } | null,
 *   },
 *   qualityControl: {
 *     activeFilters: () => any,
 *     pointPassesMetricFilters: (pointIndex: number, filters?: any) => boolean,
 *     renderedSpec: () => { key: string } | null,
 *     buildMetricValues: (spec: any) => { values: number[] },
 *     colorRange: (metricKey: string) => { lower: number, upper: number },
 *     colorScale: any,
 *   },
 *   region: {
 *     activeDisplayScope: () => { countMode: string },
 *     pointPasses: (pointIndex: number) => boolean,
 *     pointPassesDisplayScope: (pointIndex: number, scope?: any) => boolean,
 *     buildMapTraces: () => any[],
 *     isDrawing: () => boolean,
 *     addPointFromMapEvent: (event: PointerEvent) => unknown,
 *   },
 *   roi: {
 *     getById: (roiId: string) => any,
 *     findAssignedRoiId: (neuronId: number) => string | null,
 *     pointIndexInBox: (pointIndex: number, roi: any) => boolean,
 *     setActive: (roiId: string) => unknown,
 *     toggleNeuron: (neuronId: number) => unknown,
 *   },
 *   temporal: {
 *     describeNeuronTrace: (neuronId: number) => null | {
 *       traces: any[],
 *       shapes: any[],
 *       annotations: any[],
 *       height: number,
 *       frameRange: number[],
 *       yRange: number[],
 *       guideRange: number[] | null,
 *       pixelsPerUnit: number,
 *     },
 *   },
 * }} dependencies
 */
export function createMapFeature({
  store,
  commands,
  document,
  window,
  plotly,
  requestAnimationFrame,
  background,
  qualityControl,
  region,
  roi,
  temporal,
}) {
  const interactions = createMapInteractionController({
    requestAnimationFrame,
    plotly,
  });
  const hoverCard = createMapNeuronHoverCard({
    document,
    window,
    requestAnimationFrame,
  });
  const backgroundCanvas = /** @type {HTMLCanvasElement | null} */ (
    document.getElementById("map-background")
  );
  if (!backgroundCanvas) {
    throw new Error("Missing Map background canvas.");
  }
  const edgeColorTarget = document.documentElement;
  const backgroundLayer = createMapBackgroundLayer({
    canvas: backgroundCanvas,
    window,
    onEdgeColor(color) {
      if (color) {
        edgeColorTarget.style.setProperty("--edge-fallback-color", color);
      } else {
        edgeColorTarget.style.removeProperty("--edge-fallback-color");
      }
    },
  });
  let loadedBackgroundKey = null;
  let skipViewCaptureOnce = false;
  let resizeFramePending = false;
  let resizeInProgress = false;
  let resizeRequested = false;
  let resizeSyncActive = false;
  let renderInProgress = false;
  let latestRenderRequest = 0;
  let latestViewOperation = 0;
  let lastSynchronizedViewport = null;
  /** @type {number[] | null} */
  let renderedPointIndices = null;
  /** @type {ResizeObserver | null} */
  let mapResizeObserver = null;
  /** @type {null | { neuronId: number, anchor: { x: number, y: number }, pinned: boolean }} */
  let activePreview = null;
  const visibilityPorts = {
    activeFilters: qualityControl.activeFilters,
    activeDisplayScope: region.activeDisplayScope,
    pointPasses: region.pointPasses,
    pointPassesDisplayScope: region.pointPassesDisplayScope,
    pointPassesMetricFilters: qualityControl.pointPassesMetricFilters,
  };
  const markerPorts = {
    renderedSpec: qualityControl.renderedSpec,
    buildMetricValues: qualityControl.buildMetricValues,
    colorRange: qualityControl.colorRange,
    colorScale: qualityControl.colorScale,
    findAssignedRoiId: roi.findAssignedRoiId,
    getById: roi.getById,
    pointIndexInBox: roi.pointIndexInBox,
  };

  const getState = () => store.getSnapshot();
  const getPlot = () => /** @type {Cm2PlotElement | null} */ (
    document.getElementById("map-plot")
  );

  /** @param {HTMLElement | null} [plot] */
  function mapViewportSize(plot = getPlot()) {
    const rect = plot?.getBoundingClientRect();
    const width = Number(rect?.width) || Number(plot?.clientWidth) || window.innerWidth;
    const height = Number(rect?.height) || Number(plot?.clientHeight) || window.innerHeight;
    return {
      width: Math.max(1, width),
      height: Math.max(1, height),
    };
  }

  /** @param {{ width: number, height: number } | null} first @param {{ width: number, height: number } | null} second */
  function sameViewportSize(first, second) {
    return Boolean(
      first
      && second
      && Math.abs(first.width - second.width) < 0.5
      && Math.abs(first.height - second.height) < 0.5
    );
  }

  function beginViewOperation() {
    latestViewOperation += 1;
    resizeSyncActive = false;
    return true;
  }

  function visiblePointIndices() {
    return selectVisiblePointIndices(getState(), visibilityPorts);
  }

  /** @param {number} neuronId */
  function neuronAnchor(neuronId) {
    const state = getState();
    const pointIndex = state.pointIndexByNeuronId?.get(neuronId) ?? null;
    const plot = getPlot();
    if (pointIndex === null || !plot) {
      return null;
    }
    const x = axisDataToPlotPixel(
      plot._fullLayout?.xaxis,
      Number(state.points.x[pointIndex]),
    );
    const y = axisDataToPlotPixel(
      plot._fullLayout?.yaxis,
      Number(state.points.y[pointIndex]),
    );
    if (x === null || y === null) {
      return null;
    }
    const rect = plot.getBoundingClientRect();
    return { x: rect.left + x, y: rect.top + y };
  }

  /** @param {MouseEvent | PointerEvent} event */
  function findNeuronHit(event) {
    const state = getState();
    const plot = getPlot();
    const xaxis = plot?._fullLayout?.xaxis;
    const yaxis = plot?._fullLayout?.yaxis;
    if (!plot || !xaxis || !yaxis) {
      return null;
    }
    const rect = plot.getBoundingClientRect();
    const hitRadius = event.pointerType === "touch" || event.pointerType === "pen"
      ? COARSE_NEURON_HIT_RADIUS_PX
      : FINE_NEURON_HIT_RADIUS_PX;
    const eventPoint = { x: event.clientX, y: event.clientY };
    const xPixel = event.clientX - rect.left - (xaxis._offset ?? 0);
    const yPixel = event.clientY - rect.top - (yaxis._offset ?? 0);
    const axisBounds = (axis, pixel) => {
      if (typeof axis.p2d !== "function") {
        return null;
      }
      const start = Number(axis.p2d(pixel - hitRadius));
      const end = Number(axis.p2d(pixel + hitRadius));
      return Number.isFinite(start) && Number.isFinite(end)
        ? [Math.min(start, end), Math.max(start, end)]
        : null;
    };
    const xBounds = axisBounds(xaxis, xPixel);
    const yBounds = axisBounds(yaxis, yPixel);
    const hitRadiusSquared = hitRadius * hitRadius;
    const filters = qualityControl.activeFilters();
    let nearest = null;
    for (const pointIndex of renderedPointIndices ?? visiblePointIndices()) {
      const dataX = Number(state.points.x[pointIndex]);
      const dataY = Number(state.points.y[pointIndex]);
      if (
        (xBounds && (dataX < xBounds[0] || dataX > xBounds[1]))
        || (yBounds && (dataY < yBounds[0] || dataY > yBounds[1]))
      ) {
        continue;
      }
      const neuronId = Number(state.points.id[pointIndex]);
      if (!neuronIdVisible(neuronId, filters)) {
        continue;
      }
      const x = axisDataToPlotPixel(xaxis, dataX);
      const y = axisDataToPlotPixel(yaxis, dataY);
      if (x === null || y === null) {
        continue;
      }
      const anchor = { x: rect.left + x, y: rect.top + y };
      const deltaX = eventPoint.x - anchor.x;
      const deltaY = eventPoint.y - anchor.y;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (
        distanceSquared <= hitRadiusSquared
        && (!nearest || distanceSquared < nearest.distanceSquared)
      ) {
        nearest = { neuronId, anchor, distanceSquared };
      }
    }
    return nearest
      ? { neuronId: nearest.neuronId, anchor: nearest.anchor }
      : null;
  }

  /** @param {number} neuronId @param {any} [filters] */
  function neuronIdVisible(neuronId, filters = qualityControl.activeFilters()) {
    return isNeuronVisibleOnMap(
      getState(),
      neuronId,
      visibilityPorts,
      filters,
    );
  }

  function rememberViewRange() {
    if (resizeSyncActive) {
      return false;
    }
    const range = selectCurrentMapViewRange(getPlot());
    if (range) {
      commands.setMapViewRange(range);
      renderBackground(range);
    }
  }

  /**
   * Draw against the actual Plotly axes when available. During a relayouting
   * gesture this keeps the GPU underlay aligned without persisting every frame.
   */
  function syncBackgroundView() {
    const range = selectCurrentMapViewRange(getPlot());
    return renderBackground(range ?? undefined);
  }

  /**
   * @param {{ xRange: number[], yRange: number[] }} [viewRange]
   */
  function renderBackground(viewRange) {
    const state = getState();
    const active = background.active();
    const displayRange = background.range();
    if (
      !state.meta
      || !active
      || active.key !== loadedBackgroundKey
      || !displayRange
    ) {
      return false;
    }
    const viewport = mapViewportSize();
    const effectiveView = viewRange
      ?? selectCurrentMapViewRange(getPlot())
      ?? state.mapViewRange
      ?? computeMapCoverRanges(state.meta, viewport.width, viewport.height);
    return backgroundLayer.render({
      range: displayRange,
      xRange: effectiveView.xRange,
      yRange: effectiveView.yRange,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    });
  }

  /** @param {HTMLElement} plot */
  function scheduleMapResize(plot) {
    resizeRequested = true;
    if (resizeFramePending || resizeInProgress || renderInProgress) {
      return;
    }
    resizeFramePending = true;
    requestAnimationFrame(() => {
      resizeFramePending = false;
      if (!resizeRequested || resizeInProgress || renderInProgress) {
        return;
      }
      const targetViewport = mapViewportSize(plot);
      if (sameViewportSize(targetViewport, lastSynchronizedViewport)) {
        resizeRequested = false;
        return;
      }
      resizeRequested = false;
      resizeInProgress = true;
      resizeSyncActive = true;
      const viewOperation = latestViewOperation;
      const preservedRange = selectCurrentMapViewRange(plot);
      const resizeResult = typeof plotly.Plots?.resize === "function"
        ? plotly.Plots.resize(plot)
        : null;
      Promise.resolve(resizeResult)
        .then(() => {
          if (
            viewOperation !== latestViewOperation
            || !preservedRange
          ) {
            return null;
          }
          return plotly.relayout(plot, {
            "xaxis.range": preservedRange.xRange,
            "yaxis.range": preservedRange.yRange,
          });
        })
        .catch(() => null)
        .finally(() => {
          if (viewOperation === latestViewOperation) {
            lastSynchronizedViewport = targetViewport;
          }
          syncBackgroundView();
          refreshPinnedPreview();
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              resizeSyncActive = false;
              resizeInProgress = false;
              if (resizeRequested) {
                scheduleMapResize(plot);
              }
            });
          });
        });
    });
  }

  /** @param {HTMLElement} plot */
  function observeMapSize(plot) {
    if (mapResizeObserver || typeof window.ResizeObserver !== "function") {
      return false;
    }
    mapResizeObserver = new window.ResizeObserver(() => scheduleMapResize(plot));
    mapResizeObserver.observe(plot);
    if (plot.parentElement) {
      mapResizeObserver.observe(plot.parentElement);
    }
    return true;
  }

  /**
   * @param {{ spec: Record<string, any>, pixels: Uint16Array }} payload
   */
  function setBackgroundImage(payload) {
    const state = getState();
    backgroundLayer.setImage({
      pixels: payload.pixels,
      spec: payload.spec,
      width: Number(state.meta.full_width),
      height: Number(state.meta.full_height),
    });
    loadedBackgroundKey = payload.spec.key;
    return renderBackground();
  }

  function clearBackground() {
    loadedBackgroundKey = null;
    return backgroundLayer.clear();
  }

  function clearViewRange() {
    skipViewCaptureOnce = true;
    latestViewOperation += 1;
    return commands.clearMapViewRange();
  }

  function dismissNeuronPreview() {
    activePreview = null;
    return hoverCard.hide();
  }

  function hideHoverPreview() {
    if (activePreview?.pinned) {
      return false;
    }
    return dismissNeuronPreview();
  }

  function isNeuronPreviewPinned() {
    return Boolean(activePreview?.pinned);
  }

  /**
   * @param {{ neuronId: number, anchor: { x: number, y: number }, pinned?: boolean }} input
   */
  function showNeuronPreview({ neuronId, anchor, pinned = false }) {
    const state = getState();
    const pointIndex = state.pointIndexByNeuronId?.get(neuronId) ?? null;
    if (
      pointIndex === null
      || region.isDrawing()
    ) {
      return dismissNeuronPreview();
    }
    const trace = temporal.describeNeuronTrace(neuronId);
    if (!trace) {
      return dismissNeuronPreview();
    }
    const metadata = buildNeuronPreviewMetadata(state, pointIndex);
    activePreview = { neuronId, anchor, pinned };
    return hoverCard.show({
      title: metadata.title,
      metadataColumns: metadata.columns,
      anchor,
      trace,
      immediate: pinned,
    });
  }

  function refreshHoverPreview() {
    if (!activePreview) {
      return false;
    }
    return showNeuronPreview(activePreview);
  }

  function refreshPinnedPreview() {
    if (!activePreview?.pinned) {
      return false;
    }
    const anchor = neuronAnchor(activePreview.neuronId);
    if (!anchor) {
      return dismissNeuronPreview();
    }
    activePreview.anchor = anchor;
    return hoverCard.move(anchor);
  }

  /** @param {Event} event */
  function eventToDataPoint(event) {
    const state = getState();
    return mapEventToDataPoint({
      event: /** @type {MouseEvent} */ (event),
      plot: getPlot(),
      fullWidth: state.meta.full_width,
      fullHeight: state.meta.full_height,
    });
  }

  /** @param {Cm2PlotElement} plot */
  function installInteractions(plot) {
    interactions.wire(plot, {
      isRegionDrawing: region.isDrawing,
      addRegionPoint: region.addPointFromMapEvent,
      findNeuronHit,
      findBorderHit: (event) => findRoiBoxBorderHit({
        event,
        plot,
        rois: getState().rois,
        tolerance: event.pointerType === "touch" || event.pointerType === "pen"
          ? COARSE_ROI_BOX_BORDER_TOLERANCE_PX
          : ROI_BOX_BORDER_CLICK_TOLERANCE_PX,
      }),
      setActiveRoi: roi.setActive,
      beginViewOperation,
      isViewSyncActive: () => resizeSyncActive,
      rememberViewRange,
      isNeuronEligible: neuronIdVisible,
      toggleNeuron: roi.toggleNeuron,
      showNeuronPreview,
      hideHoverPreview,
      dismissNeuronPreview,
      fitView,
      refreshPinnedPreview,
      isNeuronPreviewPinned,
      syncBackgroundView,
    });
    plot.tabIndex = 0;
    plot.setAttribute("role", "region");
    plot.setAttribute("aria-label", "Full field-of-view neuron map");
  }

  /** @param {{ xRange: number[], yRange: number[] }} range */
  function applyViewRange(range) {
    const plot = getPlot();
    if (!plot) {
      return false;
    }
    beginViewOperation();
    commands.setMapViewRange({
      xRange: range.xRange.slice(0, 2),
      yRange: range.yRange.slice(0, 2),
    });
    void plotly.relayout(plot, {
      "xaxis.range": range.xRange,
      "yaxis.range": range.yRange,
    }).then(() => renderBackground(range));
    return true;
  }

  /** @param {number} factor */
  function zoomByFactor(factor) {
    const current = selectCurrentMapViewRange(getPlot());
    if (!current || !Number.isFinite(factor) || factor <= 0) {
      return false;
    }
    const centerX = (current.xRange[0] + current.xRange[1]) / 2;
    const centerY = (current.yRange[0] + current.yRange[1]) / 2;
    return applyViewRange({
      xRange: zoomAxisRange(current.xRange, centerX, factor),
      yRange: zoomAxisRange(current.yRange, centerY, factor),
    });
  }

  function zoomIn() {
    return zoomByFactor(0.8);
  }

  function zoomOut() {
    return zoomByFactor(1.25);
  }

  function fitView() {
    const state = getState();
    const plot = getPlot();
    if (!state.meta || !plot) {
      return false;
    }
    const viewport = mapViewportSize(plot);
    return applyViewRange(computeMapCoverRanges(
      state.meta,
      viewport.width,
      viewport.height,
    ));
  }

  /**
   * Pan toward the requested screen direction. Positive X moves the viewport
   * right; positive Y moves it down in the Map's top-left image coordinates.
   *
   * @param {number} dx
   * @param {number} dy
   */
  function panByScreen(dx, dy) {
    const current = selectCurrentMapViewRange(getPlot());
    const plot = getPlot();
    if (!current || !plot || !Number.isFinite(dx) || !Number.isFinite(dy)) {
      return false;
    }
    const viewport = mapViewportSize(plot);
    const width = viewport.width;
    const height = viewport.height;
    const xShift = (dx / width) * Math.abs(current.xRange[1] - current.xRange[0]);
    const yShift = (dy / height) * Math.abs(current.yRange[1] - current.yRange[0]);
    return applyViewRange({
      xRange: current.xRange.map((value) => value + xShift),
      yRange: current.yRange.map((value) => value + yShift),
    });
  }

  function dismissPinnedInspector() {
    return dismissNeuronPreview();
  }

  function hasPinnedInspector() {
    return isNeuronPreviewPinned();
  }

  function render() {
    if (region.isDrawing()) {
      dismissNeuronPreview();
    } else {
      hideHoverPreview();
    }
    const state = getState();
    const pointIndices = visiblePointIndices();
    const markerStyle = buildMapMarkerStyle(state, pointIndices, markerPorts);
    const pointTrace = buildMapPointTrace(state, pointIndices, markerStyle);
    const plot = /** @type {Cm2PlotElement} */ (getPlot());
    const viewport = mapViewportSize(plot);
    latestViewOperation += 1;

    // Ordinary data rerenders retain the current viewport. An explicit clear
    // requests a fresh Full-FOV cover range and must not resurrect Plotly's
    // previous axes while the new layout is being built.
    if (skipViewCaptureOnce) {
      skipViewCaptureOnce = false;
    } else {
      rememberViewRange();
    }
    plot.dataset.visibleNeuronCount = String(pointIndices.length);
    commands.setMapViewportKey(`${Math.round(viewport.width)}x${Math.round(viewport.height)}`);
    renderInProgress = true;
    const renderRequest = ++latestRenderRequest;

    void plotly.react(
      plot,
      [pointTrace, ...region.buildMapTraces()],
      buildMapLayout(state, {
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      }),
      buildMapPlotConfig(),
    ).then(() => {
      if (renderRequest === latestRenderRequest) {
        renderedPointIndices = pointIndices;
      }
      if (!getState().mapPlotReady) {
        installInteractions(plot);
        observeMapSize(plot);
        commands.setMapPlotReady(true);
      }
      lastSynchronizedViewport = mapViewportSize(plot);
      syncBackgroundView();
      if (renderRequest === latestRenderRequest) {
        renderInProgress = false;
        if (resizeRequested) {
          scheduleMapResize(plot);
        }
      }
    });
  }

  return Object.freeze({
    render,
    eventToDataPoint,
    rememberViewRange,
    clearBackground,
    clearViewRange,
    dismissPinnedInspector,
    fitView,
    hasPinnedInspector,
    panByScreen,
    refreshHoverPreview,
    renderBackground,
    setBackgroundImage,
    zoomIn,
    zoomOut,
  });
}
