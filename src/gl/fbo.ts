// FBO + HDR float texture helpers for the bloom pipeline.

export interface RenderTarget {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export function checkFloatFBOSupport(gl: WebGL2RenderingContext): void {
  if (!gl.getExtension('EXT_color_buffer_float')) {
    throw new Error(
      'EXT_color_buffer_float extension is required for HDR rendering. ' +
        'Your browser/GPU does not support it.',
    );
  }
}

function createFloatTexture(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // RGBA16F is the safest HDR format with EXT_color_buffer_float.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

export function createRenderTarget(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
): RenderTarget {
  const tex = createFloatTexture(gl, w, h);
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('createFramebuffer failed');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, width: w, height: h };
}

export function resizeRenderTarget(
  gl: WebGL2RenderingContext,
  rt: RenderTarget,
  w: number,
  h: number,
): void {
  if (rt.width === w && rt.height === h) return;
  gl.bindTexture(gl.TEXTURE_2D, rt.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  rt.width = w;
  rt.height = h;
}

export function bindRenderTarget(
  gl: WebGL2RenderingContext,
  rt: RenderTarget | null,
  width?: number,
  height?: number,
): void {
  if (rt) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
    gl.viewport(0, 0, rt.width, rt.height);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (width !== undefined && height !== undefined) {
      gl.viewport(0, 0, width, height);
    }
  }
}
