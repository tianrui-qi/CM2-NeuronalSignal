import { createHash } from "node:crypto";

const requestedBaseUrl = process.argv.find((value) => /^https?:\/\//u.test(value));
const baseUrl = new URL(requestedBaseUrl ?? "http://127.0.0.1:8788/");

async function requireResponse(path, expectedStatus = 200, init = undefined) {
  const response = await fetch(new URL(path, baseUrl), init);
  if (response.status !== expectedStatus) {
    throw new Error(`${path}: expected HTTP ${expectedStatus}, received ${response.status}`);
  }
  return response;
}

const root = await requireResponse("/");
if (!(await root.text()).includes("CM2 Neuron Viewer")) {
  throw new Error("The root page is not the CM2 viewer.");
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

await requireResponse("/api/ui-state", 405, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
await requireResponse("/cache/not-declared.bin", 404);

const metadata = await requireResponse("/cache/metadata.json");
if (metadata.headers.get("cache-control") !== "no-store") {
  throw new Error("Cache responses must use Cache-Control: no-store.");
}

const traceHead = await requireResponse(
  "/cache/temporal/c.float32",
  200,
  { method: "HEAD" },
);
if (traceHead.headers.get("content-length") !== "44971776") {
  throw new Error("Trace response length is incorrect.");
}
const trace = await requireResponse("/cache/temporal/c.float32");
if (trace.body === null) {
  throw new Error("Trace response body is missing.");
}
const traceHash = createHash("sha256");
let traceBytes = 0;
for await (const chunk of trace.body) {
  traceHash.update(chunk);
  traceBytes += chunk.length;
}
const traceDigest = traceHash.digest("hex");
if (
  traceBytes !== 44_971_776
  || traceDigest !== "501eeb4fecb19150bb329d21e0712b818bae2a5180c5584d7d99062ae159a3a6"
) {
  throw new Error("Chunked trace reconstruction changed the canonical bytes.");
}

const health = await (await requireResponse("/health")).json();
if (health.ok !== true) {
  throw new Error("Health route did not report success.");
}

console.log(`CM2 Sites runtime smoke passed (${traceBytes} trace bytes, SHA-256 ${traceDigest}).`);
