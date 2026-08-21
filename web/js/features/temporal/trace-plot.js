import { buildTracePlotData } from "./model.js";
import { wireConfirmedBlankTap } from "../../shared/ui/confirmed-tap.js";


export const TRACE_PLOT_MARGIN = Object.freeze({ l: 0, r: 0, t: 0, b: 0 });
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
   *   onInspectorPinned?: () => unknown,
   * }} */
  let effects = null;
  /** @type {number | null} */
  let deselectHideTimer = null;
  /** @type {number | null} */
  let pinnedNeuronId = null;

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
    const button = /** @type {HTMLButtonElement | null} */ (
      document.getElementById("trace-deselect-btn")
    );
    if (!button) {
      throw new Error("Trace deselect control is missing from the viewer DOM.");
    }
    if (button.dataset.traceActionWired === "true") {
      return button;
    }
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
    button.dataset.traceActionWired = "true";
    return button;
  }

  /** @param {{ clearHover?: boolean }} [options] */
  function hideDeselectButton({ clearHover = true } = {}) {
    clearDeselectHideTimer();
    const existingButton = document.getElementById("trace-deselect-btn");
    const wasVisible = pinnedNeuronId !== null
      || Boolean(existingButton && !existingButton.classList.contains("hidden"));
    pinnedNeuronId = null;
    if (existingButton) {
      existingButton.classList.add("hidden");
      delete existingButton.dataset.neuronId;
      existingButton.style.removeProperty("top");
      existingButton.style.removeProperty("right");
    }
    if (clearHover) {
      requireEffects().setHoverNeuronId(null);
    }
    return wasVisible;
  }

  function scheduleDeselectButtonHide() {
    if (pinnedNeuronId !== null) {
      return;
    }
    clearDeselectHideTimer();
    deselectHideTimer = window.setTimeout(() => {
      const button = document.getElementById("trace-deselect-btn");
      if (button?.matches(":hover")) {
        return;
      }
      hideDeselectButton();
    }, TRACE_DESELECT_HIDE_DELAY_MS);
  }

  /**
   * Place the action so its bottom edge follows the trace baseline and its
   * right edge keeps the shared panel inset. Coarse pointers enlarge the
   * transparent hit target while keeping the visible action on these edges.
   *
   * @param {Cm2PlotElement} plot
   * @param {any} point
   * @param {{ pinned?: boolean }} [options]
   */
  function showDeselectButton(plot, point, { pinned = false } = {}) {
    const meta = point.data?.meta ?? point.fullData?.meta ?? {};
    const neuronId = Number.isFinite(meta.neuronId) ? meta.neuronId : Number(point.customdata);
    if (!Number.isFinite(neuronId)) {
      scheduleDeselectButtonHide();
      return;
    }

    const button = getDeselectButton();
    const plotRect = plot.getBoundingClientRect();
    const panel = plot.closest(".trace-plot-panel");
    const panelRect = panel?.getBoundingClientRect() ?? plotRect;
    const yaxis = point.yaxis ?? plot._fullLayout?.yaxis;
    const baseline = Number.isFinite(meta.baseline) ? meta.baseline : point.y;
    const yPixel = yaxis && typeof yaxis.d2p === "function"
      ? yaxis.d2p(baseline) + (yaxis._offset ?? 0)
      : plotRect.height / 2;

    button.dataset.neuronId = String(neuronId);
    button.setAttribute("aria-label", `Deselect neuron ${neuronId}`);
    button.classList.remove("hidden");
    const buttonRect = button.getBoundingClientRect();
    const rootStyles = window.getComputedStyle(document.documentElement);
    const parsedInset = Number.parseFloat(
      rootStyles.getPropertyValue("--ui-spacing"),
    );
    const inset = Number.isFinite(parsedInset) ? parsedInset : 8;
    const visibleRightEdge = Math.min(plotRect.right, panelRect.right);
    button.style.top = `${plotRect.top - panelRect.top + yPixel - buttonRect.height}px`;
    button.style.right = `${panelRect.right - visibleRightEdge + inset}px`;
    clearDeselectHideTimer();
    pinnedNeuronId = pinned ? neuronId : null;
    if (pinned) {
      requireEffects().onInspectorPinned?.();
    }
    requireEffects().setHoverNeuronId(neuronId);
  }

  /** @param {Cm2PlotElement} plot */
  function attachHoverHandlers(plot) {
    if (plot.dataset.traceHoverHandlersAttached === "true") {
      return false;
    }
    plot.__cm2TraceHoverHandler = (event) => {
      if (pinnedNeuronId !== null) {
        return;
      }
      const point = getTraceHoverPoint(event);
      if (!point) {
        scheduleDeselectButtonHide();
        return;
      }
      showDeselectButton(plot, point);
    };
    plot.__cm2TraceUnhoverHandler = () => {
      scheduleDeselectButtonHide();
    };
    plot.__cm2TraceClickHandler = (event) => {
      plot.__cm2TraceTapSession?.claim();
      const point = getTraceHoverPoint(event);
      if (!point) {
        hideDeselectButton();
        return;
      }
      const pointerType = plot.__cm2TraceActivationPointerType;
      delete plot.__cm2TraceActivationPointerType;
      showDeselectButton(plot, point, {
        pinned: pointerType === "touch" || pointerType === "pen",
      });
    };
    plot.__cm2TracePointerDownHandler = (event) => {
      plot.__cm2TraceActivationPointerType = event.pointerType;
    };
    plot.__cm2TracePointerCancelHandler = () => {
      delete plot.__cm2TraceActivationPointerType;
    };
    plot.on("plotly_hover", plot.__cm2TraceHoverHandler);
    plot.on("plotly_unhover", plot.__cm2TraceUnhoverHandler);
    plot.on("plotly_click", plot.__cm2TraceClickHandler);
    plot.__cm2TraceMouseLeaveHandler = () => scheduleDeselectButtonHide();
    plot.__cm2TraceTapSession = wireConfirmedBlankTap({
      element: plot,
      onBlankTap: () => {
        if (pinnedNeuronId !== null) {
          hideDeselectButton();
        }
      },
    });
    plot.addEventListener("pointerdown", plot.__cm2TracePointerDownHandler, true);
    plot.addEventListener("pointercancel", plot.__cm2TracePointerCancelHandler, true);
    plot.addEventListener("mouseleave", plot.__cm2TraceMouseLeaveHandler);
    plot.tabIndex = 0;
    plot.setAttribute(
      "aria-label",
      "Temporal traces; hover with a mouse, or tap with touch or pen, to show the deselect action",
    );
    plot.dataset.traceHoverHandlersAttached = "true";
    return true;
  }

  /** @param {Cm2PlotElement} plot */
  function detachHoverHandlers(plot) {
    if (typeof plot.removeListener === "function") {
      if (plot.__cm2TraceHoverHandler) {
        plot.removeListener("plotly_hover", plot.__cm2TraceHoverHandler);
      }
      if (plot.__cm2TraceUnhoverHandler) {
        plot.removeListener("plotly_unhover", plot.__cm2TraceUnhoverHandler);
      }
      if (plot.__cm2TraceClickHandler) {
        plot.removeListener("plotly_click", plot.__cm2TraceClickHandler);
      }
    }
    if (plot.__cm2TraceMouseLeaveHandler) {
      plot.removeEventListener("mouseleave", plot.__cm2TraceMouseLeaveHandler);
      delete plot.__cm2TraceMouseLeaveHandler;
    }
    if (plot.__cm2TracePointerDownHandler) {
      plot.removeEventListener("pointerdown", plot.__cm2TracePointerDownHandler, true);
      delete plot.__cm2TracePointerDownHandler;
    }
    if (plot.__cm2TracePointerCancelHandler) {
      plot.removeEventListener("pointercancel", plot.__cm2TracePointerCancelHandler, true);
      delete plot.__cm2TracePointerCancelHandler;
    }
    delete plot.__cm2TraceActivationPointerType;
    plot.__cm2TraceTapSession?.destroy();
    delete plot.__cm2TraceTapSession;
    delete plot.__cm2TraceHoverHandler;
    delete plot.__cm2TraceUnhoverHandler;
    delete plot.__cm2TraceClickHandler;
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

    if (pinnedNeuronId !== null && !neuronIds.includes(pinnedNeuronId)) {
      hideDeselectButton();
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
      dragmode: false,
      showlegend: false,
      hovermode: "closest",
      hoverdistance: 18,
      spikedistance: -1,
    }, {
      responsive: false,
      displaylogo: false,
      displayModeBar: false,
      doubleClick: false,
      scrollZoom: false,
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
   *   onInspectorPinned?: () => unknown,
   * }} nextEffects
   */
  function wire(nextEffects) {
    effects = nextEffects;
    return true;
  }

  return {
    dismissPinnedInspector() {
      if (pinnedNeuronId === null) {
        return false;
      }
      return hideDeselectButton();
    },
    exportImage,
    hasPinnedInspector() {
      return pinnedNeuronId !== null;
    },
    hideDeselectButton,
    render,
    wire,
  };
}
