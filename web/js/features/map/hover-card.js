const PREVIEW_VIEWPORT_PADDING_PX = 8;
const PREVIEW_ANCHOR_GAP_PX = 12;
const PREVIEW_MIN_PLOT_HEIGHT_PX = 48;
const PREVIEW_MAX_PLOT_HEIGHT_PX = 280;
const PREVIEW_MAX_VIEWPORT_FRACTION = 0.42;
const PREVIEW_VERTICAL_PADDING_PX = 6;


/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


/** @param {DOMRect} a @param {DOMRect} b */
function rectsOverlap(a, b) {
  return !(
    a.right <= b.left
    || a.left >= b.right
    || a.bottom <= b.top
    || a.top >= b.bottom
  );
}


/**
 * Add compact visual breathing room around one neuron's real range and its
 * guides while preserving Temporal: Trace's pixels-per-scientific-unit.
 * Very tall outliers retain their complete range and are viewport-fitted.
 *
 * @param {{ height: number, yRange: number[], guideRange?: number[] | null, pixelsPerUnit: number }} trace
 * @param {number} viewportHeight
 */
export function buildHoverTraceViewport(trace, viewportHeight) {
  const yRange = Array.isArray(trace.yRange)
    ? trace.yRange.slice(0, 2).map(Number)
    : [-1, 1];
  const guideRange = Array.isArray(trace.guideRange)
    ? trace.guideRange.slice(0, 2).map(Number)
    : null;
  if (
    guideRange?.length === 2
    && guideRange.every(Number.isFinite)
    && yRange.every(Number.isFinite)
  ) {
    yRange[0] = Math.min(yRange[0], guideRange[0]);
    yRange[1] = Math.max(yRange[1], guideRange[1]);
  }
  const pixelsPerUnit = Number(trace.pixelsPerUnit);
  const guideAwareHeight = (
    Number.isFinite(pixelsPerUnit)
    && pixelsPerUnit > 0
    && yRange.every(Number.isFinite)
  )
    ? Math.ceil(Math.abs(yRange[1] - yRange[0]) * pixelsPerUnit)
    : 1;
  const naturalHeight = Math.max(
    1,
    Math.ceil(Number(trace.height) || 1),
    guideAwareHeight,
  );
  const paddedNaturalHeight = naturalHeight + 2 * PREVIEW_VERTICAL_PADDING_PX;
  const maxHeight = Math.max(
    PREVIEW_MIN_PLOT_HEIGHT_PX,
    Math.min(
      PREVIEW_MAX_PLOT_HEIGHT_PX,
      Math.floor(viewportHeight * PREVIEW_MAX_VIEWPORT_FRACTION),
    ),
  );
  const plotHeight = clamp(
    paddedNaturalHeight,
    PREVIEW_MIN_PLOT_HEIGHT_PX,
    maxHeight,
  );
  if (
    plotHeight > guideAwareHeight
    && Number.isFinite(pixelsPerUnit)
    && pixelsPerUnit > 0
    && yRange.every(Number.isFinite)
  ) {
    const center = (yRange[0] + yRange[1]) / 2;
    const targetSpan = plotHeight / pixelsPerUnit;
    const currentSpan = Math.abs(yRange[1] - yRange[0]);
    if (targetSpan > currentSpan) {
      yRange[0] = center - targetSpan / 2;
      yRange[1] = center + targetSpan / 2;
    }
  }
  return { plotHeight, yRange };
}


/**
 * Position the card beside a Map marker, avoiding the workflow overlay when
 * possible and clamping the result to the viewport.
 *
 * @param {{ x: number, y: number }} anchor
 * @param {{ width: number, height: number }} cardSize
 * @param {{ width: number, height: number }} viewport
 * @param {DOMRect | null} overlayRect
 */
export function placeHoverCard(anchor, cardSize, viewport, overlayRect = null) {
  const maxX = Math.max(
    PREVIEW_VIEWPORT_PADDING_PX,
    viewport.width - cardSize.width - PREVIEW_VIEWPORT_PADDING_PX,
  );
  const maxY = Math.max(
    PREVIEW_VIEWPORT_PADDING_PX,
    viewport.height - cardSize.height - PREVIEW_VIEWPORT_PADDING_PX,
  );
  const candidates = [
    anchor.x + PREVIEW_ANCHOR_GAP_PX,
    anchor.x - cardSize.width - PREVIEW_ANCHOR_GAP_PX,
    overlayRect?.right + PREVIEW_ANCHOR_GAP_PX,
  ]
    .filter(Number.isFinite)
    .map((x) => clamp(Number(x), PREVIEW_VIEWPORT_PADDING_PX, maxX));
  const y = clamp(
    anchor.y - cardSize.height * 0.34,
    PREVIEW_VIEWPORT_PADDING_PX,
    maxY,
  );
  const selectedX = candidates.find((x) => {
    if (!overlayRect) {
      return true;
    }
    const candidateRect = /** @type {DOMRect} */ ({
      left: x,
      right: x + cardSize.width,
      top: y,
      bottom: y + cardSize.height,
    });
    return !rectsOverlap(candidateRect, overlayRect);
  }) ?? candidates[0];
  return { left: selectedX, top: y };
}


/** @param {unknown} values @param {[number, number]} fallback */
function finiteRange(values, fallback) {
  if (!Array.isArray(values) || values.length < 2) {
    return fallback;
  }
  const lower = Number(values[0]);
  const upper = Number(values[1]);
  return Number.isFinite(lower) && Number.isFinite(upper) && lower !== upper
    ? [lower, upper]
    : fallback;
}


/** @param {unknown} dash @param {number} width */
function canvasLineDash(dash, width) {
  const unit = Math.max(1, width);
  switch (dash) {
    case "dot":
      return [unit, 3 * unit];
    case "dash":
      return [4 * unit, 3 * unit];
    case "longdash":
      return [8 * unit, 3 * unit];
    case "dashdot":
      return [4 * unit, 3 * unit, unit, 3 * unit];
    case "longdashdot":
      return [8 * unit, 3 * unit, unit, 3 * unit];
    default:
      return [];
  }
}


/**
 * Draw the Plotly-independent Temporal descriptor without constructing a
 * Plotly graph. The descriptor remains the sole owner of scientific values,
 * guides, colors, and annotations.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {any} trace
 * @param {{ plotHeight: number, yRange: number[] }} viewport
 * @param {Window} window
 */
function drawTracePreview(canvas, trace, viewport, window) {
  const cssWidth = Math.max(1, canvas.clientWidth);
  const cssHeight = Math.max(1, canvas.clientHeight);
  const pixelRatio = Math.max(1, Number(window.devicePixelRatio) || 1);
  const backingWidth = Math.max(1, Math.round(cssWidth * pixelRatio));
  const backingHeight = Math.max(1, Math.round(cssHeight * pixelRatio));
  if (canvas.width !== backingWidth) {
    canvas.width = backingWidth;
  }
  if (canvas.height !== backingHeight) {
    canvas.height = backingHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas 2D is unavailable for the neuron preview.");
  }
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);

  const [xMin, xMax] = finiteRange(trace.frameRange, [0, 1]);
  const [yMin, yMax] = finiteRange(viewport.yRange, [-1, 1]);
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  const mapX = (value) => ((value - xMin) / xSpan) * cssWidth;
  const mapY = (value) => cssHeight - ((value - yMin) / ySpan) * cssHeight;

  context.save();
  context.beginPath();
  context.rect(0, 0, cssWidth, cssHeight);
  context.clip();
  for (const series of trace.traces ?? []) {
    const x = series?.x;
    const y = series?.y;
    const pointCount = Math.min(Number(x?.length) || 0, Number(y?.length) || 0);
    if (!pointCount) {
      continue;
    }
    const lineWidth = Math.max(0.5, Number(series.line?.width) || 1);
    const dash = canvasLineDash(series.line?.dash, lineWidth);
    context.beginPath();
    context.strokeStyle = String(series.line?.color ?? "rgba(255, 255, 255, 0.72)");
    context.lineWidth = lineWidth;
    context.lineCap = dash.length ? "round" : "butt";
    context.lineJoin = "round";
    context.setLineDash(dash);
    context.globalAlpha = Number.isFinite(Number(series.opacity))
      ? clamp(Number(series.opacity), 0, 1)
      : 1;
    let hasOpenSegment = false;
    for (let index = 0; index < pointCount; index += 1) {
      const dataX = Number(x[index]);
      const dataY = Number(y[index]);
      if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) {
        hasOpenSegment = false;
        continue;
      }
      const screenX = mapX(dataX);
      const screenY = mapY(dataY);
      if (hasOpenSegment) {
        context.lineTo(screenX, screenY);
      } else {
        context.moveTo(screenX, screenY);
        hasOpenSegment = true;
      }
    }
    context.stroke();
  }

  const computedStyle = window.getComputedStyle(canvas);
  for (const annotation of trace.annotations ?? []) {
    const dataX = Number(annotation?.x);
    const dataY = Number(annotation?.y);
    if (!Number.isFinite(dataX) || !Number.isFinite(dataY)) {
      continue;
    }
    const fontSize = Math.max(1, Number(annotation.font?.size) || 11);
    const fontFamily = String(annotation.font?.family ?? computedStyle.fontFamily);
    context.save();
    context.fillStyle = String(annotation.font?.color ?? computedStyle.color);
    context.globalAlpha = Number.isFinite(Number(annotation.opacity))
      ? clamp(Number(annotation.opacity), 0, 1)
      : 1;
    context.font = `${fontSize}px ${fontFamily}`;
    context.textAlign = annotation.xanchor === "right"
      ? "right"
      : annotation.xanchor === "center"
        ? "center"
        : "left";
    context.textBaseline = annotation.yanchor === "top"
      ? "top"
      : annotation.yanchor === "middle"
        ? "middle"
        : "bottom";
    context.fillText(
      String(annotation.text ?? ""),
      mapX(dataX) + (Number(annotation.xshift) || 0),
      mapY(dataY) - (Number(annotation.yshift) || 0),
    );
    context.restore();
  }
  context.restore();
}


/**
 * Screen-only Map hover presentation. Scientific trace construction is
 * injected through the Temporal facade; this view owns only DOM, Canvas2D,
 * and stale-render suppression.
 *
 * @param {{
 *   document: Document,
 *   window: Window,
 *   requestAnimationFrame: (callback: FrameRequestCallback) => number,
 * }} dependencies
 */
export function createMapNeuronHoverCard({
  document,
  window,
  requestAnimationFrame,
}) {
  let latestRenderRequest = 0;
  let framePending = false;
  /** @type {{ requestId: number, payload: any } | null} */
  let queued = null;

  function ensureCard() {
    let card = document.getElementById("map-neuron-preview");
    if (card) {
      return card;
    }
    card = document.createElement("aside");
    card.id = "map-neuron-preview";
    card.className = "map-neuron-preview floating-surface hidden";
    card.setAttribute("aria-hidden", "true");
    card.setAttribute("role", "region");
    card.setAttribute("aria-label", "Neuron details");

    const header = document.createElement("header");
    header.className = "map-neuron-preview-header";
    const title = document.createElement("span");
    title.id = "map-neuron-preview-title";
    title.className = "map-neuron-preview-title";
    header.appendChild(title);

    const plot = document.createElement("canvas");
    plot.id = "map-neuron-preview-plot";
    plot.className = "map-neuron-preview-plot";
    plot.setAttribute("role", "img");
    plot.setAttribute("aria-label", "Neuron activity trace");

    const metadata = document.createElement("dl");
    metadata.id = "map-neuron-preview-metadata";
    metadata.className = "map-neuron-preview-metadata";
    card.append(header, plot, metadata);
    document.body.appendChild(card);
    return card;
  }

  /** @param {Array<Array<{ label: string, value: string }>>} columns */
  function renderMetadata(columns) {
    const metadata = document.getElementById("map-neuron-preview-metadata");
    if (!metadata) {
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const rows of columns) {
      const column = document.createElement("div");
      column.className = "map-neuron-preview-metric-column";
      for (const row of rows) {
        const label = document.createElement("dt");
        label.textContent = row.label;
        const value = document.createElement("dd");
        value.textContent = row.value;
        column.append(label, value);
      }
      fragment.append(column);
    }
    metadata.replaceChildren(fragment);
  }

  /** @param {HTMLElement} card @param {{ x: number, y: number }} anchor */
  function position(card, anchor) {
    const rect = card.getBoundingClientRect();
    const overlayRect = document.querySelector(".overlay-stack")?.getBoundingClientRect()
      ?? null;
    const placement = placeHoverCard(
      anchor,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
      overlayRect,
    );
    card.style.left = `${placement.left}px`;
    card.style.top = `${placement.top}px`;
  }

  function flush() {
    const next = queued;
    queued = null;
    if (!next || next.requestId !== latestRenderRequest) {
      return;
    }
    const { payload } = next;
    const card = ensureCard();
    const title = document.getElementById("map-neuron-preview-title");
    const plot = /** @type {HTMLCanvasElement} */ (
      document.getElementById("map-neuron-preview-plot")
    );
    title.textContent = payload.title;
    renderMetadata(payload.metadataColumns);
    card.classList.remove("hidden");

    const viewport = buildHoverTraceViewport(
      payload.trace,
      window.innerHeight,
    );
    plot.style.height = `${viewport.plotHeight}px`;
    plot.setAttribute("aria-label", `${payload.title} activity trace`);
    try {
      drawTracePreview(plot, payload.trace, viewport, window);
    } catch (error) {
      console.error(error);
      if (next.requestId === latestRenderRequest) {
        card.classList.add("hidden");
        card.setAttribute("aria-hidden", "true");
      }
      return;
    }
    if (next.requestId !== latestRenderRequest) {
      return;
    }
    position(card, payload.anchor);
    card.setAttribute("aria-hidden", "false");
  }

  function scheduleFlush() {
    if (framePending) {
      return;
    }
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      flush();
    });
  }

  /** @param {any} payload */
  function show(payload) {
    latestRenderRequest += 1;
    queued = { requestId: latestRenderRequest, payload };
    const card = ensureCard();
    card.classList.add("hidden");
    card.setAttribute("aria-hidden", "true");
    if (payload.immediate === true) {
      flush();
    } else {
      scheduleFlush();
    }
    return true;
  }

  /** @param {{ x: number, y: number }} anchor */
  function move(anchor) {
    const card = document.getElementById("map-neuron-preview");
    if (!card || card.classList.contains("hidden")) {
      return false;
    }
    position(card, anchor);
    return true;
  }

  function hide() {
    latestRenderRequest += 1;
    queued = null;
    const card = document.getElementById("map-neuron-preview");
    card?.classList.add("hidden");
    card?.setAttribute("aria-hidden", "true");
    return true;
  }

  return Object.freeze({ show, hide, move });
}
