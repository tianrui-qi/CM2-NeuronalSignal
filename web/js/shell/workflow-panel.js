/**
 * Own the workflow panel's shell-only DOM and interaction behavior. Feature
 * rendering remains behind the supplied effects and is never imported here.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     toggleWorkflowSection: (section: string) => { blocked?: boolean } | null | undefined,
 *     setActiveWorkflowSection: (section: string) => unknown,
 *   },
 *   renderScheduler: { scheduleScrollSync: (callback: () => void) => void },
 *   document: Document,
 *   sectionIds: readonly string[],
 *   normalizeSection: (section: unknown, fallback?: string) => string,
 *   isTemporalSection: (section: unknown) => boolean,
 * }} options
 */
export function createWorkflowPanel({
  store,
  commands,
  renderScheduler,
  document,
  sectionIds,
  normalizeSection,
  isTemporalSection,
}) {
  let wired = false;

  /** @param {{ hiddenSections?: readonly string[] }} [options] */
  function renderChrome({ hiddenSections = [] } = {}) {
    const state = store.getSnapshot();
    const hiddenSectionIds = new Set(hiddenSections);
    if (!sectionIds.includes(state.activeWorkflowSection)) {
      commands.setActiveWorkflowSection(sectionIds[0]);
    }

    for (const section of sectionIds) {
      const isActive = section === state.activeWorkflowSection;
      const isOpen = Boolean(state.openSections[section]);
      const isHidden = hiddenSectionIds.has(section);
      const sectionElement = document.querySelector(
        `[data-workflow-section="${section}"]`,
      );
      sectionElement?.classList.toggle("hidden", isHidden);
      sectionElement?.setAttribute("aria-hidden", String(isHidden));
      sectionElement?.classList.toggle("active", isActive);
      sectionElement?.classList.toggle("collapsed", !isOpen);

      const toggle = document.querySelector(`[data-section-toggle="${section}"]`);
      toggle?.setAttribute("aria-expanded", String(isOpen));
      const collapseLocked = section === "region" && state.regionDraft.active;
      if (toggle?.tagName === "BUTTON") {
        toggle.disabled = collapseLocked;
      }
      toggle?.setAttribute("aria-disabled", String(collapseLocked));
    }
  }

  /**
   * @param {unknown} section
   * @param {{
   *   persistUiState: () => void,
   *   renderSections: (options: { includeMap: boolean, includePlots: boolean }) => void,
   * }} effects
   */
  function toggleSection(section, effects) {
    const state = store.getSnapshot();
    const next = normalizeSection(section, state.activeWorkflowSection);
    const result = commands.toggleWorkflowSection(next);
    if (result?.blocked) {
      return false;
    }
    effects.persistUiState();
    effects.renderSections({
      includeMap: false,
      includePlots: isTemporalSection(next),
    });
    return true;
  }

  /**
   * @param {{
   *   renderChrome: () => unknown,
   * }} effects
   */
  function syncActiveFromScroll(effects) {
    const panel = document.getElementById("workflow-panel");
    if (!panel) {
      return;
    }

    const state = store.getSnapshot();
    const panelTop = panel.getBoundingClientRect().top;
    let bestSection = state.activeWorkflowSection;
    let bestDistance = Infinity;
    for (const section of sectionIds) {
      const element = document.querySelector(`[data-workflow-section="${section}"]`);
      if (!element || element.classList.contains("hidden")) {
        continue;
      }
      const distance = Math.abs(element.getBoundingClientRect().top - panelTop);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestSection = section;
      }
    }

    if (bestSection !== state.activeWorkflowSection) {
      commands.setActiveWorkflowSection(bestSection);
      effects.renderChrome();
    }
  }

  /**
   * @param {{
   *   persistUiState: () => void,
   *   renderSections: (options: { includeMap: boolean, includePlots: boolean }) => void,
   *   renderChrome: () => unknown,
   * }} effects
   * @returns {boolean}
   */
  function wire(effects) {
    if (wired) {
      return false;
    }
    wired = true;

    for (const section of sectionIds) {
      document.querySelector(`[data-section-toggle="${section}"]`)?.addEventListener(
        "click",
        () => toggleSection(section, effects),
      );
    }

    const panel = document.getElementById("workflow-panel");
    panel?.addEventListener("scroll", () => {
      renderScheduler.scheduleScrollSync(() => syncActiveFromScroll(effects));
    });
    return true;
  }

  return {
    renderChrome,
    wire,
  };
}
