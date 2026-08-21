import { clamp } from "./model.js";


export const ROI_BOX_BORDER_CLICK_TOLERANCE_PX = 8;
export const COARSE_ROI_BOX_BORDER_TOLERANCE_PX = 22;
export const COARSE_NEURON_HIT_RADIUS_PX = 22;
export const FINE_NEURON_HIT_RADIUS_PX = 6;

const WHEEL_LINE_HEIGHT_PX = 16;
const PINCH_ZOOM_RATE = 0.01;
const MAX_PINCH_LOG_SCALE_PER_FRAME = 0.35;
const TOUCH_TAP_SLOP_PX = 10;
const PEN_TAP_SLOP_PX = 6;
const DIRECT_PINCH_MIN_FACTOR = 0.05;
const DIRECT_PINCH_MAX_FACTOR = 20;
const SYNTHETIC_CLICK_BLOCK_MS = 800;
const DIRECT_DOUBLE_TAP_WINDOW_MS = 450;
const DIRECT_DOUBLE_TAP_SLOP_PX = 24;


/** @param {PointerEvent | { pointerType?: string }} event */
function isDirectManipulationPointer(event) {
  return event.pointerType === "touch" || event.pointerType === "pen";
}


/**
 * Convert one data coordinate into a plot-relative browser coordinate.
 *
 * @param {Record<string, any> | null | undefined} axis
 * @param {number} value
 * @returns {number | null}
 */
export function axisDataToPlotPixel(axis, value) {
  if (!axis || typeof axis.d2p !== "function") {
    return null;
  }
  const pixel = axis.d2p(value);
  return Number.isFinite(pixel) ? pixel + (axis._offset ?? 0) : null;
}


/**
 * Return the closest ROI border within the requested screen-space hit band.
 * Equal-distance hits retain ROI array order.
 *
 * @param {{
 *   event: MouseEvent | PointerEvent,
 *   plot: (HTMLElement & { _fullLayout?: Record<string, any> }) | null,
 *   rois: Array<Record<string, any>>,
 *   tolerance?: number,
 * }} input
 * @returns {string | number | null}
 */
export function findRoiBoxBorderHit({
  event,
  plot,
  rois,
  tolerance = ROI_BOX_BORDER_CLICK_TOLERANCE_PX,
}) {
  const xaxis = plot?._fullLayout?.xaxis;
  const yaxis = plot?._fullLayout?.yaxis;
  if (!plot || !xaxis || !yaxis) {
    return null;
  }

  const rect = plot.getBoundingClientRect();
  const eventX = event.clientX - rect.left;
  const eventY = event.clientY - rect.top;
  let bestHit = null;

  for (const roi of rois) {
    if (!roi.box) {
      continue;
    }
    const x0 = axisDataToPlotPixel(xaxis, roi.box.x);
    const x1 = axisDataToPlotPixel(xaxis, roi.box.x + roi.box.width);
    const y0 = axisDataToPlotPixel(yaxis, roi.box.y);
    const y1 = axisDataToPlotPixel(yaxis, roi.box.y + roi.box.height);
    if ([x0, x1, y0, y1].some((value) => value === null)) {
      continue;
    }

    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const withinBoxBand = (
      eventX >= left - tolerance
      && eventX <= right + tolerance
      && eventY >= top - tolerance
      && eventY <= bottom + tolerance
    );
    if (!withinBoxBand) {
      continue;
    }

    const distance = Math.min(
      Math.abs(eventX - left),
      Math.abs(eventX - right),
      Math.abs(eventY - top),
      Math.abs(eventY - bottom),
    );
    if (distance <= tolerance && (!bestHit || distance < bestHit.distance)) {
      bestHit = { roiId: roi.id, distance };
    }
  }

  return bestHit?.roiId ?? null;
}


/**
 * Convert one browser event into the Full-FOV scientific coordinate space.
 *
 * @param {{
 *   event: MouseEvent | PointerEvent,
 *   plot: (HTMLElement & { _fullLayout?: Record<string, any> }) | null,
 *   fullWidth: number,
 *   fullHeight: number,
 * }} input
 * @returns {{ x: number, y: number } | null}
 */
export function mapEventToDataPoint({
  event,
  plot,
  fullWidth,
  fullHeight,
}) {
  const layout = plot?._fullLayout;
  const xaxis = layout?.xaxis;
  const yaxis = layout?.yaxis;
  if (
    !plot
    || !xaxis
    || !yaxis
    || typeof xaxis.p2d !== "function"
    || typeof yaxis.p2d !== "function"
  ) {
    return null;
  }
  const rect = plot.getBoundingClientRect();
  const xPixel = event.clientX - rect.left - (xaxis._offset ?? 0);
  const yPixel = event.clientY - rect.top - (yaxis._offset ?? 0);
  if (
    xPixel < 0
    || yPixel < 0
    || xPixel > (xaxis._length ?? rect.width)
    || yPixel > (yaxis._length ?? rect.height)
  ) {
    return null;
  }
  return {
    x: clamp(xaxis.p2d(xPixel), 0, Number(fullWidth)),
    y: clamp(yaxis.p2d(yPixel), 0, Number(fullHeight)),
  };
}


/**
 * Convert WheelEvent deltas to CSS pixels without tying gesture math to one
 * browser's deltaMode choice.
 *
 * @param {number} delta
 * @param {number} deltaMode
 * @param {number} pageSize
 */
export function wheelDeltaPixels(delta, deltaMode, pageSize) {
  if (!Number.isFinite(delta)) {
    return 0;
  }
  if (deltaMode === 1) {
    return delta * WHEEL_LINE_HEIGHT_PX;
  }
  if (deltaMode === 2) {
    return delta * Math.max(1, pageSize);
  }
  return delta;
}


/**
 * Shift an axis range by a screen-space delta. Plotly's d2p/p2d pair keeps
 * the direction correct for both ordinary X and the Map's reversed Y axis.
 *
 * @param {Record<string, any>} axis
 * @param {number} pixelDelta
 */
export function panAxisRange(axis, pixelDelta) {
  if (
    !Array.isArray(axis?.range)
    || axis.range.length < 2
    || typeof axis.d2p !== "function"
    || typeof axis.p2d !== "function"
  ) {
    return null;
  }
  const shifted = axis.range.slice(0, 2).map((value) => (
    axis.p2d(axis.d2p(Number(value)) + pixelDelta)
  ));
  return shifted.every(Number.isFinite) ? shifted : null;
}


/**
 * Scale one axis range around the data coordinate under the trackpad pinch.
 *
 * @param {number[]} range
 * @param {number} anchorValue
 * @param {number} factor
 */
export function zoomAxisRange(range, anchorValue, factor) {
  if (
    !Array.isArray(range)
    || range.length < 2
    || !Number.isFinite(anchorValue)
    || !Number.isFinite(factor)
    || factor <= 0
  ) {
    return null;
  }
  const scaled = range.slice(0, 2).map((value) => (
    anchorValue + (Number(value) - anchorValue) * factor
  ));
  return scaled.every(Number.isFinite) ? scaled : null;
}


/** @param {number} accumulatedDeltaY */
export function pinchZoomFactor(accumulatedDeltaY) {
  const logScale = clamp(
    accumulatedDeltaY * PINCH_ZOOM_RATE,
    -MAX_PINCH_LOG_SCALE_PER_FRAME,
    MAX_PINCH_LOG_SCALE_PER_FRAME,
  );
  return Math.exp(logScale);
}


/** @param {Array<{ x: number, y: number }>} points */
function pointerCentroid(points) {
  if (!points.length) {
    return null;
  }
  let totalX = 0;
  let totalY = 0;
  for (const point of points) {
    totalX += point.x;
    totalY += point.y;
  }
  return { x: totalX / points.length, y: totalY / points.length };
}


/** @param {{ x: number, y: number }} first @param {{ x: number, y: number }} second */
function pointerDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}


/**
 * Create a stable linear-axis snapshot for direct manipulation. The explicit
 * range override lets a two-to-one pointer transition continue from the last
 * requested view even if Plotly has not resolved its relayout promise yet.
 *
 * @param {HTMLElement & { _fullLayout?: Record<string, any> }} plot
 * @param {{ x: number, y: number }} anchor
 * @param {{ xRange: number[], yRange: number[] } | null} [rangeOverride]
 */
function captureDirectView(plot, anchor, rangeOverride = null) {
  const xaxis = plot._fullLayout?.xaxis;
  const yaxis = plot._fullLayout?.yaxis;
  if (!xaxis || !yaxis) {
    return null;
  }
  const rect = plot.getBoundingClientRect();
  const xLength = Math.max(1, Number(xaxis._length) || rect.width || 1);
  const yLength = Math.max(1, Number(yaxis._length) || rect.height || 1);
  const xPixel = clamp(anchor.x - rect.left - (xaxis._offset ?? 0), 0, xLength);
  const yPixel = clamp(anchor.y - rect.top - (yaxis._offset ?? 0), 0, yLength);
  const xRange = (rangeOverride?.xRange ?? xaxis.range)?.slice(0, 2).map(Number);
  const yRange = (rangeOverride?.yRange ?? yaxis.range)?.slice(0, 2).map(Number);
  if (
    xRange?.length !== 2
    || yRange?.length !== 2
    || !xRange.every(Number.isFinite)
    || !yRange.every(Number.isFinite)
  ) {
    return null;
  }
  const xFraction = xPixel / xLength;
  const yFraction = yPixel / yLength;
  return {
    xRange,
    yRange,
    xLength,
    yLength,
    plotLeft: rect.left,
    plotTop: rect.top,
    xOffset: xaxis._offset ?? 0,
    yOffset: yaxis._offset ?? 0,
    xAnchor: xRange[0] + (xRange[1] - xRange[0]) * xFraction,
    // Plotly Y pixels are top-origin while range[0] is the bottom endpoint.
    yAnchor: yRange[0] + (yRange[1] - yRange[0]) * (1 - yFraction),
  };
}


/**
 * Pan a captured view so the scientific content follows the pointer.
 *
 * @param {ReturnType<typeof captureDirectView>} view
 * @param {number} deltaX
 * @param {number} deltaY
 */
function panCapturedView(view, deltaX, deltaY) {
  if (!view) {
    return null;
  }
  const xShift = -(deltaX / view.xLength) * (view.xRange[1] - view.xRange[0]);
  const yShift = (deltaY / view.yLength) * (view.yRange[1] - view.yRange[0]);
  return {
    xRange: view.xRange.map((value) => value + xShift),
    yRange: view.yRange.map((value) => value + yShift),
  };
}


/**
 * Scale a captured view around its initial centroid and move that anchor to
 * the current centroid, producing combined pinch zoom and centroid pan.
 *
 * @param {ReturnType<typeof captureDirectView>} view
 * @param {{ x: number, y: number }} currentCentroid
 * @param {number} factor
 */
function pinchCapturedView(
  view,
  currentCentroid,
  factor,
) {
  if (!view) {
    return null;
  }
  const safeFactor = clamp(factor, DIRECT_PINCH_MIN_FACTOR, DIRECT_PINCH_MAX_FACTOR);
  const xPixel = clamp(
    currentCentroid.x - view.plotLeft - view.xOffset,
    0,
    view.xLength,
  );
  const yPixel = clamp(
    currentCentroid.y - view.plotTop - view.yOffset,
    0,
    view.yLength,
  );
  const xSpan = (view.xRange[1] - view.xRange[0]) * safeFactor;
  const ySpan = (view.yRange[1] - view.yRange[0]) * safeFactor;
  const xStart = view.xAnchor - (xPixel / view.xLength) * xSpan;
  const yStart = view.yAnchor - (1 - yPixel / view.yLength) * ySpan;
  return {
    xRange: [xStart, xStart + xSpan],
    yRange: [yStart, yStart + ySpan],
  };
}


/**
 * @typedef {{
 *   isRegionDrawing: () => boolean,
 *   addRegionPoint: (event: PointerEvent) => unknown,
 *   findNeuronHit: (event: MouseEvent | PointerEvent) => { neuronId: number, anchor: { x: number, y: number } } | null,
 *   findBorderHit: (event: MouseEvent | PointerEvent) => string | number | null,
 *   setActiveRoi: (roiId: string | number) => unknown,
 *   beginViewOperation: () => unknown,
 *   isViewSyncActive: () => boolean,
 *   rememberViewRange: () => unknown,
 *   isNeuronEligible: (neuronId: number) => boolean,
 *   toggleNeuron: (neuronId: number) => unknown,
 *   showNeuronPreview: (input: {
 *     neuronId: number,
 *     anchor: { x: number, y: number },
 *     pinned?: boolean,
 *   }) => unknown,
 *   hideHoverPreview: () => unknown,
 *   dismissNeuronPreview: () => unknown,
 *   fitView: () => unknown,
 *   refreshPinnedPreview: () => unknown,
 *   isNeuronPreviewPinned: () => boolean,
 *   syncBackgroundView: () => unknown,
 * }} MapInteractionPorts
 */


/**
 * Own Map's Plotly, fine-pointer, wheel, touch, and pen listeners. Touch and
 * pen are claimed in capture phase so Plotly never interprets the same direct
 * manipulation a second time.
 *
 * @param {{
 *   requestAnimationFrame: (callback: FrameRequestCallback) => number,
 *   plotly: { relayout: (plot: HTMLElement, update: Record<string, any>) => Promise<any> },
 * }} dependencies
 */
export function createMapInteractionController({ requestAnimationFrame, plotly }) {
  let wheelFramePending = false;
  let pendingPanX = 0;
  let pendingPanY = 0;
  let pendingPinchY = 0;
  let pendingPinchClientX = 0;
  let pendingPinchClientY = 0;
  let backgroundFramePending = false;
  let touchFramePending = false;
  let pendingTouchView = null;
  let latestTouchView = null;
  let touchRelayoutInFlight = false;
  let commitTouchView = false;
  let suppressSyntheticClickUntil = 0;
  /** @type {Map<number, { id: number, x: number, y: number, pointerType: string }>} */
  const directPointers = new Map();
  /** @type {null | Record<string, any>} */
  let directSession = null;
  /** @type {null | { neuronId: number, x: number, y: number, time: number }} */
  let directNeuronTapCandidate = null;

  /** @param {Event} event */
  function claimDirectEvent(event) {
    event.preventDefault?.();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
      return;
    }
    event.stopPropagation?.();
  }

  /** @param {MapInteractionPorts} ports */
  function requestBackgroundSync(ports) {
    if (backgroundFramePending) {
      return;
    }
    backgroundFramePending = true;
    requestAnimationFrame(() => {
      backgroundFramePending = false;
      ports.syncBackgroundView();
    });
  }

  /** @param {HTMLElement & { _fullLayout?: Record<string, any> }} plot */
  function flushTrackpadGesture(plot) {
    wheelFramePending = false;
    const xaxis = plot._fullLayout?.xaxis;
    const yaxis = plot._fullLayout?.yaxis;
    if (!xaxis || !yaxis) {
      pendingPanX = 0;
      pendingPanY = 0;
      pendingPinchY = 0;
      return;
    }

    let xRange = panAxisRange(xaxis, pendingPanX) ?? xaxis.range?.slice(0, 2);
    let yRange = panAxisRange(yaxis, pendingPanY) ?? yaxis.range?.slice(0, 2);
    if (pendingPinchY !== 0) {
      const rect = plot.getBoundingClientRect();
      const xPixel = clamp(
        pendingPinchClientX - rect.left - (xaxis._offset ?? 0),
        0,
        xaxis._length ?? rect.width,
      );
      const yPixel = clamp(
        pendingPinchClientY - rect.top - (yaxis._offset ?? 0),
        0,
        yaxis._length ?? rect.height,
      );
      const factor = pinchZoomFactor(pendingPinchY);
      xRange = zoomAxisRange(xRange, xaxis.p2d(xPixel), factor) ?? xRange;
      yRange = zoomAxisRange(yRange, yaxis.p2d(yPixel), factor) ?? yRange;
    }

    pendingPanX = 0;
    pendingPanY = 0;
    pendingPinchY = 0;
    if (!xRange || !yRange) {
      return;
    }
    void plotly.relayout(plot, {
      "xaxis.range": xRange,
      "yaxis.range": yRange,
    });
  }

  /**
   * Two-finger scrolling emits an ordinary WheelEvent; trackpad pinch emits a
   * ctrl-modified WheelEvent. The Map owns both trackpad pinch and an explicit
   * Ctrl+wheel gesture while the pointer is over the Map.
   *
   * @param {WheelEvent} event
   * @param {HTMLElement & { _fullLayout?: Record<string, any> }} plot
   * @param {MapInteractionPorts} ports
   * @returns {boolean}
   */
  function handleTrackpadGesture(event, plot, ports) {
    const target = /** @type {Element | null} */ (event.target);
    if (target?.closest?.(".modebar")) {
      return false;
    }
    const xaxis = plot._fullLayout?.xaxis;
    const yaxis = plot._fullLayout?.yaxis;
    if (!xaxis || !yaxis) {
      return false;
    }

    if (event.metaKey || event.altKey || event.shiftKey) {
      return false;
    }

    claimDirectEvent(event);
    ports.beginViewOperation();
    if (event.ctrlKey) {
      pendingPinchY += wheelDeltaPixels(
        event.deltaY,
        event.deltaMode,
        yaxis._length ?? plot.clientHeight,
      );
      pendingPinchClientX = event.clientX;
      pendingPinchClientY = event.clientY;
    } else {
      pendingPanX += wheelDeltaPixels(
        event.deltaX,
        event.deltaMode,
        xaxis._length ?? plot.clientWidth,
      );
      pendingPanY += wheelDeltaPixels(
        event.deltaY,
        event.deltaMode,
        yaxis._length ?? plot.clientHeight,
      );
    }
    if (!wheelFramePending) {
      wheelFramePending = true;
      requestAnimationFrame(() => flushTrackpadGesture(plot));
    }
    return true;
  }

  /** @returns {Array<{ id: number, x: number, y: number, pointerType: string }>} */
  function currentDirectPointers() {
    const pointers = [];
    for (const pointer of directPointers.values()) {
      pointers.push(pointer);
      if (pointers.length === 2) {
        break;
      }
    }
    return pointers;
  }

  function clearDirectNeuronTapCandidate() {
    directNeuronTapCandidate = null;
  }

  /** @param {PointerEvent} event */
  function directTapTime(event) {
    const time = Number(event.timeStamp);
    return Number.isFinite(time) ? time : Date.now();
  }

  /**
   * @param {PointerEvent} event
   * @param {{ neuronId: number, anchor: { x: number, y: number } } | null} neuronHit
   */
  function isMatchingDirectDoubleTap(event, neuronHit) {
    if (!directNeuronTapCandidate || !neuronHit) {
      return false;
    }
    const elapsed = directTapTime(event) - directNeuronTapCandidate.time;
    return (
      neuronHit.neuronId === directNeuronTapCandidate.neuronId
      && elapsed >= 0
      && elapsed <= DIRECT_DOUBLE_TAP_WINDOW_MS
      && Math.hypot(
        event.clientX - directNeuronTapCandidate.x,
        event.clientY - directNeuronTapCandidate.y,
      ) <= DIRECT_DOUBLE_TAP_SLOP_PX
    );
  }

  /**
   * @param {HTMLElement & { _fullLayout?: Record<string, any> }} plot
   * @param {{ id: number, x: number, y: number }} pointer
   * @param {boolean} allowTap
   * @param {{ xRange: number[], yRange: number[] } | null} [viewOverride]
   */
  function beginSinglePointerSession(plot, pointer, allowTap, viewOverride = null) {
    const view = captureDirectView(plot, pointer, viewOverride);
    directSession = {
      kind: "single",
      pointerId: pointer.id,
      start: { x: pointer.x, y: pointer.y },
      view,
      allowTap,
      moved: false,
      viewChanged: directSession?.viewChanged ?? false,
      originView: directSession?.originView ?? view,
    };
  }

  /** @param {HTMLElement & { _fullLayout?: Record<string, any> }} plot */
  function beginPinchSession(plot) {
    clearDirectNeuronTapCandidate();
    const pointers = currentDirectPointers();
    const centroid = pointerCentroid(pointers);
    if (pointers.length < 2 || !centroid) {
      return;
    }
    const view = captureDirectView(plot, centroid, latestTouchView);
    directSession = {
      kind: "pinch",
      startDistance: Math.max(1, pointerDistance(pointers[0], pointers[1])),
      view,
      moved: true,
      viewChanged: directSession?.viewChanged ?? false,
      originView: directSession?.originView ?? view,
    };
  }

  /** @param {MapInteractionPorts} ports */
  function maybeCommitTouchView(ports) {
    if (
      !commitTouchView
      || directPointers.size
      || touchFramePending
      || pendingTouchView
      || touchRelayoutInFlight
    ) {
      return;
    }
    commitTouchView = false;
    ports.rememberViewRange();
    if (ports.isNeuronPreviewPinned()) {
      requestAnimationFrame(ports.refreshPinnedPreview);
    }
  }

  /** @param {HTMLElement} plot @param {MapInteractionPorts} ports */
  function flushTouchView(plot, ports) {
    touchFramePending = false;
    if (touchRelayoutInFlight) {
      return;
    }
    const view = pendingTouchView;
    pendingTouchView = null;
    if (!view) {
      maybeCommitTouchView(ports);
      return;
    }
    latestTouchView = view;
    touchRelayoutInFlight = true;
    Promise.resolve(plotly.relayout(plot, {
      "xaxis.range": view.xRange,
      "yaxis.range": view.yRange,
    })).catch(() => null).finally(() => {
      touchRelayoutInFlight = false;
      requestBackgroundSync(ports);
      if (pendingTouchView && !touchFramePending) {
        touchFramePending = true;
        requestAnimationFrame(() => flushTouchView(plot, ports));
      } else {
        maybeCommitTouchView(ports);
      }
    });
  }

  /**
   * @param {HTMLElement} plot
   * @param {MapInteractionPorts} ports
   * @param {{ xRange: number[], yRange: number[] }} view
   */
  function queueTouchView(plot, ports, view) {
    pendingTouchView = view;
    latestTouchView = view;
    if (touchFramePending || touchRelayoutInFlight) {
      return;
    }
    touchFramePending = true;
    requestAnimationFrame(() => flushTouchView(plot, ports));
  }

  function ownsTouchRelayout() {
    return Boolean(
      directPointers.size
      || touchFramePending
      || pendingTouchView
      || touchRelayoutInFlight
      || commitTouchView
    );
  }

  /** @param {PointerEvent} event @param {MapInteractionPorts} ports */
  function handleDirectTap(event, ports) {
    const neuronHit = ports.findNeuronHit(event);
    if (ports.isNeuronPreviewPinned()) {
      const togglesPinnedNeuron = (
        !ports.isRegionDrawing()
        && neuronHit
        && isMatchingDirectDoubleTap(event, neuronHit)
      );
      clearDirectNeuronTapCandidate();
      if (togglesPinnedNeuron) {
        ports.toggleNeuron(neuronHit.neuronId);
        ports.showNeuronPreview({ ...neuronHit, pinned: true });
      } else {
        ports.dismissNeuronPreview();
      }
      return;
    }
    if (ports.isRegionDrawing()) {
      clearDirectNeuronTapCandidate();
      ports.addRegionPoint(event);
      return;
    }
    if (neuronHit) {
      ports.showNeuronPreview({ ...neuronHit, pinned: true });
      directNeuronTapCandidate = ports.isNeuronPreviewPinned()
        ? {
            neuronId: neuronHit.neuronId,
            x: event.clientX,
            y: event.clientY,
            time: directTapTime(event),
          }
        : null;
      return;
    }
    clearDirectNeuronTapCandidate();
    const roiId = ports.findBorderHit(event);
    if (roiId !== null) {
      ports.setActiveRoi(roiId);
      return;
    }
    ports.dismissNeuronPreview();
  }

  /** @param {PointerEvent} event @param {HTMLElement} plot @param {MapInteractionPorts} ports */
  function handleDirectPointerDown(event, plot, ports) {
    if (!isDirectManipulationPointer(event) || event.button !== 0) {
      return;
    }
    const target = /** @type {Element | null} */ (event.target);
    if (target?.closest?.(".modebar") || target?.closest?.(".overlay-stack")) {
      return;
    }
    claimDirectEvent(event);
    suppressSyntheticClickUntil = Date.now() + SYNTHETIC_CLICK_BLOCK_MS;
    ports.hideHoverPreview();
    if (!directPointers.size) {
      ports.beginViewOperation();
    }
    const pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      pointerType: event.pointerType,
    };
    directPointers.set(event.pointerId, pointer);
    try {
      plot.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture can disappear when the browser cancels during pointerdown.
    }
    if (directPointers.size === 1) {
      latestTouchView = null;
      beginSinglePointerSession(plot, pointer, true);
    } else {
      beginPinchSession(plot);
    }
  }

  /** @param {PointerEvent} event @param {HTMLElement & { _fullLayout?: Record<string, any> }} plot @param {MapInteractionPorts} ports */
  function handleDirectPointerMove(event, plot, ports) {
    const pointer = directPointers.get(event.pointerId);
    if (!pointer || !directSession) {
      return;
    }
    claimDirectEvent(event);
    pointer.x = event.clientX;
    pointer.y = event.clientY;

    if (directPointers.size >= 2) {
      const pointers = currentDirectPointers();
      if (directSession.kind !== "pinch") {
        beginPinchSession(plot);
      }
      const centroid = pointerCentroid(pointers);
      if (!centroid || !directSession?.view) {
        return;
      }
      const distance = Math.max(1, pointerDistance(pointers[0], pointers[1]));
      const view = pinchCapturedView(
        directSession.view,
        centroid,
        directSession.startDistance / distance,
      );
      if (view) {
        directSession.viewChanged = true;
        queueTouchView(plot, ports, view);
      }
      return;
    }

    if (directSession.kind !== "single" || directSession.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - directSession.start.x;
    const deltaY = event.clientY - directSession.start.y;
    const slop = event.pointerType === "pen" ? PEN_TAP_SLOP_PX : TOUCH_TAP_SLOP_PX;
    if (!directSession.moved && Math.hypot(deltaX, deltaY) <= slop) {
      return;
    }
    clearDirectNeuronTapCandidate();
    directSession.moved = true;
    directSession.allowTap = false;
    const view = panCapturedView(directSession.view, deltaX, deltaY);
    if (view) {
      directSession.viewChanged = true;
      queueTouchView(plot, ports, view);
    }
  }

  /** @param {PointerEvent} event @param {HTMLElement} plot @param {MapInteractionPorts} ports */
  function handleDirectPointerUp(event, plot, ports) {
    if (!directPointers.has(event.pointerId) || !directSession) {
      return;
    }
    claimDirectEvent(event);
    suppressSyntheticClickUntil = Date.now() + SYNTHETIC_CLICK_BLOCK_MS;
    const wasTap = (
      directPointers.size === 1
      && directSession.kind === "single"
      && directSession.pointerId === event.pointerId
      && directSession.allowTap
      && !directSession.moved
    );
    const changedView = Boolean(directSession.viewChanged);
    directPointers.delete(event.pointerId);
    try {
      plot.releasePointerCapture?.(event.pointerId);
    } catch {
      // The browser may already have released capture during pointerup.
    }

    if (wasTap) {
      handleDirectTap(event, ports);
    }
    if (directPointers.size >= 2) {
      beginPinchSession(plot);
      return;
    }
    if (directPointers.size === 1) {
      const remaining = currentDirectPointers()[0];
      beginSinglePointerSession(plot, remaining, false, latestTouchView);
      directSession.moved = true;
      directSession.viewChanged = changedView;
      return;
    }
    if (changedView) {
      commitTouchView = true;
      maybeCommitTouchView(ports);
    }
    directSession = null;
    latestTouchView = null;
  }

  /** @param {PointerEvent} event @param {HTMLElement} plot @param {MapInteractionPorts} ports */
  function cancelDirectContact(event, plot, ports) {
    clearDirectNeuronTapCandidate();
    if (!directPointers.has(event.pointerId)) {
      return;
    }
    claimDirectEvent(event);
    const origin = directSession?.originView;
    const changedView = Boolean(directSession?.viewChanged);
    directPointers.delete(event.pointerId);
    try {
      plot.releasePointerCapture?.(event.pointerId);
    } catch {
      // Capture may already be gone after a native cancellation.
    }
    suppressSyntheticClickUntil = Date.now() + SYNTHETIC_CLICK_BLOCK_MS;

    if (directPointers.size >= 2) {
      beginPinchSession(plot);
      return;
    }
    if (directPointers.size === 1) {
      const remaining = currentDirectPointers()[0];
      beginSinglePointerSession(plot, remaining, false, latestTouchView);
      directSession.moved = true;
      directSession.viewChanged = changedView;
      return;
    }

    directSession = null;
    commitTouchView = false;
    if (origin && changedView) {
      queueTouchView(plot, ports, {
        xRange: origin.xRange,
        yRange: origin.yRange,
      });
    }
    latestTouchView = null;
  }

  /** @param {HTMLElement} plot @param {MapInteractionPorts} ports */
  function cancelAllDirectContacts(plot, ports) {
    clearDirectNeuronTapCandidate();
    if (!directPointers.size) {
      return;
    }
    const origin = directSession?.originView;
    const changedView = Boolean(directSession?.viewChanged);
    for (const pointerId of directPointers.keys()) {
      try {
        plot.releasePointerCapture?.(pointerId);
      } catch {
        // Native cancellation may already have released capture.
      }
    }
    directPointers.clear();
    directSession = null;
    commitTouchView = false;
    suppressSyntheticClickUntil = Date.now() + SYNTHETIC_CLICK_BLOCK_MS;
    if (origin && changedView) {
      queueTouchView(plot, ports, {
        xRange: origin.xRange,
        yRange: origin.yRange,
      });
    }
    latestTouchView = null;
  }

  /**
   * @param {any} event
   * @param {HTMLElement & { _fullLayout?: Record<string, any> }} plot
   * @param {MapInteractionPorts} ports
   */
  function handleNeuronHover(event, plot, ports) {
    if (ports.isRegionDrawing() || ports.isNeuronPreviewPinned()) {
      ports.hideHoverPreview();
      return;
    }
    const point = /** @type {any[]} */ (event?.points ?? []).find((candidate) => (
      Number.isFinite(Number(candidate?.customdata))
    ));
    if (!point) {
      ports.hideHoverPreview();
      return;
    }
    const neuronId = Number(point.customdata);
    const x = axisDataToPlotPixel(
      point.xaxis ?? plot._fullLayout?.xaxis,
      Number(point.x),
    );
    const y = axisDataToPlotPixel(
      point.yaxis ?? plot._fullLayout?.yaxis,
      Number(point.y),
    );
    if (x === null || y === null) {
      ports.hideHoverPreview();
      return;
    }
    const rect = plot.getBoundingClientRect();
    ports.showNeuronPreview({
      neuronId,
      anchor: { x: rect.left + x, y: rect.top + y },
      pinned: false,
    });
  }

  /**
   * @param {HTMLElement & {
   *   _fullLayout?: Record<string, any>,
   *   on: (name: string, listener: (event: any) => void) => unknown,
   * }} plot
   * @param {MapInteractionPorts} ports
   */
  function wire(plot, ports) {
    plot.on("plotly_relayout", () => {
      if (ownsTouchRelayout()) {
        requestBackgroundSync(ports);
        return;
      }
      if (!ports.isViewSyncActive()) {
        ports.beginViewOperation();
      }
      if (ports.isNeuronPreviewPinned()) {
        requestAnimationFrame(ports.refreshPinnedPreview);
      } else {
        ports.hideHoverPreview();
      }
      requestAnimationFrame(ports.rememberViewRange);
    });
    plot.on("plotly_relayouting", () => {
      if (!ports.isViewSyncActive()) {
        ports.beginViewOperation();
      }
      if (!ports.isNeuronPreviewPinned()) {
        ports.hideHoverPreview();
      }
      requestBackgroundSync(ports);
    });
    plot.on("plotly_hover", (event) => {
      handleNeuronHover(event, plot, ports);
    });
    plot.on("plotly_unhover", ports.hideHoverPreview);
    plot.addEventListener("click", (event) => {
      if (Date.now() < suppressSyntheticClickUntil) {
        claimDirectEvent(event);
        return;
      }
      ports.hideHoverPreview();
      const target = /** @type {Element | null} */ (event.target);
      if (
        ports.isRegionDrawing()
        || target?.closest?.(".modebar")
        || target?.closest?.(".overlay-stack")
      ) {
        return;
      }
      if (ports.findNeuronHit(event)) {
        return;
      }
      const roiId = ports.findBorderHit(event);
      if (roiId === null) {
        ports.dismissNeuronPreview();
        return;
      }
      ports.setActiveRoi(roiId);
      event.preventDefault();
      event.stopPropagation();
    }, true);
    plot.addEventListener("dblclick", (event) => {
      if (Date.now() < suppressSyntheticClickUntil) {
        claimDirectEvent(event);
        return;
      }
      const target = /** @type {Element | null} */ (event.target);
      if (
        event.defaultPrevented
        || event.button !== 0
        || ports.isRegionDrawing()
        || target?.closest?.(".modebar")
        || target?.closest?.(".overlay-stack")
      ) {
        return;
      }
      claimDirectEvent(event);
      ports.fitView();
    }, true);
    plot.on("plotly_click", (event) => {
      if (Date.now() < suppressSyntheticClickUntil || ports.isRegionDrawing()) {
        return;
      }
      const neuronId = event?.points?.[0]?.customdata;
      if (typeof neuronId === "number" && ports.isNeuronEligible(neuronId)) {
        ports.toggleNeuron(neuronId);
      }
    });
    plot.addEventListener(
      "wheel",
      (event) => {
        if (handleTrackpadGesture(event, plot, ports)) {
          ports.hideHoverPreview();
        }
      },
      { capture: true, passive: false },
    );
    plot.addEventListener(
      "pointerdown",
      (event) => handleDirectPointerDown(event, plot, ports),
      { capture: true, passive: false },
    );
    plot.addEventListener(
      "pointermove",
      (event) => handleDirectPointerMove(event, plot, ports),
      { capture: true, passive: false },
    );
    plot.addEventListener(
      "pointerup",
      (event) => handleDirectPointerUp(event, plot, ports),
      { capture: true, passive: false },
    );
    plot.addEventListener(
      "pointercancel",
      (event) => cancelDirectContact(event, plot, ports),
      { capture: true, passive: false },
    );
    for (const eventName of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      plot.addEventListener(eventName, claimDirectEvent, {
        capture: true,
        passive: false,
      });
    }
    plot.addEventListener("lostpointercapture", (event) => {
      if (directPointers.has(event.pointerId)) {
        cancelDirectContact(event, plot, ports);
      }
    }, true);
    plot.addEventListener("pointerdown", (event) => {
      if (!isDirectManipulationPointer(event)) {
        clearDirectNeuronTapCandidate();
        ports.beginViewOperation();
        ports.hideHoverPreview();
      }
    }, true);
    plot.addEventListener("mouseleave", ports.hideHoverPreview);
    const ownerDocument = plot.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    ownerWindow?.addEventListener("blur", () => {
      cancelAllDirectContacts(plot, ports);
    });
    ownerWindow?.addEventListener(
      "orientationchange",
      () => cancelAllDirectContacts(plot, ports),
    );
    ownerDocument?.addEventListener("visibilitychange", () => {
      if (ownerDocument.hidden) {
        cancelAllDirectContacts(plot, ports);
      }
    });
  }

  return { wire };
}
