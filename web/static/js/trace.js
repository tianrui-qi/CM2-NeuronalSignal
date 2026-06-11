function getTraceStats(sourceKey) {
  return state.points.trace_stats[sourceKey];
}

function getTraceSlice(sourceKey, neuronId) {
  const traceBuffer = state.tracesBySource[sourceKey];
  const offset = neuronId * state.meta.trace_length;
  return traceBuffer.subarray(offset, offset + state.meta.trace_length);
}

const ROI_STRIP_WIDTH_PX = 5;
const ROI_STRIP_GAP_PX = 2;
const TRACE_PLOT_MARGIN = { l: ROI_STRIP_WIDTH_PX + ROI_STRIP_GAP_PX, r: 8, t: 8, b: 8 };
const TRACE_DFF_PERCENT_PER_UNIT = 100;
const TRACE_DFF_ROW_STEP_PERCENT = 500;
const TRACE_DFF_ROW_GAP_PERCENT = 160;
const TRACE_DFF_ROW_HEIGHT_PX = 52;
const TRACE_DFF_ROI_GAP_PX = 16;
const TRACE_DFF_VERTICAL_MARGIN_PX = 18;
const TRACE_DFF_BASELINE_EPS = 1e-6;
const TRACE_SCALE_GUIDE_HEIGHT_PX = 72;
const HEATMAP_COLORMAP_Z_MIN = -2.5;
const HEATMAP_COLORMAP_Z_MAX = 4.5;

let currentTraceScaleMeta = null;

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
  return Number.isFinite(value) ? value : null;
}

function getDffBaseline(sourceKey, neuronId) {
  const mean = getTraceStatValue(sourceKey, "mean", neuronId);
  return mean !== null && Math.abs(mean) > TRACE_DFF_BASELINE_EPS ? mean : null;
}

function traceValueToDffPercent(sourceKey, neuronId, value) {
  const baseline = getDffBaseline(sourceKey, neuronId);
  if (baseline === null) {
    return NaN;
  }
  return ((value - baseline) / baseline) * TRACE_DFF_PERCENT_PER_UNIT;
}

function addDffReferenceLines(shapes, baseline) {
  [
    { offset: -TRACE_DFF_PERCENT_PER_UNIT, dash: "dot", opacity: 0.16 },
    { offset: 0, dash: "solid", opacity: 0.24 },
    { offset: TRACE_DFF_PERCENT_PER_UNIT, dash: "dot", opacity: 0.16 },
  ].forEach(({ offset, dash, opacity }) => {
    shapes.push({
      type: "line",
      xref: "paper",
      x0: 0,
      x1: 1,
      yref: "y",
      y0: baseline + offset,
      y1: baseline + offset,
      line: { color: `rgba(255,255,255,${opacity})`, width: 1, dash },
      layer: "below",
    });
  });
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
      const baseline = -(groupStart + localIdx * TRACE_DFF_ROW_STEP_PERCENT);
      addDffReferenceLines(shapes, baseline);
      groupMinY = Math.min(groupMinY, baseline - TRACE_DFF_PERCENT_PER_UNIT);
      groupMaxY = Math.max(groupMaxY, baseline + TRACE_DFF_PERCENT_PER_UNIT);
      for (let t = 0; t < nFrames; t += 1) {
        const yValue = baseline + traceValueToDffPercent(sourceKey, neuronId, trace[t]);
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
    const groupEnd = groupStart + Math.max(neuronIds.length - 1, 0) * TRACE_DFF_ROW_STEP_PERCENT;
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
    rowCursor = groupEnd + TRACE_DFF_ROW_STEP_PERCENT + TRACE_DFF_ROW_GAP_PERCENT;
  }

  const groupGapHeight = Math.max(roiGroupCount - 1, 0) * TRACE_DFF_ROI_GAP_PX;
  const height = neuronCount * TRACE_DFF_ROW_HEIGHT_PX + groupGapHeight + TRACE_DFF_VERTICAL_MARGIN_PX;
  const rangePadding = TRACE_DFF_PERCENT_PER_UNIT * 0.25;
  const yRange = Number.isFinite(globalMinY) && Number.isFinite(globalMaxY)
    ? [globalMinY - rangePadding, globalMaxY + rangePadding]
    : [-TRACE_DFF_PERCENT_PER_UNIT, TRACE_DFF_PERCENT_PER_UNIT];
  return {
    traces,
    shapes,
    height,
    neuronCount,
    scaleMeta: {
      height,
      margin: TRACE_PLOT_MARGIN,
      yRange,
      frameRange: [0, Math.max(nFrames - 1, 1)],
      nFrames,
    },
  };
}

function renderTracePlot(plotId, sourceKey) {
  const plotDiv = document.getElementById(plotId);
  const { traces, shapes, height, neuronCount, scaleMeta } = buildTracePlotData(sourceKey);
  plotDiv.dataset.visibleNeuronCount = String(neuronCount);
  if (traces.length === 0) {
    setPlotPanelEmpty(plotDiv, true);
    currentTraceScaleMeta = null;
    return;
  }

  currentTraceScaleMeta = scaleMeta;
  setPlotPanelEmpty(plotDiv, false);
  Plotly.react(plotDiv, traces, {
    margin: TRACE_PLOT_MARGIN,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { visible: false, range: scaleMeta.frameRange, fixedrange: true },
    yaxis: { visible: false, range: scaleMeta.yRange, fixedrange: true },
    shapes,
    height,
    showlegend: false,
    hovermode: false,
  }, { responsive: true, displaylogo: false, displayModeBar: false });
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function buildHeatmapData(sourceKey) {
  const nFrames = state.meta.trace_length;
  const traceStats = getTraceStats(sourceKey);
  const x = Array.from({ length: nFrames }, (_, idx) => idx);
  const z = [];
  const shapes = [];
  const rowHeightPx = 8;
  const verticalMarginPx = 16;
  let rowCursor = 0;
  const qcFilters = getActiveQcFilters();

  for (const roi of state.rois) {
    const neuronIds = getSortedNeuronIds(roi, qcFilters);
    if (neuronIds.length === 0) {
      continue;
    }
    const startRow = rowCursor;
    for (const neuronId of neuronIds) {
      const trace = getTraceSlice(sourceKey, neuronId);
      const mean = Number.isFinite(traceStats.mean[neuronId]) ? traceStats.mean[neuronId] : 0;
      const std = Math.max(Number.isFinite(traceStats.std[neuronId]) ? traceStats.std[neuronId] : 1, 1e-6);
      z.push(Array.from(trace, (value) => clamp((value - mean) / std, HEATMAP_COLORMAP_Z_MIN, HEATMAP_COLORMAP_Z_MAX)));
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

  return { x, z, shapes, height: z.length * rowHeightPx + verticalMarginPx };
}

function renderHeatmapPlot(plotId, sourceKey) {
  const plotDiv = document.getElementById(plotId);
  const { x, z, shapes, height } = buildHeatmapData(sourceKey);
  plotDiv.dataset.visibleNeuronCount = String(z.length);
  if (z.length === 0) {
    setPlotPanelEmpty(plotDiv, true);
    return;
  }

  setPlotPanelEmpty(plotDiv, false);
  Plotly.react(plotDiv, [{
    type: "heatmap",
    x,
    z,
    colorscale: [
      [0, "rgb(0, 0, 0)"],
      [1, "rgb(255, 255, 255)"],
    ],
    zmin: HEATMAP_COLORMAP_Z_MIN,
    zmax: HEATMAP_COLORMAP_Z_MAX,
    showscale: false,
    hovertemplate: "Frame %{x}<br>z=%{z:.2f}<extra></extra>",
  }], {
    margin: TRACE_PLOT_MARGIN,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { visible: false },
    yaxis: { visible: false, autorange: "reversed" },
    shapes,
    height,
  }, { responsive: true, displaylogo: false, displayModeBar: false });
}

function chooseDffScalePercent(plotAreaHeight, yRangeSpan) {
  const candidates = [10, 20, 50, 100, 200, 500, 1000];
  return candidates.reduce((best, candidate) => {
    const candidatePx = (candidate / yRangeSpan) * plotAreaHeight;
    const bestPx = (best / yRangeSpan) * plotAreaHeight;
    return Math.abs(candidatePx - 22) < Math.abs(bestPx - 22) ? candidate : best;
  }, candidates[0]);
}

function chooseFrameScale(frameRangeSpan, plotAreaWidth) {
  const candidates = [10, 20, 50, 100, 200, 300, 500, 1000];
  const targetFrames = Math.max((72 / Math.max(plotAreaWidth, 1)) * frameRangeSpan, 1);
  const viable = candidates.filter((candidate) => candidate <= frameRangeSpan);
  if (viable.length === 0) {
    return Math.max(Math.round(frameRangeSpan), 1);
  }
  return viable.reduce((best, candidate) => (
    Math.abs(candidate - targetFrames) < Math.abs(best - targetFrames) ? candidate : best
  ), viable[0]);
}

function renderTraceScaleGuideFromPlot() {
  renderTraceScaleGuide("trace-scale-guide", currentTraceScaleMeta);
}

function renderTraceScaleGuide(containerId, scaleMeta) {
  const guide = document.getElementById(containerId);
  if (!guide) {
    return;
  }
  const panel = guide.closest(".plot-panel");
  if (!scaleMeta) {
    guide.innerHTML = "";
    panel?.classList.add("is-empty");
    return;
  }

  panel?.classList.remove("is-empty");
  const width = Math.max(guide.clientWidth, 240);
  const plotAreaWidth = Math.max(width - scaleMeta.margin.l - scaleMeta.margin.r, 1);
  const plotAreaHeight = Math.max(scaleMeta.height - scaleMeta.margin.t - scaleMeta.margin.b, 1);
  const yRangeSpan = Math.max(Math.abs(scaleMeta.yRange[1] - scaleMeta.yRange[0]), 1);
  const frameRangeSpan = Math.max(scaleMeta.frameRange[1] - scaleMeta.frameRange[0], 1);
  const dffScale = chooseDffScalePercent(plotAreaHeight, yRangeSpan);
  const dffBarHeight = (dffScale / yRangeSpan) * plotAreaHeight;
  const frameScale = chooseFrameScale(frameRangeSpan, plotAreaWidth);
  const frameBarWidth = (frameScale / frameRangeSpan) * plotAreaWidth;
  const stripLeft = TRACE_PLOT_MARGIN.l - ROI_STRIP_GAP_PX - ROI_STRIP_WIDTH_PX;
  const contentLeft = TRACE_PLOT_MARGIN.l;
  const rowY = 28;
  const dffX = Math.max(stripLeft, 1);
  const frameX0 = Math.min(contentLeft + 76, width - frameBarWidth - 8);
  const frameX1 = frameX0 + frameBarWidth;
  const colormapX0 = contentLeft;
  const colormapWidth = Math.min(92, Math.max(width - contentLeft - 44, 48));
  const labelColor = "rgba(255,255,255,0.72)";
  const lineColor = "rgba(255,255,255,0.84)";

  guide.innerHTML = `
    <svg class="trace-scale-svg" viewBox="0 0 ${width} ${TRACE_SCALE_GUIDE_HEIGHT_PX}" width="100%" height="${TRACE_SCALE_GUIDE_HEIGHT_PX}" aria-hidden="true">
      <defs>
        <linearGradient id="heatmap-gray-scale" x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stop-color="rgb(0,0,0)" />
          <stop offset="100%" stop-color="rgb(255,255,255)" />
        </linearGradient>
      </defs>
      <line x1="0" x2="${width}" y1="0.5" y2="0.5" stroke="rgba(255,255,255,0.14)" stroke-width="1" />
      <line x1="${dffX}" x2="${dffX}" y1="${rowY - dffBarHeight}" y2="${rowY}" stroke="${lineColor}" stroke-width="1.5" />
      <line x1="${dffX - 4}" x2="${dffX + 4}" y1="${rowY - dffBarHeight}" y2="${rowY - dffBarHeight}" stroke="${lineColor}" stroke-width="1.5" />
      <line x1="${dffX - 4}" x2="${dffX + 4}" y1="${rowY}" y2="${rowY}" stroke="${lineColor}" stroke-width="1.5" />
      <text x="${dffX + 10}" y="${rowY - dffBarHeight / 2 + 4}" fill="${labelColor}" font-size="11">${dffScale}% ΔF/F</text>
      <line x1="${frameX0}" x2="${frameX1}" y1="${rowY}" y2="${rowY}" stroke="${lineColor}" stroke-width="1.5" />
      <line x1="${frameX0}" x2="${frameX0}" y1="${rowY - 4}" y2="${rowY + 4}" stroke="${lineColor}" stroke-width="1.5" />
      <line x1="${frameX1}" x2="${frameX1}" y1="${rowY - 4}" y2="${rowY + 4}" stroke="${lineColor}" stroke-width="1.5" />
      <text x="${frameX0}" y="${rowY + 16}" fill="${labelColor}" font-size="11">${frameScale} frames</text>
      <rect x="${colormapX0}" y="52" width="${colormapWidth}" height="8" fill="url(#heatmap-gray-scale)" stroke="rgba(255,255,255,0.18)" stroke-width="1" />
      <text x="${colormapX0 + colormapWidth + 8}" y="60" fill="${labelColor}" font-size="11">${HEATMAP_COLORMAP_Z_MIN} to ${HEATMAP_COLORMAP_Z_MAX} z</text>
    </svg>
  `;
}

function updatePlots() {
  ensureValidActiveTraceSource();
  renderSourceToggle("shared-source-toggle", state.activeSignalSource, (sourceKey) => {
    state.activeSignalSource = sourceKey;
    saveUiState();
    updatePlots();
  });
  if (state.meta.trace_sources[state.activeSignalSource]) {
    renderTracePlot("c-trace-plot", state.activeSignalSource);
    renderHeatmapPlot("c-heatmap-plot", state.activeSignalSource);
    renderTraceScaleGuideFromPlot();
  }
}
