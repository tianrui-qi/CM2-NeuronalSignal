async function loadCache() {
  const [metaResponse, pointsResponse] = await Promise.all([
    fetch("/cache/metadata.json"),
    fetch("/cache/points.json"),
  ]);
  if (!metaResponse.ok || !pointsResponse.ok) {
    throw new Error("Failed to load web cache files.");
  }
  const meta = await metaResponse.json();
  const points = await pointsResponse.json();
  const expected = meta.neuron_count * meta.trace_length;
  const traceEntries = TRACE_SOURCE_ORDER
    .filter((sourceKey) => Boolean(meta.trace_sources?.[sourceKey]))
    .map((sourceKey) => [sourceKey, meta.trace_sources[sourceKey]]);
  const tracePayloads = await Promise.all(traceEntries.map(async ([sourceKey, traceSpec]) => {
    const traceResponse = await fetch(`/cache/${traceSpec.file}`);
    if (!traceResponse.ok) {
      throw new Error(`Failed to load trace cache for ${sourceKey}.`);
    }
    const traces = new Float32Array(await traceResponse.arrayBuffer());
    if (traces.length !== expected) {
      throw new Error(`Trace cache size mismatch for ${sourceKey}: got ${traces.length}, expected ${expected}`);
    }
    return [sourceKey, traces];
  }));
  const tracesBySource = {};
  for (const [sourceKey, traces] of tracePayloads) {
    tracesBySource[sourceKey] = traces;
  }
  return { meta, points, tracesBySource };
}
