/**
 * @typedef {{
 *   key: string,
 *   label: string,
 *   description?: string,
 *   disabled?: boolean,
 * }} SegmentedControlOption
 */

/**
 * Render a caller-styled segmented control without taking ownership of the
 * container's layout or accessibility semantics.
 *
 * @param {{
 *   document: Document,
 *   container: HTMLElement,
 *   options: SegmentedControlOption[],
 *   activeKey: string | null,
 *   onSelect: (key: string) => void,
 *   buttonClassName: string,
 *   activeClassName: string,
 *   selectionAttribute: string | null,
 * }} config
 */
export function renderSegmentedControl({
  document,
  container,
  options,
  activeKey,
  onSelect,
  buttonClassName,
  activeClassName,
  selectionAttribute,
}) {
  container.replaceChildren();

  for (const option of options) {
    const isActive = option.key === activeKey;
    const button = document.createElement("button");
    button.type = "button";
    button.className = buttonClassName;
    button.classList.toggle(activeClassName, isActive);
    button.textContent = option.label;
    if (option.description) {
      button.setAttribute("data-control-description", option.description);
    }
    if (selectionAttribute) {
      button.setAttribute(selectionAttribute, String(isActive));
    }
    if (option.disabled !== undefined) {
      button.disabled = Boolean(option.disabled);
    }
    button.addEventListener("click", () => onSelect(option.key));
    container.appendChild(button);
  }
}
