#version 300 es
// Fullscreen triangle. Position layout(0) is in clip space already.
// We pass through normalized device coords for the fragment shader to
// reconstruct view rays.

layout(location = 0) in vec2 a_pos;
out vec2 v_ndc;

void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
