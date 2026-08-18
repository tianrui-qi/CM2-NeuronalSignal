export const DEFAULT_ROI_COLORS = Object.freeze([
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
]);


/** @param {number} roiIndex */
export function getDefaultRoiName(roiIndex) {
  return `ROI ${roiIndex + 1}`;
}


/** @param {number} roiIndex */
export function getDefaultRoiColor(roiIndex) {
  return DEFAULT_ROI_COLORS[roiIndex % DEFAULT_ROI_COLORS.length];
}


/**
 * Build the canonical timestamp/random identifier while keeping time and
 * randomness outside the pure model boundary.
 *
 * @param {number} nowMs
 * @param {number} randomValue
 */
export function createRoiId(nowMs, randomValue) {
  return `roi-${nowMs}-${randomValue.toString(36).slice(2, 8)}`;
}


/**
 * @param {{
 *   roiIndex: number,
 *   nowMs: number,
 *   randomValue: number,
 *   name?: string | null,
 *   color?: string | null,
 *   box?: unknown,
 *   neuronIds?: Iterable<number>,
 * }} options
 */
export function createRoi({
  roiIndex,
  nowMs,
  randomValue,
  name = null,
  color = null,
  box = null,
  neuronIds = [],
}) {
  return {
    id: createRoiId(nowMs, randomValue),
    name: name ?? getDefaultRoiName(roiIndex),
    color: color ?? getDefaultRoiColor(roiIndex),
    box: normalizeRoiBox(box),
    neuronIds: [...new Set(neuronIds)],
  };
}


/** @param {unknown} box */
export function normalizeRoiBox(box) {
  if (!box || typeof box !== "object") {
    return null;
  }
  const candidate = /** @type {Record<string, unknown>} */ (box);
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const width = Number(candidate.width);
  const height = Number(candidate.height);
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


/**
 * Normalize only the ROI-owned persistence fields. A null result means the
 * payload is not an applicable ROI state and callers must leave state intact.
 *
 * @param {unknown} parsed
 * @param {{
 *   validNeuronIds: Iterable<number>,
 * }} options
 */
export function normalizePersistedRoiState(
  parsed,
  { validNeuronIds },
) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const payload = /** @type {Record<string, any>} */ (parsed);
  if (!Array.isArray(payload.rois)) {
    return null;
  }

  const validIds = new Set(validNeuronIds);
  const seenNeuronIds = new Set();
  const rois = payload.rois.map((roi) => ({
    id: roi.id,
    name: roi.name,
    color: roi.color,
    box: normalizeRoiBox(roi.box),
    neuronIds: roi.neuronIds.filter((neuronId) => {
      const keep = validIds.has(neuronId) && !seenNeuronIds.has(neuronId);
      if (keep) {
        seenNeuronIds.add(neuronId);
      }
      return keep;
    }),
  }));
  const activeRoiId = payload.activeRoiId;
  return { rois, activeRoiId };
}


/**
 * ROI boxes use half-open bounds so points on right/bottom edges belong to an
 * adjacent box rather than both boxes. A missing box means full-FOV membership.
 *
 * @param {number} pointX
 * @param {number} pointY
 * @param {{ x: number, y: number, width: number, height: number } | null | undefined} box
 */
export function pointInRoiBox(pointX, pointY, box) {
  if (!box) {
    return true;
  }
  return (
    pointX >= box.x
    && pointX < box.x + box.width
    && pointY >= box.y
    && pointY < box.y + box.height
  );
}


/**
 * @param {{ x: number[], y: number[] }} points
 * @param {number} pointIndex
 * @param {{ box?: { x: number, y: number, width: number, height: number } | null } | null} roi
 */
export function pointIndexInRoiBox(points, pointIndex, roi) {
  return pointInRoiBox(
    points.x[pointIndex],
    points.y[pointIndex],
    roi?.box,
  );
}


/**
 * @param {{
 *   points: { x: number[], y: number[] },
 *   pointIndexByNeuronId: Map<number, number>,
 *   neuronId: number,
 *   roi: { box?: { x: number, y: number, width: number, height: number } | null },
 *   pointPassesEligibility?: (pointIndex: number) => boolean,
 * }} options
 */
export function neuronIdPassesRoiSelection({
  points,
  pointIndexByNeuronId,
  neuronId,
  roi,
  pointPassesEligibility = () => true,
}) {
  const pointIndex = pointIndexByNeuronId.get(neuronId) ?? null;
  return (
    pointIndex !== null
    && pointPassesEligibility(pointIndex)
    && pointIndexInRoiBox(points, pointIndex, roi)
  );
}


/**
 * @param {{
 *   points: { id: number[], x: number[], y: number[] } | null,
 *   roi: { box?: { x: number, y: number, width: number, height: number } | null } | null,
 *   pointPassesEligibility?: (pointIndex: number) => boolean,
 * }} options
 */
export function countRoiSelectableNeurons({
  points,
  roi,
  pointPassesEligibility = () => true,
}) {
  if (!points || !roi?.box) {
    return null;
  }
  return points.id.reduce((count, _neuronId, pointIndex) => {
    if (
      !pointPassesEligibility(pointIndex)
      || !pointIndexInRoiBox(points, pointIndex, roi)
    ) {
      return count;
    }
    return count + 1;
  }, 0);
}


/**
 * @param {{
 *   points: { x: number[], y: number[] },
 *   pointIndexByNeuronId: Map<number, number>,
 *   roi: {
 *     box?: { x: number, y: number, width: number, height: number } | null,
 *     neuronIds: number[],
 *   },
 *   pointPassesEligibility?: (pointIndex: number) => boolean,
 * }} options
 */
export function countRoiSelectedNeurons({
  points,
  pointIndexByNeuronId,
  roi,
  pointPassesEligibility = () => true,
}) {
  return roi.neuronIds.filter((neuronId) => neuronIdPassesRoiSelection({
    points,
    pointIndexByNeuronId,
    neuronId,
    roi,
    pointPassesEligibility,
  })).length;
}


/**
 * Return the box-valid selection without mutating the ROI or its input array.
 * Unboxed ROIs retain their existing selection reference and report no change.
 *
 * @param {{
 *   points: { x: number[], y: number[] },
 *   pointIndexByNeuronId: Map<number, number>,
 *   roi: {
 *     box?: { x: number, y: number, width: number, height: number } | null,
 *     neuronIds: number[],
 *   },
 * }} options
 */
export function pruneRoiSelectionToBox({ points, pointIndexByNeuronId, roi }) {
  if (!roi?.box) {
    return { changed: false, neuronIds: roi.neuronIds };
  }
  const neuronIds = roi.neuronIds.filter((neuronId) => {
    const pointIndex = pointIndexByNeuronId.get(neuronId) ?? null;
    return (
      pointIndex !== null
      && pointIndexInRoiBox(points, pointIndex, roi)
    );
  });
  return {
    changed: neuronIds.length !== roi.neuronIds.length,
    neuronIds,
  };
}
