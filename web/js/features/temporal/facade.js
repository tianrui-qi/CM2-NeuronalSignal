import * as model from "./model.js";
import { createTemporalHeatmap } from "./heatmap.js";
import { createTemporalPanel } from "./panel.js";
import { createTemporalTracePlot } from "./trace-plot.js";


export const TEMPORAL_PLOT_DOWNLOADS = Object.freeze({
  heatmap: Object.freeze({
    key: "heatmap",
    plotId: "c-heatmap-plot",
    buttons: Object.freeze({
      svg: "download-heatmap-svg-btn",
      png: "download-heatmap-png-btn",
    }),
    filenamePrefix: "cm2-heatmap",
    exportStyle: "paper-heatmap",
  }),
  trace: Object.freeze({
    key: "trace",
    plotId: "c-trace-plot",
    buttons: Object.freeze({
      svg: "download-trace-svg-btn",
      png: "download-trace-png-btn",
    }),
    filenamePrefix: "cm2-trace",
    exportStyle: "paper-trace",
  }),
});


/**
 * Temporal feature facade. Scientific transforms live in model.js; the two
 * Plotly views and control panel own only their DOM. This facade is the single
 * owner of Temporal state changes, ROI/QC membership, persistence ordering,
 * denominator memoization, and cross-feature orchestration.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     replaceTemporalPersistedState: (nextState: Record<string, any>) => unknown,
 *     setActiveSignalSource: (sourceKey: string) => unknown,
 *     setActiveTraceValueMode: (valueMode: string) => unknown,
 *     setTraceDfSpacingRaw: (spacingRaw: number) => unknown,
 *     setTraceDfPixelsPerKiloRaw: (pixelsPerKiloRaw: number) => unknown,
 *     setTraceDffSpacingPercent: (spacingPercent: number) => unknown,
 *     setTraceDffPixelsPerPercent: (pixelsPerPercent: number) => unknown,
 *     setHeatmapRangeForSource: (sourceKey: string, range: { min?: number, max?: number }) => unknown,
 *     setDffDenominator: (cacheKey: string, denominator: number) => unknown,
 *     setTraceHoverNeuronId: (neuronId: number | null) => boolean,
 *   },
 *   document: Document,
 *   window: Window,
 *   plotImage: {
 *     sanitizeFilenamePart: (value: unknown) => string,
 *     chooseImageSaveTarget: (suggestedName: string, format: string) => Promise<any>,
 *     clonePlotlyObject: (value: unknown) => any,
 *     getPlotExportSize: (plot: Cm2PlotElement) => { width: number, height: number },
 *     dataUrlToBlob: (dataUrl: string, format: string) => Blob,
 *     saveImageBlob: (blob: Blob, suggestedName: string, target?: any) => Promise<void>,
 *   },
 *   qualityControl: {
 *     activeFilters: () => any[],
 *     pointPassesMetricFilters: (pointIndex: number, filters?: any[]) => boolean,
 *   },
 *   region: { pointPasses: (pointIndex: number) => boolean },
 *   roi: {
 *     getById: (roiId: string | null) => any | null,
 *     pointIndexInBox: (pointIndex: number, roi: any) => boolean,
 *     neuronPassesSelection: (neuronId: number, roi: any, filters?: any[]) => boolean,
   *     deselectNeuronFromActive: (neuronId: number) => boolean,
 *   },
 * }} dependencies
 */
export function createTemporalFeature({
  store,
  commands,
  document,
  window,
  plotImage,
  qualityControl,
  region,
  roi,
}) {
  const panel = createTemporalPanel({ document });
  const tracePlot = createTemporalTracePlot({ document, window });
  /** @type {ReturnType<typeof createTemporalHeatmap> | null} */
  let heatmap = null;
  /** @type {null | {
   *   plotly: any,
   *   persistUiState: () => void,
   *   refreshRoiViews: (options?: { includePlots?: boolean }) => void,
   *   refreshMapHoverPreview: () => unknown,
   *   renderMap: () => void,
   *   setStatus: (message: string, isError?: boolean) => void,
   * }} */
  let effects = null;

  const getState = () => store.getSnapshot();

  function requireEffects() {
    if (!effects) {
      throw new Error("Temporal effects were not installed before use.");
    }
    return effects;
  }

  /** @param {number} neuronId */
  function pointIndexForNeuronId(neuronId) {
    return getState().pointIndexByNeuronId?.get(neuronId) ?? null;
  }

  /**
   * Preserve the cross-render denominator cache. The model computes the
   * scientific value; the facade owns the only state write through a command.
   *
   * @param {string} sourceKey
   * @param {number} neuronId
   */
  function getDffDenominator(sourceKey, neuronId) {
    const projectionSourceKey = model.TRACE_VIRTUAL_SOURCES[sourceKey]
      ?.dffProjectionSource;
    if (!projectionSourceKey) {
      return NaN;
    }
    const cacheKey = `${projectionSourceKey}:${neuronId}`;
    const state = getState();
    if (state.dffDenominatorCache.has(cacheKey)) {
      return state.dffDenominatorCache.get(cacheKey);
    }
    const denominator = model.getDffDenominator(state, sourceKey, neuronId);
    commands.setDffDenominator(cacheKey, denominator);
    return denominator;
  }

  const modelDependencies = {
    pointIndexForNeuronId,
    getDffDenominator,
  };

  function activeRoi() {
    return roi.getById(getState().activeRoiId);
  }

  /** @param {number} pointIndex @param {any[]} filters */
  function pointPassesEligibility(pointIndex, filters) {
    return region.pointPasses(pointIndex)
      && qualityControl.pointPassesMetricFilters(pointIndex, filters);
  }

  function membershipDependencies() {
    return {
      ...modelDependencies,
      pointPassesEligibility,
      pointIndexInBox: roi.pointIndexInBox,
      neuronPassesSelection: roi.neuronPassesSelection,
    };
  }

  /**
   * Return the exact one-neuron scientific descriptor used by Temporal:
   * Trace. Map owns the hover surface; no hover-only state or transform is
   * introduced here.
   *
   * @param {number} neuronId
   */
  function describeNeuronTrace(neuronId) {
    const state = getState();
    if (pointIndexForNeuronId(neuronId) === null) {
      return null;
    }
    const sourceKey = model.getEffectiveTraceSourceKey(
      state.activeSignalSource,
      state.activeTraceValueMode,
    );
    if (!model.isTraceSourceAvailable(state, sourceKey)) {
      return null;
    }
    const descriptor = model.buildTracePlotData(
      state,
      sourceKey,
      [neuronId],
      {
        ...modelDependencies,
        // The analytical Map preview always labels the common 5% ΔF/F
        // reference, even though row spacing is irrelevant for one trace.
        forceDffThresholdGuide: true,
      },
    );
    if (descriptor.neuronCount !== 1) {
      return null;
    }
    return {
      ...descriptor,
      pixelsPerUnit: model.getTracePixelsPerDisplayUnit(state, sourceKey),
    };
  }

  /** @param {Record<string, any>} payload */
  function applyPersistedState(payload) {
    const nextState = model.normalizePersistedTemporalState(getState(), payload);
    commands.replaceTemporalPersistedState(nextState);
    return nextState;
  }

  /**
   * @param {{ includeValueMode?: boolean }} [options]
   */
  function ensureValidState({ includeValueMode = true } = {}) {
    let changed = false;
    let state = getState();
    const sourceKey = model.normalizeActiveTraceSource(
      state,
      state.activeSignalSource,
    );
    if (sourceKey !== state.activeSignalSource) {
      commands.setActiveSignalSource(/** @type {string} */ (sourceKey));
      changed = true;
      state = getState();
    }
    if (includeValueMode) {
      const valueMode = model.normalizeActiveTraceValueMode(
        state,
        state.activeTraceValueMode,
        state.activeSignalSource,
      );
      if (valueMode !== state.activeTraceValueMode) {
        commands.setActiveTraceValueMode(/** @type {string} */ (valueMode));
        changed = true;
      }
    }
    return changed;
  }

  /** @param {number | null} neuronId */
  function setHoverNeuronId(neuronId) {
    if (commands.setTraceHoverNeuronId(neuronId)) {
      requireEffects().renderMap();
    }
  }

  /** @param {number} neuronId */
  function deselectNeuron(neuronId) {
    if (!Number.isFinite(neuronId)) {
      return;
    }
    const selectedRoi = activeRoi();
    if (!selectedRoi || !selectedRoi.neuronIds.includes(neuronId)) {
      tracePlot.hideDeselectButton();
      return;
    }
    roi.deselectNeuronFromActive(neuronId);
    tracePlot.hideDeselectButton({ clearHover: false });
    commands.setTraceHoverNeuronId(null);
    requireEffects().refreshRoiViews({ includePlots: true });
  }

  function selectedNeuronIds() {
    const state = getState();
    const selectedRoi = activeRoi();
    const filters = qualityControl.activeFilters();
    return model.getSelectedTraceNeuronIds(
      state,
      selectedRoi,
      filters,
      membershipDependencies(),
    );
  }

  /** @param {string} sourceKey */
  function renderTrace(sourceKey) {
    return tracePlot.render({
      plotly: requireEffects().plotly,
      state: getState(),
      sourceKey,
      neuronIds: selectedNeuronIds(),
      modelDependencies,
      onDownloadEnabled: (enabled) => (
        panel.setDownloadEnabled(TEMPORAL_PLOT_DOWNLOADS.trace, enabled)
      ),
    });
  }

  /** @param {string} sourceKey */
  function renderHeatmap(sourceKey) {
    if (!heatmap) {
      return null;
    }
    const state = getState();
    const filters = qualityControl.activeFilters();
    const dependencies = membershipDependencies();
    const selectedRoi = activeRoi();
    const neuronIds = model.getHeatmapNeuronIds(
      state,
      selectedRoi,
      filters,
      dependencies,
    );
    const domainNeuronIds = model.getAllHeatmapNeuronIds(
      state,
      filters,
      dependencies,
    );
    return heatmap.render({
      state,
      sourceKey,
      neuronIds,
      domainNeuronIds,
      modelDependencies,
    });
  }

  /** @param {string} sourceKey */
  function renderScaleControls(sourceKey) {
    const state = getState();
    const isDff = model.isDynamicDffSource(sourceKey);
    const spacing = isDff
      ? {
          value: model.getTraceDffSpacingPercent(state),
          min: model.TRACE_DFF_SPACING_PERCENT_MIN,
          max: model.TRACE_DFF_SPACING_PERCENT_MAX,
          step: model.TRACE_DFF_SPACING_PERCENT_STEP,
          normalize: model.normalizeTraceDffSpacingPercent,
          valueLabel: (value) => `${panel.formatTraceControlNumber(value)} %`,
          description: "Set the vertical gap between traces in ΔF/F (%)",
        }
      : {
          value: model.getTraceDfSpacingRaw(state),
          min: model.TRACE_DF_SPACING_RAW_MIN,
          max: model.TRACE_DF_SPACING_RAW_MAX,
          step: model.TRACE_DF_SPACING_RAW_STEP,
          normalize: model.normalizeTraceDfSpacingRaw,
          valueLabel: (value) => panel.formatTraceControlNumber(value),
          description: "Set the vertical gap between traces in ΔF units",
        };
    const scale = isDff
      ? {
          value: model.getTraceDffPixelsPerPercent(state),
          min: model.TRACE_DFF_PIXELS_PER_PERCENT_MIN,
          max: model.TRACE_DFF_PIXELS_PER_PERCENT_MAX,
          step: model.TRACE_DFF_PIXELS_PER_PERCENT_STEP,
          normalize: model.normalizeTraceDffPixelsPerPercent,
          valueLabel: (value) => `${panel.formatTraceControlNumber(value)} px/%`,
          description: "Set the vertical scale in pixels per 1 % ΔF/F",
        }
      : {
          value: model.getTraceDfPixelsPerKiloRaw(state),
          min: model.TRACE_DF_PIXELS_PER_KILO_RAW_MIN,
          max: model.TRACE_DF_PIXELS_PER_KILO_RAW_MAX,
          step: model.TRACE_DF_PIXELS_PER_KILO_RAW_STEP,
          normalize: model.normalizeTraceDfPixelsPerKiloRaw,
          valueLabel: (value) => `${panel.formatTraceControlNumber(value)} px/1000`,
          description: "Set the vertical scale in pixels per 1,000 ΔF",
        };
    panel.renderScaleControls({
      visible: true,
      spacingValue: spacing.value,
      scaleValue: scale.value,
      spacing,
      scale,
      onSpacingInput(nextValue) {
        if (isDff) {
          commands.setTraceDffSpacingPercent(nextValue);
        } else {
          commands.setTraceDfSpacingRaw(nextValue);
        }
        requireEffects().persistUiState();
        renderTrace(sourceKey);
        requireEffects().refreshMapHoverPreview();
      },
      onScaleInput(nextValue) {
        if (isDff) {
          commands.setTraceDffPixelsPerPercent(nextValue);
        } else {
          commands.setTraceDfPixelsPerKiloRaw(nextValue);
        }
        requireEffects().persistUiState();
        renderTrace(sourceKey);
        requireEffects().refreshMapHoverPreview();
      },
    });
  }

  /** @param {any} spec @param {string} format */
  async function downloadPlot(spec, format) {
    const installed = requireEffects();
    const plot = /** @type {Cm2PlotElement | null} */ (
      document.getElementById(spec.plotId)
    );
    if (!plot || !plot.data?.length) {
      installed.setStatus("No plot is available to download.", true);
      window.setTimeout(() => installed.setStatus(""), 1800);
      return;
    }
    const button = document.getElementById(spec.buttons?.[format]);
    button?.setAttribute("aria-busy", "true");
    button?.setAttribute("disabled", "true");
    const state = getState();
    const filename = `${spec.filenamePrefix}-${plotImage.sanitizeFilenamePart(
      state.activeSignalSource,
    )}-${plotImage.sanitizeFilenamePart(state.activeTraceValueMode)}.${format}`;
    try {
      const saveTarget = await plotImage.chooseImageSaveTarget(filename, format);
      if (saveTarget?.aborted) {
        return;
      }
      const { width, height } = plotImage.getPlotExportSize(plot);
      let dataUrl;
      if (spec.exportStyle === "paper-trace") {
        dataUrl = await tracePlot.exportImage({
          plotly: installed.plotly,
          plot,
          width,
          height,
          format,
          clonePlotlyObject: plotImage.clonePlotlyObject,
        });
      } else if (spec.exportStyle === "paper-heatmap") {
        if (!heatmap) {
          throw new Error("Heatmap export is unavailable.");
        }
        dataUrl = await heatmap.exportImage({
          plotly: installed.plotly,
          plot,
          sourceKey: model.getEffectiveTraceSourceKey(
            state.activeSignalSource,
            state.activeTraceValueMode,
          ),
          width,
          height,
          format,
          clonePlotlyObject: plotImage.clonePlotlyObject,
        });
      } else {
        dataUrl = await installed.plotly.toImage(plot, { format, width, height });
      }
      await plotImage.saveImageBlob(
        plotImage.dataUrlToBlob(dataUrl, format),
        filename,
        saveTarget,
      );
    } catch (error) {
      console.error(error);
      const caught = /** @type {any} */ (error);
      installed.setStatus(
        caught?.message ?? `Failed to download ${format.toUpperCase()}.`,
        true,
      );
      window.setTimeout(() => installed.setStatus(""), 2400);
    } finally {
      button?.removeAttribute("aria-busy");
      panel.setDownloadEnabled(spec, Boolean(plot.data?.length));
    }
  }

  function render() {
    requireEffects();
    panel.wireDownloadButtons(TEMPORAL_PLOT_DOWNLOADS, downloadPlot);
    ensureValidState();
    const state = getState();
    const handleSourceSelect = (sourceKey) => {
      commands.setActiveSignalSource(sourceKey);
      const nextState = getState();
      const valueMode = model.normalizeActiveTraceValueMode(
        nextState,
        nextState.activeTraceValueMode,
        nextState.activeSignalSource,
      );
      if (valueMode !== nextState.activeTraceValueMode) {
        commands.setActiveTraceValueMode(/** @type {string} */ (valueMode));
      }
      requireEffects().persistUiState();
      render();
      requireEffects().refreshMapHoverPreview();
    };
    const handleValueModeSelect = (valueMode) => {
      commands.setActiveTraceValueMode(valueMode);
      requireEffects().persistUiState();
      render();
      requireEffects().refreshMapHoverPreview();
    };
    panel.renderSourceValueControls({
      sourceKeys: model.getAvailableTraceSourceKeys(state),
      sourceLabels: model.TRACE_SOURCE_UI_LABELS,
      activeSourceKey: state.activeSignalSource,
      valueModes: model.getAvailableTraceValueModes(
        state,
        state.activeSignalSource,
      ),
      valueModeLabels: model.TRACE_VALUE_MODE_UI_LABELS,
      activeValueMode: state.activeTraceValueMode,
      onSourceSelect: handleSourceSelect,
      onValueModeSelect: handleValueModeSelect,
    });

    const effectiveSourceKey = model.getEffectiveTraceSourceKey(
      state.activeSignalSource,
      state.activeTraceValueMode,
    );
    if (model.isTraceSourceAvailable(state, effectiveSourceKey)) {
      if (state.openSections.temporalHeatmap) {
        renderHeatmap(effectiveSourceKey);
      }
      if (state.openSections.temporalTrace) {
        renderScaleControls(effectiveSourceKey);
        renderTrace(effectiveSourceKey);
      } else {
        tracePlot.hideDeselectButton();
      }
    }
  }

  /**
   * Install the application orchestration ports. Repeated calls replace
   * implementations but do not duplicate DOM or Plotly listeners.
   *
   * @param {{
   *   plotly: any,
   *   persistUiState: () => void,
   *   refreshRoiViews: (options?: { includePlots?: boolean }) => void,
   *   refreshMapHoverPreview: () => unknown,
   *   renderMap: () => void,
   *   setStatus: (message: string, isError?: boolean) => void,
   * }} nextEffects
   */
  function wire(nextEffects) {
    effects = nextEffects;
    tracePlot.wire({ deselectNeuron, setHoverNeuronId });
    if (!heatmap) {
      heatmap = createTemporalHeatmap({
        document,
        // Keep the view instance/listeners stable while repeated application
        // wiring replaces the current Plotly implementation.
        plotly: {
          purge(...args) {
            return requireEffects().plotly.purge(...args);
          },
          react(...args) {
            return requireEffects().plotly.react(...args);
          },
          restyle(...args) {
            return requireEffects().plotly.restyle(...args);
          },
        },
        setDownloadEnabled: (enabled) => (
          panel.setDownloadEnabled(TEMPORAL_PLOT_DOWNLOADS.heatmap, enabled)
        ),
        onRangeChange(sourceKey, range) {
          commands.setHeatmapRangeForSource(String(sourceKey), range);
          requireEffects().persistUiState();
        },
      });
    }
    return true;
  }

  return Object.freeze({
    applyPersistedState,
    describeNeuronTrace,
    ensureValidState,
    render,
    wire,
  });
}
