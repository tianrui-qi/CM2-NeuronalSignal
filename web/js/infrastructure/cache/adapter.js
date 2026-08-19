import {
  CacheClientError,
  CacheClientErrorCode,
} from "../errors.js";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const TRACE_SOURCE_FILES = Object.freeze({
  c: "temporal/c.float32",
  c_plus_yra: "temporal/c_plus_yra.float32",
});
const DFF_DENOMINATOR_FILE = "temporal/f.float64";
const BACKGROUND_SOURCE_FILES = Object.freeze({
  mean: "background/mean.uint16",
  std: "background/std.uint16",
  bandpass: "background/bandpass.uint16",
});
const BACKGROUND_KEYS = Object.freeze([
  "key",
  "label",
  "file",
  "dtype",
  "layout",
  "value_offset",
  "value_scale",
  "value_range",
  "auto_range",
]);


/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}


/** @param {unknown} value @returns {value is number} */
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}


/** @param {unknown} value */
function isPositiveFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}


/** @param {unknown} value @param {string} message */
function requireContract(value, message) {
  if (!value) {
    throw new CacheClientError(
      CacheClientErrorCode.CACHE_SCHEMA_INVALID,
      `Invalid cache contract: ${message}`,
    );
  }
}


/**
 * @param {Record<string, any>} payload
 * @param {string[]} expectedKeys
 * @param {string} name
 */
function requireExactKeys(payload, expectedKeys, name) {
  const actualKeys = Object.keys(payload);
  requireContract(
    actualKeys.length === expectedKeys.length
      && actualKeys.every((key) => expectedKeys.includes(key)),
    `${name} must contain exactly ${expectedKeys.join(", ")}.`,
  );
}


/** @param {unknown} value */
function isSafeRelativeCachePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\")) {
    return false;
  }
  const parts = value.split("/");
  return !value.startsWith("/")
    && parts.every((part) => part && part !== "." && part !== "..");
}


/**
 * @param {unknown} value
 * @param {string} name
 * @returns {{ lower: number, upper: number }}
 */
function requireIntegerRange(value, name) {
  requireContract(isObject(value), `${name} must be an object.`);
  const range = /** @type {Record<string, any>} */ (value);
  requireExactKeys(range, ["lower", "upper"], name);
  requireContract(
    Number.isSafeInteger(range.lower)
      && Number.isSafeInteger(range.upper)
      && range.lower < range.upper,
    `${name} must contain increasing integer lower and upper bounds.`,
  );
  return /** @type {{ lower: number, upper: number }} */ (range);
}


/**
 * @param {unknown} column
 * @param {number} expectedLength
 * @param {string} name
 */
function requireColumn(column, expectedLength, name) {
  requireContract(Array.isArray(column), `${name} must be an array.`);
  const values = /** @type {any[]} */ (column);
  requireContract(
    values.length === expectedLength,
    `${name} length must equal metadata.neuron_count.`,
  );
}


/**
 * @param {unknown} columns
 * @param {number} expectedLength
 * @param {string} name
 */
function requireNullableNumberColumns(columns, expectedLength, name) {
  requireContract(isObject(columns), `${name} must be an object.`);
  for (const [columnKey, values] of Object.entries(columns)) {
    requireColumn(values, expectedLength, `${name}.${columnKey}`);
    requireContract(
      values.every((value) => value === null || (typeof value === "number" && Number.isFinite(value))),
      `${name}.${columnKey} must contain only finite numbers or null.`,
    );
  }
}


/**
 * Validate the cache JSON DTO pair and expose camelCase trace-row ownership.
 * No scientific values, coordinates, axes, or point-aligned columns are
 * transformed.
 *
 * @param {unknown} metadata
 * @param {unknown} pointPayload
 */
export function adaptCacheDto(metadata, pointPayload) {
  requireContract(isObject(metadata), "metadata must be an object.");
  requireContract(isObject(pointPayload), "points must be an object.");

  const meta = /** @type {Record<string, any>} */ (metadata);
  const points = /** @type {Record<string, any>} */ (pointPayload);
  requireExactKeys(
    meta,
    [
      "full_height",
      "full_width",
      "trace_length",
      "frame_rate_hz",
      "neuron_count",
      "trace_sources",
      "dff",
      "backgrounds",
      "default_background_key",
      "image",
      "traces",
      "time",
      "selection",
    ],
    "metadata",
  );
  requireContract(isPositiveInteger(meta.full_height), "full_height must be a positive integer.");
  requireContract(isPositiveInteger(meta.full_width), "full_width must be a positive integer.");
  requireContract(isPositiveInteger(meta.neuron_count), "neuron_count must be a positive integer.");
  requireContract(isPositiveInteger(meta.trace_length), "trace_length must be a positive integer.");
  requireContract(
    isPositiveFiniteNumber(meta.frame_rate_hz),
    "frame_rate_hz must be a positive finite number.",
  );
  requireContract(
    Array.isArray(meta.backgrounds) && meta.backgrounds.length > 0,
    "backgrounds must be a non-empty array.",
  );
  const backgroundKeys = [];
  for (const [index, background] of meta.backgrounds.entries()) {
    requireContract(isObject(background), `backgrounds[${index}] must be an object.`);
    requireExactKeys(background, BACKGROUND_KEYS, `backgrounds[${index}]`);
    requireContract(
      typeof background.key === "string" && background.key.length > 0,
      `backgrounds[${index}].key must be a non-empty string.`,
    );
    requireContract(
      isSafeRelativeCachePath(background.file)
        && background.file === BACKGROUND_SOURCE_FILES[background.key],
      `backgrounds[${index}].file must be the canonical file for its key.`,
    );
    requireContract(
      typeof background.label === "string" && background.label.length > 0,
      `backgrounds[${index}].label must be a non-empty string.`,
    );
    requireContract(
      background.dtype === "<u2",
      `backgrounds[${index}].dtype must be <u2.`,
    );
    requireContract(
      background.layout === "row_major",
      `backgrounds[${index}].layout must be row_major.`,
    );
    requireContract(
      typeof background.value_offset === "number"
        && Number.isFinite(background.value_offset),
      `backgrounds[${index}].value_offset must be finite.`,
    );
    requireContract(
      isPositiveFiniteNumber(background.value_scale),
      `backgrounds[${index}].value_scale must be positive and finite.`,
    );
    const valueRange = requireIntegerRange(
      background.value_range,
      `backgrounds[${index}].value_range`,
    );
    const autoRange = requireIntegerRange(
      background.auto_range,
      `backgrounds[${index}].auto_range`,
    );
    requireContract(
      autoRange.lower >= valueRange.lower && autoRange.upper <= valueRange.upper,
      `backgrounds[${index}].auto_range must stay within value_range.`,
    );
    backgroundKeys.push(background.key);
  }
  requireContract(
    new Set(backgroundKeys).size === backgroundKeys.length,
    "background keys must be unique.",
  );
  requireContract(
    backgroundKeys.length === Object.keys(BACKGROUND_SOURCE_FILES).length
      && backgroundKeys.every((key) => Object.hasOwn(BACKGROUND_SOURCE_FILES, key)),
    "backgrounds must contain exactly mean, std, and bandpass.",
  );
  requireContract(
    typeof meta.default_background_key === "string"
      && backgroundKeys.includes(meta.default_background_key),
    "default_background_key must reference a declared background.",
  );

  requireContract(isObject(meta.image), "image must be an object.");
  requireExactKeys(
    meta.image,
    [
      "shape",
      "axis_order",
      "origin",
      "x_direction",
      "y_direction",
      "coordinate_indexing",
      "pixel_flatten_order",
    ],
    "image",
  );
  requireContract(
    Array.isArray(meta.image.shape)
      && meta.image.shape.length === 2
      && meta.image.shape[0] === meta.full_height
      && meta.image.shape[1] === meta.full_width,
    "image.shape must equal [full_height, full_width].",
  );
  requireContract(meta.image.axis_order === "YX", "image.axis_order must be YX.");
  requireContract(meta.image.origin === "top_left", "image.origin must be top_left.");
  requireContract(meta.image.x_direction === "right", "image.x_direction must be right.");
  requireContract(meta.image.y_direction === "down", "image.y_direction must be down.");
  requireContract(
    meta.image.coordinate_indexing === "zero_based",
    "image.coordinate_indexing must be zero_based.",
  );
  requireContract(
    meta.image.pixel_flatten_order === "F",
    "image.pixel_flatten_order must be F.",
  );

  requireContract(isObject(meta.traces), "traces must be an object.");
  requireExactKeys(meta.traces, ["shape", "layout", "dtype"], "traces");
  requireContract(
    Array.isArray(meta.traces.shape)
      && meta.traces.shape.length === 2
      && meta.traces.shape[0] === meta.neuron_count
      && meta.traces.shape[1] === meta.trace_length,
    "traces.shape must equal [neuron_count, trace_length].",
  );
  requireContract(
    meta.traces.layout === "component_major",
    "traces.layout must be component_major.",
  );
  requireContract(meta.traces.dtype === "<f4", "traces.dtype must be <f4.");

  requireContract(isObject(meta.time), "time must be an object.");
  requireExactKeys(
    meta.time,
    ["coordinate", "frame_indexing", "sample_rate_hz"],
    "time",
  );
  requireContract(meta.time.coordinate === "frame", "time.coordinate must be frame.");
  requireContract(
    meta.time.frame_indexing === "zero_based",
    "time.frame_indexing must be zero_based.",
  );
  requireContract(
    isPositiveFiniteNumber(meta.time.sample_rate_hz)
      && meta.time.sample_rate_hz === meta.frame_rate_hz,
    "time.sample_rate_hz must equal frame_rate_hz.",
  );

  requireContract(isObject(meta.selection), "selection must be an object.");
  requireExactKeys(
    meta.selection,
    ["roi_bounds", "qc_lower", "qc_upper", "region_boundary"],
    "selection",
  );
  requireContract(
    meta.selection.roi_bounds === "half_open",
    "selection.roi_bounds must be half_open.",
  );
  requireContract(
    meta.selection.qc_lower === "inclusive",
    "selection.qc_lower must be inclusive.",
  );
  requireContract(
    meta.selection.qc_upper === "exclusive",
    "selection.qc_upper must be exclusive.",
  );
  requireContract(
    meta.selection.region_boundary === "inclusive",
    "selection.region_boundary must be inclusive.",
  );

  requireContract(isObject(meta.dff), "dff must be an object.");
  requireExactKeys(
    meta.dff,
    ["denominator_file", "dtype", "baseline_method", "min_baseline_abs"],
    "dff",
  );
  requireContract(
    meta.dff.denominator_file === DFF_DENOMINATOR_FILE,
    `dff.denominator_file must be ${DFF_DENOMINATOR_FILE}.`,
  );
  requireContract(
    meta.dff.dtype === "<f8",
    "dff.dtype must be <f8.",
  );
  requireContract(
    meta.dff.min_baseline_abs === 1e-6,
    "dff.min_baseline_abs must be 1e-6.",
  );
  requireContract(
    meta.dff.baseline_method === "median",
    "dff.baseline_method must be median.",
  );

  requireContract(isObject(meta.trace_sources), "trace_sources must be an object.");
  const sourceKeys = Object.keys(meta.trace_sources);
  requireContract(
    sourceKeys.length === Object.keys(TRACE_SOURCE_FILES).length
      && sourceKeys.every((sourceKey) => Object.hasOwn(TRACE_SOURCE_FILES, sourceKey)),
    "trace_sources must contain exactly c and c_plus_yra.",
  );
  for (const [sourceKey, expectedFile] of Object.entries(TRACE_SOURCE_FILES)) {
    const sourceSpec = meta.trace_sources[sourceKey];
    requireContract(isObject(sourceSpec), `trace_sources.${sourceKey} must be an object.`);
    requireExactKeys(sourceSpec, ["file", "dtype"], `trace_sources.${sourceKey}`);
    requireContract(
      sourceSpec.file === expectedFile,
      `trace_sources.${sourceKey}.file must be ${expectedFile}.`,
    );
    requireContract(
      sourceSpec.dtype === "<f4",
      `trace_sources.${sourceKey}.dtype must be <f4.`,
    );
  }

  requireExactKeys(points, ["id", "trace_row", "x", "y", "metrics"], "points");
  for (const key of ["id", "trace_row", "x", "y"]) {
    requireColumn(points[key], meta.neuron_count, `points.${key}`);
  }
  requireContract(
    points.id.every((value) => Number.isSafeInteger(value) && Math.abs(value) <= MAX_SAFE_INTEGER),
    "points.id must contain safe integers.",
  );
  requireContract(
    new Set(points.id).size === meta.neuron_count,
    "points.id must contain unique neuron identifiers.",
  );
  requireContract(
    points.trace_row.every((value) => (
      Number.isSafeInteger(value) && value >= 0 && value < meta.neuron_count
    )),
    "points.trace_row must contain rows in [0, neuron_count).",
  );
  requireContract(
    new Set(points.trace_row).size === meta.neuron_count,
    "points.trace_row must be a permutation of all trace rows.",
  );
  requireContract(
    points.x.every(Number.isSafeInteger) && points.y.every(Number.isSafeInteger),
    "points.x and points.y must contain integer coordinates.",
  );
  requireContract(
    points.x.every((value) => value >= 0 && value < meta.full_width),
    "points.x must stay within zero-based image width.",
  );
  requireContract(
    points.y.every((value) => value >= 0 && value < meta.full_height),
    "points.y must stay within zero-based image height.",
  );
  requireNullableNumberColumns(points.metrics, meta.neuron_count, "points.metrics");
  requireContract(
    Object.keys(points.metrics).length > 0,
    "points.metrics must contain at least one metric.",
  );

  const { trace_row: _wireTraceRow, ...pointColumns } = points;
  return {
    meta,
    points: {
      ...pointColumns,
      traceRow: [...points.trace_row],
    },
  };
}


export function decodeTrace(arrayBuffer, sourceKey, expectedLength) {
  const actualLength = arrayBuffer.byteLength / Float32Array.BYTES_PER_ELEMENT;
  if (
    !Number.isInteger(actualLength)
    || actualLength !== expectedLength
  ) {
    throw new CacheClientError(
      CacheClientErrorCode.TRACE_SIZE_MISMATCH,
      `Trace cache size mismatch for ${sourceKey}: got ${actualLength}, expected ${expectedLength}`,
    );
  }
  if (LITTLE_ENDIAN_HOST) {
    return new Float32Array(arrayBuffer);
  }
  const view = new DataView(arrayBuffer);
  const values = new Float32Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    values[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  }
  return values;
}


/**
 * Decode the component-row-aligned DF/F denominator vector. Float64 storage
 * preserves the browser's previous double-precision even-median result.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {number} expectedLength
 */
export function decodeDffDenominators(arrayBuffer, expectedLength) {
  const actualLength = arrayBuffer.byteLength / Float64Array.BYTES_PER_ELEMENT;
  if (!Number.isInteger(actualLength) || actualLength !== expectedLength) {
    throw new CacheClientError(
      CacheClientErrorCode.TRACE_SIZE_MISMATCH,
      `DF/F denominator cache size mismatch: got ${actualLength}, expected ${expectedLength}`,
    );
  }
  if (LITTLE_ENDIAN_HOST) {
    return new Float64Array(arrayBuffer);
  }
  const view = new DataView(arrayBuffer);
  const values = new Float64Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    values[index] = view.getFloat64(index * Float64Array.BYTES_PER_ELEMENT, true);
  }
  return values;
}


/**
 * Decode one row-major YX background texture from canonical little-endian
 * unsigned-16 storage. Value reconstruction remains metadata-owned.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {string} backgroundKey
 * @param {number} expectedLength
 */
export function decodeBackground(arrayBuffer, backgroundKey, expectedLength) {
  const actualLength = arrayBuffer.byteLength / Uint16Array.BYTES_PER_ELEMENT;
  if (!Number.isInteger(actualLength) || actualLength !== expectedLength) {
    throw new CacheClientError(
      CacheClientErrorCode.TRACE_SIZE_MISMATCH,
      `Background cache size mismatch for ${backgroundKey}: got ${actualLength}, expected ${expectedLength}`,
    );
  }
  if (LITTLE_ENDIAN_HOST) {
    return new Uint16Array(arrayBuffer);
  }
  const view = new DataView(arrayBuffer);
  const values = new Uint16Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    values[index] = view.getUint16(index * Uint16Array.BYTES_PER_ELEMENT, true);
  }
  return values;
}
