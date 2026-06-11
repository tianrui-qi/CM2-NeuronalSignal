const STORAGE_KEY = "cm2_web_roi_state_v2";
const DEFAULT_ROI_COLORS = [
  "#f2559c",
  "#41a85f",
  "#4c9ee3",
  "#c6802b",
  "#7b5fd2",
  "#d64c3b",
  "#13a89e",
  "#e5b33c",
  "#9a6be8",
  "#ff7a45",
  "#6ecff6",
  "#8ac926",
  "#c44d9d",
  "#8b6f47",
];
const UNASSIGNED_POINT_COLOR = "rgba(248,248,248,0.62)";
const UNASSIGNED_LINE_COLOR = "rgba(32,27,22,0.28)";
const TRACE_SOURCE_ORDER = ["c", "c_plus_yra", "yra"];
const TRACE_SOURCE_UI_LABELS = { c: "C", yra: "YrA", c_plus_yra: "C + YrA" };
const WORKFLOW_SECTIONS = ["qc", "region", "roi", "trace"];
const DEFAULT_OPEN_SECTIONS = { qc: true, region: true, roi: true, trace: true };
const BLUEPRINT_NONE = "none";
const BLUEPRINT_COLOR_SCALE = "RdBu";
const BLUEPRINT_SIGMA_RANGE = 3;
const BLUEPRINT_STATS_SIGMA_RANGE = 3.5;
const QC_RANGE_MIN_Z = -BLUEPRINT_STATS_SIGMA_RANGE;
const QC_RANGE_MAX_Z = BLUEPRINT_STATS_SIGMA_RANGE;
const QC_RANGE_STEP_Z = 0.1;
const QC_RANGE_EPS = 1e-6;
const QC_SLIDER_UNITS_PER_Z = 10000;
const QC_SLIDER_MIN = 0;
const QC_SLIDER_MAX = Math.round((QC_RANGE_MAX_Z - QC_RANGE_MIN_Z) * QC_SLIDER_UNITS_PER_Z);
const OVERLAY_WIDTH_MIN = 340;
const OVERLAY_WIDTH_MAX = 720;
const OVERLAY_VIEWPORT_MARGIN = 72;
const REGION_LINE_COLOR = "rgba(247,241,231,0.95)";
const REGION_DRAFT_COLOR = "rgba(80,190,230,0.95)";
const BLUEPRINT_METRIC_SPECS = [
  { key: "r_value", label: "r_value", scale: "linear" },
  { key: "snr", label: "SNR", scale: "log" },
  { key: "bl", label: "bl", scale: "linear" },
  { key: "lam", label: "lambda", scale: "log" },
  { key: "neurons_sn", label: "neurons_sn", scale: "log" },
  { key: "g_0", label: "g_0", scale: "linear" },
  { key: "g_1", label: "g_1", scale: "linear" },
  { key: "t_peak", label: "t_peak", scale: "linear" },
  { key: "t_half", label: "t_half", scale: "linear" },
];

const state = {
  meta: null,
  points: null,
  tracesBySource: {},
  pointIndexByNeuronId: new Map(),
  rois: [],
  activeRoiId: null,
  activeSignalSource: "c",
  activeBlueprintMetric: BLUEPRINT_NONE,
  qcRanges: {},
  regionPolygons: [],
  regionDraft: { active: false, points: [], polygons: [] },
  regionPreview: null,
  activeWorkflowSection: "qc",
  openSections: { ...DEFAULT_OPEN_SECTIONS },
  overlayWidth: null,
  mapPlotReady: false,
  mapViewportKey: null,
  mapViewRange: null,
};

function setStatus(message, isError = false) {
  const el = document.getElementById("status-banner");
  el.textContent = message ?? "";
  el.classList.toggle("hidden", !message);
  el.classList.toggle("error", isError);
}

function getOverlayWidthBounds() {
  const viewportMax = Math.max(OVERLAY_WIDTH_MIN, window.innerWidth - OVERLAY_VIEWPORT_MARGIN);
  const max = Math.min(OVERLAY_WIDTH_MAX, viewportMax);
  return { min: Math.min(OVERLAY_WIDTH_MIN, max), max };
}

function normalizeOverlayWidth(width) {
  const scalar = Number(width);
  if (!Number.isFinite(scalar)) {
    return null;
  }
  const { min, max } = getOverlayWidthBounds();
  return clamp(scalar, min, max);
}

function applyOverlayWidth() {
  const overlay = document.querySelector(".overlay-stack");
  if (!overlay) {
    return;
  }
  if (window.innerWidth <= 800 || state.overlayWidth === null) {
    overlay.style.width = "";
    return;
  }
  state.overlayWidth = normalizeOverlayWidth(state.overlayWidth);
  overlay.style.width = `${state.overlayWidth}px`;
}

function schedulePanelPlotResize() {
  if (schedulePanelPlotResize.queued) {
    return;
  }
  schedulePanelPlotResize.queued = true;
  requestAnimationFrame(() => {
    schedulePanelPlotResize.queued = false;
    for (const id of ["blueprint-stats-plot", "c-trace-plot", "c-heatmap-plot"]) {
      const plot = document.getElementById(id);
      if (plot && plot.offsetWidth > 0 && plot.offsetHeight > 0) {
        try {
          Plotly.Plots.resize(plot);
        } catch (error) {
          console.warn(error);
        }
      }
    }
    if (typeof renderTraceScaleGuideFromPlot === "function") {
      renderTraceScaleGuideFromPlot();
    }
  });
}

function quantizedFloat(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "nan";
}

function buildNeuronHoverText(index) {
  const p = state.points;
  const m = p.metrics;
  return [
    `neuron ${p.id[index]}`,
    `x=${p.x[index]}, y=${p.y[index]}`,
    `snr=${quantizedFloat(m.snr?.[index])}`,
    `r=${quantizedFloat(m.r_value?.[index])}`,
    `g0=${quantizedFloat(m.g_0?.[index])}`,
    `g1=${quantizedFloat(m.g_1?.[index])}`,
    `t_peak=${quantizedFloat(m.t_peak?.[index], 1)} ms`,
    `t_1/2=${quantizedFloat(m.t_half?.[index], 1)} ms`,
  ].join("<br>");
}

function makeRoi(name = null, color = null, neuronIds = []) {
  const roiIndex = state.rois.length;
  return {
    id: `roi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: name ?? `ROI ${roiIndex + 1}`,
    color: color ?? DEFAULT_ROI_COLORS[roiIndex % DEFAULT_ROI_COLORS.length],
    box: null,
    neuronIds: [...new Set(neuronIds)],
  };
}

function getRoiById(roiId) {
  return state.rois.find((roi) => roi.id === roiId) ?? null;
}

function rebuildPointIndex() {
  state.pointIndexByNeuronId = new Map(state.points.id.map((id, index) => [id, index]));
}

function getPointIndexForNeuronId(neuronId) {
  return state.pointIndexByNeuronId.get(neuronId) ?? null;
}

function findAssignedRoiId(neuronId) {
  for (const roi of state.rois) {
    if (roi.neuronIds.includes(neuronId)) {
      return roi.id;
    }
  }
  return null;
}

function removeNeuronFromAllRois(neuronId) {
  for (const roi of state.rois) {
    roi.neuronIds = roi.neuronIds.filter((id) => id !== neuronId);
  }
}

function refreshRoiViews({ includePlots = false } = {}) {
  if (typeof pruneRoiSelectionsToBoxes === "function") {
    pruneRoiSelectionsToBoxes();
  }
  saveUiState();
  renderMap();
  renderRoiWorkflowPanel();
  renderWorkflowSummaries();
  if (includePlots) {
    updatePlots();
  }
}

function activateRoi(roiId) {
  state.activeRoiId = state.activeRoiId === roiId ? null : getRoiById(roiId)?.id ?? null;
  refreshRoiViews();
}

function addRoiWithColor(color, { box = null } = {}) {
  const roi = makeRoi(null, color);
  roi.box = normalizeRoiBox(box);
  state.rois.push(roi);
  state.activeRoiId = null;
  refreshRoiViews({ includePlots: true });
}

function normalizeRoiBox(box) {
  if (!box || typeof box !== "object") {
    return null;
  }
  const x = Number(box.x);
  const y = Number(box.y);
  const width = Number(box.width);
  const height = Number(box.height);
  if (
    !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(width)
    || !Number.isFinite(height)
    || width <= 0
    || height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function snapQcZ(value) {
  const scalar = Number(value);
  if (!Number.isFinite(scalar)) {
    return scalar;
  }
  return Number((Math.round(scalar / QC_RANGE_STEP_Z) * QC_RANGE_STEP_Z).toFixed(1));
}

function clampRawQcZ(value) {
  return clamp(Number(value), QC_RANGE_MIN_Z, QC_RANGE_MAX_Z);
}

function clampQcZ(value, { snap = false } = {}) {
  const raw = clampRawQcZ(value);
  if (!Number.isFinite(raw)) {
    return raw;
  }
  const next = snap ? snapQcZ(raw) : raw;
  return Number(clamp(next, QC_RANGE_MIN_Z, QC_RANGE_MAX_Z).toFixed(6));
}

function defaultQcRange() {
  return { lowerZ: QC_RANGE_MIN_Z, upperZ: QC_RANGE_MAX_Z };
}

function normalizeQcRange(range) {
  if (!range || typeof range !== "object") {
    return defaultQcRange();
  }
  let lowerZ = clampQcZ(range.lowerZ);
  let upperZ = clampQcZ(range.upperZ);
  if (!Number.isFinite(lowerZ)) {
    lowerZ = QC_RANGE_MIN_Z;
  }
  if (!Number.isFinite(upperZ)) {
    upperZ = QC_RANGE_MAX_Z;
  }
  if (lowerZ > upperZ) {
    [lowerZ, upperZ] = [upperZ, lowerZ];
  }
  return { lowerZ, upperZ };
}

function normalizeQcRanges(ranges) {
  const normalized = {};
  if (!ranges || typeof ranges !== "object") {
    return normalized;
  }
  for (const spec of getAvailableBlueprintSpecs()) {
    if (Object.prototype.hasOwnProperty.call(ranges, spec.key)) {
      normalized[spec.key] = normalizeQcRange(ranges[spec.key]);
    }
  }
  return normalized;
}

function getQcRange(metricKey) {
  return normalizeQcRange(state.qcRanges[metricKey]);
}

function setQcRange(metricKey, nextRange) {
  state.qcRanges[metricKey] = normalizeQcRange(nextRange);
}

function isQcRangeActive(range) {
  return (
    range.lowerZ > QC_RANGE_MIN_Z + QC_RANGE_EPS
    || range.upperZ < QC_RANGE_MAX_Z - QC_RANGE_EPS
  );
}

function normalizeOpenSections(openSections) {
  const normalized = { ...DEFAULT_OPEN_SECTIONS };
  if (!openSections || typeof openSections !== "object") {
    return normalized;
  }
  if (typeof openSections.boundary === "boolean") {
    normalized.region = openSections.boundary;
  }
  for (const section of WORKFLOW_SECTIONS) {
    if (typeof openSections[section] === "boolean") {
      normalized[section] = openSections[section];
    }
  }
  return normalized;
}

function normalizeWorkflowSection(section, fallback = "trace") {
  if (WORKFLOW_SECTIONS.includes(section)) {
    return section;
  }
  if (section === "footprint") {
    return "qc";
  }
  if (section === "boundary") {
    return "region";
  }
  return fallback;
}

function saveUiState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      rois: state.rois,
      activeRoiId: null,
      activeSignalSource: state.activeSignalSource,
      activeBlueprintMetric: state.activeBlueprintMetric,
      qcRanges: state.qcRanges,
      regionPolygons: state.regionPolygons,
      activeWorkflowSection: state.activeWorkflowSection,
      openSections: state.openSections,
      overlayWidth: state.overlayWidth,
    })
  );
}

function loadUiState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.rois)) {
      return false;
    }
    const validNeuronIds = new Set(state.points.id);
    const seenNeurons = new Set();
    state.rois = parsed.rois.map((roi, idx) => ({
      id: typeof roi.id === "string" ? roi.id : makeRoi().id,
      name: typeof roi.name === "string" && roi.name.trim() ? roi.name : `ROI ${idx + 1}`,
      color: typeof roi.color === "string" ? roi.color : DEFAULT_ROI_COLORS[idx % DEFAULT_ROI_COLORS.length],
      box: normalizeRoiBox(roi.box),
      neuronIds: Array.isArray(roi.neuronIds)
        ? roi.neuronIds.filter((id) => {
            const keep = validNeuronIds.has(id) && !seenNeurons.has(id);
            if (keep) {
              seenNeurons.add(id);
            }
            return keep;
          })
        : [],
    }));
    state.activeRoiId = null;
    if (TRACE_SOURCE_ORDER.includes(parsed.activeSignalSource)) {
      state.activeSignalSource = parsed.activeSignalSource;
    }
    if (isAvailableBlueprintMetric(parsed.activeBlueprintMetric)) {
      state.activeBlueprintMetric = parsed.activeBlueprintMetric;
    }
    state.qcRanges = normalizeQcRanges(parsed.qcRanges);
    state.activeWorkflowSection = normalizeWorkflowSection(
      parsed.activeWorkflowSection ?? parsed.activePanelTab,
      state.activeWorkflowSection
    );
    state.openSections = normalizeOpenSections(parsed.openSections);
    state.regionPolygons = normalizeRegionPolygons(parsed.regionPolygons ?? parsed.regionPolygon);
    state.regionDraft = { active: false, points: [], polygons: [] };
    state.overlayWidth = normalizeOverlayWidth(parsed.overlayWidth);
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function getAvailableTraceSourceKeys() {
  return TRACE_SOURCE_ORDER.filter((sourceKey) => Boolean(state.meta?.trace_sources?.[sourceKey]));
}

function getAvailableBlueprintSpecs() {
  if (!state.points?.metrics) {
    return [];
  }
  return BLUEPRINT_METRIC_SPECS.filter((spec) => Array.isArray(state.points.metrics[spec.key]));
}

function isAvailableBlueprintMetric(metricKey) {
  return metricKey === BLUEPRINT_NONE || getAvailableBlueprintSpecs().some((spec) => spec.key === metricKey);
}

function getActiveBlueprintSpec() {
  if (state.activeBlueprintMetric === BLUEPRINT_NONE) {
    return null;
  }
  return getAvailableBlueprintSpecs().find((spec) => spec.key === state.activeBlueprintMetric) ?? null;
}

function getBlueprintSpecByKey(metricKey) {
  return getAvailableBlueprintSpecs().find((spec) => spec.key === metricKey) ?? null;
}

function getRenderedBlueprintSpec() {
  return getActiveBlueprintSpec();
}

function ensureValidActiveTraceSource() {
  const available = getAvailableTraceSourceKeys();
  if (available.length && !available.includes(state.activeSignalSource)) {
    state.activeSignalSource = available[0];
  }
}

function ensureValidActiveBlueprintMetric() {
  if (!isAvailableBlueprintMetric(state.activeBlueprintMetric)) {
    state.activeBlueprintMetric = BLUEPRINT_NONE;
  }
}

function ensureValidQcRanges() {
  state.qcRanges = normalizeQcRanges(state.qcRanges);
}

function ensureValidActiveRoi() {
  if (state.activeRoiId && !getRoiById(state.activeRoiId)) {
    state.activeRoiId = null;
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function interpolateRgb(a, b, t) {
  const f = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function rgbString(rgb, alpha = 1) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function blueprintColorForValue(value, mean, std) {
  const z = clamp01((value - (mean - BLUEPRINT_SIGMA_RANGE * std)) / (2 * BLUEPRINT_SIGMA_RANGE * std));
  const red = [202, 0, 32];
  const mid = [247, 247, 247];
  const blue = [5, 113, 176];
  if (z <= 0.5) {
    return rgbString(interpolateRgb(red, mid, z / 0.5), 0.95);
  }
  return rgbString(interpolateRgb(mid, blue, (z - 0.5) / 0.5), 0.95);
}

function gaussianPdf(x, mean, std) {
  const safeStd = Math.max(std, 1e-12);
  return Math.exp(-0.5 * ((x - mean) / safeStd) ** 2) / (safeStd * Math.sqrt(2 * Math.PI));
}

function buildHistogram(metricValues, stats, binCount = 72) {
  const finite = metricValues.filter((value) => Number.isFinite(value));
  if (!finite.length) {
    return null;
  }
  const viewMin = stats.mean - BLUEPRINT_STATS_SIGMA_RANGE * stats.std;
  const viewMax = stats.mean + BLUEPRINT_STATS_SIGMA_RANGE * stats.std;
  const span = Math.max(viewMax - viewMin, 1e-9);
  const binWidth = span / binCount;
  const counts = new Array(binCount).fill(0);
  for (const value of finite) {
    if (value < viewMin || value > viewMax) {
      continue;
    }
    const bin = Math.max(0, Math.min(binCount - 1, Math.floor((value - viewMin) / binWidth)));
    counts[bin] += 1;
  }
  const centers = counts.map((_, idx) => viewMin + (idx + 0.5) * binWidth);
  return { centers, counts, binWidth, viewMin, viewMax, totalCount: finite.length };
}

function blueprintAxisTitle(spec) {
  if (spec.scale === "log") {
    return `log10(${spec.label})`;
  }
  if (spec.key === "t_peak") {
    return "t_peak (ms)";
  }
  if (spec.key === "t_half") {
    return "t_1/2 (ms)";
  }
  return spec.label;
}

function scheduleBlueprintStatsReflow() {
  const plot = document.getElementById("blueprint-stats-plot");
  if (!plot || plot.classList.contains("hidden")) {
    return;
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!plot.isConnected || plot.offsetWidth <= 0 || plot.offsetHeight <= 0) {
        return;
      }
      const spec = getActiveBlueprintSpec();
      if (!spec) {
        return;
      }
      const { values, stats } = buildBlueprintMetricValues(spec);
      const histogram = buildHistogram(values, stats);
      if (!histogram) {
        return;
      }
      try {
        Promise.resolve(Plotly.Plots.resize(plot)).then(() => {
          Plotly.relayout(plot, {
            "xaxis.autorange": false,
            "xaxis.range": [histogram.viewMin, histogram.viewMax],
            "yaxis.autorange": false,
          });
        });
      } catch (error) {
        console.warn(error);
      }
    });
  });
}
function computeMapHeight() {
  return window.innerHeight;
}

function computeMapCoverRanges() {
  const fullWidth = Number(state.meta.full_width);
  const fullHeight = Number(state.meta.full_height);
  const viewportWidth = Math.max(window.innerWidth, 1);
  const viewportHeight = Math.max(computeMapHeight(), 1);
  const viewportAspect = viewportWidth / viewportHeight;
  const imageAspect = fullWidth / fullHeight;

  let viewWidth;
  let viewHeight;
  if (viewportAspect >= imageAspect) {
    viewWidth = fullWidth;
    viewHeight = fullWidth / viewportAspect;
  } else {
    viewHeight = fullHeight;
    viewWidth = fullHeight * viewportAspect;
  }

  const centerX = fullWidth / 2;
  const centerY = fullHeight / 2;
  return {
    xRange: [centerX - viewWidth / 2, centerX + viewWidth / 2],
    yRange: [centerY + viewHeight / 2, centerY - viewHeight / 2],
  };
}

function normalizeAxisRange(range) {
  if (!Array.isArray(range) || range.length < 2) {
    return null;
  }
  const start = Number(range[0]);
  const end = Number(range[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
    return null;
  }
  return [start, end];
}

function getCurrentMapViewRange() {
  const plotDiv = document.getElementById("map-plot");
  const xRange = normalizeAxisRange(plotDiv?._fullLayout?.xaxis?.range);
  const yRange = normalizeAxisRange(plotDiv?._fullLayout?.yaxis?.range);
  if (!xRange || !yRange) {
    return null;
  }
  return { xRange, yRange };
}

function rememberCurrentMapViewRange() {
  const range = getCurrentMapViewRange();
  if (range) {
    state.mapViewRange = range;
  }
}

function clearMapViewRange() {
  state.mapViewRange = null;
}
