export const CacheClientErrorCode = Object.freeze({
  CACHE_FILES_UNAVAILABLE: "CACHE_FILES_UNAVAILABLE",
  CACHE_SCHEMA_INVALID: "CACHE_SCHEMA_INVALID",
  TRACE_UNAVAILABLE: "TRACE_UNAVAILABLE",
  TRACE_SIZE_MISMATCH: "TRACE_SIZE_MISMATCH",
});

export class CacheClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const UiStateClientErrorCode = Object.freeze({
  LOAD_HTTP: "UI_STATE_LOAD_HTTP",
  SAVE_HTTP: "UI_STATE_SAVE_HTTP",
});

export class UiStateClientError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
