import { normalizeRoiBox } from "./model.js";


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
  function close() {
    document.querySelector(".roi-box-editor-backdrop")?.remove();
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
    close();

    const backdrop = document.createElement("div");
    backdrop.className = "roi-box-editor-backdrop";

    const panel = document.createElement("form");
    panel.className = "roi-box-editor";
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      const formData = new FormDataConstructor(panel);
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

    const header = document.createElement("div");
    header.className = "roi-box-editor-header";

    const title = document.createElement("h4");
    title.textContent = titleText;
    header.appendChild(title);

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "roi-box-editor-icon";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", `Close ${titleText}`);
    closeButton.dataset.controlDescription = (
      "Close without applying changes"
    );
    closeButton.addEventListener("click", close);
    header.appendChild(closeButton);

    const grid = document.createElement("div");
    grid.className = "roi-box-grid";
    const fields = [
      ["x", "X", "Box left edge in image pixels"],
      ["y", "Y", "Box top edge in image pixels"],
      ["width", "Width", "Box width in image pixels"],
      ["height", "Height", "Box height in image pixels"],
    ];
    for (const [key, labelText, description] of fields) {
      const label = document.createElement("label");
      label.className = "roi-box-field";
      label.textContent = labelText;

      const input = document.createElement("input");
      input.type = "number";
      input.name = key;
      input.step = "any";
      input.required = true;
      input.dataset.controlDescription = description;
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

    const applyButton = document.createElement("button");
    applyButton.type = "submit";
    applyButton.className = "mini-btn";
    applyButton.textContent = "Apply";
    applyButton.setAttribute("aria-label", `Apply ${titleText}`);
    applyButton.dataset.controlDescription = onClear
      ? "Apply this box and remove selected neurons outside it"
      : "Create the ROI with this box";

    if (onClear) {
      const clearButton = document.createElement("button");
      clearButton.type = "button";
      clearButton.className = "mini-btn";
      clearButton.textContent = "Clear";
      clearButton.setAttribute("aria-label", `Clear ${titleText}`);
      clearButton.dataset.controlDescription = (
        "Remove this box; keep the ROI and its selected neurons"
      );
      clearButton.addEventListener("click", () => {
        onClear();
        close();
        setStatus("");
      });
      actions.appendChild(clearButton);
    }
    actions.appendChild(applyButton);
    panel.appendChild(header);
    panel.appendChild(grid);
    panel.appendChild(actions);
    backdrop.appendChild(panel);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        close();
      }
    });
    document.body.appendChild(backdrop);
    panel.querySelector("input")?.focus();
  }

  return Object.freeze({ close, open });
}
