/**
 * Application-level UI-state boundary. Domain normalization remains with the
 * owning feature or Shell facade; transport, debounce, retry, and
 * beacon behavior remain inside the injected persistence service.
 *
 * @param {{
 *   store: { getSnapshot: () => Record<string, any> },
 *   commands: {
 *     replaceOpenSections: (openSections: Record<string, boolean>) => unknown,
 *     setActiveWorkflowSection: (section: string) => unknown,
 *     setOverlayWidth: (width: number | null) => unknown,
 *   },
 *   selectors: {
 *     isCanonicalPersistedUiState: (value: unknown) => value is Record<string, any>,
 *     selectPersistedUiState: (state: Record<string, any>) => Record<string, any>,
 *   },
 *   features: {
 *     background: Record<string, any>,
 *     qualityControl: Record<string, any>,
 *     region: Record<string, any>,
 *     roi: Record<string, any>,
 *     temporal: Record<string, any>,
 *   },
 *   shell: Record<string, any>,
 *   persistence: {
 *     save: () => void,
 *     load: () => Promise<boolean>,
 *     flush: (options?: { keepalive?: boolean }) => Promise<void>,
 *     sendPendingBeacon: () => void,
 *   },
 *   logger?: Pick<Console, "error">,
 * }} dependencies
 */
export function createUiStateController({
  store,
  commands,
  selectors,
  features,
  shell,
  persistence,
  logger = globalThis.console,
}) {
  function serialize() {
    return selectors.selectPersistedUiState(store.getSnapshot());
  }

  function apply(parsed) {
    if (!selectors.isCanonicalPersistedUiState(parsed)) {
      return false;
    }
    try {
      if (!features.roi.applyPersistedState(parsed)) {
        return false;
      }
      features.temporal.applyPersistedState(parsed);
      features.background.setActive(parsed.activeBackgroundKey);
      features.qualityControl.applyPersistedState(parsed);
      commands.setActiveWorkflowSection(shell.normalizeSection(
        parsed.activeWorkflowSection,
        store.getSnapshot().activeWorkflowSection,
      ));
      commands.replaceOpenSections(shell.normalizeOpenSections(parsed.openSections));
      features.region.applyPersistedState(parsed);
      commands.setOverlayWidth(shell.normalizeOverlayWidth(parsed.overlayWidth));
      return true;
    } catch (error) {
      logger.error(error);
      return false;
    }
  }

  return Object.freeze({
    apply,
    serialize,
    save: persistence.save,
    load: persistence.load,
    flush: persistence.flush,
    sendPendingBeacon: persistence.sendPendingBeacon,
  });
}
