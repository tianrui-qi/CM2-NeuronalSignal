function metricToBlueprintSpace(rawValue, scale, fallback) {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  if (scale === "linear") {
    return value;
  }
  if (scale === "log") {
    if (value > 0) {
      return Math.log10(value);
    }
    return fallback;
  }
  return value;
}

function computeMetricStats(values, scale) {
  const finite = values.map(Number).filter((value) => Number.isFinite(value));
  if (!finite.length) {
    return { mean: 0, std: 1, floorSpace: 0 };
  }

  let fitValues = finite;
  let floorSpace = finite[0];
  if (scale === "log") {
    const positive = finite.filter((value) => value > 0);
    if (positive.length) {
      const floorValue = Math.min(...positive);
      floorSpace = Math.log10(floorValue);
      fitValues = positive.map((value) => Math.log10(value));
    } else {
      fitValues = [0];
      floorSpace = 0;
    }
  }

  const mean = fitValues.reduce((acc, value) => acc + value, 0) / fitValues.length;
  const variance = fitValues.reduce((acc, value) => acc + (value - mean) ** 2, 0) / fitValues.length;
  const std = Math.sqrt(Math.max(variance, 0));
  return {
    mean: Number.isFinite(mean) ? mean : 0,
    std: Number.isFinite(std) && std > 0 ? std : 1,
    floorSpace,
  };
}

function buildBlueprintMetricValues(spec) {
  const rawValues = state.points.metrics[spec.key] ?? [];
  const stats = computeMetricStats(rawValues, spec.scale);
  const fallback = spec.scale === "log" ? stats.floorSpace : stats.mean;
  const values = rawValues.map((value) => metricToBlueprintSpace(value, spec.scale, fallback));
  return { values, stats };
}

function getActiveQcFilters() {
  return getAvailableBlueprintSpecs()
    .map((spec) => {
      const range = getQcRange(spec.key);
      if (!isQcRangeActive(range)) {
        return null;
      }
      const { values, stats } = buildBlueprintMetricValues(spec);
      const lower = range.lowerZ <= QC_RANGE_MIN_Z + QC_RANGE_EPS
        ? -Infinity
        : stats.mean + range.lowerZ * stats.std;
      const upper = range.upperZ >= QC_RANGE_MAX_Z - QC_RANGE_EPS
        ? Infinity
        : stats.mean + range.upperZ * stats.std;
      return { values, lower, upper };
    })
    .filter(Boolean);
}

function pointIndexPassesQc(pointIndex, filters = getActiveQcFilters()) {
  if (!pointIndexPassesRegion(pointIndex)) {
    return false;
  }
  return pointIndexPassesMetricFilters(pointIndex, filters);
}

function pointIndexPassesMetricFilters(pointIndex, filters = getActiveQcFilters()) {
  for (const filter of filters) {
    const value = filter.values[pointIndex];
    if (!Number.isFinite(value) || value < filter.lower || value >= filter.upper) {
      return false;
    }
  }
  return true;
}

function neuronIdPassesQc(neuronId, filters = getActiveQcFilters()) {
  const pointIndex = getPointIndexForNeuronId(neuronId);
  return pointIndex !== null && pointIndexPassesQc(pointIndex, filters);
}

function neuronIdVisibleOnMap(neuronId, filters = getActiveQcFilters()) {
  const pointIndex = getPointIndexForNeuronId(neuronId);
  return pointIndex !== null && pointIndexPassesQc(pointIndex, filters);
}

function getVisiblePointIndices() {
  const filters = getActiveQcFilters();
  const scope = getActiveRegionDisplayScope();
  const usesMetricFilters = scope.countMode !== "raw";
  return state.points.id
    .map((_, index) => index)
    .filter((index) => (
      pointIndexPassesRegionDisplayScope(index, scope)
      && (!usesMetricFilters || pointIndexPassesMetricFilters(index, filters))
    ));
}

function getBlueprintMetricLabel(metricKey) {
  if (metricKey === BLUEPRINT_NONE) {
    return "None";
  }
  return getBlueprintSpecByKey(metricKey)?.label ?? metricKey;
}

function formatQcZValue(value) {
  if (Math.abs(value) < QC_RANGE_STEP_Z / 2) {
    return "0.0";
  }
  const snapped = snapQcZ(value);
  if (Math.abs(value - snapped) < QC_RANGE_EPS) {
    return `${snapped > 0 ? "+" : ""}${snapped.toFixed(1)}`;
  }
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function isLowerQcUnbounded(value) {
  return value <= QC_RANGE_MIN_Z + QC_RANGE_EPS;
}

function isUpperQcUnbounded(value) {
  return value >= QC_RANGE_MAX_Z - QC_RANGE_EPS;
}

function formatQcBound(value, side) {
  if (side === "lower" && isLowerQcUnbounded(value)) {
    return "N/A";
  }
  if (side === "upper" && isUpperQcUnbounded(value)) {
    return "N/A";
  }
  return `${formatQcZValue(value)} STD`;
}

function closeBlueprintMenu() {
  const menu = document.getElementById("blueprint-menu");
  const button = document.getElementById("blueprint-select");
  const section = document.getElementById("qc-section");
  menu?.classList.add("hidden");
  button?.setAttribute("aria-expanded", "false");
  section?.classList.remove("menu-open");
}

function toggleBlueprintMenu() {
  const menu = document.getElementById("blueprint-menu");
  const button = document.getElementById("blueprint-select");
  const section = document.getElementById("qc-section");
  if (!menu || !button) {
    return;
  }
  const nextOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !nextOpen);
  button.setAttribute("aria-expanded", String(nextOpen));
  section?.classList.toggle("menu-open", nextOpen);
}

function selectBlueprintMetric(metricKey) {
  state.activeBlueprintMetric = isAvailableBlueprintMetric(metricKey) ? metricKey : BLUEPRINT_NONE;
  state.activeWorkflowSection = "qc";
  state.openSections.qc = true;
  ensureValidActiveBlueprintMetric();
  saveUiState();
  renderWorkflowChrome();
  renderBlueprintControl();
  renderBlueprintStats();
  renderMap();
}

function renderBlueprintControl() {
  const button = document.getElementById("blueprint-select");
  const label = document.getElementById("blueprint-select-label");
  const menu = document.getElementById("blueprint-menu");
  if (!button || !label || !menu) {
    return;
  }
  const currentValue = state.activeBlueprintMetric;
  const selectedValue = isAvailableBlueprintMetric(currentValue) ? currentValue : BLUEPRINT_NONE;
  state.activeBlueprintMetric = selectedValue;
  button.value = selectedValue;
  button.dataset.value = selectedValue;
  label.textContent = getBlueprintMetricLabel(selectedValue);
  menu.innerHTML = "";

  const optionItems = [
    { key: BLUEPRINT_NONE, label: "None" },
    ...getAvailableBlueprintSpecs(),
  ];
  for (const item of optionItems) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `blueprint-option${item.key === selectedValue ? " is-active" : ""}`;
    option.dataset.value = item.key;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(item.key === selectedValue));

    const optionLabel = document.createElement("span");
    optionLabel.className = "blueprint-option-label";
    optionLabel.textContent = item.label;

    option.appendChild(optionLabel);
    option.addEventListener("click", (event) => {
      event.stopPropagation();
      closeBlueprintMenu();
      selectBlueprintMetric(item.key);
    });
    menu.appendChild(option);
  }
}

function qcZToPercent(value) {
  return ((value - QC_RANGE_MIN_Z) / (QC_RANGE_MAX_Z - QC_RANGE_MIN_Z)) * 100;
}

function qcZToSliderValue(value) {
  const zValue = clampRawQcZ(value);
  return Math.round((zValue - QC_RANGE_MIN_Z) * QC_SLIDER_UNITS_PER_Z);
}

function sliderValueToQcZ(value) {
  return clampQcZ(QC_RANGE_MIN_Z + Number(value) / QC_SLIDER_UNITS_PER_Z);
}

function updateQcRangeFill(fillEl, range) {
  if (!fillEl) {
    return;
  }
  const lowerPercent = qcZToPercent(range.lowerZ);
  const upperPercent = qcZToPercent(range.upperZ);
  if (fillEl.classList.contains("qc-color-fill")) {
    const middlePercent = (lowerPercent + upperPercent) / 2;
    fillEl.style.left = "0";
    fillEl.style.right = "0";
    fillEl.style.background = `linear-gradient(90deg,
      rgba(202, 0, 32, 0.95) 0%,
      rgba(202, 0, 32, 0.95) ${lowerPercent}%,
      rgba(247, 247, 247, 0.95) ${middlePercent}%,
      rgba(5, 113, 176, 0.95) ${upperPercent}%,
      rgba(5, 113, 176, 0.95) 100%)`;
    return;
  }
  fillEl.style.left = `${lowerPercent}%`;
  fillEl.style.right = `${100 - upperPercent}%`;
}

function zToMetricAxisValue(zValue, stats) {
  return stats.mean + zValue * stats.std;
}

function metricAxisValueToZ(value, stats) {
  return (Number(value) - stats.mean) / Math.max(stats.std, 1e-12);
}

function niceSliderStep(rawStep) {
  const scalar = Math.abs(Number(rawStep));
  if (!Number.isFinite(scalar) || scalar <= 0) {
    return QC_RANGE_STEP_Z;
  }
  const exponent = Math.floor(Math.log10(scalar));
  const base = 10 ** exponent;
  const fraction = scalar / base;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return Number((niceFraction * base).toPrecision(12));
}

function decimalPlacesForStep(step) {
  const scalar = Math.abs(Number(step));
  if (!Number.isFinite(scalar) || scalar <= 0) {
    return 3;
  }
  let scaled = scalar;
  for (let digits = 0; digits <= 6; digits += 1) {
    if (Math.abs(Math.round(scaled) - scaled) < 1e-8) {
      return digits;
    }
    scaled *= 10;
  }
  return 6;
}

function absoluteStepForStats(stats) {
  return niceSliderStep(stats.std * QC_RANGE_STEP_Z);
}

function snapMetricAxisValue(value, step) {
  const scalar = Number(value);
  const safeStep = Math.abs(Number(step));
  if (!Number.isFinite(scalar) || !Number.isFinite(safeStep) || safeStep <= 0) {
    return scalar;
  }
  const digits = decimalPlacesForStep(safeStep);
  const snapped = Math.round(scalar / safeStep) * safeStep;
  return Number(snapped.toFixed(Math.min(8, digits + 2)));
}

function absoluteSliderValueToQcZ(value, stats, side, { allowUnbounded = true } = {}) {
  const rawZ = sliderValueToQcZ(value);
  if (allowUnbounded && side === "lower" && isLowerQcUnbounded(rawZ)) {
    return QC_RANGE_MIN_Z;
  }
  if (allowUnbounded && side === "upper" && isUpperQcUnbounded(rawZ)) {
    return QC_RANGE_MAX_Z;
  }
  const step = absoluteStepForStats(stats);
  const axisValue = snapMetricAxisValue(zToMetricAxisValue(rawZ, stats), step);
  return clampQcZ(metricAxisValueToZ(axisValue, stats));
}

function getStdQcPositions({ allowUnbounded = false } = {}) {
  const positions = [];
  if (allowUnbounded) {
    positions.push(QC_RANGE_MIN_Z);
  }
  for (let value = Math.ceil(QC_RANGE_MIN_Z); value <= Math.floor(QC_RANGE_MAX_Z); value += 1) {
    positions.push(value);
  }
  if (allowUnbounded) {
    positions.push(QC_RANGE_MAX_Z);
  }
  return positions;
}

function nearestQcPosition(value, positions) {
  return positions.reduce((nearest, candidate) => (
    Math.abs(candidate - value) < Math.abs(nearest - value) ? candidate : nearest
  ), positions[0]);
}

function stdSliderValueToQcZ(value, side, { allowUnbounded = false } = {}) {
  const rawZ = sliderValueToQcZ(value);
  if (allowUnbounded && side === "lower" && isLowerQcUnbounded(rawZ)) {
    return QC_RANGE_MIN_Z;
  }
  if (allowUnbounded && side === "upper" && isUpperQcUnbounded(rawZ)) {
    return QC_RANGE_MAX_Z;
  }
  return nearestQcPosition(rawZ, getStdQcPositions({ allowUnbounded }));
}

function sliderValueToActiveQcZ(value, stats, side, { allowUnbounded = false } = {}) {
  if (state.qcThresholdMode === QC_THRESHOLD_MODE_RAW) {
    return absoluteSliderValueToQcZ(value, stats, side, { allowUnbounded });
  }
  return stdSliderValueToQcZ(value, side, { allowUnbounded });
}

function enforceStdQcRangeOrder(lowerZ, upperZ, changedHandle, { allowUnbounded = false } = {}) {
  const positions = getStdQcPositions({ allowUnbounded });
  let lowerIndex = positions.indexOf(nearestQcPosition(lowerZ, positions));
  let upperIndex = positions.indexOf(nearestQcPosition(upperZ, positions));
  if (lowerIndex >= upperIndex) {
    if (changedHandle === "lower") {
      if (upperIndex > 0) {
        lowerIndex = upperIndex - 1;
      } else {
        lowerIndex = 0;
        upperIndex = 1;
      }
    } else if (lowerIndex < positions.length - 1) {
      upperIndex = lowerIndex + 1;
    } else {
      lowerIndex = positions.length - 2;
      upperIndex = positions.length - 1;
    }
  }
  return { lowerZ: positions[lowerIndex], upperZ: positions[upperIndex] };
}

function formatMetricAxisValue(value, step = null) {
  if (Number.isFinite(step)) {
    const digits = decimalPlacesForStep(step);
    return Number(value).toFixed(digits);
  }
  const absValue = Math.abs(value);
  if (absValue === 0) {
    return "0";
  }
  if (absValue >= 1000 || absValue < 0.01) {
    return value.toExponential(2);
  }
  if (absValue >= 100) {
    return value.toFixed(1);
  }
  if (absValue >= 10) {
    return value.toFixed(2);
  }
  return value.toFixed(3);
}

function formatAbsoluteBound(zValue, side, stats, step) {
  if (side === "lower" && isLowerQcUnbounded(zValue)) {
    return "N/A";
  }
  if (side === "upper" && isUpperQcUnbounded(zValue)) {
    return "N/A";
  }
  return formatMetricAxisValue(zToMetricAxisValue(zValue, stats), step);
}

function hideQcRangeControl() {
  document.getElementById("blueprint-color-range")?.classList.add("hidden");
  document.getElementById("blueprint-qc-range")?.classList.add("hidden");
}

function setQcCardEmpty(isEmpty) {
  document.querySelector(".qc-card")?.classList.toggle("is-empty", isEmpty);
}

const QC_PLOT_DOWNLOADS = {
  svg: "download-qc-svg-btn",
  png: "download-qc-png-btn",
};

const QC_EXPORT_COLORSCALE = [
  [0, "rgb(202, 0, 32)"],
  [0.5, "rgb(247, 247, 247)"],
  [1, "rgb(5, 113, 176)"],
];

function setQcDownloadEnabled(enabled) {
  const row = document.getElementById("qc-download-row");
  row?.classList.toggle("hidden", !enabled);
  for (const buttonId of Object.values(QC_PLOT_DOWNLOADS)) {
    const button = document.getElementById(buttonId);
    if (button) {
      button.disabled = !enabled;
    }
  }
}

function getQcExportRangeLabels() {
  return {
    lower: document.getElementById("qc-color-lower-label")?.textContent?.trim() || "Min",
    upper: document.getElementById("qc-color-upper-label")?.textContent?.trim() || "Max",
  };
}

function makeQcExportData(plot) {
  const data = clonePlotlyObject(plot.data ?? []).map((trace, index) => {
    if (index !== 1 || trace?.type !== "scatter") {
      return trace;
    }
    return {
      ...trace,
      line: {
        ...(trace.line ?? {}),
        color: "rgb(32, 30, 27)",
      },
    };
  });
  const stripX = Array.from({ length: 128 }, (_, index) => index / 127);
  data.push({
    type: "heatmap",
    x: stripX,
    y: [0],
    z: [stripX],
    xaxis: "x2",
    yaxis: "y2",
    zmin: 0,
    zmax: 1,
    colorscale: QC_EXPORT_COLORSCALE,
    showscale: false,
    hoverinfo: "skip",
  });
  return data;
}

function makeQcExportLayout(plot, width, height) {
  const layout = clonePlotlyObject(plot.layout ?? {});
  const labels = getQcExportRangeLabels();
  layout.width = width;
  layout.height = height;
  layout.margin = { l: 40, r: 18, t: 18, b: 52 };
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
    color: "rgb(32, 30, 27)",
    title: {
      ...(layout.xaxis?.title ?? {}),
      font: {
        ...(layout.xaxis?.title?.font ?? {}),
        color: "rgb(32, 30, 27)",
      },
    },
    gridcolor: "rgba(32, 30, 27, 0.12)",
    range: clonePlotlyObject(plot._fullLayout?.xaxis?.range ?? layout.xaxis?.range),
  };
  layout.yaxis = {
    ...(layout.yaxis ?? {}),
    domain: [0.24, 1],
    anchor: "x",
    color: "rgb(32, 30, 27)",
    gridcolor: "rgba(32, 30, 27, 0.12)",
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
    ticktext: [labels.lower, labels.upper],
    tickfont: { color: "rgb(32, 30, 27)", size: 11 },
  };
  layout.yaxis2 = {
    domain: [0.04, 0.095],
    anchor: "x2",
    fixedrange: true,
    visible: false,
  };
  layout.shapes = clonePlotlyObject(layout.shapes ?? []).map((shape) => ({
    ...shape,
    line: {
      ...(shape.line ?? {}),
      color: "rgba(32, 30, 27, 0.5)",
      width: 1,
      dash: "dot",
    },
  }));
  return layout;
}

async function exportQcPlotImage(plot, format) {
  const currentSize = getPlotExportSize(plot);
  const width = Math.max(520, currentSize.width);
  const height = Math.max(360, currentSize.height + 90);
  const exportDiv = document.createElement("div");
  exportDiv.style.position = "fixed";
  exportDiv.style.left = "-10000px";
  exportDiv.style.top = "0";
  exportDiv.style.width = `${width}px`;
  exportDiv.style.height = `${height}px`;
  document.body.appendChild(exportDiv);
  try {
    await Plotly.newPlot(
      exportDiv,
      makeQcExportData(plot),
      makeQcExportLayout(plot, width, height),
      { staticPlot: true, displaylogo: false, displayModeBar: false, responsive: false }
    );
    return await Plotly.toImage(exportDiv, { format, width, height });
  } finally {
    Plotly.purge(exportDiv);
    exportDiv.remove();
  }
}

async function downloadQcPlotImage(format) {
  const plot = document.getElementById("blueprint-stats-plot");
  if (!plot || !plot.data?.length || !getActiveBlueprintSpec()) {
    setStatus("No quality-control histogram is available to download.", true);
    window.setTimeout(() => setStatus(""), 1800);
    return;
  }
  const button = document.getElementById(QC_PLOT_DOWNLOADS[format]);
  const filename = `cm2-qc-${sanitizeFilenamePart(state.activeBlueprintMetric)}.${format}`;
  button?.setAttribute("aria-busy", "true");
  button?.setAttribute("disabled", "true");
  try {
    const saveTarget = await chooseImageSaveTarget(filename, format);
    if (saveTarget?.aborted) {
      return;
    }
    const dataUrl = await exportQcPlotImage(plot, format);
    await saveImageBlob(dataUrlToBlob(dataUrl, format), filename, saveTarget);
  } catch (error) {
    console.error(error);
    setStatus(error.message ?? `Failed to download ${format.toUpperCase()}.`, true);
    window.setTimeout(() => setStatus(""), 2400);
  } finally {
    button?.removeAttribute("aria-busy");
    setQcDownloadEnabled(Boolean(plot.data?.length));
  }
}

function wireQcDownloadButtons() {
  for (const [format, buttonId] of Object.entries(QC_PLOT_DOWNLOADS)) {
    const button = document.getElementById(buttonId);
    if (!button || button.dataset.downloadWired === "true") {
      continue;
    }
    button.addEventListener("click", () => downloadQcPlotImage(format));
    button.dataset.downloadWired = "true";
  }
  setQcDownloadEnabled(false);
}

function configureQcSliderPair(lowerInput, upperInput, range) {
  if (!lowerInput || !upperInput) {
    return;
  }
  for (const input of [lowerInput, upperInput]) {
    input.min = String(QC_SLIDER_MIN);
    input.max = String(QC_SLIDER_MAX);
    input.step = "1";
  }
  lowerInput.value = String(qcZToSliderValue(range.lowerZ));
  upperInput.value = String(qcZToSliderValue(range.upperZ));
}

function renderBlueprintColorRangeControl(spec = getActiveBlueprintSpec()) {
  const control = document.getElementById("blueprint-color-range");
  if (!control || !spec) {
    control?.classList.add("hidden");
    return;
  }
  const range = getBlueprintColorRange(spec.key);
  const lowerInput = document.getElementById("qc-color-lower-input");
  const upperInput = document.getElementById("qc-color-upper-input");
  const { stats } = buildBlueprintMetricValues(spec);
  const absoluteStep = absoluteStepForStats(stats);
  const rawMode = state.qcThresholdMode === QC_THRESHOLD_MODE_RAW;
  configureQcSliderPair(lowerInput, upperInput, range);
  lowerInput.classList.remove("is-unbounded");
  upperInput.classList.remove("is-unbounded");
  document.getElementById("qc-color-lower-label").textContent = rawMode
    ? formatMetricAxisValue(zToMetricAxisValue(range.lowerZ, stats), absoluteStep)
    : `${formatQcZValue(range.lowerZ)} STD`;
  document.getElementById("qc-color-upper-label").textContent = rawMode
    ? formatMetricAxisValue(zToMetricAxisValue(range.upperZ, stats), absoluteStep)
    : `${formatQcZValue(range.upperZ)} STD`;
  updateQcRangeFill(document.getElementById("qc-color-fill"), range);
  control.classList.remove("hidden");
}

function renderQcUnitModeControl(enabled = Boolean(getActiveBlueprintSpec())) {
  const activeMode = normalizeQcThresholdMode(state.qcThresholdMode);
  state.qcThresholdMode = activeMode;
  for (const button of document.querySelectorAll("[data-qc-unit-mode]")) {
    const isActive = button.dataset.qcUnitMode === activeMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-checked", String(isActive));
    button.disabled = !enabled;
  }
}

function setQcThresholdMode(mode) {
  const nextMode = normalizeQcThresholdMode(mode);
  if (nextMode === state.qcThresholdMode) {
    return;
  }
  state.qcThresholdMode = nextMode;
  saveUiState();
  renderBlueprintStats();
}

function renderQcRangeControl(spec = getActiveBlueprintSpec()) {
  const control = document.getElementById("blueprint-qc-range");
  if (!control || !spec) {
    hideQcRangeControl();
    return;
  }

  const range = getQcRange(spec.key);
  const lowerInput = document.getElementById("qc-range-lower-input");
  const upperInput = document.getElementById("qc-range-upper-input");
  const lowerLabel = document.getElementById("qc-range-lower-label");
  const upperLabel = document.getElementById("qc-range-upper-label");
  const fill = document.getElementById("qc-range-fill");
  const { stats } = buildBlueprintMetricValues(spec);
  const absoluteStep = absoluteStepForStats(stats);
  const rawMode = state.qcThresholdMode === QC_THRESHOLD_MODE_RAW;

  configureQcSliderPair(lowerInput, upperInput, range);
  lowerInput.classList.toggle("is-unbounded", isLowerQcUnbounded(range.lowerZ));
  upperInput.classList.toggle("is-unbounded", isUpperQcUnbounded(range.upperZ));
  lowerLabel.textContent = rawMode
    ? formatAbsoluteBound(range.lowerZ, "lower", stats, absoluteStep)
    : formatQcBound(range.lowerZ, "lower");
  upperLabel.textContent = rawMode
    ? formatAbsoluteBound(range.upperZ, "upper", stats, absoluteStep)
    : formatQcBound(range.upperZ, "upper");
  updateQcRangeFill(fill, range);
  control.classList.remove("hidden");
}

function renderQcControls(spec = getActiveBlueprintSpec()) {
  renderQcUnitModeControl(Boolean(spec));
  if (!spec) {
    hideQcRangeControl();
    return;
  }
  renderBlueprintColorRangeControl(spec);
  renderQcRangeControl(spec);
}

function updateActiveBlueprintColorRangeFromInputs(changedHandle) {
  const spec = getActiveBlueprintSpec();
  if (!spec) {
    return;
  }
  const lowerInput = document.getElementById("qc-color-lower-input");
  const upperInput = document.getElementById("qc-color-upper-input");
  const { stats } = buildBlueprintMetricValues(spec);
  let lowerZ = sliderValueToActiveQcZ(lowerInput.value, stats, "lower");
  let upperZ = sliderValueToActiveQcZ(upperInput.value, stats, "upper");
  if (state.qcThresholdMode === QC_THRESHOLD_MODE_STD) {
    ({ lowerZ, upperZ } = enforceStdQcRangeOrder(lowerZ, upperZ, changedHandle));
  } else if (lowerZ >= upperZ - QC_RANGE_EPS) {
    const stepZ = absoluteStepForStats(stats) / Math.max(stats.std, 1e-12);
    if (changedHandle === "lower") {
      lowerZ = upperZ - stepZ;
    } else {
      upperZ = lowerZ + stepZ;
    }
  }
  lowerZ = clampQcZ(lowerZ);
  upperZ = clampQcZ(upperZ);
  if (changedHandle === "lower" && lowerZ >= upperZ) {
    lowerZ = clampQcZ(upperZ - QC_RANGE_STEP_Z);
  } else if (changedHandle === "upper" && upperZ <= lowerZ) {
    upperZ = clampQcZ(lowerZ + QC_RANGE_STEP_Z);
  }
  setBlueprintColorRange(spec.key, { lowerZ, upperZ });
  saveUiState();
  renderBlueprintStats();
  renderMap();
}

function updateActiveQcRangeFromInputs(changedHandle) {
  const spec = getActiveBlueprintSpec();
  if (!spec) {
    return;
  }
  const lowerInput = document.getElementById("qc-range-lower-input");
  const upperInput = document.getElementById("qc-range-upper-input");
  const { stats } = buildBlueprintMetricValues(spec);
  let lowerZ = sliderValueToActiveQcZ(lowerInput.value, stats, "lower", { allowUnbounded: true });
  let upperZ = sliderValueToActiveQcZ(upperInput.value, stats, "upper", { allowUnbounded: true });
  if (state.qcThresholdMode === QC_THRESHOLD_MODE_STD) {
    ({ lowerZ, upperZ } = enforceStdQcRangeOrder(lowerZ, upperZ, changedHandle, { allowUnbounded: true }));
  } else if (lowerZ >= upperZ - QC_RANGE_EPS) {
    const stepZ = absoluteStepForStats(stats) / Math.max(stats.std, 1e-12);
    if (changedHandle === "lower") {
      lowerZ = upperZ - stepZ;
    } else {
      upperZ = lowerZ + stepZ;
    }
  }
  lowerZ = clampQcZ(lowerZ);
  upperZ = clampQcZ(upperZ);
  if (changedHandle === "lower" && lowerZ >= upperZ) {
    lowerZ = clampQcZ(upperZ - QC_RANGE_STEP_Z);
  } else if (changedHandle === "upper" && upperZ <= lowerZ) {
    upperZ = clampQcZ(lowerZ + QC_RANGE_STEP_Z);
  }
  setQcRange(spec.key, { lowerZ, upperZ });
  saveUiState();
  renderQcRangeControl(spec);
  renderWorkflowSummaries();
  renderRoiWorkflowPanel();
  renderRegionList();
  renderMap();
  updatePlots();
}

function renderBlueprintStats() {
  const plot = document.getElementById("blueprint-stats-plot");
  if (!plot) {
    return;
  }
  const spec = getActiveBlueprintSpec();
  if (!spec) {
    plot.classList.add("hidden");
    setQcDownloadEnabled(false);
    renderQcUnitModeControl(false);
    hideQcRangeControl();
    setQcCardEmpty(true);
    Plotly.purge(plot);
    return;
  }

  const { values, stats } = buildBlueprintMetricValues(spec);
  const histogram = buildHistogram(values, stats);
  if (!histogram) {
    plot.classList.add("hidden");
    setQcDownloadEnabled(false);
    renderQcUnitModeControl(false);
    hideQcRangeControl();
    setQcCardEmpty(true);
    Plotly.purge(plot);
    return;
  }
  const curveX = Array.from({ length: 240 }, (_, idx) => histogram.viewMin + (idx / 239) * (histogram.viewMax - histogram.viewMin));
  const curveY = curveX.map((x) => gaussianPdf(x, stats.mean, stats.std) * histogram.totalCount * histogram.binWidth);
  const maxY = Math.max(...histogram.counts, ...curveY, 1e-12);
  const colorRange = getBlueprintColorRange(spec.key);
  const colorMin = zToMetricAxisValue(colorRange.lowerZ, stats);
  const colorMax = zToMetricAxisValue(colorRange.upperZ, stats);
  const sigmaShapes = [];
  for (let offset = -3; offset <= 3; offset += 1) {
    const x = stats.mean + offset * stats.std;
    sigmaShapes.push({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: x,
      x1: x,
      y0: 0,
      y1: 1,
      line: {
        color: "rgba(255,255,255,0.38)",
        width: 1,
        dash: "dot",
      },
    });
  }

  const barColors = histogram.centers.map((value) => blueprintColorForValue(value, colorMin, colorMax));
  plot.classList.remove("hidden");
  setQcCardEmpty(false);
  renderQcControls(spec);
  Plotly.react(
    plot,
    [
      {
        type: "bar",
        x: histogram.centers,
        y: histogram.counts,
        width: histogram.binWidth * 0.94,
        marker: {
          color: barColors,
          line: { color: "rgba(20,18,16,0.34)", width: 0.4 },
        },
        hovertemplate: `${blueprintAxisTitle(spec)}=%{x:.3g}<br>neurons=%{y:.0f}<extra></extra>`,
      },
      {
        type: "scatter",
        mode: "lines",
        x: curveX,
        y: curveY,
        line: { color: "rgba(247,241,231,0.94)", width: 2.4 },
        hoverinfo: "skip",
      },
    ],
    {
      margin: { l: 0, r: 0, t: 4, b: 30 },
      height: 130,
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      barmode: "overlay",
      showlegend: false,
      shapes: sigmaShapes,
      xaxis: {
        title: { text: blueprintAxisTitle(spec), font: { color: "#f7f1e7", size: 12 }, standoff: 2 },
        color: "#f7f1e7",
        showgrid: false,
        fixedrange: true,
        zeroline: false,
        range: [histogram.viewMin, histogram.viewMax],
      },
      yaxis: {
        title: { text: "" },
        color: "#f7f1e7",
        gridcolor: "rgba(255,245,228,0.12)",
        fixedrange: true,
        showticklabels: false,
        ticks: "",
        zeroline: false,
        rangemode: "tozero",
        range: [0, maxY * 1.08],
      },
    },
    {
      responsive: true,
      displaylogo: false,
      displayModeBar: false,
      doubleClick: false,
      scrollZoom: false,
      staticPlot: false,
    }
  ).then(() => {
    setQcDownloadEnabled(true);
    scheduleBlueprintStatsReflow();
  });
}
