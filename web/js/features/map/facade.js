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
  createMapInteractionController,
  findRoiBoxBorderHit,
  mapEventToDataPoint,
} from "./interactions.js";
import { createMapBackgroundLayer } from "./background-layer.js";
import { createMapNeuronHoverCard } from "./hover-card.js";


function buildMapPlotConfig() {
  return {
    responsive: true,
    displayModeBar: true,
    modeBarButtonsToRemove: ["select2d", "lasso2d"],
    displaylogo: false,
    scrollZoom: false,
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
    plotly,
    requestAnimationFrame,
  });
  const backgroundCanvas = /** @type {HTMLCanvasElement | null} */ (
    document.getElementById("map-background")
  );
  if (!backgroundCanvas) {
    throw new Error("Missing Map background canvas.");
  }
  const backgroundLayer = createMapBackgroundLayer({
    canvas: backgroundCanvas,
    window,
  });
  let loadedBackgroundKey = null;
  /** @type {null | { neuronId: number, anchor: { x: number, y: number } }} */
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

  function visiblePointIndices() {
    return selectVisiblePointIndices(getState(), visibilityPorts);
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
    const effectiveView = viewRange
      ?? selectCurrentMapViewRange(getPlot())
      ?? state.mapViewRange
      ?? computeMapCoverRanges(state.meta, window.innerWidth, window.innerHeight);
    return backgroundLayer.render({
      range: displayRange,
      xRange: effectiveView.xRange,
      yRange: effectiveView.yRange,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
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
    return commands.clearMapViewRange();
  }

  function hideNeuronPreview() {
    activePreview = null;
    return hoverCard.hide();
  }

  /**
   * @param {{ neuronId: number, anchor: { x: number, y: number } }} input
   */
  function showNeuronPreview({ neuronId, anchor }) {
    const state = getState();
    const pointIndex = state.pointIndexByNeuronId?.get(neuronId) ?? null;
    if (
      pointIndex === null
      || region.isDrawing()
    ) {
      return hideNeuronPreview();
    }
    const trace = temporal.describeNeuronTrace(neuronId);
    if (!trace) {
      return hideNeuronPreview();
    }
    const metadata = buildNeuronPreviewMetadata(state, pointIndex);
    activePreview = { neuronId, anchor };
    return hoverCard.show({
      title: metadata.title,
      metadataColumns: metadata.columns,
      anchor,
      trace,
    });
  }

  function refreshHoverPreview() {
    if (!activePreview) {
      return false;
    }
    return showNeuronPreview(activePreview);
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
      findBorderHit: (event) => findRoiBoxBorderHit({
        event,
        plot,
        rois: getState().rois,
      }),
      setActiveRoi: roi.setActive,
      rememberViewRange,
      isNeuronEligible: neuronIdVisible,
      toggleNeuron: roi.toggleNeuron,
      showNeuronPreview,
      hideNeuronPreview,
      syncBackgroundView,
    });
  }

  function render() {
    hideNeuronPreview();
    const state = getState();
    const pointIndices = visiblePointIndices();
    const markerStyle = buildMapMarkerStyle(state, pointIndices, markerPorts);
    const pointTrace = buildMapPointTrace(state, pointIndices, markerStyle);
    const plot = /** @type {Cm2PlotElement} */ (getPlot());

    // Capture the current Plotly view before layout construction so a pending
    // resize update cannot overwrite a range that was just cleared.
    rememberViewRange();
    plot.dataset.visibleNeuronCount = String(pointIndices.length);
    commands.setMapViewportKey(`${window.innerWidth}x${window.innerHeight}`);

    void plotly.react(
      plot,
      [pointTrace, ...region.buildMapTraces()],
      buildMapLayout(state, {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
      buildMapPlotConfig(),
    ).then(() => {
      if (!getState().mapPlotReady) {
        installInteractions(plot);
        commands.setMapPlotReady(true);
      }
      syncBackgroundView();
    });
  }

  return Object.freeze({
    render,
    eventToDataPoint,
    rememberViewRange,
    clearBackground,
    clearViewRange,
    refreshHoverPreview,
    renderBackground,
    setBackgroundImage,
  });
}
