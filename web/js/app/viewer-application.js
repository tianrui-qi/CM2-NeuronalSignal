import { createConfirmationDialog } from "../shared/ui/confirmation-dialog.js";


/**
 * Browser application boundary for the CM2-NeuronalSignal viewer.
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
 *   interactionCommands: {
 *     decorateCommandElements: (root?: ParentNode | Element) => number,
 *     helpEntries: () => Array<{ id: string, label: string, group: string, bindingLabel: string }>,
 *     register: (command: Record<string, any>) => string,
 *     start: () => boolean,
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
  interactionCommands,
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
  /** @type {"map" | "qualityControl" | "temporal" | null} */
  let lastInspectorOwner = null;
  /** @type {HTMLElement | null} */
  let shortcutHelpTrigger = null;
  const inspectorOwners = Object.freeze({
    map: features.map,
    qualityControl: features.qualityControl,
    temporal: features.temporal,
  });

  /** @param {PointerEvent} event */
  function noteInspectorOwner(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("#c-trace-plot, #c-heatmap-plot, .temporal-inspector")) {
      lastInspectorOwner = "temporal";
    } else if (target?.closest("#blueprint-stats-plot, .qc-histogram-inspector")) {
      lastInspectorOwner = "qualityControl";
    } else if (target?.closest("#map-plot, .map-neuron-preview")) {
      lastInspectorOwner = "map";
    }
  }

  function dismissPinnedInspector() {
    const owners = [
      lastInspectorOwner,
      "temporal",
      "qualityControl",
      "map",
    ].filter((owner, index, values) => owner && values.indexOf(owner) === index);
    for (const owner of owners) {
      const feature = inspectorOwners[owner];
      if (feature.hasPinnedInspector()) {
        feature.dismissPinnedInspector();
        if (lastInspectorOwner === owner) {
          lastInspectorOwner = null;
        }
        return true;
      }
    }
    return false;
  }

  function dismissAllPinnedInspectors() {
    for (const feature of Object.values(inspectorOwners)) {
      feature.dismissPinnedInspector();
    }
    lastInspectorOwner = null;
  }

  /** @param {string} title @param {Array<{ label: string, binding: string }>} rows */
  function appendHelpGroup(title, rows) {
    const container = documentRef.getElementById("shortcut-help-groups");
    if (!container) {
      return;
    }
    const section = documentRef.createElement("section");
    const heading = documentRef.createElement("h5");
    heading.className = "shortcut-help-group-title";
    heading.textContent = title;
    const list = documentRef.createElement("dl");
    list.className = "shortcut-help-list";
    for (const row of rows) {
      const label = documentRef.createElement("dt");
      label.textContent = row.label;
      const binding = documentRef.createElement("dd");
      binding.textContent = row.binding;
      list.append(label, binding);
    }
    section.append(heading, list);
    container.append(section);
  }

  function renderShortcutHelp() {
    const container = documentRef.getElementById("shortcut-help-groups");
    if (!container) {
      return false;
    }
    container.replaceChildren();
    const grouped = new Map();
    for (const entry of interactionCommands.helpEntries()) {
      if (!grouped.has(entry.group)) {
        grouped.set(entry.group, []);
      }
      grouped.get(entry.group).push({
        label: entry.label,
        binding: entry.bindingLabel,
      });
    }
    for (const [group, rows] of grouped) {
      appendHelpGroup(group, rows);
    }
    appendHelpGroup("Touch and Pointer", [
      { label: "Pan the neuron map", binding: "One-finger drag" },
      { label: "Zoom and pan the neuron map", binding: "Two-finger pinch" },
      { label: "Inspect a neuron", binding: "Tap neuron" },
      { label: "Select or deselect the inspected neuron", binding: "Double-tap the same neuron" },
      { label: "Activate an ROI", binding: "Tap ROI border" },
      { label: "Close a fixed Map inspector", binding: "Tap another Map target" },
      { label: "Add a Region vertex", binding: "Tap map while drawing" },
      { label: "Inspect Histogram or Heatmap", binding: "Tap plot" },
      { label: "Show a Trace deselect action", binding: "Tap trace" },
    ]);
    return true;
  }

  function closeShortcutHelp() {
    const dialog = /** @type {HTMLDialogElement | null} */ (
      documentRef.getElementById("shortcut-help-dialog")
    );
    if (!dialog?.open) {
      return false;
    }
    dialog.close();
    if (shortcutHelpTrigger?.isConnected) {
      shortcutHelpTrigger.focus();
    }
    shortcutHelpTrigger = null;
    return true;
  }

  /** @param {HTMLElement | null} trigger */
  function openShortcutHelp(trigger) {
    const dialog = /** @type {HTMLDialogElement | null} */ (
      documentRef.getElementById("shortcut-help-dialog")
    );
    if (!dialog) {
      return false;
    }
    shortcutHelpTrigger = trigger;
    renderShortcutHelp();
    if (!dialog.open) {
      dialog.showModal();
    }
    documentRef.getElementById("shortcut-help-close-btn")?.focus();
    return true;
  }

  function registerInteractionCommands() {
    const canUseMap = () => Boolean(getState().mapPlotReady);
    for (const entry of [
      {
        id: "native-activate",
        label: "Activate a focused button or section header",
        bindings: ["Enter", "Space"],
        bindingLabel: "Enter / Space",
      },
      {
        id: "native-picker",
        label: "Navigate and choose from an open picker",
        bindings: ["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Space", "Escape"],
        bindingLabel: "Arrow keys / Home / End / Enter / Space / Escape",
      },
      {
        id: "native-range",
        label: "Adjust a focused range endpoint",
        bindings: ["ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"],
        bindingLabel: "Arrow keys / Page Up or Down / Home / End",
      },
      {
        id: "native-dialog",
        label: "Move within or cancel a dialog",
        bindings: ["Tab", "Shift+Tab", "Escape"],
        bindingLabel: "Tab / Shift+Tab / Escape",
      },
    ]) {
      interactionCommands.register({
        ...entry,
        contexts: [],
        group: "Controls",
        execute: () => {},
      });
    }
    interactionCommands.register({
      id: "show-help",
      label: "Show keyboard and gesture help",
      contexts: ["global"],
      bindings: ["?"],
      group: "Global",
      execute: () => openShortcutHelp(documentRef.activeElement),
    });
    interactionCommands.register({
      id: "map-pan",
      label: "Pan map; hold Shift for a larger step",
      contexts: ["map"],
      bindings: [
        "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
        "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown",
      ],
      bindingLabel: "Arrow keys / Shift+Arrow keys",
      group: "Map",
      allowRepeat: true,
      canExecute: canUseMap,
      execute: (event) => {
        const step = event.shiftKey ? 120 : 40;
        const deltas = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        };
        features.map.panByScreen(...deltas[event.key]);
      },
    });
    interactionCommands.register({
      id: "map-zoom-in",
      label: "Zoom map in",
      contexts: ["map"],
      bindings: ["+"],
      group: "Map",
      canExecute: canUseMap,
      execute: features.map.zoomIn,
    });
    interactionCommands.register({
      id: "map-zoom-out",
      label: "Zoom map out",
      contexts: ["map"],
      bindings: ["-"],
      group: "Map",
      canExecute: canUseMap,
      execute: features.map.zoomOut,
    });
    interactionCommands.register({
      id: "map-fit",
      label: "Fit the full field of view",
      contexts: ["map"],
      bindings: ["0"],
      group: "Map",
      canExecute: canUseMap,
      execute: features.map.fitView,
    });
    interactionCommands.register({
      id: "region-finish",
      label: "Finish Region",
      contexts: ["regionDraw"],
      bindings: ["Enter"],
      group: "Region Drawing",
      execute: features.region.finishDrawing,
    });
    interactionCommands.register({
      id: "region-cancel",
      label: "Cancel Region",
      contexts: ["regionDraw"],
      bindings: ["Escape"],
      group: "Region Drawing",
      execute: features.region.cancelDrawing,
    });
    interactionCommands.register({
      id: "region-undo",
      label: "Undo the last Region vertex",
      contexts: ["regionDraw"],
      bindings: ["Backspace", "Control+z", "Meta+z"],
      bindingLabel: "Backspace / Ctrl or Cmd+Z",
      group: "Region Drawing",
      execute: features.region.undoVertex,
    });
    interactionCommands.register({
      id: "dismiss-inspector",
      label: "Close the fixed plot inspector",
      contexts: ["plotInspector"],
      bindings: ["Escape"],
      group: "Plot Inspection",
      execute: dismissPinnedInspector,
    });
  }

  function wireApplicationControls() {
    registerInteractionCommands();
    interactionCommands.decorateCommandElements(documentRef);
    const regionList = documentRef.getElementById("region-list");
    if (regionList && typeof windowRef.MutationObserver === "function") {
      const observer = new windowRef.MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node instanceof Element) {
              interactionCommands.decorateCommandElements(node);
            }
          }
        }
      });
      observer.observe(regionList, { childList: true, subtree: true });
    }
    interactionCommands.start();
    documentRef.addEventListener("pointerdown", noteInspectorOwner, true);

    documentRef.getElementById("shortcut-help-close-btn")
      ?.addEventListener("click", closeShortcutHelp);

    const helpDialog = /** @type {HTMLDialogElement | null} */ (
      documentRef.getElementById("shortcut-help-dialog")
    );
    helpDialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeShortcutHelp();
    });
    helpDialog?.addEventListener("click", (event) => {
      if (event.target !== helpDialog) {
        return;
      }
      const bounds = helpDialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left
        || event.clientX > bounds.right
        || event.clientY < bounds.top
        || event.clientY > bounds.bottom
      ) {
        closeShortcutHelp();
      }
    });
  }

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
      () => features.map.renderBackground(),
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
    dismissAllPinnedInspectors();
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
    wireApplicationControls();
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
      renderChrome: renderWorkflowChrome,
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
