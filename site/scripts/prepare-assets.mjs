import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(siteRoot, "..");
const publicRoot = resolve(siteRoot, "public");
const webRoot = resolve(repositoryRoot, "web");
const deployment = JSON.parse(
  await readFile(resolve(siteRoot, "cache-deployment.json"), "utf8"),
);
const cacheRoot = resolve(repositoryRoot, "data", "cache", deployment.storageKey);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CACHE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

function requireInside(parent, child) {
  const candidate = relative(resolve(parent), resolve(child));
  if (candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate))) {
    return;
  }
  throw new Error(`Unsafe generated path: ${resolve(child)}`);
}

async function copyFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(createReadStream(source), createWriteStream(destination));
}

async function sha256(source) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(source)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function verifyFile(source, specification) {
  const sourceStat = await stat(source);
  if (!sourceStat.isFile() || sourceStat.size !== specification.bytes) {
    throw new Error(`Unexpected byte length for ${source}`);
  }
  if ((await sha256(source)) !== specification.sha256) {
    throw new Error(`Unexpected SHA-256 for ${source}`);
  }
}

function validateCacheEntry(relativePath, specification) {
  const pathSegments = relativePath.split("/");
  if (
    pathSegments.length === 0
    || pathSegments.some((segment) => (
      segment === ""
      || segment === "."
      || segment === ".."
      || !CACHE_PATH_SEGMENT_PATTERN.test(segment)
    ))
  ) {
    throw new Error(`Invalid cache manifest path: ${relativePath}`);
  }
  if (
    !Number.isSafeInteger(specification.bytes)
    || specification.bytes <= 0
    || !SHA256_PATTERN.test(specification.sha256)
  ) {
    throw new Error(`Invalid cache manifest entry: ${relativePath}`);
  }
  if (
    specification.chunkBytes !== undefined
    && (
      !Number.isSafeInteger(specification.chunkBytes)
      || specification.chunkBytes <= 0
    )
  ) {
    throw new Error(`Invalid chunk size for ${relativePath}`);
  }
  return pathSegments;
}

async function findPlotlyBundle() {
  const candidates = [resolve(siteRoot, "vendor", "plotly.min.js")];
  if (process.env.CM2_PLOTLY_BUNDLE) {
    candidates.push(resolve(process.env.CM2_PLOTLY_BUNDLE));
  }
  if (process.env.CONDA_PREFIX) {
    candidates.push(
      resolve(
        process.env.CONDA_PREFIX,
        "Lib",
        "site-packages",
        "plotly",
        "package_data",
        "plotly.min.js",
      ),
    );
    const libRoot = resolve(process.env.CONDA_PREFIX, "lib");
    try {
      for (const entry of await readdir(libRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("python")) {
          candidates.push(
            resolve(libRoot, entry.name, "site-packages", "plotly", "package_data", "plotly.min.js"),
          );
        }
      }
    } catch {
      // The Windows conda layout does not have a lowercase lib directory.
    }
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next explicit candidate.
    }
  }
  throw new Error(
    "Plotly bundle not found. Activate the cm2-neuronalsignal conda environment or set CM2_PLOTLY_BUNDLE.",
  );
}

async function splitFile(source, destinationRoot, specification) {
  const sourceHandle = await open(source, "r");
  const sourceSize = (await sourceHandle.stat()).size;
  try {
    let offset = 0;
    let part = 0;
    while (offset < sourceSize) {
      const length = Math.min(specification.chunkBytes, sourceSize - offset);
      const buffer = Buffer.allocUnsafe(length);
      const result = await sourceHandle.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) {
        throw new Error(`Short read while splitting ${source}`);
      }
      const destination = join(destinationRoot, `${String(part).padStart(3, "0")}.part`);
      await mkdir(dirname(destination), { recursive: true });
      const destinationHandle = await open(destination, "w");
      try {
        let written = 0;
        while (written < buffer.length) {
          const writeResult = await destinationHandle.write(
            buffer,
            written,
            buffer.length - written,
            written,
          );
          if (writeResult.bytesWritten <= 0) {
            throw new Error(`Short write while splitting ${source}`);
          }
          written += writeResult.bytesWritten;
        }
      } finally {
        await destinationHandle.close();
      }
      offset += length;
      part += 1;
    }
  } finally {
    await sourceHandle.close();
  }
}

async function requireMissing(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Forbidden static deployment path: ${path}`);
}

requireInside(siteRoot, publicRoot);
await rm(publicRoot, { recursive: true, force: true });
await mkdir(publicRoot, { recursive: true });

await copyFile(join(webRoot, "index.html"), join(publicRoot, "index.html"));
await copyFile(join(webRoot, "app.js"), join(publicRoot, "app.js"));
await copyFile(join(webRoot, "styles.css"), join(publicRoot, "styles.css"));
await cp(join(webRoot, "css"), join(publicRoot, "css"), { recursive: true });
await cp(join(webRoot, "js"), join(publicRoot, "js"), { recursive: true });
const plotlyBundle = await findPlotlyBundle();
await verifyFile(plotlyBundle, deployment.plotly);
await copyFile(plotlyBundle, join(publicRoot, "vendor", "plotly.min.js"));

for (const [relativePath, specification] of Object.entries(deployment.cache)) {
  const pathSegments = validateCacheEntry(relativePath, specification);
  const source = join(cacheRoot, ...pathSegments);
  requireInside(cacheRoot, source);
  await verifyFile(source, specification);
  if (specification.chunkBytes === undefined) {
    const destination = join(
      publicRoot,
      "_cache-assets",
      specification.sha256,
      "payload.blob",
    );
    requireInside(publicRoot, destination);
    await copyFile(source, destination);
  } else {
    const destinationRoot = join(publicRoot, "_cache-chunks", specification.sha256);
    requireInside(publicRoot, destinationRoot);
    await splitFile(source, destinationRoot, specification);
  }
}

await requireMissing(join(publicRoot, "cache"));

console.log(`Prepared deployable viewer assets in ${publicRoot}`);
