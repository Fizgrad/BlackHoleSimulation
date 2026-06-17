#version 300 es
// Final composite: HDR scene + bloom -> ACES tonemap -> sRGB gamma -> screen.

precision highp float;

in vec2 v_ndc;
out vec4 fragColor;

uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength; // ~0.05 - 0.15
uniform float u_exposure;      // ~1.0

// ACES filmic approximation (Krzysztof Narkowicz).
vec3 acesApprox(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

void main() {
  vec2 uv = v_ndc * 0.5 + 0.5;

  vec3 scene = texture(u_scene, uv).rgb;
  vec3 bloom = texture(u_bloom, uv).rgb;

  // Linear add. Bloom is normalised inside its pipeline, so a small
  // strength multiplier is enough.
  vec3 col = scene + bloom * u_bloomStrength;
  col *= u_exposure;

  // Tonemap + sRGB gamma.
  col = acesApprox(col);
  col = pow(col, vec3(1.0 / 2.2));

  fragColor = vec4(col, 1.0);
}
