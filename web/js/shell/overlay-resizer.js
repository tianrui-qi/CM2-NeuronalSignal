const OVERLAY_WIDTH_MIN = 340;
const OVERLAY_WIDTH_MAX = 720;
const OVERLAY_VIEWPORT_MARGIN = 72;
const OVERLAY_MOBILE_MAX_WIDTH = 800;

/**
 * Own the overlay width policy and resize input wiring without knowing about
 * Plotly, map rendering, persistence transport, or any viewer feature.
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

  function getOverlayWidthBounds() {
    const viewportMax = Math.max(
      OVERLAY_WIDTH_MIN,
      window.innerWidth - OVERLAY_VIEWPORT_MARGIN,
    );
    const max = Math.min(OVERLAY_WIDTH_MAX, viewportMax);
    return { min: Math.min(OVERLAY_WIDTH_MIN, max), max };
  }

  /** @param {unknown} width */
  function normalizeOverlayWidth(width) {
    if (width === null) {
      return null;
    }
    const scalar = Number(width);
    if (!Number.isFinite(scalar)) {
      return null;
    }
    const { min, max } = getOverlayWidthBounds();
    return Math.min(max, Math.max(min, scalar));
  }

  function applyOverlayWidth() {
    const overlay = /** @type {HTMLElement | null} */ (
      document.querySelector(".overlay-stack")
    );
    if (!overlay) {
      return;
    }

    const state = store.getSnapshot();
    if (
      window.innerWidth <= OVERLAY_MOBILE_MAX_WIDTH
      || state.overlayWidth === null
    ) {
      overlay.style.width = "";
      return;
    }

    const normalizedWidth = normalizeOverlayWidth(state.overlayWidth);
    commands.setOverlayWidth(normalizedWidth);
    overlay.style.width = `${normalizedWidth}px`;
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

    const overlay = /** @type {(HTMLElement & {
     *   __cm2ResizeObserver?: ResizeObserver,
     * }) | null} */ (document.querySelector(".overlay-stack"));
    const resizer = /** @type {HTMLElement | null} */ (
      document.getElementById("overlay-resizer")
    );

    if (overlay && resizer) {
      if (
        typeof ResizeObserverConstructor === "function"
        && !overlay.__cm2ResizeObserver
      ) {
        overlay.__cm2ResizeObserver = new ResizeObserverConstructor(() => {
          effects.requestPanelResize();
        });
        overlay.__cm2ResizeObserver.observe(overlay);
      }

      let isResizing = false;
      /** @type {number | null} */
      let activePointerId = null;

      /** @param {number} clientX */
      const updateWidth = (clientX) => {
        const overlayLeft = overlay.getBoundingClientRect().left;
        commands.setOverlayWidth(normalizeOverlayWidth(clientX - overlayLeft));
        applyOverlayWidth();
        effects.requestPanelResize();
      };

      const startResize = () => {
        isResizing = true;
        overlay.classList.add("is-resizing");
        document.body.style.cursor = "ew-resize";
      };

      const finishResize = () => {
        if (!isResizing) {
          return;
        }
        isResizing = false;
        activePointerId = null;
        overlay.classList.remove("is-resizing");
        document.body.style.cursor = "";
        effects.persistUiState();
        effects.requestPanelResize({ refreshTemporal: true });
      };

      /** @param {MouseEvent} event */
      const handleMouseMove = (event) => {
        if (!isResizing || activePointerId !== null) {
          return;
        }
        updateWidth(event.clientX);
      };

      const handleMouseUp = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        finishResize();
      };

      resizer.addEventListener("pointerdown", (event) => {
        if (window.innerWidth <= OVERLAY_MOBILE_MAX_WIDTH) {
          return;
        }
        activePointerId = event.pointerId;
        resizer.setPointerCapture(event.pointerId);
        startResize();
        event.preventDefault();
      });

      resizer.addEventListener("pointermove", (event) => {
        if (!isResizing || activePointerId !== event.pointerId) {
          return;
        }
        updateWidth(event.clientX);
      });

      resizer.addEventListener("pointerup", finishResize);
      resizer.addEventListener("pointercancel", finishResize);
      window.addEventListener("pointerup", finishResize);
      window.addEventListener("pointercancel", finishResize);

      resizer.addEventListener("dblclick", () => {
        commands.setOverlayWidth(null);
        applyOverlayWidth();
        effects.persistUiState();
        effects.requestPanelResize({ refreshTemporal: true });
      });

      resizer.addEventListener("mousedown", (event) => {
        if (window.innerWidth <= OVERLAY_MOBILE_MAX_WIDTH || isResizing) {
          return;
        }
        startResize();
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp, { once: true });
        event.preventDefault();
      });
    }

    window.addEventListener("resize", () => {
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
    return true;
  }

  return {
    normalizeOverlayWidth,
    applyOverlayWidth,
    wire,
  };
}
