const VERTEX_SHADER_SOURCE = `#version 300 es
void main() {
  const vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}
`;

const DISPLAY_FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
precision highp usampler2D;

uniform usampler2D u_image;
uniform vec2 u_image_size;
uniform vec2 u_view_x;
uniform vec2 u_view_y;
uniform vec2 u_viewport_size;
uniform float u_value_offset;
uniform float u_value_scale;
uniform float u_display_lower;
uniform float u_display_upper;

out vec4 out_color;

float decoded_value(ivec2 pixel) {
  ivec2 limit = ivec2(u_image_size) - ivec2(1);
  ivec2 bounded = clamp(pixel, ivec2(0), limit);
  uint code = texelFetch(u_image, bounded, 0).r;
  return u_value_offset + float(code) * u_value_scale;
}

void main() {
  vec2 fraction = gl_FragCoord.xy / u_viewport_size;
  float data_x = mix(u_view_x.x, u_view_x.y, fraction.x);
  // Plotly's first Y endpoint is at the bottom of the screen. This remains
  // correct for the viewer's reversed-Y [height, 0] range.
  float data_y = mix(u_view_y.x, u_view_y.y, fraction.y);
  if (
    data_x < 0.0 || data_x >= u_image_size.x
    || data_y < 0.0 || data_y >= u_image_size.y
  ) {
    out_color = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Integer textures cannot use hardware linear filtering. Four exact texel
  // reads retain smooth zoomed-out presentation without changing cached data.
  vec2 pixel_position = vec2(data_x, data_y) - vec2(0.5);
  ivec2 pixel_00 = ivec2(floor(pixel_position));
  vec2 blend = fract(pixel_position);
  float value_00 = decoded_value(pixel_00);
  float value_10 = decoded_value(pixel_00 + ivec2(1, 0));
  float value_01 = decoded_value(pixel_00 + ivec2(0, 1));
  float value_11 = decoded_value(pixel_00 + ivec2(1, 1));
  float value_0 = mix(value_00, value_10, blend.x);
  float value_1 = mix(value_01, value_11, blend.x);
  float value = mix(value_0, value_1, blend.y);
  float intensity = clamp(
    (value - u_display_lower) / (u_display_upper - u_display_lower),
    0.0,
    1.0
  );
  out_color = vec4(vec3(intensity), 1.0);
}
`;

const EDGE_SAMPLE_COUNT = 21;
const EDGE_COLOR_SETTLE_MS = 120;


/** @param {WebGL2RenderingContext} gl @param {number} type @param {string} source */
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("WebGL could not allocate a background shader.");
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown shader compilation error.";
    gl.deleteShader(shader);
    throw new Error(`Background shader compilation failed: ${message}`);
  }
  return shader;
}


/** @param {WebGL2RenderingContext} gl */
function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, DISPLAY_FRAGMENT_SHADER_SOURCE);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error("WebGL could not allocate the background program.");
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown shader link error.";
    gl.deleteProgram(program);
    throw new Error(`Background shader link failed: ${message}`);
  }
  return program;
}


/** @param {WebGL2RenderingContext} gl @param {WebGLProgram} program @param {string} name */
function uniformLocation(gl, program, name) {
  const location = gl.getUniformLocation(program, name);
  if (location === null) {
    throw new Error(`Background shader is missing uniform ${name}.`);
  }
  return location;
}


/** @param {unknown} range */
function finiteRange(range) {
  const lower = Number(range?.lower);
  const upper = Number(range?.upper);
  return Number.isFinite(lower) && Number.isFinite(upper) && upper > lower
    ? { lower, upper }
    : null;
}


/** @param {number} value @param {number} lower @param {number} upper */
function clamp(value, lower, upper) {
  return Math.min(upper, Math.max(lower, value));
}


/**
 * Match the shader's four-texel interpolation so Safari's solid edge fallback
 * follows the currently displayed grayscale image rather than the raw cache.
 *
 * @param {{ pixels: Uint16Array, spec: Record<string, any>, width: number, height: number }} image
 * @param {{ range: { lower: number, upper: number }, xRange: number[], yRange: number[], viewportWidth: number, viewportHeight: number }} frame
 * @param {number} xFraction
 * @param {number} yFraction
 */
function displayedIntensity(image, frame, xFraction, yFraction) {
  const x0 = Number(frame.xRange?.[0]);
  const x1 = Number(frame.xRange?.[1]);
  const y0 = Number(frame.yRange?.[0]);
  const y1 = Number(frame.yRange?.[1]);
  const valueOffset = Number(image.spec.value_offset);
  const valueScale = Number(image.spec.value_scale);
  const displayRange = finiteRange(frame.range);
  if (
    !displayRange
    || ![x0, x1, y0, y1, valueOffset, valueScale].every(Number.isFinite)
    || valueScale <= 0
  ) {
    return null;
  }

  const dataX = x0 + (x1 - x0) * xFraction;
  const dataY = y0 + (y1 - y0) * yFraction;
  if (
    dataX < 0
    || dataX >= image.width
    || dataY < 0
    || dataY >= image.height
  ) {
    return 0;
  }

  const pixelX = dataX - 0.5;
  const pixelY = dataY - 0.5;
  const baseX = Math.floor(pixelX);
  const baseY = Math.floor(pixelY);
  const blendX = pixelX - baseX;
  const blendY = pixelY - baseY;
  const decodedValue = (x, y) => {
    const boundedX = clamp(x, 0, image.width - 1);
    const boundedY = clamp(y, 0, image.height - 1);
    return valueOffset + image.pixels[boundedY * image.width + boundedX] * valueScale;
  };
  const value00 = decodedValue(baseX, baseY);
  const value10 = decodedValue(baseX + 1, baseY);
  const value01 = decodedValue(baseX, baseY + 1);
  const value11 = decodedValue(baseX + 1, baseY + 1);
  const value0 = value00 + (value10 - value00) * blendX;
  const value1 = value01 + (value11 - value01) * blendX;
  const value = value0 + (value1 - value0) * blendY;
  return clamp(
    (value - displayRange.lower) / (displayRange.upper - displayRange.lower),
    0,
    1,
  );
}


/** @param {number[]} values */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}


/**
 * Safari can extend a solid page color through its browser chrome but does
 * not sample a drawn Canvas. Derive that fallback from the visible top and
 * bottom Map edges while the WebGL layer already owns the decoded pixels.
 *
 * @param {{ pixels: Uint16Array, spec: Record<string, any>, width: number, height: number }} image
 * @param {{ range: { lower: number, upper: number }, xRange: number[], yRange: number[], viewportWidth: number, viewportHeight: number }} frame
 */
function displayedEdgeColor(image, frame) {
  const viewportHeight = Math.max(1, Number(frame.viewportHeight) || 1);
  const lowerFraction = Math.min(0.5, 0.5 / viewportHeight);
  const upperFraction = 1 - lowerFraction;
  const lowerSamples = [];
  const upperSamples = [];
  for (let index = 0; index < EDGE_SAMPLE_COUNT; index += 1) {
    const xFraction = (index + 0.5) / EDGE_SAMPLE_COUNT;
    const lower = displayedIntensity(image, frame, xFraction, lowerFraction);
    const upper = displayedIntensity(image, frame, xFraction, upperFraction);
    if (lower !== null) {
      lowerSamples.push(lower);
    }
    if (upper !== null) {
      upperSamples.push(upper);
    }
  }
  if (!lowerSamples.length || !upperSamples.length) {
    return null;
  }
  const intensity = (median(lowerSamples) + median(upperSamples)) / 2;
  const gray = Math.round(clamp(intensity, 0, 1) * 255);
  return `rgb(${gray} ${gray} ${gray})`;
}


/**
 * GPU-backed grayscale background underlay. Cached uint16 pixels are uploaded
 * only when the selected background changes; Color Map adjustments update uniforms.
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   window: Window,
 *   onEdgeColor?: (color: string | null) => unknown,
 * }} dependencies
 */
export function createMapBackgroundLayer({ canvas, window, onEdgeColor = () => {} }) {
  /** @type {WebGL2RenderingContext | null} */
  let gl = null;
  /** @type {WebGLProgram | null} */
  let program = null;
  /** @type {WebGLTexture | null} */
  let texture = null;
  /** @type {WebGLVertexArrayObject | null} */
  let vertexArray = null;
  /** @type {Record<string, WebGLUniformLocation> | null} */
  let uniforms = null;
  /** @type {{ pixels: Uint16Array, spec: Record<string, any>, width: number, height: number } | null} */
  let image = null;
  /** @type {Record<string, any> | null} */
  let lastFrame = null;
  /** @type {string | null} */
  let lastEdgeColor = null;
  /** @type {Record<string, any> | null} */
  let pendingEdgeFrame = null;
  /** @type {number | null} */
  let edgeColorTimer = null;
  let canvasViewportWidth = 0;
  let canvasViewportHeight = 0;
  /** @type {Record<string, any> | null} */
  let lastDrawnFrame = null;

  /** @param {string | null} color */
  function publishEdgeColor(color) {
    if (color === lastEdgeColor) {
      return false;
    }
    lastEdgeColor = color;
    onEdgeColor(color);
    return true;
  }

  /**
   * Safari may animate its browser chrome when the page background changes.
   * Wait for Map rendering to settle so a continuous pan, pinch, or slider
   * preview cannot recolor that native surface on every animation frame.
   *
   * @param {{
   *   range: { lower: number, upper: number },
   *   xRange: number[],
   *   yRange: number[],
   *   viewportWidth: number,
   *   viewportHeight: number,
   * }} frame
   */
  function scheduleEdgeColor(frame) {
    if (!pendingEdgeFrame) {
      pendingEdgeFrame = {
        range: { lower: 0, upper: 1 },
        xRange: [0, 1],
        yRange: [0, 1],
        viewportWidth: 1,
        viewportHeight: 1,
      };
    }
    pendingEdgeFrame.range.lower = frame.range.lower;
    pendingEdgeFrame.range.upper = frame.range.upper;
    pendingEdgeFrame.xRange[0] = frame.xRange[0];
    pendingEdgeFrame.xRange[1] = frame.xRange[1];
    pendingEdgeFrame.yRange[0] = frame.yRange[0];
    pendingEdgeFrame.yRange[1] = frame.yRange[1];
    pendingEdgeFrame.viewportWidth = frame.viewportWidth;
    pendingEdgeFrame.viewportHeight = frame.viewportHeight;
    if (edgeColorTimer !== null) {
      window.clearTimeout(edgeColorTimer);
    }
    edgeColorTimer = window.setTimeout(() => {
      edgeColorTimer = null;
      const nextFrame = pendingEdgeFrame;
      pendingEdgeFrame = null;
      publishEdgeColor(image && nextFrame
        ? displayedEdgeColor(image, /** @type {any} */ (nextFrame))
        : null);
    }, EDGE_COLOR_SETTLE_MS);
  }

  function resetEdgeColor() {
    if (edgeColorTimer !== null) {
      window.clearTimeout(edgeColorTimer);
      edgeColorTimer = null;
    }
    pendingEdgeFrame = null;
    publishEdgeColor(null);
  }

  function initialize() {
    gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
      stencil: false,
    });
    if (!gl) {
      throw new Error("WebGL 2 is required for adjustable background Color Map ranges.");
    }
    program = createProgram(gl);
    vertexArray = gl.createVertexArray();
    texture = gl.createTexture();
    if (!vertexArray || !texture) {
      throw new Error("WebGL could not allocate the background texture.");
    }
    uniforms = {
      image: uniformLocation(gl, program, "u_image"),
      imageSize: uniformLocation(gl, program, "u_image_size"),
      viewX: uniformLocation(gl, program, "u_view_x"),
      viewY: uniformLocation(gl, program, "u_view_y"),
      viewportSize: uniformLocation(gl, program, "u_viewport_size"),
      valueOffset: uniformLocation(gl, program, "u_value_offset"),
      valueScale: uniformLocation(gl, program, "u_value_scale"),
      displayLower: uniformLocation(gl, program, "u_display_lower"),
      displayUpper: uniformLocation(gl, program, "u_display_upper"),
    };
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uniforms.image, 0);
  }

  function uploadImage() {
    if (!gl || !texture || !image) {
      return false;
    }
    const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    if (image.width > maxTextureSize || image.height > maxTextureSize) {
      throw new Error(
        `Background ${image.width}×${image.height} exceeds WebGL texture limit ${maxTextureSize}.`,
      );
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R16UI,
      image.width,
      image.height,
      0,
      gl.RED_INTEGER,
      gl.UNSIGNED_SHORT,
      image.pixels,
    );
    if (program && uniforms) {
      gl.useProgram(program);
      gl.uniform2f(uniforms.imageSize, image.width, image.height);
      gl.uniform1f(uniforms.valueOffset, Number(image.spec.value_offset));
      gl.uniform1f(uniforms.valueScale, Number(image.spec.value_scale));
    }
    return true;
  }

  function ensureCanvasSize(viewportWidth, viewportHeight) {
    if (!gl) {
      return false;
    }
    const ratio = Math.max(1, Number(window.devicePixelRatio) || 1);
    const width = Math.max(1, Math.round(Number(viewportWidth) * ratio));
    const height = Math.max(1, Math.round(Number(viewportHeight) * ratio));
    const changed = (
      canvas.width !== width
      || canvas.height !== height
      || canvasViewportWidth !== width
      || canvasViewportHeight !== height
    );
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (changed) {
      gl.viewport(0, 0, width, height);
      if (program && uniforms) {
        gl.useProgram(program);
        gl.uniform2f(uniforms.viewportSize, width, height);
      }
      canvasViewportWidth = width;
      canvasViewportHeight = height;
    }
    return changed;
  }

  /**
   * @param {{ pixels: Uint16Array, spec: Record<string, any>, width: number, height: number }} next
   */
  function setImage(next) {
    const width = Number(next?.width);
    const height = Number(next?.height);
    if (
      !(next?.pixels instanceof Uint16Array)
      || !Number.isInteger(width)
      || !Number.isInteger(height)
      || width <= 0
      || height <= 0
      || next.pixels.length !== width * height
    ) {
      throw new Error("Decoded background pixels do not match the declared image shape.");
    }
    image = {
      pixels: next.pixels,
      spec: next.spec,
      width,
      height,
    };
    lastDrawnFrame = null;
    if (!gl) {
      initialize();
    }
    uploadImage();
    return true;
  }

  function clear() {
    image = null;
    lastFrame = null;
    lastDrawnFrame = null;
    resetEdgeColor();
    if (gl) {
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    return true;
  }

  /**
   * @param {{
   *   range: { lower: number, upper: number },
   *   xRange: number[],
   *   yRange: number[],
   *   viewportWidth: number,
   *   viewportHeight: number,
   * }} frame
   */
  function render(frame) {
    lastFrame = frame;
    if (!image) {
      return false;
    }
    if (!gl || !program || !texture || !vertexArray || !uniforms) {
      initialize();
      uploadImage();
    }
    const displayRange = finiteRange(frame.range);
    const x0 = Number(frame.xRange?.[0]);
    const x1 = Number(frame.xRange?.[1]);
    const y0 = Number(frame.yRange?.[0]);
    const y1 = Number(frame.yRange?.[1]);
    const valueOffset = Number(image.spec.value_offset);
    const valueScale = Number(image.spec.value_scale);
    if (
      !displayRange
      || ![x0, x1, y0, y1, valueOffset, valueScale].every(Number.isFinite)
      || valueScale <= 0
    ) {
      return false;
    }
    const canvasResized = ensureCanvasSize(frame.viewportWidth, frame.viewportHeight);
    const viewportWidth = Number(frame.viewportWidth);
    const viewportHeight = Number(frame.viewportHeight);
    if (
      !canvasResized
      && lastDrawnFrame
      && lastDrawnFrame.image === image
      && lastDrawnFrame.displayLower === displayRange.lower
      && lastDrawnFrame.displayUpper === displayRange.upper
      && lastDrawnFrame.x0 === x0
      && lastDrawnFrame.x1 === x1
      && lastDrawnFrame.y0 === y0
      && lastDrawnFrame.y1 === y1
      && lastDrawnFrame.viewportWidth === viewportWidth
      && lastDrawnFrame.viewportHeight === viewportHeight
    ) {
      return true;
    }
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform2f(uniforms.viewX, x0, x1);
    gl.uniform2f(uniforms.viewY, y0, y1);
    gl.uniform1f(uniforms.displayLower, displayRange.lower);
    gl.uniform1f(uniforms.displayUpper, displayRange.upper);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!lastDrawnFrame) {
      lastDrawnFrame = {};
    }
    lastDrawnFrame.image = image;
    lastDrawnFrame.displayLower = displayRange.lower;
    lastDrawnFrame.displayUpper = displayRange.upper;
    lastDrawnFrame.x0 = x0;
    lastDrawnFrame.x1 = x1;
    lastDrawnFrame.y0 = y0;
    lastDrawnFrame.y1 = y1;
    lastDrawnFrame.viewportWidth = viewportWidth;
    lastDrawnFrame.viewportHeight = viewportHeight;
    scheduleEdgeColor(frame);
    return true;
  }

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    gl = null;
    program = null;
    texture = null;
    vertexArray = null;
    uniforms = null;
    canvasViewportWidth = 0;
    canvasViewportHeight = 0;
    lastDrawnFrame = null;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    initialize();
    uploadImage();
    if (lastFrame) {
      render(lastFrame);
    }
  });

  return Object.freeze({
    clear,
    render,
    setImage,
  });
}
