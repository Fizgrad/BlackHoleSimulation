# AGENTS.md

WebGL2 black hole / universe simulation. Raw WebGL2 (no Three.js / Babylon.js / regl), Vite + TypeScript, npm.

## Status
Repo is currently empty. First session should scaffold the project. Do not assume any prior structure.

## Stack constraints (do not swap without asking)
- **WebGL2 only**, accessed via `canvas.getContext('webgl2')`. No engine/wrapper libraries — write shaders, buffers, VAOs, FBOs by hand.
- **Vite** for dev server and build (`npm create vite@latest -- --template vanilla-ts`).
- **TypeScript** strict mode.
- **npm** as package manager (no pnpm/yarn lockfiles).

## Rendering approach
Black hole is rendered as a **raymarched fragment shader on a fullscreen triangle/quad**, not as mesh geometry. Key implications for any agent editing shaders:
- Vertex shader is trivial (positions in clip space); all interesting work is in the fragment shader.
- Gravitational lensing = step a ray through curved spacetime per pixel. Use Schwarzschild geodesic integration (impact parameter formulation) or analytic deflection approximation — pick one and document it in the shader file header.
- Accretion disk and skybox are sampled by the bent ray, not drawn as separate passes.
- Background starfield: cubemap or procedural noise sampled by ray direction.

## Expected layout (when scaffolded)
```
src/
  main.ts            # canvas + WebGL2 context + render loop
  gl/                # generic WebGL2 helpers (program, vao, fbo, texture)
  shaders/
    blackhole.frag   # raymarcher (the heart of the project)
    fullscreen.vert
  scene/             # camera, disk params, integrator settings
public/              # cubemap textures, accretion disk LUTs
```
Keep GLSL in `.frag` / `.vert` files imported as strings (Vite `?raw`), not inlined in TS, so shader edits don't trigger TS rebuilds of unrelated modules.

## Shader conventions
- GLSL ES 3.00 (`#version 300 es` first line, required by WebGL2).
- Use `precision highp float;` — black hole math diverges with mediump.
- Pass camera, time, and physics params as uniforms; do not hardcode in shader bodies.
- Schwarzschild radius `rs` is a uniform, not a `#define`, so it can be tweaked live.

## Commands
- `npm run dev` — Vite dev server with HMR (shaders hot-reload via `?raw` imports).
- `npm run build` — production build to `dist/`.
- `npm run preview` — serve the built bundle.
- `npx tsc --noEmit` — typecheck without emitting (Vite does not typecheck on build by default).

## Gotchas
- WebGL2 extensions: `EXT_color_buffer_float` is needed if rendering to float FBOs (HDR bloom). Always check `gl.getExtension(...)` and fail loudly.
- `OES_texture_float_linear` is **not** guaranteed in WebGL2; for linear-filtered float textures, fall back to manual bilinear in the shader.
- Resize handling must update both `canvas.width/height` (drawing buffer) and viewport; CSS size alone causes blurry output. Multiply by `devicePixelRatio` but cap it (raymarching cost scales quadratically).
- Safari/iOS: WebGL2 works but `highp` in fragment shaders can silently degrade — test on real hardware before assuming precision.
- Do not call `gl.getError()` in the hot loop in production; it forces a GPU sync.
