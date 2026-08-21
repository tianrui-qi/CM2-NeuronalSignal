import { placeAnchoredPopover } from "../../shared/ui/anchored-popover.js";
import { createConfirmationDialog } from "../../shared/ui/confirmation-dialog.js";


/**
 * Presentation-only owner for the existing ROI table and color-palette DOM.
 * Viewer state, persistence, validation, and cross-feature effects remain with
 * the caller.
 *
 * @param {{
 *   document: Document,
 *   scheduleTimeout: (callback: () => void, delay: number) => unknown,
 * }} dependencies
 */
export function createRoiPanel({ document, scheduleTimeout }) {
  const confirmationDialog = createConfirmationDialog({ document });
  let activeColorTrigger = null;
  let nextColorPickerId = 0;
  let outsideColorPickerListener = null;

  function positionColorPicker() {
    const popover = document.querySelector(".roi-color-popover");
    const anchorRow = popover?.parentElement;
    if (!popover || !anchorRow) {
      return null;
    }
    return placeAnchoredPopover({
      popup: /** @type {HTMLElement} */ (popover),
      anchor: anchorRow,
      boundary: document.getElementById("workflow-panel"),
      preferred: "up",
      maxHeight: 300,
    });
  }

  function stopColorPickerPlacement() {
    document.removeEventListener("scroll", positionColorPicker, true);
    document.defaultView?.removeEventListener("resize", positionColorPicker);
    document.removeEventListener("keydown", handleColorPickerEscape);
  }

  function handleColorPickerEscape(event) {
    if (event.key === "Escape" && document.querySelector(".roi-color-popover")) {
      event.preventDefault();
      closeColorPicker({ restoreFocus: true });
    }
  }

  /**
   * @param {{
   *   className: string,
   *   label: string,
   *   description: string,
   *   disabled?: boolean,
   *   onClick: (trigger: HTMLButtonElement) => void,
   * }} options
   */
  function makeRowAction({
    className,
    label,
    description,
    disabled = false,
    onClick,
  }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mini-btn roi-row-action-btn ${className}`.trim();
    button.setAttribute("aria-label", label);
    button.dataset.controlDescription = description;
    const visual = document.createElement("span");
    visual.className = "roi-row-action-visual";
    visual.setAttribute("aria-hidden", "true");
    button.appendChild(visual);
    button.disabled = disabled;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick(button);
    });
    return button;
  }

  /** @param {HTMLButtonElement} button */
  function appendSwatchVisual(button) {
    const visual = document.createElement("span");
    visual.className = "roi-row-swatch-visual";
    visual.setAttribute("aria-hidden", "true");
    const chip = document.createElement("span");
    chip.className = "roi-row-swatch-chip";
    visual.appendChild(chip);
    button.appendChild(visual);
  }

  function closeColorPicker({ restoreFocus = false } = {}) {
    if (outsideColorPickerListener) {
      document.removeEventListener("pointerdown", outsideColorPickerListener, true);
      outsideColorPickerListener = null;
    }
    stopColorPickerPlacement();
    const popover = document.querySelector(".roi-color-popover");
    popover?.closest(".workflow-section")?.classList.remove("menu-open");
    popover?.remove();
    const trigger = activeColorTrigger;
    activeColorTrigger = null;
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.removeAttribute("aria-controls");
    if (restoreFocus && trigger?.isConnected) {
      trigger.focus();
    }
  }

  /** @param {string} roiId */
  function findRoiSelectButton(roiId) {
    const row = Array.from(document.querySelectorAll(".roi-row[data-roi-id]"))
      .find((candidate) => candidate.dataset.roiId === roiId) ?? null;
    return row?.querySelector(".roi-row-select") ?? null;
  }

  /**
   * @param {HTMLElement} anchorRow
   * @param {HTMLButtonElement} trigger
   * @param {{
   *   palette: readonly string[],
   *   optionLabel: (color: string) => string,
   *   optionDescription: (color: string) => string,
   *   onSelect: (color: string) => void,
   *   focusFirst?: boolean,
   *   focusTarget?: "first" | "last",
   * }} options
   */
  function openColorPicker(
    anchorRow,
    trigger,
    {
      palette,
      optionLabel,
      optionDescription,
      onSelect,
      focusFirst = false,
      focusTarget = "first",
    },
  ) {
    const existing = document.querySelector(".roi-color-popover");
    if (existing?.parentElement === anchorRow && activeColorTrigger === trigger) {
      closeColorPicker({ restoreFocus: focusFirst });
      return;
    }
    closeColorPicker();

    const popover = document.createElement("div");
    popover.id = `roi-color-popover-${++nextColorPickerId}`;
    popover.className = "roi-color-popover anchored-popover floating-surface";
    popover.setAttribute("role", "menu");
    popover.setAttribute("aria-label", trigger.getAttribute("aria-label") ?? "ROI colors");
    popover.addEventListener("click", (event) => event.stopPropagation());

    palette.forEach((color) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "roi-color-option";
      button.tabIndex = -1;
      button.style.background = color;
      button.setAttribute("role", "menuitem");
      button.setAttribute("aria-label", optionLabel(color));
      button.dataset.controlDescription = optionDescription(color);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const restoreAfterRender = event.detail === 0;
        const triggerLabel = trigger.getAttribute("aria-label");
        closeColorPicker();
        onSelect(color);
        if (restoreAfterRender && triggerLabel) {
          scheduleTimeout(() => {
            Array.from(document.querySelectorAll("button"))
              .find((candidate) => candidate.getAttribute("aria-label") === triggerLabel)
              ?.focus();
          }, 0);
        }
      });
      popover.appendChild(button);
    });

    popover.addEventListener("keydown", (event) => {
      const options = Array.from(popover.querySelectorAll(".roi-color-option"));
      if (!options.length) {
        return;
      }
      const currentIndex = options.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeColorPicker({ restoreFocus: true });
        return;
      }
      if (event.key === "Tab") {
        closeColorPicker();
        return;
      }
      if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      let nextIndex = currentIndex;
      if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = options.length - 1;
      } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        nextIndex = (Math.max(-1, currentIndex) + 1) % options.length;
      } else {
        nextIndex = (currentIndex <= 0 ? options.length : currentIndex) - 1;
      }
      options[nextIndex]?.focus();
    });

    anchorRow.appendChild(popover);
    activeColorTrigger = trigger;
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", popover.id);
    popover.closest(".workflow-section")?.classList.add("menu-open");
    positionColorPicker();
    document.addEventListener("scroll", positionColorPicker, true);
    document.defaultView?.addEventListener("resize", positionColorPicker);
    document.addEventListener("keydown", handleColorPickerEscape);
    if (focusFirst) {
      const options = Array.from(popover.querySelectorAll(".roi-color-option"));
      (focusTarget === "last" ? options.at(-1) : options[0])?.focus();
    }

    outsideColorPickerListener = (event) => {
      const target = /** @type {Node} */ (event.target);
      if (popover.contains(target) || trigger.contains(target)) {
        return;
      }
      closeColorPicker();
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("pointerdown", outsideColorPickerListener, true);
  }

  /**
   * @param {{
   *   rows: Array<{
   *     id: string,
   *     name: string,
   *     color: string,
   *     isActive: boolean,
   *     selectableCount: number | null,
   *     selectedCount: number,
   *     hasSelected: boolean,
   *   }>,
   *   palette: readonly string[],
   *   toggle: (id: string) => void,
   *   editBox: (id: string) => void,
   *   changeColor: (id: string, color: string) => void,
   *   clear: (id: string) => void,
   *   delete: (id: string) => void,
   *   addDefault: (color: string) => void,
   *   addWithColor: (color: string) => void,
   *   addWithBox: (color: string) => void,
   * }} options
   */
  function render({
    rows,
    palette,
    toggle,
    editBox,
    changeColor,
    clear,
    delete: deleteRow,
    addDefault,
    addWithColor,
    addWithBox,
  }) {
    const panel = document.getElementById("roi-workflow-panel");
    if (!panel) {
      return;
    }
    closeColorPicker();
    panel.innerHTML = "";

    const header = document.createElement("div");
    header.className = "roi-row roi-row-header";
    header.innerHTML = `
      <span></span>
      <span>ROI</span>
      <span>Neuron #</span>
      <span>Selected</span>
      <span></span>
    `;
    panel.appendChild(header);

    for (const [rowIndex, rowView] of rows.entries()) {
      const row = document.createElement("div");
      row.className = `roi-row${rowView.isActive ? " roi-row-active" : ""}`;
      row.style.setProperty("--roi-color", rowView.color);
      row.dataset.roiId = rowView.id;
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", `${rowView.name} controls`);

      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "roi-row-swatch";
      swatch.style.setProperty("--roi-color", rowView.color);
      swatch.setAttribute("aria-label", `Change ${rowView.name} color`);
      swatch.setAttribute("aria-haspopup", "menu");
      swatch.setAttribute("aria-expanded", "false");
      swatch.dataset.controlDescription = (
        `Change ${rowView.name}'s color`
      );
      appendSwatchVisual(swatch);
      const showColorPicker = (focusFirst = false, focusTarget = "first") => {
        openColorPicker(row, swatch, {
          palette,
          optionLabel: (color) => `Set ${rowView.name} color to ${color}`,
          optionDescription: (color) => (
            `Set ${rowView.name} to ${color}`
          ),
          onSelect: (color) => changeColor(rowView.id, color),
          focusFirst,
          focusTarget,
        });
      };
      swatch.addEventListener("click", (event) => {
        event.stopPropagation();
        showColorPicker(event.detail === 0);
      });
      swatch.addEventListener("keydown", (event) => {
        if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        showColorPicker(true, event.key === "ArrowUp" ? "last" : "first");
      });

      const boxButton = makeRowAction({
        className: "roi-row-box",
        label: `Edit ${rowView.name} box`,
        description: `Edit the box for ${rowView.name}`,
        onClick: () => editBox(rowView.id),
      });

      const selectButton = document.createElement("button");
      selectButton.type = "button";
      selectButton.className = "roi-row-select";
      selectButton.setAttribute("aria-label", `Select ${rowView.name}`);
      selectButton.setAttribute("aria-pressed", String(rowView.isActive));
      selectButton.dataset.controlDescription = rowView.isActive
        ? `Deactivate ${rowView.name}`
        : `Activate ${rowView.name}`;
      selectButton.addEventListener("click", () => {
        const shouldRestoreFocus = document.activeElement === selectButton;
        toggle(rowView.id);
        if (shouldRestoreFocus) {
          findRoiSelectButton(rowView.id)?.focus();
        }
      });

      const name = document.createElement("span");
      name.className = "roi-row-name";
      name.textContent = rowView.name;

      const selectableCount = document.createElement("span");
      selectableCount.className = "roi-row-count";
      selectableCount.textContent = Number.isFinite(rowView.selectableCount)
        ? String(rowView.selectableCount)
        : "-";

      const selectedCount = document.createElement("span");
      selectedCount.className = "roi-row-count";
      selectedCount.textContent = String(rowView.selectedCount);

      selectButton.appendChild(name);
      selectButton.appendChild(selectableCount);
      selectButton.appendChild(selectedCount);

      const clearButton = makeRowAction({
        className: "roi-row-clear",
        label: `Clear ${rowView.name} neurons`,
        description: (
          `Remove all selected neurons from ${rowView.name}; keep its box and color`
        ),
        disabled: !rowView.hasSelected,
        onClick: (trigger) => {
          closeColorPicker();
          confirmationDialog.open({
            title: `Clear selected neurons from ${rowView.name}?`,
            description: (
              `Remove all selected neurons from ${rowView.name}. `
              + "Its box and color will remain."
            ),
            confirmLabel: "Clear Neurons",
            confirmDescription: (
              `Remove all selected neurons from ${rowView.name}; keep its box and color`
            ),
            trigger,
            onConfirm: () => clear(rowView.id),
            focusAfterConfirm: () => findRoiSelectButton(rowView.id),
          });
        },
      });
      const deleteButton = makeRowAction({
        className: "roi-row-delete",
        label: `Delete ${rowView.name}`,
        description: (
          `Delete ${rowView.name}, including its box and selected neurons`
        ),
        onClick: (trigger) => {
          const fallbackRoiId = rows[rowIndex + 1]?.id ?? rows[rowIndex - 1]?.id ?? null;
          closeColorPicker();
          confirmationDialog.open({
            title: `Delete ${rowView.name}?`,
            description: (
              `Delete ${rowView.name}, including its box and selected neurons.`
            ),
            confirmLabel: "Delete ROI",
            confirmDescription: (
              `Delete ${rowView.name}, its box, and its selected neurons`
            ),
            trigger,
            onConfirm: () => deleteRow(rowView.id),
            focusAfterConfirm: () => (
              (fallbackRoiId ? findRoiSelectButton(fallbackRoiId) : null)
              ?? document.querySelector(".roi-row-add-default")
              ?? document.querySelector('#roi-section [data-section-toggle="roi"]')
            ),
          });
        },
      });

      row.appendChild(swatch);
      row.appendChild(boxButton);
      row.appendChild(selectButton);
      row.appendChild(clearButton);
      row.appendChild(deleteButton);
      panel.appendChild(row);
    }

    const nextIndex = rows.length + 1;
    const nextName = `ROI ${nextIndex}`;
    const nextColor = palette[rows.length % palette.length];
    const addRow = document.createElement("div");
    addRow.className = "roi-row roi-row-add";
    addRow.setAttribute("role", "group");
    addRow.setAttribute("aria-label", `${nextName} creation options`);

    const addSwatch = document.createElement("button");
    addSwatch.type = "button";
    addSwatch.className = "roi-row-swatch";
    addSwatch.style.setProperty("--roi-color", nextColor);
    addSwatch.setAttribute("aria-label", `Choose color for ${nextName}`);
    addSwatch.setAttribute("aria-haspopup", "menu");
    addSwatch.setAttribute("aria-expanded", "false");
    addSwatch.dataset.controlDescription = (
      `Choose ${nextName}'s color`
    );
    appendSwatchVisual(addSwatch);
    const showAddColorPicker = (focusFirst = false, focusTarget = "first") => {
      openColorPicker(addRow, addSwatch, {
        palette,
        optionLabel: (color) => `Add ROI with color ${color}`,
        optionDescription: (color) => `Create ${nextName} in ${color}`,
        onSelect: addWithColor,
        focusFirst,
        focusTarget,
      });
    };
    addSwatch.addEventListener("click", (event) => {
      event.stopPropagation();
      showAddColorPicker(event.detail === 0);
    });
    addSwatch.addEventListener("keydown", (event) => {
      if (!["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      showAddColorPicker(true, event.key === "ArrowUp" ? "last" : "first");
    });

    const addBoxButton = makeRowAction({
      className: "roi-row-box",
      label: `Add ${nextName} with box`,
      description: `Create ${nextName} with a box`,
      onClick: () => addWithBox(nextColor),
    });

    const addDefaultButton = document.createElement("button");
    addDefaultButton.type = "button";
    addDefaultButton.className = "roi-row-add-default";
    addDefaultButton.setAttribute("aria-label", `Add ${nextName}`);
    addDefaultButton.dataset.controlDescription = (
      `Create ${nextName} without a box`
    );
    addDefaultButton.textContent = nextName;
    addDefaultButton.addEventListener("click", () => addDefault(nextColor));

    addRow.appendChild(addSwatch);
    addRow.appendChild(addBoxButton);
    addRow.appendChild(addDefaultButton);
    panel.appendChild(addRow);
  }

  return { render };
}
