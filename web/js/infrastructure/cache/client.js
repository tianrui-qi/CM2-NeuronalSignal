import {
  CacheClientError,
  CacheClientErrorCode,
} from "../errors.js";
import {
  adaptCacheDto,
  decodeTrace,
} from "./adapter.js";

function requestWithFetch(resource) {
  return fetch(resource);
}

export function createCacheClient({ request = requestWithFetch } = {}) {
  return {
    async load() {
      const [metaResponse, pointsResponse] = await Promise.all([
        request("/cache/metadata.json"),
        request("/cache/points.json"),
      ]);
      if (!metaResponse.ok || !pointsResponse.ok) {
        throw new CacheClientError(
          CacheClientErrorCode.CACHE_FILES_UNAVAILABLE,
          "Failed to load web cache files.",
        );
      }

      const metadataDto = await metaResponse.json();
      const pointsDto = await pointsResponse.json();
      const cache = adaptCacheDto(metadataDto, pointsDto);
      const { meta, points } = cache;
      const expected = meta.neuron_count * meta.trace_length;
      const traceEntries = Object.entries(meta.trace_sources);
      const tracePayloads = await Promise.all(traceEntries.map(async ([sourceKey, traceSpec]) => {
        const traceResponse = await request(`/cache/${traceSpec.file}`);
        if (!traceResponse.ok) {
          throw new CacheClientError(
            CacheClientErrorCode.TRACE_UNAVAILABLE,
            `Failed to load trace cache for ${sourceKey}.`,
          );
        }
        const arrayBuffer = await traceResponse.arrayBuffer();
        return [sourceKey, decodeTrace(arrayBuffer, sourceKey, expected)];
      }));

      const tracesBySource = {};
      for (const [sourceKey, traces] of tracePayloads) {
        tracesBySource[sourceKey] = traces;
      }
      return { meta, points, tracesBySource };
    },
  };
}
