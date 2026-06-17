#version 300 es
//
// blackhole.frag - Schwarzschild black hole + accretion disk + starfield.
//
// Method: per-pixel geodesic integration in the orbital-plane impact-
// parameter formulation. We integrate the inverse radial coordinate
// u = 1/r against the orbital angle phi using the Schwarzschild
// null-geodesic ODE:
//
//     d^2 u / d phi^2 = -u + (3/2) * rs * u^2
//
// where rs = 2GM/c^2 is the Schwarzschild radius (a uniform here).
// We march this with RK4 in fixed angular steps, terminating when
// the ray either falls inside the horizon (u * rs >= 1) or escapes
// to infinity (r large). The accretion disk (in the world y=0 plane)
// is detected by sign-change crossings between integration samples.
//
// Reference: standard derivation, e.g. Hartle "Gravity" ch.9.
//

precision highp float;

in vec2 v_ndc;
out vec4 fragColor;

uniform vec2  u_resolution;
uniform float u_time;

uniform vec3  u_camPos;
uniform vec3  u_camForward;
uniform vec3  u_camRight;
uniform vec3  u_camUp;
uniform float u_fovTan;

uniform float u_rs;
uniform float u_diskInner;
uniform float u_diskOuter;

uniform int   u_maxSteps;
uniform float u_dPhi;

#define STAR_MAX 12
uniform int   u_starCount;
uniform vec3  u_starPos[STAR_MAX];
uniform vec3  u_starCol[STAR_MAX];
uniform float u_starRadius;

// --- noise primitives ---------------------------------------------------

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i);
  float n100 = hash31(i + vec3(1, 0, 0));
  float n010 = hash31(i + vec3(0, 1, 0));
  float n110 = hash31(i + vec3(1, 1, 0));
  float n001 = hash31(i + vec3(0, 0, 1));
  float n101 = hash31(i + vec3(1, 0, 1));
  float n011 = hash31(i + vec3(0, 1, 1));
  float n111 = hash31(i + vec3(1, 1, 1));
  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
}

float fbm(vec3 p, int octaves) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    s += a * vnoise(p);
    n += a;
    p *= 2.03;
    a *= 0.5;
  }
  return s / max(n, 1e-4);
}

float ridged(vec3 p, int octaves) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float v = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    v *= v;
    s += a * v;
    n += a;
    p *= 2.1;
    a *= 0.5;
  }
  return s / max(n, 1e-4);
}

// --- starfield ----------------------------------------------------------

vec3 starColor(float t) {
  // Naked-eye visible stars (apparent magnitude < ~6.5): biased toward
  // F/G/K main sequence + a long bright tail of giants/supergiants.
  // Red dwarfs are far too dim to see, so the t->color map should
  // produce mostly white-yellow, with substantial orange/red giant
  // contribution (Betelgeuse, Antares, Aldebaran), and a small blue/B-A
  // fraction (Rigel, Vega, Sirius).
  //   t < 0.10  : blue / blue-white  (B/O ~10%)
  //   0.10-0.30 : white              (A   ~20%)
  //   0.30-0.65 : yellow-white       (F/G ~35%)
  //   0.65-0.85 : orange             (K   ~20%)
  //   > 0.85    : red                (M giants ~15%)
  vec3 blue   = vec3(0.55, 0.70, 1.00);
  vec3 white  = vec3(0.95, 0.97, 1.00);
  vec3 yellow = vec3(1.00, 0.95, 0.80);
  vec3 orange = vec3(1.00, 0.78, 0.55);
  vec3 red    = vec3(1.00, 0.55, 0.40);
  if (t < 0.10) return mix(blue,   white,  t / 0.10);
  if (t < 0.30) return mix(white,  yellow, (t - 0.10) / 0.20);
  if (t < 0.65) return mix(yellow, orange, (t - 0.30) / 0.35);
  if (t < 0.85) return mix(orange, red,    (t - 0.65) / 0.20);
  return red;
}

// One angular grid layer of stars with realistic magnitude distribution.
// densityMul (vec3) modulates per-direction density (e.g. extra density
// along the galactic plane). Magnitude distribution heavily weighted
// toward dim stars with a long bright tail (real luminosity function).
vec3 starLayer(vec3 dir, float density, float scale, float seed,
               float plane) {
  float theta = acos(clamp(dir.y, -1.0, 1.0));
  float phi   = atan(dir.z, dir.x);
  vec2 ang = vec2(phi, theta) * scale;
  vec2 ic = floor(ang);
  vec2 fc = fract(ang);

  vec3 col = vec3(0.0);
  for (int yo = -1; yo <= 1; yo++) {
    for (int xo = -1; xo <= 1; xo++) {
      vec2 cell = ic + vec2(float(xo), float(yo));
      float h1 = hash21(cell + seed);
      // Density boosted along galactic plane (up to ~3x).
      float effDensity = density * (1.0 + plane * 2.5);
      if (h1 < 1.0 - effDensity) continue;
      float h2 = hash21(cell + seed + 7.13);
      float h3 = hash21(cell + seed + 13.7);
      float h4 = hash21(cell + seed + 91.1);
      vec2 sp = vec2(float(xo), float(yo)) + vec2(h2, h3);
      vec2 d = fc - sp;
      float r2 = dot(d, d);

      // Magnitude distribution: most stars dim, rare very bright tail.
      // pow(h, 14) heavily concentrates 0..1; +base for visible floor.
      // Combined with linear+strong tail = wide dynamic range like the
      // real sky.
      float magRaw = pow(h4, 14.0);
      float intensity = 0.10 + magRaw * 30.0;     // up to ~30x median

      // Bright stars get larger PSF (saturation + scattering bloom).
      float kernelW = mix(220.0, 60.0, smoothstep(0.0, 1.0, magRaw));
      float core = exp(-r2 * kernelW) * intensity;

      // Soft glow halo for bright stars only.
      float halo = 0.0;
      if (magRaw > 0.5) {
        halo = exp(-r2 * 35.0) * (magRaw - 0.5) * 1.6;
      }

      // 4-point diffraction spikes only for the very bright ones.
      float spike = 0.0;
      if (magRaw > 0.75) {
        float sx = exp(-d.x * d.x * 9000.0) * exp(-abs(d.y) * 55.0);
        float sy = exp(-d.y * d.y * 9000.0) * exp(-abs(d.x) * 55.0);
        spike = (sx + sy) * (magRaw - 0.75) * 5.0;
      }

      // Star colour: independent of brightness. Bright stars include
      // both blue supergiants (Rigel) and red supergiants (Betelgeuse,
      // Antares, Aldebaran), so the colour-class hash is used directly.
      float colourClass = hash21(cell + seed + 31.7);
      vec3 tint = starColor(colourClass);

      col += tint * (core + halo + spike);
    }
  }
  return col;
}

// Milky-Way-like band, far more detailed than a single Gaussian:
//   - Tilted plane with noise-warped midline (the band itself wobbles
//     instead of being a perfect great circle).
//   - Variable thickness along its length: the band thickens near the
//     bulge and thins out in the anticentre, with organic large-scale
//     bulges and gaps.
//   - Asymmetric bulge: the galactic centre is not a perfect Gaussian,
//     it's perturbed and slightly squashed.
//   - Dust lane runs along a SEPARATE noise-warped curve offset from the
//     geometric midline (matches real Milky Way appearance from Earth).
//   - Coarse "star cloud" hotspots (Sagittarius/Cygnus-style bright knots).
//   - Pink H-II emission regions (procedural dots) studded along the band.
//   - Multi-scale ridged dust filaments.
vec3 galaxyBand(vec3 dir) {
  vec3 bandN = normalize(vec3(0.30, 0.86, 0.40));
  float latRaw = dot(dir, bandN);
  vec3 along3  = normalize(dir - bandN * latRaw);

  // Warp the band's centerline with low-frequency noise along it. This
  // is the single biggest "anti-perfect" change.
  float warp1 = fbm(along3 * 1.2 + 5.5, 4) * 2.0 - 1.0;
  float warp2 = fbm(along3 * 2.6 + 17.1, 4) * 2.0 - 1.0;
  float lat   = latRaw - (warp1 * 0.045 + warp2 * 0.020);

  // Variable band thickness along its length: thicker near the bulge,
  // thinner in the anticentre, with gaps and bulges driven by noise.
  float thickN = fbm(along3 * 1.8 + 11.0, 4);
  float thick  = mix(0.55, 1.7, thickN);  // 0.55x..1.7x

  // Main band: only one Gaussian envelope now (no rigid parallel arms).
  // The thickness modulation does the irregular widening.
  float band = exp(-(lat * lat) / (thick * thick) * 22.0);

  // Multi-scale brightness texture along the band.
  float n0   = fbm(along3 * 3.5,  5);
  float n1   = fbm(along3 * 7.0  + 33.1, 4);
  float n2   = fbm(along3 * 14.0 - 7.7,  4);

  // Galactic centre direction (bulge): brighter, broader, asymmetric.
  vec3 corePt = normalize(vec3(0.70, 0.15, -0.60));
  float coreCos = max(0.0, dot(dir, corePt));
  // Asymmetric bulge: distort the radial coord with noise so it's not
  // a perfect circle around corePt.
  float bulgePerturb = fbm(dir * 4.0 + 99.7, 4) * 0.6 + 0.7;
  float coreF  = pow(coreCos, 6.0) * bulgePerturb;
  float bulgeBoost = exp(-lat * lat * 6.5) * coreF * 1.35;

  // Star clouds: bright noisy hotspots scattered along the band, plus
  // a couple of stronger knots concentrated near the bulge (mimics
  // Sgr/Cyg/Sct star clouds).
  float cloudN = pow(fbm(along3 * 5.5 + 4.4, 4), 3.0);
  float starClouds = cloudN * exp(-lat * lat * 30.0) * (0.4 + 1.6 * coreF);

  // Dust lanes: ridged noise carves dark filaments. The dust lane
  // doesn't run perfectly along midplane — it follows its own warped
  // curve offset slightly below the geometric centre (Milky Way as seen
  // from Earth has the dust lane below the band's apparent midline).
  float dustWarp = fbm(along3 * 1.5 + 22.0, 4) * 2.0 - 1.0;
  float dustLat  = lat + 0.025 + dustWarp * 0.04;
  float dustFine   = ridged(along3 * 7.5  + 11.3, 5);
  float dustCoarse = ridged(along3 * 2.4  - 4.1,  4);
  // Concentrated dust along the warped lane.
  float duskMask = exp(-dustLat * dustLat * 200.0);
  float greatRift = duskMask * smoothstep(-0.2, 0.5, coreF);

  float extLane = mix(0.18, 1.0, smoothstep(0.55, 0.90, dustFine));
  extLane     *= mix(0.42, 1.0, smoothstep(0.40, 0.85, dustCoarse));
  extLane     *= 1.0 - greatRift * 0.85;
  // Add narrow ribbon of stronger extinction following the warped lane.
  extLane     *= mix(0.55, 1.0, 1.0 - duskMask * 0.7);

  // Stellar background colour gradient: cool blue-grey out in the disk,
  // warmer toward bulge.
  vec3 cool = vec3(0.07, 0.09, 0.16);
  vec3 warm = vec3(0.24, 0.16, 0.10);
  vec3 core = vec3(0.45, 0.30, 0.18);
  vec3 base = mix(mix(cool, warm, smoothstep(0.0, 0.5, n0)), core, coreF);

  // Composite brightness.
  float brightness =
      (band * (0.55 + 0.55 * thickN) + bulgeBoost + starClouds * 0.9) *
      (0.30 + 0.85 * n0 + 0.20 * n1 + 0.10 * n2);
  brightness *= extLane;

  vec3 col = base * brightness;

  // H-II regions: procedural pink emission dots along the band.
  {
    float theta = acos(clamp(dir.y, -1.0, 1.0));
    float phi   = atan(dir.z, dir.x);
    vec2 ang = vec2(phi, theta) * 95.0;
    vec2 ic  = floor(ang);
    vec2 fc  = fract(ang);
    for (int yo = -1; yo <= 1; yo++) {
      for (int xo = -1; xo <= 1; xo++) {
        vec2 cell = ic + vec2(float(xo), float(yo));
        float h1  = hash21(cell + 121.7);
        if (h1 < 0.985) continue;
        float h2  = hash21(cell + 47.3);
        float h3  = hash21(cell + 91.1);
        vec2  sp  = vec2(float(xo), float(yo)) + vec2(h2, h3);
        vec2  d   = fc - sp;
        float r2  = dot(d, d);
        float bandWeight = exp(-lat * lat * 35.0);
        float wide = exp(-r2 * 80.0);
        float hot  = exp(-r2 * 600.0);
        vec3 tintHII = mix(vec3(1.20, 0.35, 0.65),
                           vec3(0.55, 0.85, 1.00),
                           h3 * 0.35);
        col += tintHII * (wide * 0.18 + hot * 0.55) * bandWeight * extLane;
      }
    }
  }

  return col;
}

// A single nebula/patch at a given sky position. Soft radial falloff
// shaped by noise. Several of these scattered around form a rich sky.
vec3 nebulaBlob(vec3 dir, vec3 center, float size, vec3 baseCol, float seed) {
  float ca = clamp(dot(dir, center), -1.0, 1.0);
  float angDist = acos(ca);
  float radial = exp(-angDist * angDist * size);
  if (radial < 0.01) return vec3(0.0);

  vec3 fp = normalize(dir + center * 1.5) * 3.0 + seed;
  float n = fbm(fp, 4);
  float r = ridged(fp * 1.3 + 17.1, 3);
  float shape = smoothstep(0.35, 0.80, n) * (0.5 + 0.5 * r);
  return baseCol * shape * radial * 0.18;
}

// Distant galaxy with spiral arms, dust lanes, and H-II knots.
// type: 0 = elliptical (smooth radial), 1 = spiral (arms + knots).
// angScale controls angular size; core dominates for very small sizes.
// elongDir + ellip give disk plane orientation.
vec3 distantGalaxy(vec3 dir, vec3 center, float angScale, float seed,
                   vec3 coreCol, vec3 diskCol, vec3 dustCol,
                   vec3 elongDir, float ellip, int type) {
  float ca = clamp(dot(dir, center), -1.0, 1.0);
  float angDist = acos(ca);
  // Project to tangent plane coords (u,v) centred on the galaxy.
  vec3 tanU = normalize(cross(center, elongDir));
  vec3 tanV = cross(center, tanU);
  float dotU = dot(dir, tanU);
  float dotV = dot(dir, tanV);
  float r = angDist * angScale;  // 0 at centre, ~1 at halo edge

  if (r > 2.5) return vec3(0.0);

  // Ellipticity: stretch V axis.
  float vStretched = dotV * mix(1.0, 2.2, ellip);
  float rE = sqrt(dotU * dotU + vStretched * vStretched) * angScale * mix(1.0, 1.4, ellip);

  // Azimuthal angle in disk plane.
  float theta = atan(vStretched, dotU);

  float halo  = exp(-rE * rE * 0.8);
  float core  = exp(-rE * rE * 12.0);
  float bulge = exp(-rE * rE * 3.0);

  vec3 col = vec3(0.0);

  // Elliptical (smooth radial gradient + slight isophotal twist).
  if (type == 0) {
    float n = fbm(vec3(dotU * 1.5, vStretched * 1.5, seed), 4) * 0.3;
    float grad = smoothstep(1.6, 0.0, rE) * (0.6 + 0.4 * n);
    col  = diskCol * halo * grad * 0.12;
    col += coreCol * (core * 0.6 + bulge * 0.1);
    return col;
  }

  // Spiral: arms + knots + dust lanes.
  // Logarithmic spiral arms: features align along theta + log(rE)/k = const.
  float armPitch = mix(1.8, 2.5, ellip);
  float arms = 0.0;
  for (int a = 0; a < 3; a++) {
    float armAng = theta - log(max(rE, 1e-4)) * armPitch + float(a) * 2.094 + seed * 0.7;
    // Narrow arm peak: 1 on the arm, 0 away.
    float arm = abs(sin(armAng));
    arms += 1.0 - smoothstep(0.0, 0.18, arm);
  }
  arms = clamp(arms * 0.3, 0.0, 1.0);
  // Taper arms at centre and edge.
  arms *= smoothstep(0.1, 0.5, rE) * (1.0 - smoothstep(1.2, 2.2, rE));

  // Noise on arms for clumpy structure.
  float nClump = fbm(vec3(dotU * 2.5, vStretched * 2.5, seed + 5.0), 4);
  arms = mix(arms * 0.4, arms * nClump * 0.8, 0.6);

  // Dust lanes: narrow dark ridges along the inner edge of arms.
  float dustLanes = 0.0;
  for (int d = 0; d < 2; d++) {
    float dAng = theta - log(max(rE, 1e-4)) * armPitch * 0.85 + float(d) * 3.141 + seed * 1.3;
    dustLanes += 1.0 - smoothstep(0.0, 0.12, abs(sin(dAng)));
  }
  dustLanes = clamp(dustLanes * 0.4, 0.0, 1.0);
  dustLanes *= smoothstep(0.2, 0.7, rE) * (1.0 - smoothstep(1.5, 2.2, rE));

  // H-II region bright knots: random bright spots in the disk.
  float knots = 0.0;
  for (int k = 0; k < 12; k++) {
    float ka = float(k) * 1.884 + seed * 3.1;
    float kr = 0.25 + hash21(vec2(seed * 0.1 + float(k), 0.5)) * 1.4;
    vec2 kp = vec2(cos(ka), sin(ka)) * kr;
    float kd = length(vec2(dotU * angScale, vStretched * angScale) - kp);
    float sizeMult = 0.5 + hash21(vec2(float(k), seed)) * 1.0;
    knots += exp(-kd * kd * (60.0 + 80.0 * sizeMult)) *
             smoothstep(0.1, 0.7, kr) * (1.0 - smoothstep(1.5, 2.2, kr));
  }

  // Composite.
  col  = diskCol * halo * mix(0.08, 0.18, rE / max(rE + 0.3, 1e-4));
  col += diskCol * arms * 0.12;
  col += coreCol * (core * 0.6 + bulge * 0.08);
  col += coreCol * knots * 0.06;

  return col;
}

// Several nebula regions and small distant galaxies scattered across the sky.
vec3 nebulae(vec3 dir) {
  vec3 col = vec3(0.0);

  // Eagle/hyades-ish patches.
  col += nebulaBlob(dir, normalize(vec3( 0.4,  0.6,  0.6)), 240.0, vec3(0.25, 0.06, 0.32), 0.0);
  col += nebulaBlob(dir, normalize(vec3(-0.5,  0.7, -0.4)), 200.0, vec3(0.20, 0.04, 0.28), 3.1);
  col += nebulaBlob(dir, normalize(vec3( 0.2, -0.5,  0.8)), 180.0, vec3(0.06, 0.22, 0.36), 7.9);
  col += nebulaBlob(dir, normalize(vec3(-0.7, -0.3,  0.5)), 260.0, vec3(0.32, 0.08, 0.10), 11.2);
  col += nebulaBlob(dir, normalize(vec3( 0.6, -0.7, -0.2)), 150.0, vec3(0.08, 0.18, 0.30), 13.7);
  col += nebulaBlob(dir, normalize(vec3(-0.3,  0.2, -0.8)), 220.0, vec3(0.30, 0.12, 0.28), 18.4);

  // Distant galaxies with spiral arms, dust lanes, H-II knots.
  // type 0=elliptical (smooth), 1=spiral (armed).
  // angScale: larger = smaller on sky. ~40 = medium, ~70 = small, ~25 = large.

  // Large face-on spiral (Andromeda-ish), blue-white arms.
  col += distantGalaxy(dir, normalize(vec3(0.55, 0.50, -0.58)),
    30.0, 0.0,
    vec3(0.55, 0.60, 0.72),
    vec3(0.10, 0.14, 0.22),
    vec3(0.04, 0.05, 0.08),
    normalize(vec3(1.0, 0.2, 0.0)), 0.55, 1);

  // Elliptical, warm yellow-orange, smooth radial.
  col += distantGalaxy(dir, normalize(vec3(-0.45, -0.25, -0.80)),
    38.0, 1.7,
    vec3(0.65, 0.52, 0.32),
    vec3(0.18, 0.13, 0.08),
    vec3(0.05, 0.03, 0.02),
    normalize(vec3(0.0, 0.8, 0.6)), 0.45, 0);

  // Compact blue spiral (M33 / Triangulum style).
  col += distantGalaxy(dir, normalize(vec3(-0.70, 0.50, -0.40)),
    50.0, 3.2,
    vec3(0.45, 0.58, 0.72),
    vec3(0.08, 0.12, 0.20),
    vec3(0.03, 0.04, 0.07),
    normalize(vec3(0.6, 0.0, 0.8)), 0.40, 1);

  // Small irregular / dwarf, pale blue wisps.
  col += distantGalaxy(dir, normalize(vec3(0.20, -0.75, 0.55)),
    60.0, 5.0,
    vec3(0.32, 0.42, 0.55),
    vec3(0.06, 0.09, 0.14),
    vec3(0.02, 0.03, 0.05),
    normalize(vec3(0.3, 0.9, 0.0)), 0.25, 1);

  // Red elliptical, distant.
  col += distantGalaxy(dir, normalize(vec3(-0.25, 0.60, 0.68)),
    55.0, 8.1,
    vec3(0.60, 0.40, 0.22),
    vec3(0.14, 0.08, 0.04),
    vec3(0.04, 0.02, 0.01),
    normalize(vec3(0.1, 0.0, 0.9)), 0.35, 0);

  // Starburst galaxy, blue-purple arms + pinkish halo.
  col += distantGalaxy(dir, normalize(vec3(0.40, -0.35, -0.75)),
    45.0, 10.4,
    vec3(0.52, 0.48, 0.68),
    vec3(0.08, 0.05, 0.14),
    vec3(0.03, 0.02, 0.06),
    normalize(vec3(0.5, 0.7, 0.0)), 0.45, 1);

  // Barred spiral, warm core, dusty disk.
  col += distantGalaxy(dir, normalize(vec3(-0.55, -0.60, 0.40)),
    35.0, 13.9,
    vec3(0.58, 0.50, 0.38),
    vec3(0.12, 0.10, 0.06),
    vec3(0.04, 0.03, 0.02),
    normalize(vec3(0.9, 0.0, 0.3)), 0.50, 1);

  return col;
}

// Interstellar dust extinction WITH reddening: blue absorbed more than
// red. Returns a per-channel transmittance (1 = clear, ~0 = obscured).
// Real ISM extinction follows roughly A(lambda) ~ 1/lambda, so blue
// channel attenuates faster.
vec3 dustExtinction(vec3 dir) {
  float d  = ridged(dir * 2.4 - 5.1, 4);
  float d2 = fbm(dir * 1.2 + 19.3, 4);
  float depth = smoothstep(0.50, 0.88, d + d2 * 0.3);
  // depth in [0,1]: 0 = no dust, 1 = thick lane.
  // Per-channel: red barely affected, green moderate, blue heavy.
  return vec3(
    mix(1.0, 0.65, depth),
    mix(1.0, 0.45, depth),
    mix(1.0, 0.25, depth)
  );
}

// Globular clusters: tiny soft fuzzy bright dots scattered along the
// galactic band. Always warm yellow-white (old stellar populations).
vec3 globularClusters(vec3 dir) {
  vec3 bandN = normalize(vec3(0.30, 0.86, 0.40));
  float lat = dot(dir, bandN);
  // Cluster around the band but allow some halo distribution.
  float bandWeight = exp(-lat * lat * 5.0);
  if (bandWeight < 0.05) return vec3(0.0);

  float theta = acos(clamp(dir.y, -1.0, 1.0));
  float phi   = atan(dir.z, dir.x);
  vec2 ang = vec2(phi, theta) * 18.0;
  vec2 ic  = floor(ang);
  vec2 fc  = fract(ang);

  vec3 col = vec3(0.0);
  for (int yo = -1; yo <= 1; yo++) {
    for (int xo = -1; xo <= 1; xo++) {
      vec2 cell = ic + vec2(float(xo), float(yo));
      float h1 = hash21(cell + 5.5);
      if (h1 < 0.992) continue;                    // very rare
      float h2 = hash21(cell + 13.7);
      float h3 = hash21(cell + 91.1);
      vec2 sp  = vec2(float(xo), float(yo)) + vec2(h2, h3);
      vec2 d   = fc - sp;
      float r2 = dot(d, d);
      // Two-tier glow: tight bright core + diffuse halo.
      float core = exp(-r2 * 9000.0);
      float halo = exp(-r2 * 800.0);
      vec3 tint = mix(vec3(1.00, 0.95, 0.78),
                      vec3(1.00, 0.82, 0.55),
                      h3);
      col += tint * (core * 1.4 + halo * 0.18) * bandWeight;
    }
  }
  return col;
}

vec3 sampleStars(vec3 dir) {
  // Galactic-plane proximity in [0, 1]: 1 on midplane, fades off-plane.
  // Used to multiply star density so the band looks naturally crowded.
  vec3 bandN = normalize(vec3(0.30, 0.86, 0.40));
  float lat = dot(dir, bandN);
  float plane = exp(-lat * lat * 9.0);

  // Four star layers at increasing angular density. The denser layers
  // produce the "milky" speckle that gives the sky depth without obvious
  // tiling.
  vec3 stars = vec3(0.0);
  stars += starLayer(dir, 0.06,  120.0,  1.0, plane) * 1.4;
  stars += starLayer(dir, 0.18,  320.0,  9.7, plane) * 0.8;
  stars += starLayer(dir, 0.45,  800.0, 17.3, plane) * 0.35;
  stars += starLayer(dir, 0.85, 1800.0, 31.1, plane) * 0.12;

  // Selective extinction: dust reddens stars instead of just dimming.
  vec3 ext = dustExtinction(dir);
  stars *= ext;

  vec3 sky = galaxyBand(dir) + nebulae(dir) + globularClusters(dir);
  return stars + sky;
}

// --- accretion disk -----------------------------------------------------
//
// Optically thick, geometrically thin disk in the y=0 plane. Brightness
// combines:
//   - radial temperature profile (Shakura-Sunyaev style, hotter inside)
//   - turbulent FBM density modulated by Keplerian shear
//   - Doppler beaming: the side rotating toward the camera is brighter
//     and bluer; the receding side dimmer and redder
//   - gravitational redshift dimming as r -> rs
// Blackbody-ish temperature->color via piecewise tint table.

vec3 blackbodyTint(float t) {
  // Realistic black-body temperature ramp for an accretion disk, biased
  // toward warm tones so the disk reads orange/gold across most of its
  // radius. Only a thin innermost ring near ISCO reaches white-blue.
  //   t < 0.15  : deep red ember (cool outer edge)
  //   0.15-0.40 : orange-red (mid-outer)
  //   0.40-0.65 : amber (mid)
  //   0.65-0.85 : gold (mid-inner)
  //   0.85-0.95 : warm white (inner)
  //   > 0.95    : blue-white (very hot ISCO ring, narrow band)
  vec3 c0 = vec3(0.40, 0.07, 0.02);   // deep red ember
  vec3 c1 = vec3(0.95, 0.28, 0.07);   // orange-red
  vec3 c2 = vec3(1.00, 0.50, 0.16);   // amber
  vec3 c3 = vec3(1.00, 0.72, 0.32);   // gold
  vec3 c4 = vec3(1.00, 0.88, 0.55);   // warm white
  vec3 c5 = vec3(0.85, 0.92, 1.10);   // hot blue-white
  if (t < 0.15) return mix(c0, c1, t / 0.15);
  if (t < 0.40) return mix(c1, c2, (t - 0.15) / 0.25);
  if (t < 0.65) return mix(c2, c3, (t - 0.40) / 0.25);
  if (t < 0.85) return mix(c3, c4, (t - 0.65) / 0.20);
  if (t < 0.95) return mix(c4, c5, (t - 0.85) / 0.10);
  return c5;
}

// Single-point disk sample at an equatorial-plane crossing.
// Returns (rgb emission, alpha). Cheap: 1 FBM + 1 ridged + 1 noise edge,
// no volume marching. Style preserves Gargantua-flavored looks:
//   - amber/orange palette with hot blue-white inner edge
//   - relativistic Doppler beaming (strong)
//   - photon-ring boost near r = 1.5 * rs
//   - noise-warped inner/outer edges for organic boundary
//   - ISCO plunging wisps
// Off-plane fog is faked via a separate haloGlow() sampled along the ray.
vec4 sampleDisk(vec3 p, vec3 viewDir) {
  float r   = length(p.xz);
  float ang = atan(p.z, p.x);

  float omega = 1.4 / pow(max(r, u_rs * 1.1), 1.5);
  float swirlAng = ang - omega * u_time * 8.0;

  vec3 fp;
  fp.x = cos(swirlAng) * r * 0.35;
  fp.y = sin(swirlAng) * r * 0.35;
  fp.z = log(max(r, 1e-3)) * 1.5 + u_time * 0.05;

  float edgeNoise = fbm(fp * 1.0, 4) * 2.0 - 1.0;
  float rIn  = u_diskInner + edgeNoise * (u_diskInner * 0.18);
  float rOut = u_diskOuter - edgeNoise * (u_diskOuter * 0.10);

  float coverage =
      smoothstep(rIn,  rIn + 0.5,  r)
    * (1.0 - smoothstep(rOut - 1.2, rOut + 0.3, r));
  if (coverage <= 0.0) return vec4(0.0);

  float turb = fbm(fp * 1.6, 4);
  float fil  = ridged(fp * 2.0 + 5.1, 4);

  float arms = 0.5 + 0.5 * sin(swirlAng * 1.5 + log(max(r, 1e-3)) * 3.0);
  arms = arms * arms;

  float bright = mix(0.30, 1.0, turb) * mix(0.45, 1.20, fil) * (0.55 + 0.55 * arms);
  // Alpha tracks turbulence + filaments so dim regions of the disk
  // (gaps between bright streaks, dust lanes, soft edges) actually let
  // the background star field through.
  float alpha = coverage * mix(0.10, 1.0, turb) * mix(0.30, 1.0, fil);

  // Temperature profile: Shakura-Sunyaev steady-state thin disk
  //   T(r) ∝ r^(-3/4) * (1 - sqrt(r_in / r))^(1/4)
  // Inner edge boundary condition kills the temperature exactly at
  // r_in (zero stress at the ISCO), peaks ~1.36*r_in, then falls off.
  // We normalise so the peak maps to t=1.0 and use that for colour.
  float rRel = r / max(u_diskInner, 1e-3);
  float boundary = max(1.0 - sqrt(1.0 / max(rRel, 1.001)), 0.0);
  float tempProfile = pow(rRel, -0.75) * pow(boundary, 0.25);
  // Calibrated peak: profile maxes near rRel ~= 1.36, value ~= 0.41.
  // Multiply by 1/peak so peak hits ~1.0.
  float temp = clamp(tempProfile * 2.45, 0.0, 1.0);

  // Gravitational redshift: photons climbing out of the well lose
  // energy, so the inner edge of the disk dims and reddens slightly.
  // Use sqrt(1 - rs/r) (Schwarzschild factor for static observer at
  // infinity). Gentle: still keep the inner ring hot, just slightly
  // pulled down.
  float gr = sqrt(max(1.0 - u_rs / max(r, u_rs * 1.001), 0.0));
  temp *= mix(0.65, 1.0, gr);
  vec3 tint = blackbodyTint(temp);

  // Strong relativistic Doppler beaming.
  vec3 vDir = normalize(vec3(-p.z, 0.0, p.x));
  float beta = clamp(sqrt(u_rs / max(r, u_rs * 1.4)) * 0.95, 0.0, 0.92);
  float mu = dot(vDir, viewDir) * beta;
  float gamma = 1.0 / sqrt(max(1.0 - beta * beta, 1e-4));
  float D = 1.0 / max(gamma * (1.0 - mu), 1e-3);
  float beam = pow(D, 3.5);
  vec3 shiftBlue = vec3(0.65, 0.88, 1.30);
  vec3 shiftRed  = vec3(1.30, 0.65, 0.35);
  vec3 shift = (D >= 1.0) ? mix(vec3(1.0), shiftBlue, clamp(D - 1.0, 0.0, 1.2))
                          : mix(shiftRed, vec3(1.0), clamp(D, 0.0, 1.0));

  // Photon ring: bright thin band at r ~ 1.5 rs.
  float pring = exp(-pow((r - 1.5 * u_rs) / (u_rs * 0.18), 2.0));
  vec3 pringEmit = vec3(1.05, 0.85, 0.55) * pring * 2.0;

  // ISCO plunging wisps: extra reddish glow inside rIn down to ~rs.
  float plunge = smoothstep(rIn, rIn - 1.2, r) *
                 smoothstep(u_rs * 1.05, u_rs * 1.5, r);
  vec3 plungeEmit = vec3(1.0, 0.45, 0.18) * plunge * fil * 0.8;

  vec3 col = tint * shift * bright * beam * 2.2 + pringEmit + plungeEmit;
  alpha = clamp(alpha + pring * 0.6, 0.0, 1.0);

  return vec4(col, alpha);
}

// Axisymmetric off-plane halo glow. Cheap proxy for diffuse gas above
// and below the disk seen in Gargantua. No noise, just radial+vertical
// envelope. Returns emission per unit length to integrate along the ray.
vec3 haloGlow(vec3 p, vec3 viewDir) {
  float r = length(p.xz);
  float y = p.y;
  float Hhalo = mix(0.6, 2.4, smoothstep(u_diskInner, u_diskOuter, r));
  float vert  = exp(-(y * y) / (2.0 * Hhalo * Hhalo));
  float radial =
      smoothstep(u_diskInner - 0.5, u_diskInner + 1.5, r)
    * (1.0 - smoothstep(u_diskOuter - 2.0, u_diskOuter + 1.0, r));
  float env = radial * vert;
  if (env <= 1e-3) return vec3(0.0);

  vec3 vDir = normalize(vec3(-p.z, 0.0, p.x));
  float beta = clamp(sqrt(u_rs / max(r, u_rs * 1.4)) * 0.6, 0.0, 0.7);
  float mu = dot(vDir, viewDir) * beta;
  float D = 1.0 / max(1.0 - mu, 1e-3);
  vec3 shift = mix(vec3(1.10, 0.55, 0.20), vec3(0.70, 0.85, 1.10),
                   clamp(D - 0.7, 0.0, 1.0));
  return vec3(1.0, 0.55, 0.20) * shift * env * 0.18;
}

// Relativistic jet: two collimated plasma beams along +/-Y, launched
// just outside the event horizon. Returns emission rate per unit length.
//
// Detailed model:
//   - Tight collimated base (cylindrical) opening into a cone after a few rs
//   - Kink-instability wobble of the central axis (multi-scale sinusoidal)
//   - Limb-brightened transverse profile (optically thin tube look)
//   - Periodic knots along the flow (bright nodes, like M87 jet)
//   - Termination shock / hot spot at the far end
//   - Multi-frequency turbulence (FBM + ridged filaments)
//   - Doppler beaming asymmetry: approaching jet much brighter than receding
//   - Spectral aging colour gradient: blue-white -> magenta-pink -> deep red
vec3 jetSample(vec3 p, vec3 viewDir) {
  float y       = p.y;
  float ay      = abs(y);
  float dirSign = sign(y);                         // +1 upper, -1 lower
  float launch  = u_rs * 1.6;
  if (ay < launch) return vec3(0.0);

  float along = ay - launch;
  if (along > 80.0 * u_rs) return vec3(0.0);

  // --- kink-instability wobble of the central axis ---------------------
  // The jet axis itself wobbles laterally with along-distance. Two
  // frequencies stacked + slow time evolution keeps it organic.
  float ph1 = along * 0.18 + u_time * 0.30 * dirSign;
  float ph2 = along * 0.07 + u_time * 0.15 * dirSign + 1.7;
  vec2 wobble = vec2(sin(ph1), cos(ph1 * 1.3 + 0.7)) * (u_rs * 0.18);
  wobble    += vec2(sin(ph2 * 0.6), cos(ph2)) * (u_rs * 0.45);
  // Wobble grows in from base (jet is anchored at launch).
  wobble *= smoothstep(0.0, 6.0 * u_rs, along);

  vec2 offset  = p.xz - wobble;
  float radial = length(offset);

  // --- collimation: nearly cylindrical at base, conical past few rs ----
  float baseR    = launch * 0.16;
  float opening  = max(0.0, along - 6.0 * u_rs) * 0.08;
  float coneR    = baseR + opening;
  if (radial > coneR * 2.2) return vec3(0.0);

  // --- transverse profile: limb-brightened tube ------------------------
  // Optically thin synchrotron emission viewed transverse to a cylinder
  // peaks near the limb. Approximation: 1/sqrt(1-r^2) profile capped, plus
  // a softer central spine for visibility.
  float rn = radial / coneR;
  float limbCore = (rn < 0.97) ? inversesqrt(max(1.0 - rn * rn, 0.06)) : 0.0;
  float limb = limbCore * exp(-rn * rn * 1.2);
  float spine = exp(-rn * rn * 5.0);
  float transverse = limb * 0.35 + spine * 0.55;

  // --- along-axis envelope ---------------------------------------------
  float launchRamp = smoothstep(0.0, launch * 0.4, along);
  float farFade    = 1.0 / (1.0 + along * 0.045);
  // Periodic knots: bright nodes at fixed intervals along the jet,
  // slowly drifting outward over time (advected with the flow).
  float knotPhase = along * 0.32 - u_time * 0.7;
  float knots = pow(0.5 + 0.5 * sin(knotPhase), 6.0);
  // Bigger, rarer hotspots
  float bigKnotPhase = along * 0.10 - u_time * 0.3;
  float bigKnots = pow(0.5 + 0.5 * sin(bigKnotPhase + 0.5), 8.0);
  float knotBoost = 1.0 + knots * 0.9 + bigKnots * 1.6;

  // Termination shock at the far end.
  float termDist = along - 60.0 * u_rs;
  float term = exp(-(termDist * termDist) / (140.0));
  // Working surface: termination shock + cocoon ring around it
  float cocoon = exp(-rn * rn * 0.6) * term * 0.9;

  float axial = launchRamp * farFade * knotBoost;

  // --- multi-frequency turbulence --------------------------------------
  float spiral = atan(offset.y, offset.x) + along * 0.6 + u_time * 0.5 * dirSign;
  vec3 fp1 = vec3(cos(spiral) * radial, sin(spiral) * radial, along * 0.55) * 1.4;
  vec3 fp2 = vec3(p.x, along * 0.3, p.z) * 2.6 - vec3(0.0, u_time * 0.35, 0.0) * dirSign;
  float n1  = fbm(fp1, 4);
  float n2  = fbm(fp2, 3);
  float fil = ridged(fp1 * 1.6 + 7.7, 4);
  float kh  = ridged(vec3(spiral * 1.5, along * 0.4, radial * 4.0) - dirSign * u_time * 0.3, 3);
  float turbulence = mix(0.55, 1.30, n1) * mix(0.75, 1.15, n2) * mix(0.7, 1.25, fil);
  // Kelvin-Helmholtz mushrooms strongest at the jet boundary.
  turbulence *= mix(1.0, mix(0.6, 1.4, kh), smoothstep(0.6, 1.0, rn));

  float dens = transverse * axial * turbulence + cocoon;

  // --- Doppler beaming asymmetry ---------------------------------------
  // Bulk plasma flows along (0, dirSign, 0). Boost = 1 / (gamma * (1 - mu*beta))^3
  // for bolometric. viewDir points from sample toward camera (set by caller).
  float beta = 0.92;                                 // bulk Lorentz beta
  float gamma = 1.0 / sqrt(max(1.0 - beta * beta, 1e-4));
  // mu = cos(angle between flow and ray-back-to-camera). When jet flows
  // toward camera, mu>0, large boost. When away, mu<0, dimming.
  float mu = dot(vec3(0.0, dirSign, 0.0), viewDir);
  float D = 1.0 / max(gamma * (1.0 - mu * beta), 1e-3);
  float beam = pow(D, 3.0);

  // --- colour: spectral aging gradient + Doppler colour shift ----------
  // Hot blue near launch (fresh electrons), magenta-pink mid (synchrotron
  // self-Compton), deep red far (cooled, ageing population).
  float t = clamp(along / (60.0 * u_rs), 0.0, 1.0);
  vec3 hot  = vec3(0.65, 0.88, 1.35);
  vec3 mid  = vec3(0.95, 0.75, 1.05);
  vec3 cool = vec3(1.10, 0.45, 0.55);
  vec3 deep = vec3(0.55, 0.18, 0.30);
  vec3 tint = mix(mix(hot, mid, smoothstep(0.0, 0.35, t)),
                  mix(cool, deep, smoothstep(0.7, 1.0, t)),
                  smoothstep(0.35, 0.7, t));

  // Doppler frequency shift tint: approaching = bluer, receding = redder
  vec3 dopShift = (D >= 1.0)
    ? mix(vec3(1.0), vec3(0.75, 0.92, 1.25), clamp(D - 1.0, 0.0, 1.5))
    : mix(vec3(1.30, 0.60, 0.45), vec3(1.0), clamp(D, 0.0, 1.0));

  // Hot spot at termination shock looks white-hot.
  vec3 termTint = mix(tint, vec3(1.10, 1.00, 0.85), term * 0.7);

  return termTint * dopShift * dens * beam * 1.4;
}

struct Hit {
  bool horizon;
  vec3 diskCol;     // accumulated disk + star emission (front-to-back)
  float diskAlpha;  // accumulated coverage
  vec3 escapeDir;   // direction to sample background, valid if !horizon
};

Hit traceRay(vec3 ro, vec3 rd) {
  Hit h;
  h.horizon = false;
  h.diskCol = vec3(0.0);
  h.diskAlpha = 0.0;
  h.escapeDir = rd;

  float r0 = length(ro);
  if (r0 < 1e-4) { h.horizon = true; return h; }

  vec3 e1c = ro / r0;
  vec3 n   = cross(e1c, rd);
  if (length(n) < 1e-5) {
    n = cross(e1c, vec3(0.0, 1.0, 0.0));
    if (length(n) < 1e-5) n = cross(e1c, vec3(1.0, 0.0, 0.0));
  }
  n = normalize(n);
  vec3 e2 = normalize(cross(n, e1c));

  float rdRad = dot(rd, e1c);
  float rdTan = dot(rd, e2);

  float u  = 1.0 / r0;
  float du = -rdRad / (r0 * rdTan + sign(rdTan) * 1e-20 + (rdTan == 0.0 ? 1e-20 : 0.0));

  float dPhi = u_dPhi * (rdTan >= 0.0 ? 1.0 : -1.0);

  float phi = 0.0;
  vec3 prevPos = ro;

  for (int i = 0; i < 2048; i++) {
    if (i >= u_maxSteps) break;

    float k1u  = du;
    float k1du = -u + 1.5 * u_rs * u * u;

    float u2  = u  + 0.5 * dPhi * k1u;
    float du2 = du + 0.5 * dPhi * k1du;
    float k2u  = du2;
    float k2du = -u2 + 1.5 * u_rs * u2 * u2;

    float u3  = u  + 0.5 * dPhi * k2u;
    float du3 = du + 0.5 * dPhi * k2du;
    float k3u  = du3;
    float k3du = -u3 + 1.5 * u_rs * u3 * u3;

    float u4  = u  + dPhi * k3u;
    float du4 = du + dPhi * k3du;
    float k4u  = du4;
    float k4du = -u4 + 1.5 * u_rs * u4 * u4;

    float uNext   = u  + (dPhi / 6.0) * (k1u  + 2.0 * k2u  + 2.0 * k3u  + k4u);
    float duNext  = du + (dPhi / 6.0) * (k1du + 2.0 * k2du + 2.0 * k3du + k4du);
    float phiNext = phi + dPhi;

    if (uNext * u_rs >= 1.0 || uNext > 1e3) { h.horizon = true; return h; }

    if (uNext <= 0.0) {
      h.escapeDir = normalize(prevPos - ro + rd);
      return h;
    }

    float rNext = 1.0 / uNext;
    vec3 pNext = (cos(phiNext) * e1c + sin(phiNext) * e2) * rNext;

    // Check orbiting stars: if the ray-sample midpoint passes near a star,
    // blend its emission in front-to-back. Stars are small bright volumes.
    vec3 pMid = 0.5 * (prevPos + pNext);
    for (int si = 0; si < STAR_MAX; si++) {
      if (si >= u_starCount) break;
      float d = length(pMid - u_starPos[si]);
      if (d < u_starRadius * 1.5) {
        float bright = exp(-(d * d) / (u_starRadius * u_starRadius * 0.06));
        float sa = clamp(bright * 0.9, 0.0, 1.0);
        float trans = 1.0 - h.diskAlpha;
        h.diskCol   += trans * u_starCol[si] * bright;
        h.diskAlpha += trans * sa;
        // Only one star contributes (the nearest along the ray).
        if (h.diskAlpha > 0.6) break;
      }
    }

    // Equatorial-plane crossing: single-point disk sample, front-to-back.
    if ((prevPos.y * pNext.y) < 0.0) {
      float t = prevPos.y / (prevPos.y - pNext.y);
      vec3 hp = mix(prevPos, pNext, t);
      float rd2 = length(hp.xz);
      if (rd2 >= u_diskInner * 0.7 && rd2 <= u_diskOuter * 1.1) {
        vec3 viewDir = normalize(prevPos - hp);
        vec4 ds = sampleDisk(hp, viewDir);
        float trans = 1.0 - h.diskAlpha;
        h.diskCol   += trans * ds.rgb;
        h.diskAlpha += trans * ds.a;
        if (h.diskAlpha > 0.995) {
          h.escapeDir = vec3(0.0);
          return h;
        }
      }
    }

    // Off-plane halo glow (disabled — too foggy with the current style).
    // Re-enable by uncommenting the block below.
    // {
    //   vec3 mid = 0.5 * (prevPos + pNext);
    //   float r2 = length(mid.xz);
    //   if (r2 > u_diskInner * 0.6 && r2 < u_diskOuter * 1.2 && abs(mid.y) < 3.0) {
    //     vec3 segDir = pNext - prevPos;
    //     float segLen = length(segDir);
    //     vec3 viewDir = -normalize(segDir);
    //     vec3 hg = haloGlow(mid, viewDir);
    //     h.diskCol += (1.0 - h.diskAlpha) * hg * segLen;
    //   }
    // }

    // Relativistic jets: accumulate emission along the geodesic segment.
    // Cheap volumetric integration at the segment midpoint, weighted by
    // segment length. Lensing is automatic since we sample on the bent ray.
    {
      vec3 jMid = 0.5 * (prevPos + pNext);
      vec3 segDir = pNext - prevPos;
      float segLen = length(segDir);
      // viewDir = direction from the sample back along the ray (toward camera).
      vec3 jViewDir = -normalize(segDir);
      vec3 jE = jetSample(jMid, jViewDir);
      if (jE.r + jE.g + jE.b > 1e-4) {
        h.diskCol += (1.0 - h.diskAlpha) * jE * segLen;
        // Jets are mostly emissive (low absorption); only nudge alpha
        // slightly so very dense regions still occlude background.
        float jdens = max(max(jE.r, jE.g), jE.b);
        h.diskAlpha += (1.0 - h.diskAlpha) * clamp(jdens * segLen * 0.05, 0.0, 0.5);
      }
    }

    if (rNext > 200.0 * u_rs) {
      h.escapeDir = normalize(pNext - prevPos);
      return h;
    }

    prevPos = pNext;
    u = uNext;
    du = duNext;
    phi = phiNext;
  }

  h.escapeDir = normalize(prevPos - ro + rd);
  return h;
}

void main() {
  float aspect = u_resolution.x / u_resolution.y;
  vec2 uv = v_ndc;
  uv.x *= aspect;

  vec3 rd = normalize(
      u_camForward
    + u_camRight * (uv.x * u_fovTan)
    + u_camUp    * (uv.y * u_fovTan)
  );

  Hit hit = traceRay(u_camPos, rd);

  // Background: stars are sampled from the (lensed) escape direction.
  // If the ray fell into the horizon, the background is black; otherwise
  // it's whatever the bent ray sees at infinity.
  vec3 bg = hit.horizon ? vec3(0.0) : sampleStars(hit.escapeDir);

  // Composite accumulated disk emission over the (possibly star-lit) bg.
  vec3 col = hit.diskCol + (1.0 - hit.diskAlpha) * bg;

  // Output linear HDR. Tonemap + gamma happen in the composite pass so
  // the bloom pipeline can work in linear light.
  fragColor = vec4(col, 1.0);
}
