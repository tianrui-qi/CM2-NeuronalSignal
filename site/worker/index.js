import defaultState from "../../data/serve/Y-corr85-pnr12.json" with { type: "json" };
import deployment from "../cache-deployment.json" with { type: "json" };

const STORAGE_KEY = deployment.storageKey;

const CACHE_CHUNKS = Object.freeze(
  Object.fromEntries(
    Object.entries(deployment.cache)
      .filter(([, specification]) => specification.chunkBytes !== undefined)
      .map(([fileName, specification]) => {
        const partCount = Math.ceil(specification.bytes / specification.chunkBytes);
        const files = Array.from(
          { length: partCount },
          (_, index) => `/_cache-chunks/${fileName}/${String(index).padStart(3, "0")}.part`,
        );
        return [
          `/cache/${fileName}`,
          Object.freeze({ length: specification.bytes, files: Object.freeze(files) }),
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

function chunkStream(request, env, chunkFiles) {
  let chunkIndex = 0;
  let reader = null;

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (reader === null) {
          if (chunkIndex >= chunkFiles.length) {
            controller.close();
            return;
          }
          const chunkUrl = new URL(chunkFiles[chunkIndex], request.url);
          chunkIndex += 1;
          const response = await env.ASSETS.fetch(new Request(chunkUrl));
          if (!response.ok || response.body === null) {
            throw new Error(`Missing cache chunk: ${chunkUrl.pathname}`);
          }
          reader = response.body.getReader();
        }

        const result = await reader.read();
        if (result.done) {
          reader = null;
          continue;
        }
        controller.enqueue(result.value);
        return;
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

function cacheHeaders(length) {
  return {
    "Cache-Control": "no-store",
    "Content-Length": String(length),
    "Content-Type": "application/octet-stream",
  };
}

async function serveStatic(request, env) {
  const response = await env.ASSETS.fetch(request);
  if (!response.ok) {
    return response;
  }
  const headers = new Headers(response.headers);
  if (new URL(request.url).pathname.startsWith("/cache/")) {
    headers.set("Cache-Control", "no-store");
  } else {
    headers.set("Cache-Control", "no-cache");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
          { status: 405, headers: { Allow: "GET" } },
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

    const chunked = CACHE_CHUNKS[url.pathname];
    if (chunked !== undefined) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      return new Response(
        request.method === "HEAD"
          ? null
          : chunkStream(request, env, chunked.files),
        { headers: cacheHeaders(chunked.length) },
      );
    }

    if (url.pathname.startsWith("/_cache-chunks/")) {
      return new Response(null, { status: 404 });
    }

    return serveStatic(request, env);
  },
};
