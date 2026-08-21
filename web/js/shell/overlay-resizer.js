import {
  SIDEBAR_MIN_WIDTH,
  sidebarOuterInset,
  shouldUseWideLayout,
  sidebarMaximumWidth,
} from "./responsive-shell.js";

const OVERLAY_KEYBOARD_STEP = 10;
const OVERLAY_KEYBOARD_LARGE_STEP = 40;

/**
 * Own the wide-layout overlay width policy and input wiring without knowing
 * about Plotly, feature rendering, or persistence transport.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: { setOverlayWidth: (width: number | null) => unknown },
 *   document: Document,
 *   window: Window,
 *   ResizeObserver?: typeof globalThis.ResizeObserver,
 * }} options
 */
export function createOverlayResizer({
  store,
  commands,
  document,
  window,
  ResizeObserver: ResizeObserverConstructor,
}) {
  let wired = false;
  /** @type {number | null} */
  let viewportFrame = null;
  /** @type {ResizeObserver | null} */
  let overlayObserver = null;
  /** @param {unknown} width */
  function normalizeOverlayWidth(width) {
    if (width === null) {
      return null;
    }
    const scalar = Number(width);
    if (!Number.isFinite(scalar)) {
      return null;
    }
    return Math.max(SIDEBAR_MIN_WIDTH, scalar);
  }

  function maximumWidth() {
    return Math.max(
      SIDEBAR_MIN_WIDTH,
      sidebarMaximumWidth(
        window.innerWidth,
        sidebarOuterInset({ document, window }),
      ),
    );
  }

  /** @param {unknown} width */
  function clampOverlayWidth(width) {
    const normalized = normalizeOverlayWidth(width);
    return normalized === null
      ? null
      : Math.min(maximumWidth(), normalized);
  }

  function isWideLayout() {
    return shouldUseWideLayout({
      width: window.innerWidth,
      outerInset: sidebarOuterInset({ document, window }),
    });
  }

  function appliedWidth() {
    return clampOverlayWidth(store.getSnapshot().overlayWidth)
      ?? SIDEBAR_MIN_WIDTH;
  }

  /** @param {HTMLElement | null} resizer */
  function syncSeparatorValue(resizer) {
    if (!resizer) {
      return;
    }
    const state = store.getSnapshot();
    const width = appliedWidth();
    resizer.setAttribute("aria-valuemin", String(SIDEBAR_MIN_WIDTH));
    resizer.setAttribute("aria-valuemax", String(maximumWidth()));
    resizer.setAttribute("aria-valuenow", String(Math.round(width)));
    resizer.setAttribute(
      "aria-valuetext",
      state.overlayWidth === null
        ? `${Math.round(width)} pixels, default width`
        : `${Math.round(width)} pixels`,
    );
  }

  function applyOverlayWidth() {
    const overlay = /** @type {HTMLElement | null} */ (
      document.querySelector(".overlay-stack")
    );
    const resizer = /** @type {HTMLElement | null} */ (
      document.getElementById("overlay-resizer")
    );
    if (!overlay) {
      return;
    }
    const width = clampOverlayWidth(store.getSnapshot().overlayWidth);
    if (!isWideLayout() || width === null) {
      overlay.style.width = "";
    } else {
      overlay.style.width = `${width}px`;
    }
    syncSeparatorValue(resizer);
  }

  /**
   * @param {{
   *   persistUiState: () => void,
   *   requestPanelResize: (options?: { refreshTemporal?: boolean }) => void,
   *   onViewportChanged: (viewportKey: string) => void,
   * }} effects
   * @returns {boolean}
   */
  function wire(effects) {
    if (wired) {
      return false;
    }
    wired = true;

    const overlay = /** @type {HTMLElement | null} */ (
      document.querySelector(".overlay-stack")
    );
    const resizer = /** @type {HTMLElement | null} */ (
      document.getElementById("overlay-resizer")
    );

    if (overlay && resizer) {
      resizer.removeAttribute("aria-hidden");
      resizer.setAttribute("role", "separator");
      resizer.setAttribute("aria-label", "Control panel width");
      resizer.setAttribute("aria-orientation", "vertical");
      resizer.setAttribute(
        "aria-keyshortcuts",
        "ArrowLeft ArrowRight Home End",
      );
      resizer.setAttribute(
        "data-control-description",
        "Drag or use Left and Right Arrow to resize; press Home or double-click to reset",
      );
      resizer.tabIndex = 0;
      syncSeparatorValue(resizer);

      if (typeof ResizeObserverConstructor === "function") {
        overlayObserver = new ResizeObserverConstructor(() => {
          effects.requestPanelResize();
        });
        overlayObserver.observe(overlay);
      }

      let resizing = false;
      let moved = false;
      /** @type {number | null} */
      let activePointerId = null;
      /** @type {number | null} */
      let resizeFrame = null;
      /** @type {number | null} */
      let pendingClientX = null;
      /** @type {number | null} */
      let startClientX = null;
      /** @type {number | null} */
      let startingWidth = null;
      /** @type {null | { startingWidth: number | null, activeKeys: Set<string> }} */
      let keyboardSession = null;
      /** @type {number | null} */
      let keyboardBlurTimer = null;

      /** @param {number} clientX */
      const updateWidth = (clientX) => {
        const overlayLeft = overlay.getBoundingClientRect().left;
        commands.setOverlayWidth(clampOverlayWidth(clientX - overlayLeft));
        applyOverlayWidth();
      };

      const applyPendingWidth = () => {
        resizeFrame = null;
        if (pendingClientX === null) {
          return;
        }
        const clientX = pendingClientX;
        pendingClientX = null;
        updateWidth(clientX);
      };

      const clearPendingWidth = () => {
        if (resizeFrame !== null) {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        pendingClientX = null;
      };

      const clearResizePresentation = () => {
        resizing = false;
        moved = false;
        activePointerId = null;
        startClientX = null;
        startingWidth = null;
        overlay.classList.remove("is-resizing");
        document.body.style.cursor = "";
      };

      /** @param {PointerEvent} event @param {boolean} commit */
      const finishResize = (event, commit) => {
        if (!resizing || activePointerId !== event.pointerId) {
          return false;
        }
        const shouldCommit = commit && moved;
        clearPendingWidth();
        if (shouldCommit) {
          updateWidth(event.clientX);
        } else if (!commit) {
          commands.setOverlayWidth(startingWidth);
          applyOverlayWidth();
        }
        clearResizePresentation();
        if (shouldCommit) {
          effects.persistUiState();
        }
        effects.requestPanelResize({ refreshTemporal: true });
        return true;
      };

      const cancelResize = () => {
        if (!resizing) {
          return false;
        }
        clearPendingWidth();
        commands.setOverlayWidth(startingWidth);
        applyOverlayWidth();
        clearResizePresentation();
        effects.requestPanelResize({ refreshTemporal: true });
        return true;
      };

      const clearKeyboardBlurTimer = () => {
        if (keyboardBlurTimer !== null) {
          window.clearTimeout(keyboardBlurTimer);
          keyboardBlurTimer = null;
        }
      };

      const finishKeyboardResize = (commit) => {
        if (!keyboardSession) {
          clearKeyboardBlurTimer();
          return false;
        }
        const session = keyboardSession;
        keyboardSession = null;
        clearKeyboardBlurTimer();
        if (commit) {
          effects.persistUiState();
        } else {
          commands.setOverlayWidth(session.startingWidth);
          applyOverlayWidth();
        }
        effects.requestPanelResize({ refreshTemporal: true });
        return true;
      };

      const cancelActiveResize = () => {
        const canceledPointer = cancelResize();
        const canceledKeyboard = finishKeyboardResize(false);
        return canceledPointer || canceledKeyboard;
      };

      const handleVisibilityChange = () => {
        if (document.visibilityState === "hidden") {
          cancelActiveResize();
        }
      };

      const resetWidth = () => {
        if (!isWideLayout()) {
          return false;
        }
        cancelActiveResize();
        commands.setOverlayWidth(null);
        applyOverlayWidth();
        effects.persistUiState();
        effects.requestPanelResize({ refreshTemporal: true });
        return true;
      };

      resizer.addEventListener("pointerdown", (event) => {
        if (
          !isWideLayout()
          || resizing
          || event.button !== 0
          || !event.isPrimary
        ) {
          return;
        }
        finishKeyboardResize(true);
        resizing = true;
        moved = false;
        activePointerId = event.pointerId;
        startClientX = event.clientX;
        startingWidth = normalizeOverlayWidth(store.getSnapshot().overlayWidth);
        overlay.classList.add("is-resizing");
        document.body.style.cursor = "ew-resize";
        resizer.setPointerCapture(event.pointerId);
        event.preventDefault();
      });

      resizer.addEventListener("pointermove", (event) => {
        if (!resizing || activePointerId !== event.pointerId) {
          return;
        }
        if (Math.abs(event.clientX - /** @type {number} */ (startClientX)) >= 1) {
          moved = true;
        }
        if (!moved) {
          return;
        }
        pendingClientX = event.clientX;
        if (resizeFrame === null) {
          resizeFrame = window.requestAnimationFrame(applyPendingWidth);
        }
        event.preventDefault();
      });

      resizer.addEventListener("pointerup", (event) => finishResize(event, true));
      resizer.addEventListener(
        "pointercancel",
        (event) => finishResize(event, false),
      );
      resizer.addEventListener("lostpointercapture", cancelResize);
      window.addEventListener("blur", cancelActiveResize);
      window.addEventListener("pagehide", cancelActiveResize, true);
      window.addEventListener("orientationchange", cancelActiveResize);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      resizer.addEventListener("dblclick", (event) => {
        if (resetWidth()) {
          event.preventDefault();
        }
      });

      resizer.addEventListener("keydown", (event) => {
        if (!isWideLayout()) {
          return;
        }
        if (event.key === "Escape" && keyboardSession) {
          finishKeyboardResize(false);
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (event.key === "Home") {
          if (!event.repeat) {
            resetWidth();
          }
          event.preventDefault();
          return;
        }

        const step = event.shiftKey
          ? OVERLAY_KEYBOARD_LARGE_STEP
          : OVERLAY_KEYBOARD_STEP;
        let nextWidth = null;
        if (event.key === "ArrowLeft") {
          nextWidth = appliedWidth() - step;
        } else if (event.key === "ArrowRight") {
          nextWidth = appliedWidth() + step;
        } else if (event.key === "End") {
          nextWidth = maximumWidth();
        }
        if (nextWidth === null) {
          return;
        }
        if (!keyboardSession) {
          keyboardSession = {
            startingWidth: normalizeOverlayWidth(store.getSnapshot().overlayWidth),
            activeKeys: new Set(),
          };
        }
        keyboardSession.activeKeys.add(event.key);
        commands.setOverlayWidth(clampOverlayWidth(nextWidth));
        applyOverlayWidth();
        effects.requestPanelResize({ refreshTemporal: true });
        event.preventDefault();
      });
      resizer.addEventListener("keyup", (event) => {
        if (!keyboardSession || !keyboardSession.activeKeys.has(event.key)) {
          return;
        }
        keyboardSession.activeKeys.delete(event.key);
        if (keyboardSession.activeKeys.size === 0) {
          finishKeyboardResize(true);
        }
      });
      resizer.addEventListener("blur", () => {
        if (!keyboardSession) {
          return;
        }
        clearKeyboardBlurTimer();
        keyboardBlurTimer = window.setTimeout(
          () => finishKeyboardResize(true),
          0,
        );
      });
    }

    window.addEventListener("resize", () => {
      if (viewportFrame !== null) {
        return;
      }
      viewportFrame = window.requestAnimationFrame(() => {
        viewportFrame = null;
        const state = store.getSnapshot();
        if (!state.meta) {
          return;
        }
        const nextViewportKey = `${window.innerWidth}x${window.innerHeight}`;
        applyOverlayWidth();
        effects.requestPanelResize({ refreshTemporal: true });
        if (state.mapViewportKey !== nextViewportKey) {
          effects.onViewportChanged(nextViewportKey);
        }
      });
    });
    return true;
  }

  return {
    normalizeOverlayWidth,
    applyOverlayWidth,
    wire,
  };
}
