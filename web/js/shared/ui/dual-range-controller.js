const RANGE_ADJUSTMENT_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

const DOUBLE_ACTIVATION_DELAY_MS = 500;
const DOUBLE_ACTIVATION_SLOP_PX = 8;
const GESTURE_CLAIM_SLOP_PX = 8;
const GESTURE_DIRECTION_RATIO = 1.15;
const MOUSE_THUMB_HIT_RADIUS_PX = 12;
const COARSE_THUMB_HIT_RADIUS_PX = 22;


/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


/** @param {HTMLInputElement} input @param {number} value */
function setInputValue(input, value) {
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return false;
  }
  const bounded = clamp(value, min, max);
  const snapped = Number.isFinite(step) && step > 0
    ? min + Math.round((bounded - min) / step) * step
    : bounded;
  const next = String(clamp(snapped, min, max));
  if (input.value === next) {
    return false;
  }
  input.value = next;
  return true;
}


/** @param {HTMLInputElement} input @param {DOMRect} rect */
function inputClientX(input, rect) {
  const min = Number(input.min);
  const max = Number(input.max);
  const value = Number(input.value);
  if (
    !(rect.width > 0)
    || !Number.isFinite(min)
    || !Number.isFinite(max)
    || !Number.isFinite(value)
    || max <= min
  ) {
    return rect.left;
  }
  return rect.left + clamp((value - min) / (max - min), 0, 1) * rect.width;
}


/** @param {PointerEvent} event @param {Record<string, any> | null} previous */
function isDoubleActivation(event, previous) {
  return Boolean(
    previous
    && previous.handle
    && event.timeStamp - previous.timeStamp <= DOUBLE_ACTIVATION_DELAY_MS
    && Math.abs(event.clientX - previous.clientX) <= DOUBLE_ACTIVATION_SLOP_PX
    && Math.abs(event.clientY - previous.clientY) <= DOUBLE_ACTIVATION_SLOP_PX
  );
}


/**
 * Give stacked native range inputs one pointer owner. The controller routes a
 * rail press to the nearest endpoint, alternates exactly overlapping endpoints,
 * preserves native keyboard behavior, and closes every pointer-cancellation
 * path without leaving a stale interaction active.
 *
 * @param {{
 *   container: HTMLElement,
 *   lowerInput: HTMLInputElement,
 *   upperInput: HTMLInputElement,
 *   onInput: (handle: "lower" | "upper", value: string) => unknown,
 *   onInteractionStart?: (handle: "lower" | "upper", modality: "pointer" | "keyboard") => unknown,
 *   onInteractionEnd?: (options: { handle: "lower" | "upper", modality: "pointer" | "keyboard", canceled: boolean }) => unknown,
 *   onDoubleActivate?: ((handle: "lower" | "upper") => unknown) | null,
 * }} options
 */
export function wireDualRangeController({
  container,
  lowerInput,
  upperInput,
  onInput,
  onInteractionStart = () => {},
  onInteractionEnd = () => {},
  onDoubleActivate = null,
}) {
  let activePointerId = null;
  /** @type {"lower" | "upper" | null} */
  let activeHandle = null;
  /** @type {"lower" | "upper"} */
  let lastPointerHandle = "upper";
  /** @type {Record<string, any> | null} */
  let previousThumbActivation = null;
  /** @type {null | {
   *   pointerId: number,
   *   handle: "lower" | "upper",
   *   thumbHandle: "lower" | "upper" | null,
   *   startX: number,
   *   startY: number,
   *   lowerValue: string,
   *   upperValue: string,
   * }} */
  let pendingPointer = null;
  /** @type {null | { pointerId: number, lowerValue: string, upperValue: string }} */
  let rejectedPointer = null;
  let rejectedPointerTimer = null;
  /** @type {"lower" | "upper" | null} */
  let keyboardHandle = null;
  let keyboardBlurTimer = null;
  let suppressDoubleClickUntil = -Infinity;
  let suppressClickUntil = -Infinity;
  let destroyed = false;
  let pointerFrame = null;
  let pendingClientX = null;
  const ownerDocument = container.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;

  const inputForHandle = (handle) => (
    handle === "lower" ? lowerInput : upperInput
  );

  /** @param {EventTarget | null} target */
  function handleForTarget(target) {
    if (target === lowerInput) {
      return "lower";
    }
    if (target === upperInput) {
      return "upper";
    }
    return null;
  }

  /** @param {number} clientX */
  function nearestHandle(clientX) {
    const rect = container.getBoundingClientRect();
    const lowerDistance = Math.abs(clientX - inputClientX(lowerInput, rect));
    const upperDistance = Math.abs(clientX - inputClientX(upperInput, rect));
    if (Math.abs(lowerDistance - upperDistance) < 0.5) {
      return lastPointerHandle === "lower" ? "upper" : "lower";
    }
    return lowerDistance < upperDistance ? "lower" : "upper";
  }

  /**
   * Native range inputs cover the complete rail, so `event.target` cannot tell
   * whether a press landed on a thumb. Resolve that from the rendered endpoint
   * positions and keep the touch/pen hit radius large enough for a 44px target.
   *
   * @param {PointerEvent} event
   */
  function pressedThumb(event) {
    const rect = container.getBoundingClientRect();
    const radius = event.pointerType === "mouse"
      ? MOUSE_THUMB_HIT_RADIUS_PX
      : COARSE_THUMB_HIT_RADIUS_PX;
    const lowerDistance = Math.abs(event.clientX - inputClientX(lowerInput, rect));
    const upperDistance = Math.abs(event.clientX - inputClientX(upperInput, rect));
    const nearestDistance = Math.min(lowerDistance, upperDistance);
    if (nearestDistance > radius) {
      return null;
    }
    if (Math.abs(lowerDistance - upperDistance) < 0.5) {
      return lastPointerHandle === "lower" ? "upper" : "lower";
    }
    return lowerDistance < upperDistance ? "lower" : "upper";
  }

  /** @param {NonNullable<typeof pendingPointer>} pointer */
  function restorePendingValues(pointer) {
    lowerInput.value = pointer.lowerValue;
    upperInput.value = pointer.upperValue;
  }

  function cancelPendingPointer() {
    if (!pendingPointer) {
      return false;
    }
    restorePendingValues(pendingPointer);
    pendingPointer = null;
    previousThumbActivation = null;
    return true;
  }

  function clearRejectedPointer() {
    if (rejectedPointerTimer !== null) {
      ownerWindow?.clearTimeout(rejectedPointerTimer);
      rejectedPointerTimer = null;
    }
    const hadRejectedPointer = rejectedPointer !== null;
    if (rejectedPointer) {
      lowerInput.value = rejectedPointer.lowerValue;
      upperInput.value = rejectedPointer.upperValue;
    }
    rejectedPointer = null;
    return hadRejectedPointer;
  }

  /** @param {NonNullable<typeof pendingPointer>} pointer */
  function rejectPendingPointer(pointer) {
    restorePendingValues(pointer);
    pendingPointer = null;
    previousThumbActivation = null;
    rejectedPointer = {
      pointerId: pointer.pointerId,
      lowerValue: pointer.lowerValue,
      upperValue: pointer.upperValue,
    };
  }

  function releaseRejectedPointerSoon() {
    if (rejectedPointerTimer !== null) {
      ownerWindow?.clearTimeout(rejectedPointerTimer);
    }
    rejectedPointerTimer = ownerWindow?.setTimeout(clearRejectedPointer, 0) ?? null;
  }

  /** @param {PointerEvent} event @param {"lower" | "upper"} handle */
  function claimPointer(event, handle) {
    activeHandle = handle;
    lastPointerHandle = handle;
    activePointerId = event.pointerId;
    previousThumbActivation = null;
    inputForHandle(handle).focus({ preventScroll: true });
    container.setPointerCapture(event.pointerId);
    onInteractionStart(handle, "pointer");
    if (event.pointerType !== "mouse") {
      suppressClickUntil = event.timeStamp + DOUBLE_ACTIVATION_DELAY_MS;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
  }

  /** @param {number} clientX */
  function updateFromPointer(clientX) {
    if (!activeHandle) {
      return false;
    }
    const input = inputForHandle(activeHandle);
    const rect = container.getBoundingClientRect();
    const min = Number(input.min);
    const max = Number(input.max);
    if (!(rect.width > 0) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      return false;
    }
    const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
    if (setInputValue(input, min + fraction * (max - min))) {
      onInput(activeHandle, input.value);
      return true;
    }
    return false;
  }

  function discardPointerUpdate() {
    if (pointerFrame !== null) {
      ownerWindow?.cancelAnimationFrame(pointerFrame);
    }
    pointerFrame = null;
    pendingClientX = null;
  }

  /** @param {number} [finalClientX] */
  function flushPointerUpdate(finalClientX) {
    if (Number.isFinite(finalClientX)) {
      pendingClientX = finalClientX;
    }
    const clientX = pendingClientX;
    discardPointerUpdate();
    return Number.isFinite(clientX)
      ? updateFromPointer(/** @type {number} */ (clientX))
      : false;
  }

  /** @param {number} clientX */
  function schedulePointerUpdate(clientX) {
    pendingClientX = clientX;
    if (pointerFrame !== null) {
      return;
    }
    if (!ownerWindow?.requestAnimationFrame) {
      flushPointerUpdate();
      return;
    }
    pointerFrame = ownerWindow.requestAnimationFrame(() => {
      pointerFrame = null;
      const scheduledClientX = pendingClientX;
      pendingClientX = null;
      if (activePointerId !== null && activeHandle && Number.isFinite(scheduledClientX)) {
        updateFromPointer(/** @type {number} */ (scheduledClientX));
      }
    });
  }

  /** @param {PointerEvent} event @param {boolean} canceled */
  function endPointer(event, canceled) {
    if (event.pointerId !== activePointerId || !activeHandle) {
      return false;
    }
    if (canceled) {
      discardPointerUpdate();
    } else {
      flushPointerUpdate(event.clientX);
    }
    const endedHandle = activeHandle;
    activePointerId = null;
    activeHandle = null;
    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }
    onInteractionEnd({
      handle: endedHandle,
      modality: "pointer",
      canceled,
    });
    return true;
  }

  function cancelPointerInteraction() {
    if (activePointerId === null || !activeHandle) {
      return false;
    }
    const endedHandle = activeHandle;
    const pointerId = activePointerId;
    discardPointerUpdate();
    activePointerId = null;
    activeHandle = null;
    previousThumbActivation = null;
    if (container.hasPointerCapture(pointerId)) {
      container.releasePointerCapture(pointerId);
    }
    onInteractionEnd({
      handle: endedHandle,
      modality: "pointer",
      canceled: true,
    });
    return true;
  }

  function clearKeyboardBlurTimer() {
    if (keyboardBlurTimer !== null) {
      ownerWindow?.clearTimeout(keyboardBlurTimer);
      keyboardBlurTimer = null;
    }
  }

  /** @param {boolean} canceled */
  function endKeyboardInteraction(canceled) {
    if (!keyboardHandle) {
      clearKeyboardBlurTimer();
      return false;
    }
    const endedHandle = keyboardHandle;
    keyboardHandle = null;
    clearKeyboardBlurTimer();
    onInteractionEnd({
      handle: endedHandle,
      modality: "keyboard",
      canceled,
    });
    return true;
  }

  function cancelActiveInteraction() {
    const pendingCanceled = cancelPendingPointer();
    const rejectedCanceled = clearRejectedPointer();
    const pointerCanceled = cancelPointerInteraction();
    const keyboardCanceled = endKeyboardInteraction(true);
    return pendingCanceled || rejectedCanceled || pointerCanceled || keyboardCanceled;
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (
      destroyed
      || activePointerId !== null
      || pendingPointer !== null
      || rejectedPointer !== null
      || !event.isPrimary
      || event.button !== 0
      || lowerInput.disabled
      || upperInput.disabled
    ) {
      return;
    }
    endKeyboardInteraction(false);
    const thumbHandle = pressedThumb(event);
    const handle = thumbHandle ?? nearestHandle(event.clientX);

    if (event.pointerType !== "mouse") {
      pendingPointer = {
        pointerId: event.pointerId,
        handle,
        thumbHandle,
        startX: event.clientX,
        startY: event.clientY,
        lowerValue: lowerInput.value,
        upperValue: upperInput.value,
      };
      return;
    }

    const repeatedHandle = previousThumbActivation?.handle ?? null;
    if (
      repeatedHandle
      && onDoubleActivate
      && isDoubleActivation(event, previousThumbActivation)
    ) {
      previousThumbActivation = null;
      suppressDoubleClickUntil = event.timeStamp + DOUBLE_ACTIVATION_DELAY_MS;
      inputForHandle(repeatedHandle).focus({ preventScroll: true });
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();
      onDoubleActivate(repeatedHandle);
      return;
    }

    claimPointer(event, handle);
    previousThumbActivation = thumbHandle
      ? {
          handle: thumbHandle,
          timeStamp: event.timeStamp,
          clientX: event.clientX,
          clientY: event.clientY,
        }
      : null;
    if (!thumbHandle) {
      schedulePointerUpdate(event.clientX);
    }
  }

  /** @param {PointerEvent} event */
  function onPointerMove(event) {
    if (pendingPointer?.pointerId === event.pointerId) {
      const pointer = pendingPointer;
      const deltaX = Math.abs(event.clientX - pointer.startX);
      const deltaY = Math.abs(event.clientY - pointer.startY);
      if (Math.max(deltaX, deltaY) <= GESTURE_CLAIM_SLOP_PX) {
        return;
      }
      if (deltaY >= deltaX * GESTURE_DIRECTION_RATIO) {
        rejectPendingPointer(pointer);
        return;
      }
      if (deltaX < deltaY * GESTURE_DIRECTION_RATIO) {
        return;
      }
      restorePendingValues(pointer);
      pendingPointer = null;
      claimPointer(event, pointer.handle);
      schedulePointerUpdate(event.clientX);
      return;
    }
    if (event.pointerId !== activePointerId || !activeHandle) {
      return;
    }
    if (
      previousThumbActivation
      && (
        Math.abs(event.clientX - previousThumbActivation.clientX)
          > DOUBLE_ACTIVATION_SLOP_PX
        || Math.abs(event.clientY - previousThumbActivation.clientY)
          > DOUBLE_ACTIVATION_SLOP_PX
      )
    ) {
      previousThumbActivation = null;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    schedulePointerUpdate(event.clientX);
  }

  /** @param {Event} event */
  function onNativeInput(event) {
    const handle = handleForTarget(event.currentTarget);
    if (!handle || activePointerId !== null) {
      return;
    }
    if (pendingPointer) {
      restorePendingValues(pendingPointer);
      return;
    }
    if (rejectedPointer) {
      lowerInput.value = rejectedPointer.lowerValue;
      upperInput.value = rejectedPointer.upperValue;
      return;
    }
    const input = inputForHandle(handle);
    const isStandaloneAdjustment = keyboardHandle === null;
    if (isStandaloneAdjustment) {
      onInteractionStart(handle, "keyboard");
    }
    onInput(handle, input.value);
    if (isStandaloneAdjustment) {
      onInteractionEnd({ handle, modality: "keyboard", canceled: false });
    }
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const handle = handleForTarget(event.currentTarget);
    if (!handle || activePointerId !== null || pendingPointer || rejectedPointer) {
      return;
    }
    if (RANGE_ADJUSTMENT_KEYS.has(event.key) && keyboardHandle !== handle) {
      endKeyboardInteraction(false);
      keyboardHandle = handle;
      onInteractionStart(handle, "keyboard");
    }
    if (event.key === "Escape" && keyboardHandle === handle) {
      endKeyboardInteraction(true);
    }
  }

  /** @param {KeyboardEvent} event */
  function onKeyUp(event) {
    const handle = handleForTarget(event.currentTarget);
    if (!handle || keyboardHandle !== handle || !RANGE_ADJUSTMENT_KEYS.has(event.key)) {
      return;
    }
    endKeyboardInteraction(false);
  }

  /** @param {FocusEvent} event */
  function onBlur(event) {
    const handle = handleForTarget(event.currentTarget);
    if (!handle || keyboardHandle !== handle) {
      return;
    }
    clearKeyboardBlurTimer();
    keyboardBlurTimer = ownerWindow?.setTimeout(
      () => endKeyboardInteraction(false),
      0,
    ) ?? null;
  }

  /** @param {MouseEvent} event */
  function onDoubleClick(event) {
    const handle = handleForTarget(event.currentTarget);
    if (!handle || !onDoubleActivate) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.timeStamp <= suppressDoubleClickUntil) {
      suppressDoubleClickUntil = -Infinity;
      return;
    }
    previousThumbActivation = null;
    onDoubleActivate(handle);
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (rejectedPointer?.pointerId === event.pointerId) {
      lowerInput.value = rejectedPointer.lowerValue;
      upperInput.value = rejectedPointer.upperValue;
      releaseRejectedPointerSoon();
      return;
    }
    if (pendingPointer?.pointerId === event.pointerId) {
      const pointer = pendingPointer;
      const deltaX = Math.abs(event.clientX - pointer.startX);
      const deltaY = Math.abs(event.clientY - pointer.startY);
      restorePendingValues(pointer);
      pendingPointer = null;
      if (Math.max(deltaX, deltaY) > GESTURE_CLAIM_SLOP_PX) {
        rejectPendingPointer(pointer);
        releaseRejectedPointerSoon();
        return;
      }

      suppressClickUntil = event.timeStamp + DOUBLE_ACTIVATION_DELAY_MS;
      const repeatedHandle = previousThumbActivation?.handle ?? null;
      if (
        pointer.thumbHandle
        && repeatedHandle
        && onDoubleActivate
        && isDoubleActivation(event, previousThumbActivation)
      ) {
        previousThumbActivation = null;
        suppressDoubleClickUntil = suppressClickUntil;
        inputForHandle(repeatedHandle).focus({ preventScroll: true });
        if (event.cancelable) {
          event.preventDefault();
        }
        event.stopPropagation();
        onDoubleActivate(repeatedHandle);
        return;
      }

      lastPointerHandle = pointer.handle;
      inputForHandle(pointer.handle).focus({ preventScroll: true });
      onInteractionStart(pointer.handle, "pointer");
      if (!pointer.thumbHandle) {
        activeHandle = pointer.handle;
        updateFromPointer(event.clientX);
        activeHandle = null;
      }
      onInteractionEnd({
        handle: pointer.handle,
        modality: "pointer",
        canceled: false,
      });
      previousThumbActivation = pointer.thumbHandle
        ? {
            handle: pointer.thumbHandle,
            timeStamp: event.timeStamp,
            clientX: event.clientX,
            clientY: event.clientY,
          }
        : null;
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();
      return;
    }
    endPointer(event, false);
  }

  /** @param {PointerEvent} event */
  function onPointerCancel(event) {
    if (rejectedPointer?.pointerId === event.pointerId) {
      releaseRejectedPointerSoon();
      return;
    }
    if (pendingPointer?.pointerId === event.pointerId) {
      rejectPendingPointer(pendingPointer);
      releaseRejectedPointerSoon();
      return;
    }
    if (event.pointerId === activePointerId) {
      cancelActiveInteraction();
    }
  }

  /** @param {MouseEvent} event */
  function onClick(event) {
    if (event.timeStamp > suppressClickUntil) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  /** @param {PointerEvent} event */
  function onLostPointerCapture(event) {
    if (event.pointerId === activePointerId) {
      cancelPointerInteraction();
    }
  }

  function onVisibilityChange() {
    if (ownerDocument.visibilityState === "hidden") {
      cancelActiveInteraction();
    }
  }

  container.addEventListener("pointerdown", onPointerDown, true);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerCancel);
  container.addEventListener("lostpointercapture", onLostPointerCapture);
  container.addEventListener("click", onClick, true);
  ownerWindow?.addEventListener("blur", cancelActiveInteraction);
  ownerWindow?.addEventListener("pagehide", cancelActiveInteraction, true);
  ownerWindow?.addEventListener("orientationchange", cancelActiveInteraction);
  ownerDocument.addEventListener("visibilitychange", onVisibilityChange);

  for (const input of [lowerInput, upperInput]) {
    input.addEventListener("input", onNativeInput);
    input.addEventListener("keydown", onKeyDown);
    input.addEventListener("keyup", onKeyUp);
    input.addEventListener("blur", onBlur);
    input.addEventListener("dblclick", onDoubleClick);
  }

  return Object.freeze({
    destroy() {
      if (destroyed) {
        return false;
      }
      cancelActiveInteraction();
      destroyed = true;
      container.removeEventListener("pointerdown", onPointerDown, true);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("pointercancel", onPointerCancel);
      container.removeEventListener("lostpointercapture", onLostPointerCapture);
      container.removeEventListener("click", onClick, true);
      ownerWindow?.removeEventListener("blur", cancelActiveInteraction);
      ownerWindow?.removeEventListener("pagehide", cancelActiveInteraction, true);
      ownerWindow?.removeEventListener("orientationchange", cancelActiveInteraction);
      ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
      for (const input of [lowerInput, upperInput]) {
        input.removeEventListener("input", onNativeInput);
        input.removeEventListener("keydown", onKeyDown);
        input.removeEventListener("keyup", onKeyUp);
        input.removeEventListener("blur", onBlur);
        input.removeEventListener("dblclick", onDoubleClick);
      }
      return true;
    },
  });
}
