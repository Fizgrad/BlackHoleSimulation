#version 300 es
// 13-tap downsample for bloom (Call of Duty: Advanced Warfare HDR bloom).
// Samples a wide neighbourhood with weights tuned to suppress fireflies
// while preserving overall energy. Source texel size is the input mip's
// pixel size; dest is half resolution.

precision highp float;

in vec2 v_ndc;
out vec4 fragColor;

uniform sampler2D u_src;
uniform vec2 u_srcTexel;   // 1/srcSize in uv units
uniform float u_threshold; // optional bright-pass threshold (>=0 disables)

vec3 sample(vec2 uv) {
  return texture(u_src, uv).rgb;
}

// Bright-pass: soft knee around threshold so tonemap stays continuous.
vec3 brightPass(vec3 c) {
  if (u_threshold < 0.0) return c;
  float br = max(c.r, max(c.g, c.b));
  float knee = 0.5;
  float soft = clamp(br - u_threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float contribution = max(soft, br - u_threshold) / max(br, 1e-4);
  return c * contribution;
}

void main() {
  vec2 uv = v_ndc * 0.5 + 0.5;
  vec2 px = u_srcTexel;

  vec3 a = sample(uv + px * vec2(-1.0, -1.0));
  vec3 b = sample(uv + px * vec2( 0.0, -1.0));
  vec3 c = sample(uv + px * vec2( 1.0, -1.0));
  vec3 d = sample(uv + px * vec2(-1.0,  0.0));
  vec3 e = sample(uv + px * vec2( 0.0,  0.0));
  vec3 f = sample(uv + px * vec2( 1.0,  0.0));
  vec3 g = sample(uv + px * vec2(-1.0,  1.0));
  vec3 h = sample(uv + px * vec2( 0.0,  1.0));
  vec3 i = sample(uv + px * vec2( 1.0,  1.0));

  vec3 j = sample(uv + px * vec2(-0.5, -0.5));
  vec3 k = sample(uv + px * vec2( 0.5, -0.5));
  vec3 l = sample(uv + px * vec2(-0.5,  0.5));
  vec3 m = sample(uv + px * vec2( 0.5,  0.5));

  // Weighted sum (5 boxes). Centre and inner taps get more weight to
  // preserve energy through the chain.
  vec3 result = e * 0.125;
  result += (a + c + g + i) * (0.03125);
  result += (b + d + f + h) * (0.0625);
  result += (j + k + l + m) * (0.125);

  // Apply bright-pass only on the very first downsample.
  result = brightPass(result);
  fragColor = vec4(result, 1.0);
}
