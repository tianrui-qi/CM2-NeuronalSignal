import {
  buildHeatmapColorDomain,
  buildHeatmapData,
  computeHeatmapRangeUpdate,
  formatHeatmapColorbarValue,
  getHeatmapRangeForSource,
  getHeatmapSliderSpec,
  heatmapSliderValueToValue,
  heatmapValueToSliderValue,
} from "./model.js";
import { wireDualRangeController } from "../../shared/ui/dual-range-controller.js";
import { wireConfirmedBlankTap } from "../../shared/ui/confirmed-tap.js";


export const HEATMAP_PLOT_MARGIN = Object.freeze({ l: 0, r: 0, t: 0, b: 0 });
const HEATMAP_EXPORT_MIN_WIDTH_PX = 320;
const HEATMAP_EXPORT_MIN_HEIGHT_PX = 240;
const HEATMAP_EXPORT_COLORBAR_HEIGHT_PX = 110;
const HEATMAP_EXPORT_SIDE_MARGIN_PX = 40;
export const HEATMAP_MAGMA_COLORSCALE = Object.freeze([
  Object.freeze([0, "#000004"]),
  Object.freeze([0.25, "#51127c"]),
  Object.freeze([0.5, "#b63679"]),
  Object.freeze([0.75, "#fb8861"]),
  Object.freeze([1, "#fcfdbf"]),
]);


function buildMutableMagmaColorscale() {
  return HEATMAP_MAGMA_COLORSCALE.map(([position, color]) => [position, color]);
}


/** @param {number} value */
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}


/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


/** @param {number} value */
function cssPercent(value) {
  return `${Number(value).toFixed(3).replace(/\.?0+$/, "")}%`;
}


/**
 * @param {number} minPercent
 * @param {number} maxPercent
 */
export function buildHeatmapColorbarGradient(minPercent, maxPercent) {
  const colorscale = HEATMAP_MAGMA_COLORSCALE;
  const firstColor = colorscale[0][1];
  const lastColor = colorscale[colorscale.length - 1][1];
  const low = clamp(minPercent, 0, 100);
  const high = clamp(maxPercent, low + 0.001, 100);
  const span = high - low;
  const stops = [
    `${firstColor} 0%`,
    `${firstColor} ${cssPercent(low)}`,
  ];
  for (const [position, color] of colorscale) {
    stops.push(`${color} ${cssPercent(low + clamp01(position) * span)}`);
  }
  stops.push(`${lastColor} ${cssPercent(high)}`);
  stops.push(`${lastColor} 100%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}


/**
 * Build the current Plotly descriptor without touching DOM or state.
 * `domainNeuronIds` must be the all-ROI Heatmap union supplied by the facade.
 *
 * @param {{
 *   state: Record<string, any>,
 *   sourceKey: string,
 *   neuronIds: readonly number[],
 *   domainNeuronIds: readonly number[],
 *   modelDependencies?: {
 *     pointIndexForNeuronId?: (neuronId: number) => number | null,
 *     getDffDenominator?: (sourceKey: string, neuronId: number) => number,
 *   },
 *   pointIndexForNeuronId?: (neuronId: number) => number | null,
 * }} options
 */
export function buildHeatmapPlotDescriptor({
  state,
  sourceKey,
  neuronIds,
  domainNeuronIds,
  modelDependencies = {},
  pointIndexForNeuronId,
}) {
  const model = buildHeatmapData(
    state,
    sourceKey,
    neuronIds,
    domainNeuronIds,
    {
      ...modelDependencies,
      ...(pointIndexForNeuronId ? { pointIndexForNeuronId } : {}),
    },
  );
  const { x, z, shapes, height, zMin, zMax } = model;
  if (z.length === 0 || !Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    return {
      ...model,
      empty: true,
      plotHeight: null,
      colorDomain: null,
      colorRange: null,
      data: [],
      layout: null,
      config: null,
    };
  }

  const colorDomain = buildHeatmapColorDomain(sourceKey, zMin, zMax);
  const colorRange = getHeatmapRangeForSource(
    state,
    sourceKey,
    colorDomain.minValue,
    colorDomain.maxValue,
  );
  const plotHeight = Math.max(1, Math.ceil(height));
  return {
    ...model,
    empty: false,
    plotHeight,
    colorDomain,
    colorRange,
    data: [{
      type: "heatmap",
      x,
      z,
      // Plotly normalizes colorscale pairs in place, so keep the canonical
      // fixed Magma definition immutable and pass a fresh mutable copy.
      colorscale: buildMutableMagmaColorscale(),
      zmin: colorRange.min,
      zmax: colorRange.max,
      showscale: false,
      hovertemplate: "Frame %{x}<br>value=%{z:.2f}<extra></extra>",
    }],
    layout: {
      margin: HEATMAP_PLOT_MARGIN,
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      xaxis: {
        visible: false,
        range: [0, Math.max(state.meta.trace_length - 1, 1)],
        fixedrange: true,
      },
      yaxis: { visible: false, autorange: "reversed", fixedrange: true },
      dragmode: false,
      shapes,
      height: plotHeight,
    },
    config: {
      responsive: false,
      displaylogo: false,
      displayModeBar: false,
      doubleClick: false,
      scrollZoom: false,
    },
  };
}


/** @param {Cm2PlotElement} plot */
function getHeatmapExportMapping(plot) {
  const trace = (plot.data ?? []).find((candidate) => candidate?.type === "heatmap");
  const min = Number(trace?.zmin);
  const max = Number(trace?.zmax);
  if (!trace || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    throw new Error("Heatmap color mapping is unavailable for export.");
  }
  if (trace.colorscale == null) {
    throw new Error("Heatmap colormap is unavailable for export.");
  }
  return { min, max, colorscale: trace.colorscale };
}


/**
 * Add a horizontal colorbar whose scale is the exact colorscale/z-range
 * currently applied to the on-screen Heatmap.
 *
 * @param {Cm2PlotElement} plot
 * @param {(value: unknown) => any} clonePlotlyObject
 */
export function buildHeatmapExportData(plot, clonePlotlyObject) {
  const mapping = getHeatmapExportMapping(plot);
  // Preserve the potentially multi-million-value x/z arrays by reference.
  // JSON cloning would multiply export memory and convert NaN samples to null.
  const data = (plot.data ?? []).map((trace) => ({
    ...trace,
    colorscale: trace?.colorscale == null
      ? trace?.colorscale
      : clonePlotlyObject(trace.colorscale),
    ...(trace?.type === "heatmap" ? { zauto: false, showscale: false } : {}),
  }));
  const stripX = Array.from({ length: 128 }, (_, index) => index / 127);
  const stripZ = stripX.map(
    (fraction) => mapping.min + fraction * (mapping.max - mapping.min),
  );
  data.push({
    type: "heatmap",
    x: stripX,
    y: [0],
    z: [stripZ],
    xaxis: "x2",
    yaxis: "y2",
    zmin: mapping.min,
    zmax: mapping.max,
    zauto: false,
    colorscale: clonePlotlyObject(mapping.colorscale),
    showscale: false,
    hoverinfo: "skip",
  });
  return data;
}


/**
 * @param {Cm2PlotElement} plot
 * @param {string} sourceKey
 * @param {number} width
 * @param {number} height
 * @param {(value: unknown) => any} clonePlotlyObject
 */
export function buildHeatmapExportLayout(
  plot,
  sourceKey,
  width,
  height,
  clonePlotlyObject,
) {
  const mapping = getHeatmapExportMapping(plot);
  const layout = clonePlotlyObject(plot.layout ?? {});
  layout.width = width;
  layout.height = height;
  layout.margin = {
    l: HEATMAP_EXPORT_SIDE_MARGIN_PX,
    r: HEATMAP_EXPORT_SIDE_MARGIN_PX,
    t: 0,
    b: 52,
  };
  layout.paper_bgcolor = "rgb(255, 255, 255)";
  layout.plot_bgcolor = "rgb(255, 255, 255)";
  layout.font = {
    ...(layout.font ?? {}),
    color: "rgb(32, 30, 27)",
  };
  layout.xaxis = {
    ...(layout.xaxis ?? {}),
    domain: [0, 1],
    anchor: "y",
  };
  layout.yaxis = {
    ...(layout.yaxis ?? {}),
    domain: [0.25, 1],
    anchor: "x",
  };
  layout.xaxis2 = {
    domain: [0, 1],
    anchor: "y2",
    range: [0, 1],
    fixedrange: true,
    showgrid: false,
    zeroline: false,
    ticks: "outside",
    tickmode: "array",
    tickvals: [0, 1],
    ticktext: [
      formatHeatmapColorbarValue(sourceKey, mapping.min),
      formatHeatmapColorbarValue(sourceKey, mapping.max),
    ],
    tickfont: { color: "rgb(32, 30, 27)", size: 11 },
  };
  layout.yaxis2 = {
    domain: [0.04, 0.095],
    anchor: "x2",
    fixedrange: true,
    visible: false,
  };
  return layout;
}


/**
 * Heatmap DOM and Plotly boundary. All state writes, persistence, downloads,
 * ROI/QC membership, and store access are supplied as explicit ports.
 *
 * @param {{
 *   document: Document,
 *   plotly: {
 *     purge: (plot: HTMLElement) => unknown,
 *     react: (plot: HTMLElement, data: any[], layout: any, config: any) => unknown,
 *     restyle: (plot: HTMLElement, update: Record<string, any>) => unknown,
 *   },
 *   setDownloadEnabled?: (enabled: boolean) => void,
 *   onRangeCommit?: (sourceKey: string, range: { min: number, max: number }) => void,
 *   onInspectorPinned?: () => unknown,
 * }} dependencies
 */
export function createTemporalHeatmap({
  document,
  plotly,
  setDownloadEnabled = () => {},
  onRangeCommit = () => {},
  onInspectorPinned = () => {},
}) {
  let renderRevision = 0;
  let colorbarController = null;

  function getTapInspector() {
    const panel = document.querySelector(".heatmap-plot-panel");
    if (!panel) {
      return null;
    }
    let inspector = /** @type {HTMLElement | null} */ (
      panel.querySelector(".heatmap-tap-inspector")
    );
    if (!inspector) {
      inspector = document.createElement("div");
      inspector.className = "heatmap-tap-inspector temporal-inspector hidden";
      inspector.setAttribute("role", "status");
      inspector.setAttribute("aria-live", "polite");
      panel.appendChild(inspector);
    }
    return inspector;
  }

  function hideTapInspector() {
    const inspector = document.querySelector(".heatmap-tap-inspector");
    const wasVisible = Boolean(inspector && !inspector.classList.contains("hidden"));
    inspector?.classList.add("hidden");
    if (inspector) {
      inspector.textContent = "";
    }
    return wasVisible;
  }

  document.querySelector(".heatmap-plot-panel")?.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("#c-heatmap-plot, button, input, [role='button']")) {
        hideTapInspector();
      }
    },
  );

  /** @param {Cm2PlotElement} plot */
  function detachTapInspector(plot) {
    if (plot.__cm2HeatmapTapHandler && typeof plot.removeListener === "function") {
      plot.removeListener("plotly_click", plot.__cm2HeatmapTapHandler);
    }
    plot.__cm2HeatmapTapSession?.destroy();
    delete plot.__cm2HeatmapTapHandler;
    delete plot.__cm2HeatmapTapSession;
  }

  /**
   * @param {Cm2PlotElement} plot
   * @param {string} sourceKey
   * @param {readonly number[]} neuronIds
   */
  function attachTapInspector(plot, sourceKey, neuronIds) {
    detachTapInspector(plot);
    plot.__cm2HeatmapTapHandler = (event) => {
      plot.__cm2HeatmapTapSession?.claim();
      const point = event?.points?.[0];
      const rowIndex = Number(point?.pointNumber?.[0] ?? point?.y);
      const neuronId = neuronIds[Math.round(rowIndex)];
      const frame = Number(point?.x);
      const value = Number(point?.z);
      const inspector = getTapInspector();
      if (
        !inspector
        || !Number.isFinite(neuronId)
        || !Number.isFinite(frame)
        || !Number.isFinite(value)
      ) {
        hideTapInspector();
        return;
      }
      inspector.textContent = (
        `Neuron ${neuronId}; frame ${Math.round(frame)}; value `
        + formatHeatmapColorbarValue(sourceKey, value)
      );
      inspector.classList.remove("hidden");
      onInspectorPinned();
    };
    plot.__cm2HeatmapTapSession = wireConfirmedBlankTap({
      element: plot,
      onBlankTap: hideTapInspector,
    });
    plot.on("plotly_click", plot.__cm2HeatmapTapHandler);
  }

  /** @param {string} tag @param {string} className */
  function createElement(tag, className = "") {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  }

  /**
   * @param {HTMLElement} colorbar
   * @param {string} sourceKey
   * @param {number} zMin
   * @param {number} zMax
   * @param {{ min: number, max: number }} activeRange
   * @param {{ forceInputValues?: boolean }} [options]
   */
  function updateColorbarState(
    colorbar,
    sourceKey,
    zMin,
    zMax,
    activeRange,
    { forceInputValues = false } = {},
  ) {
    const rangeState = { heatmapRangeBySource: { [String(sourceKey)]: activeRange } };
    const range = getHeatmapRangeForSource(rangeState, sourceKey, zMin, zMax);
    const minFraction = clamp01((range.min - zMin) / (zMax - zMin));
    const maxFraction = clamp01((range.max - zMin) / (zMax - zMin));
    const track = /** @type {HTMLElement | null} */ (
      colorbar.querySelector(".heatmap-colorbar-track")
    );
    if (track) {
      track.style.background = buildHeatmapColorbarGradient(
        minFraction * 100,
        maxFraction * 100,
      );
    }
    const minInput = /** @type {HTMLInputElement | null} */ (
      colorbar.querySelector(".heatmap-colorbar-input-min")
    );
    if (minInput && (forceInputValues || document.activeElement !== minInput)) {
      minInput.value = String(heatmapValueToSliderValue(
        sourceKey,
        range.min,
        zMin,
        zMax,
      ));
    }
    minInput?.setAttribute(
      "aria-valuetext",
      formatHeatmapColorbarValue(sourceKey, range.min),
    );
    const maxInput = /** @type {HTMLInputElement | null} */ (
      colorbar.querySelector(".heatmap-colorbar-input-max")
    );
    if (maxInput && (forceInputValues || document.activeElement !== maxInput)) {
      maxInput.value = String(heatmapValueToSliderValue(
        sourceKey,
        range.max,
        zMin,
        zMax,
      ));
    }
    maxInput?.setAttribute(
      "aria-valuetext",
      formatHeatmapColorbarValue(sourceKey, range.max),
    );
    const minLabel = colorbar.querySelector(".heatmap-colorbar-min-label");
    if (minLabel) {
      minLabel.textContent = formatHeatmapColorbarValue(sourceKey, range.min);
    }
    const maxLabel = colorbar.querySelector(".heatmap-colorbar-max-label");
    if (maxLabel) {
      maxLabel.textContent = formatHeatmapColorbarValue(sourceKey, range.max);
    }
    return range;
  }

  /**
   * @param {string} plotId
   * @param {{ min: number, max: number }} range
   */
  function updatePlotRange(plotId, range) {
    const plot = /** @type {HTMLElement & { data?: any[] } | null} */ (
      document.getElementById(plotId)
    );
    if (!plot || !Array.isArray(plot.data) || plot.data.length === 0 || !range) {
      return false;
    }
    plotly.restyle(plot, {
      zmin: [range.min],
      zmax: [range.max],
    });
    return true;
  }

  /**
   * @param {{
   *   state: Record<string, any>,
   *   sourceKey: string,
   *   zMin: number | null,
   *   zMax: number | null,
   *   activeRange?: { min: number, max: number } | null,
   *   plotId?: string,
   * }} options
   */
  function renderColorbar({
    state,
    sourceKey,
    zMin,
    zMax,
    activeRange = null,
    plotId = "c-heatmap-plot",
  }) {
    colorbarController?.destroy();
    colorbarController = null;
    const colorbar = /** @type {HTMLElement | null} */ (
      document.getElementById("heatmap-colorbar")
    );
    if (!colorbar) {
      return null;
    }
    const hasRange = Number.isFinite(zMin) && Number.isFinite(zMax) && zMax > zMin;
    colorbar.classList.toggle("hidden", !hasRange);
    colorbar.innerHTML = "";
    if (!hasRange) {
      return null;
    }

    const numericMin = /** @type {number} */ (zMin);
    const numericMax = /** @type {number} */ (zMax);
    let currentRange = activeRange
      ?? getHeatmapRangeForSource(state, sourceKey, numericMin, numericMax);
    /** @type {{ min: number, max: number } | null} */
    let interactionStartRange = null;
    const row = createElement("div", "heatmap-colorbar-row");
    const rangeContainer = createElement("div", "heatmap-colorbar-range");
    const labels = createElement("div", "heatmap-colorbar-labels");
    const minLabel = createElement("span", "heatmap-colorbar-min-label");
    const rangeLabel = createElement("span", "heatmap-colorbar-range-label");
    rangeLabel.textContent = "Color Map";
    const maxLabel = createElement("span", "heatmap-colorbar-max-label");
    labels.append(minLabel, rangeLabel, maxLabel);
    const rangeControl = createElement("div", "heatmap-colorbar-control");
    const track = createElement("div", "heatmap-colorbar-track");
    track.setAttribute("aria-hidden", "true");
    const sliderSpec = getHeatmapSliderSpec(sourceKey, numericMin, numericMax);
    /**
     * @param {string} className
     * @param {string} label
     * @param {string} description
     * @param {number} value
     */
    const createRangeInput = (className, label, description, value) => {
      const input = /** @type {HTMLInputElement} */ (
        createElement("input", `heatmap-colorbar-input ${className}`)
      );
      input.type = "range";
      input.min = String(sliderSpec.min);
      input.max = String(sliderSpec.max);
      input.step = sliderSpec.step;
      input.value = String(heatmapValueToSliderValue(
        sourceKey,
        value,
        numericMin,
        numericMax,
      ));
      input.setAttribute("aria-label", label);
      input.setAttribute("aria-valuetext", formatHeatmapColorbarValue(sourceKey, value));
      input.dataset.controlDescription = description;
      return input;
    };
    const minInput = createRangeInput(
      "heatmap-colorbar-input-min",
      "Heatmap minimum",
      "Set the lower limit of the heatmap color scale",
      currentRange.min,
    );
    const maxInput = createRangeInput(
      "heatmap-colorbar-input-max",
      "Heatmap maximum",
      "Set the upper limit of the heatmap color scale",
      currentRange.max,
    );
    rangeControl.append(track, minInput, maxInput);
    rangeContainer.append(labels, rangeControl);
    row.appendChild(rangeContainer);
    colorbar.appendChild(row);

    /** @param {{ min?: unknown, max?: unknown }} candidate */
    const updateRange = (candidate) => {
      const rangeState = {
        ...state,
        heatmapRangeBySource: {
          ...(state.heatmapRangeBySource ?? {}),
          [String(sourceKey)]: currentRange,
        },
      };
      const nextRange = computeHeatmapRangeUpdate(
        rangeState,
        sourceKey,
        numericMin,
        numericMax,
        candidate,
      );
      if (!nextRange) {
        return;
      }
      currentRange = nextRange;
      updateColorbarState(
        colorbar,
        sourceKey,
        numericMin,
        numericMax,
        currentRange,
        { forceInputValues: true },
      );
      updatePlotRange(plotId, currentRange);
    };
    colorbarController = wireDualRangeController({
      container: rangeControl,
      lowerInput: minInput,
      upperInput: maxInput,
      onInput(handle, value) {
        const converted = heatmapSliderValueToValue(
          sourceKey,
          Number(value),
          numericMin,
          numericMax,
        );
        updateRange(handle === "lower" ? { min: converted } : { max: converted });
      },
      onInteractionStart() {
        interactionStartRange = { ...currentRange };
      },
      onInteractionEnd({ canceled }) {
        const startRange = interactionStartRange;
        interactionStartRange = null;
        if (!startRange) {
          return;
        }
        const changed = (
          currentRange.min !== startRange.min
          || currentRange.max !== startRange.max
        );
        if (!changed) {
          return;
        }
        if (canceled) {
          currentRange = { ...startRange };
          updateColorbarState(
            colorbar,
            sourceKey,
            numericMin,
            numericMax,
            currentRange,
            { forceInputValues: true },
          );
          updatePlotRange(plotId, currentRange);
          return;
        }
        onRangeCommit(sourceKey, currentRange);
      },
    });
    currentRange = updateColorbarState(
      colorbar,
      sourceKey,
      numericMin,
      numericMax,
      currentRange,
    );
    return { range: currentRange };
  }

  function clearControls() {
    renderRevision += 1;
    colorbarController?.destroy();
    colorbarController = null;
    const colorbar = document.getElementById("heatmap-colorbar");
    colorbar?.classList.add("hidden");
    colorbar?.replaceChildren();
    hideTapInspector();
    setDownloadEnabled(false);
    return true;
  }

  /**
   * @param {{
   *   plotly: any,
   *   plot: Cm2PlotElement,
   *   sourceKey: string,
   *   width: number,
   *   height: number,
   *   format: string,
   *   clonePlotlyObject: (value: unknown) => any,
   * }} options
   */
  async function exportImage({
    plotly: exportPlotly,
    plot,
    sourceKey,
    width,
    height,
    format,
    clonePlotlyObject,
  }) {
    const exportWidth = (
      Math.max(HEATMAP_EXPORT_MIN_WIDTH_PX, width)
      + HEATMAP_EXPORT_SIDE_MARGIN_PX * 2
    );
    const exportHeight = Math.max(
      HEATMAP_EXPORT_MIN_HEIGHT_PX,
      height + HEATMAP_EXPORT_COLORBAR_HEIGHT_PX,
    );
    const exportDiv = /** @type {Cm2PlotElement} */ (
      /** @type {unknown} */ (document.createElement("div"))
    );
    exportDiv.style.position = "fixed";
    exportDiv.style.left = "-10000px";
    exportDiv.style.top = "0";
    exportDiv.style.width = `${exportWidth}px`;
    exportDiv.style.height = `${exportHeight}px`;
    exportDiv.style.background = "rgb(255, 255, 255)";
    document.body.appendChild(exportDiv);
    try {
      await exportPlotly.newPlot(
        exportDiv,
        buildHeatmapExportData(plot, clonePlotlyObject),
        buildHeatmapExportLayout(
          plot,
          sourceKey,
          exportWidth,
          exportHeight,
          clonePlotlyObject,
        ),
        { staticPlot: true, displaylogo: false, displayModeBar: false, responsive: false },
      );
      return await exportPlotly.toImage(
        exportDiv,
        { format, width: exportWidth, height: exportHeight },
      );
    } finally {
      exportPlotly.purge(exportDiv);
      exportDiv.remove();
    }
  }

  /**
   * @param {{
   *   plotId?: string,
   *   state: Record<string, any>,
   *   sourceKey: string,
   *   neuronIds: readonly number[],
   *   domainNeuronIds: readonly number[],
   *   modelDependencies?: {
   *     pointIndexForNeuronId?: (neuronId: number) => number | null,
   *     getDffDenominator?: (sourceKey: string, neuronId: number) => number,
   *   },
   *   pointIndexForNeuronId?: (neuronId: number) => number | null,
   *   updateColorbar?: boolean,
   * }} options
   */
  function render({
    plotId = "c-heatmap-plot",
    state,
    sourceKey,
    neuronIds,
    domainNeuronIds,
    modelDependencies = {},
    pointIndexForNeuronId,
    updateColorbar = true,
  }) {
    const revision = ++renderRevision;
    const plot = /** @type {HTMLElement & { data?: any[] } | null} */ (
      document.getElementById(plotId)
    );
    if (!plot) {
      return null;
    }
    const descriptor = buildHeatmapPlotDescriptor({
      state,
      sourceKey,
      neuronIds,
      domainNeuronIds,
      modelDependencies,
      pointIndexForNeuronId,
    });
    plot.dataset.visibleNeuronCount = String(descriptor.z.length);
    if (descriptor.empty) {
      plot.closest(".plot-panel")?.classList.toggle("is-empty", true);
      hideTapInspector();
      detachTapInspector(/** @type {Cm2PlotElement} */ (plot));
      plotly.purge(plot);
      plot.innerHTML = "";
      setDownloadEnabled(false);
      // The empty path clears a stale colorbar even when a caller opts
      // out of non-empty colorbar refreshes.
      renderColorbar({ state, sourceKey, zMin: null, zMax: null, plotId });
      return descriptor;
    }

    plot.closest(".plot-panel")?.classList.toggle("is-empty", false);
    setDownloadEnabled(true);
    plot.style.height = `${descriptor.plotHeight}px`;
    Promise.resolve(
      plotly.react(plot, descriptor.data, descriptor.layout, descriptor.config),
    ).then(() => {
      if (revision === renderRevision && plot.isConnected) {
        attachTapInspector(
          /** @type {Cm2PlotElement} */ (plot),
          sourceKey,
          neuronIds,
        );
      }
    }).catch((error) => globalThis.console?.warn(error));
    if (updateColorbar) {
      renderColorbar({
        state,
        sourceKey,
        zMin: descriptor.colorDomain.minValue,
        zMax: descriptor.colorDomain.maxValue,
        activeRange: descriptor.colorRange,
        plotId,
      });
    }
    return descriptor;
  }

  return {
    clearControls,
    dismissPinnedInspector: hideTapInspector,
    exportImage,
    hasPinnedInspector() {
      const inspector = document.querySelector(".heatmap-tap-inspector");
      return Boolean(inspector && !inspector.classList.contains("hidden"));
    },
    render,
  };
}
