/**
 * @typedef {{
 *   type: "full-fov" | "region-all" | "region",
 *   countMode: "qc" | "raw",
 *   index?: number,
 * }} RegionDisplayScope
 */


/** @param {unknown} point */
export function normalizeRegionPoint(point) {
  if (point && typeof point === "object" && !Array.isArray(point)) {
    const candidate = /** @type {{ x?: unknown, y?: unknown }} */ (point);
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  return null;
}


/** @param {unknown} points */
export function normalizeRegionPolygon(points) {
  if (!Array.isArray(points)) {
    return [];
  }
  const normalized = points
    .map((point) => normalizeRegionPoint(point))
    .filter((point) => point !== null);
  return normalized.length >= 3 ? normalized : [];
}


/** @param {unknown} value */
export function normalizeRegionPolygons(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((polygon) => normalizeRegionPolygon(polygon))
    .filter((polygon) => polygon.length >= 3);
}


/** @param {Record<string, any>} state */
export function getCommittedRegionPolygons(state) {
  return normalizeRegionPolygons(state.regionPolygons);
}


/** @param {Record<string, any>} state */
export function getCommittedRegionCount(state) {
  return getCommittedRegionPolygons(state).length;
}


/** @param {Record<string, any>} state */
export function getDisplayedRegionPolygons(state) {
  return getCommittedRegionPolygons(state);
}


/** @param {unknown} countMode @returns {"qc" | "raw"} */
export function normalizeRegionCountMode(countMode) {
  return countMode === "raw" ? "raw" : "qc";
}


/**
 * @param {Record<string, any>} state
 * @param {unknown} preview
 * @returns {RegionDisplayScope | null}
 */
export function normalizeRegionPreview(state, preview) {
  if (state.regionDraft.active || !preview || typeof preview !== "object") {
    return null;
  }
  const candidate = /** @type {Record<string, any>} */ (preview);
  const countMode = normalizeRegionCountMode(candidate.countMode);
  if (candidate.type === "full-fov") {
    return { type: "full-fov", countMode };
  }
  if (candidate.type === "region-all") {
    return getCommittedRegionCount(state) >= 2
      ? { type: "region-all", countMode }
      : null;
  }
  if (candidate.type === "region") {
    const index = Number(candidate.index);
    return Number.isInteger(index) && getCommittedRegionPolygons(state)[index]
      ? { type: "region", index, countMode }
      : null;
  }
  return null;
}


/** @param {Record<string, any>} state @returns {RegionDisplayScope | null} */
export function getRegionPreview(state) {
  return normalizeRegionPreview(state, state.regionPreview);
}


/** @param {any} preview */
export function getRegionPreviewKey(preview) {
  if (!preview) {
    return null;
  }
  if (preview.type === "region") {
    return `region-${preview.index}`;
  }
  return preview.type;
}


/** @param {any} a @param {any} b */
export function sameRegionPreview(a, b) {
  return (
    getRegionPreviewKey(a) === getRegionPreviewKey(b)
    && normalizeRegionCountMode(a?.countMode) === normalizeRegionCountMode(b?.countMode)
  );
}


/** @param {any} a @param {any} b */
export function sameRegionPreviewScope(a, b) {
  return getRegionPreviewKey(a) === getRegionPreviewKey(b);
}


export function pointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const cross = (px - ax) * dy - (py - ay) * dx;
  const scale = Math.max(Math.abs(dx), Math.abs(dy), 1);
  if (Math.abs(cross) > 1e-6 * scale) {
    return false;
  }
  const dot = (px - ax) * dx + (py - ay) * dy;
  if (dot < -1e-6) {
    return false;
  }
  const lenSq = dx * dx + dy * dy;
  return dot <= lenSq + 1e-6;
}


/** @param {Array<{ x: number, y: number }>} polygon */
export function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (pointOnSegment(x, y, a.x, a.y, b.x, b.y)) {
      return true;
    }
    const crosses = (a.y > y) !== (b.y > y);
    if (crosses) {
      const xIntersect = ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
      if (x < xIntersect) {
        inside = !inside;
      }
    }
  }
  return inside;
}


/** @param {Record<string, any>} state @param {number} pointIndex */
export function pointIndexPassesRegion(state, pointIndex) {
  if (state.regionDraft.active) {
    return true;
  }
  const polygons = getCommittedRegionPolygons(state);
  if (!polygons.length) {
    return true;
  }
  const x = state.points.x[pointIndex];
  const y = state.points.y[pointIndex];
  return polygons.some((polygon) => pointInPolygon(x, y, polygon));
}


/**
 * @param {Record<string, any>} state
 * @param {number} pointIndex
 * @param {Array<Array<{ x: number, y: number }>>} polygons
 */
export function pointIndexPassesRegionPolygons(state, pointIndex, polygons) {
  if (!polygons.length) {
    return true;
  }
  const x = state.points.x[pointIndex];
  const y = state.points.y[pointIndex];
  return polygons.some((polygon) => pointInPolygon(x, y, polygon));
}


/** @param {Record<string, any>} state @returns {RegionDisplayScope} */
export function getActiveRegionDisplayScope(state) {
  if (state.regionDraft.active) {
    return { type: "full-fov", countMode: "qc" };
  }
  const preview = getRegionPreview(state);
  if (preview) {
    return preview;
  }
  const regionCount = getCommittedRegionCount(state);
  if (regionCount >= 2) {
    return { type: "region-all", countMode: "qc" };
  }
  if (regionCount === 1) {
    return { type: "region", index: 0, countMode: "qc" };
  }
  return { type: "full-fov", countMode: "qc" };
}


/**
 * @param {Record<string, any>} state
 * @param {number} pointIndex
 * @param {any} [scope]
 */
export function pointIndexPassesRegionDisplayScope(
  state,
  pointIndex,
  scope = getActiveRegionDisplayScope(state),
) {
  if (scope.type === "full-fov") {
    return true;
  }
  if (scope.type === "region-all") {
    return pointIndexPassesRegionPolygons(
      state,
      pointIndex,
      getCommittedRegionPolygons(state),
    );
  }
  if (scope.type === "region") {
    const polygon = getCommittedRegionPolygons(state)[scope.index];
    return polygon
      ? pointIndexPassesRegionPolygons(state, pointIndex, [polygon])
      : false;
  }
  return true;
}


/**
 * @param {Record<string, any>} state
 * @param {Array<Array<{ x: number, y: number }>>} polygons
 * @param {{ filters?: any, pointPassesMetricFilters?: (pointIndex: number, filters: any) => boolean }} [options]
 */
export function countRegionNeuronsForPolygons(
  state,
  polygons,
  { filters = null, pointPassesMetricFilters = () => true } = {},
) {
  if (!state.points || !polygons.length) {
    return 0;
  }
  return state.points.id.reduce((count, _id, pointIndex) => {
    if (filters && !pointPassesMetricFilters(pointIndex, filters)) {
      return count;
    }
    const x = state.points.x[pointIndex];
    const y = state.points.y[pointIndex];
    return count + (polygons.some((polygon) => pointInPolygon(x, y, polygon)) ? 1 : 0);
  }, 0);
}


/**
 * @param {Record<string, any>} state
 * @param {any} filters
 * @param {(pointIndex: number, filters: any) => boolean} pointPassesMetricFilters
 */
export function countMetricQcNeurons(state, filters, pointPassesMetricFilters) {
  if (!state.points) {
    return 0;
  }
  return state.points.id.reduce(
    (count, _id, pointIndex) => (
      count + (pointPassesMetricFilters(pointIndex, filters) ? 1 : 0)
    ),
    0,
  );
}


/** @param {unknown} value */
export function formatRegionCount(value) {
  return Number.isFinite(value) ? `${value}` : "-";
}


/**
 * @param {Record<string, any>} state
 * @param {any} filters
 * @param {(pointIndex: number, filters: any) => boolean} pointPassesMetricFilters
 */
export function getFullFovCounts(state, filters, pointPassesMetricFilters) {
  if (!state.points) {
    return { raw: null, qc: null };
  }
  return {
    raw: state.points.id.length,
    qc: countMetricQcNeurons(state, filters, pointPassesMetricFilters),
  };
}


/**
 * @param {Record<string, any>} state
 * @param {any} filters
 * @param {(pointIndex: number, filters: any) => boolean} pointPassesMetricFilters
 */
export function getRegionAllCounts(state, filters, pointPassesMetricFilters) {
  const polygons = getCommittedRegionPolygons(state);
  if (!polygons.length) {
    return { raw: null, qc: null };
  }
  return {
    raw: countRegionNeuronsForPolygons(state, polygons),
    qc: countRegionNeuronsForPolygons(state, polygons, {
      filters,
      pointPassesMetricFilters,
    }),
  };
}
