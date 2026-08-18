import { renderSegmentedControl } from "../../shared/ui/segmented-control.js";


const BACKGROUND_DESCRIPTIONS = Object.freeze({
  mean: "Show the mean-intensity image as the map background",
  std: "Show the temporal standard-deviation image as the map background",
  bandpass: "Show the bandpass-enhanced STD image as the map background",
});


/** @param {any} background */
function backgroundDescription(background) {
  const label = background.label ?? background.key;
  return BACKGROUND_DESCRIPTIONS[background.key] ?? `Show ${label} as the map background`;
}


/**
 * @param {{
 *   document: Document,
 *   container: HTMLElement | null,
 *   backgrounds: any[],
 *   activeKey: string | null,
 *   onSelect: (key: string) => void,
 * }} options
 */
export function renderBackgroundControl({
  document,
  container,
  backgrounds,
  activeKey,
  onSelect,
}) {
  if (!container) {
    return;
  }
  renderSegmentedControl({
    document,
    container,
    options: backgrounds.map((background) => ({
      key: background.key,
      label: background.label ?? background.key,
      description: backgroundDescription(background),
    })),
    activeKey,
    onSelect,
    buttonClassName: "background-option",
    activeClassName: "is-active",
    selectionAttribute: "aria-pressed",
  });
}
