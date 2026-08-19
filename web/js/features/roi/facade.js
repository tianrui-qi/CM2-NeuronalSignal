import { createRoiBoxEditor } from "./box-editor.js";
import {
  DEFAULT_ROI_COLORS,
  countRoiSelectableNeurons,
  countRoiSelectedNeurons,
  createRoi,
  neuronIdPassesRoiSelection,
  normalizePersistedRoiState,
  pointIndexInRoiBox,
  pruneRoiSelectionToBox,
} from "./model.js";
import { createRoiPanel } from "./panel.js";


/**
 * ROI feature facade. The model owns persistence policy, the two DOM
 * modules own presentation, commands own state writes, and the application
 * boundary supplies cross-feature render effects.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     replaceRoiPersistedState(nextState: { rois: Cm2Roi[], activeRoiId: string | null }): unknown,
 *     toggleActiveRoi(roiId: string | null): string | null,
 *     setActiveRoi(roiId: string | null): boolean,
 *     addRoi(roi: Cm2Roi): Cm2Roi,
 *     setRoiBox(roiId: string, box: { x: number, y: number, width: number, height: number } | null): unknown,
 *     setRoiColor(roiId: string, color: string): unknown,
 *     setRoiNeuronIds(roiId: string, neuronIds: number[]): unknown,
 *     removeNeuronFromAllRois(neuronId: number): boolean,
 *     deleteRoi(roiId: string): unknown,
 *   },
 *   document: Document,
 *   qualityControl: {
 *     activeFilters: () => any[],
 *     pointPassesQc: (pointIndex: number, filters: any[]) => boolean,
 *   },
 *   FormData?: typeof globalThis.FormData,
 *   scheduleTimeout?: (callback: () => void, delay: number) => unknown,
 *   now?: () => number,
 *   random?: () => number,
 * }} dependencies
 */
export function createRoiFeature({
  store,
  commands,
  document,
  qualityControl,
  FormData = globalThis.FormData,
  scheduleTimeout = globalThis.setTimeout.bind(globalThis),
  now = Date.now,
  random = Math.random,
}) {
  /** @type {null | {
   *   refreshRoiViews: (options?: { includePlots?: boolean }) => void,
   *   setStatus: (message: string, isError?: boolean) => void,
   * }} */
  let effects = null;

  const panel = createRoiPanel({ document, scheduleTimeout });
  const boxEditor = createRoiBoxEditor({
    document,
    FormData,
    setStatus(message, isError = false) {
      effects?.setStatus(message, isError);
    },
  });

  function requireEffects() {
    if (!effects) {
      throw new Error("ROI effects were not installed before an ROI action.");
    }
    return effects;
  }

  function getById(roiId) {
    return store.getSnapshot().rois.find((roi) => roi.id === roiId) ?? null;
  }

  function findAssignedRoiId(neuronId) {
    for (const roi of store.getSnapshot().rois) {
      if (roi.neuronIds.includes(neuronId)) {
        return roi.id;
      }
    }
    return null;
  }

  function pointIndexInBox(pointIndex, roi) {
    return pointIndexInRoiBox(store.getSnapshot().points, pointIndex, roi);
  }

  function neuronPassesSelection(
    neuronId,
    roi,
    filters = qualityControl.activeFilters(),
  ) {
    const state = store.getSnapshot();
    return neuronIdPassesRoiSelection({
      points: state.points,
      pointIndexByNeuronId: state.pointIndexByNeuronId,
      neuronId,
      roi,
      pointPassesEligibility: (pointIndex) => (
        qualityControl.pointPassesQc(pointIndex, filters)
      ),
    });
  }

  function pruneOneSelection(roi) {
    const state = store.getSnapshot();
    const result = pruneRoiSelectionToBox({
      points: state.points,
      pointIndexByNeuronId: state.pointIndexByNeuronId,
      roi,
    });
    if (result.changed) {
      commands.setRoiNeuronIds(roi.id, result.neuronIds);
    }
    return result.changed;
  }

  function pruneSelectionsToBoxes() {
    let changed = false;
    for (const roi of store.getSnapshot().rois) {
      changed = pruneOneSelection(roi) || changed;
    }
    return changed;
  }

  function applyPersistedState(payload) {
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.rois)) {
      return false;
    }
    const state = store.getSnapshot();
    const nextState = normalizePersistedRoiState(payload, {
      validNeuronIds: state.points.id,
    });
    if (!nextState) {
      return false;
    }
    commands.replaceRoiPersistedState(nextState);
    return true;
  }

  function addRoi(color, box = null) {
    const state = store.getSnapshot();
    const roi = createRoi({
      roiIndex: state.rois.length,
      nowMs: now(),
      randomValue: random(),
      color,
      box,
    });
    commands.addRoi(roi);
    requireEffects().refreshRoiViews({ includePlots: true });
  }

  function openBoxEditor(roiId) {
    const roi = getById(roiId);
    if (!roi) {
      return;
    }
    boxEditor.open({
      titleText: `${roi.name} Box`,
      initialBox: roi.box,
      onApply(box) {
        commands.setRoiBox(roi.id, box);
        pruneOneSelection(roi);
        requireEffects().refreshRoiViews();
      },
      onClear() {
        commands.setRoiBox(roi.id, null);
        requireEffects().refreshRoiViews();
      },
    });
  }

  function openAddBoxEditor(color) {
    const roiName = `ROI ${store.getSnapshot().rois.length + 1}`;
    boxEditor.open({
      titleText: `${roiName} Box`,
      onApply: (box) => addRoi(color, box),
    });
  }

  function renderPanel(nextEffects) {
    effects = nextEffects;
    const state = store.getSnapshot();
    const filters = qualityControl.activeFilters();
    const pointPassesEligibility = (pointIndex) => (
      qualityControl.pointPassesQc(pointIndex, filters)
    );
    panel.render({
      palette: DEFAULT_ROI_COLORS,
      rows: state.rois.map((roi) => ({
        id: roi.id,
        name: roi.name,
        color: roi.color,
        isActive: roi.id === state.activeRoiId,
        selectableCount: countRoiSelectableNeurons({
          points: state.points,
          roi,
          pointPassesEligibility,
        }),
        selectedCount: countRoiSelectedNeurons({
          points: state.points,
          pointIndexByNeuronId: state.pointIndexByNeuronId,
          roi,
          pointPassesEligibility,
        }),
        hasSelected: roi.neuronIds.length !== 0,
      })),
      toggle(roiId) {
        commands.toggleActiveRoi(roiId);
        requireEffects().refreshRoiViews({ includePlots: true });
      },
      editBox: openBoxEditor,
      changeColor(roiId, color) {
        commands.setRoiColor(roiId, color);
        requireEffects().refreshRoiViews({ includePlots: true });
      },
      clear(roiId) {
        commands.setRoiNeuronIds(roiId, []);
        requireEffects().refreshRoiViews({ includePlots: true });
      },
      delete(roiId) {
        commands.deleteRoi(roiId);
        requireEffects().refreshRoiViews({ includePlots: true });
      },
      addDefault: (color) => addRoi(color),
      addWithColor: (color) => addRoi(color),
      addWithBox: openAddBoxEditor,
    });
  }

  function setActive(roiId) {
    if (!commands.setActiveRoi(roiId)) {
      return false;
    }
    requireEffects().refreshRoiViews({ includePlots: true });
    return true;
  }

  function toggleNeuron(neuronId) {
    const state = store.getSnapshot();
    const activeRoi = getById(state.activeRoiId);
    if (!activeRoi) {
      return false;
    }
    const currentRoiId = findAssignedRoiId(neuronId);
    const pointIndex = state.pointIndexByNeuronId.get(neuronId) ?? null;
    if (
      currentRoiId !== activeRoi.id
      && activeRoi.box
      && (pointIndex === null || !pointIndexInBox(pointIndex, activeRoi))
    ) {
      return false;
    }

    if (currentRoiId === activeRoi.id) {
      commands.setRoiNeuronIds(
        activeRoi.id,
        activeRoi.neuronIds.filter((id) => id !== neuronId),
      );
    } else {
      commands.removeNeuronFromAllRois(neuronId);
      commands.setRoiNeuronIds(
        activeRoi.id,
        [...activeRoi.neuronIds, neuronId],
      );
    }
    requireEffects().refreshRoiViews({ includePlots: true });
    return true;
  }

  function deselectNeuronFromActive(neuronId) {
    const activeRoi = getById(store.getSnapshot().activeRoiId);
    if (!activeRoi || !activeRoi.neuronIds.includes(neuronId)) {
      return false;
    }
    commands.setRoiNeuronIds(
      activeRoi.id,
      activeRoi.neuronIds.filter((id) => id !== neuronId),
    );
    return true;
  }

  return Object.freeze({
    applyPersistedState,
    getById,
    findAssignedRoiId,
    pointIndexInBox,
    neuronPassesSelection,
    pruneSelectionsToBoxes,
    renderPanel,
    setActive,
    toggleNeuron,
    deselectNeuronFromActive,
  });
}
