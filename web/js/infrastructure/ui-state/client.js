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
 * Create the transport boundary for the existing UI-state endpoint.
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
     * @returns {Promise<unknown | null>}
     */
    async load() {
      const response = await fetchImpl(endpoint, { cache: "no-store" });
      if (!response.ok) {
        throw new UiStateClientError(
          UiStateClientErrorCode.LOAD_HTTP,
          `Failed to load cache cookie state: HTTP ${response.status}`
        );
      }
      return decodeUiStateEnvelope(await response.json());
    },

    /**
     * @param {unknown} payload
     * @param {{ keepalive?: boolean }} [options]
     * @returns {Promise<void>}
     */
    async save(payload, { keepalive = false } = {}) {
      const response = await fetchImpl(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: encodeUiState(payload),
        keepalive,
      });
      if (!response.ok) {
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
     * Call only after canSendBeacon() succeeds.
     *
     * @param {unknown} payload
     * @returns {boolean}
     */
    sendBeacon(payload) {
      if (typeof sendBeaconImpl !== "function") {
        return false;
      }
      return sendBeaconImpl(endpoint, createUiStateBlob(payload, BlobCtor));
    },
  };
}
