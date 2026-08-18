/**
 * Encode one viewer-state payload for the UI-state HTTP and beacon transports.
 * The payload is intentionally not cloned before serialization.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function encodeUiState(payload) {
  return JSON.stringify(payload);
}

/**
 * Unwrap the server response without interpreting the viewer-state domain.
 *
 * @param {unknown} payload
 * @returns {unknown | null}
 */
export function decodeUiStateEnvelope(payload) {
  if (payload === null || payload === undefined) {
    return null;
  }
  return /** @type {{ state?: unknown }} */ (Object(payload)).state ?? null;
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
