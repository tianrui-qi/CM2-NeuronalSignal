const PERSISTED_UI_STATE_KEYS = Object.freeze([
  "rois",
  "activeRoiId",
  "activeSignalSource",
  "activeTraceValueMode",
  "traceDfSpacingRaw",
  "traceDfPixelsPerKiloRaw",
  "traceDffSpacingPercent",
  "traceDffPixelsPerPercent",
  "heatmapRangeBySource",
  "activeBackgroundKey",
  "backgroundRanges",
  "activeBlueprintMetric",
  "blueprintColorRanges",
  "qcRanges",
  "regionPolygons",
  "openSections",
  "overlayWidth",
]);

const WORKFLOW_SECTION_KEYS = Object.freeze([
  "background",
  "qc",
  "region",
  "roi",
  "temporalHeatmap",
  "temporalTrace",
]);

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** @param {Record<string, any>} value @param {readonly string[]} expectedKeys */
function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => expectedKeys.includes(key));
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} value */
function isOptionalFiniteRange(value) {
  if (!isObject(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length >= 1
    && keys.length <= 2
    && keys.every((key) => key === "min" || key === "max")
    && keys.every((key) => isFiniteNumber(value[key]));
}

/** @param {unknown} value @param {boolean} nullable */
function isBoundRangeMap(value, nullable) {
  return isObject(value) && Object.entries(value).every(([metricKey, range]) => (
    metricKey.length > 0
    && isObject(range)
    && hasExactKeys(range, ["lower", "upper"])
    && [range.lower, range.upper].every((bound) => (
      isFiniteNumber(bound) || (nullable && bound === null)
    ))
  ));
}

/** @param {unknown} value */
function isBackgroundRangeMap(value) {
  return isObject(value) && Object.entries(value).every(([backgroundKey, range]) => (
    backgroundKey.length > 0
    && isObject(range)
    && hasExactKeys(range, ["lower", "upper"])
    && Number.isSafeInteger(range.lower)
    && Number.isSafeInteger(range.upper)
    && range.lower < range.upper
  ));
}

/** @param {unknown} value */
function isRoiBox(value) {
  return value === null || (
    isObject(value)
    && hasExactKeys(value, ["x", "y", "width", "height"])
    && isFiniteNumber(value.x)
    && isFiniteNumber(value.y)
    && isFiniteNumber(value.width)
    && value.width > 0
    && isFiniteNumber(value.height)
    && value.height > 0
  );
}

/**
 * Accept only the current persisted viewer-state shape. A missing state is
 * handled by the caller as a fresh viewer; partial or superseded shapes are
 * rejected as a whole.
 *
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isCanonicalPersistedUiState(value) {
  if (!isObject(value) || !hasExactKeys(value, PERSISTED_UI_STATE_KEYS)) {
    return false;
  }

  const roiIds = new Set();
  const neuronIds = new Set();
  if (!Array.isArray(value.rois) || !value.rois.every((roi) => {
    if (
      !isObject(roi)
      || !hasExactKeys(roi, ["id", "name", "color", "box", "neuronIds"])
      || typeof roi.id !== "string"
      || roi.id.length === 0
      || roiIds.has(roi.id)
      || typeof roi.name !== "string"
      || roi.name.trim().length === 0
      || typeof roi.color !== "string"
      || roi.color.length === 0
      || !isRoiBox(roi.box)
      || !Array.isArray(roi.neuronIds)
    ) {
      return false;
    }
    roiIds.add(roi.id);
    return roi.neuronIds.every((neuronId) => {
      if (!Number.isSafeInteger(neuronId) || neuronIds.has(neuronId)) {
        return false;
      }
      neuronIds.add(neuronId);
      return true;
    });
  })) {
    return false;
  }

  if (
    value.activeRoiId !== null
    && (typeof value.activeRoiId !== "string" || !roiIds.has(value.activeRoiId))
  ) {
    return false;
  }

  return (
    (value.activeSignalSource === "c_bl" || value.activeSignalSource === "c_bl_plus_yra")
    && (value.activeTraceValueMode === "df" || value.activeTraceValueMode === "dff")
    && isFiniteNumber(value.traceDfSpacingRaw)
    && isFiniteNumber(value.traceDfPixelsPerKiloRaw)
    && isFiniteNumber(value.traceDffSpacingPercent)
    && isFiniteNumber(value.traceDffPixelsPerPercent)
    && isObject(value.heatmapRangeBySource)
    && Object.entries(value.heatmapRangeBySource).every(([sourceKey, range]) => (
      sourceKey.length > 0 && isOptionalFiniteRange(range)
    ))
    && typeof value.activeBackgroundKey === "string"
    && value.activeBackgroundKey.length > 0
    && isBackgroundRangeMap(value.backgroundRanges)
    && typeof value.activeBlueprintMetric === "string"
    && value.activeBlueprintMetric.length > 0
    && isBoundRangeMap(value.blueprintColorRanges, false)
    && isBoundRangeMap(value.qcRanges, true)
    && Array.isArray(value.regionPolygons)
    && value.regionPolygons.every((polygon) => (
      Array.isArray(polygon)
      && polygon.length >= 3
      && polygon.every((point) => (
        isObject(point)
        && hasExactKeys(point, ["x", "y"])
        && isFiniteNumber(point.x)
        && isFiniteNumber(point.y)
      ))
    ))
    && isObject(value.openSections)
    && hasExactKeys(value.openSections, WORKFLOW_SECTION_KEYS)
    && WORKFLOW_SECTION_KEYS.every((key) => typeof value.openSections[key] === "boolean")
    && (value.overlayWidth === null || isFiniteNumber(value.overlayWidth))
  );
}

/**
 * @param {Record<string, any>} state
 * @param {string | null} roiId
 */
export function selectRoiById(state, roiId) {
  return state.rois.find((roi) => roi.id === roiId) ?? null;
}

/**
 * Return the canonical persistence payload without cloning any nested state.
 * The UI-state transport retains responsibility for serialization.
 *
 * @param {Record<string, any>} state
 */
export function selectPersistedUiState(state) {
  return {
    rois: state.rois,
    activeRoiId: state.activeRoiId,
    activeSignalSource: state.activeSignalSource,
    activeTraceValueMode: state.activeTraceValueMode,
    traceDfSpacingRaw: state.traceDfSpacingRaw,
    traceDfPixelsPerKiloRaw: state.traceDfPixelsPerKiloRaw,
    traceDffSpacingPercent: state.traceDffSpacingPercent,
    traceDffPixelsPerPercent: state.traceDffPixelsPerPercent,
    heatmapRangeBySource: state.heatmapRangeBySource,
    activeBackgroundKey: state.activeBackgroundKey,
    backgroundRanges: state.backgroundRanges,
    activeBlueprintMetric: state.activeBlueprintMetric,
    blueprintColorRanges: state.blueprintColorRanges,
    qcRanges: state.qcRanges,
    regionPolygons: state.regionPolygons,
    openSections: state.openSections,
    overlayWidth: state.overlayWidth,
  };
}
