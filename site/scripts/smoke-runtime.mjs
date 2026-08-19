import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const deployment = JSON.parse(
  await readFile(new URL("../cache-deployment.json", import.meta.url), "utf8"),
);

const requestedBaseUrl = process.argv.find((value) => /^https?:\/\//u.test(value));
const baseUrl = new URL(requestedBaseUrl ?? "http://127.0.0.1:8788/");

async function requireResponse(path, expectedStatus = 200, init = undefined) {
  const response = await fetch(new URL(path, baseUrl), init);
  if (response.status !== expectedStatus) {
    throw new Error(`${path}: expected HTTP ${expectedStatus}, received ${response.status}`);
  }
  return response;
}

function requireCachePolicy(response, path) {
  const directives = new Set(
    (response.headers.get("cache-control") ?? "")
      .split(",")
      .map((directive) => directive.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!directives.has("no-store") || !directives.has("no-transform")) {
    throw new Error(`${path}: cache response must use no-store and no-transform.`);
  }
}

function expectedContentType(relativePath) {
  return relativePath.endsWith(".json")
    ? "application/json; charset=utf-8"
    : "application/octet-stream";
}

async function hashResponseBody(response, relativePath) {
  if (response.body === null) {
    throw new Error(`${relativePath}: response body is missing.`);
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

const root = await requireResponse("/");
if (!(await root.text()).includes("CM2-NeuronalSignal")) {
  throw new Error("The root page is not CM2-NeuronalSignal.");
}

const profileResponse = await requireResponse("/api/ui-state");
if (profileResponse.headers.get("cache-control") !== "no-store") {
  throw new Error("Default profile response must use Cache-Control: no-store.");
}
const profile = await profileResponse.json();
if (
  profile.mode !== "browser"
  || profile.storageKey !== "Y-corr85-pnr12"
  || profile.writeEpoch !== null
  || profile.defaultState === null
  || Object.keys(profile.defaultState).length !== 17
) {
  throw new Error("Default profile descriptor does not match browser mode.");
}

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  await requireResponse("/api/ui-state", 405, {
    method,
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

for (const method of ["GET", "HEAD"]) {
  const unknown = await requireResponse("/cache/not-declared.bin", 404, { method });
  requireCachePolicy(unknown, `/cache/not-declared.bin (${method})`);
}

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  const rejectedWrite = await requireResponse("/cache/metadata.json", 405, { method });
  requireCachePolicy(rejectedWrite, `/cache/metadata.json (${method})`);
  if (rejectedWrite.headers.get("allow") !== "GET, HEAD") {
    throw new Error("Cache method rejection must advertise GET and HEAD.");
  }
}

let totalCacheBytes = 0;
for (const [relativePath, specification] of Object.entries(deployment.cache)) {
  const canonicalPath = `/cache/${relativePath}`;
  const contentType = expectedContentType(relativePath);

  const head = await requireResponse(canonicalPath, 200, { method: "HEAD" });
  requireCachePolicy(head, `${canonicalPath} (HEAD)`);
  if (head.headers.get("content-length") !== String(specification.bytes)) {
    throw new Error(`${relativePath}: HEAD response length is incorrect.`);
  }
  if (head.headers.get("content-type") !== contentType) {
    throw new Error(`${relativePath}: HEAD response content type is incorrect.`);
  }
  if ((await head.arrayBuffer()).byteLength !== 0) {
    throw new Error(`${relativePath}: HEAD response must not contain a body.`);
  }

  const response = await requireResponse(canonicalPath);
  requireCachePolicy(response, canonicalPath);
  if (response.headers.get("content-length") !== String(specification.bytes)) {
    throw new Error(`${relativePath}: GET response length is incorrect.`);
  }
  if (response.headers.get("content-type") !== contentType) {
    throw new Error(`${relativePath}: GET response content type is incorrect.`);
  }
  const actual = await hashResponseBody(response, relativePath);
  if (actual.bytes !== specification.bytes || actual.sha256 !== specification.sha256) {
    throw new Error(`${relativePath}: canonical bytes do not match the deployment manifest.`);
  }
  totalCacheBytes += actual.bytes;
}

const rangeResponse = await requireResponse("/cache/metadata.json", 200, {
  headers: { Range: "bytes=0-0" },
});
requireCachePolicy(rangeResponse, "/cache/metadata.json (Range)");
if (
  rangeResponse.headers.get("content-range") !== null
  || rangeResponse.headers.get("content-length") !== String(deployment.cache["metadata.json"].bytes)
) {
  throw new Error("Canonical cache routes must ignore transport-layer Range requests.");
}
await rangeResponse.body?.cancel();

const queryResponse = await requireResponse("/cache/metadata.json?cachebust=1", 200, {
  method: "GET",
});
requireCachePolicy(queryResponse, "/cache/metadata.json?cachebust=1");
const queryActual = await hashResponseBody(queryResponse, "metadata.json?cachebust=1");
if (
  queryActual.bytes !== deployment.cache["metadata.json"].bytes
  || queryActual.sha256 !== deployment.cache["metadata.json"].sha256
) {
  throw new Error("Canonical cache query parameters changed the response bytes.");
}

const health = await (await requireResponse("/health")).json();
if (health.ok !== true) {
  throw new Error("Health route did not report success.");
}

console.log(
  `CM2-NeuronalSignal Sites runtime smoke passed: `
  + `${Object.keys(deployment.cache).length} cache artifacts, ${totalCacheBytes} verified bytes.`,
);
