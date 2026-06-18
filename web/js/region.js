function normalizeRegionPoint(point) {
  if (Array.isArray(point) && point.length >= 2) {
    const x = Number(point[0]);
    const y = Number(point[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  if (point && typeof point === "object") {
    const x = Number(point.x);
    const y = Number(point.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }
  return null;
}

function normalizeRegionPolygon(points) {
  if (!Array.isArray(points)) {
    return [];
  }
  const normalized = points
    .map((point) => normalizeRegionPoint(point))
    .filter((point) => point !== null);
  return normalized.length >= 3 ? normalized : [];
}

function normalizeRegionPolygons(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length > 0 && normalizeRegionPoint(value[0]) !== null) {
    const legacyPolygon = normalizeRegionPolygon(value);
    return legacyPolygon.length ? [legacyPolygon] : [];
  }
  return value
    .map((polygon) => normalizeRegionPolygon(polygon))
    .filter((polygon) => polygon.length >= 3);
}

function getCommittedRegionPolygons() {
  return normalizeRegionPolygons(state.regionPolygons);
}

function getCommittedRegionCount() {
  return getCommittedRegionPolygons().length;
}

function getDisplayedRegionPolygons() {
  return getCommittedRegionPolygons();
}

function normalizeRegionCountMode(countMode) {
  return countMode === "raw" ? "raw" : "qc";
}

function normalizeRegionPreview(preview) {
  if (state.regionDraft.active || !preview || typeof preview !== "object") {
    return null;
  }
  const countMode = normalizeRegionCountMode(preview.countMode);
  if (preview.type === "full-fov") {
    return { type: "full-fov", countMode };
  }
  if (preview.type === "region-all") {
    return getCommittedRegionCount() >= 2
      ? { type: "region-all", countMode }
      : null;
  }
  if (preview.type === "region") {
    const index = Number(preview.index);
    return Number.isInteger(index) && getCommittedRegionPolygons()[index]
      ? { type: "region", index, countMode }
      : null;
  }
  return null;
}

function getRegionPreview() {
  return normalizeRegionPreview(state.regionPreview);
}

function getRegionPreviewKey(preview) {
  if (!preview) {
    return null;
  }
  if (preview.type === "region") {
    return `region-${preview.index}`;
  }
  return preview.type;
}

function sameRegionPreview(a, b) {
  return (
    getRegionPreviewKey(a) === getRegionPreviewKey(b)
    && normalizeRegionCountMode(a?.countMode) === normalizeRegionCountMode(b?.countMode)
  );
}

function sameRegionPreviewScope(a, b) {
  return getRegionPreviewKey(a) === getRegionPreviewKey(b);
}

function pointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const cross = (px - ax) * dy - (py - ay) * dx;
  const scale = Math.max(Math.abs(dx), Math.abs(dy), 1);
  if (Math.abs(cross) > 1e-6 * scale) {
    return false;
  }
  const dot = (px - ax) * dx + (py - ay) * dy;
  if (dot < -1e-6) {
    return false;
  }
  const lenSq = dx * dx + dy * dy;
  return dot <= lenSq + 1e-6;
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (pointOnSegment(x, y, a.x, a.y, b.x, b.y)) {
      return true;
    }
    const crosses = (a.y > y) !== (b.y > y);
    if (crosses) {
      const xIntersect = ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
      if (x < xIntersect) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function pointIndexPassesRegion(pointIndex) {
  if (state.regionDraft.active) {
    return true;
  }
  const polygons = getCommittedRegionPolygons();
  if (!polygons.length) {
    return true;
  }
  const x = state.points.x[pointIndex];
  const y = state.points.y[pointIndex];
  return polygons.some((polygon) => pointInPolygon(x, y, polygon));
}

function pointIndexPassesRegionPolygons(pointIndex, polygons) {
  if (!polygons.length) {
    return true;
  }
  const x = state.points.x[pointIndex];
  const y = state.points.y[pointIndex];
  return polygons.some((polygon) => pointInPolygon(x, y, polygon));
}

function getActiveRegionDisplayScope() {
  if (state.regionDraft.active) {
    return { type: "full-fov", countMode: "qc" };
  }
  const preview = getRegionPreview();
  if (preview) {
    return preview;
  }
  const regionCount = getCommittedRegionCount();
  if (regionCount >= 2) {
    return { type: "region-all", countMode: "qc" };
  }
  if (regionCount === 1) {
    return { type: "region", index: 0, countMode: "qc" };
  }
  return { type: "full-fov", countMode: "qc" };
}

function pointIndexPassesRegionDisplayScope(pointIndex, scope = getActiveRegionDisplayScope()) {
  if (scope.type === "full-fov") {
    return true;
  }
  if (scope.type === "region-all") {
    return pointIndexPassesRegionPolygons(pointIndex, getCommittedRegionPolygons());
  }
  if (scope.type === "region") {
    const polygon = getCommittedRegionPolygons()[scope.index];
    return polygon ? pointIndexPassesRegionPolygons(pointIndex, [polygon]) : false;
  }
  return true;
}

function countRegionNeuronsForPolygons(polygons, { filters = null } = {}) {
  if (!state.points || !polygons.length) {
    return 0;
  }
  return state.points.id.reduce((count, _id, pointIndex) => {
    if (filters && !pointIndexPassesMetricFilters(pointIndex, filters)) {
      return count;
    }
    const x = state.points.x[pointIndex];
    const y = state.points.y[pointIndex];
    return count + (polygons.some((polygon) => pointInPolygon(x, y, polygon)) ? 1 : 0);
  }, 0);
}

function countMetricQcNeurons(filters = getActiveQcFilters()) {
  if (!state.points) {
    return 0;
  }
  return state.points.id.reduce(
    (count, _id, pointIndex) => count + (pointIndexPassesMetricFilters(pointIndex, filters) ? 1 : 0),
    0
  );
}

function formatRegionCount(value) {
  return Number.isFinite(value) ? `${value}` : "-";
}

function getFullFovCounts(filters = getActiveQcFilters()) {
  if (!state.points) {
    return { raw: null, qc: null };
  }
  return {
    raw: state.points.id.length,
    qc: countMetricQcNeurons(filters),
  };
}

function getRegionAllCounts(filters = getActiveQcFilters()) {
  const polygons = getCommittedRegionPolygons();
  if (!polygons.length) {
    return { raw: null, qc: null };
  }
  return {
    raw: countRegionNeuronsForPolygons(polygons),
    qc: countRegionNeuronsForPolygons(polygons, { filters }),
  };
}

function updateRegionCountHighlights() {
  const activeScope = getActiveRegionDisplayScope();
  const activeKey = getRegionPreviewKey(activeScope);
  const activeMode = normalizeRegionCountMode(activeScope.countMode);
  document.querySelectorAll(".region-row-count[data-region-preview-key]").forEach((cell) => {
    const isActive = (
      cell.dataset.regionPreviewKey === activeKey
      && cell.dataset.regionCountMode === activeMode
    );
    cell.classList.toggle("region-row-count-active", isActive);
  });
}

function deleteRegionAt(index) {
  state.regionPreview = null;
  state.regionPolygons = getCommittedRegionPolygons().filter((_, idx) => idx !== index);
  refreshRegionViews();
}

function setRegionPreview(preview) {
  const next = normalizeRegionPreview(preview);
  const current = getRegionPreview();
  if (sameRegionPreview(current, next)) {
    return;
  }
  state.regionPreview = next;
  updateRegionCountHighlights();
  renderMap();
}

function clearRegionPreview(preview = null) {
  const current = getRegionPreview();
  if (!current) {
    return;
  }
  if (preview && !sameRegionPreviewScope(current, normalizeRegionPreview(preview))) {
    return;
  }
  state.regionPreview = null;
  updateRegionCountHighlights();
  renderMap();
}

function parseGridTrackPixels(templateColumns) {
  return String(templateColumns)
    .split(/\s+/)
    .map((track) => Number.parseFloat(track))
    .filter((value) => Number.isFinite(value));
}

function getRegionCountModeFromPointer(row, clientX) {
  if (!Number.isFinite(clientX)) {
    return "qc";
  }

  const rowRect = row.getBoundingClientRect();
  const style = getComputedStyle(row);
  const tracks = parseGridTrackPixels(style.gridTemplateColumns);
  const gap = Number.parseFloat(style.columnGap) || 0;
  const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;

  if (tracks.length >= 3) {
    const contentLeft = rowRect.left + borderLeft + paddingLeft;
    const qcRawBoundary = contentLeft + tracks[0] + gap + tracks[1] + gap / 2;
    return clientX >= qcRawBoundary ? "raw" : "qc";
  }

  return "qc";
}

function wireRegionPreview(row, preview) {
  const setPreviewFromPointer = (event) => {
    setRegionPreview({
      ...preview,
      countMode: getRegionCountModeFromPointer(row, event.clientX),
    });
  };
  for (const eventName of ["mouseenter", "pointerenter"]) {
    row.addEventListener(eventName, setPreviewFromPointer);
  }
  for (const eventName of ["mousemove", "pointermove"]) {
    row.addEventListener(eventName, setPreviewFromPointer);
  }
  for (const eventName of ["mouseleave", "pointerleave"]) {
    row.addEventListener(eventName, () => clearRegionPreview({ ...preview, countMode: "qc" }));
  }
}

function makeRegionCountCell(value, preview, countMode) {
  const cell = document.createElement("div");
  cell.className = "region-row-count";
  cell.textContent = formatRegionCount(value);
  if (Number.isFinite(value) && preview) {
    cell.dataset.regionPreviewKey = getRegionPreviewKey(preview);
    cell.dataset.regionCountMode = normalizeRegionCountMode(countMode);
  }
  return cell;
}

function makeRegionIconButton({ className, label, title, onClick, disabled = false }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `region-row-icon mini-btn ${className}`;
  button.setAttribute("aria-label", label);
  button.title = title ?? label;
  button.disabled = disabled;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function renderRegionList() {
  const container = document.getElementById("region-list");
  if (!container) {
    return;
  }
  const polygons = getDisplayedRegionPolygons();
  const filters = getActiveQcFilters();
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "region-row region-row-header";
  header.innerHTML = `
    <div class="region-row-label">Region</div>
    <div class="region-row-count">Neuron #</div>
    <div class="region-row-count">Before QC</div>
    <div class="region-row-action"></div>
  `;
  container.appendChild(header);

  const fullFovPreview = { type: "full-fov" };
  const fullFovCounts = getFullFovCounts(filters);
  const fullFovRow = document.createElement("div");
  fullFovRow.className = "region-row region-row-summary region-row-full-fov region-row-previewable";
  wireRegionPreview(fullFovRow, fullFovPreview);
  const fullFovLabel = document.createElement("div");
  fullFovLabel.className = "region-row-label";
  fullFovLabel.textContent = "Full FOV";
  fullFovRow.appendChild(fullFovLabel);
  fullFovRow.appendChild(makeRegionCountCell(fullFovCounts.qc, fullFovPreview, "qc"));
  fullFovRow.appendChild(makeRegionCountCell(fullFovCounts.raw, fullFovPreview, "raw"));
  fullFovRow.appendChild(document.createElement("div")).className = "region-row-action";
  container.appendChild(fullFovRow);

  polygons.forEach((polygon, index) => {
    const regionPreview = { type: "region", index };
    const row = document.createElement("div");
    row.className = "region-row region-row-previewable";
    wireRegionPreview(row, regionPreview);

    const label = document.createElement("div");
    label.className = "region-row-label";
    label.textContent = `Region ${index + 1}`;

    const rawCount = makeRegionCountCell(countRegionNeuronsForPolygons([polygon]), regionPreview, "raw");
    const qcCount = makeRegionCountCell(countRegionNeuronsForPolygons([polygon], { filters }), regionPreview, "qc");

    const deleteButton = makeRegionIconButton({
      className: "region-row-delete",
      label: `Delete Region ${index + 1}`,
      onClick: () => deleteRegionAt(index),
    });
    const action = document.createElement("div");
    action.className = "region-row-action";
    action.appendChild(deleteButton);

    row.appendChild(label);
    row.appendChild(qcCount);
    row.appendChild(rawCount);
    row.appendChild(action);
    container.appendChild(row);
  });

  if (state.regionDraft.active) {
    const draftIndex = getCommittedRegionPolygons().length + 1;
    const draftPolygon = normalizeRegionPolygon(state.regionDraft.points);
    const hasDraftPolygon = draftPolygon.length >= 3;
    const draft = document.createElement("div");
    draft.className = "region-row region-row-draft";
    const label = document.createElement("div");
    label.className = "region-row-label";
    label.textContent = `Region ${draftIndex}`;
    const rawCount = document.createElement("div");
    rawCount.className = "region-row-count";
    rawCount.textContent = hasDraftPolygon ? `${countRegionNeuronsForPolygons([draftPolygon])}` : "-";
    const qcCount = document.createElement("div");
    qcCount.className = "region-row-count";
    qcCount.textContent = hasDraftPolygon ? `${countRegionNeuronsForPolygons([draftPolygon], { filters })}` : "-";
    const action = document.createElement("div");
    action.className = "region-row-action";
    action.appendChild(makeRegionIconButton({
      className: "region-row-commit",
      label: `Save Region ${draftIndex}`,
      onClick: applyRegionDrawing,
      disabled: !hasDraftPolygon,
    }));
    action.appendChild(makeRegionIconButton({
      className: "region-row-cancel",
      label: `Cancel Region ${draftIndex}`,
      onClick: cancelRegionDrawing,
    }));
    draft.appendChild(label);
    draft.appendChild(qcCount);
    draft.appendChild(rawCount);
    draft.appendChild(action);
    container.appendChild(draft);
  } else {
    const nextIndex = getCommittedRegionPolygons().length + 1;
    const addRow = document.createElement("button");
    addRow.type = "button";
    addRow.className = "region-row region-row-add";
    addRow.setAttribute("aria-label", `Add Region ${nextIndex}`);
    addRow.addEventListener("click", startRegionDrawing);
    addRow.innerHTML = `
      <div class="region-row-label">Region ${nextIndex}</div>
      <div class="region-row-count"></div>
      <div class="region-row-count"></div>
      <div class="region-row-action"></div>
    `;
    container.appendChild(addRow);
  }

  if (polygons.length >= 2) {
    const regionAllPreview = { type: "region-all" };
    const regionAllCounts = getRegionAllCounts(filters);
    const regionAllRow = document.createElement("div");
    regionAllRow.className = "region-row region-row-summary region-row-region-all region-row-previewable";
    wireRegionPreview(regionAllRow, regionAllPreview);
    const regionAllLabel = document.createElement("div");
    regionAllLabel.className = "region-row-label";
    regionAllLabel.textContent = "Region All";
    regionAllRow.appendChild(regionAllLabel);
    regionAllRow.appendChild(makeRegionCountCell(regionAllCounts.qc, regionAllPreview, "qc"));
    regionAllRow.appendChild(makeRegionCountCell(regionAllCounts.raw, regionAllPreview, "raw"));
    regionAllRow.appendChild(document.createElement("div")).className = "region-row-action";
    container.appendChild(regionAllRow);
  }
  updateRegionCountHighlights();
}

function refreshRegionViews({ save = true } = {}) {
  if (save) {
    saveUiState();
  }
  renderRegionList();
  renderWorkflowSummaries();
  renderBlueprintControl();
  renderMap();
  updatePlots();
}

function startRegionDrawing() {
  rememberCurrentMapViewRange();
  state.regionPreview = null;
  state.activeWorkflowSection = "region";
  state.openSections.region = true;
  state.regionDraft = {
    active: true,
    points: [],
    polygons: [],
  };
  setStatus("");
  refreshRegionViews({ save: false });
}

function cancelRegionDrawing() {
  if (!state.regionDraft.active) {
    return;
  }
  state.regionDraft = { active: false, points: [], polygons: [] };
  state.regionPreview = null;
  setStatus("");
  refreshRegionViews({ save: false });
}

function closeRegionDraftPolygon() {
  applyRegionDrawing();
}

function applyRegionDrawing() {
  if (!state.regionDraft.active) {
    return;
  }
  const polygon = normalizeRegionPolygon(state.regionDraft.points);
  if (!polygon.length) {
    setStatus("Region needs at least three points.", true);
    renderRegionList();
    return;
  }
  state.regionPolygons = [...getCommittedRegionPolygons(), polygon];
  state.regionDraft = { active: false, points: [], polygons: [] };
  state.regionPreview = null;
  setStatus("");
  refreshRegionViews();
}

function addRegionDraftPoint(point) {
  state.regionDraft.points.push(point);
  renderRegionList();
  renderMap();
}

function isRegionDraftMapEvent(event) {
  return (
    state.regionDraft.active
    && !event.target?.closest?.(".modebar")
    && !event.target?.closest?.(".overlay-stack")
  );
}

function wireRegionDrawing() {
  const plotDiv = document.getElementById("map-plot");
  if (!plotDiv) {
    return;
  }

  let pointerStart = null;
  let lastDraftClick = null;
  const clickDistancePx = 5;
  const duplicateClickMs = 250;

  const isDuplicateDraftClick = (event) => (
    lastDraftClick
    && performance.now() - lastDraftClick.time < duplicateClickMs
    && Math.hypot(event.clientX - lastDraftClick.x, event.clientY - lastDraftClick.y) <= clickDistancePx
  );

  const addDraftPointFromEvent = (event) => {
    if (isDuplicateDraftClick(event)) {
      return true;
    }
    const point = mapEventToDataPoint(event);
    if (!point) {
      return false;
    }
    lastDraftClick = {
      time: performance.now(),
      x: event.clientX,
      y: event.clientY,
    };
    addRegionDraftPoint(point);
    return true;
  };

  plotDiv.addEventListener("pointerdown", (event) => {
    if (!isRegionDraftMapEvent(event) || event.button !== 0) {
      return;
    }
    pointerStart = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  }, true);

  plotDiv.addEventListener("pointerup", (event) => {
    if (!isRegionDraftMapEvent(event) || !pointerStart || pointerStart.id !== event.pointerId) {
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

  plotDiv.addEventListener("pointercancel", () => {
    pointerStart = null;
  }, true);

  plotDiv.addEventListener("click", (event) => {
    if (!isRegionDraftMapEvent(event)) {
      return;
    }
    addDraftPointFromEvent(event);
    event.preventDefault();
    event.stopPropagation();
  }, true);

  plotDiv.addEventListener("dblclick", (event) => {
    if (!isRegionDraftMapEvent(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeRegionDraftPolygon();
  }, true);
}
