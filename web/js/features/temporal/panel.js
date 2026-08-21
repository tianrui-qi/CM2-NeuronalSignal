import { wireRangeController } from "../../shared/ui/range-controller.js";


const TRACE_SOURCE_DESCRIPTIONS = Object.freeze({
  c_bl: "Neuron temporal trace (C)",
  c_bl_plus_yra: "Neuron temporal trace (C) plus the spatially filtered residual signal (YrA)",
});

const TRACE_VALUE_MODE_DESCRIPTIONS = Object.freeze({
  df: "Fluorescence change (ΔF)",
  dff: "Fluorescence change relative to background fluorescence (ΔF/F)",
});

const SEGMENTED_TOGGLE_GROUP_LABELS = Object.freeze({
  "heatmap-source-toggle": "Heatmap signal source",
  "heatmap-value-toggle": "Heatmap value mode",
  "trace-source-toggle": "Trace signal source",
  "trace-value-toggle": "Trace value mode",
});

/**
 * Temporal controls DOM boundary. State normalization, scientific values,
 * Plotly lifecycle, persistence, and cross-feature orchestration stay outside
 * this module.
 *
 * @param {{ document: Document }} dependencies
 */
export function createTemporalPanel({ document }) {
  /** @type {Array<{ destroy: () => boolean }>} */
  let scaleControllers = [];
  /**
   * @param {string} containerId
   * @param {string[]} keys
   * @param {Record<string, string>} labels
   * @param {Record<string, string>} descriptions
   * @param {string} activeKey
   * @param {(key: string) => void} onSelect
   */
  function renderSegmentedToggle(
    containerId,
    keys,
    labels,
    descriptions,
    activeKey,
    onSelect,
  ) {
    const container = document.getElementById(containerId);
    if (!container) {
      return;
    }
    container.setAttribute("role", "group");
    container.setAttribute(
      "aria-label",
      SEGMENTED_TOGGLE_GROUP_LABELS[containerId] ?? "Temporal options",
    );
    container.innerHTML = "";
    if (keys.length <= 1) {
      container.style.display = "none";
      return;
    }
    container.style.display = "inline-flex";
    for (const key of keys) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `trace-source-btn${key === activeKey ? " active" : ""}`;
      button.setAttribute("aria-pressed", String(key === activeKey));
      button.textContent = labels[key] ?? key;
      button.dataset.controlDescription = descriptions[key] ?? `Select ${labels[key] ?? key}`;
      button.addEventListener("click", () => onSelect(key));
      container.appendChild(button);
    }
  }

  /**
   * @param {{
   *   sourceKeys: string[],
   *   sourceLabels: Record<string, string>,
   *   activeSourceKey: string,
   *   valueModes: string[],
   *   valueModeLabels: Record<string, string>,
   *   activeValueMode: string,
   *   onSourceSelect: (sourceKey: string) => void,
   *   onValueModeSelect: (valueMode: string) => void,
   * }} options
   */
  function renderSourceValueControls({
    sourceKeys,
    sourceLabels,
    activeSourceKey,
    valueModes,
    valueModeLabels,
    activeValueMode,
    onSourceSelect,
    onValueModeSelect,
  }) {
    renderSegmentedToggle(
      "heatmap-source-toggle",
      sourceKeys,
      sourceLabels,
      TRACE_SOURCE_DESCRIPTIONS,
      activeSourceKey,
      onSourceSelect,
    );
    renderSegmentedToggle(
      "heatmap-value-toggle",
      valueModes,
      valueModeLabels,
      TRACE_VALUE_MODE_DESCRIPTIONS,
      activeValueMode,
      onValueModeSelect,
    );
    renderSegmentedToggle(
      "trace-source-toggle",
      sourceKeys,
      sourceLabels,
      TRACE_SOURCE_DESCRIPTIONS,
      activeSourceKey,
      onSourceSelect,
    );
    renderSegmentedToggle(
      "trace-value-toggle",
      valueModes,
      valueModeLabels,
      TRACE_VALUE_MODE_DESCRIPTIONS,
      activeValueMode,
      onValueModeSelect,
    );
  }

  /** @param {{ buttons?: Record<string, string> }} spec @param {boolean} enabled */
  function setDownloadEnabled(spec, enabled) {
    for (const buttonId of Object.values(spec.buttons ?? {})) {
      const button = /** @type {HTMLButtonElement | null} */ (
        document.getElementById(buttonId)
      );
      if (button) {
        button.disabled = !enabled;
      }
    }
  }

  /**
   * @param {Record<string, { buttons?: Record<string, string> }>} specs
   * @param {(spec: any, format: string) => void} onDownload
   */
  function wireDownloadButtons(specs, onDownload) {
    for (const spec of Object.values(specs)) {
      for (const [format, buttonId] of Object.entries(spec.buttons ?? {})) {
        const button = /** @type {HTMLButtonElement | null} */ (
          document.getElementById(buttonId)
        );
        if (!button || button.dataset.downloadWired === "true") {
          continue;
        }
        button.addEventListener("click", () => onDownload(spec, format));
        button.dataset.downloadWired = "true";
      }
      // updatePlots() disables both targets before each render; the
      // plot renderers enable only plots that have data.
      setDownloadEnabled(spec, false);
    }
  }

  /** @param {unknown} value */
  function formatTraceControlNumber(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return "N/A";
    }
    return Number.isInteger(numericValue)
      ? String(numericValue)
      : numericValue.toFixed(1);
  }

  /**
   * @param {{
   *   label: string,
   *   value: number,
   *   min: number,
   *   max: number,
   *   step: number,
   *   normalize: (value: number) => number,
   *   valueLabel: (value: number) => string,
   *   description: string,
   *   onInput: (value: number) => void,
   *   onInteractionStart: (modality: "pointer" | "keyboard") => void,
   *   onInteractionEnd: (options: { modality: "pointer" | "keyboard", canceled: boolean }) => void,
   * }} options
   */
  function renderScaleControl({
    label,
    value,
    min,
    max,
    step,
    normalize,
    valueLabel,
    description,
    onInput,
    onInteractionStart,
    onInteractionEnd,
  }) {
    const control = document.createElement("label");
    control.className = "trace-scale-control";
    const header = document.createElement("span");
    header.className = "trace-scale-control-header";
    const labelText = document.createElement("span");
    labelText.textContent = label;
    const valueText = document.createElement("span");
    valueText.className = "trace-scale-control-value";
    valueText.textContent = valueLabel(value);
    header.append(labelText, valueText);

    const input = document.createElement("input");
    input.className = "trace-scale-input";
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.setAttribute("aria-label", label);
    input.dataset.controlDescription = description;

    /** @param {number} nextValue */
    const updateInputPresentation = (nextValue) => {
      const numericMin = Number(input.min);
      const numericMax = Number(input.max);
      const progress = numericMax > numericMin
        ? Math.max(
            0,
            Math.min(
              100,
              ((nextValue - numericMin) / (numericMax - numericMin)) * 100,
            ),
          )
        : 0;
      const formattedValue = valueLabel(nextValue);
      input.style.setProperty("--slider-progress", `${progress}%`);
      input.setAttribute("aria-valuetext", formattedValue);
      valueText.textContent = formattedValue;
    };

    updateInputPresentation(value);
    const controller = wireRangeController({
      input,
      onInput(rawValue) {
        const nextValue = normalize(Number(rawValue));
        input.value = String(nextValue);
        updateInputPresentation(nextValue);
        onInput(nextValue);
      },
      onInteractionStart,
      onInteractionEnd,
    });
    control.append(header, input);
    return { control, controller };
  }

  /**
   * @param {{
   *   visible: boolean,
   *   spacingValue: number,
   *   scaleValue: number,
   *   spacing: {
   *     min: number,
   *     max: number,
   *     step: number,
   *     normalize: (value: number) => number,
   *     valueLabel: (value: number) => string,
   *     description: string,
   *   },
   *   scale: {
   *     min: number,
   *     max: number,
   *     step: number,
   *     normalize: (value: number) => number,
   *     valueLabel: (value: number) => string,
   *     description: string,
   *   },
   *   onSpacingInput: (value: number) => void,
   *   onScaleInput: (value: number) => void,
   *   onSpacingInteractionStart: (modality: "pointer" | "keyboard") => void,
   *   onScaleInteractionStart: (modality: "pointer" | "keyboard") => void,
   *   onSpacingInteractionEnd: (options: { modality: "pointer" | "keyboard", canceled: boolean }) => void,
   *   onScaleInteractionEnd: (options: { modality: "pointer" | "keyboard", canceled: boolean }) => void,
   * }} options
   */
  function renderScaleControls({
    visible,
    spacingValue,
    scaleValue,
    spacing,
    scale,
    onSpacingInput,
    onScaleInput,
    onSpacingInteractionStart,
    onScaleInteractionStart,
    onSpacingInteractionEnd,
    onScaleInteractionEnd,
  }) {
    const container = document.getElementById("trace-scale-controls");
    if (!container) {
      return;
    }
    container.classList.toggle("hidden", !visible);
    for (const controller of scaleControllers) {
      controller.destroy();
    }
    scaleControllers = [];
    container.innerHTML = "";
    if (!visible) {
      return;
    }
    const spacingControl = renderScaleControl({
      label: "Spacing",
      value: spacingValue,
      ...spacing,
      onInput: onSpacingInput,
      onInteractionStart: onSpacingInteractionStart,
      onInteractionEnd: onSpacingInteractionEnd,
    });
    const scaleControl = renderScaleControl({
      label: "Scale",
      value: scaleValue,
      ...scale,
      onInput: onScaleInput,
      onInteractionStart: onScaleInteractionStart,
      onInteractionEnd: onScaleInteractionEnd,
    });
    scaleControllers = [spacingControl.controller, scaleControl.controller];
    container.append(
      spacingControl.control,
      scaleControl.control,
    );
  }

  return {
    renderSourceValueControls,
    setDownloadEnabled,
    wireDownloadButtons,
    renderScaleControls,
    formatTraceControlNumber,
  };
}
