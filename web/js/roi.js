function closeRoiBoxEditor() {
  document.querySelector(".roi-box-editor-backdrop")?.remove();
}

function openRoiBoxForm({ titleText = "ROI Box", initialBox = null, onApply, onClear = null }) {
  closeRoiBoxEditor();

  const backdrop = document.createElement("div");
  backdrop.className = "roi-box-editor-backdrop";

  const panel = document.createElement("form");
  panel.className = "roi-box-editor";
  panel.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(panel);
    const box = normalizeRoiBox({
      x: formData.get("x"),
      y: formData.get("y"),
      width: formData.get("width"),
      height: formData.get("height"),
    });
    if (!box) {
      setStatus("ROI box needs positive width and height.", true);
      return;
    }
    onApply?.(box);
    closeRoiBoxEditor();
    setStatus("");
  });

  const header = document.createElement("div");
  header.className = "roi-box-editor-header";

  const title = document.createElement("h4");
  title.textContent = titleText;
  header.appendChild(title);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "roi-box-editor-icon";
  closeBtn.textContent = "×";
  closeBtn.title = "Close";
  closeBtn.addEventListener("click", closeRoiBoxEditor);
  header.appendChild(closeBtn);

  const grid = document.createElement("div");
  grid.className = "roi-box-grid";
  const fields = [
    ["x", "X"],
    ["y", "Y"],
    ["width", "Width"],
    ["height", "Height"],
  ];
  for (const [key, labelText] of fields) {
    const label = document.createElement("label");
    label.className = "roi-box-field";
    label.textContent = labelText;

    const input = document.createElement("input");
    input.type = "number";
    input.name = key;
    input.step = "any";
    input.required = true;
    if (key === "width" || key === "height") {
      input.min = "0.000001";
    } else {
      input.min = "0";
    }
    if (initialBox) {
      input.value = String(initialBox[key]);
    }
    label.appendChild(input);
    grid.appendChild(label);
  }

  const actions = document.createElement("div");
  actions.className = "roi-box-actions";

  const applyBtn = document.createElement("button");
  applyBtn.type = "submit";
  applyBtn.className = "mini-btn";
  applyBtn.textContent = "Apply";

  if (onClear) {
    const clearBoxBtn = document.createElement("button");
    clearBoxBtn.type = "button";
    clearBoxBtn.className = "mini-btn";
    clearBoxBtn.textContent = "Clear";
    clearBoxBtn.addEventListener("click", () => {
      onClear();
      closeRoiBoxEditor();
      setStatus("");
    });
    actions.appendChild(clearBoxBtn);
  }
  actions.appendChild(applyBtn);
  panel.appendChild(header);
  panel.appendChild(grid);
  panel.appendChild(actions);
  backdrop.appendChild(panel);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) {
      closeRoiBoxEditor();
    }
  });
  document.body.appendChild(backdrop);
  panel.querySelector("input")?.focus();
}

function openRoiBoxEditor(roiId) {
  const roi = getRoiById(roiId);
  if (!roi) {
    return;
  }
  openRoiBoxForm({
    titleText: "ROI Box",
    initialBox: roi.box,
    onApply: (box) => {
      roi.box = box;
      pruneRoiSelectionToBox(roi);
      refreshRoiViews();
    },
    onClear: () => {
      roi.box = null;
      refreshRoiViews();
    },
  });
}

function openAddRoiBoxEditor(color) {
  const roiName = `ROI ${state.rois.length + 1}`;
  openRoiBoxForm({
    titleText: `${roiName} Box`,
    onApply: (box) => addRoiWithColor(color, { box }),
  });
}

function pointIndexInRoiBox(pointIndex, roi) {
  if (!roi?.box) {
    return true;
  }
  const { x, y, width, height } = roi.box;
  const pointX = state.points.x[pointIndex];
  const pointY = state.points.y[pointIndex];
  return (
    pointX >= x
    && pointX < x + width
    && pointY >= y
    && pointY < y + height
  );
}

function neuronIdPassesRoiSelection(neuronId, roi, filters = getActiveQcFilters()) {
  const pointIndex = getPointIndexForNeuronId(neuronId);
  return (
    pointIndex !== null
    && pointIndexPassesQc(pointIndex, filters)
    && pointIndexInRoiBox(pointIndex, roi)
  );
}

function countRoiSelectableNeurons(roi, filters = getActiveQcFilters()) {
  if (!state.points || !roi?.box) {
    return null;
  }
  return state.points.id.reduce((count, _id, pointIndex) => {
    if (!pointIndexPassesQc(pointIndex, filters) || !pointIndexInRoiBox(pointIndex, roi)) {
      return count;
    }
    return count + 1;
  }, 0);
}

function countRoiSelectedNeurons(roi, filters = getActiveQcFilters()) {
  return roi.neuronIds.filter((neuronId) => neuronIdPassesRoiSelection(neuronId, roi, filters)).length;
}

function pruneRoiSelectionToBox(roi) {
  if (!roi?.box) {
    return false;
  }
  const before = roi.neuronIds.length;
  roi.neuronIds = roi.neuronIds.filter((neuronId) => {
    const pointIndex = getPointIndexForNeuronId(neuronId);
    return pointIndex !== null && pointIndexInRoiBox(pointIndex, roi);
  });
  return roi.neuronIds.length !== before;
}

function pruneRoiSelectionsToBoxes() {
  return state.rois.reduce((changed, roi) => pruneRoiSelectionToBox(roi) || changed, false);
}

function makeRoiRowAction({ className = "", label, text = "", disabled = false, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `mini-btn roi-row-action-btn ${className}`.trim();
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  button.disabled = disabled;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!disabled) {
      onClick?.(event);
    }
  });
  return button;
}

function closeRoiColorPicker() {
  document.querySelector(".roi-color-popover")?.remove();
}

function openRoiColorPicker(anchorRow, { optionLabel, onSelect }) {
  const existing = document.querySelector(".roi-color-popover");
  if (existing?.parentElement === anchorRow) {
    closeRoiColorPicker();
    return;
  }
  closeRoiColorPicker();

  const popover = document.createElement("div");
  popover.className = "roi-color-popover";
  popover.addEventListener("click", (event) => event.stopPropagation());

  DEFAULT_ROI_COLORS.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "roi-color-option";
    button.style.background = color;
    button.title = optionLabel(color);
    button.setAttribute("aria-label", optionLabel(color));
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeRoiColorPicker();
      onSelect(color);
    });
    popover.appendChild(button);
  });

  anchorRow.appendChild(popover);
  setTimeout(() => {
    document.addEventListener("click", closeRoiColorPicker, { once: true });
  }, 0);
}

function renderRoiWorkflowPanel() {
  const panel = document.getElementById("roi-workflow-panel");
  if (!panel) {
    return;
  }
  const filters = getActiveQcFilters();
  panel.innerHTML = "";

  const header = document.createElement("div");
  header.className = "roi-row roi-row-header";
  header.innerHTML = `
    <span>ROI</span>
    <span>Neuron #</span>
    <span>Selected</span>
    <span></span>
  `;
  panel.appendChild(header);

  for (const roi of state.rois) {
    const row = document.createElement("div");
    const isActiveRoi = roi.id === state.activeRoiId;
    row.className = `roi-row${isActiveRoi ? " roi-row-active" : ""}`;
    row.style.setProperty("--roi-color", roi.color);
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", String(isActiveRoi));
    row.tabIndex = 0;
    row.title = `${isActiveRoi ? "Deactivate" : "Activate"} ${roi.name}`;
    row.addEventListener("click", () => activateRoi(roi.id));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateRoi(roi.id);
      }
    });

    const label = document.createElement("div");
    label.className = "roi-row-label";
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "roi-row-swatch roi-row-color-swatch";
    swatch.style.background = roi.color;
    swatch.title = `Change ${roi.name} color`;
    swatch.setAttribute("aria-label", `Change ${roi.name} color`);
    swatch.addEventListener("click", (event) => {
      event.stopPropagation();
      openRoiColorPicker(row, {
        optionLabel: (color) => `Set ${roi.name} color to ${color}`,
        onSelect: (color) => {
          roi.color = color;
          refreshRoiViews({ includePlots: true });
        },
      });
    });
    const name = document.createElement("span");
    name.className = "roi-row-name";
    name.textContent = roi.name;

    const boxBtn = makeRoiRowAction({
      className: "roi-row-box",
      label: `Edit ${roi.name} box`,
      onClick: () => {
        openRoiBoxEditor(roi.id);
      },
    });

    label.appendChild(swatch);
    label.appendChild(boxBtn);
    label.appendChild(name);

    const selectableCount = document.createElement("div");
    selectableCount.className = "roi-row-count";
    const selectableNeuronCount = countRoiSelectableNeurons(roi, filters);
    selectableCount.textContent = Number.isFinite(selectableNeuronCount) ? String(selectableNeuronCount) : "-";

    const selectedCount = document.createElement("div");
    selectedCount.className = "roi-row-count";
    selectedCount.textContent = String(countRoiSelectedNeurons(roi, filters));

    const actionCell = document.createElement("div");
    actionCell.className = "roi-row-actions";

    const clearNeuronsBtn = makeRoiRowAction({
      className: "roi-row-clear",
      label: `Clear ${roi.name} neurons`,
      disabled: roi.neuronIds.length === 0,
      onClick: () => {
        if (typeof setTraceSortCustom === "function") {
          setTraceSortCustom();
        }
        roi.neuronIds = [];
        refreshRoiViews({ includePlots: true });
      },
    });

    const deleteBtn = makeRoiRowAction({
      className: "roi-row-delete",
      label: `Delete ${roi.name}`,
      onClick: () => {
        state.rois = state.rois.filter((r) => r.id !== roi.id);
        state.activeRoiId = null;
        refreshRoiViews({ includePlots: true });
      },
    });

    actionCell.appendChild(clearNeuronsBtn);
    actionCell.appendChild(deleteBtn);

    row.appendChild(label);
    row.appendChild(selectableCount);
    row.appendChild(selectedCount);
    row.appendChild(actionCell);
    panel.appendChild(row);
  }

  const nextColor = DEFAULT_ROI_COLORS[state.rois.length % DEFAULT_ROI_COLORS.length];
  const addRow = document.createElement("div");
  addRow.className = "roi-row roi-row-add";
  addRow.setAttribute("role", "button");
  addRow.tabIndex = 0;
  addRow.title = `Add ROI ${state.rois.length + 1}`;
  addRow.addEventListener("click", () => addRoiWithColor(nextColor));
  addRow.addEventListener("keydown", (event) => {
    if (event.target !== addRow) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      addRoiWithColor(nextColor);
    }
  });

  const addLabel = document.createElement("div");
  addLabel.className = "roi-row-label";
  const addSwatch = document.createElement("button");
  addSwatch.type = "button";
  addSwatch.className = "roi-row-swatch roi-row-add-swatch";
  addSwatch.style.background = nextColor;
  addSwatch.title = `Choose color for ROI ${state.rois.length + 1}`;
  addSwatch.setAttribute("aria-label", `Choose color for ROI ${state.rois.length + 1}`);
  addSwatch.addEventListener("click", (event) => {
    event.stopPropagation();
    openRoiColorPicker(addRow, {
      optionLabel: (color) => `Add ROI with color ${color}`,
      onSelect: (color) => addRoiWithColor(color),
    });
  });
  const addName = document.createElement("span");
  addName.className = "roi-row-name";
  addName.textContent = `ROI ${state.rois.length + 1}`;

  const addBoxBtn = makeRoiRowAction({
    className: "roi-row-box",
    label: `Add ${addName.textContent} with box`,
    onClick: () => openAddRoiBoxEditor(nextColor),
  });

  addLabel.appendChild(addSwatch);
  addLabel.appendChild(addBoxBtn);
  addLabel.appendChild(addName);

  addRow.appendChild(addLabel);
  addRow.appendChild(document.createElement("span"));
  addRow.appendChild(document.createElement("span"));
  addRow.appendChild(document.createElement("span"));
  panel.appendChild(addRow);
}
