import {
  formatMetricValue,
  formatRawBound,
  getSliderBounds,
  rawValueToPercent,
  rawValueToSliderValue,
} from "./model.js";
import { placeAnchoredPopover } from "../../shared/ui/anchored-popover.js";
import { describeControl } from "../../shared/ui/control-tooltip.js";
import { wireDualRangeController } from "../../shared/ui/dual-range-controller.js";


const QC_PLOT_DOWNLOADS = Object.freeze({
  svg: "download-qc-svg-btn",
  png: "download-qc-png-btn",
});

const QC_METRIC_DESCRIPTIONS = Object.freeze({
  r_value: "Spatial correlation between the neuron footprint and movie activity (r_value)",
  snr: "Temporal activity signal-to-noise ratio (SNR)",
  bl: "Temporal-trace baseline level (bl)",
  lam: "Temporal-trace regularization strength (lambda)",
  neurons_sn: "Estimated temporal-trace noise level (neurons_sn)",
  g_0: "First calcium-response model coefficient (g_0)",
  g_1: "Second calcium-response model coefficient (g_1)",
  t_peak: "Response onset-to-peak time (t_peak, ms)",
  t_half: "Response peak-to-half-decay time (t_half, ms)",
});

/** @param {{ key: string, label: string }} item */
function metricOptionDescription(item) {
  if (item.key === "none") {
    return "No metric colors or histogram; current QC filters remain";
  }
  return QC_METRIC_DESCRIPTIONS[item.key] ?? `Neuron metric (${item.label})`;
}


/**
 * Presentation-only owner for the existing Quality Control DOM contract.
 * It does not read viewer state, persist, render Plotly, or import another
 * feature.
 *
 * @param {{ document: Document }} options
 */
export function createQualityControlPanel({ document }) {
  let wired = false;
  let exportRangeLabels = { lower: "Min", upper: "Max" };

  function metricOptions() {
    return Array.from(document.querySelectorAll("#blueprint-menu .blueprint-option"));
  }

  function positionMenu() {
    const menu = document.getElementById("blueprint-menu");
    const picker = document.getElementById("blueprint-picker");
    if (!menu || !picker || menu.classList.contains("hidden")) {
      return null;
    }
    return placeAnchoredPopover({
      popup: menu,
      anchor: picker,
      boundary: document.getElementById("workflow-panel"),
      preferred: "down",
      maxHeight: 300,
    });
  }

  function closeMenu({ restoreFocus = false } = {}) {
    const menu = document.getElementById("blueprint-menu");
    const button = document.getElementById("blueprint-select");
    const section = document.getElementById("qc-section");
    menu?.classList.add("hidden");
    menu?.style.removeProperty("--anchored-popover-available-height");
    menu?.removeAttribute("data-placement");
    button?.setAttribute("aria-expanded", "false");
    section?.classList.remove("menu-open");
    if (restoreFocus) {
      button?.focus();
    }
  }

  function focusMenuOption(target = "selected") {
    const options = metricOptions();
    if (!options.length) {
      return;
    }
    const option = target === "first"
      ? options[0]
      : target === "last"
        ? options.at(-1)
        : options.find((candidate) => candidate.getAttribute("aria-selected") === "true")
          ?? options[0];
    option?.focus();
    option?.scrollIntoView({ block: "nearest" });
  }

  function toggleMenu({ focusMenu = false, focusTarget = "selected" } = {}) {
    const menu = document.getElementById("blueprint-menu");
    const button = document.getElementById("blueprint-select");
    const section = document.getElementById("qc-section");
    if (!menu || !button) {
      return;
    }
    const nextOpen = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !nextOpen);
    button.setAttribute("aria-expanded", String(nextOpen));
    section?.classList.toggle("menu-open", nextOpen);
    if (!nextOpen) {
      menu.style.removeProperty("--anchored-popover-available-height");
      menu.removeAttribute("data-placement");
      return;
    }
    positionMenu();
    const selectedOption = metricOptions().find(
      (candidate) => candidate.getAttribute("aria-selected") === "true",
    );
    selectedOption?.scrollIntoView({ block: "nearest" });
    if (focusMenu) {
      focusMenuOption(focusTarget);
    }
  }

  /**
   * @param {{
   *   selectedValue: string,
   *   items: Array<{
   *     key: string,
   *     label: string,
   *     thresholdSummary?: string,
   *     thresholdDescription?: string,
   *   }>,
   *   onSelect: (key: string) => void,
   * }} options
   */
  function renderMetricControl({ selectedValue, items, onSelect }) {
    const button = /** @type {HTMLButtonElement | null} */ (
      document.getElementById("blueprint-select")
    );
    const label = document.getElementById("blueprint-select-label");
    const menu = document.getElementById("blueprint-menu");
    if (!button || !label || !menu) {
      return;
    }

    button.value = selectedValue;
    button.dataset.value = selectedValue;
    label.textContent = items.find((item) => item.key === selectedValue)?.label ?? selectedValue;
    menu.replaceChildren();

    for (const item of items) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = `blueprint-option${item.key === selectedValue ? " is-active" : ""}`;
      option.dataset.value = item.key;
      option.dataset.metricLabel = item.label;
      option.tabIndex = -1;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(item.key === selectedValue));
      option.setAttribute(
        "aria-label",
        item.thresholdDescription
          ? `${item.label}, ${item.thresholdDescription}`
          : item.label,
      );
      describeControl(option, metricOptionDescription(item));

      const optionLabel = document.createElement("span");
      optionLabel.className = "blueprint-option-label";
      optionLabel.textContent = item.label;
      option.appendChild(optionLabel);

      const threshold = document.createElement("span");
      threshold.className = "blueprint-option-threshold";
      threshold.setAttribute("aria-hidden", "true");
      threshold.textContent = item.thresholdSummary ?? "";
      option.appendChild(threshold);
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        closeMenu({ restoreFocus: event.detail === 0 });
        onSelect(item.key);
      });
      menu.appendChild(option);
    }
  }

  /**
   * Update one rendered option without rebuilding the open listbox or moving
   * its keyboard focus.
   *
   * @param {{
   *   key: string,
   *   thresholdSummary?: string,
   *   thresholdDescription?: string,
   * }} item
   */
  function updateMetricThreshold({
    key,
    thresholdSummary = "",
    thresholdDescription = "",
  }) {
    const option = metricOptions().find((candidate) => candidate.dataset.value === key);
    if (!option) {
      return false;
    }
    const label = option.dataset.metricLabel ?? key;
    const threshold = option.querySelector(".blueprint-option-threshold");
    if (threshold) {
      threshold.textContent = thresholdSummary;
    }
    option.setAttribute(
      "aria-label",
      thresholdDescription ? `${label}, ${thresholdDescription}` : label,
    );
    positionMenu();
    return true;
  }

  function hideRangeControls() {
    document.getElementById("blueprint-color-range")?.classList.add("hidden");
    document.getElementById("blueprint-qc-range")?.classList.add("hidden");
    hideHistogramRangePreview();
  }

  function configureSliderPair(
    lowerInput,
    upperInput,
    range,
    domain,
    { allowUnbounded = false } = {},
  ) {
    if (!lowerInput || !upperInput) {
      return;
    }
    const sliderBounds = getSliderBounds(domain, { allowUnbounded });
    for (const input of [lowerInput, upperInput]) {
      input.min = String(sliderBounds.min);
      input.max = String(sliderBounds.max);
      input.step = String(sliderBounds.step);
    }
    lowerInput.value = String(rawValueToSliderValue(
      range.lower,
      domain,
      "lower",
      { allowUnbounded },
    ));
    upperInput.value = String(rawValueToSliderValue(
      range.upper,
      domain,
      "upper",
      { allowUnbounded },
    ));
  }

  /** @param {HTMLInputElement | null} input @param {string} valueText */
  function setSliderValueText(input, valueText) {
    input?.setAttribute("aria-valuetext", valueText);
  }

  function updateRangeFill(fill, range, domain) {
    if (!fill) {
      return;
    }
    const lowerPercent = rawValueToPercent(range.lower, domain, "lower");
    const upperPercent = rawValueToPercent(range.upper, domain, "upper");
    if (fill.classList.contains("qc-color-fill")) {
      const middlePercent = (lowerPercent + upperPercent) / 2;
      fill.style.left = "0";
      fill.style.right = "0";
      fill.style.background = `linear-gradient(90deg,
      rgba(202, 0, 32, 0.95) 0%,
      rgba(202, 0, 32, 0.95) ${lowerPercent}%,
      rgba(247, 247, 247, 0.95) ${middlePercent}%,
      rgba(5, 113, 176, 0.95) ${upperPercent}%,
      rgba(5, 113, 176, 0.95) 100%)`;
      return;
    }
    fill.style.left = `${lowerPercent}%`;
    fill.style.right = `${100 - upperPercent}%`;
  }

  /**
   * Show a screen-only range guide over the Histogram data area. Percentages
   * are derived from the shared raw interaction domain, not slider pixels;
   * Threshold's extra N/A sentinel stops therefore remain presentation-only.
   *
   * @param {{
   *   kind: "color" | "threshold",
   *   range: { lower: number | null, upper: number | null },
   *   domain: { min: number, max: number, step: number, stopCount?: number },
   * }} options
   */
  function showHistogramRangePreview({ kind, range, domain }) {
    const preview = document.getElementById("qc-histogram-range-preview");
    const plot = document.getElementById("blueprint-stats-plot");
    if (!preview || !range || !domain || plot?.classList.contains("hidden")) {
      hideHistogramRangePreview();
      return false;
    }

    const lowerPercent = Math.max(
      0,
      Math.min(100, rawValueToPercent(range.lower, domain, "lower")),
    );
    const upperPercent = Math.max(
      lowerPercent,
      Math.min(100, rawValueToPercent(range.upper, domain, "upper")),
    );
    const hasLower = range.lower !== null;
    const hasUpper = range.upper !== null;

    preview.dataset.kind = kind;
    preview.style.setProperty("--qc-preview-lower", `${lowerPercent}%`);
    preview.style.setProperty("--qc-preview-upper", `${upperPercent}%`);
    preview.classList.toggle("has-lower", hasLower);
    preview.classList.toggle("has-upper", hasUpper);
    preview.classList.toggle("hidden", kind === "threshold" && !hasLower && !hasUpper);
    return !preview.classList.contains("hidden");
  }

  function hideHistogramRangePreview() {
    const preview = document.getElementById("qc-histogram-range-preview");
    if (!preview) {
      return false;
    }
    preview.classList.add("hidden");
    preview.classList.remove("has-lower", "has-upper");
    preview.removeAttribute("data-kind");
    preview.style.removeProperty("--qc-preview-lower");
    preview.style.removeProperty("--qc-preview-upper");
    return true;
  }

  /**
   * @param {{
   *   range: { lower: number, upper: number },
   *   domain: { min: number, max: number, step: number, stopCount?: number },
   * }} options
   */
  function renderColorRange({ range, domain }) {
    const control = document.getElementById("blueprint-color-range");
    if (!control || !range || !domain) {
      control?.classList.add("hidden");
      return;
    }
    const lowerInput = /** @type {HTMLInputElement | null} */ (
      document.getElementById("qc-color-lower-input")
    );
    const upperInput = /** @type {HTMLInputElement | null} */ (
      document.getElementById("qc-color-upper-input")
    );
    const lowerLabel = document.getElementById("qc-color-lower-label");
    const upperLabel = document.getElementById("qc-color-upper-label");

    configureSliderPair(lowerInput, upperInput, range, domain);
    const lowerText = formatMetricValue(range.lower, domain.step);
    const upperText = formatMetricValue(range.upper, domain.step);
    if (lowerLabel) {
      lowerLabel.textContent = lowerText;
    }
    if (upperLabel) {
      upperLabel.textContent = upperText;
    }
    setSliderValueText(lowerInput, lowerText);
    setSliderValueText(upperInput, upperText);
    if (lowerInput) {
      describeControl(lowerInput, `Lower color mapping bound: ${lowerText}`);
    }
    if (upperInput) {
      describeControl(upperInput, `Upper color mapping bound: ${upperText}`);
    }
    exportRangeLabels = { lower: lowerText, upper: upperText };
    updateRangeFill(document.getElementById("qc-color-fill"), range, domain);
    control.classList.remove("hidden");
  }

  /**
   * @param {{
   *   range: { lower: number | null, upper: number | null },
   *   domain: { min: number, max: number, step: number, stopCount?: number },
   * }} options
   */
  function renderQcRange({ range, domain }) {
    const control = document.getElementById("blueprint-qc-range");
    if (!control || !range || !domain) {
      hideRangeControls();
      return;
    }
    const lowerInput = /** @type {HTMLInputElement | null} */ (
      document.getElementById("qc-range-lower-input")
    );
    const upperInput = /** @type {HTMLInputElement | null} */ (
      document.getElementById("qc-range-upper-input")
    );
    const lowerLabel = document.getElementById("qc-range-lower-label");
    const upperLabel = document.getElementById("qc-range-upper-label");

    configureSliderPair(
      lowerInput,
      upperInput,
      range,
      domain,
      { allowUnbounded: true },
    );
    const lowerText = formatRawBound(range.lower, domain.step);
    const upperText = formatRawBound(range.upper, domain.step);
    if (lowerLabel) {
      lowerLabel.textContent = lowerText;
    }
    if (upperLabel) {
      upperLabel.textContent = upperText;
    }
    setSliderValueText(
      lowerInput,
      range.lower === null ? "No lower limit" : lowerText,
    );
    setSliderValueText(
      upperInput,
      range.upper === null ? "No upper limit" : upperText,
    );
    if (lowerInput) {
      describeControl(
        lowerInput,
        range.lower === null
          ? "No lower threshold is applied"
          : `Lower threshold: ${lowerText}`,
      );
    }
    if (upperInput) {
      describeControl(
        upperInput,
        range.upper === null
          ? "No upper threshold is applied"
          : `Upper threshold: ${upperText}`,
      );
    }
    updateRangeFill(document.getElementById("qc-range-fill"), range, domain);
    control.classList.remove("hidden");
  }

  /**
   * @param {{
   *   enabled: boolean,
   *   colorRange?: { lower: number, upper: number } | null,
   *   qcRange?: { lower: number | null, upper: number | null } | null,
   *   domain?: { min: number, max: number, step: number, stopCount?: number } | null,
   * }} options
   */
  function renderControls({
    enabled,
    colorRange = null,
    qcRange = null,
    domain = null,
  }) {
    if (
      !enabled
      || !colorRange
      || !qcRange
      || !domain
    ) {
      hideRangeControls();
      return;
    }
    renderColorRange({ range: colorRange, domain });
    renderQcRange({ range: qcRange, domain });
  }

  function readSliderValues(lowerId, upperId) {
    const lower = /** @type {HTMLInputElement | null} */ (document.getElementById(lowerId));
    const upper = /** @type {HTMLInputElement | null} */ (document.getElementById(upperId));
    return {
      lower: lower?.value ?? null,
      upper: upper?.value ?? null,
    };
  }

  function readColorSliderValues() {
    return readSliderValues("qc-color-lower-input", "qc-color-upper-input");
  }

  function readQcSliderValues() {
    return readSliderValues("qc-range-lower-input", "qc-range-upper-input");
  }

  function setEmpty(isEmpty) {
    document.querySelector(".qc-card")?.classList.toggle("is-empty", isEmpty);
  }

  function setDownloadButtonsEnabled(enabled) {
    for (const buttonId of Object.values(QC_PLOT_DOWNLOADS)) {
      const button = /** @type {HTMLButtonElement | null} */ (document.getElementById(buttonId));
      if (button) {
        button.disabled = !enabled;
      }
    }
  }

  function setDownloadEnabled(enabled) {
    document.getElementById("qc-download-row")?.classList.toggle("hidden", !enabled);
    setDownloadButtonsEnabled(enabled);
  }

  function getExportRangeLabels() {
    return { ...exportRangeLabels };
  }

  /**
   * @param {{
   *   onToggleMenu?: (options?: { focusMenu?: boolean, focusTarget?: string }) => void,
   *   onCloseMenu?: (options?: { restoreFocus?: boolean }) => void,
   *   onColorInput?: (handle: "lower" | "upper") => void,
   *   onQcInput?: (handle: "lower" | "upper") => void,
   *   onRangeInteractionStart?: (kind: "color" | "threshold") => void,
   *   onRangeInteractionEnd?: (kind: "color" | "threshold", options: { canceled: boolean }) => void,
   *   onDownload?: (format: "svg" | "png") => unknown,
   * }} effects
   */
  function wire({
    onToggleMenu = toggleMenu,
    onCloseMenu = closeMenu,
    onColorInput = () => {},
    onQcInput = () => {},
    onRangeInteractionStart = () => {},
    onRangeInteractionEnd = () => {},
    onDownload = () => {},
  } = {}) {
    if (wired) {
      return false;
    }
    wired = true;

    const blueprintButton = document.getElementById("blueprint-select");
    blueprintButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      onToggleMenu({ focusMenu: false });
    });
    blueprintButton?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onToggleMenu({ focusMenu: true });
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const menu = document.getElementById("blueprint-menu");
        if (menu?.classList.contains("hidden")) {
          onToggleMenu({
            focusMenu: true,
            focusTarget: event.key === "ArrowDown" ? "first" : "last",
          });
        } else {
          focusMenuOption(event.key === "ArrowDown" ? "first" : "last");
        }
      }
      if (event.key === "Escape") {
        onCloseMenu({ restoreFocus: true });
      }
    });
    document.getElementById("blueprint-menu")?.addEventListener("keydown", (event) => {
      const options = metricOptions();
      if (!options.length) {
        return;
      }
      const currentIndex = options.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseMenu({ restoreFocus: true });
        return;
      }
      if (event.key === "Tab") {
        onCloseMenu();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      let nextIndex = currentIndex;
      if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = options.length - 1;
      } else if (event.key === "ArrowDown") {
        nextIndex = (Math.max(-1, currentIndex) + 1) % options.length;
      } else {
        nextIndex = (currentIndex <= 0 ? options.length : currentIndex) - 1;
      }
      options[nextIndex]?.focus();
      options[nextIndex]?.scrollIntoView({ block: "nearest" });
    });
    document.addEventListener("pointerdown", (event) => {
      const picker = document.getElementById("blueprint-picker");
      const menu = document.getElementById("blueprint-menu");
      if (
        !menu
        || menu.classList.contains("hidden")
        || picker?.contains(/** @type {Node} */ (event.target))
      ) {
        return;
      }
      onCloseMenu();
      event.preventDefault();
      event.stopPropagation();
    }, true);
    document.addEventListener("scroll", positionMenu, true);
    document.defaultView?.addEventListener("resize", positionMenu);

    function bindRangePair({
      kind,
      containerSelector,
      lowerId,
      upperId,
      onInput,
    }) {
      const container = /** @type {HTMLElement | null} */ (
        document.querySelector(containerSelector)
      );
      const lowerInput = /** @type {HTMLInputElement | null} */ (
        document.getElementById(lowerId)
      );
      const upperInput = /** @type {HTMLInputElement | null} */ (
        document.getElementById(upperId)
      );
      if (!container || !lowerInput || !upperInput) {
        return false;
      }
      wireDualRangeController({
        container,
        lowerInput,
        upperInput,
        onInput(handle) {
          onInput(handle);
        },
        onInteractionStart() {
          onRangeInteractionStart(kind);
        },
        onInteractionEnd({ canceled }) {
          onRangeInteractionEnd(kind, { canceled });
        },
      });
      return true;
    }

    bindRangePair({
      kind: "color",
      containerSelector: "#blueprint-color-range .qc-range-slider",
      lowerId: "qc-color-lower-input",
      upperId: "qc-color-upper-input",
      onInput: onColorInput,
    });
    bindRangePair({
      kind: "threshold",
      containerSelector: "#blueprint-qc-range .qc-range-slider",
      lowerId: "qc-range-lower-input",
      upperId: "qc-range-upper-input",
      onInput: onQcInput,
    });
    for (const [format, buttonId] of Object.entries(QC_PLOT_DOWNLOADS)) {
      const button = document.getElementById(buttonId);
      if (!button) {
        continue;
      }
      button.addEventListener("click", () => onDownload(/** @type {"svg" | "png"} */ (format)));
    }
    setDownloadEnabled(false);
    return true;
  }

  return {
    renderMetricControl,
    updateMetricThreshold,
    renderQcRange,
    renderControls,
    showHistogramRangePreview,
    hideHistogramRangePreview,
    readColorSliderValues,
    readQcSliderValues,
    setEmpty,
    setDownloadButtonsEnabled,
    setDownloadEnabled,
    getExportRangeLabels,
    wire,
  };
}
