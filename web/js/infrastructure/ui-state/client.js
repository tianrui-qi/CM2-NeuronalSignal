import {
  createUiStateBlob,
  decodeUiStateEnvelope,
  encodeUiState,
} from "./codec.js";
import {
  UiStateClientError,
  UiStateClientErrorCode,
} from "../errors.js";

export const UI_STATE_API_PATH = "/api/ui-state";

function buildWriteEndpoint(endpoint, writeEpoch, writeRevision) {
  if (
    !Number.isSafeInteger(writeEpoch)
    || writeEpoch < 1
    || !Number.isSafeInteger(writeRevision)
    || writeRevision < 1
  ) {
    throw new TypeError("Edit-default writes require a valid epoch and revision.");
  }
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}write_epoch=${writeEpoch}&write_revision=${writeRevision}`;
}

/**
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
function defaultFetch(input, init) {
  return globalThis.fetch(input, init);
}

function defaultSendBeacon() {
  if (typeof globalThis.navigator?.sendBeacon !== "function") {
    return null;
  }
  return (url, data) => globalThis.navigator.sendBeacon(url, data);
}

/**
 * Create the transport boundary for the default-profile endpoint.
 * Domain validation and normalization remain caller-owned callbacks.
 *
 * @param {{
 *   endpoint?: string,
 *   fetchImpl?: typeof fetch,
 *   sendBeaconImpl?: ((url: string, data?: BodyInit | null) => boolean) | null,
 *   BlobCtor?: typeof Blob,
 * }} [options]
 */
export function createUiStateClient({
  endpoint = UI_STATE_API_PATH,
  fetchImpl = defaultFetch,
  sendBeaconImpl = defaultSendBeacon(),
  BlobCtor = globalThis.Blob,
} = {}) {
  return {
    /**
     * @returns {Promise<{
     *   mode: "browser" | "edit_default",
     *   storageKey: string,
     *   defaultState: unknown | null,
     *   writeEpoch: number | null,
     * }>}
     */
    async load() {
      const response = await fetchImpl(endpoint, { cache: "no-store" });
      if (!response.ok) {
        throw new UiStateClientError(
          UiStateClientErrorCode.LOAD_HTTP,
          `Failed to load the default viewer profile: HTTP ${response.status}`
        );
      }
      return decodeUiStateEnvelope(await response.json());
    },

    /**
     * @param {unknown} payload
     * @param {{
     *   keepalive?: boolean,
     *   writeEpoch: number,
     *   writeRevision: number,
     * }} options
     * @returns {Promise<void>}
     */
    async save(payload, {
      keepalive = false,
      writeEpoch,
      writeRevision,
    }) {
      const response = await fetchImpl(
        buildWriteEndpoint(endpoint, writeEpoch, writeRevision),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: encodeUiState(payload),
          keepalive,
        },
      );
      if (!response.ok) {
        if (response.status === 409) {
          throw new UiStateClientError(
            UiStateClientErrorCode.STALE_WRITER,
            "Another edit-default page now owns this profile."
          );
        }
        throw new UiStateClientError(
          UiStateClientErrorCode.SAVE_HTTP,
          `HTTP ${response.status}`
        );
      }
    },

    /**
     * @returns {boolean}
     */
    canSendBeacon() {
      return typeof sendBeaconImpl === "function";
    },

    /**
     * Call only in edit-default mode after canSendBeacon() succeeds.
     *
     * @param {unknown} payload
     * @param {{ writeEpoch: number, writeRevision: number }} options
     * @returns {boolean}
     */
    sendBeacon(payload, { writeEpoch, writeRevision }) {
      if (typeof sendBeaconImpl !== "function") {
        return false;
      }
      return sendBeaconImpl(
        buildWriteEndpoint(endpoint, writeEpoch, writeRevision),
        createUiStateBlob(payload, BlobCtor),
      );
    },
  };
}
