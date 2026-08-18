/**
 * Preserve the metadata-owned background list and its declared order.
 *
 * @param {Record<string, any>} state
 * @returns {any[]}
 */
export function selectAvailableBackgrounds(state) {
  return Array.isArray(state?.meta?.backgrounds) ? state.meta.backgrounds : [];
}

/**
 * Prefer a declared default that is still present, then use the first available
 * option when current metadata does not declare a usable default.
 *
 * @param {Record<string, any>} state
 * @returns {string | null}
 */
export function selectDefaultBackgroundKey(state) {
  const backgrounds = selectAvailableBackgrounds(state);
  const defaultKey = state?.meta?.default_background_key;
  if (backgrounds.some((background) => background.key === defaultKey)) {
    return defaultKey;
  }
  return backgrounds[0]?.key ?? null;
}

/**
 * @param {Record<string, any>} state
 * @param {unknown} candidate
 * @returns {string | null}
 */
export function normalizeBackgroundKey(state, candidate) {
  const backgrounds = selectAvailableBackgrounds(state);
  if (backgrounds.some((background) => background.key === candidate)) {
    return /** @type {string} */ (candidate);
  }
  return selectDefaultBackgroundKey(state);
}

/**
 * Resolve the first matching metadata entry when duplicate keys are present.
 *
 * @param {Record<string, any>} state
 * @returns {any | null}
 */
export function selectActiveBackground(state) {
  const activeKey = normalizeBackgroundKey(state, state?.activeBackgroundKey);
  return selectAvailableBackgrounds(state)
    .find((background) => background.key === activeKey) ?? null;
}
