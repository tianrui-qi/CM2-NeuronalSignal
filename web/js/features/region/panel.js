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
      onSetPreview({
        ...preview,
        countMode: getCountModeFromPointer(row, event.clientX),
      });
    };
    for (const eventName of ["mouseenter", "pointerenter"]) {
      row.addEventListener(eventName, setPreviewFromPointer);
    }
    for (const eventName of ["mousemove", "pointermove"]) {
      row.addEventListener(eventName, setPreviewFromPointer);
    }
    for (const eventName of ["mouseleave", "pointerleave"]) {
      row.addEventListener(eventName, () => (
        onClearPreview({ ...preview, countMode: "qc" })
      ));
    }
  }

  /** @param {unknown} value @param {any} preview @param {unknown} countMode */
  function makeCountCell(value, preview, countMode) {
    const cell = document.createElement("div");
    cell.className = "region-row-count";
    cell.textContent = model.formatRegionCount(value);
    if (Number.isFinite(value) && preview) {
      cell.dataset.regionPreviewKey = model.getRegionPreviewKey(preview);
      cell.dataset.regionCountMode = model.normalizeRegionCountMode(countMode);
      describeControl(
        cell,
        countMode === "raw"
          ? "Preview neurons before QC"
          : "Preview neurons after QC",
      );
    }
    return cell;
  }

  /**
   * @param {{
   *   className: string,
   *   label: string,
   *   description?: string,
   *   onClick: (trigger: HTMLButtonElement) => void,
   *   disabled?: boolean,
   * }} options
   */
  function makeIconButton({
    className,
    label,
    description,
    onClick,
    disabled = false,
  }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `region-row-icon mini-btn ${className}`;
    button.setAttribute("aria-label", label);
    describeControl(button, description ?? label);
    button.disabled = disabled;
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
    const cells = /** @type {NodeListOf<HTMLElement>} */ (
      document.querySelectorAll(".region-row-count[data-region-preview-key]")
    );
    cells.forEach((cell) => {
      const isActive = (
        cell.dataset.regionPreviewKey === activeKey
        && cell.dataset.regionCountMode === activeMode
      );
      cell.classList.toggle("region-row-count-active", isActive);
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
   *   onApply: () => void,
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
    onApply,
    onCancel,
  }) {
    const container = document.getElementById("region-list");
    if (!container) {
      return;
    }
    const polygons = model.getDisplayedRegionPolygons(state);
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
    fullFovRow.className = "region-row region-row-summary region-row-full-fov region-row-previewable";
    wirePreview(fullFovRow, fullFovPreview, previewHandlers);
    const fullFovLabel = document.createElement("div");
    fullFovLabel.className = "region-row-label";
    fullFovLabel.textContent = "Full FOV";
    fullFovRow.appendChild(fullFovLabel);
    fullFovRow.appendChild(makeCountCell(fullFovCounts.qc, fullFovPreview, "qc"));
    fullFovRow.appendChild(makeCountCell(fullFovCounts.raw, fullFovPreview, "raw"));
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
      );
      const qcCount = makeCountCell(
        countForPolygons([polygon], { filters }),
        regionPreview,
        "qc",
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
      action.appendChild(makeIconButton({
        className: "region-row-commit",
        label: `Save Region ${draftIndex}`,
        description: `Save Region ${draftIndex}`,
        onClick: onApply,
        disabled: !hasDraftPolygon,
      }));
      action.appendChild(makeIconButton({
        className: "region-row-cancel",
        label: `Cancel Region ${draftIndex}`,
        description: `Discard Region ${draftIndex}`,
        onClick: onCancel,
      }));
      draft.appendChild(label);
      draft.appendChild(qcCount);
      draft.appendChild(rawCount);
      draft.appendChild(action);
      container.appendChild(draft);
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
      regionAllRow.className = "region-row region-row-summary region-row-region-all region-row-previewable";
      wirePreview(regionAllRow, regionAllPreview, previewHandlers);
      const regionAllLabel = document.createElement("div");
      regionAllLabel.className = "region-row-label";
      regionAllLabel.textContent = "Region All";
      regionAllRow.appendChild(regionAllLabel);
      regionAllRow.appendChild(makeCountCell(regionAllCounts.qc, regionAllPreview, "qc"));
      regionAllRow.appendChild(makeCountCell(regionAllCounts.raw, regionAllPreview, "raw"));
      regionAllRow.appendChild(document.createElement("div")).className = "region-row-action";
      container.appendChild(regionAllRow);
    }
    updateCountHighlights(state);
  }

  return {
    render,
    updateCountHighlights,
  };
}
