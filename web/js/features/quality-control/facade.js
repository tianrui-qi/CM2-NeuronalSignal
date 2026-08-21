import * as model from "./model.js";
import { createQualityControlPanel } from "./panel.js";
import { createQualityControlHistogram } from "./histogram.js";


/**
 * Quality Control feature facade. Metric policy, QC-owned state changes, DOM,
 * Plotly rendering, and exact action ordering meet here. Region, ROI, Map, and
 * Temporal remain injected effects behind explicit feature boundaries.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     activateWorkflowSection: (section: string) => unknown,
 *     replaceQualityControlState: (nextState: Record<string, any>) => unknown,
 *     setActiveBlueprintMetric: (metricKey: string) => boolean,
 *     setBlueprintColorRange: (metricKey: string, range: { lower: number, upper: number }) => unknown,
 *     setQcRange: (metricKey: string, range: { lower: number | null, upper: number | null }) => unknown,
 *   },
 *   document: Document,
 *   renderScheduler: { scheduleDoubleFrame: (callback: () => void) => void },
 *   plotImage: {
 *     sanitizeFilenamePart: (value: unknown) => string,
 *     chooseImageSaveTarget: (suggestedName: string, format: string) => Promise<any>,
 *     clonePlotlyObject: (value: unknown) => any,
 *     getPlotExportSize: (plot: Cm2PlotElement) => { width: number, height: number },
 *     dataUrlToBlob: (dataUrl: string, format: string) => Blob,
 *     saveImageBlob: (blob: Blob, suggestedName: string, target?: any) => Promise<void>,
 *   },
 * }} dependencies
 */
export function createQualityControlFeature({
  store,
  commands,
  document,
  renderScheduler,
  plotImage,
}) {
  const panel = createQualityControlPanel({ document });
  const histogram = createQualityControlHistogram({ document, renderScheduler });
  /** @type {Record<string, any> | null} */
  let effects = null;
  /** @type {"color" | "threshold" | null} */
  let activeRangePreviewKind = null;
  /** @type {null | {
   *   kind: "color" | "threshold",
   *   metricKey: string,
   *   startRange: { lower: number | null, upper: number | null },
   *   previewRange: { lower: number | null, upper: number | null },
   * }} */
  let rangeInteraction = null;

  const getState = () => store.getSnapshot();

  function requireEffects() {
    if (!effects) {
      throw new Error("Quality Control effects were not installed before use.");
    }
    return effects;
  }

  /** @param {unknown} metricKey */
  function normalizeMetric(metricKey) {
    return model.normalizeBlueprintMetricKey(getState(), metricKey);
  }

  function availableSpecs() {
    return model.getAvailableBlueprintSpecs(getState());
  }

  /** @param {unknown} metricKey */
  function isAvailableMetric(metricKey) {
    return model.isAvailableBlueprintMetric(getState(), metricKey);
  }

  function activeSpec() {
    return model.getActiveBlueprintSpec(getState());
  }

  function renderedSpec() {
    return activeSpec();
  }

  /** @param {{ key: string }} spec */
  function buildMetricValues(spec) {
    return model.buildBlueprintMetricValues(getState(), spec);
  }

  function resolveCurrentReflowRange() {
    const spec = activeSpec();
    if (!spec) {
      return null;
    }
    const currentHistogram = buildMetricPresentation(spec).histogramData;
    return currentHistogram
      ? { viewMin: currentHistogram.viewMin, viewMax: currentHistogram.viewMax }
      : null;
  }

  /** @param {{ key: string }} spec */
  function buildMetricPresentation(spec) {
    const { values, extent } = buildMetricValues(spec);
    const interactionDomain = model.buildMetricFocusDomain(values, extent);
    const histogramData = model.buildHistogram(values, interactionDomain);
    return {
      values,
      extent,
      interactionDomain,
      histogramData,
    };
  }

  function activeFilters() {
    return model.getActiveQcFilters(getState());
  }

  /**
   * @param {number} pointIndex
   * @param {Array<{ values: number[], lower: number, upper: number }>} filters
   */
  function pointPassesMetricFilters(pointIndex, filters = activeFilters()) {
    return model.pointIndexPassesMetricFilters(pointIndex, filters);
  }

  /** @param {string} metricKey */
  function colorRange(metricKey) {
    return model.getBlueprintColorRange(getState(), metricKey);
  }

  /** @param {string} metricKey */
  function qcRange(metricKey) {
    return model.getQcRange(getState(), metricKey);
  }

  /**
   * @param {{ key: string }} spec
   * @param {{ lower: number | null, upper: number | null }} [range]
   * @param {number | null} [step]
   */
  function metricThresholdPresentation(
    spec,
    range = qcRange(spec.key),
    step = null,
  ) {
    if (!model.isQcRangeActive(range)) {
      return {
        thresholdSummary: "",
        thresholdDescription: "",
      };
    }
    const resolvedStep = Number.isFinite(step)
      ? /** @type {number} */ (step)
      : buildMetricPresentation(spec).interactionDomain.step;
    return {
      thresholdSummary: model.formatQcRangeSummary(range, resolvedStep),
      thresholdDescription: model.describeQcRange(range, resolvedStep),
    };
  }

  /**
   * Apply only the canonical QC-owned fields from the persisted UI-state
   * payload. An invalid active metric leaves the current selection unchanged.
   *
   * @param {Record<string, any>} parsed
   */
  function applyPersistedState(parsed) {
    const state = getState();
    const activeBlueprintMetric = isAvailableMetric(parsed.activeBlueprintMetric)
      ? parsed.activeBlueprintMetric
      : state.activeBlueprintMetric;
    return commands.replaceQualityControlState({
      activeBlueprintMetric,
      blueprintColorRanges: model.normalizeBlueprintColorRanges(
        state,
        parsed.blueprintColorRanges,
      ),
      qcRanges: model.normalizeQcRanges(state, parsed.qcRanges),
    });
  }

  function ensureValidMetric() {
    return commands.setActiveBlueprintMetric(
      normalizeMetric(getState().activeBlueprintMetric),
    );
  }

  function ensureValidRanges() {
    const state = getState();
    return commands.replaceQualityControlState({
      activeBlueprintMetric: state.activeBlueprintMetric,
      blueprintColorRanges: model.normalizeBlueprintColorRanges(
        state,
        state.blueprintColorRanges,
      ),
      qcRanges: model.normalizeQcRanges(state, state.qcRanges),
    });
  }

  function renderMetricControl() {
    const selectedValue = normalizeMetric(getState().activeBlueprintMetric);
    commands.setActiveBlueprintMetric(selectedValue);
    panel.renderMetricControl({
      selectedValue,
      items: [
        { key: model.BLUEPRINT_NONE, label: "None" },
        ...availableSpecs().map((spec) => ({
          ...spec,
          ...metricThresholdPresentation(spec),
        })),
      ],
      onSelect: selectMetric,
    });
  }

  function renderStats() {
    if (!histogram.getPlot()) {
      return;
    }
    const installed = requireEffects();
    const spec = activeSpec();
    if (!spec) {
      hideRangePreview();
      histogram.clear({
        plotly: installed.plotly,
        onDownloadEnabled: panel.setDownloadEnabled,
      });
      panel.renderControls({ enabled: false });
      panel.setEmpty(true);
      return;
    }

    const presentation = buildMetricPresentation(spec);
    const {
      values,
      extent,
      histogramData,
      interactionDomain,
    } = presentation;
    if (!histogramData) {
      hideRangePreview();
      histogram.clear({
        plotly: installed.plotly,
        onDownloadEnabled: panel.setDownloadEnabled,
      });
      panel.renderControls({ enabled: false });
      panel.setEmpty(true);
      return;
    }

    const currentColorRange = colorRange(spec.key);
    const currentQcRange = qcRange(spec.key);
    panel.setEmpty(false);
    panel.renderControls({
      enabled: true,
      colorRange: currentColorRange,
      qcRange: currentQcRange,
      domain: interactionDomain,
    });
    refreshRangePreview(
      activeRangePreviewKind,
      activeRangePreviewKind === "threshold" ? currentQcRange : currentColorRange,
      interactionDomain,
    );
    void histogram.render({
      plotly: installed.plotly,
      spec,
      values,
      extent,
      histogramData,
      colorRange: currentColorRange,
      resolveReflowRange: resolveCurrentReflowRange,
      onDownloadButtonsEnabled: panel.setDownloadButtonsEnabled,
      onDownloadEnabled: panel.setDownloadEnabled,
    });
  }

  /** @param {unknown} metricKey */
  function selectMetric(metricKey) {
    const installed = requireEffects();
    hideRangePreview();
    commands.setActiveBlueprintMetric(normalizeMetric(metricKey));
    commands.activateWorkflowSection("qc");
    ensureValidMetric();
    installed.persistUiState();
    installed.renderWorkflowChrome();
    renderMetricControl();
    renderStats();
    installed.renderMap();
  }

  /**
   * @param {"lower" | "upper"} changedHandle
   * @param {boolean} allowUnbounded
   */
  function rangeFromSliderInputs(changedHandle, allowUnbounded) {
    const spec = activeSpec();
    if (!spec) {
      return null;
    }
    const sliderValues = allowUnbounded
      ? panel.readQcSliderValues()
      : panel.readColorSliderValues();
    const presentation = buildMetricPresentation(spec);
    const domain = presentation.interactionDomain;
    const currentRange = rangeInteraction?.metricKey === spec.key
      && rangeInteraction.kind === (allowUnbounded ? "threshold" : "color")
      ? rangeInteraction.previewRange
      : allowUnbounded
        ? qcRange(spec.key)
        : colorRange(spec.key);
    const range = model.updateRawRangeFromSlider(
      currentRange,
      changedHandle,
      sliderValues[changedHandle],
      domain,
      { allowUnbounded },
    );
    return { spec, range, domain };
  }

  function refreshRangePreview(kind, range = null, domain = null) {
    if (!kind || activeRangePreviewKind !== kind) {
      return false;
    }
    const spec = activeSpec();
    if (!spec) {
      hideRangePreview();
      return false;
    }
    const resolvedDomain = domain ?? buildMetricPresentation(spec).interactionDomain;
    const resolvedRange = range ?? (
      kind === "threshold" ? qcRange(spec.key) : colorRange(spec.key)
    );
    return panel.showHistogramRangePreview({
      kind,
      range: resolvedRange,
      domain: resolvedDomain,
    });
  }

  /** @param {"color" | "threshold"} kind */
  function showRangePreview(kind) {
    activeRangePreviewKind = kind;
    refreshRangePreview(kind);
  }

  function hideRangePreview() {
    activeRangePreviewKind = null;
    panel.hideHistogramRangePreview();
  }

  /** @param {"color" | "threshold"} kind */
  function beginRangeInteraction(kind) {
    const spec = activeSpec();
    if (!spec) {
      return false;
    }
    const range = kind === "threshold" ? qcRange(spec.key) : colorRange(spec.key);
    rangeInteraction = {
      kind,
      metricKey: spec.key,
      startRange: { ...range },
      previewRange: { ...range },
    };
    showRangePreview(kind);
    return true;
  }

  /**
   * @param {"color" | "threshold"} kind
   * @param {{ canceled: boolean }} options
   */
  function finishRangeInteraction(kind, { canceled }) {
    const interaction = rangeInteraction;
    rangeInteraction = null;
    hideRangePreview();
    const spec = activeSpec();
    if (
      !interaction
      || !spec
      || interaction.kind !== kind
      || interaction.metricKey !== spec.key
    ) {
      return false;
    }
    const { startRange, previewRange } = interaction;
    const changed = (
      previewRange.lower !== startRange.lower
      || previewRange.upper !== startRange.upper
    );
    const domain = buildMetricPresentation(spec).interactionDomain;
    if (canceled || !changed) {
      if (kind === "threshold") {
        const storedRange = qcRange(spec.key);
        panel.renderQcRange({ range: storedRange, domain });
        panel.updateMetricThreshold({
          key: spec.key,
          ...metricThresholdPresentation(spec, storedRange, domain.step),
        });
      } else {
        panel.renderColorRange({ range: colorRange(spec.key), domain });
      }
      return false;
    }

    const installed = requireEffects();
    if (kind === "threshold") {
      commands.setQcRange(spec.key, previewRange);
    } else {
      commands.setBlueprintColorRange(spec.key, {
        lower: /** @type {number} */ (previewRange.lower),
        upper: /** @type {number} */ (previewRange.upper),
      });
    }
    installed.persistUiState();
    renderStats();
    if (kind === "threshold") {
      const storedRange = qcRange(spec.key);
      panel.updateMetricThreshold({
        key: spec.key,
        ...metricThresholdPresentation(spec, storedRange, domain.step),
      });
      installed.renderRoiWorkflowPanel();
      installed.renderRegionList();
      installed.updatePlots();
    }
    installed.renderMap();
    return true;
  }

  /** @param {"lower" | "upper"} changedHandle */
  function updateColorRange(changedHandle) {
    const next = rangeFromSliderInputs(changedHandle, false);
    if (!next || rangeInteraction?.kind !== "color") {
      return;
    }
    const previewRange = model.normalizeBlueprintColorRange(
      getState(),
      next.spec,
      next.range,
    );
    rangeInteraction.previewRange = { ...previewRange };
    panel.renderColorRange({ range: previewRange, domain: next.domain });
    refreshRangePreview(
      "color",
      previewRange,
      next.domain,
    );
  }

  /** @param {"lower" | "upper"} changedHandle */
  function updateQcRange(changedHandle) {
    const next = rangeFromSliderInputs(changedHandle, true);
    if (!next || rangeInteraction?.kind !== "threshold") {
      return;
    }
    const previewRange = model.normalizeQcRange(
      getState(),
      next.spec,
      next.range,
    );
    rangeInteraction.previewRange = { ...previewRange };
    refreshRangePreview("threshold", previewRange, next.domain);
    panel.renderQcRange({
      range: previewRange,
      domain: next.domain,
    });
    panel.updateMetricThreshold({
      key: next.spec.key,
      ...metricThresholdPresentation(next.spec, previewRange, next.domain.step),
    });
  }

  /** @param {"svg" | "png"} format */
  async function downloadPlot(format) {
    const installed = requireEffects();
    const plot = histogram.getPlot();
    if (!plot || !plot.data?.length || !activeSpec()) {
      const statusToken = installed.setStatus(
        "No quality-control histogram is available to download.",
        true,
      );
      globalThis.setTimeout(() => installed.clearStatus(statusToken), 1800);
      return;
    }

    const button = document.getElementById(`download-qc-${format}-btn`);
    const filename = `cm2-neuronalsignal-qc-${plotImage.sanitizeFilenamePart(
      getState().activeBlueprintMetric,
    )}.${format}`;
    button?.setAttribute("aria-busy", "true");
    button?.setAttribute("disabled", "true");
    try {
      const saveTarget = await plotImage.chooseImageSaveTarget(filename, format);
      if (saveTarget?.aborted) {
        return;
      }
      const dataUrl = await histogram.exportImage({
        plotly: installed.plotly,
        plot,
        format,
        clonePlotlyObject: plotImage.clonePlotlyObject,
        getPlotExportSize: plotImage.getPlotExportSize,
        rangeLabels: panel.getExportRangeLabels(),
      });
      await plotImage.saveImageBlob(
        plotImage.dataUrlToBlob(dataUrl, format),
        filename,
        saveTarget,
      );
    } catch (error) {
      console.error(error);
      const caught = /** @type {any} */ (error);
      const statusToken = installed.setStatus(
        caught?.message ?? `Failed to download ${format.toUpperCase()}.`,
        true,
      );
      globalThis.setTimeout(() => installed.clearStatus(statusToken), 2400);
    } finally {
      button?.removeAttribute("aria-busy");
      panel.setDownloadEnabled(Boolean(plot.data?.length));
    }
  }

  /**
   * Install the application effect ports and wire the existing DOM once.
   * Repeated calls update effect implementations but do not duplicate listeners.
   *
   * @param {Record<string, any>} nextEffects
   */
  function wire(nextEffects) {
    effects = nextEffects;
    return panel.wire({
      onColorInput: updateColorRange,
      onQcInput: updateQcRange,
      onRangeInteractionStart: beginRangeInteraction,
      onRangeInteractionEnd: finishRangeInteraction,
      onDownload: (format) => {
        void downloadPlot(format);
      },
    });
  }

  return {
    colorScale: model.BLUEPRINT_COLOR_SCALE,
    activeFilters,
    applyPersistedState,
    buildMetricValues,
    colorRange,
    ensureValidMetric,
    ensureValidRanges,
    hasPinnedInspector: histogram.hasPinnedInspector,
    dismissPinnedInspector: histogram.dismissPinnedInspector,
    pointPassesMetricFilters,
    renderedSpec,
    renderMetricControl,
    renderStats,
    wire,
  };
}
