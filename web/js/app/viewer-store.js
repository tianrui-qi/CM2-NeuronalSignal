export const WORKFLOW_SECTIONS = Object.freeze([
  "background",
  "qc",
  "region",
  "roi",
  "temporalHeatmap",
  "temporalTrace",
]);

/** @returns {Record<string, boolean>} */
export function createDefaultOpenSections() {
  return {
    background: true,
    qc: true,
    region: true,
    roi: true,
    temporalHeatmap: true,
    temporalTrace: true,
  };
}

/**
 * Create the viewer's complete mutable state with the established viewer
 * defaults. Every mutable container is owned by this invocation.
 *
 * @returns {Record<string, any>}
 */
export function createInitialViewerState() {
  return {
    meta: null,
    points: null,
    tracesBySource: {},
    pointIndexByNeuronId: new Map(),
    rois: [],
    activeRoiId: null,
    activeSignalSource: "c_bl",
    activeTraceValueMode: "dff",
    traceDfSpacingRaw: 10000,
    traceDfPixelsPerKiloRaw: 2,
    traceDffSpacingPercent: 8,
    traceDffPixelsPerPercent: 3,
    traceHoverNeuronId: null,
    dffDenominators: new Float64Array(),
    heatmapRangeBySource: {},
    activeBackgroundKey: null,
    backgroundRanges: {},
    activeBlueprintMetric: "none",
    blueprintColorRanges: {},
    qcRanges: {},
    regionPolygons: [],
    regionDraft: { active: false, points: [], polygons: [] },
    regionPreview: null,
    activeWorkflowSection: "qc",
    openSections: createDefaultOpenSections(),
    overlayWidth: null,
    mapPlotReady: false,
    mapViewportKey: null,
    mapViewRange: null,
  };
}

/**
 * Minimal synchronous owner for the viewer's mutable object. It adds no
 * cloning, freezing, subscription, or scheduling.
 *
 * @param {Record<string, any>} [initialState]
 */
export function createViewerStore(initialState = createInitialViewerState()) {
  const snapshot = initialState;
  return {
    getSnapshot() {
      return snapshot;
    },

    /**
     * @template Result
     * @param {string} reason
     * @param {(state: Record<string, any>) => Result} mutator
     * @returns {Result}
     */
    update(reason, mutator) {
      void reason;
      return mutator(snapshot);
    },
  };
}
