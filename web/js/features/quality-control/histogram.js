import {
  blueprintColorForValue,
  buildHistogram,
  formatMetricValue,
} from "./model.js";


export const QC_EXPORT_COLORSCALE = [
  [0, "rgb(202, 0, 32)"],
  [0.5, "rgb(247, 247, 247)"],
  [1, "rgb(5, 113, 176)"],
];


/**
 * Keep the visible first and last x-axis tick labels identical to the shared
 * Histogram/Color Map/Threshold domain. Interior ticks are chosen from the
 * same discrete slider stops so labels never imply a different coordinate
 * system.
 *
 * @param {{ min: number, max: number, step: number, stopCount?: number }} domain
 * @param {number} [targetTickCount]
 */
export function buildQcAxisTicks(domain, targetTickCount = 5) {
  const fallbackStopCount = Math.max(
    1,
    Math.round((domain.max - domain.min) / domain.step),
  );
  const stopCount = Number.isInteger(domain.stopCount) && domain.stopCount >= 1
    ? domain.stopCount
    : fallbackStopCount;
  const intervalCount = Math.max(
    1,
    Math.min(stopCount, Math.floor(targetTickCount) - 1),
  );
  const indices = [...new Set(Array.from(
    { length: intervalCount + 1 },
    (_, index) => Math.round(index * stopCount / intervalCount),
  ))];
  const values = indices.map((index) => Number(
    (domain.min + index * domain.step).toPrecision(12),
  ));
  values[0] = domain.min;
  values[values.length - 1] = domain.max;
  return {
    values,
    labels: values.map((value) => formatMetricValue(value, domain.step)),
  };
}


/**
 * @param {Cm2PlotElement} plot
 * @param {(value: unknown) => any} clonePlotlyObject
 */
export function buildQcExportData(plot, clonePlotlyObject) {
  const data = clonePlotlyObject(plot.data ?? []);
  const stripX = Array.from({ length: 128 }, (_, index) => index / 127);
  data.push({
    type: "heatmap",
    x: stripX,
    y: [0],
    z: [stripX],
    xaxis: "x2",
    yaxis: "y2",
    zmin: 0,
    zmax: 1,
    colorscale: QC_EXPORT_COLORSCALE,
    showscale: false,
    hoverinfo: "skip",
  });
  return data;
}


/**
 * @param {Cm2PlotElement} plot
 * @param {number} width
 * @param {number} height
 * @param {{ lower?: string, upper?: string }} rangeLabels
 * @param {(value: unknown) => any} clonePlotlyObject
 */
export function buildQcExportLayout(
  plot,
  width,
  height,
  rangeLabels,
  clonePlotlyObject,
) {
  const layout = clonePlotlyObject(plot.layout ?? {});
  const labels = {
    lower: rangeLabels?.lower?.trim() || "Min",
    upper: rangeLabels?.upper?.trim() || "Max",
  };
  layout.width = width;
  layout.height = height;
  layout.margin = { l: 40, r: 18, t: 18, b: 52 };
  layout.paper_bgcolor = "rgb(255, 255, 255)";
  layout.plot_bgcolor = "rgb(255, 255, 255)";
  layout.font = {
    ...(layout.font ?? {}),
    color: "rgb(32, 30, 27)",
  };
  layout.xaxis = {
    ...(layout.xaxis ?? {}),
    domain: [0, 1],
    anchor: "y",
    color: "rgb(32, 30, 27)",
    title: { text: "" },
    gridcolor: "rgba(32, 30, 27, 0.12)",
    range: clonePlotlyObject(plot._fullLayout?.xaxis?.range ?? layout.xaxis?.range),
  };
  layout.yaxis = {
    ...(layout.yaxis ?? {}),
    domain: [0.24, 1],
    anchor: "x",
    color: "rgb(32, 30, 27)",
    gridcolor: "rgba(32, 30, 27, 0.12)",
  };
  layout.xaxis2 = {
    domain: [0, 1],
    anchor: "y2",
    range: [0, 1],
    fixedrange: true,
    showgrid: false,
    zeroline: false,
    ticks: "outside",
    tickmode: "array",
    tickvals: [0, 1],
    ticktext: [labels.lower, labels.upper],
    tickfont: { color: "rgb(32, 30, 27)", size: 11 },
  };
  layout.yaxis2 = {
    domain: [0.04, 0.095],
    anchor: "x2",
    fixedrange: true,
    visible: false,
  };
  layout.shapes = [];
  layout.annotations = [];
  return layout;
}


/**
 * Plotly-only owner for the existing QC histogram and offscreen image-render
 * contract. State, persistence, browser file saving, and other feature renders
 * remain caller-owned.
 *
 * @param {{
 *   document: Document,
 *   renderScheduler: { scheduleDoubleFrame: (callback: () => void) => void },
 * }} options
 */
export function createQualityControlHistogram({ document, renderScheduler }) {
  function getPlot() {
    return /** @type {Cm2PlotElement | null} */ (
      document.getElementById("blueprint-stats-plot")
    );
  }

  /** @param {HTMLElement} plot */
  function getPlotInsets(plot) {
    const card = plot.closest(".qc-card");
    const view = document.defaultView;
    if (!card || !view) {
      return { left: 0, right: 0 };
    }
    const style = view.getComputedStyle(card);
    const left = Number.parseFloat(style.getPropertyValue("--qc-plot-left-inset"));
    const right = Number.parseFloat(style.getPropertyValue("--qc-plot-right-inset"));
    return {
      left: Number.isFinite(left) ? left : 0,
      right: Number.isFinite(right) ? right : 0,
    };
  }

  /**
   * @param {{
   *   plotly: any,
   *   onDownloadEnabled?: (enabled: boolean) => void,
   * }} options
   */
  function clear({ plotly, onDownloadEnabled = () => {} }) {
    const plot = getPlot();
    if (!plot) {
      return false;
    }
    plot.classList.add("hidden");
    onDownloadEnabled(false);
    plotly.purge(plot);
    return true;
  }

  /**
   * @param {{
   *   plotly: any,
   *   spec: { key: string, label: string } | null,
   *   values: number[],
   *   extent: { min: number, max: number, span: number },
   *   domain?: {
   *     min: number, max: number, span: number, step: number,
   *   },
   *   histogramData?: {
   *     centers: number[], counts: number[], widths: number[], binWidth: number,
   *     hoverLabels: string[],
   *     viewMin: number, viewMax: number, domain: Record<string, any>,
   *   } | null,
   *   colorRange: { lower: number, upper: number },
   *   resolveReflowRange?: () => { viewMin: number, viewMax: number } | null,
   *   onDownloadEnabled?: (enabled: boolean) => void,
   * }} options
   */
  function render({
    plotly,
    spec,
    values,
    extent,
    domain = null,
    histogramData = null,
    colorRange,
    resolveReflowRange = null,
    onDownloadEnabled = () => {},
  }) {
    const plot = getPlot();
    if (!plot || !spec) {
      clear({ plotly, onDownloadEnabled });
      return Promise.resolve(false);
    }
    const histogram = histogramData ?? buildHistogram(values, domain ?? extent);
    if (!histogram) {
      clear({ plotly, onDownloadEnabled });
      return Promise.resolve(false);
    }
    const getReflowRange = resolveReflowRange ?? (() => ({
      viewMin: histogram.viewMin,
      viewMax: histogram.viewMax,
    }));

    const maxY = Math.max(...histogram.counts, 1e-12);
    const colorMin = colorRange.lower;
    const colorMax = colorRange.upper;
    const xTicks = buildQcAxisTicks(histogram.domain);
    const plotInsets = getPlotInsets(plot);

    const barColors = histogram.centers.map(
      (value) => blueprintColorForValue(value, colorMin, colorMax),
    );
    const barWidths = histogram.widths.map((width) => width * 0.94);
    const customdata = histogram.hoverLabels.map((label, index) => [
      label,
      histogram.counts[index],
    ]);
    plot.classList.remove("hidden");
    return plotly.react(
      plot,
      [
        {
          type: "bar",
          x: histogram.centers,
          y: histogram.counts,
          width: barWidths,
          customdata,
          marker: {
            color: barColors,
            line: {
              color: "rgba(20,18,16,0.34)",
              width: 0.4,
            },
          },
          hovertemplate: `%{customdata[0]}<br>neurons=%{customdata[1]:.0f}<extra></extra>`,
        },
      ],
      {
        margin: { l: plotInsets.left, r: plotInsets.right, t: 4, b: 30 },
        height: 130,
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        barmode: "overlay",
        showlegend: false,
        shapes: [],
        xaxis: {
          title: { text: "" },
          color: "#f7f1e7",
          showgrid: false,
          fixedrange: true,
          zeroline: false,
          range: [histogram.viewMin, histogram.viewMax],
          tickmode: "array",
          tickvals: xTicks.values,
          ticktext: xTicks.labels,
          ticklabeloverflow: "allow",
        },
        yaxis: {
          title: { text: "" },
          color: "#f7f1e7",
          gridcolor: "rgba(255,245,228,0.12)",
          fixedrange: true,
          showticklabels: false,
          ticks: "",
          zeroline: false,
          rangemode: "tozero",
          range: [0, maxY * 1.08],
        },
      },
      {
        responsive: true,
        displaylogo: false,
        displayModeBar: false,
        doubleClick: false,
        scrollZoom: false,
        staticPlot: false,
      },
    ).then(() => {
      onDownloadEnabled(true);
      renderScheduler.scheduleDoubleFrame(() => {
        if (!plot.isConnected || plot.offsetWidth <= 0 || plot.offsetHeight <= 0) {
          return;
        }
        const reflowRange = getReflowRange();
        if (!reflowRange) {
          return;
        }
        try {
          Promise.resolve(plotly.Plots.resize(plot)).then(() => {
            plotly.relayout(plot, {
              "xaxis.autorange": false,
              "xaxis.range": [reflowRange.viewMin, reflowRange.viewMax],
              "yaxis.autorange": false,
            });
          });
        } catch (error) {
          console.warn(error);
        }
      });
      return true;
    });
  }

  /**
   * @param {{
   *   plotly: any,
   *   plot: Cm2PlotElement,
   *   format: string,
   *   clonePlotlyObject: (value: unknown) => any,
   *   getPlotExportSize: (plot: Cm2PlotElement) => { width: number, height: number },
   *   rangeLabels: { lower?: string, upper?: string },
   * }} options
   */
  async function exportImage({
    plotly,
    plot,
    format,
    clonePlotlyObject,
    getPlotExportSize,
    rangeLabels,
  }) {
    const currentSize = getPlotExportSize(plot);
    const width = Math.max(520, currentSize.width);
    const height = Math.max(360, currentSize.height + 90);
    const exportDiv = document.createElement("div");
    exportDiv.style.position = "fixed";
    exportDiv.style.left = "-10000px";
    exportDiv.style.top = "0";
    exportDiv.style.width = `${width}px`;
    exportDiv.style.height = `${height}px`;
    document.body.appendChild(exportDiv);
    try {
      await plotly.newPlot(
        exportDiv,
        buildQcExportData(plot, clonePlotlyObject),
        buildQcExportLayout(plot, width, height, rangeLabels, clonePlotlyObject),
        { staticPlot: true, displaylogo: false, displayModeBar: false, responsive: false },
      );
      return await plotly.toImage(exportDiv, { format, width, height });
    } finally {
      plotly.purge(exportDiv);
      exportDiv.remove();
    }
  }

  return {
    getPlot,
    clear,
    render,
    exportImage,
  };
}
