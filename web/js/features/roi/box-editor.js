import { normalizeRoiBox } from "./model.js";

let roiBoxEditorSequence = 0;


/**
 * DOM-only owner for the existing ROI box form. State transitions and render
 * effects remain with its caller.
 *
 * @param {{
 *   document: Document,
 *   FormData?: typeof globalThis.FormData,
 *   setStatus?: (message: string, isError?: boolean) => void,
 * }} dependencies
 */
export function createRoiBoxEditor({
  document,
  FormData: FormDataConstructor = globalThis.FormData,
  setStatus = () => {},
}) {
  /** @type {null | {
   *   dialog: HTMLDialogElement,
   *   trigger: HTMLElement | null,
   *   triggerLabel: string | null,
   * }} */
  let active = null;

  /** @param {{ restoreFocus?: boolean }} [options] */
  function close({ restoreFocus = true } = {}) {
    if (!active) {
      return false;
    }
    const { dialog, trigger, triggerLabel } = active;
    active = null;
    if (dialog.open) {
      dialog.close();
    }
    dialog.remove();
    if (restoreFocus) {
      const focusTarget = trigger?.isConnected
        ? trigger
        : Array.from(document.querySelectorAll("button")).find(
          (button) => button.getAttribute("aria-label") === triggerLabel,
        );
      focusTarget?.focus();
    }
    return true;
  }

  /**
   * @param {{
   *   titleText?: string,
   *   initialBox?: { x: number, y: number, width: number, height: number } | null,
   *   onApply?: (box: { x: number, y: number, width: number, height: number }) => void,
   *   onClear?: (() => void) | null,
   * }} options
   */
  function open({
    titleText = "ROI Box",
    initialBox = null,
    onApply,
    onClear = null,
  }) {
    close({ restoreFocus: false });

    roiBoxEditorSequence += 1;
    const titleId = `roi-box-editor-title-${roiBoxEditorSequence}`;
    const descriptionId = `roi-box-editor-description-${roiBoxEditorSequence}`;
    const trigger = typeof document.activeElement?.focus === "function"
      ? /** @type {HTMLElement} */ (document.activeElement)
      : null;

    const dialog = document.createElement("dialog");
    dialog.className = "confirmation-dialog roi-box-editor";
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", titleId);
    dialog.setAttribute("aria-describedby", descriptionId);

    const form = document.createElement("form");
    form.className = "roi-box-editor-form";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormDataConstructor(form);
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
      close();
      setStatus("");
    });

    const title = document.createElement("h4");
    title.id = titleId;
    title.className = "confirmation-dialog-title roi-box-editor-title";
    title.textContent = titleText;

    const description = document.createElement("p");
    description.id = descriptionId;
    description.className = (
      "confirmation-dialog-description roi-box-editor-description"
    );
    description.textContent = onClear
      ? (
        "Set the box bounds in image pixels. "
        + "Saving removes any selected neurons outside the box."
      )
      : "Set the box bounds in image pixels.";

    const grid = document.createElement("div");
    grid.className = "roi-box-grid";
    const fields = [
      ["x", "X", "Set the box left edge in image pixels"],
      ["y", "Y", "Set the box top edge in image pixels"],
      ["width", "Width", "Set the box width in image pixels"],
      ["height", "Height", "Set the box height in image pixels"],
    ];
    for (const [key, labelText, fieldDescription] of fields) {
      const label = document.createElement("label");
      label.className = "roi-box-field";
      label.textContent = labelText;

      const input = document.createElement("input");
      input.type = "number";
      input.name = key;
      input.step = "any";
      input.required = true;
      input.dataset.controlDescription = fieldDescription;
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
    actions.className = "confirmation-dialog-actions roi-box-actions";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "mini-btn roi-box-cancel";
    cancelButton.textContent = "Cancel";
    cancelButton.setAttribute("aria-label", `Cancel ${titleText}`);
    cancelButton.dataset.controlDescription = "Close this dialog without saving changes";
    cancelButton.addEventListener("click", () => close());

    const applyButton = document.createElement("button");
    applyButton.type = "submit";
    applyButton.className = "mini-btn roi-box-save";
    applyButton.textContent = "Save";
    applyButton.setAttribute("aria-label", `Save ${titleText}`);
    applyButton.dataset.controlDescription = onClear
      ? "Save the box and remove any selected neurons outside it"
      : "Create the ROI with this box";

    if (onClear) {
      const clearButton = document.createElement("button");
      clearButton.type = "button";
      clearButton.className = "mini-btn";
      clearButton.textContent = "Clear";
      clearButton.setAttribute("aria-label", `Clear ${titleText}`);
      clearButton.dataset.controlDescription = (
        "Remove the box; keep the ROI and its selected neurons"
      );
      clearButton.addEventListener("click", () => {
        onClear();
        close();
        setStatus("");
      });
      actions.appendChild(clearButton);
    }
    actions.appendChild(cancelButton);
    actions.appendChild(applyButton);

    form.appendChild(title);
    form.appendChild(description);
    form.appendChild(grid);
    form.appendChild(actions);
    dialog.appendChild(form);

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) {
        return;
      }
      const bounds = dialog.getBoundingClientRect();
      const clickedBackdrop = (
        event.clientX < bounds.left
        || event.clientX > bounds.right
        || event.clientY < bounds.top
        || event.clientY > bounds.bottom
      );
      if (clickedBackdrop) {
        close();
      }
    });

    document.body.appendChild(dialog);
    active = {
      dialog,
      trigger,
      triggerLabel: trigger?.getAttribute("aria-label") ?? null,
    };
    dialog.showModal();
    form.querySelector("input")?.focus();
    return true;
  }

  return Object.freeze({ close, open });
}
