import { encodeUiState } from "./codec.js";
import { UiStateClientErrorCode } from "../errors.js";


export const UI_STATE_SAVE_DEBOUNCE_MS = 250;
export const UI_STATE_SAVE_RETRY_MS = 1000;
export const UI_STATE_LOCAL_STORAGE_PREFIX = "cm2.ui-state:v1";

function defaultSetTimeout(callback, delay) {
  return globalThis.setTimeout(callback, delay);
}

function defaultClearTimeout(timerId) {
  globalThis.clearTimeout(timerId);
}

function defaultLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function cloneJsonValue(value) {
  return JSON.parse(encodeUiState(value));
}

/**
 * Compare JSON values without depending on object insertion order.
 * Array order remains significant because ROI and polygon order are state.
 *
 * @param {unknown} left
 * @param {unknown} right
 */
export function uiStatesEqual(left, right) {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => uiStatesEqual(value, right[index]));
  }
  if (
    !left
    || !right
    || typeof left !== "object"
    || typeof right !== "object"
  ) {
    return false;
  }
  const leftRecord = /** @type {Record<string, unknown>} */ (left);
  const rightRecord = /** @type {Record<string, unknown>} */ (right);
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && uiStatesEqual(leftRecord[key], rightRecord[key])
    ));
}

/** @param {string} serverStorageKey */
export function buildUiStateLocalStorageKey(serverStorageKey) {
  return `${UI_STATE_LOCAL_STORAGE_PREFIX}:${serverStorageKey}`;
}

/**
 * Coordinate the two terminal serving modes:
 *
 * - browser: a complete localStorage state wins; only its absence allows the
 *   immutable server default to seed the viewer;
 * - edit_default: localStorage is ignored and complete states are written to
 *   the configured server profile with the established debounce/beacon path.
 *
 * The serialize/apply callbacks keep viewer-domain behavior outside this
 * infrastructure module.
 *
 * @param {{
 *   client: {
 *     load: () => Promise<{
 *       mode: "browser" | "edit_default",
 *       storageKey: string,
 *       defaultState: unknown | null,
 *       writeEpoch: number | null,
 *     }>,
 *     save: (payload: unknown, options: {
 *       keepalive?: boolean,
 *       writeEpoch: number,
 *       writeRevision: number,
 *     }) => Promise<void>,
 *     canSendBeacon: () => boolean,
 *     sendBeacon: (payload: unknown, options: {
 *       writeEpoch: number,
 *       writeRevision: number,
 *     }) => boolean,
 *   },
 *   serialize: () => unknown,
 *   apply: (payload: unknown) => boolean,
 *   localStorage?: Pick<Storage, "getItem" | "setItem"> | null,
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
  localStorage: localStorageRef = defaultLocalStorage(),
  setTimeoutImpl = defaultSetTimeout,
  clearTimeoutImpl = defaultClearTimeout,
  logger = globalThis.console,
  debounceMs = UI_STATE_SAVE_DEBOUNCE_MS,
  retryMs = UI_STATE_SAVE_RETRY_MS,
}) {
  /** @type {"browser" | "edit_default" | null} */
  let mode = null;
  /** @type {string | null} */
  let localStorageKey = null;
  /** @type {unknown | null} */
  let factoryState = null;
  /** @type {unknown | null} */
  let defaultState = null;
  /** @type {number | null} */
  let writeEpoch = null;
  let nextWriteRevision = 0;
  /** @type {{ payload: unknown, revision: number } | null} */
  let pendingWrite = null;
  /** @type {unknown | null} */
  let saveTimer = null;
  /** @type {Promise<void> | null} */
  let remoteFlushPromise = null;

  /** @param {unknown} payload */
  function applyCompleteState(payload) {
    return apply(cloneJsonValue(payload));
  }

  /** @param {unknown} payload */
  function writeBrowserState(payload) {
    if (!localStorageRef || !localStorageKey) {
      logger.warn("Browser localStorage is unavailable; viewer changes are not persistent.");
      return false;
    }
    try {
      localStorageRef.setItem(localStorageKey, encodeUiState(payload));
      return true;
    } catch (error) {
      logger.warn("Failed to save viewer state to browser localStorage.", error);
      return false;
    }
  }

  function readBrowserState() {
    if (!localStorageRef || !localStorageKey) {
      return { exists: false, payload: null };
    }
    let encoded;
    try {
      encoded = localStorageRef.getItem(localStorageKey);
    } catch (error) {
      logger.warn("Failed to read viewer state from browser localStorage.", error);
      return { exists: false, payload: null };
    }
    if (encoded === null) {
      return { exists: false, payload: null };
    }
    try {
      return { exists: true, payload: JSON.parse(encoded) };
    } catch (error) {
      logger.warn("Browser viewer state is malformed; replacing it with a clean state.", error);
      return { exists: true, payload: null };
    }
  }

  /** @param {unknown} payload */
  function allocateRemoteWrite(payload) {
    nextWriteRevision += 1;
    if (!Number.isSafeInteger(nextWriteRevision)) {
      throw new RangeError("Edit-default write revision exceeded the safe integer range.");
    }
    return { payload, revision: nextWriteRevision };
  }

  /** @param {unknown} payload */
  function queueRemote(payload) {
    pendingWrite = allocateRemoteWrite(payload);
    if (saveTimer !== null) {
      clearTimeoutImpl(saveTimer);
    }
    saveTimer = setTimeoutImpl(() => flush(), debounceMs);
  }

  /**
   * Persist the current complete canonical state through the active mode.
   * Browser writes are synchronous; edit-default writes remain debounced.
   */
  function save() {
    if (mode === null) {
      return false;
    }
    const payload = cloneJsonValue(serialize());
    if (mode === "browser") {
      return writeBrowserState(payload);
    }
    if (writeEpoch === null) {
      return false;
    }
    queueRemote(payload);
    return true;
  }

  /**
   * @param {{ keepalive?: boolean }} [options]
   * @returns {Promise<void>}
   */
  function flush({ keepalive = false } = {}) {
    if (saveTimer !== null) {
      clearTimeoutImpl(saveTimer);
      saveTimer = null;
    }
    if (mode !== "edit_default") {
      return Promise.resolve();
    }
    if (remoteFlushPromise !== null) {
      return remoteFlushPromise;
    }
    if (pendingWrite === null || writeEpoch === null) {
      return Promise.resolve();
    }

    remoteFlushPromise = (async () => {
      while (mode === "edit_default" && pendingWrite !== null) {
        if (saveTimer !== null) {
          clearTimeoutImpl(saveTimer);
          saveTimer = null;
        }
        const write = pendingWrite;
        pendingWrite = null;
        try {
          await client.save(write.payload, {
            keepalive,
            writeEpoch,
            writeRevision: write.revision,
          });
        } catch (error) {
          if (error?.code === UiStateClientErrorCode.STALE_WRITER) {
            writeEpoch = null;
            pendingWrite = null;
            if (saveTimer !== null) {
              clearTimeoutImpl(saveTimer);
              saveTimer = null;
            }
            logger.warn(
              "This edit-default page no longer owns the profile; reload before editing again.",
              error,
            );
            return;
          }
          // A newer state always wins. Restore this failed payload only when
          // no newer complete state was queued while the request was active.
          if (pendingWrite === null) {
            pendingWrite = write;
          }
          if (saveTimer === null) {
            saveTimer = setTimeoutImpl(() => flush(), retryMs);
          }
          logger.warn("Failed to save the default viewer profile.", error);
          return;
        }
      }
    })().finally(() => {
      remoteFlushPromise = null;
      if (mode === "edit_default" && pendingWrite !== null && saveTimer === null) {
        saveTimer = setTimeoutImpl(() => flush(), 0);
      }
    });
    return remoteFlushPromise;
  }

  /**
   * Capture the already-normalized factory state, then select exactly one
   * startup source. No local/default merge is performed.
   *
   * @returns {Promise<{
   *   mode: "browser" | "edit_default",
   *   source: "local" | "default" | "factory",
   * }>}
   */
  async function load() {
    factoryState = cloneJsonValue(serialize());
    const descriptor = await client.load();
    mode = descriptor.mode;
    writeEpoch = descriptor.writeEpoch;
    nextWriteRevision = 0;
    localStorageKey = buildUiStateLocalStorageKey(descriptor.storageKey);

    if (descriptor.defaultState !== null) {
      if (!applyCompleteState(descriptor.defaultState)) {
        applyCompleteState(factoryState);
        throw new TypeError("The default viewer profile is not valid for this cache.");
      }
      // Feature hydration may normalize dataset-bound values. The resolved
      // result is the immutable comparison/restore baseline for this session.
      defaultState = cloneJsonValue(serialize());
    } else {
      defaultState = null;
      applyCompleteState(factoryState);
    }

    if (mode === "edit_default") {
      return {
        mode,
        source: defaultState === null ? "factory" : "default",
      };
    }

    const local = readBrowserState();
    if (!local.exists) {
      return {
        mode,
        source: defaultState === null ? "factory" : "default",
      };
    }

    if (local.payload !== null && applyCompleteState(local.payload)) {
      return { mode, source: "local" };
    }

    // An existing but invalid value must not fall through to the server
    // default: the browser-local state remains the authoritative branch.
    applyCompleteState(factoryState);
    writeBrowserState(factoryState);
    logger.warn("Browser viewer state was invalid and has been reset.");
    return { mode, source: "factory" };
  }

  function clearAll() {
    if (factoryState === null || !applyCompleteState(factoryState)) {
      return false;
    }
    save();
    return true;
  }

  function restoreDefault() {
    if (defaultState === null || !applyCompleteState(defaultState)) {
      return false;
    }
    save();
    return true;
  }

  function canRestoreDefault() {
    return defaultState !== null && !uiStatesEqual(serialize(), defaultState);
  }

  /**
   * Try the pagehide beacon only for a pending edit-default write. Browser
   * mode has already committed synchronously to localStorage.
   */
  function sendPendingBeacon() {
    if (
      mode !== "edit_default"
      || writeEpoch === null
      || !client.canSendBeacon()
    ) {
      return;
    }
    const write = pendingWrite ?? (
      remoteFlushPromise === null
        ? null
        : allocateRemoteWrite(cloneJsonValue(serialize()))
    );
    if (write === null) {
      return;
    }
    pendingWrite = null;
    if (!client.sendBeacon(write.payload, {
      writeEpoch,
      writeRevision: write.revision,
    })) {
      pendingWrite = write;
    }
  }

  return Object.freeze({
    canRestoreDefault,
    clearAll,
    flush,
    load,
    mode: () => mode,
    restoreDefault,
    save,
    sendPendingBeacon,
  });
}
