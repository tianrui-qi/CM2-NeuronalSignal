import { placeAnchoredPopover } from "../../shared/ui/anchored-popover.js";
import { describeControl } from "../../shared/ui/control-tooltip.js";
import { wireDualRangeController } from "../../shared/ui/dual-range-controller.js";
import { backgroundValueToPercent } from "./model.js";


const BACKGROUND_DESCRIPTIONS = Object.freeze({
  mean: "Show the mean-intensity image as the map background",
  std: "Show the temporal standard-deviation image as the map background",
  bandpass: "Show the bandpass-enhanced STD image as the map background",
});


/** @param {any} background */
function backgroundDescription(background) {
  const label = background.label ?? background.key;
  return BACKGROUND_DESCRIPTIONS[background.key]
    ?? "Show " + label + " as the map background";
}


/**
 * Presentation-only owner for the Background DOM. State mutation,
 * persistence, cache loading, and Map rendering remain outside this module.
 *
 * @param {{ document: Document }} options
 */
export function createBackgroundPanel({ document }) {
  let effects = {
    onSelect: /** @param {string} _key */ (_key) => {},
    onRangeInput: /** @param {"lower" | "upper"} _handle @param {string} _value */ (
      _handle,
      _value,
    ) => {},
    onRangeReset: /** @param {"lower" | "upper"} _handle */ (_handle) => {},
    onRangeInteractionStart: () => {},
    onRangeInteractionEnd: /** @param {{ canceled: boolean }} _options */ (_options) => {},
  };

  function backgroundOptions() {
    return Array.from(document.querySelectorAll("#background-menu .background-picker-option"));
  }

  function positionMenu() {
    const menu = document.getElementById("background-menu");
    const picker = document.getElementById("background-picker");
    if (!menu || !picker || menu.classList.contains("hidden")) {
      return null;
    }
    return placeAnchoredPopover({
      popup: menu,
      anchor: picker,
      boundary: document.getElementById("workflow-panel"),
      preferred: "down",
      maxHeight: 220,
    });
  }

  function closeMenu({ restoreFocus = false } = {}) {
    const menu = document.getElementById("background-menu");
    const button = document.getElementById("background-select");
    const section = document.getElementById("background-section");
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
    const options = backgroundOptions();
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
    const menu = document.getElementById("background-menu");
    const button = document.getElementById("background-select");
    const section = document.getElementById("background-section");
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
    if (focusMenu) {
      focusMenuOption(focusTarget);
    }
  }

  /**
   * @param {{
   *   backgrounds: any[],
   *   activeKey: string | null,
   * }} options
   */
  function renderPicker({ backgrounds, activeKey }) {
    const button = /** @type {HTMLButtonElement | null} */ (
      document.getElementById("background-select")
    );
    const label = document.getElementById("background-select-label");
    const menu = document.getElementById("background-menu");
    if (!button || !label || !menu) {
      return;
    }

    const active = backgrounds.find((background) => background.key === activeKey);
    button.value = activeKey ?? "";
    button.dataset.value = activeKey ?? "";
    label.textContent = active?.label ?? activeKey ?? "None";
    menu.replaceChildren();

    for (const background of backgrounds) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "background-picker-option"
        + (background.key === activeKey ? " is-active" : "");
      option.dataset.value = background.key;
      option.tabIndex = -1;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(background.key === activeKey));
      option.textContent = background.label ?? background.key;
      describeControl(option, backgroundDescription(background));
      option.addEventListener("click", (event) => {
        event.stopPropagation();
        closeMenu({ restoreFocus: event.detail === 0 });
        effects.onSelect(background.key);
      });
      menu.appendChild(option);
    }
  }

  /**
   * @param {{
   *   range: { lower: number, upper: number } | null,
   *   domain: { lower: number, upper: number } | null,
   *   autoRange: { lower: number, upper: number } | null,
   * }} options
   */
  function renderRange({ range, domain, autoRange }) {
    const control = document.getElementById("background-range");
    const lowerInput = /** @type {HTMLInputElement | null} */ (
      document.getElementById("background-range-lower-input")
    );
    const upperInput = /** @type {HTMLInputElement | null} */ (
      document.getElementById("background-range-upper-input")
    );
    if (!control || !lowerInput || !upperInput || !range || !domain) {
      control?.classList.add("hidden");
      return;
    }

    for (const input of [lowerInput, upperInput]) {
      input.min = String(domain.lower);
      input.max = String(domain.upper);
      input.step = "1";
    }
    lowerInput.value = String(range.lower);
    upperInput.value = String(range.upper);

    const lowerText = String(range.lower);
    const upperText = String(range.upper);
    const lowerLabel = document.getElementById("background-range-lower-label");
    const upperLabel = document.getElementById("background-range-upper-label");
    const centerLabel = document.getElementById("background-range-center-label");
    if (lowerLabel) {
      lowerLabel.textContent = lowerText;
    }
    if (upperLabel) {
      upperLabel.textContent = upperText;
    }
    if (centerLabel) {
      centerLabel.textContent = "Color Map";
    }

    const isLowerAuto = range.lower === autoRange?.lower;
    const isUpperAuto = range.upper === autoRange?.upper;

    lowerInput.setAttribute(
      "aria-valuetext",
      isLowerAuto ? lowerText + ", automatic minimum" : lowerText,
    );
    upperInput.setAttribute(
      "aria-valuetext",
      isUpperAuto ? upperText + ", automatic maximum" : upperText,
    );
    describeControl(
      lowerInput,
      "Minimum displayed intensity: " + lowerText
        + (isLowerAuto ? ", automatic" : "")
        + "; double-click or double-tap the thumb to restore it",
    );
    describeControl(
      upperInput,
      "Maximum displayed intensity: " + upperText
        + (isUpperAuto ? ", automatic" : "")
        + "; double-click or double-tap the thumb to restore it",
    );

    const fill = document.getElementById("background-range-fill");
    if (fill) {
      const lowerPercent = backgroundValueToPercent(range.lower, domain);
      const upperPercent = backgroundValueToPercent(range.upper, domain);
      fill.style.left = lowerPercent + "%";
      fill.style.right = (100 - upperPercent) + "%";
    }
    control.classList.remove("hidden");
  }

  /**
   * @param {{
   *   backgrounds: any[],
   *   activeKey: string | null,
   *   range: { lower: number, upper: number } | null,
   *   domain: { lower: number, upper: number } | null,
   *   autoRange: { lower: number, upper: number } | null,
   *   onSelect?: (key: string) => void,
   *   onRangeInput?: (handle: "lower" | "upper", value: string) => void,
   *   onRangeReset?: (handle: "lower" | "upper") => void,
   *   onRangeInteractionStart?: () => void,
   *   onRangeInteractionEnd?: (options: { canceled: boolean }) => void,
   * }} options
   */
  function renderControl({
    backgrounds,
    activeKey,
    range,
    domain,
    autoRange,
    onSelect = () => {},
    onRangeInput = () => {},
    onRangeReset = () => {},
    onRangeInteractionStart = () => {},
    onRangeInteractionEnd = () => {},
  }) {
    effects = {
      onSelect,
      onRangeInput,
      onRangeReset,
      onRangeInteractionStart,
      onRangeInteractionEnd,
    };
    renderPicker({ backgrounds, activeKey });
    renderRange({ range, domain, autoRange });
  }

  function wire() {
    const selectButton = document.getElementById("background-select");
    selectButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMenu();
    });
    selectButton?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleMenu({ focusMenu: true });
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const menu = document.getElementById("background-menu");
        if (menu?.classList.contains("hidden")) {
          toggleMenu({
            focusMenu: true,
            focusTarget: event.key === "ArrowDown" ? "first" : "last",
          });
        } else {
          focusMenuOption(event.key === "ArrowDown" ? "first" : "last");
        }
      }
      if (event.key === "Escape") {
        closeMenu({ restoreFocus: true });
      }
      if (event.key === "Tab") {
        closeMenu();
      }
    });
    document.getElementById("background-menu")?.addEventListener("keydown", (event) => {
      const options = backgroundOptions();
      if (!options.length) {
        return;
      }
      const currentIndex = options.indexOf(document.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu({ restoreFocus: true });
        return;
      }
      if (event.key === "Tab") {
        closeMenu();
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
      const picker = document.getElementById("background-picker");
      const menu = document.getElementById("background-menu");
      if (
        !menu
        || menu.classList.contains("hidden")
        || picker?.contains(/** @type {Node} */ (event.target))
      ) {
        return;
      }
      closeMenu();
      event.preventDefault();
      event.stopPropagation();
    }, true);
    document.addEventListener("scroll", positionMenu, true);
    document.defaultView?.addEventListener("resize", positionMenu);

    const rangeSlider = /** @type {HTMLElement | null} */ (
      document.getElementById("background-range")?.querySelector(
        ".background-range-slider",
      )
    );
    const lowerRangeInput = /** @type {HTMLInputElement | null} */ (
      document.getElementById("background-range-lower-input")
    );
    const upperRangeInput = /** @type {HTMLInputElement | null} */ (
      document.getElementById("background-range-upper-input")
    );
    if (rangeSlider && lowerRangeInput && upperRangeInput) {
      wireDualRangeController({
        container: rangeSlider,
        lowerInput: lowerRangeInput,
        upperInput: upperRangeInput,
        onInput(handle, value) {
          effects.onRangeInput(handle, value);
        },
        onDoubleActivate(handle) {
          effects.onRangeReset(handle);
        },
        onInteractionStart() {
          effects.onRangeInteractionStart();
        },
        onInteractionEnd({ canceled }) {
          effects.onRangeInteractionEnd({ canceled });
        },
      });
    }
  }

  wire();
  return Object.freeze({
    renderControl,
    renderRange,
  });
}
