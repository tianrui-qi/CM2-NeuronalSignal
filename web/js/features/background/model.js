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
 * @param {Record<string, any>} state
 * @param {unknown} backgroundKey
 */
export function selectBackgroundByKey(state, backgroundKey) {
  const key = normalizeBackgroundKey(state, backgroundKey);
  return selectAvailableBackgrounds(state)
    .find((background) => background.key === key) ?? null;
}


/**
 * Resolve the first matching metadata entry when duplicate keys are present.
 *
 * @param {Record<string, any>} state
 * @returns {any | null}
 */
export function selectActiveBackground(state) {
  return selectBackgroundByKey(state, state?.activeBackgroundKey);
}


/** @param {unknown} value @param {number} min @param {number} max */
function clampInteger(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value))));
}


/**
 * Cache metadata owns the complete integer interaction domain. Returning null
 * keeps a malformed cache entry from creating partially configured controls.
 *
 * @param {any} background
 * @returns {{ lower: number, upper: number, step: 1 } | null}
 */
export function getBackgroundControlRange(background) {
  const lower = background?.value_range?.lower;
  const upper = background?.value_range?.upper;
  if (
    !Number.isSafeInteger(lower)
    || !Number.isSafeInteger(upper)
    || lower >= upper
  ) {
    return null;
  }
  return { lower, upper, step: 1 };
}


/**
 * @param {any} background
 * @returns {{ lower: number, upper: number } | null}
 */
export function getBackgroundAutoRange(background) {
  const domain = getBackgroundControlRange(background);
  const lower = background?.auto_range?.lower;
  const upper = background?.auto_range?.upper;
  if (
    !domain
    || !Number.isSafeInteger(lower)
    || !Number.isSafeInteger(upper)
  ) {
    return null;
  }
  const normalized = {
    lower: clampInteger(lower, domain.lower, domain.upper),
    upper: clampInteger(upper, domain.lower, domain.upper),
  };
  return normalized.lower < normalized.upper ? normalized : null;
}


/**
 * @param {any} background
 * @param {unknown} candidate
 * @returns {{ lower: number, upper: number } | null}
 */
export function normalizeBackgroundRange(background, candidate) {
  const domain = getBackgroundControlRange(background);
  const source = candidate && typeof candidate === "object"
    ? /** @type {{ lower?: unknown, upper?: unknown }} */ (candidate)
    : null;
  if (
    !domain
    || !source
    || !Number.isFinite(Number(source.lower))
    || !Number.isFinite(Number(source.upper))
  ) {
    return null;
  }
  const normalized = {
    lower: clampInteger(source.lower, domain.lower, domain.upper),
    upper: clampInteger(source.upper, domain.lower, domain.upper),
  };
  return normalized.lower < normalized.upper ? normalized : null;
}


/**
 * Retain only manual ranges for backgrounds declared by current metadata.
 * Missing entries intentionally continue to mean cache-owned Auto.
 *
 * @param {Record<string, any>} state
 * @param {unknown} ranges
 */
export function normalizeBackgroundRanges(state, ranges) {
  if (!ranges || typeof ranges !== "object" || Array.isArray(ranges)) {
    return {};
  }
  const source = /** @type {Record<string, unknown>} */ (ranges);
  const normalized = {};
  for (const background of selectAvailableBackgrounds(state)) {
    if (!Object.hasOwn(source, background.key)) {
      continue;
    }
    const range = normalizeBackgroundRange(background, source[background.key]);
    const autoRange = getBackgroundAutoRange(background);
    if (range && (!autoRange || !backgroundRangesEqual(range, autoRange))) {
      normalized[background.key] = range;
    }
  }
  return normalized;
}


/**
 * @param {Record<string, any>} state
 * @param {unknown} backgroundKey
 */
export function selectBackgroundRangeOverride(state, backgroundKey) {
  const background = selectBackgroundByKey(state, backgroundKey);
  if (!background) {
    return null;
  }
  const candidate = state?.backgroundRanges?.[background.key];
  return normalizeBackgroundRange(background, candidate);
}


/**
 * Resolve the range actually displayed: a saved manual range when present,
 * otherwise the cache-declared ImageJ Auto range.
 *
 * @param {Record<string, any>} state
 * @param {unknown} [backgroundKey]
 */
export function selectBackgroundDisplayRange(
  state,
  backgroundKey = state?.activeBackgroundKey,
) {
  const background = selectBackgroundByKey(state, backgroundKey);
  if (!background) {
    return null;
  }
  return selectBackgroundRangeOverride(state, background.key)
    ?? getBackgroundAutoRange(background);
}


/**
 * @param {Record<string, any>} state
 * @param {unknown} [backgroundKey]
 */
export function isBackgroundRangeAuto(
  state,
  backgroundKey = state?.activeBackgroundKey,
) {
  const background = selectBackgroundByKey(state, backgroundKey);
  return Boolean(background) && !selectBackgroundRangeOverride(state, background.key);
}


/**
 * Convert the one handle that moved while preserving an ordered interval.
 *
 * @param {{ lower: number, upper: number }} currentRange
 * @param {"lower" | "upper"} changedHandle
 * @param {unknown} value
 * @param {{ lower: number, upper: number }} domain
 */
export function updateBackgroundRangeHandle(
  currentRange,
  changedHandle,
  value,
  domain,
) {
  const next = { ...currentRange };
  if (changedHandle === "lower") {
    next.lower = clampInteger(value, domain.lower, next.upper - 1);
  } else {
    next.upper = clampInteger(value, next.lower + 1, domain.upper);
  }
  return next;
}


/**
 * Restore one endpoint to the cache-declared Auto value. If the other manual
 * endpoint has crossed that value, restore both endpoints because no ordered
 * interval can otherwise contain the requested exact Auto endpoint.
 *
 * @param {{ lower: number, upper: number }} currentRange
 * @param {"lower" | "upper"} resetHandle
 * @param {{ lower: number, upper: number }} autoRange
 */
export function resetBackgroundRangeHandle(
  currentRange,
  resetHandle,
  autoRange,
) {
  const next = { ...currentRange, [resetHandle]: autoRange[resetHandle] };
  return next.lower < next.upper ? next : { ...autoRange };
}


/**
 * @param {{ lower: number, upper: number }} left
 * @param {{ lower: number, upper: number }} right
 */
export function backgroundRangesEqual(left, right) {
  return left.lower === right.lower && left.upper === right.upper;
}


/** @param {number} value @param {{ lower: number, upper: number }} domain */
export function backgroundValueToPercent(value, domain) {
  return 100 * (value - domain.lower) / (domain.upper - domain.lower);
}
