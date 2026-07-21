function buildMapMarkerStyle(pointIndices) {
  const fill = [];
  const line = [];
  const size = [];
  const lineWidth = [];
  const blueprintSpec = getRenderedBlueprintSpec();
  const blueprintValues = blueprintSpec ? buildBlueprintMetricValues(blueprintSpec) : null;

  for (const pointIndex of pointIndices) {
    const neuronId = state.points.id[pointIndex];
    const roiId = findAssignedRoiId(neuronId);
    const assignedRoi = roiId ? getRoiById(roiId) : null;
    const showRoiStyle = state.traceHoverNeuronId === null || state.traceHoverNeuronId === neuronId;
    const roi = showRoiStyle && assignedRoi && pointIndexInRoiBox(pointIndex, assignedRoi) ? assignedRoi : null;
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

  const { values, stats } = blueprintValues;
  const colorRange = getBlueprintColorRange(blueprintSpec.key);
  const colorMin = stats.mean + colorRange.lowerZ * stats.std;
  const colorMax = stats.mean + colorRange.upperZ * stats.std;
  return {
    color: pointIndices.map((index) => values[index]),
    lineColor: line,
    lineWidth,
    size,
    showscale: false,
    colorscale: BLUEPRINT_COLOR_SCALE,
    reversescale: true,
    cmin: colorMin,
    cmax: colorMax,
  };
}

function buildRoiBoxShapes() {
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

const ROI_BOX_BORDER_CLICK_TOLERANCE_PX = 8;

function axisDataToPlotPixel(axis, value) {
  if (!axis || typeof axis.d2p !== "function") {
    return null;
  }
  const pixel = axis.d2p(value);
  return Number.isFinite(pixel) ? pixel + (axis._offset ?? 0) : null;
}

function findRoiBoxBorderHit(event) {
  const plotDiv = document.getElementById("map-plot");
  const xaxis = plotDiv?._fullLayout?.xaxis;
  const yaxis = plotDiv?._fullLayout?.yaxis;
  if (!plotDiv || !xaxis || !yaxis) {
    return null;
  }

  const rect = plotDiv.getBoundingClientRect();
  const eventX = event.clientX - rect.left;
  const eventY = event.clientY - rect.top;
  let bestHit = null;

  for (const roi of state.rois) {
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
    const tolerance = ROI_BOX_BORDER_CLICK_TOLERANCE_PX;
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
      Math.abs(eventY - bottom)
    );
    if (distance <= tolerance && (!bestHit || distance < bestHit.distance)) {
      bestHit = { roiId: roi.id, distance };
    }
  }

  return bestHit?.roiId ?? null;
}

function handleRoiBoxBorderClick(event) {
  if (
    state.regionDraft.active
    || event.target?.closest?.(".modebar")
    || event.target?.closest?.(".overlay-stack")
  ) {
    return;
  }
  const roiId = findRoiBoxBorderHit(event);
  if (!roiId) {
    return;
  }
  setActiveRoi(roiId);
  event.preventDefault();
  event.stopPropagation();
}

function buildRegionTraces() {
  const traces = [];
  const preview = getRegionPreview();
  const committedPolygons = getCommittedRegionPolygons();
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
        color: REGION_LINE_COLOR,
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
    const endpointColors = draftPoints.length > 1 ? ["#f7f1e7", REGION_DRAFT_COLOR] : [REGION_DRAFT_COLOR];
    const endpointSizes = draftPoints.length > 1 ? [9, 13] : [13];
    const endpointSymbols = draftPoints.length > 1 ? ["circle-open", "circle"] : ["circle"];
    traces.push({
      type: "scatter",
      mode: state.regionDraft.points.length > 1 ? "lines+markers" : "markers",
      x: draftPoints.map((point) => point.x),
      y: draftPoints.map((point) => point.y),
      line: { color: REGION_DRAFT_COLOR, width: 2, dash: "dot" },
      marker: {
        color: "#f7f1e7",
        line: { color: REGION_DRAFT_COLOR, width: 1.5 },
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

function buildMapLayout() {
  const background = getActiveBackground();
  const { xRange, yRange } = state.mapViewRange ?? computeMapCoverRanges();
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
    height: computeMapHeight(),
    autosize: true,
    xaxis: { range: xRange, showgrid: false, zeroline: false, showticklabels: false, fixedrange: false },
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
    shapes: buildRoiBoxShapes(),
    uirevision: "map-persist",
  };
}

function renderMap() {
  const pointIndices = getVisiblePointIndices();
  const markerStyle = buildMapMarkerStyle(pointIndices);
  const trace = {
    type: "scattergl",
    mode: "markers",
    x: pointIndices.map((idx) => state.points.x[idx]),
    y: pointIndices.map((idx) => state.points.y[idx]),
    text: pointIndices.map((idx) => buildNeuronHoverText(idx)),
    customdata: pointIndices.map((idx) => state.points.id[idx]),
    hovertemplate: "%{text}<extra></extra>",
    marker: {
      color: markerStyle.color,
      colorscale: markerStyle.colorscale,
      cmin: markerStyle.cmin,
      cmax: markerStyle.cmax,
      cmid: markerStyle.cmid,
      showscale: markerStyle.showscale,
      reversescale: markerStyle.reversescale,
      size: markerStyle.size,
      line: { color: markerStyle.lineColor, width: markerStyle.lineWidth },
      opacity: 1,
    },
  };
  const plotDiv = document.getElementById("map-plot");
  rememberCurrentMapViewRange();
  plotDiv.dataset.visibleNeuronCount = String(pointIndices.length);
  state.mapViewportKey = `${window.innerWidth}x${window.innerHeight}`;
  Plotly.react(plotDiv, [trace, ...buildRegionTraces()], buildMapLayout(), {
    responsive: true,
    displayModeBar: true,
    modeBarButtonsToRemove: ["select2d", "lasso2d"],
    displaylogo: false,
    scrollZoom: true,
  }).then(() => {
    if (!state.mapPlotReady) {
      plotDiv.on("plotly_relayout", () => {
        requestAnimationFrame(rememberCurrentMapViewRange);
      });
      plotDiv.addEventListener("click", handleRoiBoxBorderClick, true);
      plotDiv.on("plotly_click", (event) => {
        if (state.regionDraft.active) {
          return;
        }
        const neuronId = event?.points?.[0]?.customdata;
        if (typeof neuronId === "number" && neuronIdVisibleOnMap(neuronId)) {
          handleNeuronToggle(neuronId);
        }
      });
      state.mapPlotReady = true;
    }
  });
}

function mapEventToDataPoint(event) {
  const plotDiv = document.getElementById("map-plot");
  const layout = plotDiv?._fullLayout;
  const xaxis = layout?.xaxis;
  const yaxis = layout?.yaxis;
  if (!plotDiv || !xaxis || !yaxis || typeof xaxis.p2d !== "function" || typeof yaxis.p2d !== "function") {
    return null;
  }
  const rect = plotDiv.getBoundingClientRect();
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
    x: clamp(xaxis.p2d(xPixel), 0, Number(state.meta.full_width)),
    y: clamp(yaxis.p2d(yPixel), 0, Number(state.meta.full_height)),
  };
}
