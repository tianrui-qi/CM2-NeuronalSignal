/**
 * Encode one viewer-state payload for HTTP, beacon, and localStorage.
 * The payload is intentionally not cloned before serialization.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function encodeUiState(payload) {
  return JSON.stringify(payload);
}

/**
 * Decode the server-owned startup descriptor without interpreting the viewer
 * state itself. The application-level UI-state controller remains the strict
 * domain validator.
 *
 * @param {unknown} payload
 * @returns {{
 *   mode: "browser" | "edit_default",
 *   storageKey: string,
 *   defaultState: unknown | null,
 *   writeEpoch: number | null,
 * }}
 */
export function decodeUiStateEnvelope(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("UI-state startup response must be an object.");
  }
  const envelope = /** @type {Record<string, unknown>} */ (payload);
  if (envelope.ok !== true) {
    throw new TypeError("UI-state startup response was not successful.");
  }
  if (envelope.mode !== "browser" && envelope.mode !== "edit_default") {
    throw new TypeError("UI-state startup response has an invalid mode.");
  }
  if (
    typeof envelope.storageKey !== "string"
    || envelope.storageKey.trim().length === 0
  ) {
    throw new TypeError("UI-state startup response has no storage key.");
  }
  if (
    envelope.defaultState !== null
    && (
      !envelope.defaultState
      || typeof envelope.defaultState !== "object"
      || Array.isArray(envelope.defaultState)
    )
  ) {
    throw new TypeError("Default UI state must be an object or null.");
  }
  if (
    (envelope.mode === "browser" && envelope.writeEpoch !== null)
    || (
      envelope.mode === "edit_default"
      && (!Number.isSafeInteger(envelope.writeEpoch) || envelope.writeEpoch < 1)
    )
  ) {
    throw new TypeError("UI-state startup response has an invalid write epoch.");
  }
  return {
    mode: envelope.mode,
    storageKey: envelope.storageKey,
    defaultState: envelope.defaultState,
    writeEpoch: envelope.writeEpoch,
  };
}

/**
 * Build the exact body accepted by the existing pagehide beacon endpoint.
 *
 * @param {unknown} payload
 * @param {typeof Blob} BlobCtor
 * @returns {Blob}
 */
export function createUiStateBlob(payload, BlobCtor) {
  return new BlobCtor([encodeUiState(payload)], { type: "application/json" });
}
