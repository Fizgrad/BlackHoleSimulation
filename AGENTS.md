# AGENTS.md

WebGL2 black hole / universe simulation. Raw WebGL2 (no Three.js / Babylon.js / regl), Vite + TypeScript, npm.

## Stack constraints (do not swap without asking)
- **WebGL2 only**, accessed via `canvas.getContext('webgl2')`. No engine/wrapper libraries — write shaders, buffers, VAOs, FBOs by hand.
- **Vite** for dev server and build.
- **TypeScript** strict mode.
- **npm** as package manager (no pnpm/yarn lockfiles).

## Rendering approach
Black hole is rendered as a **raymarched fragment shader on a fullscreen triangle**, not as mesh geometry.
- Vertex shader is trivial (positions in clip space); all interesting work is in the fragment shader.
- Gravitational lensing = step a ray through curved spacetime per pixel using Schwarzschild null-geodesic RK4 integration of `d²u/dφ² = −u + (3/2)·rs·u²`.
- Accretion disk and background sky are sampled by the bent ray, not drawn as separate passes.
- Per-ray `dPhi` jitter (±9%) dithers equatorial-plane crossings to prevent concentric banding.
- Background is fully procedural (no cubemaps): 4 star layers, Milky-Way band, nebulae, distant galaxies, globular clusters.

## Project layout
```
src/
  main.ts                       # canvas + GL context + multi-pass render loop + UI toggles
  gl/
    program.ts                  # shader compile/link with annotated errors
    quad.ts                     # fullscreen-triangle VAO
    fbo.ts                      # HDR float render targets (RGBA16F)
  scene/
    camera.ts                   # orbit camera + basis vectors
  shaders/
    fullscreen.vert             # passthrough vertex shader (clip space)
    blackhole.frag              # geodesic raymarcher + disk + jets + sky
    bloom_downsample.frag       # 13-tap downsample with bright-pass
    bloom_upsample.frag         # 3×3 tent-filter additive upsample
    composite.frag              # HDR + bloom -> hue-preserving Reinhard -> sRGB
public/                         # empty (procedural textures only)
```
Keep GLSL in `.frag` / `.vert` files imported as strings (Vite `?raw`), not inlined in TS.

## Render pipeline (per frame)
1. Scene pass → `sceneRT` (RGBA16F FBO, HDR linear output, no tonemap).
2. Bloom downsample chain (5 mips, first mip applies bright-pass threshold).
3. Bloom upsample chain (5 mips, additive blend).
4. Composite pass → canvas: scene + bloom → hue-preserving Reinhard → sRGB gamma.

## Feature toggles
UI checkboxes (top-left) control bool uniforms: `u_showDisk`, `u_showPhotonRing`, `u_showJets`, `u_showNebulae`. Bloom is toggled at the post-process level (skip bloom pass + set strength to 0).

## Shader conventions
- GLSL ES 3.00 (`#version 300 es` first line, required by WebGL2).
- Use `precision highp float;` — black hole math diverges with mediump.
- Pass camera, time, and physics params as uniforms; do not hardcode in shader bodies.
- Schwarzschild radius `rs` is a uniform, not a `#define`, so it can be tweaked live.
- `sample` is a reserved keyword in GLSL ES 3.00 — do not use it as a function name.

## Commands
- `npm run dev` — Vite dev server with HMR (shaders hot-reload via `?raw` imports).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built bundle.
- `npx tsc --noEmit` — typecheck without emitting (Vite does not typecheck on build by default).

## Gotchas
- WebGL2 extensions: `EXT_color_buffer_float` is needed for HDR FBOs. `checkFloatFBOSupport()` in `fbo.ts` throws loudly if missing.
- `OES_texture_float_linear` is **not** guaranteed in WebGL2; bloom uses `RGBA16F` with `LINEAR` filtering which is supported via `EXT_color_buffer_float`.
- Resize handling must update both `canvas.width/height` (drawing buffer) and viewport; CSS size alone causes blurry output. Multiply by `devicePixelRatio` but cap it (raymarching cost scales quadratically).
- Safari/iOS: WebGL2 works but `highp` in fragment shaders can silently degrade — test on real hardware before assuming precision.
- Do not call `gl.getError()` in the hot loop in production; it forces a GPU sync.
- Tonemap is hue-preserving Reinhard (not ACES) — ACES bleaches saturated highlights to white.
