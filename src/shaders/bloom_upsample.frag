#version 300 es
// 9-tap tent-filter upsample for bloom. Adds the upsampled blur additively
// onto the previous (larger) mip — the host code uses additive blending.

precision highp float;

in vec2 v_ndc;
out vec4 fragColor;

uniform sampler2D u_src;
uniform vec2 u_srcTexel;   // 1/srcSize
uniform float u_radius;    // filter radius in source texels (typ. 1.0)

void main() {
  vec2 uv = v_ndc * 0.5 + 0.5;
  vec2 px = u_srcTexel * u_radius;

  // 3x3 tent filter (1-2-1 binomial weights).
  vec3 c = vec3(0.0);
  c += texture(u_src, uv + px * vec2(-1.0, -1.0)).rgb * 1.0;
  c += texture(u_src, uv + px * vec2( 0.0, -1.0)).rgb * 2.0;
  c += texture(u_src, uv + px * vec2( 1.0, -1.0)).rgb * 1.0;

  c += texture(u_src, uv + px * vec2(-1.0,  0.0)).rgb * 2.0;
  c += texture(u_src, uv + px * vec2( 0.0,  0.0)).rgb * 4.0;
  c += texture(u_src, uv + px * vec2( 1.0,  0.0)).rgb * 2.0;

  c += texture(u_src, uv + px * vec2(-1.0,  1.0)).rgb * 1.0;
  c += texture(u_src, uv + px * vec2( 0.0,  1.0)).rgb * 2.0;
  c += texture(u_src, uv + px * vec2( 1.0,  1.0)).rgb * 1.0;

  c *= (1.0 / 16.0);
  fragColor = vec4(c, 1.0);
}
