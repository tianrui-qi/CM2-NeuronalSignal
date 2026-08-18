export const UI_STATE_SAVE_DEBOUNCE_MS = 250;
export const UI_STATE_SAVE_RETRY_MS = 1000;

function defaultSetTimeout(callback, delay) {
  return globalThis.setTimeout(callback, delay);
}

function defaultClearTimeout(timerId) {
  globalThis.clearTimeout(timerId);
}

/**
 * Coordinate debounced remote persistence, retry, and load.
 * The serialize/apply callbacks keep all viewer-domain behavior outside this
 * infrastructure module.
 *
 * @param {{
 *   client: {
 *     load: () => Promise<unknown | null>,
 *     save: (payload: unknown, options?: { keepalive?: boolean }) => Promise<void>,
 *     canSendBeacon: () => boolean,
 *     sendBeacon: (payload: unknown) => boolean,
 *   },
 *   serialize: () => unknown,
 *   apply: (payload: unknown) => boolean,
 *   setTimeoutImpl?: (callback: () => unknown, delay: number) => unknown,
 *   clearTimeoutImpl?: (timerId: unknown) => void,
 *   logger?: Pick<Console, "warn">,
 *   debounceMs?: number,
 *   retryMs?: number,
 * }} options
 */
export function createUiStateSaveCoordinator({
  client,
  serialize,
  apply,
  setTimeoutImpl = defaultSetTimeout,
  clearTimeoutImpl = defaultClearTimeout,
  logger = globalThis.console,
  debounceMs = UI_STATE_SAVE_DEBOUNCE_MS,
  retryMs = UI_STATE_SAVE_RETRY_MS,
}) {
  /** @type {unknown | null} */
  let pendingPayload = null;
  /** @type {unknown | null} */
  let saveTimer = null;

  /**
   * @param {unknown} payload
   */
  function queue(payload) {
    pendingPayload = payload;
    if (saveTimer !== null) {
      clearTimeoutImpl(saveTimer);
    }
    saveTimer = setTimeoutImpl(() => flush(), debounceMs);
  }

  /**
   * Serialize synchronously, then queue the same payload reference for remote
   * persistence.
   */
  function save() {
    const payload = serialize();
    queue(payload);
  }

  /**
   * @param {{ keepalive?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async function flush({ keepalive = false } = {}) {
    if (saveTimer !== null) {
      clearTimeoutImpl(saveTimer);
      saveTimer = null;
    }
    if (!pendingPayload) {
      return;
    }

    const payload = pendingPayload;
    pendingPayload = null;
    try {
      await client.save(payload, { keepalive });
    } catch (error) {
      if (!pendingPayload) {
        pendingPayload = payload;
        saveTimer = setTimeoutImpl(() => flush(), retryMs);
      }
      logger.warn("Failed to save viewer state to cache cookie folder.", error);
    }
  }

  /**
   * Load the server-authoritative state, then delegate domain application to
   * the caller.
   *
   * @returns {Promise<boolean>}
   */
  async function load() {
    try {
      const remoteState = await client.load();
      if (!remoteState) {
        return false;
      }
      const loaded = apply(remoteState);
      return loaded;
    } catch (error) {
      logger.warn(
        "Remote cache cookie state is unavailable; starting with a fresh viewer state.",
        error
      );
      return false;
    }
  }

  /**
   * Try the existing pagehide beacon path without disturbing the save timer.
   */
  function sendPendingBeacon() {
    if (!pendingPayload || !client.canSendBeacon()) {
      return;
    }
    const payload = pendingPayload;
    pendingPayload = null;
    if (!client.sendBeacon(payload)) {
      pendingPayload = payload;
    }
  }

  return {
    save,
    load,
    flush,
    sendPendingBeacon,
  };
}
