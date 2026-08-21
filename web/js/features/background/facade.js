import {
  backgroundRangesEqual,
  getBackgroundAutoRange,
  getBackgroundControlRange,
  normalizeBackgroundKey,
  normalizeBackgroundRanges,
  selectActiveBackground,
  selectAvailableBackgrounds,
  selectBackgroundByKey,
  selectBackgroundDisplayRange,
  resetBackgroundRangeHandle,
  updateBackgroundRangeHandle,
} from "./model.js";
import { createBackgroundPanel } from "./panel.js";


/**
 * Public Background feature boundary. Selection, display-range policy, and
 * panel rendering live here; cache loading, persistence scheduling, and Map
 * rendering remain caller-owned effects.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     replaceBackgroundPersistedState: (nextState: {
 *       activeBackgroundKey: string | null,
 *       backgroundRanges: Record<string, { lower: number, upper: number }>,
 *     }) => unknown,
 *     setActiveBackground: (backgroundKey: string | null) => boolean,
 *     setBackgroundRange: (
 *       backgroundKey: string,
 *       range: { lower: number, upper: number } | null,
 *     ) => boolean,
 *   },
 *   document: Document,
 * }} dependencies
 */
export function createBackgroundFeature({ store, commands, document }) {
  const panel = createBackgroundPanel({ document });
  const getState = () => store.getSnapshot();

  /** @param {unknown} candidate */
  function normalizeKey(candidate) {
    return normalizeBackgroundKey(getState(), candidate);
  }

  function active() {
    return selectActiveBackground(getState());
  }

  /** @param {unknown} candidate */
  function setActive(candidate) {
    return commands.setActiveBackground(normalizeKey(candidate));
  }

  /**
   * Apply the complete Background persistence slice against current metadata.
   *
   * @param {Record<string, any>} parsed
   */
  function applyPersistedState(parsed) {
    const state = getState();
    commands.replaceBackgroundPersistedState({
      activeBackgroundKey: normalizeBackgroundKey(
        state,
        parsed.activeBackgroundKey,
      ),
      backgroundRanges: normalizeBackgroundRanges(
        state,
        parsed.backgroundRanges,
      ),
    });
    return true;
  }

  /** @param {unknown} [backgroundKey] */
  function displayRange(backgroundKey = getState().activeBackgroundKey) {
    return selectBackgroundDisplayRange(getState(), backgroundKey);
  }

  /**
   * @param {(key: string) => void} onSelect
   * @param {(range: { lower: number, upper: number }, key: string) => void} [onRangeCommit]
   * @param {(range: { lower: number, upper: number }, key: string) => void} [onRangePreview]
   */
  function renderControl(
    onSelect,
    onRangeCommit = () => {},
    onRangePreview = () => {},
  ) {
    const state = getState();
    const activeKey = normalizeBackgroundKey(state, state.activeBackgroundKey);
    const background = selectBackgroundByKey(state, activeKey);
    const domain = getBackgroundControlRange(background);
    const range = selectBackgroundDisplayRange(state, activeKey);
    /** @type {{ lower: number, upper: number } | null} */
    let interactionStartRange = null;

    /**
     * Store one effective display range, removing the manual override when it
     * exactly matches the cache-declared Auto range.
     *
     * @param {any} currentBackground
     * @param {{ lower: number, upper: number }} currentDomain
     * @param {{ lower: number, upper: number }} next
     * @param {(range: { lower: number, upper: number }, key: string) => void} notify
     */
    function applyDisplayRange(currentBackground, currentDomain, next, notify) {
      const autoRange = getBackgroundAutoRange(currentBackground);
      const isAuto = Boolean(
        autoRange && backgroundRangesEqual(next, autoRange),
      );
      if (!commands.setBackgroundRange(
        currentBackground.key,
        isAuto ? null : next,
      )) {
        return false;
      }
      panel.renderRange({ range: next, domain: currentDomain, autoRange });
      notify(next, currentBackground.key);
      return true;
    }

    panel.renderControl({
      backgrounds: selectAvailableBackgrounds(state),
      activeKey,
      range,
      domain,
      autoRange: getBackgroundAutoRange(background),
      onSelect,
      onRangeInput(handle, value) {
        const currentState = getState();
        const currentBackground = selectBackgroundByKey(currentState, activeKey);
        const currentDomain = getBackgroundControlRange(currentBackground);
        const currentRange = selectBackgroundDisplayRange(currentState, activeKey);
        if (!currentBackground || !currentDomain || !currentRange) {
          return;
        }
        const next = updateBackgroundRangeHandle(
          currentRange,
          handle,
          value,
          currentDomain,
        );
        applyDisplayRange(
          currentBackground,
          currentDomain,
          next,
          onRangePreview,
        );
      },
      onRangeReset(handle) {
        const currentState = getState();
        const currentBackground = selectBackgroundByKey(currentState, activeKey);
        const currentDomain = getBackgroundControlRange(currentBackground);
        const currentRange = selectBackgroundDisplayRange(currentState, activeKey);
        const autoRange = getBackgroundAutoRange(currentBackground);
        if (!currentBackground || !currentDomain || !currentRange || !autoRange) {
          return;
        }
        const next = resetBackgroundRangeHandle(
          currentRange,
          handle,
          autoRange,
        );
        applyDisplayRange(
          currentBackground,
          currentDomain,
          next,
          onRangeCommit,
        );
      },
      onRangeInteractionStart() {
        const currentRange = selectBackgroundDisplayRange(getState(), activeKey);
        interactionStartRange = currentRange ? { ...currentRange } : null;
      },
      onRangeInteractionEnd({ canceled }) {
        const startRange = interactionStartRange;
        interactionStartRange = null;
        const currentState = getState();
        const currentBackground = selectBackgroundByKey(currentState, activeKey);
        const currentDomain = getBackgroundControlRange(currentBackground);
        const currentRange = selectBackgroundDisplayRange(currentState, activeKey);
        if (!currentBackground || !currentDomain || !currentRange || !startRange) {
          return;
        }
        if (canceled) {
          applyDisplayRange(
            currentBackground,
            currentDomain,
            startRange,
            onRangePreview,
          );
          return;
        }
        if (!backgroundRangesEqual(currentRange, startRange)) {
          onRangeCommit(currentRange, currentBackground.key);
        }
      },
    });
  }

  return Object.freeze({
    active,
    applyPersistedState,
    normalizeKey,
    range: displayRange,
    renderControl,
    setActive,
  });
}
