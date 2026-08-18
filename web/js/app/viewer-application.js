/**
 * Browser application boundary for the CM2 viewer.
 *
 * Features own their policy and rendering. This module owns only startup,
 * persisted-state hydration, cross-feature effect wiring, and the established
 * render/effect order.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     hydrateCache: (cache: any) => unknown,
 *     replaceOpenSections: (openSections: Record<string, boolean>) => unknown,
 *     setActiveWorkflowSection: (section: string) => unknown,
 *     setOverlayWidth: (width: number | null) => unknown,
 *   },
 *   renderScheduler: {
 *     schedulePanelResize: (options: {
 *       refreshTemporal: boolean,
 *       onReady: (refreshTemporal: boolean) => void,
 *     }) => void,
 *   },
 *   features: {
 *     background: Record<string, any>,
 *     qualityControl: Record<string, any>,
 *     region: Record<string, any>,
 *     roi: Record<string, any>,
 *     map: Record<string, any>,
 *     temporal: Record<string, any>,
 *   },
 *   shell: Record<string, any>,
 *   cacheClient: {
 *     load: () => Promise<{
 *       meta: any,
 *       points: any,
 *       tracesBySource: Record<string, Float32Array>,
 *     }>,
 *   },
 *   uiState: {
 *     save: () => void,
 *     load: () => Promise<boolean>,
 *     sendPendingBeacon: () => void,
 *   },
 *   document?: Document,
 *   window?: Window,
 *   plotly: any,
 *   logger?: Pick<Console, "error" | "warn">,
 * }} dependencies
 */
export function createViewerApplication({
  store,
  commands,
  renderScheduler,
  features,
  shell,
  cacheClient,
  uiState,
  document: documentRef = globalThis.document,
  window: windowRef = globalThis.window,
  plotly,
  logger = globalThis.console,
}) {
  let lifecycleStarted = false;

  const getState = () => store.getSnapshot();

  function setStatus(message, isError = false) {
    const element = documentRef.getElementById("status-banner");
    element.textContent = message ?? "";
    element.classList.toggle("hidden", !message);
    element.classList.toggle("error", isError);
  }

  function saveUiState() {
    uiState.save();
  }

  function renderMap() {
    return features.map.render();
  }

  function updatePlots() {
    features.temporal.wire({
      plotly,
      persistUiState: saveUiState,
      refreshRoiViews,
      refreshMapHoverPreview: features.map.refreshHoverPreview,
      renderMap,
      setStatus,
    });
    return features.temporal.render();
  }

  function schedulePanelPlotResize({ refreshTemporal = false } = {}) {
    renderScheduler.schedulePanelResize({
      refreshTemporal: Boolean(refreshTemporal),
      onReady: (shouldRefreshTemporal) => {
        if (shouldRefreshTemporal) {
          updatePlots();
          return;
        }

        for (const id of ["blueprint-stats-plot", "c-trace-plot", "c-heatmap-plot"]) {
          const plot = documentRef.getElementById(id);
          if (plot && plot.offsetWidth > 0 && plot.offsetHeight > 0) {
            try {
              plotly.Plots.resize(plot);
            } catch (error) {
              logger.warn(error);
            }
          }
        }
      },
    });
  }

  function setActiveBackgroundKey(backgroundKey) {
    const next = features.background.normalizeKey(backgroundKey);
    if (!next || !features.background.setActive(next)) {
      return;
    }
    saveUiState();
    features.background.renderControl(setActiveBackgroundKey);
    renderMap();
  }

  function renderRoiWorkflowPanel() {
    return features.roi.renderPanel({
      refreshRoiViews,
      setStatus,
    });
  }

  function renderWorkflowChrome() {
    shell.renderChrome();
  }

  function renderWorkflowSections({ includeMap = true, includePlots = true } = {}) {
    const state = getState();
    renderWorkflowChrome();
    features.background.renderControl(setActiveBackgroundKey);
    features.region.renderList();
    features.qualityControl.renderMetricControl();
    if (state.openSections.qc) {
      features.qualityControl.renderStats();
    }
    renderRoiWorkflowPanel();
    if (
      includePlots
      && (state.openSections.temporalHeatmap || state.openSections.temporalTrace)
    ) {
      updatePlots();
    }
    schedulePanelPlotResize();
    if (includeMap && state.points) {
      renderMap();
    }
  }

  function refreshRoiViews({ includePlots = false } = {}) {
    features.roi.pruneSelectionsToBoxes();
    saveUiState();
    renderMap();
    renderRoiWorkflowPanel();
    if (includePlots) {
      updatePlots();
    }
  }

  function wireInteractions() {
    features.qualityControl.wire({
      plotly,
      persistUiState: saveUiState,
      renderWorkflowChrome,
      renderRoiWorkflowPanel,
      renderRegionList: features.region.renderList,
      renderMap,
      updatePlots,
      setStatus,
    });
    shell.wire({
      persistUiState: saveUiState,
      renderSections: renderWorkflowSections,
      requestPanelResize: schedulePanelPlotResize,
      onViewportChanged: () => {
        features.map.clearViewRange();
        renderMap();
      },
    });
    features.region.wire({
      rememberMapViewRange: features.map.rememberViewRange,
      persistUiState: saveUiState,
      setStatus,
      mapEventToDataPoint: features.map.eventToDataPoint,
      renderMap,
      renderQualityControl: features.qualityControl.renderMetricControl,
      updateTemporal: updatePlots,
    });
  }

  async function initialize() {
    try {
      setStatus("Loading cache...");
      commands.hydrateCache(await cacheClient.load());
      await uiState.load();
      features.background.setActive(getState().activeBackgroundKey);
      features.temporal.ensureValidState({ includeValueMode: false });
      features.qualityControl.ensureValidMetric();
      features.qualityControl.ensureValidRanges();
      if (features.roi.pruneSelectionsToBoxes()) {
        saveUiState();
      }
      wireInteractions();
      shell.applyOverlayWidth();
      if (!plotly) {
        throw new ReferenceError("Plotly is not defined");
      }
      features.qualityControl.renderMetricControl();
      renderWorkflowSections();
      setStatus("");
    } catch (error) {
      logger.error(error);
      setStatus(error?.message ?? "Failed to initialize web app.", true);
    }
  }

  function start() {
    if (lifecycleStarted) {
      return false;
    }
    lifecycleStarted = true;
    windowRef.addEventListener("load", initialize);
    windowRef.addEventListener("pagehide", uiState.sendPendingBeacon);
    return true;
  }

  return Object.freeze({
    start,
  });
}
