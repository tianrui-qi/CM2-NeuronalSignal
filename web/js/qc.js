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

function renderSegmentedToggle(containerId, keys, labels, activeKey, onSelect) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (keys.length <= 1) {
    container.style.display = "none";
    return;
  }
  container.style.display = "inline-flex";
  for (const key of keys) {
    const button = document.createElement("button");
    button.className = `trace-source-btn${key === activeKey ? " active" : ""}`;
    button.textContent = labels[key] ?? key;
    button.addEventListener("click", () => onSelect(key));
    container.appendChild(button);
  }
}

function renderSourceToggle(containerId, activeSourceKey, onSelect) {
  renderSegmentedToggle(
    containerId,
    getAvailableTraceSourceKeys(),
    TRACE_SOURCE_UI_LABELS,
    activeSourceKey,
    onSelect
  );
}

function renderTraceValueToggle(containerId, activeValueMode, onSelect) {
  renderSegmentedToggle(
    containerId,
    getAvailableTraceValueModes(),
    TRACE_VALUE_MODE_UI_LABELS,
    activeValueMode,
    onSelect
  );
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

function formatQcRangeSummary(metricKey) {
  if (metricKey === BLUEPRINT_NONE) {
    return "";
  }
  const range = getQcRange(metricKey);
  if (!isQcRangeActive(range)) {
    return "";
  }
  const lower = isLowerQcUnbounded(range.lowerZ) ? "N/A" : formatQcZValue(range.lowerZ);
  const upper = isUpperQcUnbounded(range.upperZ) ? "N/A" : formatQcZValue(range.upperZ);
  return `[${lower}, ${upper}) STD`;
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
  const rangeLabel = document.getElementById("blueprint-select-range");
  const menu = document.getElementById("blueprint-menu");
  if (!button || !label || !rangeLabel || !menu) {
    return;
  }
  const currentValue = state.activeBlueprintMetric;
  const selectedValue = isAvailableBlueprintMetric(currentValue) ? currentValue : BLUEPRINT_NONE;
  state.activeBlueprintMetric = selectedValue;
  button.value = selectedValue;
  button.dataset.value = selectedValue;
  label.textContent = getBlueprintMetricLabel(selectedValue);
  rangeLabel.textContent = formatQcRangeSummary(selectedValue);
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

    const optionRange = document.createElement("span");
    optionRange.className = "blueprint-option-range";
    optionRange.textContent = formatQcRangeSummary(item.key);

    option.appendChild(optionLabel);
    option.appendChild(optionRange);
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
  fillEl.style.left = "0";
  fillEl.style.right = "0";
  fillEl.style.clipPath = `inset(0 ${100 - upperPercent}% 0 ${lowerPercent}%)`;
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

function absoluteSliderValueToQcZ(value, stats, side) {
  const rawZ = sliderValueToQcZ(value);
  if (side === "lower" && isLowerQcUnbounded(rawZ)) {
    return QC_RANGE_MIN_Z;
  }
  if (side === "upper" && isUpperQcUnbounded(rawZ)) {
    return QC_RANGE_MAX_Z;
  }
  const step = absoluteStepForStats(stats);
  const axisValue = snapMetricAxisValue(zToMetricAxisValue(rawZ, stats), step);
  return clampQcZ(metricAxisValueToZ(axisValue, stats));
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
  document.getElementById("blueprint-qc-range")?.classList.add("hidden");
}

function setQcCardEmpty(isEmpty) {
  document.querySelector(".qc-card")?.classList.toggle("is-empty", isEmpty);
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
  const absoluteLowerInput = document.getElementById("qc-absolute-lower-input");
  const absoluteUpperInput = document.getElementById("qc-absolute-upper-input");
  const lowerLabel = document.getElementById("qc-range-lower-label");
  const upperLabel = document.getElementById("qc-range-upper-label");
  const absoluteLowerLabel = document.getElementById("qc-absolute-lower-label");
  const absoluteUpperLabel = document.getElementById("qc-absolute-upper-label");
  const fill = document.getElementById("qc-range-fill");
  const absoluteFill = document.getElementById("qc-absolute-fill");
  const { stats } = buildBlueprintMetricValues(spec);
  const absoluteStep = absoluteStepForStats(stats);
  const lowerSliderValue = qcZToSliderValue(range.lowerZ);
  const upperSliderValue = qcZToSliderValue(range.upperZ);

  for (const input of [lowerInput, upperInput]) {
    input.min = String(QC_SLIDER_MIN);
    input.max = String(QC_SLIDER_MAX);
    input.step = "1";
  }
  for (const input of [absoluteLowerInput, absoluteUpperInput]) {
    input.min = String(QC_SLIDER_MIN);
    input.max = String(QC_SLIDER_MAX);
    input.step = "1";
  }
  for (const input of [lowerInput]) {
    input.value = String(lowerSliderValue);
    input.classList.toggle("is-unbounded", isLowerQcUnbounded(range.lowerZ));
  }
  for (const input of [upperInput]) {
    input.value = String(upperSliderValue);
    input.classList.toggle("is-unbounded", isUpperQcUnbounded(range.upperZ));
  }
  absoluteLowerInput.value = String(lowerSliderValue);
  absoluteUpperInput.value = String(upperSliderValue);
  absoluteLowerInput.classList.toggle("is-unbounded", isLowerQcUnbounded(range.lowerZ));
  absoluteUpperInput.classList.toggle("is-unbounded", isUpperQcUnbounded(range.upperZ));
  lowerLabel.textContent = formatQcBound(range.lowerZ, "lower");
  upperLabel.textContent = formatQcBound(range.upperZ, "upper");
  absoluteLowerLabel.textContent = formatAbsoluteBound(range.lowerZ, "lower", stats, absoluteStep);
  absoluteUpperLabel.textContent = formatAbsoluteBound(range.upperZ, "upper", stats, absoluteStep);
  updateQcRangeFill(fill, range);
  updateQcRangeFill(absoluteFill, range);
  control.classList.remove("hidden");
}

function updateActiveQcRangeFromInputs(changedHandle, sourcePrefix = "qc-range") {
  const spec = getActiveBlueprintSpec();
  if (!spec) {
    return;
  }
  const lowerInput = document.getElementById(`${sourcePrefix}-lower-input`);
  const upperInput = document.getElementById(`${sourcePrefix}-upper-input`);
  const fromAbsolute = sourcePrefix === "qc-absolute";
  const { stats } = buildBlueprintMetricValues(spec);
  const stepZ = fromAbsolute
    ? absoluteStepForStats(stats) / Math.max(stats.std, 1e-12)
    : QC_RANGE_STEP_Z;
  let lowerZ = fromAbsolute
    ? absoluteSliderValueToQcZ(lowerInput.value, stats, "lower")
    : clampQcZ(sliderValueToQcZ(lowerInput.value), { snap: true });
  let upperZ = fromAbsolute
    ? absoluteSliderValueToQcZ(upperInput.value, stats, "upper")
    : clampQcZ(sliderValueToQcZ(upperInput.value), { snap: true });
  if (changedHandle === "lower") {
    lowerZ = Math.min(lowerZ, upperZ - stepZ);
  } else {
    upperZ = Math.max(upperZ, lowerZ + stepZ);
  }
  lowerZ = clampQcZ(lowerZ);
  upperZ = clampQcZ(upperZ);
  setQcRange(spec.key, { lowerZ, upperZ });
  saveUiState();
  renderBlueprintControl();
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
    hideQcRangeControl();
    setQcCardEmpty(true);
    Plotly.purge(plot);
    return;
  }

  const { values, stats } = buildBlueprintMetricValues(spec);
  const histogram = buildHistogram(values, stats);
  if (!histogram) {
    plot.classList.add("hidden");
    hideQcRangeControl();
    setQcCardEmpty(true);
    Plotly.purge(plot);
    return;
  }
  const curveX = Array.from({ length: 240 }, (_, idx) => histogram.viewMin + (idx / 239) * (histogram.viewMax - histogram.viewMin));
  const curveY = curveX.map((x) => gaussianPdf(x, stats.mean, stats.std) * histogram.totalCount * histogram.binWidth);
  const maxY = Math.max(...histogram.counts, ...curveY, 1e-12);
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
        color: offset === 0 ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.38)",
        width: offset === 0 ? 1.6 : 1,
        dash: offset === 0 ? "solid" : "dot",
      },
    });
  }

  const barColors = histogram.centers.map((value) => blueprintColorForValue(value, stats.mean, stats.std));
  plot.classList.remove("hidden");
  setQcCardEmpty(false);
  renderQcRangeControl(spec);
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
      margin: { l: 28, r: 18, t: 6, b: 38 },
      height: 260,
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      barmode: "overlay",
      showlegend: false,
      shapes: sigmaShapes,
      xaxis: {
        title: { text: blueprintAxisTitle(spec), font: { color: "#f7f1e7", size: 12 }, standoff: 2 },
        color: "#f7f1e7",
        gridcolor: "rgba(255,245,228,0.12)",
        fixedrange: true,
        zeroline: false,
        range: [histogram.viewMin, histogram.viewMax],
      },
      yaxis: {
        title: { text: "" },
        color: "#f7f1e7",
        gridcolor: "rgba(255,245,228,0.12)",
        fixedrange: true,
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
  ).then(scheduleBlueprintStatsReflow);
}
