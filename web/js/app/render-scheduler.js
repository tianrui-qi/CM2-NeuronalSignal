/**
 * @typedef {(callback: () => void) => unknown} RequestFrame
 */

/**
 * Resolve the browser scheduler only when a frame is requested so importing or
 * constructing the scheduler remains safe in non-DOM environments.
 *
 * @param {() => void} callback
 * @returns {unknown}
 */
function defaultRequestFrame(callback) {
  return globalThis.requestAnimationFrame(callback);
}

/**
 * Coordinate the viewer's existing synchronous and animation-frame render
 * timing without owning any DOM, plotting, or feature state.
 *
 * @param {{ requestFrame?: RequestFrame }} [options]
 */
export function createRenderScheduler({ requestFrame = defaultRequestFrame } = {}) {
  let panelResizeQueued = false;
  let panelResizeRefreshTemporal = false;
  /** @type {((refreshTemporal: boolean) => void) | null} */
  let panelResizeOnReady = null;

  let scrollSyncQueued = false;
  /** @type {(() => void) | null} */
  let scrollSyncOnReady = null;

  /**
   * @param {() => void} callback
   */
  function scheduleDoubleFrame(callback) {
    requestFrame(() => {
      requestFrame(callback);
    });
  }

  /**
   * @param {{
   *   refreshTemporal?: boolean,
   *   onReady: (refreshTemporal: boolean) => void,
  * }} options
  */
  function schedulePanelResize({ refreshTemporal = false, onReady }) {
    panelResizeRefreshTemporal = panelResizeRefreshTemporal || Boolean(refreshTemporal);
    panelResizeOnReady = onReady;
    if (panelResizeQueued) {
      return;
    }

    panelResizeQueued = true;
    requestFrame(() => {
      requestFrame(() => {
        const shouldRefreshTemporal = panelResizeRefreshTemporal;
        const ready = panelResizeOnReady;

        panelResizeQueued = false;
        panelResizeRefreshTemporal = false;
        panelResizeOnReady = null;

        ready?.(shouldRefreshTemporal);
      });
    });
  }

  /**
   * @param {() => void} onReady
   */
  function scheduleScrollSync(onReady) {
    scrollSyncOnReady = onReady;
    if (scrollSyncQueued) {
      return;
    }

    scrollSyncQueued = true;
    requestFrame(() => {
      const ready = scrollSyncOnReady;
      scrollSyncQueued = false;
      scrollSyncOnReady = null;
      ready?.();
    });
  }

  return {
    scheduleDoubleFrame,
    schedulePanelResize,
    scheduleScrollSync,
  };
}
