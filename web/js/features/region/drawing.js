import {
  getCommittedRegionPolygons,
  getRegionPreview,
} from "./model.js";


export const REGION_LINE_COLOR = "rgba(247,241,231,0.95)";
export const REGION_DRAFT_COLOR = "rgba(80,190,230,0.95)";


/**
 * @typedef {{
 *   addDraftPoint: (point: { x: number, y: number }) => void,
 *   applyDrawing: () => unknown,
 *   cancelDrawing: () => unknown,
 *   closeDraftPolygon: () => unknown,
 *   mapEventToDataPoint: (event: Event) => { x: number, y: number } | null,
 * }} RegionDrawingEffects
 */


/**
 * Build the exact Plotly descriptors owned by Region preview and drawing.
 * This is a pure read: Map retains Plotly lifecycle, axes, and trace ordering.
 *
 * @param {Record<string, any>} state
 * @param {{ lineColor?: string, draftColor?: string }} [options]
 */
export function buildRegionTraces(
  state,
  {
    lineColor = REGION_LINE_COLOR,
    draftColor = REGION_DRAFT_COLOR,
  } = {},
) {
  const traces = [];
  const preview = getRegionPreview(state);
  const committedPolygons = getCommittedRegionPolygons(state);
  const previewPolygons = preview?.type === "region-all"
    ? committedPolygons.map((polygon, index) => ({ polygon, index, highlighted: false }))
    : preview?.type === "region" && committedPolygons[preview.index]
      ? [{ polygon: committedPolygons[preview.index], index: preview.index, highlighted: true }]
      : [];

  previewPolygons.forEach(({ polygon, index, highlighted }) => {
    const closed = [...polygon, polygon[0]];
    traces.push({
      type: "scatter",
      mode: "lines",
      x: closed.map((point) => point.x),
      y: closed.map((point) => point.y),
      line: {
        color: lineColor,
        width: highlighted ? 3.2 : 2.2,
        dash: "solid",
      },
      hoverinfo: "skip",
      showlegend: false,
      name: `region-${index + 1}`,
    });
  });

  if (state.regionDraft.active && state.regionDraft.points.length > 0) {
    const draftPoints = state.regionDraft.points;
    const firstPoint = draftPoints[0];
    const lastPoint = draftPoints[draftPoints.length - 1];
    const endpointPoints = draftPoints.length > 1 ? [firstPoint, lastPoint] : [lastPoint];
    const endpointColors = draftPoints.length > 1
      ? ["#f7f1e7", draftColor]
      : [draftColor];
    const endpointSizes = draftPoints.length > 1 ? [9, 13] : [13];
    const endpointSymbols = draftPoints.length > 1
      ? ["circle-open", "circle"]
      : ["circle"];
    traces.push({
      type: "scatter",
      mode: state.regionDraft.points.length > 1 ? "lines+markers" : "markers",
      x: draftPoints.map((point) => point.x),
      y: draftPoints.map((point) => point.y),
      line: { color: draftColor, width: 2, dash: "dot" },
      marker: {
        color: "#f7f1e7",
        line: { color: draftColor, width: 1.5 },
        size: 8,
      },
      hoverinfo: "skip",
      showlegend: false,
      name: "region-draft-path",
    });
    traces.push({
      type: "scatter",
      mode: "markers",
      x: endpointPoints.map((point) => point.x),
      y: endpointPoints.map((point) => point.y),
      marker: {
        color: endpointColors,
        line: { color: "#f7f1e7", width: 2 },
        size: endpointSizes,
        symbol: endpointSymbols,
      },
      hoverinfo: "skip",
      showlegend: false,
      name: "region-draft-endpoints",
    });
  }
  return traces;
}


/**
 * Own the Region keyboard/pointer listeners for the lifetime of one feature.
 * Re-wiring replaces effect implementations without duplicating listeners or
 * resetting click de-duplication state.
 *
 * @param {{
 *   document: Document,
 *   getState: () => Record<string, any>,
 *   now?: () => number,
 * }} dependencies
 */
export function createRegionDrawingController({
  document,
  getState,
  now = () => globalThis.performance.now(),
}) {
  /** @type {RegionDrawingEffects | null} */
  let effects = null;
  let keyboardWired = false;
  /** @type {HTMLElement | null} */
  let wiredPlot = null;
  let pointerStart = null;
  let lastDraftClick = null;
  const clickDistancePx = 5;
  const duplicateClickMs = 250;

  /** @returns {RegionDrawingEffects} */
  function requireEffects() {
    if (!effects) {
      throw new Error("Region drawing effects were not installed before use.");
    }
    return effects;
  }

  /** @param {Event & { target?: any }} event */
  function isDraftMapEvent(event) {
    return (
      getState().regionDraft.active
      && !event.target?.closest?.(".modebar")
      && !event.target?.closest?.(".overlay-stack")
    );
  }

  /** @param {PointerEvent | MouseEvent} event */
  function isDuplicateDraftClick(event) {
    return Boolean(
      lastDraftClick
      && now() - lastDraftClick.time < duplicateClickMs
      && Math.hypot(
        event.clientX - lastDraftClick.x,
        event.clientY - lastDraftClick.y,
      ) <= clickDistancePx
    );
  }

  /** @param {PointerEvent | MouseEvent} event */
  function addDraftPointFromEvent(event) {
    if (isDuplicateDraftClick(event)) {
      return true;
    }
    const installed = requireEffects();
    const point = installed.mapEventToDataPoint(event);
    if (!point) {
      return false;
    }
    lastDraftClick = {
      time: now(),
      x: event.clientX,
      y: event.clientY,
    };
    installed.addDraftPoint(point);
    return true;
  }

  function wireKeyboard() {
    if (keyboardWired) {
      return false;
    }
    document.addEventListener("keydown", (event) => {
      const state = getState();
      const installed = requireEffects();
      if (event.key === "Escape" && state.regionDraft.active) {
        installed.cancelDrawing();
      }
      if (
        event.key === "Enter"
        && state.regionDraft.active
        && state.regionDraft.points.length >= 3
      ) {
        installed.applyDrawing();
      }
    });
    keyboardWired = true;
    return true;
  }

  /** @param {HTMLElement} plot */
  function wirePlot(plot) {
    if (wiredPlot === plot) {
      return false;
    }
    plot.addEventListener("pointerdown", (event) => {
      if (!isDraftMapEvent(event) || event.button !== 0) {
        return;
      }
      pointerStart = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
    }, true);

    plot.addEventListener("pointerup", (event) => {
      if (!isDraftMapEvent(event) || !pointerStart || pointerStart.id !== event.pointerId) {
        pointerStart = null;
        return;
      }
      const dx = event.clientX - pointerStart.x;
      const dy = event.clientY - pointerStart.y;
      pointerStart = null;
      if (Math.hypot(dx, dy) > clickDistancePx) {
        return;
      }
      addDraftPointFromEvent(event);
    }, true);

    plot.addEventListener("pointercancel", () => {
      pointerStart = null;
    }, true);

    plot.addEventListener("click", (event) => {
      if (!isDraftMapEvent(event)) {
        return;
      }
      addDraftPointFromEvent(event);
      event.preventDefault();
      event.stopPropagation();
    }, true);

    plot.addEventListener("dblclick", (event) => {
      if (!isDraftMapEvent(event)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      requireEffects().closeDraftPolygon();
    }, true);

    wiredPlot = plot;
    return true;
  }

  /** @param {RegionDrawingEffects} nextEffects */
  function wire(nextEffects) {
    effects = nextEffects;
    const installedKeyboard = wireKeyboard();
    const plot = /** @type {HTMLElement | null} */ (document.getElementById("map-plot"));
    const installedPlot = plot ? wirePlot(plot) : false;
    return installedKeyboard || installedPlot;
  }

  return {
    isDraftMapEvent,
    wire,
  };
}
