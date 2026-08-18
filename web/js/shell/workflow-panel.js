/**
 * Own the workflow panel's shell-only DOM and interaction behavior. Feature
 * rendering remains behind the supplied effects and is never imported here.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     activateWorkflowSection: (section: string) => unknown,
 *     toggleWorkflowSection: (section: string) => unknown,
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

  function renderChrome() {
    const state = store.getSnapshot();
    if (!sectionIds.includes(state.activeWorkflowSection)) {
      commands.setActiveWorkflowSection(sectionIds[0]);
    }

    for (const section of sectionIds) {
      const isActive = section === state.activeWorkflowSection;
      const isOpen = Boolean(state.openSections[section]);
      const sectionElement = document.querySelector(
        `[data-workflow-section="${section}"]`,
      );
      sectionElement?.classList.remove("hidden");
      sectionElement?.classList.toggle("active", isActive);
      sectionElement?.classList.toggle("collapsed", !isOpen);

      const toggle = document.querySelector(`[data-section-toggle="${section}"]`);
      toggle?.setAttribute("aria-expanded", String(isOpen));
    }
  }

  /**
   * @param {unknown} section
   * @param {{
   *   persistUiState: () => void,
   *   renderSections: (options: { includeMap: boolean, includePlots: boolean }) => void,
   * }} effects
   * @param {{ scroll?: boolean, includePlots?: boolean }} [options]
   */
  function activateSection(
    section,
    effects,
    { scroll = false, includePlots = false } = {},
  ) {
    const state = store.getSnapshot();
    const next = normalizeSection(section, state.activeWorkflowSection);
    const changed = state.activeWorkflowSection !== next;
    commands.activateWorkflowSection(next);
    effects.persistUiState();
    effects.renderSections({ includeMap: changed, includePlots });

    if (scroll) {
      document.querySelector(`[data-workflow-section="${next}"]`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
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
    commands.toggleWorkflowSection(next);
    effects.persistUiState();
    effects.renderSections({
      includeMap: true,
      includePlots: isTemporalSection(next),
    });
  }

  /**
   * @param {{
   *   persistUiState: () => void,
   *   renderSections: (options: { includeMap: boolean, includePlots: boolean }) => void,
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
      if (!element) {
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
      effects.persistUiState();
      effects.renderSections({
        includeMap: true,
        includePlots: isTemporalSection(bestSection),
      });
    }
  }

  /**
   * @param {{
   *   persistUiState: () => void,
   *   renderSections: (options: { includeMap: boolean, includePlots: boolean }) => void,
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
    activateSection,
    toggleSection,
    syncActiveFromScroll,
    wire,
  };
}
