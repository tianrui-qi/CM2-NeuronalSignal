import {
  normalizeBackgroundKey,
  selectActiveBackground,
  selectAvailableBackgrounds,
} from "./model.js";
import {
  renderBackgroundControl,
} from "./panel.js";


/**
 * Public Background feature boundary. Selection policy and rendering live in
 * this feature; persistence, Plotly rendering, and caller-visible effect order
 * remain with the application orchestration boundary.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: { setActiveBackground: (backgroundKey: string | null) => boolean },
 *   document: Document,
 * }} dependencies
 */
export function createBackgroundFeature({ store, commands, document }) {
  const getState = () => store.getSnapshot();

  return {
    /** @param {unknown} candidate */
    normalizeKey(candidate) {
      return normalizeBackgroundKey(getState(), candidate);
    },

    active() {
      return selectActiveBackground(getState());
    },

    /** @param {unknown} candidate */
    setActive(candidate) {
      return commands.setActiveBackground(
        normalizeBackgroundKey(getState(), candidate),
      );
    },

    /** @param {(key: string) => void} onSelect */
    renderControl(onSelect) {
      const state = getState();
      renderBackgroundControl({
        document,
        container: document.getElementById("background-options"),
        backgrounds: selectAvailableBackgrounds(state),
        activeKey: normalizeBackgroundKey(state, state.activeBackgroundKey),
        onSelect,
      });
    },
  };
}
