import {
  CacheClientError,
  CacheClientErrorCode,
} from "../errors.js";
import {
  adaptCacheDto,
  decodeBackground,
  decodeDffDenominators,
  decodeTrace,
} from "./adapter.js";


function requestWithFetch(resource) {
  return fetch(resource);
}


/** @param {Response} response @param {string} message @param {string} code */
function requireResponse(response, message, code) {
  if (!response.ok) {
    throw new CacheClientError(code, message);
  }
  return response;
}


export function createCacheClient({ request = requestWithFetch } = {}) {
  /** @type {Promise<{
   *   meta: any,
   *   points: any,
   *   dffDenominators: Float64Array,
   *   tracesBySource: Record<string, Float32Array>,
   * }> | null} */
  let corePromise = null;
  /** @type {Map<string, Promise<Float32Array>>} */
  const tracePromises = new Map();
  /** @type {Map<string, Promise<{ spec: any, values: Uint16Array }>>} */
  const backgroundPromises = new Map();

  async function loadCore() {
    const [metaResponse, pointsResponse] = await Promise.all([
      request("/cache/metadata.json"),
      request("/cache/point.json"),
    ]);
    requireResponse(
      metaResponse,
      "Failed to load cache metadata.",
      CacheClientErrorCode.CACHE_FILES_UNAVAILABLE,
    );
    requireResponse(
      pointsResponse,
      "Failed to load cache points.",
      CacheClientErrorCode.CACHE_FILES_UNAVAILABLE,
    );

    const cache = adaptCacheDto(
      await metaResponse.json(),
      await pointsResponse.json(),
    );
    const denominatorResponse = await request(`/cache/${cache.meta.dff.denominator_file}`);
    requireResponse(
      denominatorResponse,
      "Failed to load DF/F denominator cache.",
      CacheClientErrorCode.CACHE_FILES_UNAVAILABLE,
    );
    const dffDenominators = decodeDffDenominators(
      await denominatorResponse.arrayBuffer(),
      cache.meta.neuron_count,
    );
    return {
      ...cache,
      dffDenominators,
      // Physical sources intentionally start empty and are hydrated on first
      // use through loadTraceSource().
      tracesBySource: {},
    };
  }

  function load() {
    if (!corePromise) {
      corePromise = loadCore().catch((error) => {
        corePromise = null;
        throw error;
      });
    }
    return corePromise;
  }

  /** @param {string} sourceKey */
  function loadTraceSource(sourceKey) {
    const key = String(sourceKey);
    if (tracePromises.has(key)) {
      return /** @type {Promise<Float32Array>} */ (tracePromises.get(key));
    }
    const promise = load().then(async ({ meta }) => {
      const traceSpec = meta.trace_sources[key];
      if (!traceSpec) {
        throw new CacheClientError(
          CacheClientErrorCode.CACHE_SCHEMA_INVALID,
          `Unknown physical trace source: ${key}`,
        );
      }
      const response = await request(`/cache/${traceSpec.file}`);
      requireResponse(
        response,
        `Failed to load trace cache for ${key}.`,
        CacheClientErrorCode.TRACE_UNAVAILABLE,
      );
      return decodeTrace(
        await response.arrayBuffer(),
        key,
        meta.neuron_count * meta.trace_length,
      );
    }).catch((error) => {
      tracePromises.delete(key);
      throw error;
    });
    tracePromises.set(key, promise);
    return promise;
  }

  /**
   * Deduplicate concurrent requests per key without retaining resolved CPU
   * images. The renderer owns only the current decoded array/GPU texture.
   *
   * @param {string} backgroundKey
   */
  function loadBackground(backgroundKey) {
    const key = String(backgroundKey);
    if (backgroundPromises.has(key)) {
      return /** @type {Promise<{ spec: any, values: Uint16Array }>} */ (
        backgroundPromises.get(key)
      );
    }
    const promise = load().then(async ({ meta }) => {
      const spec = meta.backgrounds.find((background) => background.key === key);
      if (!spec) {
        throw new CacheClientError(
          CacheClientErrorCode.CACHE_SCHEMA_INVALID,
          `Unknown background: ${key}`,
        );
      }
      const response = await request(`/cache/${spec.file}`);
      requireResponse(
        response,
        `Failed to load background cache for ${key}.`,
        CacheClientErrorCode.CACHE_FILES_UNAVAILABLE,
      );
      const values = decodeBackground(
        await response.arrayBuffer(),
        key,
        meta.full_height * meta.full_width,
      );
      return { spec, values };
    }).finally(() => {
      if (backgroundPromises.get(key) === promise) {
        backgroundPromises.delete(key);
      }
    });
    backgroundPromises.set(key, promise);
    return promise;
  }

  return Object.freeze({
    load,
    loadBackground,
    loadTraceSource,
  });
}
