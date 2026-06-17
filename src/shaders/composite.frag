#version 300 es
// Final composite: HDR scene + bloom -> hue-preserving tonemap -> sRGB.
//
// Uses an extended-Reinhard luminance compression that keeps highlights
// from going pure white. Hue/saturation is preserved by scaling the
// linear RGB by the luminance ratio instead of mapping each channel
// independently (which is what makes ACES "bleach" hot regions).

precision highp float;

in vec2 v_ndc;
out vec4 fragColor;

uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
uniform float u_exposure;

// Rec.709 luminance.
float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// Extended Reinhard with white point. y in [0, +inf) -> [0, 1).
float reinhardExt(float y, float Lw) {
  float num = y * (1.0 + y / (Lw * Lw));
  return num / (1.0 + y);
}

void main() {
  vec2 uv = v_ndc * 0.5 + 0.5;

  vec3 scene = texture(u_scene, uv).rgb;
  vec3 bloom = texture(u_bloom, uv).rgb;

  vec3 col = scene + bloom * u_bloomStrength;
  col *= u_exposure;

  // Hue-preserving tonemap: compress luminance, scale RGB to match.
  float L     = max(luma(col), 1e-5);
  float Lw    = 8.0;                   // white point (luma above this fully saturates display)
  float Lout  = reinhardExt(L, Lw);
  // Soft saturation roll-off as luma -> 1 to avoid neon clipping.
  float satCompress = mix(1.0, 0.85, smoothstep(0.6, 1.0, Lout));
  col = col * (Lout / L);
  // Pull super-saturated highlights toward their luma a touch.
  vec3 grey = vec3(luma(col));
  col = mix(grey, col, satCompress);

  // Clamp + sRGB gamma.
  col = clamp(col, 0.0, 1.0);
  col = pow(col, vec3(1.0 / 2.2));

  fragColor = vec4(col, 1.0);
}
