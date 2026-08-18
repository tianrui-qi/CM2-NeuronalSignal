import { buildTracePlotData } from "./model.js";


export const TRACE_PLOT_MARGIN = Object.freeze({ l: 0, r: 0, t: 0, b: 0 });
export const TRACE_DESELECT_BUTTON_SIZE_PX = 20;
export const TRACE_DESELECT_BUTTON_INSET_PX = 8;
export const TRACE_DESELECT_HIDE_DELAY_MS = 140;


/** @param {any} trace */
export function isTraceNeuronLine(trace) {
  return Number.isFinite(trace?.meta?.neuronId);
}


/**
 * Transform the live dark-theme Plotly data into the existing paper-export
 * style without mutating the rendered descriptor.
 *
 * @param {Cm2PlotElement} plot
 * @param {(value: unknown) => any} clonePlotlyObject
 */
export function makeTraceExportData(plot, clonePlotlyObject) {
  const clonedData = /** @type {any[]} */ (clonePlotlyObject(plot.data ?? []));
  return clonedData.map((trace) => {
    if (trace?.type !== "scatter" || !trace.line) {
      return trace;
    }
    const line = { ...trace.line, color: "rgb(0, 0, 0)" };
    if (!isTraceNeuronLine(trace)) {
      line.dash = "dot";
      line.width = Math.min(Number(line.width) || 1, 1);
    }
    return { ...trace, line };
  });
}


/**
 * @param {Cm2PlotElement} plot
 * @param {number} width
 * @param {number} height
 * @param {(value: unknown) => any} clonePlotlyObject
 */
export function makeTraceExportLayout(
  plot,
  width,
  height,
  clonePlotlyObject,
) {
  const layout = clonePlotlyObject(plot.layout ?? {});
  layout.width = width;
  layout.height = height;
  layout.paper_bgcolor = "rgb(255, 255, 255)";
  layout.plot_bgcolor = "rgb(255, 255, 255)";
  layout.margin = clonePlotlyObject(plot.layout?.margin ?? TRACE_PLOT_MARGIN);
  layout.xaxis = {
    ...(layout.xaxis ?? {}),
    visible: false,
    fixedrange: true,
    range: clonePlotlyObject(plot._fullLayout?.xaxis?.range ?? layout.xaxis?.range),
  };
  layout.yaxis = {
    ...(layout.yaxis ?? {}),
    visible: false,
    fixedrange: true,
    range: clonePlotlyObject(plot._fullLayout?.yaxis?.range ?? layout.yaxis?.range),
  };
  const annotations = /** @type {any[]} */ (
    clonePlotlyObject(layout.annotations ?? [])
  );
  layout.annotations = annotations.map((annotation) => ({
    ...annotation,
    font: {
      ...(annotation.font ?? {}),
      color: "rgb(0, 0, 0)",
    },
  }));
  const shapes = /** @type {any[]} */ (clonePlotlyObject(layout.shapes ?? []));
  layout.shapes = shapes.map((shape) => ({
    ...shape,
    line: {
      ...(shape.line ?? {}),
      color: "rgb(0, 0, 0)",
    },
  }));
  return layout;
}


/** @param {any} event */
export function getTraceHoverPoint(event) {
  const points = /** @type {any[]} */ (event?.points ?? []);
  return points.find((point) => {
    const metaNeuronId = point.data?.meta?.neuronId ?? point.fullData?.meta?.neuronId;
    return Number.isFinite(metaNeuronId) || Number.isFinite(point.customdata);
  }) ?? null;
}


/**
 * Plotly/DOM owner for the line-trace panel. Scientific trace construction is
 * delegated to the pure Temporal model; state writes, persistence, ROI
 * mutation, and file saving remain caller-owned effects.
 *
 * @param {{ document: Document, window: Window }} dependencies
 */
export function createTemporalTracePlot({ document, window }) {
  /** @type {null | {
   *   deselectNeuron: (neuronId: number) => unknown,
   *   setHoverNeuronId: (neuronId: number | null) => unknown,
   * }} */
  let effects = null;
  /** @type {number | null} */
  let deselectHideTimer = null;

  function requireEffects() {
    if (!effects) {
      throw new Error("Temporal trace-plot effects were not installed before use.");
    }
    return effects;
  }

  function getPlot() {
    return /** @type {Cm2PlotElement | null} */ (
      document.getElementById("c-trace-plot")
    );
  }

  function clearDeselectHideTimer() {
    if (deselectHideTimer !== null) {
      window.clearTimeout(deselectHideTimer);
      deselectHideTimer = null;
    }
  }

  function getDeselectButton() {
    let button = /** @type {HTMLButtonElement | null} */ (
      document.getElementById("trace-deselect-btn")
    );
    if (button) {
      return button;
    }
    button = document.createElement("button");
    button.id = "trace-deselect-btn";
    button.type = "button";
    button.className = "mini-btn roi-row-delete trace-deselect-btn hidden";
    button.setAttribute("aria-label", "Deselect hovered neuron");
    button.dataset.controlDescription = (
      "Remove this neuron from the active ROI selection"
    );
    button.addEventListener("pointerenter", clearDeselectHideTimer);
    button.addEventListener("pointerleave", () => scheduleDeselectButtonHide());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const neuronId = Number(button.dataset.neuronId);
      requireEffects().deselectNeuron(neuronId);
    });
    document.body.appendChild(button);
    return button;
  }

  /** @param {{ clearHover?: boolean }} [options] */
  function hideDeselectButton({ clearHover = true } = {}) {
    clearDeselectHideTimer();
    const button = document.getElementById("trace-deselect-btn");
    if (button) {
      button.classList.add("hidden");
      delete button.dataset.neuronId;
    }
    if (clearHover) {
      requireEffects().setHoverNeuronId(null);
    }
  }

  function scheduleDeselectButtonHide() {
    clearDeselectHideTimer();
    deselectHideTimer = window.setTimeout(() => {
      const button = document.getElementById("trace-deselect-btn");
      if (button?.matches(":hover")) {
        return;
      }
      hideDeselectButton();
    }, TRACE_DESELECT_HIDE_DELAY_MS);
  }

  /** @param {Cm2PlotElement} plot @param {any} point */
  function showDeselectButton(plot, point) {
    const meta = point.data?.meta ?? point.fullData?.meta ?? {};
    const neuronId = Number.isFinite(meta.neuronId) ? meta.neuronId : Number(point.customdata);
    if (!Number.isFinite(neuronId)) {
      scheduleDeselectButtonHide();
      return;
    }

    const button = getDeselectButton();
    const plotRect = plot.getBoundingClientRect();
    const panelRect = plot.closest(".trace-plot-panel")?.getBoundingClientRect() ?? plotRect;
    const yaxis = point.yaxis ?? plot._fullLayout?.yaxis;
    const baseline = Number.isFinite(meta.baseline) ? meta.baseline : point.y;
    const yPixel = yaxis && typeof yaxis.d2p === "function"
      ? yaxis.d2p(baseline) + (yaxis._offset ?? 0)
      : plotRect.height / 2;
    const y = plotRect.top + yPixel - TRACE_DESELECT_BUTTON_SIZE_PX;
    const rightEdge = Math.min(plotRect.right, panelRect.right) - TRACE_DESELECT_BUTTON_INSET_PX;
    const x = rightEdge - TRACE_DESELECT_BUTTON_SIZE_PX;

    button.dataset.neuronId = String(neuronId);
    button.style.left = `${x}px`;
    button.style.top = `${y}px`;
    button.classList.remove("hidden");
    clearDeselectHideTimer();
    requireEffects().setHoverNeuronId(neuronId);
  }

  /** @param {Cm2PlotElement} plot */
  function attachHoverHandlers(plot) {
    if (plot.dataset.traceHoverHandlersAttached === "true") {
      return false;
    }
    plot.on("plotly_hover", (event) => {
      const point = getTraceHoverPoint(event);
      if (!point) {
        scheduleDeselectButtonHide();
        return;
      }
      showDeselectButton(plot, point);
    });
    plot.on("plotly_unhover", () => {
      scheduleDeselectButtonHide();
    });
    plot.__cm2TraceMouseLeaveHandler = () => scheduleDeselectButtonHide();
    plot.addEventListener("mouseleave", plot.__cm2TraceMouseLeaveHandler);
    plot.dataset.traceHoverHandlersAttached = "true";
    return true;
  }

  /** @param {Cm2PlotElement} plot */
  function detachHoverHandlers(plot) {
    if (typeof plot.removeAllListeners === "function") {
      plot.removeAllListeners("plotly_hover");
      plot.removeAllListeners("plotly_unhover");
    }
    if (plot.__cm2TraceMouseLeaveHandler) {
      plot.removeEventListener("mouseleave", plot.__cm2TraceMouseLeaveHandler);
      delete plot.__cm2TraceMouseLeaveHandler;
    }
    delete plot.dataset.traceHoverHandlersAttached;
  }

  /** @param {Cm2PlotElement} plot @param {boolean} isEmpty @param {any} plotly */
  function setPanelEmpty(plot, isEmpty, plotly) {
    plot.closest(".plot-panel")?.classList.toggle("is-empty", isEmpty);
    if (isEmpty) {
      plotly.purge(plot);
      plot.innerHTML = "";
    }
  }

  /**
   * @param {{
   *   plotly: any,
   *   state: Record<string, any>,
   *   sourceKey: string,
   *   neuronIds: readonly number[],
   *   modelDependencies?: {
   *     pointIndexForNeuronId?: (neuronId: number) => number | null,
   *     getDffDenominator?: (sourceKey: string, neuronId: number) => number,
   *   },
   *   onDownloadEnabled?: (enabled: boolean) => void,
   * }} options
   */
  function render({
    plotly,
    state,
    sourceKey,
    neuronIds,
    modelDependencies = {},
    onDownloadEnabled = () => {},
  }) {
    const plot = getPlot();
    if (!plot) {
      return Promise.resolve(false);
    }
    const descriptor = buildTracePlotData(
      state,
      sourceKey,
      neuronIds,
      modelDependencies,
    );
    const {
      traces,
      shapes,
      annotations,
      height,
      neuronCount,
      frameRange,
      yRange,
    } = descriptor;
    plot.dataset.visibleNeuronCount = String(neuronCount);
    if (traces.length === 0) {
      hideDeselectButton();
      detachHoverHandlers(plot);
      setPanelEmpty(plot, true, plotly);
      onDownloadEnabled(false);
      return Promise.resolve(false);
    }

    setPanelEmpty(plot, false, plotly);
    onDownloadEnabled(true);
    const plotHeight = Math.max(1, Math.ceil(height));
    plot.style.height = `${plotHeight}px`;
    return plotly.react(plot, traces, {
      margin: TRACE_PLOT_MARGIN,
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      xaxis: { visible: false, range: frameRange, fixedrange: true },
      yaxis: { visible: false, range: yRange, fixedrange: true },
      shapes,
      annotations,
      height: plotHeight,
      showlegend: false,
      hovermode: "closest",
      hoverdistance: 18,
      spikedistance: -1,
    }, {
      responsive: true,
      displaylogo: false,
      displayModeBar: false,
    }).then(() => {
      attachHoverHandlers(plot);
      return true;
    });
  }

  /**
   * @param {{
   *   plotly: any,
   *   plot: Cm2PlotElement,
   *   width: number,
   *   height: number,
   *   format: string,
   *   clonePlotlyObject: (value: unknown) => any,
   * }} options
   */
  async function exportImage({
    plotly,
    plot,
    width,
    height,
    format,
    clonePlotlyObject,
  }) {
    const exportDiv = /** @type {Cm2PlotElement} */ (
      /** @type {unknown} */ (document.createElement("div"))
    );
    exportDiv.style.position = "fixed";
    exportDiv.style.left = "-10000px";
    exportDiv.style.top = "0";
    exportDiv.style.width = `${width}px`;
    exportDiv.style.height = `${height}px`;
    exportDiv.style.background = "rgb(255, 255, 255)";
    document.body.appendChild(exportDiv);
    try {
      await plotly.newPlot(
        exportDiv,
        makeTraceExportData(plot, clonePlotlyObject),
        makeTraceExportLayout(plot, width, height, clonePlotlyObject),
        { staticPlot: true, displaylogo: false, displayModeBar: false, responsive: false },
      );
      return await plotly.toImage(exportDiv, { format, width, height });
    } finally {
      plotly.purge(exportDiv);
      exportDiv.remove();
    }
  }

  /**
   * Replaces effect implementations without duplicating DOM/Plotly listeners.
   * @param {{
   *   deselectNeuron: (neuronId: number) => unknown,
   *   setHoverNeuronId: (neuronId: number | null) => unknown,
   * }} nextEffects
   */
  function wire(nextEffects) {
    effects = nextEffects;
    return true;
  }

  return {
    exportImage,
    hideDeselectButton,
    render,
    wire,
  };
}
