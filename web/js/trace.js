function getTraceStats(sourceKey) {
  const baseSourceKey = getTraceBaseSourceKey(sourceKey);
  return state.points.trace_stats[baseSourceKey];
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
  return rawValue - getTraceSubtractValue(sourceKey, neuronId);
}

const ROI_STRIP_WIDTH_PX = 5;
const ROI_STRIP_GAP_PX = 2;
const TRACE_PLOT_MARGIN = { l: ROI_STRIP_WIDTH_PX + ROI_STRIP_GAP_PX, r: 8, t: 8, b: 8 };
const TRACE_ROW_HEIGHT_PX = 52;
const TRACE_ROI_GAP_PX = 16;
const TRACE_VERTICAL_MARGIN_PX = 18;
const TRACE_ROW_STEP_FALLBACK = 1;
const TRACE_ROW_GAP_FRACTION = 0.32;
const TRACE_ROW_RANGE_PAD_FRACTION = 0.08;

function setPlotPanelEmpty(plotDiv, isEmpty) {
  plotDiv.closest(".plot-panel")?.classList.toggle("is-empty", isEmpty);
  if (isEmpty) {
    Plotly.purge(plotDiv);
    plotDiv.innerHTML = "";
  }
}

function getSortedNeuronIds(roi, filters = getActiveQcFilters()) {
  return roi.neuronIds.filter((neuronId) => neuronIdPassesRoiSelection(neuronId, roi, filters)).sort((a, b) => {
    const aIndex = getPointIndexForNeuronId(a);
    const bIndex = getPointIndexForNeuronId(b);
    if (aIndex === null || bIndex === null) {
      return 0;
    }
    const dx = state.points.x[aIndex] - state.points.x[bIndex];
    return dx !== 0 ? dx : state.points.y[aIndex] - state.points.y[bIndex];
  });
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

function getRawTraceRowStep(sourceKey, neuronIds) {
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
  return Math.max((high - low) * 1.35, 1);
}

function buildTracePlotData(sourceKey) {
  const nFrames = state.meta.trace_length;
  const frames = Array.from({ length: nFrames }, (_, idx) => idx);
  const traces = [];
  const shapes = [];
  const traceLineColor = "rgba(255, 255, 255, 0.72)";
  let neuronCount = 0;
  let roiGroupCount = 0;
  let rowCursor = 0;
  let globalMinY = Infinity;
  let globalMaxY = -Infinity;
  const qcFilters = getActiveQcFilters();
  const selectedNeuronIds = state.rois.flatMap((roi) => getSortedNeuronIds(roi, qcFilters));
  const rowStep = getRawTraceRowStep(sourceKey, selectedNeuronIds);
  const rowGap = rowStep * TRACE_ROW_GAP_FRACTION;

  for (const roi of state.rois) {
    const neuronIds = getSortedNeuronIds(roi, qcFilters);
    if (neuronIds.length === 0) {
      continue;
    }
    roiGroupCount += 1;
    neuronCount += neuronIds.length;
    const x = [];
    const y = [];
    const groupStart = rowCursor;
    let groupMinY = Infinity;
    let groupMaxY = -Infinity;
    neuronIds.forEach((neuronId, localIdx) => {
      const trace = getTraceSlice(sourceKey, neuronId);
      const baseline = -(groupStart + localIdx * rowStep);
      for (let t = 0; t < nFrames; t += 1) {
        const yValue = baseline + getTraceDisplayValue(sourceKey, neuronId, trace[t]);
        x.push(frames[t]);
        y.push(yValue);
        groupMinY = Math.min(groupMinY, yValue);
        groupMaxY = Math.max(groupMaxY, yValue);
      }
      x.push(NaN);
      y.push(NaN);
    });
    traces.push({
      type: "scatter",
      mode: "lines",
      x,
      y,
      line: { color: traceLineColor, width: 1 },
      hoverinfo: "skip",
      showlegend: false,
    });
    const groupEnd = groupStart + Math.max(neuronIds.length - 1, 0) * rowStep;
    const yPadding = Math.max((groupMaxY - groupMinY) * 0.004, 0.02);
    globalMinY = Math.min(globalMinY, groupMinY - yPadding);
    globalMaxY = Math.max(globalMaxY, groupMaxY + yPadding);
    shapes.push({
      type: "rect",
      xref: "paper",
      xsizemode: "pixel",
      xanchor: 0,
      x0: -(ROI_STRIP_WIDTH_PX + ROI_STRIP_GAP_PX),
      x1: -ROI_STRIP_GAP_PX,
      yref: "y",
      y0: groupMinY - yPadding,
      y1: groupMaxY + yPadding,
      fillcolor: roi.color,
      line: { width: 0 },
      layer: "above",
    });
    rowCursor = groupEnd + rowStep + rowGap;
  }

  const groupGapHeight = Math.max(roiGroupCount - 1, 0) * TRACE_ROI_GAP_PX;
  const height = neuronCount * TRACE_ROW_HEIGHT_PX + groupGapHeight + TRACE_VERTICAL_MARGIN_PX;
  const rangePadding = Math.max(rowStep * TRACE_ROW_RANGE_PAD_FRACTION, 1);
  const yRange = Number.isFinite(globalMinY) && Number.isFinite(globalMaxY)
    ? [globalMinY - rangePadding, globalMaxY + rangePadding]
    : [-1, 1];
  return {
    traces,
    shapes,
    height,
    neuronCount,
    frameRange: [0, Math.max(nFrames - 1, 1)],
    yRange,
  };
}

function renderTracePlot(plotId, sourceKey) {
  const plotDiv = document.getElementById(plotId);
  const { traces, shapes, height, neuronCount, frameRange, yRange } = buildTracePlotData(sourceKey);
  plotDiv.dataset.visibleNeuronCount = String(neuronCount);
  if (traces.length === 0) {
    setPlotPanelEmpty(plotDiv, true);
    return;
  }

  setPlotPanelEmpty(plotDiv, false);
  Plotly.react(plotDiv, traces, {
    margin: TRACE_PLOT_MARGIN,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { visible: false, range: frameRange, fixedrange: true },
    yaxis: { visible: false, range: yRange, fixedrange: true },
    shapes,
    height,
    showlegend: false,
    hovermode: false,
  }, { responsive: true, displaylogo: false, displayModeBar: false });
}

function buildHeatmapData(sourceKey) {
  const nFrames = state.meta.trace_length;
  const x = Array.from({ length: nFrames }, (_, idx) => idx);
  const z = [];
  const shapes = [];
  const rowHeightPx = 8;
  const verticalMarginPx = 16;
  let rowCursor = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  const qcFilters = getActiveQcFilters();

  for (const roi of state.rois) {
    const neuronIds = getSortedNeuronIds(roi, qcFilters);
    if (neuronIds.length === 0) {
      continue;
    }
    const startRow = rowCursor;
    for (const neuronId of neuronIds) {
      const trace = getTraceSlice(sourceKey, neuronId);
      z.push(Array.from(trace, (value) => {
        const displayValue = getTraceDisplayValue(sourceKey, neuronId, value);
        if (Number.isFinite(displayValue)) {
          zMin = Math.min(zMin, displayValue);
          zMax = Math.max(zMax, displayValue);
        }
        return displayValue;
      }));
      rowCursor += 1;
    }
    const endRow = rowCursor - 1;
    shapes.push({
      type: "rect",
      xref: "paper",
      xsizemode: "pixel",
      xanchor: 0,
      x0: -(ROI_STRIP_WIDTH_PX + ROI_STRIP_GAP_PX),
      x1: -ROI_STRIP_GAP_PX,
      yref: "y",
      y0: startRow - 0.5,
      y1: endRow + 0.5,
      fillcolor: roi.color,
      line: { width: 0 },
    });
  }

  return {
    x,
    z,
    shapes,
    height: z.length * rowHeightPx + verticalMarginPx,
    zMin: Number.isFinite(zMin) ? zMin : null,
    zMax: Number.isFinite(zMax) ? zMax : null,
  };
}

function formatHeatmapColorbarValue(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }
  const absValue = Math.abs(value);
  if (absValue >= 1000) {
    return value.toPrecision(4).replace(/\.?0+e/, "e");
  }
  if (absValue >= 10) {
    return value.toFixed(1).replace(/\.0$/, "");
  }
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function renderHeatmapColorbar(zMin, zMax) {
  const colorbar = document.getElementById("heatmap-colorbar");
  if (!colorbar) {
    return;
  }
  const hasRange = Number.isFinite(zMin) && Number.isFinite(zMax);
  colorbar.classList.toggle("hidden", !hasRange);
  if (!hasRange) {
    colorbar.innerHTML = "";
    return;
  }
  colorbar.innerHTML = `
    <div class="heatmap-colorbar-track" aria-hidden="true"></div>
    <div class="heatmap-colorbar-labels">
      <span>${formatHeatmapColorbarValue(zMin)}</span>
      <span>${formatHeatmapColorbarValue(zMax)}</span>
    </div>
  `;
}

function renderHeatmapPlot(plotId, sourceKey) {
  const plotDiv = document.getElementById(plotId);
  const { x, z, shapes, height, zMin, zMax } = buildHeatmapData(sourceKey);
  plotDiv.dataset.visibleNeuronCount = String(z.length);
  if (z.length === 0 || !Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    setPlotPanelEmpty(plotDiv, true);
    renderHeatmapColorbar(null, null);
    return;
  }

  setPlotPanelEmpty(plotDiv, false);
  const zRangeMin = zMin;
  const zRangeMax = zMax > zMin ? zMax : zMin + 1;
  Plotly.react(plotDiv, [{
    type: "heatmap",
    x,
    z,
    colorscale: [
      [0, "rgb(0, 0, 0)"],
      [1, "rgb(255, 255, 255)"],
    ],
    zmin: zRangeMin,
    zmax: zRangeMax,
    showscale: false,
    hovertemplate: "Frame %{x}<br>value=%{z:.2f}<extra></extra>",
  }], {
    margin: TRACE_PLOT_MARGIN,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { visible: false },
    yaxis: { visible: false, autorange: "reversed" },
    shapes,
    height,
  }, { responsive: true, displaylogo: false, displayModeBar: false });
  renderHeatmapColorbar(zMin, zMax);
}

function updatePlots() {
  ensureValidActiveTraceSource();
  renderSourceToggle("shared-source-toggle", state.activeSignalSource, (sourceKey) => {
    state.activeSignalSource = sourceKey;
    saveUiState();
    updatePlots();
  });
  if (isTraceSourceAvailable(state.activeSignalSource)) {
    renderTracePlot("c-trace-plot", state.activeSignalSource);
    renderHeatmapPlot("c-heatmap-plot", state.activeSignalSource);
  }
}
