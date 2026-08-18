const DEFAULT_GAP_PX = 8;
const DEFAULT_PADDING_PX = 8;
const DEFAULT_MAX_HEIGHT_PX = 300;


/**
 * Choose a vertical side without coupling popup geometry to a feature.
 *
 * @param {{
 *   spaceAbove: number,
 *   spaceBelow: number,
 *   desiredHeight: number,
 *   preferred?: "up" | "down",
 * }} options
 */
export function chooseVerticalPopoverPlacement({
  spaceAbove,
  spaceBelow,
  desiredHeight,
  preferred = "down",
}) {
  const preferredSpace = preferred === "up" ? spaceAbove : spaceBelow;
  const alternateSpace = preferred === "up" ? spaceBelow : spaceAbove;
  if (preferredSpace >= desiredHeight) {
    return preferred;
  }
  if (alternateSpace >= desiredHeight) {
    return preferred === "up" ? "down" : "up";
  }
  return spaceBelow >= spaceAbove ? "down" : "up";
}


/**
 * Place an absolutely positioned popup above or below its anchor while
 * respecting both the viewport and the workflow scrollport that clips it.
 *
 * @param {{
 *   popup: HTMLElement,
 *   anchor: HTMLElement,
 *   boundary?: HTMLElement | null,
 *   preferred?: "up" | "down",
 *   gap?: number,
 *   padding?: number,
 *   maxHeight?: number,
 *   window?: Window | null,
 * }} options
 */
export function placeAnchoredPopover({
  popup,
  anchor,
  boundary = null,
  preferred = "down",
  gap = DEFAULT_GAP_PX,
  padding = DEFAULT_PADDING_PX,
  maxHeight = DEFAULT_MAX_HEIGHT_PX,
  window = popup.ownerDocument.defaultView,
}) {
  if (!window || !popup.isConnected || !anchor.isConnected) {
    return null;
  }

  popup.style.removeProperty("--anchored-popover-available-height");
  popup.dataset.placement = preferred;

  const anchorRect = anchor.getBoundingClientRect();
  const boundaryRect = boundary?.getBoundingClientRect() ?? null;
  const viewportTop = padding;
  const viewportBottom = Math.max(viewportTop, window.innerHeight - padding);
  const effectiveTop = Math.max(
    viewportTop,
    boundaryRect ? boundaryRect.top + padding : viewportTop,
  );
  const effectiveBottom = Math.min(
    viewportBottom,
    boundaryRect ? boundaryRect.bottom - padding : viewportBottom,
  );
  const spaceAbove = Math.max(0, anchorRect.top - gap - effectiveTop);
  const spaceBelow = Math.max(0, effectiveBottom - anchorRect.bottom - gap);
  const popupRect = popup.getBoundingClientRect();
  const naturalHeight = Math.max(popup.scrollHeight, popupRect.height);
  const desiredHeight = Math.min(maxHeight, naturalHeight);
  const placement = chooseVerticalPopoverPlacement({
    spaceAbove,
    spaceBelow,
    desiredHeight,
    preferred,
  });
  const availableHeight = placement === "up" ? spaceAbove : spaceBelow;

  popup.dataset.placement = placement;
  popup.style.setProperty(
    "--anchored-popover-available-height",
    `${Math.max(0, Math.floor(Math.min(maxHeight, availableHeight)))}px`,
  );
  return {
    placement,
    availableHeight,
    spaceAbove,
    spaceBelow,
  };
}
