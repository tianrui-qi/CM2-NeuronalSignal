export const CONTROL_DESCRIPTION_ATTRIBUTE = "data-control-description";

const CONTROL_SELECTOR = `[${CONTROL_DESCRIPTION_ATTRIBUTE}]`;
const TOOLTIP_ID = "cm2-control-tooltip";
const HOVER_DELAY_MS = 700;
const VIEWPORT_PADDING_PX = 8;
const ANCHOR_GAP_PX = 8;


/**
 * Attach concise instructional copy to a project-owned interactive control.
 * The accessible name remains independently owned by visible text or an
 * `aria-label`; the shared tooltip exposes this copy as its description.
 * Copy uses sentence case without terminal punctuation.
 *
 * @param {HTMLElement} element
 * @param {unknown} description
 */
export function describeControl(element, description) {
  const text = typeof description === "string" ? description.trim() : "";
  if (text) {
    element.setAttribute(CONTROL_DESCRIPTION_ATTRIBUTE, text);
  } else {
    element.removeAttribute(CONTROL_DESCRIPTION_ATTRIBUTE);
  }
  // Avoid displaying a second, delayed native tooltip over the shared one.
  element.removeAttribute("title");
  return element;
}


/** @param {unknown} value */
function asElement(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (/** @type {{ nodeType?: unknown }} */ (value).nodeType === 1) {
    return /** @type {Element} */ (value);
  }
  return /** @type {{ parentElement?: Element | null }} */ (value).parentElement ?? null;
}


/**
 * A single delegated tooltip keeps dynamically rebuilt feature controls
 * covered without observing or scanning the DOM. Only explicitly described
 * controls participate, so Plotly's own modebar buttons remain untouched.
 *
 * @param {{ document: Document, window: Window }} dependencies
 */
export function createControlTooltip({ document, window }) {
  /** @type {HTMLElement | null} */
  let tooltip = null;
  /** @type {HTMLElement | null} */
  let activeControl = null;
  /** @type {HTMLElement | null} */
  let hoveredControl = null;
  /** @type {number | null} */
  let showTimer = null;
  /** @type {string | null} */
  let recentPointerType = null;
  let started = false;

  function ensureTooltip() {
    if (tooltip) {
      return tooltip;
    }
    const existing = document.getElementById(TOOLTIP_ID);
    tooltip = existing ?? document.createElement("div");
    tooltip.id = TOOLTIP_ID;
    tooltip.className = "control-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    if (!tooltip.parentElement) {
      document.body.appendChild(tooltip);
    }
    return tooltip;
  }

  function clearShowTimer() {
    if (showTimer !== null) {
      window.clearTimeout(showTimer);
      showTimer = null;
    }
  }

  /** @param {HTMLElement | null} control */
  function unlinkDescription(control) {
    if (!control) {
      return;
    }
    const tokens = (control.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((token) => token && token !== TOOLTIP_ID);
    if (tokens.length) {
      control.setAttribute("aria-describedby", tokens.join(" "));
    } else {
      control.removeAttribute("aria-describedby");
    }
  }

  /** @param {HTMLElement} control */
  function linkDescription(control) {
    const tokens = (control.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter(Boolean);
    if (!tokens.includes(TOOLTIP_ID)) {
      tokens.push(TOOLTIP_ID);
      control.setAttribute("aria-describedby", tokens.join(" "));
    }
  }

  function moveTooltipToBody() {
    const element = ensureTooltip();
    element.removeAttribute("data-dialog-layer");
    if (element.parentElement !== document.body) {
      document.body.appendChild(element);
    }
  }

  /** @param {HTMLElement} control */
  function moveTooltipToControlLayer(control) {
    const element = ensureTooltip();
    const dialog = control.closest("dialog[open]");
    const host = dialog instanceof HTMLElement ? dialog : document.body;
    element.toggleAttribute("data-dialog-layer", host !== document.body);
    if (element.parentElement !== host) {
      host.appendChild(element);
    }
  }

  function hide() {
    clearShowTimer();
    unlinkDescription(activeControl);
    activeControl = null;
    const element = ensureTooltip();
    element.hidden = true;
    element.textContent = "";
    element.style.removeProperty("left");
    element.style.removeProperty("top");
    moveTooltipToBody();
  }

  /** @param {HTMLElement} control */
  function position(control) {
    const element = ensureTooltip();
    const anchorRect = control.getBoundingClientRect();
    const tooltipRect = element.getBoundingClientRect();
    const dialog = element.hasAttribute("data-dialog-layer")
      ? /** @type {HTMLDialogElement | null} */ (control.closest("dialog[open]"))
      : null;
    if (dialog) {
      const dialogRect = dialog.getBoundingClientRect();
      const visibleLeft = dialog.scrollLeft + VIEWPORT_PADDING_PX;
      const visibleTop = dialog.scrollTop + VIEWPORT_PADDING_PX;
      const visibleRight = dialog.scrollLeft + dialog.clientWidth - VIEWPORT_PADDING_PX;
      const visibleBottom = dialog.scrollTop + dialog.clientHeight - VIEWPORT_PADDING_PX;
      const centeredLeft = (
        anchorRect.left
        - dialogRect.left
        + dialog.scrollLeft
        + (anchorRect.width - tooltipRect.width) / 2
      );
      const left = Math.min(
        Math.max(visibleLeft, visibleRight - tooltipRect.width),
        Math.max(visibleLeft, centeredLeft),
      );
      const below = (
        anchorRect.bottom
        - dialogRect.top
        + dialog.scrollTop
        + ANCHOR_GAP_PX
      );
      const above = (
        anchorRect.top
        - dialogRect.top
        + dialog.scrollTop
        - tooltipRect.height
        - ANCHOR_GAP_PX
      );
      const preferredTop = below + tooltipRect.height <= visibleBottom
        ? below
        : above;
      const top = Math.min(
        Math.max(visibleTop, visibleBottom - tooltipRect.height),
        Math.max(visibleTop, preferredTop),
      );
      element.style.left = `${Math.round(left)}px`;
      element.style.top = `${Math.round(top)}px`;
      return;
    }
    const viewportWidth = Math.max(0, window.innerWidth);
    const viewportHeight = Math.max(0, window.innerHeight);
    const maxLeft = Math.max(
      VIEWPORT_PADDING_PX,
      viewportWidth - tooltipRect.width - VIEWPORT_PADDING_PX,
    );
    const centeredLeft = anchorRect.left + (anchorRect.width - tooltipRect.width) / 2;
    const left = Math.min(maxLeft, Math.max(VIEWPORT_PADDING_PX, centeredLeft));
    const below = anchorRect.bottom + ANCHOR_GAP_PX;
    const above = anchorRect.top - tooltipRect.height - ANCHOR_GAP_PX;
    const top = below + tooltipRect.height <= viewportHeight - VIEWPORT_PADDING_PX
      ? below
      : Math.max(VIEWPORT_PADDING_PX, above);
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  /** @param {HTMLElement} control */
  function show(control) {
    const description = control.getAttribute(CONTROL_DESCRIPTION_ATTRIBUTE)?.trim();
    if (!description || !control.isConnected) {
      return;
    }
    clearShowTimer();
    if (activeControl && activeControl !== control) {
      unlinkDescription(activeControl);
    }
    activeControl = control;
    const element = ensureTooltip();
    moveTooltipToControlLayer(control);
    element.textContent = description;
    element.hidden = false;
    linkDescription(control);
    position(control);
  }

  /** @param {HTMLElement} control */
  function scheduleShow(control) {
    clearShowTimer();
    showTimer = window.setTimeout(() => {
      showTimer = null;
      if (hoveredControl === control) {
        show(control);
      }
    }, HOVER_DELAY_MS);
  }

  /** @param {unknown} target */
  function findControl(target) {
    const element = asElement(target);
    return /** @type {HTMLElement | null} */ (element?.closest(CONTROL_SELECTOR) ?? null);
  }

  /** @param {PointerEvent} event */
  function onPointerOver(event) {
    if (event.pointerType && event.pointerType !== "mouse") {
      return;
    }
    const control = findControl(event.target);
    if (!control || control === hoveredControl) {
      return;
    }
    hoveredControl = control;
    if (activeControl && activeControl !== control) {
      hide();
    }
    scheduleShow(control);
  }

  /** @param {PointerEvent} event */
  function onPointerOut(event) {
    const control = findControl(event.target);
    if (!control || control !== hoveredControl) {
      return;
    }
    const relatedControl = findControl(event.relatedTarget);
    if (relatedControl === control) {
      return;
    }
    hoveredControl = relatedControl;
    if (activeControl === control || !relatedControl) {
      hide();
    }
    if (relatedControl) {
      scheduleShow(relatedControl);
    }
  }

  /** @param {FocusEvent} event */
  function onFocusIn(event) {
    if (recentPointerType) {
      return;
    }
    const control = findControl(event.target);
    if (control) {
      show(control);
    }
  }

  /** @param {FocusEvent} event */
  function onFocusOut(event) {
    const control = findControl(event.target);
    if (control && activeControl === control) {
      hide();
    }
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    recentPointerType = null;
    if (event.key === "Escape") {
      hoveredControl = null;
      hide();
    }
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    recentPointerType = event.pointerType || "mouse";
    hide();
  }

  function onViewportChange() {
    hoveredControl = null;
    hide();
  }

  function start() {
    if (started) {
      return false;
    }
    started = true;
    ensureTooltip();
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return true;
  }

  return Object.freeze({ start });
}
