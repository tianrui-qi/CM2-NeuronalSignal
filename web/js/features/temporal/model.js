export const TRACE_SOURCE_ORDER = Object.freeze(["c_bl", "c_bl_plus_yra"]);
export const TRACE_SOURCE_UI_LABELS = Object.freeze({
  c_bl: "C - bl",
  c_bl_plus_yra: "C - bl + YrA",
});

export const TRACE_VALUE_MODE_ORDER = Object.freeze(["df", "dff"]);
export const TRACE_VALUE_MODE_UI_LABELS = Object.freeze({
  df: "ΔF",
  dff: "ΔF/F",
});

export const TRACE_EFFECTIVE_SOURCES = Object.freeze({
  df: Object.freeze({
    c_bl: "c_bl",
    c_bl_plus_yra: "c_bl_plus_yra",
  }),
  dff: Object.freeze({
    c_bl: "dff_c_bl",
    c_bl_plus_yra: "dff_c_bl_plus_yra",
  }),
});

/**
 * @type {Readonly<Record<string, Readonly<{
 *   baseSource: string,
 *   subtractMetric?: string,
 *   usesDffDenominator?: boolean,
 * }>>>}
 */
export const TRACE_VIRTUAL_SOURCES = Object.freeze({
  c_bl: Object.freeze({ baseSource: "c", subtractMetric: "bl" }),
  c_bl_plus_yra: Object.freeze({ baseSource: "c_plus_yra", subtractMetric: "bl" }),
  dff_c_bl: Object.freeze({
    baseSource: "c",
    subtractMetric: "bl",
    usesDffDenominator: true,
  }),
  dff_c_bl_plus_yra: Object.freeze({
    baseSource: "c_plus_yra",
    subtractMetric: "bl",
    usesDffDenominator: true,
  }),
});

export const TRACE_DFF_SPACING_PERCENT_MIN = 5;
export const TRACE_DFF_SPACING_PERCENT_MAX = 20;
export const TRACE_DFF_SPACING_PERCENT_STEP = 1;
export const TRACE_DFF_SPACING_PERCENT_DEFAULT = 10;
export const TRACE_DFF_PIXELS_PER_PERCENT_MIN = 1;
export const TRACE_DFF_PIXELS_PER_PERCENT_MAX = 12;
export const TRACE_DFF_PIXELS_PER_PERCENT_STEP = 1;
export const TRACE_DFF_PIXELS_PER_PERCENT_DEFAULT = 5;
export const TRACE_DF_SPACING_RAW_MIN = 1000;
export const TRACE_DF_SPACING_RAW_MAX = 30000;
export const TRACE_DF_SPACING_RAW_STEP = 1000;
export const TRACE_DF_SPACING_RAW_DEFAULT = 15000;
export const TRACE_DF_PIXELS_PER_KILO_RAW_MIN = 1;
export const TRACE_DF_PIXELS_PER_KILO_RAW_MAX = 12;
export const TRACE_DF_PIXELS_PER_KILO_RAW_STEP = 1;
export const TRACE_DF_PIXELS_PER_KILO_RAW_DEFAULT = 3;
export const TRACE_DF_RAW_VALUES_PER_KILO = 1000;

export const TRACE_ROW_STEP_FALLBACK = 1;
export const TRACE_ROW_STEP_MIN = 1e-6;
export const TRACE_ZERO_GUIDE_COLOR = "rgba(255, 255, 255, 0.16)";
export const TRACE_DFF_THRESHOLD_VALUE = 0.05;
export const TRACE_DFF_THRESHOLD_COLOR = "rgba(255, 255, 255, 0.28)";
export const TRACE_DFF_THRESHOLD_LABEL = `${Math.round(TRACE_DFF_THRESHOLD_VALUE * 100)} %`;
export const TRACE_DFF_THRESHOLD_LABEL_FONT_PX = 11;
export const TRACE_DFF_THRESHOLD_LABEL_YSHIFT_PX = 2;
export const TRACE_DFF_THRESHOLD_LABEL_CLEARANCE_PX = Math.ceil(
  TRACE_DFF_THRESHOLD_LABEL_FONT_PX * 1.25 + TRACE_DFF_THRESHOLD_LABEL_YSHIFT_PX + 3,
);

export const HEATMAP_ROW_HEIGHT_PX = 0.8;
export const HEATMAP_VERTICAL_MARGIN_PX = 16;
export const HEATMAP_PERCENT_SCALE = 100;
export const HEATMAP_DF_RANGE_MIN_STEP_VALUE = 1;
export const HEATMAP_DF_RANGE_TARGET_STEP_COUNT = 50;


/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


/**
 * @param {Record<string, any>} state
 * @param {number} neuronId
 * @param {((neuronId: number) => number | null) | undefined} pointIndexForNeuronId
 */
function resolvePointIndex(state, neuronId, pointIndexForNeuronId) {
  if (pointIndexForNeuronId) {
    return pointIndexForNeuronId(neuronId) ?? null;
  }
  return state.pointIndexByNeuronId?.get(neuronId) ?? null;
}


/**
 * Map the user-facing signal/value pair to the cache source used for display.
 * Unknown value modes fall back to the requested signal source.
 *
 * @param {string} signalSource
 * @param {string} valueMode
 */
export function getEffectiveTraceSourceKey(signalSource, valueMode) {
  return TRACE_EFFECTIVE_SOURCES[/** @type {keyof typeof TRACE_EFFECTIVE_SOURCES} */ (valueMode)]
    ?.[/** @type {"c_bl" | "c_bl_plus_yra"} */ (signalSource)] ?? signalSource;
}


/** @param {string} sourceKey */
export function getTraceBaseSourceKey(sourceKey) {
  return TRACE_VIRTUAL_SOURCES[/** @type {keyof typeof TRACE_VIRTUAL_SOURCES} */ (sourceKey)]
    ?.baseSource ?? sourceKey;
}


/** @param {string} sourceKey */
export function isDynamicDffSource(sourceKey) {
  return Boolean(
    TRACE_VIRTUAL_SOURCES[/** @type {keyof typeof TRACE_VIRTUAL_SOURCES} */ (sourceKey)]
      ?.usesDffDenominator,
  );
}


/**
 * Availability is metadata-owned so lazy physical buffers do not remove an
 * otherwise valid Source or Mode control while it is still loading.
 *
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 */
export function isTraceSourceAvailable(state, sourceKey) {
  if (state.meta?.trace_sources?.[sourceKey]) {
    return true;
  }
  const virtual = TRACE_VIRTUAL_SOURCES[
    /** @type {keyof typeof TRACE_VIRTUAL_SOURCES} */ (sourceKey)
  ];
  return Boolean(
    virtual
    && state.meta?.trace_sources?.[virtual.baseSource]
    && (!virtual.subtractMetric || Array.isArray(state.points?.metrics?.[virtual.subtractMetric]))
    && (!virtual.usesDffDenominator || state.meta?.dff?.denominator_file)
  );
}


/**
 * Rendering additionally requires the lazy base buffer and, for DF/F, the
 * row-aligned denominator vector loaded with the core cache.
 *
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 */
export function isTraceSourceLoaded(state, sourceKey) {
  const baseSourceKey = getTraceBaseSourceKey(sourceKey);
  const traceBuffer = state.tracesBySource?.[baseSourceKey];
  if (!(traceBuffer instanceof Float32Array)) {
    return false;
  }
  if (!isDynamicDffSource(sourceKey)) {
    return true;
  }
  return state.dffDenominators instanceof Float64Array
    && state.dffDenominators.length === state.meta?.neuron_count;
}


/** @param {Record<string, any>} state */
export function getAvailableTraceSourceKeys(state) {
  return TRACE_SOURCE_ORDER.filter((sourceKey) => (
    TRACE_VALUE_MODE_ORDER.some((valueMode) => (
      isTraceSourceAvailable(state, getEffectiveTraceSourceKey(sourceKey, valueMode))
    ))
  ));
}


/**
 * @param {Record<string, any>} state
 * @param {string} valueMode
 * @param {string} signalSource
 */
export function isTraceValueModeAvailable(state, valueMode, signalSource) {
  return TRACE_VALUE_MODE_ORDER.includes(/** @type {string} */ (valueMode))
    && isTraceSourceAvailable(state, getEffectiveTraceSourceKey(signalSource, valueMode));
}


/** @param {Record<string, any>} state @param {string} signalSource */
export function getAvailableTraceValueModes(state, signalSource) {
  return TRACE_VALUE_MODE_ORDER.filter((valueMode) => (
    isTraceValueModeAvailable(state, valueMode, signalSource)
  ));
}


/**
 * Return the first available source without mutating viewer state.
 * If no source exists, the candidate is retained exactly as before.
 *
 * @param {Record<string, any>} state
 * @param {unknown} candidate
 */
export function normalizeActiveTraceSource(state, candidate) {
  const available = getAvailableTraceSourceKeys(state);
  return available.length && !available.includes(/** @type {string} */ (candidate))
    ? available[0]
    : candidate;
}


/**
 * @param {Record<string, any>} state
 * @param {unknown} candidate
 * @param {string} signalSource
 */
export function normalizeActiveTraceValueMode(state, candidate, signalSource) {
  const available = getAvailableTraceValueModes(state, signalSource);
  return available.length && !available.includes(/** @type {string} */ (candidate))
    ? available[0]
    : candidate;
}


/**
 * Normalize canonical persisted per-source Heatmap range objects. Either
 * endpoint may be omitted so the rendered data domain supplies that endpoint.
 *
 * @param {unknown} value
 */
export function normalizeHeatmapRangeBySource(value) {
  /** @type {Record<string, { min?: number, max?: number }>} */
  const normalized = {};
  if (value && typeof value === "object") {
    for (const [sourceKey, sourceRange] of Object.entries(value)) {
      if (typeof sourceKey !== "string") {
        continue;
      }
      if (sourceRange && typeof sourceRange === "object" && !Array.isArray(sourceRange)) {
        const candidate = /** @type {Record<string, unknown>} */ (sourceRange);
        const min = candidate.min;
        const max = candidate.max;
        /** @type {{ min?: number, max?: number }} */
        const nextRange = {};
        if (Number.isFinite(min)) {
          nextRange.min = snapHeatmapRangeMinValue(sourceKey, min);
        }
        if (Number.isFinite(max)) {
          nextRange.max = snapHeatmapRangeMaxValue(sourceKey, max);
        }
        if (Object.keys(nextRange).length) {
          normalized[sourceKey] = nextRange;
        }
      }
    }
  }
  return normalized;
}


/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {number} step
 */
export function normalizeTraceControlValue(value, fallback, min, max, step) {
  const numericValue = Number(value);
  const numericFallback = Number.isFinite(fallback) ? fallback : min;
  const scalar = Number.isFinite(numericValue) ? numericValue : numericFallback;
  const stepped = Math.round(scalar / step) * step;
  return Number(clamp(stepped, min, max).toFixed(2));
}


/** @param {unknown} value @param {number} fallback */
export function normalizeTraceDffSpacingPercent(
  value,
  fallback = TRACE_DFF_SPACING_PERCENT_DEFAULT,
) {
  return normalizeTraceControlValue(
    value,
    fallback,
    TRACE_DFF_SPACING_PERCENT_MIN,
    TRACE_DFF_SPACING_PERCENT_MAX,
    TRACE_DFF_SPACING_PERCENT_STEP,
  );
}


/** @param {unknown} value @param {number} fallback */
export function normalizeTraceDffPixelsPerPercent(
  value,
  fallback = TRACE_DFF_PIXELS_PER_PERCENT_DEFAULT,
) {
  return normalizeTraceControlValue(
    value,
    fallback,
    TRACE_DFF_PIXELS_PER_PERCENT_MIN,
    TRACE_DFF_PIXELS_PER_PERCENT_MAX,
    TRACE_DFF_PIXELS_PER_PERCENT_STEP,
  );
}


/** @param {unknown} value @param {number} fallback */
export function normalizeTraceDfSpacingRaw(
  value,
  fallback = TRACE_DF_SPACING_RAW_DEFAULT,
) {
  return normalizeTraceControlValue(
    value,
    fallback,
    TRACE_DF_SPACING_RAW_MIN,
    TRACE_DF_SPACING_RAW_MAX,
    TRACE_DF_SPACING_RAW_STEP,
  );
}


/** @param {unknown} value @param {number} fallback */
export function normalizeTraceDfPixelsPerKiloRaw(
  value,
  fallback = TRACE_DF_PIXELS_PER_KILO_RAW_DEFAULT,
) {
  return normalizeTraceControlValue(
    value,
    fallback,
    TRACE_DF_PIXELS_PER_KILO_RAW_MIN,
    TRACE_DF_PIXELS_PER_KILO_RAW_MAX,
    TRACE_DF_PIXELS_PER_KILO_RAW_STEP,
  );
}


/**
 * Produce the Temporal-owned hydration patch without mutating state. Invalid
 * explicit source/value choices retain the pre-hydration value, while missing
 * scale/range controls use current defaults.
 *
 * @param {Record<string, any>} state
 * @param {unknown} parsed
 */
export function normalizePersistedTemporalState(state, parsed) {
  const payload = parsed && typeof parsed === "object"
    ? /** @type {Record<string, any>} */ (parsed)
    : {};
  const activeSignalSource = isTraceSourceAvailable(state, payload.activeSignalSource)
    ? payload.activeSignalSource
    : state.activeSignalSource;
  const availabilityState = { ...state, activeSignalSource };
  const activeTraceValueMode = isTraceValueModeAvailable(
    availabilityState,
    payload.activeTraceValueMode,
    activeSignalSource,
  )
    ? payload.activeTraceValueMode
    : state.activeTraceValueMode;

  return {
    activeSignalSource,
    activeTraceValueMode,
    traceDfSpacingRaw: normalizeTraceDfSpacingRaw(payload.traceDfSpacingRaw),
    traceDfPixelsPerKiloRaw: normalizeTraceDfPixelsPerKiloRaw(
      payload.traceDfPixelsPerKiloRaw,
    ),
    traceDffSpacingPercent: normalizeTraceDffSpacingPercent(
      payload.traceDffSpacingPercent,
    ),
    traceDffPixelsPerPercent: normalizeTraceDffPixelsPerPercent(
      payload.traceDffPixelsPerPercent,
    ),
    heatmapRangeBySource: normalizeHeatmapRangeBySource(payload.heatmapRangeBySource),
  };
}


/**
 * Trace artifacts are neuron-major flat buffers. The cache exposes the binary row
 * separately from the stable neuron identifier.
 *
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 * @param {number} neuronId
 */
export function getTraceSlice(state, sourceKey, neuronId) {
  const baseSourceKey = getTraceBaseSourceKey(sourceKey);
  const traceBuffer = state.tracesBySource?.[baseSourceKey];
  if (!(traceBuffer instanceof Float32Array)) {
    throw new Error(`Trace source ${baseSourceKey} has not been loaded.`);
  }
  const pointIndex = resolvePointIndex(state, neuronId, undefined);
  const traceRow = pointIndex === null
    ? null
    : state.points?.traceRow?.[pointIndex];
  if (!Number.isInteger(traceRow)) {
    throw new Error(`Missing trace row for neuron ${neuronId}.`);
  }
  const offset = traceRow * state.meta.trace_length;
  return traceBuffer.subarray(offset, offset + state.meta.trace_length);
}


/**
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 * @param {number} neuronId
 * @param {{ pointIndexForNeuronId?: (neuronId: number) => number | null }} [dependencies]
 */
export function getTraceSubtractValue(
  state,
  sourceKey,
  neuronId,
  { pointIndexForNeuronId } = {},
) {
  const metricKey = TRACE_VIRTUAL_SOURCES[
    /** @type {keyof typeof TRACE_VIRTUAL_SOURCES} */ (sourceKey)
  ]?.subtractMetric;
  if (!metricKey) {
    return 0;
  }
  const pointIndex = resolvePointIndex(state, neuronId, pointIndexForNeuronId);
  const value = pointIndex === null ? null : state.points.metrics?.[metricKey]?.[pointIndex];
  return Number.isFinite(value) ? value : 0;
}


/** @param {Record<string, any>} state */
export function getDffMinBaselineAbs(state) {
  return state.meta.dff.min_baseline_abs;
}


/**
 * Read the cache-built median by canonical trace row. The Float64 artifact
 * preserves the former browser calculation without retaining the full
 * projected-background trace matrix.
 *
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 * @param {number} neuronId
 */
export function getDffDenominator(state, sourceKey, neuronId) {
  if (!isDynamicDffSource(sourceKey)) {
    return NaN;
  }
  const pointIndex = resolvePointIndex(state, neuronId, undefined);
  const traceRow = pointIndex === null
    ? null
    : state.points?.traceRow?.[pointIndex];
  if (!Number.isInteger(traceRow)) {
    return NaN;
  }
  const denominator = state.dffDenominators?.[traceRow];
  return typeof denominator === "number" ? denominator : NaN;
}


/**
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 * @param {number} neuronId
 * @param {number} rawValue
 * @param {{
 *   pointIndexForNeuronId?: (neuronId: number) => number | null,
 *   dffDenominator?: number,
 * }} [dependencies]
 */
export function getTraceDisplayValue(
  state,
  sourceKey,
  neuronId,
  rawValue,
  dependencies = {},
) {
  const value = rawValue - getTraceSubtractValue(state, sourceKey, neuronId, dependencies);
  if (!isDynamicDffSource(sourceKey)) {
    return value;
  }
  const denominator = Object.prototype.hasOwnProperty.call(dependencies, "dffDenominator")
    ? dependencies.dffDenominator
    : getDffDenominator(state, sourceKey, neuronId);
  if (
    typeof denominator !== "number"
    || !Number.isFinite(denominator)
    || Math.abs(denominator) <= getDffMinBaselineAbs(state)
  ) {
    return NaN;
  }
  return value / denominator;
}


/**
 * Build one row's value reader. The denominator lookup happens once per row;
 * there is no projection-trace calculation or mutable memoization.
 *
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 * @param {number} neuronId
 * @param {{
 *   pointIndexForNeuronId?: (neuronId: number) => number | null,
 * }} dependencies
 */
function createTraceDisplayValueReader(state, sourceKey, neuronId, dependencies) {
  const rowDependencies = isDynamicDffSource(sourceKey)
    ? {
        ...dependencies,
        dffDenominator: getDffDenominator(state, sourceKey, neuronId),
      }
    : dependencies;
  return (rawValue) => getTraceDisplayValue(
    state,
    sourceKey,
    neuronId,
    rawValue,
    rowDependencies,
  );
}


/**
 * @param {Record<string, any>} state
 * @param {readonly number[]} neuronIds
 * @param {{ pointIndexForNeuronId?: (neuronId: number) => number | null }} [dependencies]
 */
export function sortNeuronIdsByPosition(state, neuronIds, { pointIndexForNeuronId } = {}) {
  return [...neuronIds].sort((a, b) => {
    const aIndex = resolvePointIndex(state, a, pointIndexForNeuronId);
    const bIndex = resolvePointIndex(state, b, pointIndexForNeuronId);
    if (aIndex === null || bIndex === null) {
      return 0;
    }
    const dx = state.points.x[aIndex] - state.points.x[bIndex];
    return dx !== 0 ? dx : state.points.y[aIndex] - state.points.y[bIndex];
  });
}


/**
 * @param {Record<string, any>} _state
 * @param {{ neuronIds: number[] } | null} roi
 * @param {unknown[]} filters
 * @param {{
 *   neuronPassesSelection: (neuronId: number, roi: any, filters: unknown[]) => boolean,
 * }} dependencies
 */
export function getSelectedTraceNeuronIds(_state, roi, filters, { neuronPassesSelection }) {
  if (!roi) {
    return [];
  }
  return roi.neuronIds.filter((neuronId) => neuronPassesSelection(neuronId, roi, filters));
}


/**
 * A boxed ROI's Heatmap contains every eligible point in the half-open box;
 * an unboxed ROI contains only its selected Trace neurons in selection order.
 * ROI and QC policies enter only through narrow callbacks.
 *
 * @param {Record<string, any>} state
 * @param {{ box?: any, neuronIds: number[] } | null} roi
 * @param {unknown[]} filters
 * @param {{
 *   neuronPassesSelection: (neuronId: number, roi: any, filters: unknown[]) => boolean,
 *   pointPassesEligibility: (pointIndex: number, filters: unknown[]) => boolean,
 *   pointIndexInBox: (pointIndex: number, roi: any) => boolean,
 *   pointIndexForNeuronId?: (neuronId: number) => number | null,
 * }} dependencies
 */
export function getHeatmapNeuronIds(state, roi, filters, dependencies) {
  if (!roi) {
    return [];
  }
  if (!roi.box) {
    return getSelectedTraceNeuronIds(state, roi, filters, dependencies);
  }
  const neuronIds = [];
  for (let pointIndex = 0; pointIndex < state.points.id.length; pointIndex += 1) {
    if (
      dependencies.pointPassesEligibility(pointIndex, filters)
      && dependencies.pointIndexInBox(pointIndex, roi)
    ) {
      neuronIds.push(state.points.id[pointIndex]);
    }
  }
  return sortNeuronIdsByPosition(state, neuronIds, dependencies);
}


/**
 * The Heatmap color domain is derived from the union of every ROI's heatmap
 * membership, not only the active ROI. The Set preserves first occurrence
 * before the stable position sort is applied.
 *
 * @param {Record<string, any>} state
 * @param {unknown[]} filters
 * @param {Parameters<typeof getHeatmapNeuronIds>[3]} dependencies
 */
export function getAllHeatmapNeuronIds(state, filters, dependencies) {
  const neuronIds = new Set();
  for (const roi of state.rois) {
    for (const neuronId of getHeatmapNeuronIds(state, roi, filters, dependencies)) {
      neuronIds.add(neuronId);
    }
  }
  return sortNeuronIdsByPosition(state, [...neuronIds], dependencies);
}


/** @param {Record<string, any>} state */
export function getTraceDffSpacingPercent(state) {
  return normalizeTraceDffSpacingPercent(state.traceDffSpacingPercent);
}


/** @param {Record<string, any>} state */
export function getTraceDffSpacingValue(state) {
  return getTraceDffSpacingPercent(state) / 100;
}


/** @param {Record<string, any>} state */
export function getTraceDffPixelsPerPercent(state) {
  return normalizeTraceDffPixelsPerPercent(state.traceDffPixelsPerPercent);
}


/** @param {Record<string, any>} state */
export function getTraceDffPixelsPerUnit(state) {
  return getTraceDffPixelsPerPercent(state) * 100;
}


/** @param {Record<string, any>} state */
export function getTraceDfSpacingRaw(state) {
  return normalizeTraceDfSpacingRaw(state.traceDfSpacingRaw);
}


/** @param {Record<string, any>} state */
export function getTraceDfPixelsPerKiloRaw(state) {
  return normalizeTraceDfPixelsPerKiloRaw(state.traceDfPixelsPerKiloRaw);
}


/** @param {Record<string, any>} state */
export function getTraceDfPixelsPerRawUnit(state) {
  return getTraceDfPixelsPerKiloRaw(state) / TRACE_DF_RAW_VALUES_PER_KILO;
}


/** @param {string} _sourceKey */
export function getTraceDffThresholdDisplayValue(_sourceKey) {
  return TRACE_DFF_THRESHOLD_VALUE;
}


/**
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 */
export function getTraceRowStep(state, sourceKey) {
  const spacing = isDynamicDffSource(sourceKey)
    ? getTraceDffSpacingValue(state)
    : getTraceDfSpacingRaw(state);
  return Math.max(spacing, TRACE_ROW_STEP_MIN);
}


/** @param {Record<string, any>} state @param {string} sourceKey */
export function getTracePixelsPerDisplayUnit(state, sourceKey) {
  return isDynamicDffSource(sourceKey)
    ? getTraceDffPixelsPerUnit(state)
    : getTraceDfPixelsPerRawUnit(state);
}


/**
 * Create the Plotly-independent trace data descriptor. The caller owns active
 * ROI/QC membership and passes the already ordered neuron list.
 *
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 * @param {readonly number[]} neuronIds
 * @param {{
 *   pointIndexForNeuronId?: (neuronId: number) => number | null,
 *   forceDffThresholdGuide?: boolean,
 * }} [dependencies]
 */
export function buildTracePlotData(state, sourceKey, neuronIds, dependencies = {}) {
  const nFrames = state.meta.trace_length;
  const frames = Array.from({ length: nFrames }, (_, index) => index);
  /** @type {any[]} */
  const traces = [];
  /** @type {any[]} */
  const shapes = [];
  /** @type {any[]} */
  const annotations = [];
  /** @type {{ x: number[], y: number[] }} */
  const zeroGuide = { x: [], y: [] };
  /** @type {{ x: number[], y: number[] }} */
  const dffThresholdGuide = { x: [], y: [] };
  const showDffThreshold = sourceKey.startsWith("dff_")
    && (
      dependencies.forceDffThresholdGuide === true
      || getTraceDffSpacingPercent(state) > TRACE_DFF_SPACING_PERCENT_MIN
    );
  const traceLineColor = "rgba(255, 255, 255, 0.72)";
  let neuronCount = 0;
  let traceMinY = Infinity;
  let traceMaxY = -Infinity;
  /** @type {number | null} */
  let thresholdLabelY = null;
  const rowStep = getTraceRowStep(state, sourceKey);
  const dffThresholdDisplayValue = getTraceDffThresholdDisplayValue(sourceKey);
  if (neuronIds.length > 0) {
    neuronCount = neuronIds.length;
    neuronIds.forEach((neuronId, localIndex) => {
      const trace = getTraceSlice(state, sourceKey, neuronId);
      const displayValue = createTraceDisplayValueReader(
        state,
        sourceKey,
        neuronId,
        dependencies,
      );
      const baseline = -(localIndex * rowStep);
      const y = [];
      zeroGuide.x.push(0, nFrames - 1, NaN);
      zeroGuide.y.push(baseline, baseline, NaN);
      if (showDffThreshold) {
        const thresholdY = baseline + dffThresholdDisplayValue;
        dffThresholdGuide.x.push(0, nFrames - 1, NaN);
        dffThresholdGuide.y.push(thresholdY, thresholdY, NaN);
        if (localIndex === 0) {
          thresholdLabelY = thresholdY;
          annotations.push({
            x: 0,
            y: thresholdY,
            xref: "x",
            yref: "y",
            text: TRACE_DFF_THRESHOLD_LABEL,
            showarrow: false,
            xanchor: "left",
            yanchor: "bottom",
            xshift: -2,
            yshift: TRACE_DFF_THRESHOLD_LABEL_YSHIFT_PX,
            font: {
              color: "rgba(255, 255, 255, 0.72)",
              size: TRACE_DFF_THRESHOLD_LABEL_FONT_PX,
            },
          });
        }
      }
      for (let frameIndex = 0; frameIndex < nFrames; frameIndex += 1) {
        const yValue = baseline + displayValue(trace[frameIndex]);
        y.push(yValue);
        traceMinY = Math.min(traceMinY, yValue);
        traceMaxY = Math.max(traceMaxY, yValue);
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

  let yRange = [-TRACE_ROW_STEP_FALLBACK, TRACE_ROW_STEP_FALLBACK];
  if (Number.isFinite(traceMinY) && Number.isFinite(traceMaxY)) {
    if (traceMaxY > traceMinY) {
      yRange = [traceMinY, traceMaxY];
    } else {
      const halfSpan = Math.max(Math.abs(traceMinY) * 0.01, TRACE_ROW_STEP_MIN);
      yRange = [traceMinY - halfSpan, traceMaxY + halfSpan];
    }
  }
  if (typeof thresholdLabelY === "number" && Number.isFinite(thresholdLabelY)) {
    const labelClearance = TRACE_DFF_THRESHOLD_LABEL_CLEARANCE_PX
      / getTraceDffPixelsPerUnit(state);
    yRange[1] = Math.max(yRange[1], thresholdLabelY + labelClearance);
  }
  const ySpan = Math.max(yRange[1] - yRange[0], TRACE_ROW_STEP_MIN);
  const height = Math.ceil(ySpan * getTracePixelsPerDisplayUnit(state, sourceKey));
  const guideValues = [...zeroGuide.y, ...dffThresholdGuide.y]
    .filter(Number.isFinite);
  const guideRange = guideValues.length
    ? [Math.min(...guideValues), Math.max(...guideValues)]
    : null;
  return {
    traces,
    shapes,
    annotations,
    height,
    neuronCount,
    frameRange: [0, Math.max(nFrames - 1, 1)],
    yRange,
    guideRange,
  };
}


/**
 * Build a Plotly-independent heatmap descriptor. `neuronIds` is the active
 * ROI's visible membership; `domainNeuronIds` is the all-ROI union used to
 * keep the color domain stable while the active ROI changes.
 *
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 * @param {readonly number[]} neuronIds
 * @param {readonly number[]} domainNeuronIds
 * @param {{
 *   pointIndexForNeuronId?: (neuronId: number) => number | null,
 * }} [dependencies]
 */
export function buildHeatmapData(
  state,
  sourceKey,
  neuronIds,
  domainNeuronIds,
  dependencies = {},
) {
  const nFrames = state.meta.trace_length;
  const x = Array.from({ length: nFrames }, (_, index) => index);
  const z = [];
  let visibleMin = Infinity;
  let visibleMax = -Infinity;
  let domainMin = Infinity;
  let domainMax = -Infinity;
  for (const neuronId of neuronIds) {
    const trace = getTraceSlice(state, sourceKey, neuronId);
    const displayValue = createTraceDisplayValueReader(
      state,
      sourceKey,
      neuronId,
      dependencies,
    );
    z.push(Array.from(trace, (value) => {
      const nextValue = displayValue(value);
      if (Number.isFinite(nextValue)) {
        visibleMin = Math.min(visibleMin, nextValue);
        visibleMax = Math.max(visibleMax, nextValue);
      }
      return nextValue;
    }));
  }

  for (const neuronId of domainNeuronIds) {
    const trace = getTraceSlice(state, sourceKey, neuronId);
    const displayValue = createTraceDisplayValueReader(
      state,
      sourceKey,
      neuronId,
      dependencies,
    );
    for (let index = 0; index < trace.length; index += 1) {
      const nextValue = displayValue(trace[index]);
      if (Number.isFinite(nextValue)) {
        domainMin = Math.min(domainMin, nextValue);
        domainMax = Math.max(domainMax, nextValue);
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
    height: z.length * HEATMAP_ROW_HEIGHT_PX + HEATMAP_VERTICAL_MARGIN_PX,
    zMin: Number.isFinite(domainMin) ? domainMin : null,
    zMax: Number.isFinite(domainMax) ? domainMax : null,
  };
}


/** @param {string} sourceKey */
export function isHeatmapPercentSource(sourceKey) {
  return isDynamicDffSource(sourceKey);
}


/** @param {number} value */
export function heatmapValueToPercent(value) {
  const percent = Math.round(Number(value) * HEATMAP_PERCENT_SCALE);
  return Object.is(percent, -0) ? 0 : percent;
}


/** @param {number} percent */
export function heatmapPercentToValue(percent) {
  const value = Number(percent) / HEATMAP_PERCENT_SCALE;
  return Object.is(value, -0) ? 0 : value;
}


/** @param {number} value */
export function snapHeatmapValueToPercent(value) {
  return heatmapPercentToValue(heatmapValueToPercent(value));
}


/** @param {string} sourceKey @param {number} value */
export function snapHeatmapRangeMinValue(sourceKey, value) {
  if (isHeatmapPercentSource(sourceKey)) {
    return snapHeatmapValueToPercent(value);
  }
  const snapped = Math.floor(Number(value));
  return Object.is(snapped, -0) ? 0 : snapped;
}


/** @param {string} sourceKey @param {number} value */
export function snapHeatmapRangeMaxValue(sourceKey, value) {
  if (isHeatmapPercentSource(sourceKey)) {
    return snapHeatmapValueToPercent(value);
  }
  const snapped = Math.ceil(Number(value));
  return Object.is(snapped, -0) ? 0 : snapped;
}


/**
 * Choose an integer 1/2/5 x 10^n step that yields no more than roughly the
 * target number of ΔF positions. The scientific heatmap values stay untouched;
 * this step belongs only to the color-range control.
 *
 * @param {number} zMin
 * @param {number} zMax
 */
export function getHeatmapDfRangeStep(zMin, zMax) {
  const span = Number(zMax) - Number(zMin);
  if (!Number.isFinite(span) || span <= 0) {
    return HEATMAP_DF_RANGE_MIN_STEP_VALUE;
  }
  const rawStep = Math.max(
    HEATMAP_DF_RANGE_MIN_STEP_VALUE,
    span / HEATMAP_DF_RANGE_TARGET_STEP_COUNT,
  );
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const scaled = rawStep / magnitude;
  const factor = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return Math.max(
    HEATMAP_DF_RANGE_MIN_STEP_VALUE,
    Math.round(factor * magnitude),
  );
}


/**
 * Return exact data-domain endpoints plus zero-anchored nice interior values.
 * The range input uses indexes into this list so a negative endpoint cannot
 * offset every subsequent native HTML step.
 *
 * @param {number} zMin
 * @param {number} zMax
 */
export function buildHeatmapDfSliderValues(zMin, zMax) {
  const numericMin = Number(zMin);
  const numericMax = Number(zMax);
  if (!Number.isFinite(numericMin) || !Number.isFinite(numericMax)) {
    return [];
  }
  if (numericMax <= numericMin) {
    return [numericMin];
  }
  const step = getHeatmapDfRangeStep(numericMin, numericMax);
  const values = [numericMin];
  let candidate = Math.ceil(numericMin / step) * step;
  if (candidate <= numericMin) {
    candidate += step;
  }
  while (candidate < numericMax) {
    values.push(Object.is(candidate, -0) ? 0 : candidate);
    candidate += step;
  }
  if (values[values.length - 1] !== numericMax) {
    values.push(numericMax);
  }
  return values;
}


/** @param {readonly number[]} values @param {number} value */
function findHeatmapFloorIndex(values, value) {
  let index = 0;
  for (let candidateIndex = 1; candidateIndex < values.length; candidateIndex += 1) {
    if (values[candidateIndex] > value) {
      break;
    }
    index = candidateIndex;
  }
  return index;
}


/** @param {readonly number[]} values @param {number} value */
function findHeatmapCeilIndex(values, value) {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] >= value) {
      return index;
    }
  }
  return Math.max(0, values.length - 1);
}


/** @param {readonly number[]} values @param {number} value */
function findNearestHeatmapIndex(values, value) {
  const floorIndex = findHeatmapFloorIndex(values, value);
  const ceilIndex = findHeatmapCeilIndex(values, value);
  return Math.abs(values[floorIndex] - value) <= Math.abs(values[ceilIndex] - value)
    ? floorIndex
    : ceilIndex;
}


/** @param {string} sourceKey @param {number} zMin @param {number} zMax */
export function buildHeatmapColorDomain(sourceKey, zMin, zMax) {
  if (!isHeatmapPercentSource(sourceKey)) {
    const minValue = snapHeatmapRangeMinValue(sourceKey, zMin);
    let maxValue = snapHeatmapRangeMaxValue(sourceKey, zMax);
    if (maxValue <= minValue) {
      maxValue = minValue + HEATMAP_DF_RANGE_MIN_STEP_VALUE;
    }
    return { minValue, maxValue };
  }
  const minPercent = heatmapValueToPercent(zMin);
  let maxPercent = heatmapValueToPercent(zMax);
  if (maxPercent <= minPercent) {
    maxPercent = minPercent + 1;
  }
  return {
    minValue: heatmapPercentToValue(minPercent),
    maxValue: heatmapPercentToValue(maxPercent),
  };
}


/** @param {string} sourceKey @param {number} zMin @param {number} zMax */
export function getHeatmapRangeStepValue(sourceKey, zMin, zMax) {
  if (isHeatmapPercentSource(sourceKey)) {
    return heatmapPercentToValue(1);
  }
  return getHeatmapDfRangeStep(zMin, zMax);
}


/**
 * @param {string} sourceKey
 * @param {number} value
 * @param {number} zMin
 * @param {number} zMax
 */
export function heatmapValueToSliderValue(sourceKey, value, zMin, zMax) {
  if (isHeatmapPercentSource(sourceKey)) {
    return heatmapValueToPercent(value);
  }
  const values = buildHeatmapDfSliderValues(zMin, zMax);
  return values.length ? findNearestHeatmapIndex(values, Number(value)) : 0;
}


/**
 * @param {string} sourceKey
 * @param {number} value
 * @param {number} zMin
 * @param {number} zMax
 */
export function heatmapSliderValueToValue(sourceKey, value, zMin, zMax) {
  if (isHeatmapPercentSource(sourceKey)) {
    return heatmapPercentToValue(value);
  }
  const values = buildHeatmapDfSliderValues(zMin, zMax);
  if (!values.length) {
    return Number(zMin);
  }
  const index = clamp(Math.round(Number(value)), 0, values.length - 1);
  return values[index];
}


/** @param {string} sourceKey @param {number} zMin @param {number} zMax */
export function getHeatmapSliderSpec(sourceKey, zMin, zMax) {
  if (isHeatmapPercentSource(sourceKey)) {
    return {
      min: heatmapValueToPercent(zMin),
      max: heatmapValueToPercent(zMax),
      step: "1",
    };
  }
  const values = buildHeatmapDfSliderValues(zMin, zMax);
  return {
    min: 0,
    max: Math.max(0, values.length - 1),
    step: "1",
  };
}


/**
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 * @param {number} zMin
 * @param {number} zMax
 */
export function getHeatmapRangeForSource(state, sourceKey, zMin, zMax) {
  if (zMax <= zMin) {
    return { min: zMin, max: zMax };
  }
  if (!isHeatmapPercentSource(sourceKey)) {
    const values = buildHeatmapDfSliderValues(zMin, zMax);
    if (values.length < 2) {
      return { min: zMin, max: zMax };
    }
    const stored = state.heatmapRangeBySource?.[sourceKey] ?? {};
    const storedMin = Number(stored.min);
    const storedMax = Number(stored.max);
    const minIndex = Number.isFinite(storedMin)
      ? findHeatmapFloorIndex(values, clamp(storedMin, zMin, zMax))
      : 0;
    const maxIndex = Number.isFinite(storedMax)
      ? findHeatmapCeilIndex(values, clamp(storedMax, zMin, zMax))
      : values.length - 1;
    return minIndex < maxIndex
      ? { min: values[minIndex], max: values[maxIndex] }
      : { min: zMin, max: zMax };
  }
  const step = getHeatmapRangeStepValue(sourceKey, zMin, zMax);
  const stored = state.heatmapRangeBySource?.[sourceKey] ?? {};
  const storedMin = Number(stored.min);
  const storedMax = Number(stored.max);
  let min = Number.isFinite(storedMin)
    ? snapHeatmapRangeMinValue(sourceKey, clamp(storedMin, zMin, zMax - step))
    : zMin;
  let max = Number.isFinite(storedMax)
    ? snapHeatmapRangeMaxValue(sourceKey, clamp(storedMax, zMin + step, zMax))
    : zMax;

  if (min >= max) {
    min = zMin;
    max = zMax;
  }
  return { min, max };
}


/**
 * Resolve an interactive range update without writing state or persistence.
 * Invalid domains return `undefined`.
 *
 * @param {Record<string, any>} state
 * @param {string} sourceKey
 * @param {number} zMin
 * @param {number} zMax
 * @param {{ min?: unknown, max?: unknown } | null | undefined} nextRange
 */
export function computeHeatmapRangeUpdate(state, sourceKey, zMin, zMax, nextRange) {
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || zMax <= zMin) {
    return undefined;
  }
  if (!isHeatmapPercentSource(sourceKey)) {
    const values = buildHeatmapDfSliderValues(zMin, zMax);
    if (values.length < 2) {
      return { min: zMin, max: zMax };
    }
    const current = getHeatmapRangeForSource(state, sourceKey, zMin, zMax);
    let minIndex = findNearestHeatmapIndex(values, current.min);
    let maxIndex = findNearestHeatmapIndex(values, current.max);
    const nextMin = Number(nextRange?.min);
    const nextMax = Number(nextRange?.max);
    if (Number.isFinite(nextMin)) {
      minIndex = Math.min(
        findHeatmapFloorIndex(values, clamp(nextMin, zMin, zMax)),
        maxIndex - 1,
      );
    }
    if (Number.isFinite(nextMax)) {
      maxIndex = Math.max(
        findHeatmapCeilIndex(values, clamp(nextMax, zMin, zMax)),
        minIndex + 1,
      );
    }
    minIndex = clamp(minIndex, 0, values.length - 2);
    maxIndex = clamp(maxIndex, minIndex + 1, values.length - 1);
    return { min: values[minIndex], max: values[maxIndex] };
  }
  const step = getHeatmapRangeStepValue(sourceKey, zMin, zMax);
  const range = getHeatmapRangeForSource(state, sourceKey, zMin, zMax);
  const nextMin = Number(nextRange?.min);
  const nextMax = Number(nextRange?.max);
  if (Number.isFinite(nextMin)) {
    range.min = snapHeatmapRangeMinValue(
      sourceKey,
      clamp(nextMin, zMin, range.max - step),
    );
  }
  if (Number.isFinite(nextMax)) {
    range.max = snapHeatmapRangeMaxValue(
      sourceKey,
      clamp(nextMax, range.min + step, zMax),
    );
  }
  if (range.min >= range.max) {
    range.min = zMin;
    range.max = zMax;
  }
  return range;
}


/** @param {string} value */
function trimNumericLabel(value) {
  return value.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/^-0$/, "0");
}


/** @param {number} value */
export function formatRawHeatmapColorbarValue(value) {
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


/** @param {string} sourceKey @param {number} value */
export function formatHeatmapColorbarValue(sourceKey, value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }
  return isHeatmapPercentSource(sourceKey)
    ? `${heatmapValueToPercent(value)} %`
    : formatRawHeatmapColorbarValue(value);
}
