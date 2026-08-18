import { clamp } from "./model.js";


export const ROI_BOX_BORDER_CLICK_TOLERANCE_PX = 8;

const WHEEL_LINE_HEIGHT_PX = 16;
const PINCH_ZOOM_RATE = 0.01;
const MAX_PINCH_LOG_SCALE_PER_FRAME = 0.35;


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
 * Return the closest ROI border within the current eight-pixel hit band.
 * Equal-distance hits retain ROI array order.
 *
 * @param {{
 *   event: MouseEvent,
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
 *   event: MouseEvent,
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


/**
 * @typedef {{
 *   isRegionDrawing: () => boolean,
 *   findBorderHit: (event: MouseEvent) => string | number | null,
 *   setActiveRoi: (roiId: string | number) => unknown,
 *   rememberViewRange: () => unknown,
 *   isNeuronEligible: (neuronId: number) => boolean,
 *   toggleNeuron: (neuronId: number) => unknown,
 *   showNeuronPreview: (input: {
 *     neuronId: number,
 *     anchor: { x: number, y: number },
 *   }) => unknown,
 *   hideNeuronPreview: () => unknown,
 * }} MapInteractionPorts
 */


/**
 * Own Map's DOM and Plotly listeners without owning listener lifecycle state.
 * The facade applies the post-Plotly-react readiness gate.
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
   * macOS two-finger scrolling emits an ordinary WheelEvent; trackpad pinch
   * emits a ctrl-modified WheelEvent. Own both paths so scroll pans while only
   * pinch zooms.
   *
   * @param {WheelEvent} event
   * @param {HTMLElement & { _fullLayout?: Record<string, any> }} plot
   */
  function handleTrackpadGesture(event, plot) {
    const target = /** @type {Element | null} */ (event.target);
    if (target?.closest?.(".modebar")) {
      return;
    }
    const xaxis = plot._fullLayout?.xaxis;
    const yaxis = plot._fullLayout?.yaxis;
    if (!xaxis || !yaxis) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
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
  }

  /**
   * @param {any} event
   * @param {HTMLElement & { _fullLayout?: Record<string, any> }} plot
   * @param {MapInteractionPorts} ports
   */
  function handleNeuronHover(event, plot, ports) {
    if (ports.isRegionDrawing()) {
      ports.hideNeuronPreview();
      return;
    }
    const point = /** @type {any[]} */ (event?.points ?? []).find((candidate) => (
      Number.isFinite(Number(candidate?.customdata))
    ));
    if (!point) {
      ports.hideNeuronPreview();
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
      ports.hideNeuronPreview();
      return;
    }
    const rect = plot.getBoundingClientRect();
    ports.showNeuronPreview({
      neuronId,
      anchor: { x: rect.left + x, y: rect.top + y },
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
      ports.hideNeuronPreview();
      requestAnimationFrame(ports.rememberViewRange);
    });
    plot.on("plotly_hover", (event) => {
      handleNeuronHover(event, plot, ports);
    });
    plot.on("plotly_unhover", ports.hideNeuronPreview);
    plot.addEventListener("click", (event) => {
      ports.hideNeuronPreview();
      const target = /** @type {Element | null} */ (event.target);
      if (
        ports.isRegionDrawing()
        || target?.closest?.(".modebar")
        || target?.closest?.(".overlay-stack")
      ) {
        return;
      }
      const roiId = ports.findBorderHit(event);
      if (!roiId) {
        return;
      }
      ports.setActiveRoi(roiId);
      event.preventDefault();
      event.stopPropagation();
    }, true);
    plot.on("plotly_click", (event) => {
      if (ports.isRegionDrawing()) {
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
        ports.hideNeuronPreview();
        handleTrackpadGesture(event, plot);
      },
      { capture: true, passive: false },
    );
    plot.addEventListener("pointerdown", ports.hideNeuronPreview, true);
    plot.addEventListener("mouseleave", ports.hideNeuronPreview);
  }

  return { wire };
}
