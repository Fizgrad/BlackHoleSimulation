export function createFullscreenTriangle(gl: WebGL2RenderingContext): WebGLVertexArrayObject {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('createVertexArray failed');
  const buf = gl.createBuffer();
  if (!buf) throw new Error('createBuffer failed');

  // Single oversized triangle covering the viewport in clip space.
  // Cheaper than a quad and avoids the diagonal seam from interpolation.
  const verts = new Float32Array([
    -1, -1,
     3, -1,
    -1,  3,
  ]);

  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}
