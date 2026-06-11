function renderWorkflowSummaries() {
  const regionSummary = document.getElementById("region-section-summary");
  if (regionSummary) {
    regionSummary.textContent = "";
  }

  const qcSummary = document.getElementById("qc-section-summary");
  if (qcSummary) {
    qcSummary.textContent = "";
  }

  const roiSummary = document.getElementById("roi-section-summary");
  if (roiSummary) {
    roiSummary.textContent = "";
  }

  const traceSummary = document.getElementById("trace-section-summary");
  if (traceSummary) {
    traceSummary.textContent = "";
  }
}

function renderWorkflowChrome() {
  if (!WORKFLOW_SECTIONS.includes(state.activeWorkflowSection)) {
    state.activeWorkflowSection = WORKFLOW_SECTIONS[0];
  }
  for (const section of WORKFLOW_SECTIONS) {
    const isActive = section === state.activeWorkflowSection;
    const isOpen = Boolean(state.openSections[section]);
    const sectionEl = document.querySelector(`[data-workflow-section="${section}"]`);
    sectionEl?.classList.remove("hidden");
    sectionEl?.classList.toggle("active", isActive);
    sectionEl?.classList.toggle("collapsed", !isOpen);
    const toggle = document.querySelector(`[data-section-toggle="${section}"]`);
    toggle?.setAttribute("aria-expanded", String(isOpen));
  }
  renderWorkflowSummaries();
}

function renderWorkflowSections({ includeMap = true, includePlots = true } = {}) {
  renderWorkflowChrome();
  renderRegionList();
  renderBlueprintControl();
  if (state.openSections.qc) {
    renderBlueprintStats();
  }
  renderRoiWorkflowPanel();
  if (includePlots && state.openSections.trace) {
    updatePlots();
  }
  schedulePanelPlotResize();
  if (includeMap && state.points) {
    renderMap();
  }
}

function setActiveWorkflowSection(section, { scroll = false, includePlots = false } = {}) {
  const next = normalizeWorkflowSection(section, state.activeWorkflowSection);
  const changed = state.activeWorkflowSection !== next;
  state.activeWorkflowSection = next;
  state.openSections[next] = true;
  saveUiState();
  renderWorkflowSections({ includeMap: changed, includePlots });
  if (scroll) {
    document.querySelector(`[data-workflow-section="${next}"]`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }
}

function toggleWorkflowSection(section) {
  const next = normalizeWorkflowSection(section, state.activeWorkflowSection);
  state.activeWorkflowSection = next;
  state.openSections[next] = !state.openSections[next];
  saveUiState();
  renderWorkflowSections({ includeMap: true, includePlots: next === "trace" });
}

function syncActiveWorkflowFromScroll() {
  const panel = document.getElementById("workflow-panel");
  if (!panel) {
    return;
  }
  const panelTop = panel.getBoundingClientRect().top;
  let bestSection = state.activeWorkflowSection;
  let bestDistance = Infinity;
  for (const section of WORKFLOW_SECTIONS) {
    const el = document.querySelector(`[data-workflow-section="${section}"]`);
    if (!el) {
      continue;
    }
    const distance = Math.abs(el.getBoundingClientRect().top - panelTop);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSection = section;
    }
  }
  if (bestSection !== state.activeWorkflowSection) {
    state.activeWorkflowSection = bestSection;
    saveUiState();
    renderWorkflowSections({ includeMap: true, includePlots: bestSection === "trace" });
  }
}

function handleNeuronToggle(neuronId) {
  const activeRoi = getRoiById(state.activeRoiId);
  if (!activeRoi) {
    return;
  }
  const currentRoiId = findAssignedRoiId(neuronId);
  const pointIndex = getPointIndexForNeuronId(neuronId);
  if (
    currentRoiId !== activeRoi.id
    && activeRoi.box
    && (pointIndex === null || !pointIndexInRoiBox(pointIndex, activeRoi))
  ) {
    return;
  }
  if (currentRoiId === activeRoi.id) {
    activeRoi.neuronIds = activeRoi.neuronIds.filter((id) => id !== neuronId);
  } else {
    removeNeuronFromAllRois(neuronId);
    activeRoi.neuronIds = [...activeRoi.neuronIds, neuronId];
  }
  refreshRoiViews({ includePlots: true });
}
function wireOverlayResizer() {
  const overlay = document.querySelector(".overlay-stack");
  const resizer = document.getElementById("overlay-resizer");
  if (!overlay || !resizer) {
    return;
  }

  let isResizing = false;
  let activePointerId = null;
  const updateWidth = (clientX) => {
    const overlayLeft = overlay.getBoundingClientRect().left;
    state.overlayWidth = normalizeOverlayWidth(clientX - overlayLeft);
    applyOverlayWidth();
    schedulePanelPlotResize();
  };
  const startResize = () => {
    isResizing = true;
    overlay.classList.add("is-resizing");
    document.body.style.cursor = "ew-resize";
  };
  const finishResize = () => {
    if (!isResizing) {
      return;
    }
    isResizing = false;
    activePointerId = null;
    overlay.classList.remove("is-resizing");
    document.body.style.cursor = "";
    saveUiState();
    schedulePanelPlotResize();
  };
  const handleMouseMove = (event) => {
    if (!isResizing || activePointerId !== null) {
      return;
    }
    updateWidth(event.clientX);
  };
  const handleMouseUp = () => {
    document.removeEventListener("mousemove", handleMouseMove);
    finishResize();
  };

  resizer.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= 800) {
      return;
    }
    activePointerId = event.pointerId;
    resizer.setPointerCapture(event.pointerId);
    startResize();
    event.preventDefault();
  });

  resizer.addEventListener("pointermove", (event) => {
    if (!isResizing || activePointerId !== event.pointerId) {
      return;
    }
    updateWidth(event.clientX);
  });

  resizer.addEventListener("pointerup", finishResize);
  resizer.addEventListener("pointercancel", finishResize);
  resizer.addEventListener("dblclick", () => {
    state.overlayWidth = null;
    applyOverlayWidth();
    saveUiState();
    schedulePanelPlotResize();
  });
  resizer.addEventListener("mousedown", (event) => {
    if (window.innerWidth <= 800 || isResizing) {
      return;
    }
    startResize();
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp, { once: true });
    event.preventDefault();
  });
}

function wireButtons() {
  for (const section of WORKFLOW_SECTIONS) {
    document.querySelector(`[data-section-toggle="${section}"]`)?.addEventListener("click", () => {
      toggleWorkflowSection(section);
    });
  }
  const workflowPanel = document.getElementById("workflow-panel");
  workflowPanel?.addEventListener("scroll", () => {
    if (syncActiveWorkflowFromScroll.queued) {
      return;
    }
    syncActiveWorkflowFromScroll.queued = true;
    requestAnimationFrame(() => {
      syncActiveWorkflowFromScroll.queued = false;
      syncActiveWorkflowFromScroll();
    });
  });

  const blueprintButton = document.getElementById("blueprint-select");
  blueprintButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleBlueprintMenu();
  });
  blueprintButton.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleBlueprintMenu();
    }
    if (event.key === "Escape") {
      closeBlueprintMenu();
    }
  });
  document.addEventListener("click", (event) => {
    if (!document.getElementById("blueprint-picker")?.contains(event.target)) {
      closeBlueprintMenu();
    }
  });

  document.getElementById("qc-range-lower-input").addEventListener("input", () => {
    updateActiveQcRangeFromInputs("lower");
  });
  document.getElementById("qc-range-upper-input").addEventListener("input", () => {
    updateActiveQcRangeFromInputs("upper");
  });
  document.getElementById("qc-absolute-lower-input").addEventListener("input", () => {
    updateActiveQcRangeFromInputs("lower", "qc-absolute");
  });
  document.getElementById("qc-absolute-upper-input").addEventListener("input", () => {
    updateActiveQcRangeFromInputs("upper", "qc-absolute");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.regionDraft.active) {
      cancelRegionDrawing();
    }
    if (event.key === "Enter" && state.regionDraft.active && state.regionDraft.points.length >= 3) {
      applyRegionDrawing();
    }
  });

  wireRegionDrawing();
  wireOverlayResizer();
  window.addEventListener("resize", () => {
    if (!state.meta) {
      return;
    }
    const nextKey = `${window.innerWidth}x${window.innerHeight}`;
    applyOverlayWidth();
    schedulePanelPlotResize();
    if (state.mapViewportKey !== nextKey) {
      clearMapViewRange();
      renderMap();
    }
  });
}
