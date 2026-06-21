function getTraceStats(sourceKey) {
  return state.points.trace_stats[sourceKey] ?? state.points.trace_stats[getTraceBaseSourceKey(sourceKey)];
}

function getTraceSlice(sourceKey, neuronId) {
  const traceBuffer = state.tracesBySource[getTraceBaseSourceKey(sourceKey)];
  const offset = neuronId * state.meta.trace_length;
  return traceBuffer.subarray(offset, offset + state.meta.trace_length);
}

function getTraceBaseSourceKey(sourceKey) {
  return TRACE_VIRTUAL_SOURCES[sourceKey]?.baseSource ?? sourceKey;
}

function getTraceSubtractValue(sourceKey, neuronId) {
  const metricKey = TRACE_VIRTUAL_SOURCES[sourceKey]?.subtractMetric;
  if (!metricKey) {
    return 0;
  }
  const pointIndex = getPointIndexForNeuronId(neuronId);
  const value = pointIndex === null ? null : state.points.metrics?.[metricKey]?.[pointIndex];
  return Number.isFinite(value) ? value : 0;
}

function getTraceDisplayValue(sourceKey, neuronId, rawValue) {
  const value = rawValue - getTraceSubtractValue(sourceKey, neuronId);
  const virtual = TRACE_VIRTUAL_SOURCES[sourceKey];
  if (!virtual?.dffProjectionSource) {
    return value;
  }
  const denominator = getDffDenominator(sourceKey, neuronId);
  if (!Number.isFinite(denominator) || Math.abs(denominator) <= getDffMinBaselineAbs()) {
    return NaN;
  }
  return value / denominator;
}

function isDynamicDffSource(sourceKey) {
  return Boolean(TRACE_VIRTUAL_SOURCES[sourceKey]?.dffProjectionSource);
}

function getDffBaselinePercentile() {
  return DFF_DEFAULT_BASELINE_PERCENTILE;
}

function getDffMinBaselineAbs() {
  const value = Number(state.meta?.dff?.min_baseline_abs);
  return Number.isFinite(value) && value > 0 ? value : DFF_MIN_BASELINE_ABS;
}

function percentileSorted(sortedValues, percentile) {
  const n = sortedValues.length;
  if (!n) {
    return NaN;
  }
  if (n === 1) {
    return sortedValues[0];
  }
  const position = clamp(percentile, 0, 100) / 100 * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const fraction = position - lower;
  return sortedValues[lower] * (1 - fraction) + sortedValues[upper] * fraction;
}

function tracePercentile(trace, percentile) {
  const values = [];
  for (let idx = 0; idx < trace.length; idx += 1) {
    const value = trace[idx];
    if (Number.isFinite(value)) {
      values.push(value);
    }
  }
  values.sort((a, b) => a - b);
  return percentileSorted(values, percentile);
}

function getDffDenominator(sourceKey, neuronId) {
  const projectionSourceKey = TRACE_VIRTUAL_SOURCES[sourceKey]?.dffProjectionSource;
  if (!projectionSourceKey) {
    return NaN;
  }
  const percentile = getDffBaselinePercentile();
  const cacheKey = `${projectionSourceKey}:${percentile}:${neuronId}`;
  if (state.dffDenominatorCache.has(cacheKey)) {
    return state.dffDenominatorCache.get(cacheKey);
  }
  const projectionTrace = getTraceSlice(projectionSourceKey, neuronId);
  const denominator = tracePercentile(projectionTrace, percentile);
  state.dffDenominatorCache.set(cacheKey, denominator);
  return denominator;
}

const TRACE_PLOT_MARGIN = { l: 0, r: 0, t: 14, b: 8 };
const HEATMAP_PLOT_MARGIN = { l: 0, r: 0, t: 0, b: 0 };
const TRACE_ROW_HEIGHT_PX = 52;
const TRACE_VERTICAL_MARGIN_PX = 18;
const TRACE_ROW_STEP_FALLBACK = 1;
const TRACE_ROW_STEP_MIN = 1e-6;
const TRACE_ROW_RANGE_PAD_FRACTION = 0.08;
const TRACE_ZERO_GUIDE_COLOR = "rgba(255, 255, 255, 0.16)";
const TRACE_DFF_THRESHOLD_VALUE = 0.05;
const TRACE_DFF_THRESHOLD_COLOR = "rgba(255, 255, 255, 0.28)";
const TRACE_DFF_THRESHOLD_LABEL = `${Math.round(TRACE_DFF_THRESHOLD_VALUE * 100)}%`;
const HEATMAP_ROW_HEIGHT_PX = 0.8;
const HEATMAP_PERCENT_SCALE = 100;
const HEATMAP_COLORMAP_DEFAULT = "gray";
const HEATMAP_COLORMAP_ORDER = [
  "gray",
  "viridis",
  "cividis",
  "magma",
  "inferno",
  "plasma",
  "rocket",
  "mako",
  "crest",
  "flare",
  "batlow",
  "thermal",
  "haline",
  "amber",
  "ember",
  "ocean",
  "turbo",
  "hot",
  "teal",
  "mint",
  "electric",
  "blackbody",
];
const HEATMAP_COLORMAPS = {
  gray: {
    label: "Gray",
    colorscale: [
      [0, "#000000"],
      [1, "#ffffff"],
    ],
  },
  viridis: {
    label: "Viridis",
    colorscale: [
      [0, "#440154"],
      [0.25, "#3b528b"],
      [0.5, "#21918c"],
      [0.75, "#5ec962"],
      [1, "#fde725"],
    ],
  },
  cividis: {
    label: "Cividis",
    colorscale: [
      [0, "#00204c"],
      [0.25, "#31446b"],
      [0.5, "#666870"],
      [0.75, "#a8955b"],
      [1, "#ffea46"],
    ],
  },
  magma: {
    label: "Magma",
    colorscale: [
      [0, "#000004"],
      [0.25, "#51127c"],
      [0.5, "#b63679"],
      [0.75, "#fb8861"],
      [1, "#fcfdbf"],
    ],
  },
  inferno: {
    label: "Inferno",
    colorscale: [
      [0, "#000004"],
      [0.25, "#57106e"],
      [0.5, "#bc3754"],
      [0.75, "#f98e09"],
      [1, "#fcffa4"],
    ],
  },
  plasma: {
    label: "Plasma",
    colorscale: [
      [0, "#0d0887"],
      [0.25, "#7e03a8"],
      [0.5, "#cc4778"],
      [0.75, "#f89540"],
      [1, "#f0f921"],
    ],
  },
  rocket: {
    label: "Rocket",
    colorscale: [
      [0, "#03051a"],
      [0.2, "#3f1b43"],
      [0.4, "#8c1d5b"],
      [0.6, "#cb1b4f"],
      [0.8, "#f06043"],
      [1, "#f6b48f"],
    ],
  },
  mako: {
    label: "Mako",
    colorscale: [
      [0, "#0b0405"],
      [0.2, "#17314f"],
      [0.4, "#17597a"],
      [0.6, "#3b8496"],
      [0.8, "#8ab8a7"],
      [1, "#def5e5"],
    ],
  },
  crest: {
    label: "Crest",
    colorscale: [
      [0, "#082319"],
      [0.2, "#174d3a"],
      [0.4, "#287a5f"],
      [0.6, "#49a982"],
      [0.8, "#8fd1a5"],
      [1, "#d7f2c2"],
    ],
  },
  flare: {
    label: "Flare",
    colorscale: [
      [0, "#2a0b32"],
      [0.2, "#662d5c"],
      [0.4, "#a34360"],
      [0.6, "#d16458"],
      [0.8, "#f1965b"],
      [1, "#f6d08a"],
    ],
  },
  batlow: {
    label: "Batlow",
    colorscale: [
      [0, "#011959"],
      [0.2, "#12436d"],
      [0.4, "#257977"],
      [0.6, "#7da85a"],
      [0.8, "#d7c05a"],
      [1, "#f9fb93"],
    ],
  },
  thermal: {
    label: "Thermal",
    colorscale: [
      [0, "#042333"],
      [0.2, "#43328a"],
      [0.4, "#b02a7c"],
      [0.6, "#e85d3f"],
      [0.8, "#f6b13b"],
      [1, "#fff2a6"],
    ],
  },
  haline: {
    label: "Haline",
    colorscale: [
      [0, "#071330"],
      [0.2, "#123c69"],
      [0.4, "#176b8c"],
      [0.6, "#1aa59a"],
      [0.8, "#72d28c"],
      [1, "#eef6a4"],
    ],
  },
  amber: {
    label: "Amber",
    colorscale: [
      [0, "#050301"],
      [0.2, "#2f1202"],
      [0.4, "#7a2c02"],
      [0.6, "#c4570a"],
      [0.8, "#f0a12b"],
      [1, "#ffe59a"],
    ],
  },
  ember: {
    label: "Ember",
    colorscale: [
      [0, "#06000d"],
      [0.2, "#2a073d"],
      [0.4, "#65104c"],
      [0.6, "#a51f39"],
      [0.8, "#de5b2c"],
      [1, "#ffd37a"],
    ],
  },
  ocean: {
    label: "Ocean",
    colorscale: [
      [0, "#020918"],
      [0.2, "#06345a"],
      [0.4, "#0b6f86"],
      [0.6, "#12aaa1"],
      [0.8, "#69d4bd"],
      [1, "#d7fff2"],
    ],
  },
  turbo: {
    label: "Turbo",
    colorscale: [
      [0, "#30123b"],
      [0.2, "#4145ab"],
      [0.4, "#1ae4b6"],
      [0.6, "#a4fc3c"],
      [0.8, "#f66c19"],
      [1, "#7a0403"],
    ],
  },
  hot: {
    label: "Hot",
    colorscale: [
      [0, "#000000"],
      [0.33, "#b30000"],
      [0.66, "#ffb300"],
      [1, "#ffffff"],
    ],
  },
  teal: {
    label: "Teal",
    colorscale: [
      [0, "#001219"],
      [0.25, "#005f73"],
      [0.5, "#0a9396"],
      [0.75, "#94d2bd"],
      [1, "#e9d8a6"],
    ],
  },
  mint: {
    label: "Mint",
    colorscale: [
      [0, "#001b12"],
      [0.25, "#0b5d3b"],
      [0.5, "#1aa36f"],
      [0.75, "#7be0ad"],
      [1, "#edfff6"],
    ],
  },
  electric: {
    label: "Electric",
    colorscale: [
      [0, "#000000"],
      [0.2, "#1b03a3"],
      [0.4, "#0066ff"],
      [0.6, "#00e5ff"],
      [0.8, "#fff200"],
      [1, "#ffffff"],
    ],
  },
  blackbody: {
    label: "Blackbody",
    colorscale: [
      [0, "#000000"],
      [0.2, "#2b0000"],
      [0.45, "#b30000"],
      [0.7, "#ff8c00"],
      [0.9, "#ffff66"],
      [1, "#ffffff"],
    ],
  },
};
const TRACE_DESELECT_BUTTON_SIZE_PX = 20;
const TRACE_DESELECT_BUTTON_INSET_PX = 8;
const TRACE_SORT_CUSTOM_KEY = "custom";
const TRACE_SORT_DEFAULT_KEY = TRACE_SORT_CUSTOM_KEY;
const TRACE_SORT_OPTIONS = [
  { key: "peak-desc", label: "Peak" },
  { key: "mean-desc", label: "Mean" },
  { key: "position", label: "Position" },
  { key: TRACE_SORT_CUSTOM_KEY, label: "Custom" },
];
const TEMPORAL_PLOT_DOWNLOADS = {
  heatmap: {
    plotId: "c-heatmap-plot",
    buttons: {
      svg: "download-heatmap-svg-btn",
      png: "download-heatmap-png-btn",
    },
    filenamePrefix: "cm2-heatmap",
  },
  trace: {
    plotId: "c-trace-plot",
    buttons: {
      svg: "download-trace-svg-btn",
      png: "download-trace-png-btn",
    },
    filenamePrefix: "cm2-trace",
    exportStyle: "paper-trace",
  },
};
let traceDeselectHideTimer = null;

function setPlotPanelEmpty(plotDiv, isEmpty) {
  plotDiv.closest(".plot-panel")?.classList.toggle("is-empty", isEmpty);
  if (isEmpty) {
    Plotly.purge(plotDiv);
    plotDiv.innerHTML = "";
  }
}

function setTemporalDownloadEnabled(spec, enabled) {
  for (const buttonId of Object.values(spec.buttons ?? {})) {
    const button = document.getElementById(buttonId);
    if (button) {
      button.disabled = !enabled;
    }
  }
}

function sanitizeFilenamePart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "plot";
}

function getDefaultTemporalFilename(spec, format) {
  const source = sanitizeFilenamePart(state.activeSignalSource);
  const valueMode = sanitizeFilenamePart(state.activeTraceValueMode);
  return `${spec.filenamePrefix}-${source}-${valueMode}.${format}`;
}

function getImageMimeType(format) {
  return format === "png" ? "image/png" : "image/svg+xml";
}

function dataUrlToBlob(dataUrl, format) {
  const mimeType = getImageMimeType(format);
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return new Blob([dataUrl], { type: `${mimeType};charset=utf-8` });
  }
  const metadata = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const content = metadata.includes(";base64")
    ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    : decodeURIComponent(payload);
  return new Blob([content], { type: `${mimeType};charset=utf-8` });
}

function getImageSaveType(format) {
  if (format === "png") {
    return {
      description: "PNG image",
      accept: { "image/png": [".png"] },
    };
  }
  return {
    description: "SVG image",
    accept: { "image/svg+xml": [".svg"] },
  };
}

async function chooseImageSaveTarget(suggestedName, format) {
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [getImageSaveType(format)],
      });
      return { handle };
    } catch (error) {
      if (error?.name === "AbortError") {
        return { aborted: true };
      }
      console.warn(`Native ${format.toUpperCase()} save failed; falling back to browser download.`, error);
    }
  }
  return null;
}

async function saveImageBlob(blob, suggestedName, target = null) {
  if (target?.aborted) {
    return;
  }
  if (target?.handle) {
    const writable = await target.handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function getPlotExportSize(plotDiv) {
  const rect = plotDiv.getBoundingClientRect();
  return {
    width: Math.max(1, Math.round(plotDiv._fullLayout?.width ?? rect.width ?? plotDiv.clientWidth ?? 1)),
    height: Math.max(1, Math.round(plotDiv._fullLayout?.height ?? rect.height ?? plotDiv.clientHeight ?? 1)),
  };
}

function clonePlotlyObject(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isTraceNeuronLine(trace) {
  return Number.isFinite(trace?.meta?.neuronId);
}

function makeTraceExportData(plotDiv) {
  return clonePlotlyObject(plotDiv.data ?? []).map((trace) => {
    if (trace?.type !== "scatter" || !trace.line) {
      return trace;
    }
    const line = { ...trace.line, color: "rgb(0, 0, 0)" };
    if (!isTraceNeuronLine(trace)) {
      line.dash = "dot";
      line.width = Math.min(Number(line.width) || 1, 1);
    }
    return { ...trace, line };
  });
}

function makeTraceExportLayout(plotDiv, width, height) {
  const layout = clonePlotlyObject(plotDiv.layout ?? {});
  layout.width = width;
  layout.height = height;
  layout.paper_bgcolor = "rgb(255, 255, 255)";
  layout.plot_bgcolor = "rgb(255, 255, 255)";
  layout.margin = clonePlotlyObject(plotDiv.layout?.margin ?? TRACE_PLOT_MARGIN);
  layout.xaxis = {
    ...(layout.xaxis ?? {}),
    visible: false,
    fixedrange: true,
    range: clonePlotlyObject(plotDiv._fullLayout?.xaxis?.range ?? layout.xaxis?.range),
  };
  layout.yaxis = {
    ...(layout.yaxis ?? {}),
    visible: false,
    fixedrange: true,
    range: clonePlotlyObject(plotDiv._fullLayout?.yaxis?.range ?? layout.yaxis?.range),
  };
  layout.annotations = clonePlotlyObject(layout.annotations ?? []).map((annotation) => ({
    ...annotation,
    font: {
      ...(annotation.font ?? {}),
      color: "rgb(0, 0, 0)",
    },
  }));
  layout.shapes = clonePlotlyObject(layout.shapes ?? []).map((shape) => ({
    ...shape,
    line: {
      ...(shape.line ?? {}),
      color: "rgb(0, 0, 0)",
    },
  }));
  return layout;
}

async function exportTracePlotImage(plotDiv, width, height, format) {
  const exportDiv = document.createElement("div");
  exportDiv.style.position = "fixed";
  exportDiv.style.left = "-10000px";
  exportDiv.style.top = "0";
  exportDiv.style.width = `${width}px`;
  exportDiv.style.height = `${height}px`;
  exportDiv.style.background = "rgb(255, 255, 255)";
  document.body.appendChild(exportDiv);
  try {
    await Plotly.newPlot(
      exportDiv,
      makeTraceExportData(plotDiv),
      makeTraceExportLayout(plotDiv, width, height),
      { staticPlot: true, displaylogo: false, displayModeBar: false, responsive: false }
    );
    return await Plotly.toImage(exportDiv, {
      format,
      width,
      height,
    });
  } finally {
    Plotly.purge(exportDiv);
    exportDiv.remove();
  }
}

async function exportTemporalPlotImage(spec, plotDiv, width, height, format) {
  if (spec.exportStyle === "paper-trace") {
    return exportTracePlotImage(plotDiv, width, height, format);
  }
  return Plotly.toImage(plotDiv, {
    format,
    width,
    height,
  });
}

async function downloadTemporalPlotImage(spec, format) {
  const plotDiv = document.getElementById(spec.plotId);
  if (!plotDiv || !plotDiv.data?.length) {
    setStatus("No plot is available to download.", true);
    window.setTimeout(() => setStatus(""), 1800);
    return;
  }
  const button = document.getElementById(spec.buttons?.[format]);
  button?.setAttribute("aria-busy", "true");
  button?.setAttribute("disabled", "true");
  const filename = getDefaultTemporalFilename(spec, format);
  try {
    const saveTarget = await chooseImageSaveTarget(filename, format);
    if (saveTarget?.aborted) {
      return;
    }
    const { width, height } = getPlotExportSize(plotDiv);
    const dataUrl = await exportTemporalPlotImage(spec, plotDiv, width, height, format);
    await saveImageBlob(dataUrlToBlob(dataUrl, format), filename, saveTarget);
  } catch (error) {
    console.error(error);
    setStatus(error.message ?? `Failed to download ${format.toUpperCase()}.`, true);
    window.setTimeout(() => setStatus(""), 2400);
  } finally {
    button?.removeAttribute("aria-busy");
    setTemporalDownloadEnabled(spec, Boolean(plotDiv.data?.length));
  }
}

function wireTemporalDownloadButtons() {
  for (const spec of Object.values(TEMPORAL_PLOT_DOWNLOADS)) {
    for (const [format, buttonId] of Object.entries(spec.buttons ?? {})) {
      const button = document.getElementById(buttonId);
      if (!button || button.dataset.downloadWired === "true") {
        continue;
      }
      button.addEventListener("click", () => downloadTemporalPlotImage(spec, format));
      button.dataset.downloadWired = "true";
    }
    setTemporalDownloadEnabled(spec, false);
  }
}

function setTraceSelectAllEnabled(enabled) {
  const button = document.getElementById("trace-select-all-btn");
  if (button) {
    button.disabled = !enabled;
  }
}

function wireTraceSelectAllButton() {
  const button = document.getElementById("trace-select-all-btn");
  if (!button || button.dataset.selectAllWired === "true") {
    return;
  }
  button.addEventListener("click", selectAllTraceNeuronsForActiveRoi);
  button.dataset.selectAllWired = "true";
  setTraceSelectAllEnabled(false);
}

function sortNeuronIdsByPosition(neuronIds) {
  return [...neuronIds].sort((a, b) => {
    const aIndex = getPointIndexForNeuronId(a);
    const bIndex = getPointIndexForNeuronId(b);
    if (aIndex === null || bIndex === null) {
      return 0;
    }
    const dx = state.points.x[aIndex] - state.points.x[bIndex];
    return dx !== 0 ? dx : state.points.y[aIndex] - state.points.y[bIndex];
  });
}

function getActiveTemporalRoi() {
  return getRoiById(state.activeRoiId);
}

function getSelectedTraceNeuronIds(roi, filters = getActiveQcFilters()) {
  if (!roi) {
    return [];
  }
  return roi.neuronIds.filter((neuronId) => neuronIdPassesRoiSelection(neuronId, roi, filters));
}

function getOrderedSelectedTraceNeuronIds(sourceKey, roi, filters = getActiveQcFilters()) {
  return sortTraceNeuronIds(getSelectedTraceNeuronIds(roi, filters), sourceKey, getActiveTraceSortKey());
}

function getHeatmapNeuronIds(roi, filters = getActiveQcFilters()) {
  if (!roi) {
    return [];
  }
  if (!roi.box) {
    return getSelectedTraceNeuronIds(roi, filters);
  }
  const neuronIds = [];
  for (let pointIndex = 0; pointIndex < state.points.id.length; pointIndex += 1) {
    if (pointIndexPassesQc(pointIndex, filters) && pointIndexInRoiBox(pointIndex, roi)) {
      neuronIds.push(state.points.id[pointIndex]);
    }
  }
  return sortNeuronIdsByPosition(neuronIds);
}

function getAllHeatmapNeuronIds(filters = getActiveQcFilters()) {
  const neuronIds = new Set();
  for (const roi of state.rois) {
    for (const neuronId of getHeatmapNeuronIds(roi, filters)) {
      neuronIds.add(neuronId);
    }
  }
  return sortNeuronIdsByPosition([...neuronIds]);
}

function getTraceOperationControlsContainer() {
  let container = document.getElementById("trace-operation-controls");
  if (container) {
    return container;
  }

  container = document.createElement("div");
  container.id = "trace-operation-controls";
  container.className = "trace-operation-controls";

  const scaleControls = document.getElementById("trace-scale-controls");
  if (scaleControls?.parentElement) {
    scaleControls.parentElement.insertBefore(container, scaleControls);
    return container;
  }

  const tracePanel = document.querySelector(".trace-plot-panel");
  if (tracePanel?.parentElement) {
    tracePanel.parentElement.insertBefore(container, tracePanel);
    return container;
  }

  return null;
}

function getAllPointIndices() {
  return state.points.id.map((_, pointIndex) => pointIndex);
}

function getSelectableTraceNeuronIds(roi, filters = getActiveQcFilters()) {
  if (!roi) {
    return [];
  }
  const pointIndices = roi.box
    ? getAllPointIndices()
    : (typeof getVisiblePointIndices === "function" ? getVisiblePointIndices() : getAllPointIndices());
  const neuronIds = [];
  for (const pointIndex of pointIndices) {
    if (!pointIndexPassesQc(pointIndex, filters) || !pointIndexInRoiBox(pointIndex, roi)) {
      continue;
    }
    neuronIds.push(state.points.id[pointIndex]);
  }
  return neuronIds;
}

function selectAllTraceNeuronsForActiveRoi() {
  const roi = getActiveTemporalRoi();
  if (!roi) {
    return;
  }
  setTraceSortCustom();
  const nextNeuronIds = new Set(roi.neuronIds);
  const selectableNeuronIds = getSelectableTraceNeuronIds(roi);
  for (const neuronId of selectableNeuronIds) {
    removeNeuronFromAllRois(neuronId);
    nextNeuronIds.add(neuronId);
  }
  roi.neuronIds = sortNeuronIdsByPosition([...nextNeuronIds]);
  refreshRoiViews({ includePlots: true });
}

function getTraceSortMetric(sourceKey, sortKey, neuronId) {
  const trace = getTraceSlice(sourceKey, neuronId);
  let peak = -Infinity;
  let sum = 0;
  let count = 0;
  for (let idx = 0; idx < trace.length; idx += 1) {
    const value = getTraceDisplayValue(sourceKey, neuronId, trace[idx]);
    if (!Number.isFinite(value)) {
      continue;
    }
    peak = Math.max(peak, value);
    sum += value;
    count += 1;
  }
  if (!count) {
    return null;
  }
  return sortKey === "mean-desc" ? sum / count : peak;
}

function compareTraceSortEntries(a, b) {
  const aValid = Number.isFinite(a.metric);
  const bValid = Number.isFinite(b.metric);
  if (aValid && bValid && a.metric !== b.metric) {
    return b.metric - a.metric;
  }
  if (aValid !== bValid) {
    return aValid ? -1 : 1;
  }
  return a.originalIndex - b.originalIndex;
}

function sortTraceNeuronIds(neuronIds, sourceKey, sortKey) {
  if (sortKey === TRACE_SORT_CUSTOM_KEY) {
    return [...neuronIds];
  }
  if (sortKey === "position") {
    return sortNeuronIdsByPosition(neuronIds);
  }
  return neuronIds
    .map((neuronId, originalIndex) => ({
      neuronId,
      originalIndex,
      metric: getTraceSortMetric(sourceKey, sortKey, neuronId),
    }))
    .sort(compareTraceSortEntries)
    .map(({ neuronId }) => neuronId);
}

function setTraceSortCustom() {
  state.activeTraceSortKey = TRACE_SORT_CUSTOM_KEY;
}

function getActiveTraceSortKey() {
  return TRACE_SORT_OPTIONS.some((option) => option.key === state.activeTraceSortKey)
    ? state.activeTraceSortKey
    : TRACE_SORT_DEFAULT_KEY;
}

function setActiveTraceSort(sourceKey, sortKey = TRACE_SORT_DEFAULT_KEY) {
  const roi = getActiveTemporalRoi();
  if (!roi || !isTraceSourceAvailable(sourceKey)) {
    return;
  }
  state.activeTraceSortKey = TRACE_SORT_OPTIONS.some((option) => option.key === sortKey)
    ? sortKey
    : TRACE_SORT_DEFAULT_KEY;
  refreshRoiViews({ includePlots: true });
}

function renderTraceOperationControls(sourceKey) {
  const container = getTraceOperationControlsContainer();
  if (!container) {
    return;
  }

  const roi = getActiveTemporalRoi();
  const hasRoi = Boolean(roi);
  const sourceAvailable = isTraceSourceAvailable(sourceKey);
  container.classList.remove("hidden");
  container.innerHTML = "";

  if (!TRACE_SORT_OPTIONS.some((option) => option.key === state.activeTraceSortKey)) {
    state.activeTraceSortKey = TRACE_SORT_DEFAULT_KEY;
  }
  const activeTraceSortKey = getActiveTraceSortKey();
  const sortControl = document.createElement("div");
  sortControl.className = "trace-sort-toggle";
  sortControl.setAttribute("role", "group");
  sortControl.setAttribute("aria-label", "Sort trace neurons");
  for (const option of TRACE_SORT_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `trace-sort-btn${option.key === activeTraceSortKey ? " active" : ""}`;
    button.textContent = option.label;
    button.disabled = !hasRoi || !sourceAvailable;
    button.setAttribute("aria-pressed", String(option.key === activeTraceSortKey));
    button.addEventListener("click", () => {
      setActiveTraceSort(sourceKey, option.key);
    });
    sortControl.appendChild(button);
  }

  setTraceSelectAllEnabled(hasRoi);
  container.appendChild(sortControl);
}

function getTraceStatValue(sourceKey, statKey, neuronId) {
  const value = getTraceStats(sourceKey)?.[statKey]?.[neuronId];
  if (!Number.isFinite(value)) {
    return null;
  }
  if (TRACE_VIRTUAL_SOURCES[sourceKey] && statKey !== "std") {
    return value - getTraceSubtractValue(sourceKey, neuronId);
  }
  return value;
}

function getTraceDffSpacingPercent() {
  return normalizeTraceDffSpacingPercent(state.traceDffSpacingPercent);
}

function getTraceDffSpacingValue() {
  return getTraceDffSpacingPercent() / 100;
}

function getTraceDffPixelsPerPercent() {
  return normalizeTraceDffPixelsPerPercent(state.traceDffPixelsPerPercent);
}

function getTraceDffPixelsPerUnit() {
  return getTraceDffPixelsPerPercent() * 100;
}

function getTraceDffThresholdDisplayValue(sourceKey) {
  return isDynamicDffSource(sourceKey)
    ? TRACE_DFF_THRESHOLD_VALUE
    : TRACE_DFF_THRESHOLD_VALUE;
}

function getTracePlotValue(sourceKey, neuronId, rawValue) {
  return getTraceDisplayValue(sourceKey, neuronId, rawValue);
}

function getRawTraceRowStep(sourceKey, neuronIds) {
  if (isDynamicDffSource(sourceKey)) {
    return Math.max(getTraceDffSpacingValue(), TRACE_ROW_STEP_MIN);
  }
  const stats = getTraceStats(sourceKey);
  if (!stats) {
    return TRACE_ROW_STEP_FALLBACK;
  }
  let low = Infinity;
  let high = -Infinity;
  for (const neuronId of neuronIds) {
    const p05 = getTraceStatValue(sourceKey, "p05", neuronId);
    const p95 = getTraceStatValue(sourceKey, "p95", neuronId);
    if (Number.isFinite(p05)) {
      low = Math.min(low, p05);
    }
    if (Number.isFinite(p95)) {
      high = Math.max(high, p95);
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    return TRACE_ROW_STEP_FALLBACK;
  }
  return Math.max((high - low) * 1.35, TRACE_ROW_STEP_MIN);
}

function buildTracePlotData(sourceKey) {
  const nFrames = state.meta.trace_length;
  const frames = Array.from({ length: nFrames }, (_, idx) => idx);
  const traces = [];
  const shapes = [];
  const annotations = [];
  const zeroGuide = { x: [], y: [] };
  const dffThresholdGuide = { x: [], y: [] };
  const showDffThreshold = sourceKey.startsWith("dff_")
    && getTraceDffSpacingPercent() > TRACE_DFF_SPACING_PERCENT_MIN;
  const traceLineColor = "rgba(255, 255, 255, 0.72)";
  let neuronCount = 0;
  let globalMinY = Infinity;
  let globalMaxY = -Infinity;
  const qcFilters = getActiveQcFilters();
  const roi = getActiveTemporalRoi();
  const neuronIds = getOrderedSelectedTraceNeuronIds(sourceKey, roi, qcFilters);
  const rowStep = getRawTraceRowStep(sourceKey, neuronIds);
  const dffThresholdDisplayValue = getTraceDffThresholdDisplayValue(sourceKey);

  if (neuronIds.length > 0) {
    neuronCount = neuronIds.length;
    let groupMinY = Infinity;
    let groupMaxY = -Infinity;
    neuronIds.forEach((neuronId, localIdx) => {
      const trace = getTraceSlice(sourceKey, neuronId);
      const baseline = -(localIdx * rowStep);
      const y = [];
      zeroGuide.x.push(0, nFrames - 1, NaN);
      zeroGuide.y.push(baseline, baseline, NaN);
      groupMinY = Math.min(groupMinY, baseline);
      groupMaxY = Math.max(groupMaxY, baseline);
      if (showDffThreshold) {
        const thresholdY = baseline + dffThresholdDisplayValue;
        dffThresholdGuide.x.push(0, nFrames - 1, NaN);
        dffThresholdGuide.y.push(thresholdY, thresholdY, NaN);
        groupMinY = Math.min(groupMinY, thresholdY);
        groupMaxY = Math.max(groupMaxY, thresholdY);
        if (localIdx === 0) {
          annotations.push({
            x: Math.max(0, Math.round(nFrames * 0.015)),
            y: thresholdY,
            xref: "x",
            yref: "y",
            text: TRACE_DFF_THRESHOLD_LABEL,
            showarrow: false,
            xanchor: "left",
            yanchor: "bottom",
            yshift: 2,
            font: {
              color: "rgba(255, 255, 255, 0.72)",
              size: 10,
            },
          });
        }
      }
      for (let t = 0; t < nFrames; t += 1) {
        const yValue = baseline + getTracePlotValue(sourceKey, neuronId, trace[t]);
        y.push(yValue);
        groupMinY = Math.min(groupMinY, yValue);
        groupMaxY = Math.max(groupMaxY, yValue);
      }
      traces.push({
        type: "scatter",
        mode: "lines",
        x: frames,
        y,
        customdata: frames.map(() => neuronId),
        meta: { neuronId, baseline },
        line: { color: traceLineColor, width: 1 },
        hoverinfo: "none",
        showlegend: false,
      });
    });
    const yPadding = Math.max((groupMaxY - groupMinY) * 0.004, rowStep * 0.02, TRACE_ROW_STEP_MIN);
    globalMinY = Math.min(globalMinY, groupMinY - yPadding);
    globalMaxY = Math.max(globalMaxY, groupMaxY + yPadding);
  }

  if (zeroGuide.x.length) {
    traces.unshift({
      type: "scatter",
      mode: "lines",
      x: zeroGuide.x,
      y: zeroGuide.y,
      line: { color: TRACE_ZERO_GUIDE_COLOR, width: 1 },
      hoverinfo: "skip",
      showlegend: false,
    });
  }
  if (dffThresholdGuide.x.length) {
    traces.unshift({
      type: "scatter",
      mode: "lines",
      x: dffThresholdGuide.x,
      y: dffThresholdGuide.y,
      line: { color: TRACE_DFF_THRESHOLD_COLOR, width: 1, dash: "dot" },
      hoverinfo: "skip",
      showlegend: false,
    });
  }

  const rangePadding = Math.max(rowStep * TRACE_ROW_RANGE_PAD_FRACTION, TRACE_ROW_STEP_MIN);
  const yRange = Number.isFinite(globalMinY) && Number.isFinite(globalMaxY)
    ? [globalMinY - rangePadding, globalMaxY + rangePadding]
    : [-TRACE_ROW_STEP_FALLBACK, TRACE_ROW_STEP_FALLBACK];
  const ySpan = Math.max(yRange[1] - yRange[0], TRACE_ROW_STEP_MIN);
  const height = isDynamicDffSource(sourceKey)
    ? Math.ceil(ySpan * getTraceDffPixelsPerUnit() + TRACE_PLOT_MARGIN.t + TRACE_PLOT_MARGIN.b)
    : neuronCount * TRACE_ROW_HEIGHT_PX + TRACE_VERTICAL_MARGIN_PX;
  return {
    traces,
    shapes,
    annotations,
    height,
    neuronCount,
    frameRange: [0, Math.max(nFrames - 1, 1)],
    yRange,
  };
}

function clearTraceDeselectHideTimer() {
  if (traceDeselectHideTimer !== null) {
    window.clearTimeout(traceDeselectHideTimer);
    traceDeselectHideTimer = null;
  }
}

function getTraceDeselectButton() {
  let button = document.getElementById("trace-deselect-btn");
  if (button) {
    return button;
  }
  button = document.createElement("button");
  button.id = "trace-deselect-btn";
  button.type = "button";
  button.className = "mini-btn roi-row-delete trace-deselect-btn hidden";
  button.setAttribute("aria-label", "Deselect hovered neuron");
  button.title = "Deselect neuron";
  button.addEventListener("pointerenter", clearTraceDeselectHideTimer);
  button.addEventListener("pointerleave", () => scheduleTraceDeselectButtonHide());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const neuronId = Number(button.dataset.neuronId);
    deselectTraceNeuron(neuronId);
  });
  document.body.appendChild(button);
  return button;
}

function hideTraceDeselectButton({ clearHover = true } = {}) {
  clearTraceDeselectHideTimer();
  const button = document.getElementById("trace-deselect-btn");
  if (button) {
    button.classList.add("hidden");
    delete button.dataset.neuronId;
  }
  if (clearHover) {
    setTraceHoverNeuronId(null);
  }
}

function scheduleTraceDeselectButtonHide() {
  clearTraceDeselectHideTimer();
  traceDeselectHideTimer = window.setTimeout(() => {
    const button = document.getElementById("trace-deselect-btn");
    if (button?.matches(":hover")) {
      return;
    }
    hideTraceDeselectButton();
  }, 140);
}

function getTraceHoverPoint(event) {
  return event?.points?.find((point) => {
    const metaNeuronId = point.data?.meta?.neuronId ?? point.fullData?.meta?.neuronId;
    return Number.isFinite(metaNeuronId) || Number.isFinite(point.customdata);
  }) ?? null;
}

function showTraceDeselectButton(plotDiv, point) {
  const meta = point.data?.meta ?? point.fullData?.meta ?? {};
  const neuronId = Number.isFinite(meta.neuronId) ? meta.neuronId : Number(point.customdata);
  if (!Number.isFinite(neuronId)) {
    scheduleTraceDeselectButtonHide();
    return;
  }

  const button = getTraceDeselectButton();
  const plotRect = plotDiv.getBoundingClientRect();
  const panelRect = plotDiv.closest(".trace-plot-panel")?.getBoundingClientRect() ?? plotRect;
  const yaxis = point.yaxis ?? plotDiv._fullLayout?.yaxis;
  const baseline = Number.isFinite(meta.baseline) ? meta.baseline : point.y;
  const yPixel = yaxis && typeof yaxis.d2p === "function"
    ? yaxis.d2p(baseline) + (yaxis._offset ?? 0)
    : plotRect.height / 2;
  const y = clamp(
    plotRect.top + yPixel - TRACE_DESELECT_BUTTON_SIZE_PX / 2,
    plotRect.top + TRACE_DESELECT_BUTTON_INSET_PX,
    plotRect.bottom - TRACE_DESELECT_BUTTON_SIZE_PX - TRACE_DESELECT_BUTTON_INSET_PX
  );
  const rightEdge = Math.min(plotRect.right, panelRect.right) - TRACE_DESELECT_BUTTON_INSET_PX;
  const x = rightEdge - TRACE_DESELECT_BUTTON_SIZE_PX;

  button.dataset.neuronId = String(neuronId);
  button.style.left = `${x}px`;
  button.style.top = `${y}px`;
  button.classList.remove("hidden");
  clearTraceDeselectHideTimer();
  setTraceHoverNeuronId(neuronId);
}

function deselectTraceNeuron(neuronId) {
  if (!Number.isFinite(neuronId)) {
    return;
  }
  const roi = getActiveTemporalRoi();
  if (!roi || !roi.neuronIds.includes(neuronId)) {
    hideTraceDeselectButton();
    return;
  }
  setTraceSortCustom();
  roi.neuronIds = roi.neuronIds.filter((id) => id !== neuronId);
  hideTraceDeselectButton({ clearHover: false });
  state.traceHoverNeuronId = null;
  refreshRoiViews({ includePlots: true });
}

function attachTraceHoverHandlers(plotDiv) {
  if (plotDiv.dataset.traceHoverHandlersAttached === "true") {
    return;
  }
  plotDiv.on("plotly_hover", (event) => {
    const point = getTraceHoverPoint(event);
    if (!point) {
      scheduleTraceDeselectButtonHide();
      return;
    }
    showTraceDeselectButton(plotDiv, point);
  });
  plotDiv.on("plotly_unhover", () => {
    scheduleTraceDeselectButtonHide();
  });
  plotDiv.__cm2TraceMouseLeaveHandler = () => scheduleTraceDeselectButtonHide();
  plotDiv.addEventListener("mouseleave", plotDiv.__cm2TraceMouseLeaveHandler);
  plotDiv.dataset.traceHoverHandlersAttached = "true";
}

function detachTraceHoverHandlers(plotDiv) {
  if (typeof plotDiv.removeAllListeners === "function") {
    plotDiv.removeAllListeners("plotly_hover");
    plotDiv.removeAllListeners("plotly_unhover");
  }
  if (plotDiv.__cm2TraceMouseLeaveHandler) {
    plotDiv.removeEventListener("mouseleave", plotDiv.__cm2TraceMouseLeaveHandler);
    delete plotDiv.__cm2TraceMouseLeaveHandler;
  }
  delete plotDiv.dataset.traceHoverHandlersAttached;
}

function renderTracePlot(plotId, sourceKey) {
  const plotDiv = document.getElementById(plotId);
  const plotData = buildTracePlotData(sourceKey);
  const { traces, shapes, annotations, height, neuronCount, frameRange, yRange } = plotData;
  plotDiv.dataset.visibleNeuronCount = String(neuronCount);
  if (traces.length === 0) {
    hideTraceDeselectButton();
    detachTraceHoverHandlers(plotDiv);
    setPlotPanelEmpty(plotDiv, true);
    setTemporalDownloadEnabled(TEMPORAL_PLOT_DOWNLOADS.trace, false);
    return;
  }

  setPlotPanelEmpty(plotDiv, false);
  setTemporalDownloadEnabled(TEMPORAL_PLOT_DOWNLOADS.trace, true);
  Plotly.react(plotDiv, traces, {
    margin: TRACE_PLOT_MARGIN,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { visible: false, range: frameRange, fixedrange: true },
    yaxis: { visible: false, range: yRange, fixedrange: true },
    shapes,
    annotations,
    height,
    showlegend: false,
    hovermode: "closest",
    hoverdistance: 18,
    spikedistance: -1,
  }, { responsive: true, displaylogo: false, displayModeBar: false }).then(() => {
    attachTraceHoverHandlers(plotDiv);
  });
}

function formatTraceControlNumber(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "N/A";
  }
  return Number.isInteger(numericValue) ? String(numericValue) : numericValue.toFixed(1);
}

function renderTraceScaleControl({ label, value, min, max, step, normalize, valueLabel, onInput }) {
  const control = document.createElement("label");
  control.className = "trace-scale-control";

  const header = document.createElement("span");
  header.className = "trace-scale-control-header";

  const labelText = document.createElement("span");
  labelText.textContent = label;

  const valueText = document.createElement("span");
  valueText.className = "trace-scale-control-value";
  valueText.textContent = valueLabel(value);

  header.append(labelText, valueText);

  const input = document.createElement("input");
  input.className = "trace-scale-input";
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => {
    const nextValue = normalize(Number(input.value));
    input.value = String(nextValue);
    valueText.textContent = valueLabel(nextValue);
    onInput(nextValue);
  });

  control.append(header, input);
  return control;
}

function renderTraceScaleControls(sourceKey) {
  const container = document.getElementById("trace-scale-controls");
  if (!container) {
    return;
  }
  const showControls = isDynamicDffSource(sourceKey);
  container.classList.toggle("hidden", !showControls);
  container.innerHTML = "";
  if (!showControls) {
    return;
  }

  const redrawTrace = () => renderTracePlot("c-trace-plot", sourceKey);
  const spacingPercent = getTraceDffSpacingPercent();
  const pixelsPerPercent = getTraceDffPixelsPerPercent();

  container.append(
    renderTraceScaleControl({
      label: "Spacing",
      value: spacingPercent,
      min: TRACE_DFF_SPACING_PERCENT_MIN,
      max: TRACE_DFF_SPACING_PERCENT_MAX,
      step: TRACE_DFF_SPACING_PERCENT_STEP,
      normalize: normalizeTraceDffSpacingPercent,
      valueLabel: (nextValue) => `${formatTraceControlNumber(nextValue)}%`,
      onInput: (nextValue) => {
        state.traceDffSpacingPercent = nextValue;
        saveUiState();
        redrawTrace();
      },
    }),
    renderTraceScaleControl({
      label: "Scale",
      value: pixelsPerPercent,
      min: TRACE_DFF_PIXELS_PER_PERCENT_MIN,
      max: TRACE_DFF_PIXELS_PER_PERCENT_MAX,
      step: TRACE_DFF_PIXELS_PER_PERCENT_STEP,
      normalize: normalizeTraceDffPixelsPerPercent,
      valueLabel: (nextValue) => `${formatTraceControlNumber(nextValue)} px/%`,
      onInput: (nextValue) => {
        state.traceDffPixelsPerPercent = nextValue;
        saveUiState();
        redrawTrace();
      },
    })
  );
}

function buildHeatmapData(sourceKey) {
  const nFrames = state.meta.trace_length;
  const x = Array.from({ length: nFrames }, (_, idx) => idx);
  const z = [];
  const verticalMarginPx = 16;
  let visibleMin = Infinity;
  let visibleMax = -Infinity;
  let domainMin = Infinity;
  let domainMax = -Infinity;
  const qcFilters = getActiveQcFilters();
  const roi = getActiveTemporalRoi();
  const neuronIds = getHeatmapNeuronIds(roi, qcFilters);
  const domainNeuronIds = getAllHeatmapNeuronIds(qcFilters);

  for (const neuronId of neuronIds) {
    const trace = getTraceSlice(sourceKey, neuronId);
    z.push(Array.from(trace, (value) => {
      const displayValue = getTraceDisplayValue(sourceKey, neuronId, value);
      if (Number.isFinite(displayValue)) {
        visibleMin = Math.min(visibleMin, displayValue);
        visibleMax = Math.max(visibleMax, displayValue);
      }
      return displayValue;
    }));
  }

  for (const neuronId of domainNeuronIds) {
    const trace = getTraceSlice(sourceKey, neuronId);
    for (let idx = 0; idx < trace.length; idx += 1) {
      const displayValue = getTraceDisplayValue(sourceKey, neuronId, trace[idx]);
      if (Number.isFinite(displayValue)) {
        domainMin = Math.min(domainMin, displayValue);
        domainMax = Math.max(domainMax, displayValue);
      }
    }
  }

  if (!Number.isFinite(domainMin) || !Number.isFinite(domainMax)) {
    domainMin = visibleMin;
    domainMax = visibleMax;
  }

  return {
    x,
    z,
    shapes: [],
    height: z.length * HEATMAP_ROW_HEIGHT_PX + verticalMarginPx,
    zMin: Number.isFinite(domainMin) ? domainMin : null,
    zMax: Number.isFinite(domainMax) ? domainMax : null,
  };
}

function isHeatmapPercentSource(sourceKey) {
  return isDynamicDffSource(sourceKey);
}

function trimNumericLabel(value) {
  return value.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/^-0$/, "0");
}

function formatRawHeatmapColorbarValue(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }
  const absValue = Math.abs(value);
  if (absValue < 1e-9) {
    return "0";
  }
  if (absValue >= 100) {
    return value.toFixed(0);
  }
  if (absValue >= 10) {
    return trimNumericLabel(value.toFixed(1));
  }
  if (absValue >= 1) {
    return trimNumericLabel(value.toFixed(2));
  }
  if (absValue >= 0.01) {
    return trimNumericLabel(value.toFixed(3));
  }
  return value.toPrecision(2);
}

function formatHeatmapColorbarValue(sourceKey, value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }
  if (!isHeatmapPercentSource(sourceKey)) {
    return formatRawHeatmapColorbarValue(value);
  }
  return `${heatmapValueToPercent(value)}%`;
}

function heatmapValueToPercent(value) {
  const percent = Math.round(Number(value) * HEATMAP_PERCENT_SCALE);
  return Object.is(percent, -0) ? 0 : percent;
}

function heatmapPercentToValue(percent) {
  const value = Number(percent) / HEATMAP_PERCENT_SCALE;
  return Object.is(value, -0) ? 0 : value;
}

function snapHeatmapValueToPercent(value) {
  return heatmapPercentToValue(heatmapValueToPercent(value));
}

function snapHeatmapControlValue(sourceKey, value) {
  return isHeatmapPercentSource(sourceKey) ? snapHeatmapValueToPercent(value) : Number(value);
}

function buildHeatmapColorDomain(sourceKey, zMin, zMax) {
  if (!isHeatmapPercentSource(sourceKey)) {
    return { minValue: zMin, maxValue: zMax };
  }
  let minPercent = heatmapValueToPercent(zMin);
  let maxPercent = heatmapValueToPercent(zMax);
  if (maxPercent <= minPercent) {
    maxPercent = minPercent + 1;
  }
  return {
    minValue: heatmapPercentToValue(minPercent),
    maxValue: heatmapPercentToValue(maxPercent),
  };
}

function getHeatmapRangeStepValue(sourceKey, zMin, zMax) {
  if (isHeatmapPercentSource(sourceKey)) {
    return heatmapPercentToValue(1);
  }
  return Math.max((zMax - zMin) * 1e-6, 1e-12);
}

function heatmapValueToSliderValue(sourceKey, value) {
  return isHeatmapPercentSource(sourceKey) ? heatmapValueToPercent(value) : value;
}

function heatmapSliderValueToValue(sourceKey, value) {
  return isHeatmapPercentSource(sourceKey) ? heatmapPercentToValue(value) : Number(value);
}

function getHeatmapSliderStep(sourceKey) {
  return isHeatmapPercentSource(sourceKey) ? "1" : "any";
}

function getHeatmapRangeForSource(sourceKey, zMin, zMax) {
  if (zMax <= zMin) {
    return { min: zMin, max: zMax };
  }
  const step = getHeatmapRangeStepValue(sourceKey, zMin, zMax);
  const stored = state.heatmapRangeBySource?.[sourceKey] ?? {};
  const storedMin = Number(stored.min);
  const storedMax = Number(stored.max);
  let min = Number.isFinite(storedMin)
    ? snapHeatmapControlValue(sourceKey, clamp(storedMin, zMin, zMax - step))
    : zMin;
  let max = Number.isFinite(storedMax)
    ? snapHeatmapControlValue(sourceKey, clamp(storedMax, zMin + step, zMax))
    : zMax;

  if (min >= max) {
    min = zMin;
    max = zMax;
  }
  return { min, max };
}

function setHeatmapRangeForSource(sourceKey, zMin, zMax, nextRange) {
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || zMax <= zMin) {
    return;
  }
  const step = getHeatmapRangeStepValue(sourceKey, zMin, zMax);
  const range = getHeatmapRangeForSource(sourceKey, zMin, zMax);
  const nextMin = Number(nextRange?.min);
  const nextMax = Number(nextRange?.max);
  if (Number.isFinite(nextMin)) {
    range.min = snapHeatmapControlValue(sourceKey, clamp(nextMin, zMin, range.max - step));
  }
  if (Number.isFinite(nextMax)) {
    range.max = snapHeatmapControlValue(sourceKey, clamp(nextMax, range.min + step, zMax));
  }
  if (range.min >= range.max) {
    range.min = zMin;
    range.max = zMax;
  }
  state.heatmapRangeBySource[sourceKey] = range;
  saveUiState();
  return range;
}

function normalizeHeatmapColormapKey(colormapKey) {
  return Object.prototype.hasOwnProperty.call(HEATMAP_COLORMAPS, colormapKey)
    ? colormapKey
    : HEATMAP_COLORMAP_DEFAULT;
}

function getHeatmapColormapSpec(colormapKey = state.activeHeatmapColormap) {
  return HEATMAP_COLORMAPS[normalizeHeatmapColormapKey(colormapKey)]
    ?? HEATMAP_COLORMAPS[HEATMAP_COLORMAP_DEFAULT];
}

function getHeatmapColorscale(colormapKey = state.activeHeatmapColormap) {
  return getHeatmapColormapSpec(colormapKey).colorscale;
}

function cssPercent(value) {
  return `${Number(value).toFixed(3).replace(/\.?0+$/, "")}%`;
}

function buildHeatmapColorbarGradient(colormapKey, minPercent, maxPercent) {
  const colorscale = getHeatmapColorscale(colormapKey);
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

function renderHeatmapColormapOptions() {
  return HEATMAP_COLORMAP_ORDER.map((key) => {
    const spec = HEATMAP_COLORMAPS[key];
    const selected = normalizeHeatmapColormapKey(state.activeHeatmapColormap) === key ? " selected" : "";
    return `<option value="${key}"${selected}>${spec.label}</option>`;
  }).join("");
}

function updateHeatmapColorbarState(colorbar, sourceKey, zMin, zMax, activeRange) {
  if (!activeRange) {
    return;
  }
  state.activeHeatmapColormap = normalizeHeatmapColormapKey(state.activeHeatmapColormap);
  const step = getHeatmapRangeStepValue(sourceKey, zMin, zMax);
  const minValue = snapHeatmapControlValue(sourceKey, clamp(activeRange.min, zMin, zMax - step));
  const maxValue = snapHeatmapControlValue(sourceKey, clamp(activeRange.max, minValue + step, zMax));
  const minFraction = clamp01((minValue - zMin) / (zMax - zMin));
  const maxFraction = clamp01((maxValue - zMin) / (zMax - zMin));
  const minPercent = minFraction * 100;
  const maxPercent = maxFraction * 100;
  const track = colorbar.querySelector(".heatmap-colorbar-track");
  if (track) {
    track.style.background = buildHeatmapColorbarGradient(
      state.activeHeatmapColormap,
      minPercent,
      maxPercent
    );
  }
  const minInput = colorbar.querySelector(".heatmap-colorbar-input-min");
  if (minInput && document.activeElement !== minInput) {
    minInput.value = String(heatmapValueToSliderValue(sourceKey, minValue));
  }
  const maxInput = colorbar.querySelector(".heatmap-colorbar-input-max");
  if (maxInput && document.activeElement !== maxInput) {
    maxInput.value = String(heatmapValueToSliderValue(sourceKey, maxValue));
  }
  const minLabel = colorbar.querySelector(".heatmap-colorbar-min-label");
  if (minLabel) {
    minLabel.textContent = formatHeatmapColorbarValue(sourceKey, minValue);
  }
  const maxLabel = colorbar.querySelector(".heatmap-colorbar-max-label");
  if (maxLabel) {
    maxLabel.textContent = formatHeatmapColorbarValue(sourceKey, maxValue);
  }
  const colormapSelect = colorbar.querySelector(".heatmap-colormap-select");
  if (colormapSelect && document.activeElement !== colormapSelect) {
    colormapSelect.value = state.activeHeatmapColormap;
  }
}

function updateHeatmapPlotColors(range) {
  const plotDiv = document.getElementById("c-heatmap-plot");
  if (!plotDiv || !Array.isArray(plotDiv.data) || plotDiv.data.length === 0 || !range) {
    return;
  }
  Plotly.restyle(plotDiv, {
    colorscale: [getHeatmapColorscale()],
    zmin: [range.min],
    zmax: [range.max],
  });
}

function renderHeatmapColorbar(sourceKey, zMin, zMax, activeRange) {
  const colorbar = document.getElementById("heatmap-colorbar");
  if (!colorbar) {
    return;
  }
  const hasRange = Number.isFinite(zMin) && Number.isFinite(zMax) && zMax > zMin;
  colorbar.classList.toggle("hidden", !hasRange);
  if (!hasRange) {
    colorbar.innerHTML = "";
    return;
  }
  const range = activeRange ?? getHeatmapRangeForSource(sourceKey, zMin, zMax);
  const sliderMin = heatmapValueToSliderValue(sourceKey, zMin);
  const sliderMax = heatmapValueToSliderValue(sourceKey, zMax);
  colorbar.innerHTML = `
    <div class="heatmap-colorbar-row">
      <div class="heatmap-colorbar-range">
        <div class="heatmap-colorbar-labels">
          <span class="heatmap-colorbar-min-label">${formatHeatmapColorbarValue(sourceKey, range.min)}</span>
          <span class="heatmap-colorbar-max-label">${formatHeatmapColorbarValue(sourceKey, range.max)}</span>
        </div>
        <div class="heatmap-colorbar-control">
          <div class="heatmap-colorbar-track" aria-hidden="true"></div>
          <input
            class="heatmap-colorbar-input heatmap-colorbar-input-min"
            type="range"
            min="${sliderMin}"
            max="${sliderMax}"
            step="${getHeatmapSliderStep(sourceKey)}"
            value="${heatmapValueToSliderValue(sourceKey, range.min)}"
            aria-label="Heatmap minimum"
          >
          <input
            class="heatmap-colorbar-input heatmap-colorbar-input-max"
            type="range"
            min="${sliderMin}"
            max="${sliderMax}"
            step="${getHeatmapSliderStep(sourceKey)}"
            value="${heatmapValueToSliderValue(sourceKey, range.max)}"
            aria-label="Heatmap maximum"
          >
        </div>
      </div>
      <label class="heatmap-colormap-control">
        <select class="heatmap-colormap-select" aria-label="Heatmap colormap">
          ${renderHeatmapColormapOptions()}
        </select>
      </label>
    </div>
  `;
  updateHeatmapColorbarState(colorbar, sourceKey, zMin, zMax, range);
  const minInput = colorbar.querySelector(".heatmap-colorbar-input-min");
  minInput?.addEventListener("input", () => {
    const nextMin = heatmapSliderValueToValue(sourceKey, minInput.value);
    const nextRange = setHeatmapRangeForSource(sourceKey, zMin, zMax, { min: nextMin });
    updateHeatmapColorbarState(colorbar, sourceKey, zMin, zMax, nextRange);
    updateHeatmapPlotColors(nextRange);
  });
  const maxInput = colorbar.querySelector(".heatmap-colorbar-input-max");
  maxInput?.addEventListener("input", () => {
    const nextMax = heatmapSliderValueToValue(sourceKey, maxInput.value);
    const nextRange = setHeatmapRangeForSource(sourceKey, zMin, zMax, { max: nextMax });
    updateHeatmapColorbarState(colorbar, sourceKey, zMin, zMax, nextRange);
    updateHeatmapPlotColors(nextRange);
  });
  const colormapSelect = colorbar.querySelector(".heatmap-colormap-select");
  colormapSelect?.addEventListener("change", () => {
    state.activeHeatmapColormap = normalizeHeatmapColormapKey(colormapSelect.value);
    saveUiState();
    updateHeatmapColorbarState(colorbar, sourceKey, zMin, zMax, getHeatmapRangeForSource(sourceKey, zMin, zMax));
    updateHeatmapPlotColors(getHeatmapRangeForSource(sourceKey, zMin, zMax));
  });
}

function renderHeatmapPlot(plotId, sourceKey, { updateColorbar = true } = {}) {
  const plotDiv = document.getElementById(plotId);
  const { x, z, shapes, height, zMin, zMax } = buildHeatmapData(sourceKey);
  plotDiv.dataset.visibleNeuronCount = String(z.length);
  if (z.length === 0 || !Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    setPlotPanelEmpty(plotDiv, true);
    setTemporalDownloadEnabled(TEMPORAL_PLOT_DOWNLOADS.heatmap, false);
    renderHeatmapColorbar(null, null, null, null);
    return;
  }

  setPlotPanelEmpty(plotDiv, false);
  setTemporalDownloadEnabled(TEMPORAL_PLOT_DOWNLOADS.heatmap, true);
  const colorDomain = buildHeatmapColorDomain(sourceKey, zMin, zMax);
  const colorRange = getHeatmapRangeForSource(sourceKey, colorDomain.minValue, colorDomain.maxValue);
  Plotly.react(plotDiv, [{
    type: "heatmap",
    x,
    z,
    colorscale: getHeatmapColorscale(),
    zmin: colorRange.min,
    zmax: colorRange.max,
    showscale: false,
    hovertemplate: "Frame %{x}<br>value=%{z:.2f}<extra></extra>",
  }], {
    margin: HEATMAP_PLOT_MARGIN,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { visible: false, range: [0, Math.max(state.meta.trace_length - 1, 1)], fixedrange: true },
    yaxis: { visible: false, autorange: "reversed" },
    shapes,
    height,
  }, { responsive: true, displaylogo: false, displayModeBar: false });
  if (updateColorbar) {
    renderHeatmapColorbar(sourceKey, colorDomain.minValue, colorDomain.maxValue, colorRange);
  }
}

function updatePlots() {
  wireTemporalDownloadButtons();
  wireTraceSelectAllButton();
  ensureValidActiveTraceSource();
  ensureValidActiveTraceValueMode();
  const handleSourceSelect = (sourceKey) => {
    state.activeSignalSource = sourceKey;
    ensureValidActiveTraceValueMode();
    saveUiState();
    updatePlots();
  };
  const handleValueModeSelect = (valueMode) => {
    state.activeTraceValueMode = valueMode;
    saveUiState();
    updatePlots();
  };
  renderSourceToggle("heatmap-source-toggle", state.activeSignalSource, handleSourceSelect);
  renderTraceValueToggle("heatmap-value-toggle", state.activeTraceValueMode, handleValueModeSelect);
  renderSourceToggle("trace-source-toggle", state.activeSignalSource, handleSourceSelect);
  renderTraceValueToggle("trace-value-toggle", state.activeTraceValueMode, handleValueModeSelect);

  const effectiveSourceKey = getEffectiveTraceSourceKey();
  if (isTraceSourceAvailable(effectiveSourceKey)) {
    if (state.openSections.temporalHeatmap) {
      renderHeatmapPlot("c-heatmap-plot", effectiveSourceKey);
    }
    if (state.openSections.temporalTrace) {
      renderTraceOperationControls(effectiveSourceKey);
      renderTraceScaleControls(effectiveSourceKey);
      renderTracePlot("c-trace-plot", effectiveSourceKey);
    } else {
      hideTraceDeselectButton();
    }
  }
}
