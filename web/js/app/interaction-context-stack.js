/** @param {Element | null} element */
function isTextEditingElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return true;
  }
  if (!(element instanceof HTMLInputElement)) {
    return false;
  }
  return !["button", "checkbox", "radio", "reset", "submit"].includes(element.type);
}

/** @param {Element | null} element */
function isVisiblePopover(element) {
  return Boolean(
    element
    && !element.classList.contains("hidden")
    && element.getAttribute("aria-hidden") !== "true"
  );
}

/**
 * Resolve interaction ownership from the highest-priority transient surface
 * down to the global viewer context. The stack is runtime-only.
 *
 * @param {{
 *   document?: Document,
 *   isRegionDrawing?: () => boolean,
 *   hasPlotInspector?: () => boolean,
 * }} options
 */
export function createInteractionContextStack({
  document: documentRef = globalThis.document,
  isRegionDrawing = () => false,
  hasPlotInspector = () => false,
} = {}) {
  function activeContexts() {
    const activeElement = documentRef.activeElement;
    if (documentRef.querySelector("dialog[open]")) {
      return ["dialog"];
    }
    if ([...documentRef.querySelectorAll(".anchored-popover, [role='listbox']")]
      .some(isVisiblePopover)) {
      return ["popover"];
    }
    if (isTextEditingElement(activeElement)) {
      return ["textInput"];
    }

    const contexts = [];
    if (isRegionDrawing()) {
      contexts.push("regionDraw");
    }
    if (hasPlotInspector()) {
      contexts.push("plotInspector");
    }
    if (activeElement === documentRef.getElementById("map-plot")) {
      contexts.push("map");
    }
    contexts.push("global");
    return contexts;
  }

  return Object.freeze({
    activeContexts,
  });
}
