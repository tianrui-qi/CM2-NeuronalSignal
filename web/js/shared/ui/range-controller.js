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

const GESTURE_CLAIM_SLOP_PX = 8;
const GESTURE_DIRECTION_RATIO = 1.15;
const SYNTHETIC_CLICK_WINDOW_MS = 500;


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
  const nextValue = String(clamp(snapped, min, max));
  if (nextValue === input.value) {
    return false;
  }
  input.value = nextValue;
  return true;
}


/**
 * Route one native range input through explicit preview/commit transactions.
 * Touch and pen wait for horizontal intent, leaving vertical sheet scrolling
 * entirely native. Pointer and keyboard cancellation restore the interaction's
 * starting value without committing it.
 *
 * @param {{
 *   input: HTMLInputElement,
 *   onInput: (value: string) => unknown,
 *   onInteractionStart?: (modality: "pointer" | "keyboard") => unknown,
 *   onInteractionEnd?: (options: { modality: "pointer" | "keyboard", canceled: boolean }) => unknown,
 * }} options
 */
export function wireRangeController({
  input,
  onInput,
  onInteractionStart = () => {},
  onInteractionEnd = () => {},
}) {
  const ownerDocument = input.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  /** @type {null | { pointerId: number, startX: number, startY: number, startValue: string }} */
  let pendingPointer = null;
  /** @type {null | { pointerId: number, startValue: string }} */
  let rejectedPointer = null;
  let rejectedPointerTimer = null;
  /** @type {null | { modality: "pointer" | "keyboard", startValue: string }} */
  let interaction = null;
  let activePointerId = null;
  let inputFrame = null;
  let pendingInputValue = null;
  let keyboardBlurTimer = null;
  let suppressClickUntil = -Infinity;
  let destroyed = false;

  function clearKeyboardBlurTimer() {
    if (keyboardBlurTimer !== null) {
      ownerWindow?.clearTimeout(keyboardBlurTimer);
      keyboardBlurTimer = null;
    }
  }

  function discardInput() {
    if (inputFrame !== null) {
      ownerWindow?.cancelAnimationFrame(inputFrame);
    }
    inputFrame = null;
    pendingInputValue = null;
  }

  function flushInput() {
    const value = pendingInputValue;
    discardInput();
    if (value === null) {
      return false;
    }
    onInput(value);
    return true;
  }

  function scheduleInput() {
    pendingInputValue = input.value;
    if (inputFrame !== null) {
      return;
    }
    if (!ownerWindow?.requestAnimationFrame) {
      flushInput();
      return;
    }
    inputFrame = ownerWindow.requestAnimationFrame(() => {
      inputFrame = null;
      const value = pendingInputValue;
      pendingInputValue = null;
      if (interaction && value !== null) {
        onInput(value);
      }
    });
  }

  /** @param {"pointer" | "keyboard"} modality */
  function startInteraction(modality) {
    if (interaction) {
      return false;
    }
    interaction = { modality, startValue: input.value };
    onInteractionStart(modality);
    return true;
  }

  /** @param {boolean} canceled */
  function endInteraction(canceled) {
    if (!interaction) {
      clearKeyboardBlurTimer();
      return false;
    }
    const ended = interaction;
    interaction = null;
    clearKeyboardBlurTimer();
    if (canceled) {
      const changed = input.value !== ended.startValue || pendingInputValue !== null;
      discardInput();
      input.value = ended.startValue;
      if (changed) {
        onInput(input.value);
      }
    } else {
      flushInput();
    }
    onInteractionEnd({ modality: ended.modality, canceled });
    return true;
  }

  function cancelPendingPointer() {
    if (!pendingPointer) {
      return false;
    }
    input.value = pendingPointer.startValue;
    pendingPointer = null;
    return true;
  }

  function clearRejectedPointer() {
    if (rejectedPointerTimer !== null) {
      ownerWindow?.clearTimeout(rejectedPointerTimer);
      rejectedPointerTimer = null;
    }
    const hadRejectedPointer = rejectedPointer !== null;
    if (rejectedPointer) {
      input.value = rejectedPointer.startValue;
    }
    rejectedPointer = null;
    return hadRejectedPointer;
  }

  /** @param {NonNullable<typeof pendingPointer>} pointer */
  function rejectPendingPointer(pointer) {
    input.value = pointer.startValue;
    pendingPointer = null;
    rejectedPointer = {
      pointerId: pointer.pointerId,
      startValue: pointer.startValue,
    };
  }

  function releaseRejectedPointerSoon() {
    if (rejectedPointerTimer !== null) {
      ownerWindow?.clearTimeout(rejectedPointerTimer);
    }
    rejectedPointerTimer = ownerWindow?.setTimeout(clearRejectedPointer, 0) ?? null;
  }

  function cancelActiveInteraction() {
    const pendingCanceled = cancelPendingPointer();
    const rejectedCanceled = clearRejectedPointer();
    const pointerId = activePointerId;
    activePointerId = null;
    if (pointerId !== null && input.hasPointerCapture(pointerId)) {
      input.releasePointerCapture(pointerId);
    }
    return endInteraction(true) || pendingCanceled || rejectedCanceled;
  }

  /** @param {number} clientX */
  function updateFromPointer(clientX) {
    const rect = input.getBoundingClientRect();
    const min = Number(input.min);
    const max = Number(input.max);
    if (!(rect.width > 0) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
      return false;
    }
    const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
    if (!setInputValue(input, min + fraction * (max - min))) {
      return false;
    }
    scheduleInput();
    return true;
  }

  /** @param {PointerEvent} event */
  function claimPointer(event) {
    activePointerId = event.pointerId;
    startInteraction("pointer");
    input.focus({ preventScroll: true });
    input.setPointerCapture(event.pointerId);
    if (event.pointerType !== "mouse") {
      suppressClickUntil = event.timeStamp + SYNTHETIC_CLICK_WINDOW_MS;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
  }

  /** @param {PointerEvent} event */
  function onPointerDown(event) {
    if (
      destroyed
      || pendingPointer
      || rejectedPointer
      || activePointerId !== null
      || !event.isPrimary
      || event.button !== 0
      || input.disabled
    ) {
      return;
    }
    if (interaction?.modality === "keyboard") {
      endInteraction(false);
    }
    if (interaction) {
      return;
    }
    if (event.pointerType !== "mouse") {
      pendingPointer = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startValue: input.value,
      };
      return;
    }
    claimPointer(event);
    updateFromPointer(event.clientX);
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
      input.value = pointer.startValue;
      pendingPointer = null;
      claimPointer(event);
      updateFromPointer(event.clientX);
      return;
    }
    if (event.pointerId !== activePointerId || interaction?.modality !== "pointer") {
      return;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    updateFromPointer(event.clientX);
  }

  /** @param {PointerEvent} event */
  function onPointerUp(event) {
    if (rejectedPointer?.pointerId === event.pointerId) {
      input.value = rejectedPointer.startValue;
      releaseRejectedPointerSoon();
      return;
    }
    if (pendingPointer?.pointerId === event.pointerId) {
      const pointer = pendingPointer;
      const deltaX = Math.abs(event.clientX - pointer.startX);
      const deltaY = Math.abs(event.clientY - pointer.startY);
      input.value = pointer.startValue;
      pendingPointer = null;
      if (Math.max(deltaX, deltaY) > GESTURE_CLAIM_SLOP_PX) {
        rejectPendingPointer(pointer);
        releaseRejectedPointerSoon();
        return;
      }
      suppressClickUntil = event.timeStamp + SYNTHETIC_CLICK_WINDOW_MS;
      startInteraction("pointer");
      input.focus({ preventScroll: true });
      updateFromPointer(event.clientX);
      if (event.cancelable) {
        event.preventDefault();
      }
      event.stopPropagation();
      endInteraction(false);
      return;
    }
    if (event.pointerId !== activePointerId || interaction?.modality !== "pointer") {
      return;
    }
    updateFromPointer(event.clientX);
    activePointerId = null;
    if (input.hasPointerCapture(event.pointerId)) {
      input.releasePointerCapture(event.pointerId);
    }
    endInteraction(false);
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

  /** @param {PointerEvent} event */
  function onLostPointerCapture(event) {
    if (event.pointerId === activePointerId) {
      cancelActiveInteraction();
    }
  }

  function onNativeInput() {
    if (pendingPointer) {
      input.value = pendingPointer.startValue;
      return;
    }
    if (rejectedPointer) {
      input.value = rejectedPointer.startValue;
      return;
    }
    if (interaction?.modality === "pointer") {
      return;
    }
    if (interaction?.modality === "keyboard") {
      scheduleInput();
      return;
    }
    startInteraction("keyboard");
    scheduleInput();
    endInteraction(false);
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (activePointerId !== null || pendingPointer || rejectedPointer) {
      return;
    }
    if (event.key === "Escape" && interaction?.modality === "keyboard") {
      event.preventDefault();
      event.stopPropagation();
      endInteraction(true);
      return;
    }
    if (RANGE_ADJUSTMENT_KEYS.has(event.key) && !interaction) {
      startInteraction("keyboard");
    }
  }

  /** @param {KeyboardEvent} event */
  function onKeyUp(event) {
    if (
      interaction?.modality !== "keyboard"
      || !RANGE_ADJUSTMENT_KEYS.has(event.key)
    ) {
      return;
    }
    endInteraction(false);
  }

  function onBlur() {
    if (interaction?.modality !== "keyboard") {
      return;
    }
    clearKeyboardBlurTimer();
    keyboardBlurTimer = ownerWindow?.setTimeout(
      () => endInteraction(false),
      0,
    ) ?? null;
  }

  /** @param {MouseEvent} event */
  function onClick(event) {
    if (event.timeStamp > suppressClickUntil) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function onVisibilityChange() {
    if (ownerDocument.visibilityState === "hidden") {
      cancelActiveInteraction();
    }
  }

  input.addEventListener("pointerdown", onPointerDown, true);
  input.addEventListener("pointermove", onPointerMove);
  input.addEventListener("pointerup", onPointerUp);
  input.addEventListener("pointercancel", onPointerCancel);
  input.addEventListener("lostpointercapture", onLostPointerCapture);
  input.addEventListener("click", onClick, true);
  input.addEventListener("input", onNativeInput);
  input.addEventListener("keydown", onKeyDown);
  input.addEventListener("keyup", onKeyUp);
  input.addEventListener("blur", onBlur);
  ownerWindow?.addEventListener("blur", cancelActiveInteraction);
  ownerWindow?.addEventListener("pagehide", cancelActiveInteraction, true);
  ownerWindow?.addEventListener("orientationchange", cancelActiveInteraction);
  ownerDocument.addEventListener("visibilitychange", onVisibilityChange);

  return Object.freeze({
    destroy() {
      if (destroyed) {
        return false;
      }
      cancelActiveInteraction();
      destroyed = true;
      input.removeEventListener("pointerdown", onPointerDown, true);
      input.removeEventListener("pointermove", onPointerMove);
      input.removeEventListener("pointerup", onPointerUp);
      input.removeEventListener("pointercancel", onPointerCancel);
      input.removeEventListener("lostpointercapture", onLostPointerCapture);
      input.removeEventListener("click", onClick, true);
      input.removeEventListener("input", onNativeInput);
      input.removeEventListener("keydown", onKeyDown);
      input.removeEventListener("keyup", onKeyUp);
      input.removeEventListener("blur", onBlur);
      ownerWindow?.removeEventListener("blur", cancelActiveInteraction);
      ownerWindow?.removeEventListener("pagehide", cancelActiveInteraction, true);
      ownerWindow?.removeEventListener("orientationchange", cancelActiveInteraction);
      ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
      return true;
    },
  });
}
