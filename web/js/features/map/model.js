export const UNASSIGNED_POINT_COLOR = "rgba(248,248,248,0.62)";
export const UNASSIGNED_LINE_COLOR = "rgba(32,27,22,0.28)";


/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


/** @param {number} value @param {number} [digits] */
export function quantizedFloat(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "nan";
}


/**
 * Build the compact two-column metadata shown below a Map-hover trace.
 * Precision, units, and `nan` spelling remain aligned with the metric panels.
 *
 * @param {Record<string, any>} state
 * @param {number} pointIndex
 */
export function buildNeuronPreviewMetadata(state, pointIndex) {
  const points = state.points;
  const metrics = points.metrics;
  return {
    title: `Neuron ${points.id[pointIndex]}`,
    columns: [
      [
        { label: "r_value", value: quantizedFloat(metrics.r_value?.[pointIndex]) },
        { label: "SNR", value: quantizedFloat(metrics.snr?.[pointIndex]) },
        { label: "bl", value: quantizedFloat(metrics.bl?.[pointIndex]) },
        { label: "lambda", value: quantizedFloat(metrics.lam?.[pointIndex]) },
        {
          label: "neurons_sn",
          value: quantizedFloat(metrics.neurons_sn?.[pointIndex]),
        },
      ],
      [
        { label: "g_0", value: quantizedFloat(metrics.g_0?.[pointIndex]) },
        { label: "g_1", value: quantizedFloat(metrics.g_1?.[pointIndex]) },
        {
          label: "t_peak",
          value: `${quantizedFloat(metrics.t_peak?.[pointIndex], 1)} ms`,
        },
        {
          label: "t_half",
          value: `${quantizedFloat(metrics.t_half?.[pointIndex], 1)} ms`,
        },
      ],
    ],
  };
}


/**
 * Select points rendered by Map. A raw Region preview deliberately bypasses
 * metric filters, while every other display scope applies cumulative QC.
 * This display rule is intentionally distinct from click eligibility below.
 *
 * @param {Record<string, any>} state
 * @param {{
 *   activeFilters: () => any,
 *   activeDisplayScope: () => { countMode: string },
 *   pointPassesDisplayScope: (pointIndex: number, scope: any) => boolean,
 *   pointPassesMetricFilters: (pointIndex: number, filters: any) => boolean,
 * }} ports
 */
export function selectVisiblePointIndices(state, ports) {
  const filters = ports.activeFilters();
  const scope = ports.activeDisplayScope();
  const usesMetricFilters = scope.countMode !== "raw";
  return state.points.id
    .map((_, index) => index)
    .filter((pointIndex) => (
      ports.pointPassesDisplayScope(pointIndex, scope)
      && (
        !usesMetricFilters
        || ports.pointPassesMetricFilters(pointIndex, filters)
      )
    ));
}


/**
 * Preserve Map neuron-click eligibility: committed Region membership and
 * cumulative metric QC always apply, even while a raw Region preview expands
 * the points currently rendered on the Map.
 *
 * @param {Record<string, any>} state
 * @param {number} neuronId
 * @param {{
 *   activeFilters: () => any,
 *   pointPasses: (pointIndex: number) => boolean,
 *   pointPassesMetricFilters: (pointIndex: number, filters: any) => boolean,
 *   pointIndexForNeuronId?: (neuronId: number) => number | null | undefined,
 * }} ports
 * @param {any} [filters]
 */
export function isNeuronVisibleOnMap(
  state,
  neuronId,
  ports,
  filters = ports.activeFilters(),
) {
  const pointIndex = ports.pointIndexForNeuronId
    ? (ports.pointIndexForNeuronId(neuronId) ?? null)
    : (state.pointIndexByNeuronId.get(neuronId) ?? null);
  return (
    pointIndex !== null
    && ports.pointPasses(pointIndex)
    && ports.pointPassesMetricFilters(pointIndex, filters)
  );
}


/**
 * Metric values and color bounds enter Map in raw cache units.
 *
 * @param {Record<string, any>} state
 * @param {number[]} pointIndices
 * @param {{
 *   renderedSpec: () => { key: string } | null,
 *   buildMetricValues: (spec: any) => { values: number[] },
 *   colorRange: (metricKey: string) => { lower: number, upper: number },
 *   colorScale: any,
 *   findAssignedRoiId: (neuronId: number) => string | null,
 *   getById: (roiId: string) => any,
 *   pointIndexInBox: (pointIndex: number, roi: any) => boolean,
 * }} ports
 */
export function buildMapMarkerStyle(state, pointIndices, ports) {
  const fill = [];
  const line = [];
  const size = [];
  const lineWidth = [];
  const blueprintSpec = ports.renderedSpec();
  const blueprintValues = blueprintSpec
    ? ports.buildMetricValues(blueprintSpec)
    : null;

  for (const pointIndex of pointIndices) {
    const neuronId = state.points.id[pointIndex];
    const roiId = ports.findAssignedRoiId(neuronId);
    const assignedRoi = roiId ? ports.getById(roiId) : null;
    const showRoiStyle = (
      state.traceHoverNeuronId === null
      || state.traceHoverNeuronId === neuronId
    );
    const roi = (
      showRoiStyle
      && assignedRoi
      && ports.pointIndexInBox(pointIndex, assignedRoi)
    ) ? assignedRoi : null;
    if (!blueprintSpec) {
      fill.push(roi ? roi.color : UNASSIGNED_POINT_COLOR);
      line.push(roi ? "rgba(20,16,12,0.75)" : UNASSIGNED_LINE_COLOR);
      size.push(roi ? 9 : 6);
      lineWidth.push(0.8);
    } else {
      line.push(roi ? roi.color : "rgba(255,255,255,0.32)");
      size.push(roi ? 9 : 6);
      lineWidth.push(roi ? 2.4 : 0.5);
    }
  }

  if (!blueprintSpec) {
    return {
      color: fill,
      lineColor: line,
      lineWidth,
      size,
      showscale: false,
    };
  }

  const { values } = blueprintValues;
  const colorRange = ports.colorRange(blueprintSpec.key);
  return {
    color: pointIndices.map((pointIndex) => values[pointIndex]),
    lineColor: line,
    lineWidth,
    size,
    showscale: false,
    colorscale: ports.colorScale,
    reversescale: true,
    cmin: colorRange.lower,
    cmax: colorRange.upper,
  };
}


/** @param {Record<string, any>} state */
export function buildRoiBoxShapes(state) {
  return state.rois
    .filter((roi) => roi.box)
    .map((roi) => ({
      type: "rect",
      xref: "x",
      yref: "y",
      x0: roi.box.x,
      x1: roi.box.x + roi.box.width,
      y0: roi.box.y,
      y1: roi.box.y + roi.box.height,
      fillcolor: "rgba(0,0,0,0)",
      line: {
        color: roi.color,
        width: roi.id === state.activeRoiId ? 3 : 2,
      },
      layer: "above",
    }));
}


/**
 * @param {{ full_width: unknown, full_height: unknown }} meta
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 */
export function computeMapCoverRanges(meta, viewportWidth, viewportHeight) {
  const fullWidth = Number(meta.full_width);
  const fullHeight = Number(meta.full_height);
  const safeViewportWidth = Math.max(viewportWidth, 1);
  const safeViewportHeight = Math.max(viewportHeight, 1);
  const viewportAspect = safeViewportWidth / safeViewportHeight;
  const imageAspect = fullWidth / fullHeight;

  let viewWidth;
  let viewHeight;
  if (viewportAspect >= imageAspect) {
    viewWidth = fullWidth;
    viewHeight = fullWidth / viewportAspect;
  } else {
    viewHeight = fullHeight;
    viewWidth = fullHeight * viewportAspect;
  }

  const centerX = fullWidth / 2;
  const centerY = fullHeight / 2;
  return {
    xRange: [centerX - viewWidth / 2, centerX + viewWidth / 2],
    yRange: [centerY + viewHeight / 2, centerY - viewHeight / 2],
  };
}


/** @param {unknown} range */
export function normalizeAxisRange(range) {
  if (!Array.isArray(range) || range.length < 2) {
    return null;
  }
  const start = Number(range[0]);
  const end = Number(range[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
    return null;
  }
  return [start, end];
}


/** @param {Cm2PlotElement | null | undefined} plot */
export function selectCurrentMapViewRange(plot) {
  const xRange = normalizeAxisRange(plot?._fullLayout?.xaxis?.range);
  const yRange = normalizeAxisRange(plot?._fullLayout?.yaxis?.range);
  if (!xRange || !yRange) {
    return null;
  }
  return { xRange, yRange };
}


/**
 * @param {Record<string, any>} state
 * @param {number[]} pointIndices
 * @param {Record<string, any>} markerStyle
 */
export function buildMapPointTrace(state, pointIndices, markerStyle) {
  return {
    type: "scattergl",
    mode: "markers",
    x: pointIndices.map((pointIndex) => state.points.x[pointIndex]),
    y: pointIndices.map((pointIndex) => state.points.y[pointIndex]),
    customdata: pointIndices.map((pointIndex) => state.points.id[pointIndex]),
    // `none` suppresses Plotly's native label without suppressing the hover
    // event used by the custom analytical preview.
    hoverinfo: "none",
    marker: {
      color: markerStyle.color,
      colorscale: markerStyle.colorscale,
      cmin: markerStyle.cmin,
      cmax: markerStyle.cmax,
      cmid: markerStyle.cmid,
      showscale: markerStyle.showscale,
      reversescale: markerStyle.reversescale,
      size: markerStyle.size,
      line: {
        color: markerStyle.lineColor,
        width: markerStyle.lineWidth,
      },
      opacity: 1,
    },
  };
}


/**
 * @param {Record<string, any>} state
 * @param {{
 *   background: { file: string } | null,
 *   viewportWidth: number,
 *   viewportHeight: number,
 * }} options
 */
export function buildMapLayout(
  state,
  { background, viewportWidth, viewportHeight },
) {
  const { xRange, yRange } = state.mapViewRange ?? computeMapCoverRanges(
    state.meta,
    viewportWidth,
    viewportHeight,
  );
  const images = background ? [{
    source: `/cache/${background.file}`,
    xref: "x",
    yref: "y",
    x: 0,
    y: state.meta.full_height,
    sizex: state.meta.full_width,
    sizey: state.meta.full_height,
    sizing: "stretch",
    yanchor: "bottom",
    layer: "below",
    opacity: 1,
  }] : [];
  return {
    margin: { l: 0, r: 0, t: 0, b: 0 },
    height: viewportHeight,
    autosize: true,
    xaxis: {
      range: xRange,
      showgrid: false,
      zeroline: false,
      showticklabels: false,
      fixedrange: false,
    },
    yaxis: {
      range: yRange,
      showgrid: false,
      zeroline: false,
      showticklabels: false,
      fixedrange: false,
      scaleanchor: "x",
      scaleratio: 1,
    },
    images,
    paper_bgcolor: "#000",
    plot_bgcolor: "#000",
    dragmode: "pan",
    hovermode: "closest",
    showlegend: false,
    shapes: buildRoiBoxShapes(state),
    uirevision: "map-persist",
  };
}
