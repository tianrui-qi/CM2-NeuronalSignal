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


/**
 * GPU-backed grayscale background underlay. Cached uint16 pixels are uploaded
 * only when the selected background changes; Color Map adjustments update uniforms.
 *
 * @param {{ canvas: HTMLCanvasElement, window: Window }} dependencies
 */
export function createMapBackgroundLayer({ canvas, window }) {
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
    return true;
  }

  function ensureCanvasSize(viewportWidth, viewportHeight) {
    if (!gl) {
      return false;
    }
    const ratio = Math.max(1, Number(window.devicePixelRatio) || 1);
    const width = Math.max(1, Math.round(Number(viewportWidth) * ratio));
    const height = Math.max(1, Math.round(Number(viewportHeight) * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    return true;
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
    if (!gl) {
      initialize();
    }
    uploadImage();
    return true;
  }

  function clear() {
    image = null;
    lastFrame = null;
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
    ensureCanvasSize(frame.viewportWidth, frame.viewportHeight);
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform2f(uniforms.imageSize, image.width, image.height);
    gl.uniform2f(uniforms.viewX, x0, x1);
    gl.uniform2f(uniforms.viewY, y0, y1);
    gl.uniform2f(uniforms.viewportSize, canvas.width, canvas.height);
    gl.uniform1f(uniforms.valueOffset, valueOffset);
    gl.uniform1f(uniforms.valueScale, valueScale);
    gl.uniform1f(uniforms.displayLower, displayRange.lower);
    gl.uniform1f(uniforms.displayUpper, displayRange.upper);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    gl = null;
    program = null;
    texture = null;
    vertexArray = null;
    uniforms = null;
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
