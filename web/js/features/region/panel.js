import * as model from "./model.js";
import { createConfirmationDialog } from "../../shared/ui/confirmation-dialog.js";
import { describeControl } from "../../shared/ui/control-tooltip.js";


/** @param {unknown} templateColumns */
export function parseGridTrackPixels(templateColumns) {
  return String(templateColumns)
    .split(/\s+/)
    .map((track) => Number.parseFloat(track))
    .filter((value) => Number.isFinite(value));
}


/**
 * Region table DOM boundary. It renders the existing rows and translates
 * pointer position into the current QC/raw preview intent; state transitions
 * and cross-feature effects remain with the facade.
 *
 * @param {{
 *   document: Document,
 *   getComputedStyle?: (element: Element) => CSSStyleDeclaration | Record<string, any>,
 * }} dependencies
 */
export function createRegionPanel({
  document,
  getComputedStyle = (element) => globalThis.getComputedStyle(element),
}) {
  const confirmationDialog = createConfirmationDialog({ document });

  /**
   * @param {HTMLElement} row
   * @param {number} clientX
   */
  function getCountModeFromPointer(row, clientX) {
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

  /**
   * @param {HTMLElement} row
   * @param {any} preview
   * @param {{ onSetPreview: (preview: any) => void, onClearPreview: (preview: any) => void }} handlers
   */
  function wirePreview(row, preview, { onSetPreview, onClearPreview }) {
    const setPreviewFromPointer = (event) => {
      if (event.pointerType !== "mouse") {
        return;
      }
      onSetPreview({
        ...preview,
        countMode: getCountModeFromPointer(row, event.clientX),
      });
    };
    row.addEventListener("pointerenter", setPreviewFromPointer);
    row.addEventListener("pointermove", setPreviewFromPointer);
    row.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") {
        onClearPreview({ ...preview, countMode: "qc" });
      }
    });
  }

  /**
   * @param {unknown} value
   * @param {any} preview
   * @param {unknown} countMode
   * @param {{ onSetPreview?: (preview: any) => void, onClearPreview?: (preview: any) => void }} [handlers]
   */
  function makeCountCell(value, preview, countMode, handlers = {}) {
    const interactive = Boolean(
      Number.isFinite(value)
      && preview
      && typeof handlers.onSetPreview === "function"
      && typeof handlers.onClearPreview === "function"
    );
    const cell = document.createElement(interactive ? "button" : "div");
    cell.className = "region-row-count";
    if (interactive) {
      cell.type = "button";
      cell.textContent = model.formatRegionCount(value);
      cell.dataset.regionPreviewKey = model.getRegionPreviewKey(preview);
      cell.dataset.regionCountMode = model.normalizeRegionCountMode(countMode);
      cell.setAttribute("aria-pressed", "false");
      describeControl(
        cell,
        countMode === "raw"
          ? "Preview neurons before QC"
          : "Preview neurons after QC",
      );
      let lastPointerType = null;
      cell.addEventListener("pointerdown", (event) => {
        lastPointerType = event.pointerType;
      });
      cell.addEventListener("focus", () => {
        if (lastPointerType === null) {
          handlers.onSetPreview({ ...preview, countMode });
        }
      });
      cell.addEventListener("click", (event) => {
        event.stopPropagation();
        const canToggle = (
          event.detail === 0
          || lastPointerType === "touch"
          || lastPointerType === "pen"
        );
        if (canToggle && cell.getAttribute("aria-pressed") === "true") {
          handlers.onClearPreview({ ...preview, countMode });
        } else {
          handlers.onSetPreview({ ...preview, countMode });
        }
        lastPointerType = null;
      });
    } else {
      cell.textContent = model.formatRegionCount(value);
    }
    return cell;
  }

  /**
   * @param {{
   *   className: string,
   *   label: string,
   *   description?: string,
   *   onClick: (trigger: HTMLButtonElement) => void,
   * }} options
   */
  function makeIconButton({
    className,
    label,
    description,
    onClick,
  }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `region-row-icon mini-btn ${className}`;
    button.setAttribute("aria-label", label);
    describeControl(button, description ?? label);
    const visual = document.createElement("span");
    visual.className = "region-row-icon-visual";
    visual.setAttribute("aria-hidden", "true");
    button.appendChild(visual);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(button);
    });
    return button;
  }

  /** @param {number} deletedIndex */
  function focusTargetAfterDelete(deletedIndex) {
    const remainingDeleteButtons = Array.from(
      document.querySelectorAll("#region-list .region-row-delete"),
    );
    if (remainingDeleteButtons.length) {
      return remainingDeleteButtons[
        Math.min(deletedIndex, remainingDeleteButtons.length - 1)
      ] ?? null;
    }
    return (
      document.querySelector("#region-list .region-row-add")
      ?? document.querySelector('[data-section-toggle="region"]')
    );
  }

  /** @param {Record<string, any>} state */
  function updateCountHighlights(state) {
    const activeScope = model.getActiveRegionDisplayScope(state);
    const activeKey = model.getRegionPreviewKey(activeScope);
    const activeMode = model.normalizeRegionCountMode(activeScope.countMode);
    const pinnedPreview = model.getRegionPreview(state);
    const pinnedKey = model.getRegionPreviewKey(pinnedPreview);
    const pinnedMode = model.normalizeRegionCountMode(pinnedPreview?.countMode);
    const cells = /** @type {NodeListOf<HTMLElement>} */ (
      document.querySelectorAll(".region-row-count[data-region-preview-key]")
    );
    cells.forEach((cell) => {
      const isActive = (
        cell.dataset.regionPreviewKey === activeKey
        && cell.dataset.regionCountMode === activeMode
      );
      const isPinned = Boolean(
        pinnedPreview
        && cell.dataset.regionPreviewKey === pinnedKey
        && cell.dataset.regionCountMode === pinnedMode
      );
      cell.classList.toggle("region-row-count-active", isActive);
      cell.setAttribute("aria-pressed", String(isPinned));
    });
  }

  /**
   * @param {{
   *   state: Record<string, any>,
   *   filters: any,
   *   pointPassesMetricFilters: (pointIndex: number, filters: any) => boolean,
   *   onDelete: (index: number) => void,
   *   onSetPreview: (preview: any) => void,
   *   onClearPreview: (preview?: any) => void,
   *   onStart: () => void,
   *   onFinish: () => void,
   *   onUndo: () => boolean,
   *   onCancel: () => void,
   * }} options
   */
  function render({
    state,
    filters,
    pointPassesMetricFilters,
    onDelete,
    onSetPreview,
    onClearPreview,
    onStart,
    onFinish,
    onUndo,
    onCancel,
  }) {
    const container = document.getElementById("region-list");
    if (!container) {
      return;
    }
    const polygons = model.getDisplayedRegionPolygons(state);
    const sectionToggle = /** @type {HTMLButtonElement | null} */ (
      document.querySelector('[data-section-toggle="region"]')
    );
    if (sectionToggle) {
      sectionToggle.disabled = state.regionDraft.active;
      sectionToggle.setAttribute(
        "aria-disabled",
        String(state.regionDraft.active),
      );
    }
    const countForPolygons = (targetPolygons, options = {}) => (
      model.countRegionNeuronsForPolygons(state, targetPolygons, {
        ...options,
        pointPassesMetricFilters,
      })
    );
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

    const previewHandlers = { onSetPreview, onClearPreview };
    const fullFovPreview = { type: "full-fov" };
    const fullFovCounts = model.getFullFovCounts(
      state,
      filters,
      pointPassesMetricFilters,
    );
    const fullFovRow = document.createElement("div");
    fullFovRow.className = "region-row region-row-summary region-row-previewable";
    wirePreview(fullFovRow, fullFovPreview, previewHandlers);
    const fullFovLabel = document.createElement("div");
    fullFovLabel.className = "region-row-label";
    fullFovLabel.textContent = "Full FOV";
    fullFovRow.appendChild(fullFovLabel);
    fullFovRow.appendChild(makeCountCell(
      fullFovCounts.qc,
      fullFovPreview,
      "qc",
      previewHandlers,
    ));
    fullFovRow.appendChild(makeCountCell(
      fullFovCounts.raw,
      fullFovPreview,
      "raw",
      previewHandlers,
    ));
    fullFovRow.appendChild(document.createElement("div")).className = "region-row-action";
    container.appendChild(fullFovRow);

    polygons.forEach((polygon, index) => {
      const regionPreview = { type: "region", index };
      const row = document.createElement("div");
      row.className = "region-row region-row-previewable";
      wirePreview(row, regionPreview, previewHandlers);

      const label = document.createElement("div");
      label.className = "region-row-label";
      label.textContent = `Region ${index + 1}`;

      const rawCount = makeCountCell(
        countForPolygons([polygon]),
        regionPreview,
        "raw",
        previewHandlers,
      );
      const qcCount = makeCountCell(
        countForPolygons([polygon], { filters }),
        regionPreview,
        "qc",
        previewHandlers,
      );
      const deleteButton = makeIconButton({
        className: "region-row-delete",
        label: `Delete Region ${index + 1}`,
        description: `Delete Region ${index + 1} and its boundary`,
        onClick: (trigger) => {
          const regionName = `Region ${index + 1}`;
          confirmationDialog.open({
            title: `Delete ${regionName}?`,
            description: (
              `Delete ${regionName} and its boundary. It will no longer contribute `
              + "to the Region filter."
            ),
            confirmLabel: "Delete Region",
            confirmDescription: `Delete ${regionName} and remove its boundary from the Region filter`,
            cancelDescription: `Keep ${regionName} and close this dialog`,
            trigger,
            onConfirm: () => onDelete(index),
            focusAfterConfirm: () => focusTargetAfterDelete(index),
          });
        },
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

    let drawingToolbar = null;
    if (state.regionDraft.active) {
      const draftIndex = model.getCommittedRegionPolygons(state).length + 1;
      const draftPolygon = model.normalizeRegionPolygon(state.regionDraft.points);
      const hasDraftPolygon = draftPolygon.length >= 3;
      const draft = document.createElement("div");
      draft.className = "region-row region-row-draft";
      const label = document.createElement("div");
      label.className = "region-row-label";
      label.textContent = `Region ${draftIndex}`;
      const rawCount = document.createElement("div");
      rawCount.className = "region-row-count";
      rawCount.textContent = hasDraftPolygon
        ? `${countForPolygons([draftPolygon])}`
        : "-";
      const qcCount = document.createElement("div");
      qcCount.className = "region-row-count";
      qcCount.textContent = hasDraftPolygon
        ? `${countForPolygons([draftPolygon], { filters })}`
        : "-";
      const action = document.createElement("div");
      action.className = "region-row-action";
      draft.appendChild(label);
      draft.appendChild(qcCount);
      draft.appendChild(rawCount);
      draft.appendChild(action);
      container.appendChild(draft);

      const toolbar = document.createElement("div");
      toolbar.className = "region-drawing-toolbar";
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", `Region ${draftIndex} drawing controls`);
      const makeDrawingButton = ({
        className,
        command,
        label,
        description,
        disabled,
        onClick,
      }) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `mini-btn region-drawing-action ${className}`;
        button.dataset.interactionCommand = command;
        button.textContent = label;
        button.disabled = disabled;
        describeControl(button, description);
        button.addEventListener("click", onClick);
        return button;
      };
      toolbar.appendChild(makeDrawingButton({
        className: "region-drawing-undo",
        command: "region-undo",
        label: "Undo",
        description: `Remove the last vertex from Region ${draftIndex}`,
        disabled: state.regionDraft.points.length === 0,
        onClick: () => {
          if (onUndo()) {
            document.querySelector(".region-drawing-undo")?.focus();
          }
        },
      }));
      toolbar.appendChild(makeDrawingButton({
        className: "region-drawing-finish",
        command: "region-finish",
        label: "Finish",
        description: `Finish and save Region ${draftIndex}`,
        disabled: !hasDraftPolygon,
        onClick: onFinish,
      }));
      toolbar.appendChild(makeDrawingButton({
        className: "region-drawing-cancel",
        command: "region-cancel",
        label: "Cancel",
        description: `Discard Region ${draftIndex}`,
        disabled: false,
        onClick: onCancel,
      }));
      drawingToolbar = toolbar;
    } else {
      const nextIndex = model.getCommittedRegionPolygons(state).length + 1;
      const addRow = document.createElement("button");
      addRow.type = "button";
      addRow.className = "region-row region-row-add";
      addRow.setAttribute("aria-label", `Add Region ${nextIndex}`);
      describeControl(addRow, `Draw Region ${nextIndex} on the map`);
      addRow.addEventListener("click", onStart);
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
      const regionAllCounts = model.getRegionAllCounts(
        state,
        filters,
        pointPassesMetricFilters,
      );
      const regionAllRow = document.createElement("div");
      regionAllRow.className = "region-row region-row-summary region-row-previewable";
      wirePreview(regionAllRow, regionAllPreview, previewHandlers);
      const regionAllLabel = document.createElement("div");
      regionAllLabel.className = "region-row-label";
      regionAllLabel.textContent = "Region All";
      regionAllRow.appendChild(regionAllLabel);
      regionAllRow.appendChild(makeCountCell(
        regionAllCounts.qc,
        regionAllPreview,
        "qc",
        previewHandlers,
      ));
      regionAllRow.appendChild(makeCountCell(
        regionAllCounts.raw,
        regionAllPreview,
        "raw",
        previewHandlers,
      ));
      regionAllRow.appendChild(document.createElement("div")).className = "region-row-action";
      container.appendChild(regionAllRow);
    }
    if (drawingToolbar) {
      container.appendChild(drawingToolbar);
    }
    updateCountHighlights(state);
  }

  return {
    render,
    updateCountHighlights,
  };
}
