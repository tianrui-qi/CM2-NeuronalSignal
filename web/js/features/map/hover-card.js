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


/**
 * Screen-only Map hover presentation. Scientific trace construction is
 * injected through the Temporal facade; this view owns only DOM, Plotly, and
 * stale-render suppression.
 *
 * @param {{
 *   document: Document,
 *   window: Window,
 *   plotly: { react: (plot: HTMLElement, data: any[], layout: any, config: any) => Promise<any> },
 *   requestAnimationFrame: (callback: FrameRequestCallback) => number,
 * }} dependencies
 */
export function createMapNeuronHoverCard({
  document,
  window,
  plotly,
  requestAnimationFrame,
}) {
  let revision = 0;
  let framePending = false;
  let rendering = false;
  /** @type {{ revision: number, payload: any } | null} */
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

    const header = document.createElement("header");
    header.className = "map-neuron-preview-header";
    const title = document.createElement("span");
    title.id = "map-neuron-preview-title";
    title.className = "map-neuron-preview-title";
    header.append(title);

    const plot = document.createElement("div");
    plot.id = "map-neuron-preview-plot";
    plot.className = "map-neuron-preview-plot";

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

  async function flush() {
    if (rendering) {
      return;
    }
    rendering = true;
    while (queued) {
      const next = queued;
      queued = null;
      const { payload } = next;
      const card = ensureCard();
      const title = document.getElementById("map-neuron-preview-title");
      const plot = /** @type {HTMLElement} */ (
        document.getElementById("map-neuron-preview-plot")
      );
      title.textContent = payload.title;
      renderMetadata(payload.metadataColumns);
      card.classList.remove("hidden");
      card.classList.add("is-rendering");

      const viewport = buildHoverTraceViewport(
        payload.trace,
        window.innerHeight,
      );
      plot.style.height = `${viewport.plotHeight}px`;
      try {
        await plotly.react(plot, payload.trace.traces, {
          margin: { l: 0, r: 0, t: 0, b: 0 },
          paper_bgcolor: "rgba(0,0,0,0)",
          plot_bgcolor: "rgba(0,0,0,0)",
          xaxis: {
            visible: false,
            fixedrange: true,
            range: payload.trace.frameRange,
          },
          yaxis: {
            visible: false,
            fixedrange: true,
            range: viewport.yRange,
          },
          shapes: payload.trace.shapes,
          annotations: payload.trace.annotations,
          height: viewport.plotHeight,
          showlegend: false,
          hovermode: false,
          dragmode: false,
        }, {
          responsive: false,
          staticPlot: true,
          displayModeBar: false,
          displaylogo: false,
        });
      } catch (error) {
        console.error(error);
        if (next.revision === revision) {
          card.classList.add("hidden");
          card.classList.remove("is-rendering");
        }
        continue;
      }
      if (next.revision !== revision) {
        continue;
      }
      position(card, payload.anchor);
      card.classList.remove("is-rendering");
    }
    rendering = false;
  }

  function scheduleFlush() {
    if (framePending) {
      return;
    }
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      void flush();
    });
  }

  /** @param {any} payload */
  function show(payload) {
    revision += 1;
    queued = { revision, payload };
    const card = ensureCard();
    card.classList.add("hidden");
    card.classList.remove("is-rendering");
    scheduleFlush();
    return true;
  }

  function hide() {
    revision += 1;
    queued = null;
    const card = document.getElementById("map-neuron-preview");
    card?.classList.add("hidden");
    card?.classList.remove("is-rendering");
    return true;
  }

  return Object.freeze({ show, hide });
}
