/**
 * @param {unknown} value
 */
export function sanitizeFilenamePart(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "plot";
}


/** @param {string} format */
export function getImageMimeType(format) {
  return format === "png" ? "image/png" : "image/svg+xml";
}


/** @param {string} format */
export function getImageSaveType(format) {
  if (format === "png") {
    return {
      description: "PNG image",
      accept: { "image/png": [".png"] },
    };
  }
  return {
    description: "SVG image",
    accept: { "image/svg+xml": [".svg"] },
  };
}


/**
 * @param {string} dataUrl
 * @param {string} format
 * @param {{
 *   Blob: typeof globalThis.Blob,
 *   atob: (value: string) => string,
 * }} browser
 */
function convertDataUrlToBlob(dataUrl, format, browser) {
  const mimeType = getImageMimeType(format);
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return new browser.Blob([dataUrl], { type: `${mimeType};charset=utf-8` });
  }
  const metadata = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const content = metadata.includes(";base64")
    ? Uint8Array.from(browser.atob(payload), (char) => char.charCodeAt(0))
    : decodeURIComponent(payload);
  return new browser.Blob([content], { type: `${mimeType};charset=utf-8` });
}


/** @param {Cm2PlotElement} plotDiv */
export function getPlotExportSize(plotDiv) {
  const rect = plotDiv.getBoundingClientRect();
  return {
    width: Math.max(
      1,
      Math.round(
        plotDiv._fullLayout?.width ?? rect.width ?? plotDiv.clientWidth ?? 1,
      ),
    ),
    height: Math.max(
      1,
      Math.round(
        plotDiv._fullLayout?.height ?? rect.height ?? plotDiv.clientHeight ?? 1,
      ),
    ),
  };
}


/** @param {unknown} value */
export function clonePlotlyObject(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}


/**
 * Browser-owned image-save boundary shared by Plotly-backed features.
 *
 * @param {{ document: Document, window: Window & typeof globalThis }} dependencies
 */
export function createPlotImageService({ document, window }) {
  const BlobConstructor = window.Blob ?? globalThis.Blob;
  const decodeBase64 = typeof window.atob === "function"
    ? window.atob.bind(window)
    : globalThis.atob.bind(globalThis);
  const objectUrl = window.URL ?? globalThis.URL;

  /**
   * @param {string} suggestedName
   * @param {string} format
   */
  async function chooseImageSaveTarget(suggestedName, format) {
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [getImageSaveType(format)],
        });
        return { handle };
      } catch (error) {
        if (/** @type {any} */ (error)?.name === "AbortError") {
          return { aborted: true };
        }
        console.warn(
          `Native ${format.toUpperCase()} save failed; falling back to browser download.`,
          error,
        );
      }
    }
    return null;
  }

  /**
   * @param {Blob} blob
   * @param {string} suggestedName
   * @param {{ aborted?: boolean, handle?: FileSystemFileHandle } | null} [target]
   */
  async function saveImageBlob(blob, suggestedName, target = null) {
    if (target?.aborted) {
      return;
    }
    if (target?.handle) {
      const writable = await target.handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }

    const url = objectUrl.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = suggestedName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => objectUrl.revokeObjectURL(url), 1000);
  }

  return {
    chooseImageSaveTarget,
    clonePlotlyObject,
    dataUrlToBlob(dataUrl, format) {
      return convertDataUrlToBlob(dataUrl, format, {
        Blob: BlobConstructor,
        atob: decodeBase64,
      });
    },
    getPlotExportSize,
    sanitizeFilenamePart,
    saveImageBlob,
  };
}
