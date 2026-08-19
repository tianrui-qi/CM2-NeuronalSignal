import { createConfirmationDialog } from "../shared/ui/confirmation-dialog.js";


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
 *     scheduleDoubleFrame: (callback: () => void) => void,
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
 *       dffDenominators: Float64Array,
 *       tracesBySource: Record<string, Float32Array>,
 *     }>,
 *     loadBackground: (key: string) => Promise<{
 *       spec: Record<string, any>,
 *       values: Uint16Array,
 *     }>,
 *   },
 *   uiState: {
 *     save: () => boolean,
 *     load: () => Promise<{
 *       mode: "browser" | "edit_default",
 *       source: "local" | "default" | "factory",
 *     }>,
 *     clearAll: () => boolean,
 *     restoreDefault: () => boolean,
 *     canRestoreDefault: () => boolean,
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
  let uiStateActionsWired = false;
  let backgroundLoadRevision = 0;
  let statusRevision = 0;
  let activeStatusRevision = 0;
  /** @type {null | "browser" | "edit_default"} */
  let uiStateMode = null;

  const getState = () => store.getSnapshot();

  function setStatus(message, isError = false) {
    const revision = ++statusRevision;
    activeStatusRevision = revision;
    const element = documentRef.getElementById("status-banner");
    element.textContent = message ?? "";
    element.classList.toggle("hidden", !message);
    element.classList.toggle("error", isError);
    return revision;
  }

  function clearStatus(revision) {
    if (revision !== activeStatusRevision) {
      return false;
    }
    setStatus("");
    return true;
  }

  function createScopedStatusPort() {
    let ownedRevision = null;
    return Object.freeze({
      setStatus(message, isError = false) {
        if (!message) {
          if (ownedRevision === null) {
            return false;
          }
          const revision = ownedRevision;
          ownedRevision = null;
          return clearStatus(revision);
        }
        ownedRevision = setStatus(message, isError);
        return ownedRevision;
      },
      clearStatus(revision) {
        if (revision !== ownedRevision) {
          return false;
        }
        ownedRevision = null;
        return clearStatus(revision);
      },
    });
  }

  const temporalStatus = createScopedStatusPort();
  const qualityControlStatus = createScopedStatusPort();
  const regionStatus = createScopedStatusPort();
  const roiStatus = createScopedStatusPort();
  const stateConfirmationDialog = createConfirmationDialog({ document: documentRef });

  function saveUiState() {
    uiState.save();
    renderUiStateActions();
  }

  function renderUiStateActions() {
    const actionGroup = /** @type {HTMLElement | null} */ (
      documentRef.getElementById("workflow-state-actions")
    );
    const clearButton = /** @type {HTMLButtonElement | null} */ (
      documentRef.getElementById("clear-all-btn")
    );
    const restoreButton = documentRef.getElementById("restore-default-btn");
    const available = uiStateMode === "browser";
    if (actionGroup) {
      actionGroup.hidden = !available;
      actionGroup.inert = !available;
      if (available) {
        actionGroup.removeAttribute("aria-hidden");
      } else {
        actionGroup.setAttribute("aria-hidden", "true");
      }
    }
    if (!available) {
      restoreButton?.classList.add("hidden");
      restoreButton?.setAttribute("aria-hidden", "true");
      actionGroup?.remove();
      return false;
    }
    const visible = uiState.canRestoreDefault();
    const restoreHadFocus = documentRef.activeElement === restoreButton;
    restoreButton?.classList.toggle("hidden", !visible);
    restoreButton?.setAttribute("aria-hidden", String(!visible));
    if (!visible && restoreHadFocus) {
      if (clearButton && !clearButton.disabled) {
        clearButton.focus();
      } else {
        documentRef.querySelector('[data-section-toggle="background"]')?.focus();
      }
    }
    return true;
  }

  function setUiStateActionsBusy(busy) {
    for (const id of ["clear-all-btn", "restore-default-btn"]) {
      const button = /** @type {HTMLButtonElement | null} */ (
        documentRef.getElementById(id)
      );
      if (button) {
        button.disabled = busy;
        button.setAttribute("aria-busy", String(busy));
      }
    }
  }

  function renderMap() {
    return features.map.render();
  }

  function renderTemporalPlots() {
    features.temporal.wire({
      plotly,
      persistUiState: saveUiState,
      refreshRoiViews,
      refreshMapHoverPreview: features.map.refreshHoverPreview,
      renderMap,
      setStatus: temporalStatus.setStatus,
      clearStatus: temporalStatus.clearStatus,
    });
    return features.temporal.render();
  }

  function updatePlots() {
    return renderWorkflowChrome() ? renderTemporalPlots() : null;
  }

  function resizeVisiblePanelPlots() {
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
  }

  function schedulePanelPlotResize({ refreshTemporal = false } = {}) {
    renderScheduler.schedulePanelResize({
      refreshTemporal: Boolean(refreshTemporal),
      onReady: (shouldRefreshTemporal) => {
        resizeVisiblePanelPlots();

        // Width changes do not alter Temporal data or plot height, so a full
        // react would only queue expensive redraws behind live drag reflows.
        // Drag end, double-click, and viewport resize request one final pass
        // to win over any in-flight intermediate-width Plotly resize.
        if (shouldRefreshTemporal) {
          renderScheduler.scheduleDoubleFrame(resizeVisiblePanelPlots);
        }
      },
    });
  }

  async function loadActiveBackground({ showStatus = false } = {}) {
    const active = features.background.active();
    if (!active) {
      throw new Error("No background is available in the cache.");
    }
    const revision = ++backgroundLoadRevision;
    features.map.clearBackground();
    const statusToken = showStatus
      ? setStatus(`Loading ${active.label ?? active.key} background...`)
      : null;
    let payload;
    try {
      payload = await cacheClient.loadBackground(active.key);
    } catch (error) {
      if (
        revision !== backgroundLoadRevision
        || features.background.active()?.key !== active.key
      ) {
        return false;
      }
      throw error;
    }
    if (
      revision !== backgroundLoadRevision
      || features.background.active()?.key !== payload.spec.key
    ) {
      return false;
    }
    features.map.setBackgroundImage({
      spec: payload.spec,
      pixels: payload.values,
    });
    if (statusToken !== null) {
      clearStatus(statusToken);
    }
    return true;
  }

  function handleBackgroundRangeChange(_range, backgroundKey) {
    if (features.background.active()?.key !== backgroundKey) {
      return;
    }
    saveUiState();
    features.map.renderBackground();
  }

  function renderBackgroundControl() {
    features.background.renderControl(
      setActiveBackgroundKey,
      handleBackgroundRangeChange,
    );
  }

  function setActiveBackgroundKey(backgroundKey) {
    const next = features.background.normalizeKey(backgroundKey);
    if (!next || !features.background.setActive(next)) {
      return;
    }
    saveUiState();
    renderBackgroundControl();
    void loadActiveBackground({ showStatus: true }).catch((error) => {
      logger.error(error);
      setStatus(error?.message ?? "Failed to load background.", true);
    });
  }

  function renderRoiWorkflowPanel() {
    return features.roi.renderPanel({
      refreshRoiViews,
      setStatus: roiStatus.setStatus,
    });
  }

  function renderWorkflowChrome() {
    const hasSelectedNeurons = features.temporal.hasSelectedNeurons();
    shell.renderChrome({
      hiddenSections: hasSelectedNeurons
        ? []
        : ["temporalHeatmap", "temporalTrace"],
    });
    return hasSelectedNeurons;
  }

  function renderWorkflowSections({ includeMap = true, includePlots = true } = {}) {
    const state = getState();
    const showTemporal = renderWorkflowChrome();
    renderBackgroundControl();
    features.region.renderList();
    features.qualityControl.renderMetricControl();
    if (state.openSections.qc) {
      features.qualityControl.renderStats();
    }
    renderRoiWorkflowPanel();
    if (
      includePlots
      && showTemporal
      && (state.openSections.temporalHeatmap || state.openSections.temporalTrace)
    ) {
      renderTemporalPlots();
    }
    schedulePanelPlotResize();
    if (includeMap && state.points) {
      renderMap();
    }
  }

  function refreshRoiViews({ includePlots = false } = {}) {
    features.roi.pruneSelectionsToBoxes();
    const showTemporal = renderWorkflowChrome();
    saveUiState();
    renderMap();
    renderRoiWorkflowPanel();
    if (includePlots && showTemporal) {
      renderTemporalPlots();
    }
  }

  async function renderAppliedUiState() {
    features.background.setActive(getState().activeBackgroundKey);
    features.temporal.ensureValidState({ includeValueMode: false });
    features.qualityControl.ensureValidMetric();
    features.qualityControl.ensureValidRanges();
    if (features.roi.pruneSelectionsToBoxes()) {
      saveUiState();
    }
    features.map.clearViewRange();
    shell.applyOverlayWidth();
    const backgroundLoad = loadActiveBackground({ showStatus: true });
    // Refresh every state-owned panel immediately. Background loading starts
    // synchronously above and clears the old underlay, but a slow or failed
    // binary request must never leave ROI/QC/Temporal UI from the prior state.
    renderWorkflowSections();
    renderUiStateActions();
    await backgroundLoad;
  }

  /** @param {() => boolean} replaceState */
  async function replaceUiState(replaceState) {
    setUiStateActionsBusy(true);
    try {
      if (!replaceState()) {
        return false;
      }
      await renderAppliedUiState();
      return true;
    } catch (error) {
      logger.error(error);
      setStatus(error?.message ?? "Failed to replace viewer state.", true);
      return false;
    } finally {
      setUiStateActionsBusy(false);
      renderUiStateActions();
    }
  }

  function wireUiStateActions() {
    if (uiStateMode !== "browser" || uiStateActionsWired) {
      return false;
    }
    uiStateActionsWired = true;
    const clearButton = /** @type {HTMLButtonElement | null} */ (
      documentRef.getElementById("clear-all-btn")
    );
    const restoreButton = /** @type {HTMLButtonElement | null} */ (
      documentRef.getElementById("restore-default-btn")
    );
    clearButton?.addEventListener("click", () => {
      stateConfirmationDialog.open({
        title: "Clear all viewer state?",
        description: (
          "Reset all viewer settings and selections to a clean state. Regions, ROIs, "
          + "neuron selections, filters, display ranges, and Temporal settings will "
          + "be cleared without loading the Default Profile."
        ),
        confirmLabel: "Clear All",
        confirmDescription: "Reset all viewer settings and selections without loading the Default Profile",
        trigger: clearButton,
        onConfirm: () => replaceUiState(uiState.clearAll),
        focusAfterConfirm: () => clearButton,
      });
    });
    restoreButton?.addEventListener("click", () => {
      stateConfirmationDialog.open({
        title: "Restore Default Profile?",
        description: (
          "Replace all viewer settings and selections with the configured Default "
          + "Profile. Current changes will be discarded."
        ),
        confirmLabel: "Restore Default",
        confirmDescription: "Restore all viewer settings and selections from the configured Default Profile",
        trigger: restoreButton,
        onConfirm: () => replaceUiState(uiState.restoreDefault),
        focusAfterConfirm: (didReplace) => {
          if (didReplace || restoreButton.classList.contains("hidden")) {
            return clearButton;
          }
          return restoreButton;
        },
      });
    });
    return true;
  }

  function wireInteractions() {
    wireUiStateActions();
    features.qualityControl.wire({
      plotly,
      persistUiState: saveUiState,
      renderWorkflowChrome,
      renderRoiWorkflowPanel,
      renderRegionList: features.region.renderList,
      renderMap,
      updatePlots,
      setStatus: qualityControlStatus.setStatus,
      clearStatus: qualityControlStatus.clearStatus,
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
      setStatus: regionStatus.setStatus,
      mapEventToDataPoint: features.map.eventToDataPoint,
      renderMap,
      renderQualityControl: features.qualityControl.renderMetricControl,
      updateTemporal: updatePlots,
    });
  }

  async function initialize() {
    try {
      const startupStatusToken = setStatus("Loading cache...");
      commands.hydrateCache(await cacheClient.load());
      // Resolve all dataset-dependent program defaults before the persistence
      // service captures the Factory State used by Clear All.
      features.background.setActive(getState().activeBackgroundKey);
      features.temporal.ensureValidState({ includeValueMode: false });
      features.qualityControl.ensureValidMetric();
      features.qualityControl.ensureValidRanges();
      const loadedUiState = await uiState.load();
      uiStateMode = loadedUiState.mode;
      features.background.setActive(getState().activeBackgroundKey);
      await loadActiveBackground();
      features.temporal.ensureValidState({ includeValueMode: false });
      features.qualityControl.ensureValidMetric();
      features.qualityControl.ensureValidRanges();
      features.roi.pruneSelectionsToBoxes();
      wireInteractions();
      shell.applyOverlayWidth();
      if (!plotly) {
        throw new ReferenceError("Plotly is not defined");
      }
      features.qualityControl.renderMetricControl();
      renderWorkflowSections();
      renderUiStateActions();
      clearStatus(startupStatusToken);
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
