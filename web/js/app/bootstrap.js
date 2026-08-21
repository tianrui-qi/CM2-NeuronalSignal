import { createViewerStore } from "./viewer-store.js";
import { createViewerCommands } from "./commands.js";
import * as selectors from "./selectors.js";
import { createRenderScheduler } from "./render-scheduler.js";
import { createUiStateController } from "./ui-state-controller.js";
import { createViewerApplication } from "./viewer-application.js";
import { createInteractionCommandRegistry } from "./interaction-command-registry.js";
import { createInteractionContextStack } from "./interaction-context-stack.js";
import { createBackgroundFeature } from "../features/background/facade.js";
import { createQualityControlFeature } from "../features/quality-control/facade.js";
import { createRegionFeature } from "../features/region/facade.js";
import { createRoiFeature } from "../features/roi/facade.js";
import { createMapFeature } from "../features/map/facade.js";
import { createTemporalFeature } from "../features/temporal/facade.js";
import { createCacheClient } from "../infrastructure/cache/client.js";
import { createPlotImageService } from "../infrastructure/plot-image.js";
import { createUiStateClient } from "../infrastructure/ui-state/client.js";
import { createUiStateSaveCoordinator } from "../infrastructure/ui-state/save-coordinator.js";
import { createControlTooltip } from "../shared/ui/control-tooltip.js";
import { createViewerShell } from "../shell/viewer-shell.js";


const viewerStore = createViewerStore();
const commands = createViewerCommands(viewerStore);
const renderScheduler = createRenderScheduler();
const plotly = typeof Plotly === "undefined" ? null : Plotly;
const plotImage = createPlotImageService({ document, window });
const cacheClient = createCacheClient();
createControlTooltip({ document, window }).start();
const background = createBackgroundFeature({
  store: viewerStore,
  commands,
  document,
});
const qualityControl = createQualityControlFeature({
  store: viewerStore,
  commands,
  document,
  renderScheduler,
  plotImage,
});
const region = createRegionFeature({
  store: viewerStore,
  commands,
  document,
  qualityControl: {
    activeFilters: qualityControl.activeFilters,
    pointPassesMetricFilters: qualityControl.pointPassesMetricFilters,
  },
  getComputedStyle: window.getComputedStyle.bind(window),
});
const roi = createRoiFeature({
  store: viewerStore,
  commands,
  document,
  qualityControl: {
    activeFilters: qualityControl.activeFilters,
    pointPassesQc: (pointIndex, filters) => (
      region.pointPasses(pointIndex)
      && qualityControl.pointPassesMetricFilters(pointIndex, filters)
    ),
  },
  FormData: window.FormData,
  scheduleTimeout: window.setTimeout.bind(window),
});
const temporal = createTemporalFeature({
  store: viewerStore,
  commands,
  loadTraceSource: cacheClient.loadTraceSource,
  document,
  window,
  plotImage,
  qualityControl: {
    activeFilters: qualityControl.activeFilters,
    pointPassesMetricFilters: qualityControl.pointPassesMetricFilters,
  },
  region: {
    pointPasses: region.pointPasses,
  },
  roi: {
    getById: roi.getById,
    pointIndexInBox: roi.pointIndexInBox,
    neuronPassesSelection: roi.neuronPassesSelection,
    deselectNeuronFromActive: roi.deselectNeuronFromActive,
  },
});
const map = createMapFeature({
  store: viewerStore,
  commands,
  document,
  window,
  plotly,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  background: {
    active: background.active,
    range: background.range,
  },
  qualityControl: {
    activeFilters: qualityControl.activeFilters,
    pointPassesMetricFilters: qualityControl.pointPassesMetricFilters,
    renderedSpec: qualityControl.renderedSpec,
    buildMetricValues: qualityControl.buildMetricValues,
    colorRange: qualityControl.colorRange,
    colorScale: qualityControl.colorScale,
  },
  region: {
    activeDisplayScope: region.activeDisplayScope,
    pointPasses: region.pointPasses,
    pointPassesDisplayScope: region.pointPassesDisplayScope,
    buildMapTraces: region.buildMapTraces,
    isDrawing: region.isDrawing,
    addPointFromMapEvent: region.addPointFromMapEvent,
  },
  roi: {
    getById: roi.getById,
    findAssignedRoiId: roi.findAssignedRoiId,
    pointIndexInBox: roi.pointIndexInBox,
    setActive: roi.setActive,
    toggleNeuron: roi.toggleNeuron,
  },
  temporal: {
    describeNeuronTrace: temporal.describeNeuronTrace,
  },
});
const shell = createViewerShell({
  store: viewerStore,
  commands,
  renderScheduler,
  document,
  window,
  ResizeObserver: window.ResizeObserver,
});
const interactionContextStack = createInteractionContextStack({
  document,
  isRegionDrawing: region.isDrawing,
  hasPlotInspector: () => (
    map.hasPinnedInspector()
    || qualityControl.hasPinnedInspector()
    || temporal.hasPinnedInspector()
  ),
});
const interactionCommands = createInteractionCommandRegistry({
  contextStack: interactionContextStack,
  document,
});


const uiStateClient = createUiStateClient();
/** @type {ReturnType<typeof createUiStateController>} */
let uiState;
const uiStatePersistence = createUiStateSaveCoordinator({
  client: uiStateClient,
  serialize: () => uiState.serialize(),
  apply: (payload) => uiState.apply(payload),
});

uiState = createUiStateController({
  store: viewerStore,
  commands,
  selectors,
  features: { background, qualityControl, region, roi, temporal },
  shell,
  persistence: uiStatePersistence,
});
const application = createViewerApplication({
  store: viewerStore,
  commands,
  renderScheduler,
  features: { background, qualityControl, region, roi, map, temporal },
  shell,
  cacheClient,
  uiState,
  document,
  window,
  plotly,
  interactionCommands,
});
application.start();
