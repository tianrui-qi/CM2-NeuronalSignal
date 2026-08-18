export const BLUEPRINT_NONE = "none";
export const BLUEPRINT_COLOR_SCALE = "RdBu";

export const QC_SLIDER_MIN = 0;
export const QC_RANGE_EPS = 1e-9;

const QC_FOCUS_LOWER_QUANTILE = 0.01;
const QC_FOCUS_UPPER_QUANTILE = 0.99;
const QC_FOCUS_MIN_SAMPLE_COUNT = 200;
const QC_FOCUS_MIN_COMPRESSION_RATIO = 2;
const QC_FOCUS_TUKEY_IQR_MULTIPLIER = 1.5;
const QC_TARGET_SLIDER_INTERVALS = 200;

export const BLUEPRINT_METRIC_SPECS = [
  { key: "r_value", label: "r_value" },
  { key: "snr", label: "SNR" },
  { key: "bl", label: "bl" },
  { key: "lam", label: "lambda" },
  { key: "neurons_sn", label: "neurons_sn" },
  { key: "g_0", label: "g_0" },
  { key: "g_1", label: "g_1" },
  { key: "t_peak", label: "t_peak" },
  { key: "t_half", label: "t_half" },
];


/**
 * @param {Record<string, any>} state
 * @returns {Array<{ key: string, label: string }>}
 */
export function getAvailableBlueprintSpecs(state) {
  if (!state?.points?.metrics) {
    return [];
  }
  return BLUEPRINT_METRIC_SPECS.filter(
    (spec) => Array.isArray(state.points.metrics[spec.key]),
  );
}


/** @param {Record<string, any>} state @param {unknown} metricKey */
export function isAvailableBlueprintMetric(state, metricKey) {
  return metricKey === BLUEPRINT_NONE
    || getAvailableBlueprintSpecs(state).some((spec) => spec.key === metricKey);
}


/**
 * Normalize an explicit metric selection. Invalid selections retain the
 * `none` fallback rather than selecting the first available metric.
 *
 * @param {Record<string, any>} state
 * @param {unknown} metricKey
 * @returns {string}
 */
export function normalizeBlueprintMetricKey(state, metricKey) {
  return isAvailableBlueprintMetric(state, metricKey)
    ? /** @type {string} */ (metricKey)
    : BLUEPRINT_NONE;
}


/** @param {Record<string, any>} state */
export function getActiveBlueprintSpec(state) {
  if (state?.activeBlueprintMetric === BLUEPRINT_NONE) {
    return null;
  }
  return getAvailableBlueprintSpecs(state)
    .find((spec) => spec.key === state?.activeBlueprintMetric) ?? null;
}


/** @param {Record<string, any>} state @param {unknown} metricKey */
export function getBlueprintSpecByKey(state, metricKey) {
  return getAvailableBlueprintSpecs(state)
    .find((spec) => spec.key === metricKey) ?? null;
}


/**
 * Preserve the established JavaScript number coercion at the cache boundary.
 * In particular, serialized JSON `null` remains numeric zero. The Quality
 * Control feature otherwise operates directly on cache metric values.
 *
 * @param {readonly unknown[]} rawValues
 */
export function computeMetricExtent(rawValues) {
  const finite = rawValues.map(Number).filter((value) => Number.isFinite(value));
  if (!finite.length) {
    return { min: -1, max: 1, span: 2 };
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  return {
    min,
    max: span > QC_RANGE_EPS ? max : min + 1,
    span: span > QC_RANGE_EPS ? span : 1,
  };
}


/** @param {Record<string, any>} state @param {{ key: string }} spec */
export function buildBlueprintMetricValues(state, spec) {
  const rawValues = state.points.metrics[spec.key] ?? [];
  const values = rawValues.map((rawValue) => {
    const value = Number(rawValue);
    return Number.isFinite(value) ? value : 0;
  });
  return { values, extent: computeMetricExtent(values) };
}


/** @param {unknown} value */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const scalar = Number(value);
  return Number.isFinite(scalar) ? scalar : null;
}


/** @param {{ min: number, max: number }} extent */
function defaultBlueprintColorRange(extent) {
  return { lower: extent.min, upper: extent.max };
}


/** @param {Record<string, any>} state @param {{ key: string }} spec @param {unknown} range */
export function normalizeBlueprintColorRange(state, spec, range) {
  const { values, extent } = buildBlueprintMetricValues(state, spec);
  const fallback = defaultBlueprintColorRange(extent);
  const source = /** @type {{ lower?: unknown, upper?: unknown }} */ (
    range && typeof range === "object" ? range : {}
  );
  let lower = finiteOrNull(source.lower) ?? fallback.lower;
  let upper = finiteOrNull(source.upper) ?? fallback.upper;
  if (lower > upper) {
    [lower, upper] = [upper, lower];
  }
  if (upper - lower <= QC_RANGE_EPS) {
    upper = lower + buildMetricFocusDomain(values, extent).step;
  }
  return { lower, upper };
}


/** @param {Record<string, any>} state @param {unknown} ranges */
export function normalizeBlueprintColorRanges(state, ranges) {
  const normalized = {};
  if (!ranges || typeof ranges !== "object") {
    return normalized;
  }
  for (const spec of getAvailableBlueprintSpecs(state)) {
    if (Object.prototype.hasOwnProperty.call(ranges, spec.key)) {
      normalized[spec.key] = normalizeBlueprintColorRange(
        state,
        spec,
        ranges[spec.key],
      );
    }
  }
  return normalized;
}


/** @param {Record<string, any>} state @param {{ key: string }} spec @param {unknown} range */
export function normalizeQcRange(state, spec, range) {
  const source = /** @type {{ lower?: unknown, upper?: unknown }} */ (
    range && typeof range === "object" ? range : {}
  );
  let lower = finiteOrNull(source.lower);
  let upper = finiteOrNull(source.upper);
  if (lower !== null && upper !== null && lower > upper) {
    [lower, upper] = [upper, lower];
  }
  return { lower, upper };
}


/** @param {Record<string, any>} state @param {unknown} ranges */
export function normalizeQcRanges(state, ranges) {
  const normalized = {};
  if (!ranges || typeof ranges !== "object") {
    return normalized;
  }
  for (const spec of getAvailableBlueprintSpecs(state)) {
    if (Object.prototype.hasOwnProperty.call(ranges, spec.key)) {
      normalized[spec.key] = normalizeQcRange(state, spec, ranges[spec.key]);
    }
  }
  return normalized;
}


/** @param {Record<string, any>} state @param {string} metricKey */
export function getBlueprintColorRange(state, metricKey) {
  const spec = getBlueprintSpecByKey(state, metricKey);
  if (!spec) {
    return { lower: 0, upper: 1 };
  }
  return normalizeBlueprintColorRange(
    state,
    spec,
    state?.blueprintColorRanges?.[metricKey],
  );
}


/** @param {Record<string, any>} state @param {string} metricKey */
export function getQcRange(state, metricKey) {
  const spec = getBlueprintSpecByKey(state, metricKey);
  if (!spec) {
    return { lower: null, upper: null };
  }
  return normalizeQcRange(state, spec, state?.qcRanges?.[metricKey]);
}


/** @param {{ lower: number | null, upper: number | null }} range */
export function isQcRangeActive(range) {
  return range.lower !== null || range.upper !== null;
}


/** @param {Record<string, any>} state */
export function getActiveQcFilters(state) {
  return getAvailableBlueprintSpecs(state)
    .map((spec) => {
      const range = getQcRange(state, spec.key);
      if (!isQcRangeActive(range)) {
        return null;
      }
      const { values } = buildBlueprintMetricValues(state, spec);
      return {
        values,
        lower: range.lower ?? -Infinity,
        upper: range.upper ?? Infinity,
      };
    })
    .filter(Boolean);
}


/**
 * This predicate deliberately contains only metric semantics. Region and ROI
 * eligibility are composed by their owning features. Bounds remain lower
 * inclusive and upper exclusive.
 *
 * @param {number} pointIndex
 * @param {Array<{ values: number[], lower: number, upper: number }>} filters
 */
export function pointIndexPassesMetricFilters(pointIndex, filters) {
  for (const filter of filters) {
    const value = filter.values[pointIndex];
    if (!Number.isFinite(value) || value < filter.lower || value >= filter.upper) {
      return false;
    }
  }
  return true;
}


/** @param {unknown} rawStep */
export function niceSliderStep(rawStep) {
  const scalar = Math.abs(Number(rawStep));
  if (!Number.isFinite(scalar) || scalar <= 0) {
    return 1;
  }
  const exponent = Math.floor(Math.log10(scalar));
  const base = 10 ** exponent;
  const fraction = scalar / base;
  const niceFraction = fraction <= 1
    ? 1
    : fraction <= 2
      ? 2
      : fraction <= 2.5
        ? 2.5
        : fraction <= 5
          ? 5
          : 10;
  return Number((niceFraction * base).toPrecision(12));
}


/**
 * Linearly interpolated quantile for an ascending finite numeric array.
 *
 * @param {readonly number[]} sortedValues
 * @param {unknown} probability
 */
export function quantileSorted(sortedValues, probability) {
  if (!sortedValues.length) {
    return null;
  }
  const p = clamp(Number(probability), 0, 1);
  const position = (sortedValues.length - 1) * p;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.min(sortedValues.length - 1, lowerIndex + 1);
  const fraction = position - lowerIndex;
  return sortedValues[lowerIndex]
    + (sortedValues[upperIndex] - sortedValues[lowerIndex]) * fraction;
}


/** @param {unknown} step */
export function decimalPlacesForStep(step) {
  const scalar = Math.abs(Number(step));
  if (!Number.isFinite(scalar) || scalar <= 0) {
    return 3;
  }
  let scaled = scalar;
  for (let digits = 0; digits <= 8; digits += 1) {
    if (Math.abs(Math.round(scaled) - scaled) < 1e-8) {
      return digits;
    }
    scaled *= 10;
  }
  return 8;
}


/** @param {{ span: number }} extent */
export function metricSliderStep(extent) {
  return niceSliderStep(extent.span / QC_TARGET_SLIDER_INTERVALS);
}


/** @param {unknown} value @param {unknown} step */
export function snapMetricValue(value, step) {
  const scalar = Number(value);
  const safeStep = Math.abs(Number(step));
  if (!Number.isFinite(scalar) || !Number.isFinite(safeStep) || safeStep <= 0) {
    return scalar;
  }
  const digits = decimalPlacesForStep(safeStep);
  const snapped = Math.round(scalar / safeStep) * safeStep;
  return Number(snapped.toFixed(Math.min(10, digits + 2)));
}


/**
 * Round an interaction domain outwards to zero-anchored multiples of its
 * logical slider step. The returned span is therefore an integer number of
 * Arrow-key stops.
 *
 * @param {number} min
 * @param {number} max
 * @param {number} step
 */
function outwardRoundDomain(min, max, step) {
  const safeStep = Math.abs(Number(step));
  if (!Number.isFinite(safeStep) || safeStep <= 0) {
    return { min, max };
  }
  const lowerIndex = Math.floor(min / safeStep + 1e-10);
  const upperIndex = Math.ceil(max / safeStep - 1e-10);
  let roundedMin = Number((lowerIndex * safeStep).toPrecision(12));
  let roundedMax = Number((upperIndex * safeStep).toPrecision(12));
  if (roundedMax - roundedMin <= QC_RANGE_EPS) {
    roundedMax = Number((roundedMin + safeStep).toPrecision(12));
  }
  return { min: roundedMin, max: roundedMax };
}


/**
 * Build the raw-value interaction and histogram focus domain. A robust focus
 * is used only when the union of P1-P99 and the Tukey inner fences is at least
 * two times narrower than the full range. This preserves natural boundaries
 * such as SNR=0 while preventing isolated extremes from consuming nearly all
 * slider precision. No metric value is transformed.
 *
 * @param {readonly unknown[]} metricValues
 * @param {{ min: number, max: number, span: number }} extent
 */
export function buildMetricFocusDomain(metricValues, extent) {
  const finite = metricValues
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const fullMin = Number.isFinite(extent?.min) ? extent.min : -1;
  const fullMax = Number.isFinite(extent?.max) ? extent.max : 1;
  const fullSpan = Math.max(fullMax - fullMin, QC_RANGE_EPS);

  let candidateMin = fullMin;
  let candidateMax = fullMax;
  if (finite.length >= QC_FOCUS_MIN_SAMPLE_COUNT) {
    const p01 = quantileSorted(finite, QC_FOCUS_LOWER_QUANTILE);
    const p99 = quantileSorted(finite, QC_FOCUS_UPPER_QUANTILE);
    const q1 = quantileSorted(finite, 0.25);
    const q3 = quantileSorted(finite, 0.75);
    if (
      p01 !== null
      && p99 !== null
      && q1 !== null
      && q3 !== null
    ) {
      const iqr = Math.max(q3 - q1, 0);
      const tukeyMin = q1 - QC_FOCUS_TUKEY_IQR_MULTIPLIER * iqr;
      const tukeyMax = q3 + QC_FOCUS_TUKEY_IQR_MULTIPLIER * iqr;
      const robustMin = clamp(Math.min(p01, tukeyMin), fullMin, fullMax);
      const robustMax = clamp(Math.max(p99, tukeyMax), fullMin, fullMax);
      const robustSpan = robustMax - robustMin;
      if (
        robustSpan > QC_RANGE_EPS
        && fullSpan / robustSpan >= QC_FOCUS_MIN_COMPRESSION_RATIO
      ) {
        candidateMin = robustMin;
        candidateMax = robustMax;
      }
    }
  }

  const candidateSpan = Math.max(candidateMax - candidateMin, QC_RANGE_EPS);
  const step = metricSliderStep({ span: candidateSpan });
  const rounded = outwardRoundDomain(candidateMin, candidateMax, step);
  const span = rounded.max - rounded.min;
  const stopCount = Math.max(1, Math.round(span / step));
  return {
    min: rounded.min,
    max: rounded.max,
    span,
    step,
    stopCount,
  };
}


/** @param {{ min: number, max: number, step: number, stopCount?: number }} domain */
function logicalStopCount(domain) {
  const explicit = Number(domain?.stopCount);
  if (Number.isInteger(explicit) && explicit >= 1) {
    return explicit;
  }
  return Math.max(1, Math.round((domain.max - domain.min) / domain.step));
}


/**
 * Slider attributes for a raw-value domain. With unbounded QC ranges, the
 * finite raw stops are shifted by one and surrounded by distinct lower/upper
 * null sentinels.
 *
 * @param {{ min: number, max: number, step: number, stopCount?: number }} domain
 * @param {{ allowUnbounded?: boolean }} [options]
 */
export function getSliderBounds(domain, { allowUnbounded = false } = {}) {
  const stopCount = logicalStopCount(domain);
  return {
    min: QC_SLIDER_MIN,
    max: allowUnbounded ? stopCount + 2 : stopCount,
    step: 1,
  };
}


/** @param {number | null} value @param {{ min: number, max: number }} domain @param {string} side */
export function rawValueToPercent(value, domain, side) {
  const resolved = value === null
    ? (side === "lower" ? domain.min : domain.max)
    : value;
  return clamp01((resolved - domain.min) / Math.max(domain.max - domain.min, 1e-12)) * 100;
}


/**
 * @param {number | null} value
 * @param {{ min: number, max: number, step: number, stopCount?: number }} domain
 * @param {"lower" | "upper"} side
 * @param {{ allowUnbounded?: boolean }} [options]
 */
export function rawValueToSliderValue(
  value,
  domain,
  side,
  { allowUnbounded = false } = {},
) {
  const stopCount = logicalStopCount(domain);
  if (allowUnbounded && value === null) {
    return side === "lower" ? QC_SLIDER_MIN : stopCount + 2;
  }
  const scalar = Number(value);
  const resolved = Number.isFinite(scalar)
    ? clamp(scalar, domain.min, domain.max)
    : (side === "lower" ? domain.min : domain.max);
  const finiteStop = clamp(
    Math.round((resolved - domain.min) / domain.step),
    0,
    stopCount,
  );
  return allowUnbounded ? finiteStop + 1 : finiteStop;
}


/**
 * @param {unknown} sliderValue
 * @param {{ min: number, max: number, step: number, stopCount?: number }} domain
 * @param {"lower" | "upper"} side
 * @param {{ allowUnbounded?: boolean }} [options]
 */
export function sliderValueToRawValue(
  sliderValue,
  domain,
  side,
  { allowUnbounded = false } = {},
) {
  const stopCount = logicalStopCount(domain);
  const bounds = getSliderBounds(domain, { allowUnbounded });
  const slider = Math.round(clamp(Number(sliderValue), bounds.min, bounds.max));
  if (allowUnbounded && side === "lower" && slider === bounds.min) {
    return null;
  }
  if (allowUnbounded && side === "upper" && slider === bounds.max) {
    return null;
  }
  const finiteStop = clamp(
    allowUnbounded ? slider - 1 : slider,
    0,
    stopCount,
  );
  return Number((domain.min + finiteStop * domain.step).toPrecision(12));
}


/**
 * Convert only the handle that emitted an input event. The untouched raw
 * endpoint is retained exactly, even when it lies outside the robust focus
 * domain and is visually pinned to a slider edge.
 *
 * @param {{ lower: number | null, upper: number | null }} currentRange
 * @param {"lower" | "upper"} changedHandle
 * @param {unknown} sliderValue
 * @param {{ min: number, max: number, step: number, stopCount?: number }} domain
 * @param {{ allowUnbounded?: boolean }} [options]
 */
export function updateRawRangeFromSlider(
  currentRange,
  changedHandle,
  sliderValue,
  domain,
  { allowUnbounded = false } = {},
) {
  const current = {
    lower: allowUnbounded
      ? finiteOrNull(currentRange?.lower)
      : (finiteOrNull(currentRange?.lower) ?? domain.min),
    upper: allowUnbounded
      ? finiteOrNull(currentRange?.upper)
      : (finiteOrNull(currentRange?.upper) ?? domain.max),
  };
  const next = {
    ...current,
    [changedHandle]: sliderValueToRawValue(
      sliderValue,
      domain,
      changedHandle,
      { allowUnbounded },
    ),
  };
  const ordered = (range) => (
    (range.lower ?? -Infinity) < (range.upper ?? Infinity) - QC_RANGE_EPS
  );
  if (ordered(next)) {
    return next;
  }

  if (changedHandle === "lower" && next.upper !== null) {
    const target = next.upper - domain.step;
    if (target >= domain.min - QC_RANGE_EPS) {
      next.lower = clamp(snapMetricValue(target, domain.step), domain.min, domain.max);
    } else if (allowUnbounded) {
      next.lower = null;
    }
  } else if (changedHandle === "upper" && next.lower !== null) {
    const target = next.lower + domain.step;
    if (target <= domain.max + QC_RANGE_EPS) {
      next.upper = clamp(snapMetricValue(target, domain.step), domain.min, domain.max);
    } else if (allowUnbounded) {
      next.upper = null;
    }
  }
  return ordered(next) ? next : current;
}


/** @param {number} value @param {number | null} [step] */
export function formatMetricValue(value, step = null) {
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


/** @param {number | null} value @param {number} step */
export function formatRawBound(value, step) {
  return value === null ? "N/A" : formatMetricValue(value, step);
}


/**
 * Compact visible summary for an active raw QC interval. The lower endpoint
 * is inclusive and the upper endpoint is exclusive.
 *
 * @param {{ lower: number | null, upper: number | null }} range
 * @param {number} step
 */
export function formatQcRangeSummary(range, step) {
  if (!isQcRangeActive(range)) {
    return "";
  }
  const lower = range.lower === null ? null : formatMetricValue(range.lower, step);
  const upper = range.upper === null ? null : formatMetricValue(range.upper, step);
  if (lower !== null && upper !== null) {
    return `[${lower}, ${upper})`;
  }
  return lower !== null ? `[${lower}, )` : `[, ${upper})`;
}


/**
 * Screen-reader wording for the same raw QC interval.
 *
 * @param {{ lower: number | null, upper: number | null }} range
 * @param {number} step
 */
export function describeQcRange(range, step) {
  if (!isQcRangeActive(range)) {
    return "";
  }
  const lower = range.lower === null ? null : formatMetricValue(range.lower, step);
  const upper = range.upper === null ? null : formatMetricValue(range.upper, step);
  if (lower !== null && upper !== null) {
    return `threshold from ${lower} inclusive to ${upper} exclusive`;
  }
  if (lower !== null) {
    return `threshold ${lower} or greater; no upper limit`;
  }
  return `threshold below ${upper}; no lower limit`;
}


/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


/** @param {number} value */
export function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}


/** @param {number[]} a @param {number[]} b @param {number} t */
export function interpolateRgb(a, b, t) {
  const f = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}


/** @param {number[]} rgb @param {number} [alpha] */
export function rgbString(rgb, alpha = 1) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}


/** @param {number} value @param {number} lower @param {number} upper */
export function blueprintColorForValue(value, lower, upper) {
  const z = clamp01((value - lower) / Math.max(upper - lower, 1e-12));
  const red = [202, 0, 32];
  const mid = [247, 247, 247];
  const blue = [5, 113, 176];
  if (z <= 0.5) {
    return rgbString(interpolateRgb(red, mid, z / 0.5), 0.95);
  }
  return rgbString(interpolateRgb(mid, blue, (z - 0.5) / 0.5), 0.95);
}


/**
 * @param {number[]} metricValues
 * @param {{
 *   min: number, max: number, span: number, step: number,
 * }} domain
 * @param {number} [binCount]
 */
export function buildHistogram(metricValues, domain, binCount = 72) {
  const finite = metricValues.filter((value) => Number.isFinite(value));
  if (!finite.length) {
    return null;
  }

  const requestedBinCount = Math.max(3, Math.floor(Number(binCount) || 72));
  const regularBinCount = requestedBinCount;
  const span = Math.max(domain.max - domain.min, QC_RANGE_EPS);
  const binWidth = span / regularBinCount;
  const regularCounts = new Array(regularBinCount).fill(0);

  for (const value of finite) {
    if (value < domain.min || value > domain.max) {
      continue;
    }
    const bin = Math.max(
      0,
      Math.min(
        regularBinCount - 1,
        Math.floor((value - domain.min) / binWidth),
      ),
    );
    regularCounts[bin] += 1;
  }

  const regularCenters = regularCounts.map(
    (_, index) => domain.min + (index + 0.5) * binWidth,
  );
  const regularHoverLabels = regularCounts.map((_, index) => {
    const lower = domain.min + index * binWidth;
    const upper = lower + binWidth;
    const closing = index === regularBinCount - 1 ? "]" : ")";
    return `[${formatMetricValue(lower)}, ${formatMetricValue(upper)}${closing}`;
  });

  return {
    centers: regularCenters,
    counts: regularCounts,
    widths: regularCounts.map(() => binWidth),
    binWidth,
    hoverLabels: regularHoverLabels,
    viewMin: domain.min,
    viewMax: domain.max,
    domain,
  };
}
