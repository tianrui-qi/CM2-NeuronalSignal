async function init() {
  try {
    setStatus("Loading cache...");
    const { meta, points, tracesBySource } = await loadCache();
    state.meta = meta;
    state.points = points;
    rebuildPointIndex();
    state.tracesBySource = tracesBySource;
    state.dffDenominatorCache.clear();
    loadUiState();
    ensureValidActiveBackgroundKey();
    ensureValidActiveTraceSource();
    ensureValidActiveBlueprintMetric();
    ensureValidQcRanges();
    if (pruneRoiSelectionsToBoxes()) {
      saveUiState();
    }
    wireButtons();
    applyOverlayWidth();
    renderBlueprintControl();
    renderWorkflowSections();
    setStatus("");
  } catch (error) {
    console.error(error);
    setStatus(error.message ?? "Failed to initialize web app.", true);
  }
}

window.addEventListener("load", init);
