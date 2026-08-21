import * as model from "./model.js";
import {
  buildRegionTraces,
  createRegionDrawingController,
} from "./drawing.js";
import {
  createRegionPanel,
} from "./panel.js";


/**
 * @typedef {{
 *   replaceRegionPersistedState: (polygons: Array<Array<{ x: number, y: number }>>) => unknown,
 *   beginRegionDrawing: () => unknown,
 *   cancelRegionDrawing: () => unknown,
 *   appendRegionDraftPoint: (point: { x: number, y: number }) => unknown,
 *   undoRegionVertex: () => boolean,
 *   commitRegionPolygons: (polygons: Array<Array<{ x: number, y: number }>>) => unknown,
 *   deleteRegionAt: (index: number, polygons: Array<Array<{ x: number, y: number }>>) => unknown,
 *   setRegionPreview: (preview: unknown) => unknown,
 * }} RegionCommands
 *
 * @typedef {{
 *   activeFilters: () => any,
 *   pointPassesMetricFilters: (pointIndex: number, filters?: any) => boolean,
 * }} RegionQualityControlPort
 *
 * @typedef {{
 *   rememberMapViewRange: () => void,
 *   persistUiState: () => void,
 *   setStatus: (message: string, isError?: boolean) => void,
 *   mapEventToDataPoint: (event: Event) => { x: number, y: number } | null,
 *   renderMap: () => void,
 *   renderQualityControl: () => void,
 *   updateTemporal: () => void,
 * }} RegionEffects
 */


/**
 * Public Region feature boundary. Region owns polygon normalization,
 * geometry/count policy, table DOM, drawing input, state transitions, and
 * exact synchronous action ordering. Map/QC/Temporal/persistence remain narrow
 * injected ports.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: RegionCommands,
 *   document: Document,
 *   qualityControl: RegionQualityControlPort,
 *   getComputedStyle?: (element: Element) => CSSStyleDeclaration | Record<string, any>,
 *   lineColor?: string,
 *   draftColor?: string,
 * }} dependencies
 */
export function createRegionFeature({
  store,
  commands,
  document,
  qualityControl,
  getComputedStyle,
  lineColor,
  draftColor,
}) {
  const getState = () => store.getSnapshot();
  const panel = createRegionPanel({ document, getComputedStyle });
  const drawing = createRegionDrawingController({ document, getState });
  /** @type {RegionEffects | null} */
  let effects = null;

  /** @returns {RegionEffects} */
  function requireEffects() {
    if (!effects) {
      throw new Error("Region effects were not installed before use.");
    }
    return effects;
  }

  function activeFilters() {
    return qualityControl.activeFilters();
  }

  /** @param {number} pointIndex @param {any} filters */
  function pointPassesMetricFilters(pointIndex, filters) {
    return qualityControl.pointPassesMetricFilters(pointIndex, filters);
  }

  /** @param {Record<string, any>} parsed */
  function applyPersistedState(parsed) {
    return commands.replaceRegionPersistedState(
      model.normalizeRegionPolygons(parsed.regionPolygons),
    );
  }

  /** @param {unknown} preview */
  function normalizePreview(preview) {
    return model.normalizeRegionPreview(getState(), preview);
  }

  function committedPolygons() {
    return model.getCommittedRegionPolygons(getState());
  }

  function preview() {
    return model.getRegionPreview(getState());
  }

  /** @param {number} pointIndex */
  function pointPasses(pointIndex) {
    return model.pointIndexPassesRegion(getState(), pointIndex);
  }

  function activeDisplayScope() {
    return model.getActiveRegionDisplayScope(getState());
  }

  /** @param {number} pointIndex @param {any} [scope] */
  function pointPassesDisplayScope(pointIndex, scope = activeDisplayScope()) {
    return model.pointIndexPassesRegionDisplayScope(
      getState(),
      pointIndex,
      scope,
    );
  }

  function updateCountHighlights() {
    panel.updateCountHighlights(getState());
  }

  /** @param {unknown} nextPreview */
  function setPreview(nextPreview) {
    const next = normalizePreview(nextPreview);
    const current = preview();
    if (model.sameRegionPreview(current, next)) {
      return false;
    }
    commands.setRegionPreview(next);
    updateCountHighlights();
    requireEffects().renderMap();
    return true;
  }

  /** @param {unknown} [targetPreview] */
  function clearPreview(targetPreview = null) {
    const current = preview();
    if (!current) {
      return false;
    }
    if (
      targetPreview
      && !model.sameRegionPreviewScope(current, normalizePreview(targetPreview))
    ) {
      return false;
    }
    commands.setRegionPreview(null);
    updateCountHighlights();
    requireEffects().renderMap();
    return true;
  }

  function renderList() {
    panel.render({
      state: getState(),
      filters: activeFilters(),
      pointPassesMetricFilters,
      onDelete: deleteAt,
      onSetPreview: setPreview,
      onClearPreview: clearPreview,
      onStart: startDrawing,
      onFinish: finishDrawing,
      onUndo: undoVertex,
      onCancel: cancelDrawing,
    });
  }

  /** @param {{ persist?: boolean }} [options] */
  function refreshViews({ persist = true } = {}) {
    const installed = requireEffects();
    if (persist) {
      installed.persistUiState();
    }
    renderList();
    installed.renderQualityControl();
    installed.renderMap();
    installed.updateTemporal();
  }

  function startDrawing() {
    const installed = requireEffects();
    installed.rememberMapViewRange();
    commands.beginRegionDrawing();
    installed.setStatus("");
    refreshViews({ persist: false });
  }

  function cancelDrawing() {
    if (!getState().regionDraft.active) {
      return false;
    }
    commands.cancelRegionDrawing();
    const installed = requireEffects();
    installed.setStatus("");
    refreshViews({ persist: false });
    return true;
  }

  function finishDrawing() {
    const state = getState();
    if (!state.regionDraft.active) {
      return false;
    }
    const polygon = model.normalizeRegionPolygon(state.regionDraft.points);
    if (!polygon.length) {
      requireEffects().setStatus("Region needs at least three points.", true);
      renderList();
      return false;
    }
    commands.commitRegionPolygons([...committedPolygons(), polygon]);
    const installed = requireEffects();
    installed.setStatus("");
    refreshViews();
    return true;
  }

  /** @param {{ x: number, y: number }} point */
  function addDraftPoint(point) {
    commands.appendRegionDraftPoint(point);
    renderList();
    requireEffects().renderMap();
  }

  /** @param {PointerEvent} event */
  function addPointFromMapEvent(event) {
    return drawing.addPointFromEvent(event);
  }

  function undoVertex() {
    const state = getState();
    if (!state.regionDraft.active || !state.regionDraft.points.length) {
      return false;
    }
    if (!commands.undoRegionVertex()) {
      return false;
    }
    renderList();
    requireEffects().renderMap();
    return true;
  }

  /** @param {number} index */
  function deleteAt(index) {
    commands.deleteRegionAt(index, committedPolygons());
    refreshViews();
  }

  function buildMapTraces() {
    return buildRegionTraces(getState(), { lineColor, draftColor });
  }

  function isDrawing() {
    return Boolean(getState().regionDraft.active);
  }

  /**
   * Install application effects and wire keyboard/map input once. Repeated
   * calls update effects but do not duplicate listeners.
   *
   * @param {RegionEffects} nextEffects
   */
  function wire(nextEffects) {
    effects = nextEffects;
    return drawing.wire({
      addDraftPoint,
      finishDrawing,
      mapEventToDataPoint: nextEffects.mapEventToDataPoint,
    });
  }

  return {
    activeDisplayScope,
    addPointFromMapEvent,
    applyPersistedState,
    buildMapTraces,
    cancelDrawing,
    finishDrawing,
    isDrawing,
    pointPasses,
    pointPassesDisplayScope,
    renderList,
    undoVertex,
    wire,
  };
}
