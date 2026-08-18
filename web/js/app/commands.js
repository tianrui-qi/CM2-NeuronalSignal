import { selectRoiById } from "./selectors.js";

/**
 * State-only viewer mutations. Rendering, persistence, transport, and browser
 * effects remain the caller's orchestration responsibility.
 *
 * @param {{
 *   getSnapshot: () => Record<string, any>,
 *   update: <Result>(reason: string, mutator: (state: Record<string, any>) => Result) => Result,
 * }} store
 */
export function createViewerCommands(store) {
  return {
    /**
     * @param {{ meta: any, points: any, tracesBySource: Record<string, Float32Array> }} cache
     */
    hydrateCache(cache) {
      return store.update("cache:hydrate", (state) => {
        state.meta = cache.meta;
        state.points = cache.points;
        state.pointIndexByNeuronId = new Map(
          state.points.id.map((id, index) => [id, index]),
        );
        state.tracesBySource = cache.tracesBySource;
        state.dffDenominatorCache.clear();
        return state;
      });
    },

    /**
     * @param {{ rois: Cm2Roi[], activeRoiId: string | null }} nextState
     */
    replaceRoiPersistedState(nextState) {
      return store.update("roi:replace-persisted-state", (state) => {
        state.rois = nextState.rois;
        state.activeRoiId = nextState.activeRoiId;
        return nextState;
      });
    },

    /** @param {string | null} roiId */
    toggleActiveRoi(roiId) {
      return store.update("roi:toggle-active", (state) => {
        state.activeRoiId = state.activeRoiId === roiId
          ? null
          : selectRoiById(state, roiId)?.id ?? null;
        return state.activeRoiId;
      });
    },

    /** @param {string | null} roiId */
    setActiveRoi(roiId) {
      return store.update("roi:set-active", (state) => {
        const roi = selectRoiById(state, roiId);
        if (!roi || state.activeRoiId === roi.id) {
          return false;
        }
        state.activeRoiId = roi.id;
        return true;
      });
    },

    /** @param {number | null} neuronId */
    setTraceHoverNeuronId(neuronId) {
      return store.update("trace:set-hover-neuron", (state) => {
        const nextNeuronId = Number.isFinite(neuronId) ? Number(neuronId) : null;
        if (state.traceHoverNeuronId === nextNeuronId) {
          return false;
        }
        state.traceHoverNeuronId = nextNeuronId;
        return true;
      });
    },

    /**
     * Atomic hydration command for the seven persisted Temporal fields.
     * Normalization belongs to the Temporal feature; this command preserves
     * the caller-owned reference semantics of the current hydration path.
     *
     * @param {{
     *   activeSignalSource: string,
     *   activeTraceValueMode: string,
     *   traceDfSpacingRaw: number,
     *   traceDfPixelsPerKiloRaw: number,
     *   traceDffSpacingPercent: number,
     *   traceDffPixelsPerPercent: number,
     *   heatmapRangeBySource: Record<string, { min?: number, max?: number }>,
     * }} nextState
     */
    replaceTemporalPersistedState(nextState) {
      return store.update("temporal:replace-persisted-state", (state) => {
        state.activeSignalSource = nextState.activeSignalSource;
        state.activeTraceValueMode = nextState.activeTraceValueMode;
        state.traceDfSpacingRaw = nextState.traceDfSpacingRaw;
        state.traceDfPixelsPerKiloRaw = nextState.traceDfPixelsPerKiloRaw;
        state.traceDffSpacingPercent = nextState.traceDffSpacingPercent;
        state.traceDffPixelsPerPercent = nextState.traceDffPixelsPerPercent;
        state.heatmapRangeBySource = nextState.heatmapRangeBySource;
        return nextState;
      });
    },

    /** @param {string} sourceKey */
    setActiveSignalSource(sourceKey) {
      return store.update("temporal:set-signal-source", (state) => {
        state.activeSignalSource = sourceKey;
        return sourceKey;
      });
    },

    /** @param {string} valueMode */
    setActiveTraceValueMode(valueMode) {
      return store.update("temporal:set-value-mode", (state) => {
        state.activeTraceValueMode = valueMode;
        return valueMode;
      });
    },

    /** @param {number} spacingRaw */
    setTraceDfSpacingRaw(spacingRaw) {
      return store.update("temporal:set-df-spacing", (state) => {
        state.traceDfSpacingRaw = spacingRaw;
        return spacingRaw;
      });
    },

    /** @param {number} pixelsPerKiloRaw */
    setTraceDfPixelsPerKiloRaw(pixelsPerKiloRaw) {
      return store.update("temporal:set-df-scale", (state) => {
        state.traceDfPixelsPerKiloRaw = pixelsPerKiloRaw;
        return pixelsPerKiloRaw;
      });
    },

    /** @param {number} spacingPercent */
    setTraceDffSpacingPercent(spacingPercent) {
      return store.update("temporal:set-dff-spacing", (state) => {
        state.traceDffSpacingPercent = spacingPercent;
        return spacingPercent;
      });
    },

    /** @param {number} pixelsPerPercent */
    setTraceDffPixelsPerPercent(pixelsPerPercent) {
      return store.update("temporal:set-dff-scale", (state) => {
        state.traceDffPixelsPerPercent = pixelsPerPercent;
        return pixelsPerPercent;
      });
    },

    /**
     * @param {string} sourceKey
     * @param {{ min?: number, max?: number }} range
     */
    setHeatmapRangeForSource(sourceKey, range) {
      return store.update("temporal:set-heatmap-range", (state) => {
        state.heatmapRangeBySource[sourceKey] = range;
        return range;
      });
    },

    /** @param {string} cacheKey @param {number} denominator */
    setDffDenominator(cacheKey, denominator) {
      return store.update("temporal:cache-dff-denominator", (state) => {
        state.dffDenominatorCache.set(cacheKey, denominator);
        return denominator;
      });
    },

    /** @param {Cm2Roi} roi */
    addRoi(roi) {
      return store.update("roi:add", (state) => {
        state.rois.push(roi);
        state.activeRoiId = null;
        return roi;
      });
    },

    /**
     * @param {string} roiId
     * @param {{ x: number, y: number, width: number, height: number } | null} box
     */
    setRoiBox(roiId, box) {
      return store.update("roi:set-box", (state) => {
        const roi = selectRoiById(state, roiId);
        if (!roi) {
          return null;
        }
        roi.box = box;
        return box;
      });
    },

    /**
     * @param {string} roiId
     * @param {string} color
     */
    setRoiColor(roiId, color) {
      return store.update("roi:set-color", (state) => {
        const roi = selectRoiById(state, roiId);
        if (!roi) {
          return null;
        }
        roi.color = color;
        return color;
      });
    },

    /**
     * @param {string} roiId
     * @param {number[]} neuronIds
     */
    setRoiNeuronIds(roiId, neuronIds) {
      return store.update("roi:set-neuron-ids", (state) => {
        const roi = selectRoiById(state, roiId);
        if (!roi) {
          return null;
        }
        roi.neuronIds = neuronIds;
        return neuronIds;
      });
    },

    /** @param {number} neuronId */
    removeNeuronFromAllRois(neuronId) {
      return store.update("roi:remove-neuron-from-all", (state) => {
        let changed = false;
        for (const roi of state.rois) {
          const nextNeuronIds = roi.neuronIds.filter((id) => id !== neuronId);
          changed = nextNeuronIds.length !== roi.neuronIds.length || changed;
          roi.neuronIds = nextNeuronIds;
        }
        return changed;
      });
    },

    /** @param {string} roiId */
    deleteRoi(roiId) {
      return store.update("roi:delete", (state) => {
        state.rois = state.rois.filter((roi) => roi.id !== roiId);
        state.activeRoiId = null;
        return state.rois;
      });
    },

    /** @param {string | null} backgroundKey */
    setActiveBackground(backgroundKey) {
      return store.update("background:set-active", (state) => {
        if (backgroundKey === state.activeBackgroundKey) {
          return false;
        }
        state.activeBackgroundKey = backgroundKey;
        return true;
      });
    },

    /** @param {string} section */
    activateWorkflowSection(section) {
      return store.update("workflow:activate", (state) => {
        const changed = state.activeWorkflowSection !== section;
        state.activeWorkflowSection = section;
        state.openSections[section] = true;
        return { section, changed };
      });
    },

    /** @param {string} section */
    toggleWorkflowSection(section) {
      return store.update("workflow:toggle", (state) => {
        state.activeWorkflowSection = section;
        state.openSections[section] = !state.openSections[section];
        return { section, isOpen: state.openSections[section] };
      });
    },

    /** @param {string} section */
    setActiveWorkflowSection(section) {
      return store.update("workflow:set-active", (state) => {
        if (state.activeWorkflowSection === section) {
          return false;
        }
        state.activeWorkflowSection = section;
        return true;
      });
    },

    /** @param {Record<string, boolean>} openSections */
    replaceOpenSections(openSections) {
      return store.update("workflow:replace-open-sections", (state) => {
        state.openSections = openSections;
        return openSections;
      });
    },

    /** @param {number | null} width */
    setOverlayWidth(width) {
      return store.update("shell:set-overlay-width", (state) => {
        state.overlayWidth = width;
        return width;
      });
    },

    /** @param {string} metricKey */
    setActiveBlueprintMetric(metricKey) {
      return store.update("quality-control:set-active-metric", (state) => {
        if (state.activeBlueprintMetric === metricKey) {
          return false;
        }
        state.activeBlueprintMetric = metricKey;
        return true;
      });
    },

    /**
     * Atomic command for UI-state hydration and startup normalization behind
     * the Quality Control feature boundary.
     *
     * @param {{
     *   activeBlueprintMetric: string,
     *   blueprintColorRanges: Record<string, { lower: number, upper: number }>,
     *   qcRanges: Record<string, { lower: number | null, upper: number | null }>,
     * }} nextState
     */
    replaceQualityControlState(nextState) {
      return store.update("quality-control:replace-state", (state) => {
        state.activeBlueprintMetric = nextState.activeBlueprintMetric;
        state.blueprintColorRanges = nextState.blueprintColorRanges;
        state.qcRanges = nextState.qcRanges;
        return nextState;
      });
    },

    /**
     * @param {string} metricKey
     * @param {{ lower: number, upper: number }} nextRange
     */
    setBlueprintColorRange(metricKey, nextRange) {
      return store.update("blueprint:set-color-range", (state) => {
        state.blueprintColorRanges[metricKey] = nextRange;
        return nextRange;
      });
    },

    /**
     * @param {string} metricKey
     * @param {{ lower: number | null, upper: number | null }} nextRange
     */
    setQcRange(metricKey, nextRange) {
      return store.update("qc:set-range", (state) => {
        state.qcRanges[metricKey] = nextRange;
        return nextRange;
      });
    },

    /** @param {Array<Array<{ x: number, y: number }>>} regionPolygons */
    replaceRegionPersistedState(regionPolygons) {
      return store.update("region:replace-persisted-state", (state) => {
        state.regionPolygons = regionPolygons;
        state.regionDraft = { active: false, points: [], polygons: [] };
        return regionPolygons;
      });
    },

    beginRegionDrawing() {
      return store.update("region:begin-drawing", (state) => {
        state.regionPreview = null;
        state.activeWorkflowSection = "region";
        state.openSections.region = true;
        state.regionDraft = { active: true, points: [], polygons: [] };
        return state.regionDraft;
      });
    },

    cancelRegionDrawing() {
      return store.update("region:cancel-drawing", (state) => {
        state.regionDraft = { active: false, points: [], polygons: [] };
        state.regionPreview = null;
        return state.regionDraft;
      });
    },

    /** @param {{ x: number, y: number }} point */
    appendRegionDraftPoint(point) {
      return store.update("region:append-draft-point", (state) => {
        state.regionDraft.points.push(point);
        return point;
      });
    },

    /** @param {Array<Array<{ x: number, y: number }>>} regionPolygons */
    commitRegionPolygons(regionPolygons) {
      return store.update("region:commit-polygons", (state) => {
        state.regionPolygons = regionPolygons;
        state.regionDraft = { active: false, points: [], polygons: [] };
        state.regionPreview = null;
        return regionPolygons;
      });
    },

    /**
     * @param {number} index
     * @param {Array<Array<{ x: number, y: number }>>} regionPolygons
     */
    deleteRegionAt(index, regionPolygons) {
      return store.update("region:delete", (state) => {
        state.regionPreview = null;
        state.regionPolygons = regionPolygons.filter((_, candidate) => (
          candidate !== index
        ));
        return state.regionPolygons;
      });
    },

    /** @param {any} preview */
    setRegionPreview(preview) {
      return store.update("region:set-preview", (state) => {
        state.regionPreview = preview;
        return preview;
      });
    },

    /** @param {boolean} ready */
    setMapPlotReady(ready) {
      return store.update("map:set-plot-ready", (state) => {
        state.mapPlotReady = ready;
        return ready;
      });
    },

    /** @param {string} viewportKey */
    setMapViewportKey(viewportKey) {
      return store.update("map:set-viewport-key", (state) => {
        state.mapViewportKey = viewportKey;
        return viewportKey;
      });
    },

    /** @param {{ xRange: number[], yRange: number[] }} range */
    setMapViewRange(range) {
      return store.update("map:set-view-range", (state) => {
        state.mapViewRange = range;
        return range;
      });
    },

    clearMapViewRange() {
      return store.update("map:clear-view-range", (state) => {
        const changed = state.mapViewRange !== null;
        state.mapViewRange = null;
        return changed;
      });
    },
  };
}
