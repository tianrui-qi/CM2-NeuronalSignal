import defaultState from "../../data/serve/Y-corr85-pnr12.json" with { type: "json" };
import deployment from "../cache-deployment.json" with { type: "json" };

const STORAGE_KEY = deployment.storageKey;

const CACHE_ROUTES = Object.freeze(
  Object.fromEntries(
    Object.entries(deployment.cache).map(([fileName, specification]) => {
      const partCount = specification.chunkBytes === undefined
        ? 1
        : Math.ceil(specification.bytes / specification.chunkBytes);
      const transportFiles = specification.chunkBytes === undefined
        ? [`/_cache-assets/${specification.sha256}/payload.blob`]
        : Array.from(
          { length: partCount },
          (_, index) => (
            `/_cache-chunks/${specification.sha256}/`
            + `${String(index).padStart(3, "0")}.part`
          ),
        );
      return [
        `/cache/${fileName}`,
        Object.freeze({
          contentType: fileName.endsWith(".json")
            ? "application/json; charset=utf-8"
            : "application/octet-stream",
          length: specification.bytes,
          transportFiles: Object.freeze(transportFiles),
        }),
      ];
    }),
  ),
);

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function cacheHeaders(length, contentType) {
  return {
    "Cache-Control": "no-store, no-transform",
    "Content-Length": String(length),
    "Content-Type": contentType,
  };
}

function cacheErrorResponse(status, headers = {}) {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store, no-transform",
      ...headers,
    },
  });
}

async function fetchTransport(request, env, transportFile) {
  const transportUrl = new URL(transportFile, request.url);
  transportUrl.search = "";
  const response = await env.ASSETS.fetch(new Request(transportUrl, {
    method: "GET",
    headers: { "Accept-Encoding": "identity" },
  }));
  if (!response.ok || response.body === null) {
    throw new Error(`Missing cache transport object: ${transportUrl.pathname}`);
  }
  return response;
}

async function writeResponseBody(response, writer) {
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      await writer.write(result.value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The source may already be closed after a downstream cancellation.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function pumpTransport(request, env, specification, firstResponse, writable) {
  const writer = writable.getWriter();
  try {
    for (let index = 0; index < specification.transportFiles.length; index += 1) {
      const response = index === 0
        ? firstResponse
        : await fetchTransport(request, env, specification.transportFiles[index]);
      await writeResponseBody(response, writer);
    }
    await writer.close();
  } catch (error) {
    try {
      await writer.abort(error);
    } catch {
      // A disconnected client may already have aborted the fixed-length stream.
    }
  }
}

async function serveCacheRoute(request, env, specification) {
  let firstResponse;
  try {
    firstResponse = await fetchTransport(request, env, specification.transportFiles[0]);
  } catch {
    return cacheErrorResponse(502);
  }

  const headers = cacheHeaders(specification.length, specification.contentType);
  if (request.method === "HEAD") {
    try {
      await firstResponse.body.cancel();
    } catch {
      // The canonical HEAD response has already been fully described by metadata.
    }
    return new Response(null, { headers });
  }

  const { readable, writable } = new FixedLengthStream(specification.length);
  void pumpTransport(request, env, specification, firstResponse, writable);
  return new Response(readable, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      const response = jsonResponse({ ok: true });
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }

    if (url.pathname === "/api/ui-state") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonResponse(
          { ok: false, error: "Default-profile writes are unavailable on the deployed site." },
          { status: 405, headers: { Allow: "GET, HEAD" } },
        );
      }
      const response = jsonResponse({
        ok: true,
        mode: "browser",
        storageKey: STORAGE_KEY,
        defaultState,
        writeEpoch: null,
      });
      return request.method === "HEAD"
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    }

    const cacheRoute = CACHE_ROUTES[url.pathname];
    if (cacheRoute !== undefined) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return cacheErrorResponse(405, { Allow: "GET, HEAD" });
      }
      return serveCacheRoute(request, env, cacheRoute);
    }

    if (url.pathname.startsWith("/cache/")) {
      return cacheErrorResponse(404);
    }

    return env.ASSETS.fetch(request);
  },
};
