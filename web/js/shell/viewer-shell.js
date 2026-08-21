import {
  WORKFLOW_SECTIONS,
  createDefaultOpenSections,
} from "../app/viewer-store.js";
import { createOverlayResizer } from "./overlay-resizer.js";
import { createResponsiveShell } from "./responsive-shell.js";
import { createWorkflowPanel } from "./workflow-panel.js";

const REQUIRED_EFFECT_PORTS = [
  "persistUiState",
  "renderSections",
  "renderChrome",
  "requestPanelResize",
  "onViewportChanged",
];

/**
 * Create the viewer Shell facade. It owns workflow chrome, navigation and
 * overlay interactions while all feature rendering stays behind narrow effect
 * ports.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     toggleWorkflowSection: (section: string) => { blocked?: boolean } | null | undefined,
 *     setActiveWorkflowSection: (section: string) => unknown,
 *     setOverlayWidth: (width: number | null) => unknown,
 *   },
 *   renderScheduler: { scheduleScrollSync: (callback: () => void) => void },
 *   document?: Document,
 *   window?: Window,
 *   ResizeObserver?: typeof globalThis.ResizeObserver,
 * }} options
 */
export function createViewerShell({
  store,
  commands,
  renderScheduler,
  document: documentRef = globalThis.document,
  window: windowRef = globalThis.window,
  ResizeObserver: ResizeObserverConstructor = globalThis.ResizeObserver,
}) {
  const sectionIds = WORKFLOW_SECTIONS;
  let wired = false;

  /**
   * @param {unknown} section
   * @param {string} [fallback]
   */
  function normalizeSection(section, fallback = "temporalTrace") {
    if (typeof section === "string" && sectionIds.includes(section)) {
      return section;
    }
    return fallback;
  }

  /** @param {unknown} openSections */
  function normalizeOpenSections(openSections) {
    const normalized = createDefaultOpenSections();
    if (!openSections || typeof openSections !== "object") {
      return normalized;
    }

    const input = /** @type {Record<string, unknown>} */ (openSections);
    for (const section of sectionIds) {
      if (typeof input[section] === "boolean") {
        normalized[section] = input[section];
      }
    }
    return normalized;
  }

  /** @param {unknown} section */
  function isTemporalSection(section) {
    return section === "temporalHeatmap" || section === "temporalTrace";
  }

  const workflowPanel = createWorkflowPanel({
    store,
    commands,
    renderScheduler,
    document: documentRef,
    sectionIds,
    normalizeSection,
    isTemporalSection,
  });
  const overlayResizer = createOverlayResizer({
    store,
    commands,
    document: documentRef,
    window: windowRef,
    ResizeObserver: ResizeObserverConstructor,
  });
  const responsiveShell = createResponsiveShell({
    document: documentRef,
    window: windowRef,
  });

  /**
   * @param {{
   *   persistUiState: () => void,
   *   renderSections: (options: { includeMap: boolean, includePlots: boolean }) => void,
   *   renderChrome: () => unknown,
   *   requestPanelResize: (options?: { refreshTemporal?: boolean }) => void,
   *   onViewportChanged: (viewportKey: string) => void,
   * }} effects
   * @returns {boolean}
   */
  function wire(effects) {
    if (wired) {
      return false;
    }
    for (const port of REQUIRED_EFFECT_PORTS) {
      if (typeof effects?.[port] !== "function") {
        throw new TypeError(`Viewer Shell requires the ${port} effect port.`);
      }
    }

    wired = true;
    workflowPanel.wire(effects);
    responsiveShell.wire(effects);
    overlayResizer.wire(effects);
    return true;
  }

  return {
    normalizeOpenSections,
    normalizeOverlayWidth: overlayResizer.normalizeOverlayWidth,
    renderChrome: workflowPanel.renderChrome,
    applyOverlayWidth: overlayResizer.applyOverlayWidth,
    wire,
  };
}
