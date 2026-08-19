import {
  backgroundRangesEqual,
  getBackgroundAutoRange,
  getBackgroundControlRange,
  isBackgroundRangeAuto,
  normalizeBackgroundKey,
  normalizeBackgroundRange,
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

  /** @param {unknown} [backgroundKey] */
  function rangeDomain(backgroundKey = getState().activeBackgroundKey) {
    return getBackgroundControlRange(
      selectBackgroundByKey(getState(), backgroundKey),
    );
  }

  /** @param {unknown} [backgroundKey] */
  function isAutoRange(backgroundKey = getState().activeBackgroundKey) {
    return isBackgroundRangeAuto(getState(), backgroundKey);
  }

  /**
   * @param {unknown} candidate
   * @param {unknown} [backgroundKey]
   */
  function setRange(candidate, backgroundKey = getState().activeBackgroundKey) {
    const state = getState();
    const background = selectBackgroundByKey(state, backgroundKey);
    const range = normalizeBackgroundRange(background, candidate);
    if (!background || !range) {
      return false;
    }
    const autoRange = getBackgroundAutoRange(background);
    return commands.setBackgroundRange(
      background.key,
      autoRange && backgroundRangesEqual(range, autoRange) ? null : range,
    );
  }

  /** @param {unknown} [backgroundKey] */
  function resetRange(backgroundKey = getState().activeBackgroundKey) {
    const background = selectBackgroundByKey(getState(), backgroundKey);
    return background
      ? commands.setBackgroundRange(background.key, null)
      : false;
  }

  /**
   * @param {(key: string) => void} onSelect
   * @param {(range: { lower: number, upper: number }, key: string) => void} [onRangeChange]
   */
  function renderControl(onSelect, onRangeChange = () => {}) {
    const state = getState();
    const activeKey = normalizeBackgroundKey(state, state.activeBackgroundKey);
    const background = selectBackgroundByKey(state, activeKey);
    const domain = getBackgroundControlRange(background);
    const range = selectBackgroundDisplayRange(state, activeKey);

    /**
     * Store one effective display range, removing the manual override when it
     * exactly matches the cache-declared Auto range.
     *
     * @param {any} currentBackground
     * @param {{ lower: number, upper: number }} currentDomain
     * @param {{ lower: number, upper: number }} next
     */
    function commitDisplayRange(currentBackground, currentDomain, next) {
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
      onRangeChange(next, currentBackground.key);
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
        commitDisplayRange(currentBackground, currentDomain, next);
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
        commitDisplayRange(currentBackground, currentDomain, next);
      },
    });
  }

  return Object.freeze({
    active,
    activeDisplayRange: displayRange,
    applyPersistedState,
    displayRange,
    isAutoRange,
    normalizeKey,
    range: displayRange,
    rangeDomain,
    renderControl,
    resetRange,
    setActive,
    setRange,
  });
}
