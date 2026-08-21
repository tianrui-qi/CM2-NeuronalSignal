const TAP_SLOP_PX = 10;
const POINT_EVENT_GRACE_MS = 40;


/**
 * Confirm a blank tap without treating a scroll gesture's pointerdown as an
 * action. Plot owners call `claim()` when their semantic point event fires;
 * otherwise an unmoved pointerup becomes the blank-tap action after a short
 * grace period.
 *
 * @param {{ element: HTMLElement, onBlankTap: () => unknown }} options
 */
export function wireConfirmedBlankTap({ element, onBlankTap }) {
  /** @type {null | { pointerId: number, x: number, y: number, moved: boolean }} */
  let contact = null;
  let pendingTapTimer = null;
  const ownerWindow = element.ownerDocument.defaultView;

  function clearPendingTap() {
    if (pendingTapTimer !== null) {
      ownerWindow?.clearTimeout(pendingTapTimer);
      pendingTapTimer = null;
    }
  }

  function claim() {
    contact = null;
    clearPendingTap();
    return true;
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (!event.isPrimary) {
      contact = null;
      clearPendingTap();
      return;
    }
    if (event.button !== 0) {
      return;
    }
    clearPendingTap();
    contact = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  }

  /** @param {PointerEvent} event */
  function onPointerMove(event) {
    if (!contact || event.pointerId !== contact.pointerId || contact.moved) {
      return;
    }
    contact.moved = (
      Math.abs(event.clientX - contact.x) > TAP_SLOP_PX
      || Math.abs(event.clientY - contact.y) > TAP_SLOP_PX
    );
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (!contact || event.pointerId !== contact.pointerId) {
      return;
    }
    const isTap = !contact.moved;
    contact = null;
    if (!isTap) {
      return;
    }
    clearPendingTap();
    pendingTapTimer = ownerWindow?.setTimeout(() => {
      pendingTapTimer = null;
      onBlankTap();
    }, POINT_EVENT_GRACE_MS) ?? null;
  }

  /** @param {PointerEvent} event */
  function onPointerCancel(event) {
    if (contact?.pointerId === event.pointerId) {
      contact = null;
    }
  }

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerCancel);

  return Object.freeze({
    claim,
    destroy() {
      contact = null;
      clearPendingTap();
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerCancel);
    },
  });
}
