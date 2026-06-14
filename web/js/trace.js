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

function getTraceDisplayStats(sourceKey, neuronId) {
  const cacheKey = `${sourceKey}:${getDffBaselinePercentile()}:${neuronId}`;
  if (state.traceDisplayStatsCache.has(cacheKey)) {
    return state.traceDisplayStatsCache.get(cacheKey);
  }
  const trace = getTraceSlice(sourceKey, neuronId);
  const values = [];
  for (let idx = 0; idx < trace.length; idx += 1) {
    const value = getTraceDisplayValue(sourceKey, neuronId, trace[idx]);
    if (Number.isFinite(value)) {
      values.push(value);
    }
  }
  values.sort((a, b) => a - b);
  const stats = {
    p05: percentileSorted(values, 5),
    p95: percentileSorted(values, 95),
  };
  state.traceDisplayStatsCache.set(cacheKey, stats);
  return stats;
}

const TRACE_PLOT_MARGIN = { l: 0, r: 0, t: 14, b: 8 };
const TRACE_ROW_HEIGHT_PX = 52;
const TRACE_VERTICAL_MARGIN_PX = 18;
const TRACE_ROW_STEP_FALLBACK = 1;
const TRACE_ROW_STEP_MIN = 1e-6;
const TRACE_ROW_RANGE_PAD_FRACTION = 0.08;
const TRACE_DFF_ROW_STEP_VALUE = 0.10;
const TRACE_ZERO_GUIDE_COLOR = "rgba(255, 255, 255, 0.16)";
const TRACE_DFF_THRESHOLD_VALUE = 0.05;
const TRACE_DFF_THRESHOLD_COLOR = "rgba(255, 255, 255, 0.28)";
const TRACE_DFF_THRESHOLD_LABEL = `${Math.round(TRACE_DFF_THRESHOLD_VALUE * 100)}%`;
const HEATMAP_ROW_HEIGHT_PX = 0.8;

function setPlotPanelEmpty(plotDiv, isEmpty) {
  plotDiv.closest(".plot-panel")?.classList.toggle("is-empty", isEmpty);
  if (isEmpty) {
    Plotly.purge(plotDiv);
    plotDiv.innerHTML = "";
  }
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
  return sortNeuronIdsByPosition(
    roi.neuronIds.filter((neuronId) => neuronIdPassesRoiSelection(neuronId, roi, filters))
  );
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
  if (isDynamicDffSource(sourceKey)) {
    return TRACE_DFF_ROW_STEP_VALUE;
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
  const showDffThreshold = sourceKey.startsWith("dff_");
  const traceLineColor = "rgba(255, 255, 255, 0.72)";
  let neuronCount = 0;
  let globalMinY = Infinity;
  let globalMaxY = -Infinity;
  const qcFilters = getActiveQcFilters();
  const roi = getActiveTemporalRoi();
  const neuronIds = getSelectedTraceNeuronIds(roi, qcFilters);
  const rowStep = getRawTraceRowStep(sourceKey, neuronIds);

  if (neuronIds.length > 0) {
    neuronCount = neuronIds.length;
    const x = [];
    const y = [];
    let groupMinY = Infinity;
    let groupMaxY = -Infinity;
    neuronIds.forEach((neuronId, localIdx) => {
      const trace = getTraceSlice(sourceKey, neuronId);
      const baseline = -(localIdx * rowStep);
      zeroGuide.x.push(0, nFrames - 1, NaN);
      zeroGuide.y.push(baseline, baseline, NaN);
      groupMinY = Math.min(groupMinY, baseline);
      groupMaxY = Math.max(groupMaxY, baseline);
      if (showDffThreshold) {
        const thresholdY = baseline + TRACE_DFF_THRESHOLD_VALUE;
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

  const height = neuronCount * TRACE_ROW_HEIGHT_PX + TRACE_VERTICAL_MARGIN_PX;
  const rangePadding = Math.max(rowStep * TRACE_ROW_RANGE_PAD_FRACTION, TRACE_ROW_STEP_MIN);
  const yRange = showDffThreshold && neuronCount > 0
    ? [
        -(neuronCount - 1) * rowStep - rowStep * 0.55,
        rowStep * 0.75,
      ]
    : Number.isFinite(globalMinY) && Number.isFinite(globalMaxY)
    ? [globalMinY - rangePadding, globalMaxY + rangePadding]
    : [-TRACE_ROW_STEP_FALLBACK, TRACE_ROW_STEP_FALLBACK];
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

function renderTracePlot(plotId, sourceKey) {
  const plotDiv = document.getElementById(plotId);
  const plotData = buildTracePlotData(sourceKey);
  const { traces, shapes, annotations, height, neuronCount, frameRange, yRange } = plotData;
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
    annotations,
    height,
    showlegend: false,
    hovermode: false,
  }, { responsive: true, displaylogo: false, displayModeBar: false });
}

function buildHeatmapData(sourceKey) {
  const nFrames = state.meta.trace_length;
  const x = Array.from({ length: nFrames }, (_, idx) => idx);
  const z = [];
  const verticalMarginPx = 16;
  let zMin = Infinity;
  let zMax = -Infinity;
  const qcFilters = getActiveQcFilters();
  const roi = getActiveTemporalRoi();
  const neuronIds = getHeatmapNeuronIds(roi, qcFilters);

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
  }

  return {
    x,
    z,
    shapes: [],
    height: z.length * HEATMAP_ROW_HEIGHT_PX + verticalMarginPx,
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
    xaxis: { visible: false, range: [0, Math.max(state.meta.trace_length - 1, 1)], fixedrange: true },
    yaxis: { visible: false, autorange: "reversed" },
    shapes,
    height,
  }, { responsive: true, displaylogo: false, displayModeBar: false });
  renderHeatmapColorbar(zMin, zMax);
}

function updatePlots() {
  ensureValidActiveTraceSource();
  ensureValidActiveTraceValueMode();
  renderSourceToggle("shared-source-toggle", state.activeSignalSource, (sourceKey) => {
    state.activeSignalSource = sourceKey;
    ensureValidActiveTraceValueMode();
    saveUiState();
    updatePlots();
  });
  renderTraceValueToggle("shared-value-toggle", state.activeTraceValueMode, (valueMode) => {
    state.activeTraceValueMode = valueMode;
    saveUiState();
    updatePlots();
  });
  const effectiveSourceKey = getEffectiveTraceSourceKey();
  if (isTraceSourceAvailable(effectiveSourceKey)) {
    renderTracePlot("c-trace-plot", effectiveSourceKey);
    renderHeatmapPlot("c-heatmap-plot", effectiveSourceKey);
  }
}
