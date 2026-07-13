import vertSrc from './shaders/fullscreen.vert?raw';
import sceneFragSrc from './shaders/blackhole.frag?raw';
import downsampleFragSrc from './shaders/bloom_downsample.frag?raw';
import upsampleFragSrc from './shaders/bloom_upsample.frag?raw';
import compositeFragSrc from './shaders/composite.frag?raw';
import { createGL, createProgram, getUniformLocations } from './gl/program';
import { createFullscreenTriangle } from './gl/quad';
import {
  bindRenderTarget,
  checkFloatFBOSupport,
  createRenderTarget,
  resizeRenderTarget,
} from './gl/fbo';
import { createOrbitCamera, computeCameraBasis } from './scene/camera';

const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
if (!canvas) throw new Error('canvas#gl not found');

const gl = createGL(canvas);
checkFloatFBOSupport(gl);

const sceneProgram = createProgram(gl, vertSrc, sceneFragSrc);
const downsampleProgram = createProgram(gl, vertSrc, downsampleFragSrc);
const upsampleProgram = createProgram(gl, vertSrc, upsampleFragSrc);
const compositeProgram = createProgram(gl, vertSrc, compositeFragSrc);

const vao = createFullscreenTriangle(gl);

const U = getUniformLocations(gl, sceneProgram, [
  'u_resolution',
  'u_time',
  'u_camPos',
  'u_camForward',
  'u_camRight',
  'u_camUp',
  'u_fovTan',
  'u_rs',
  'u_diskInner',
  'u_diskOuter',
  'u_maxSteps',
  'u_dPhi',
  'u_showDisk',
  'u_showPhotonRing',
  'u_showJets',
  'u_showNebulae',
  'u_galaxyTex',
  'u_galaxyCount',
  'u_galaxyCenter[0]',
  'u_galaxyCenter[1]',
  'u_galaxyCenter[2]',
  'u_galaxyCenter[3]',
  'u_galaxyCenter[4]',
  'u_galaxyCenter[5]',
  'u_galaxyCenter[6]',
  'u_galaxyScale[0]',
  'u_galaxyScale[1]',
  'u_galaxyScale[2]',
  'u_galaxyScale[3]',
  'u_galaxyScale[4]',
  'u_galaxyScale[5]',
  'u_galaxyScale[6]',
  'u_galaxyElong[0]',
  'u_galaxyElong[1]',
  'u_galaxyElong[2]',
  'u_galaxyElong[3]',
  'u_galaxyElong[4]',
  'u_galaxyElong[5]',
  'u_galaxyElong[6]',
  'u_galaxyEllip[0]',
  'u_galaxyEllip[1]',
  'u_galaxyEllip[2]',
  'u_galaxyEllip[3]',
  'u_galaxyEllip[4]',
  'u_galaxyEllip[5]',
  'u_galaxyEllip[6]',
] as const);

const Udown = getUniformLocations(gl, downsampleProgram, [
  'u_src',
  'u_srcTexel',
  'u_threshold',
] as const);

const Uup = getUniformLocations(gl, upsampleProgram, [
  'u_src',
  'u_srcTexel',
  'u_radius',
] as const);

const Ucomp = getUniformLocations(gl, compositeProgram, [
  'u_scene',
  'u_bloom',
  'u_bloomStrength',
  'u_exposure',
] as const);

// --- render targets -----------------------------------------------------

const BLOOM_MIPS = 5;
let sceneRT = createRenderTarget(gl, 16, 16);
const bloomMips = Array.from({ length: BLOOM_MIPS }, () =>
  createRenderTarget(gl, 16, 16),
);

const cam = createOrbitCamera();

const physics = {
  rs: 1.0,
  diskInner: 3.0,
  diskOuter: 14.0,
  maxSteps: 400,
  dPhi: 0.035,
};

// --- galaxy textures (real Hubble images) --------------------------------

interface GalaxyData {
  file: string;
  center: [number, number, number];
  scale: number;
  elong: [number, number, number];
  ellip: number;
}

const galaxyList: GalaxyData[] = [
  { file: 'm31.png',     center: [0.55, 0.50, -0.58], scale: 30, elong: [1.0, 0.2, 0.0], ellip: 0.55 },
  { file: 'm51.png',     center: [-0.70, 0.50, -0.40], scale: 50, elong: [0.6, 0.0, 0.8], ellip: 0.40 },
  { file: 'm104.png',    center: [-0.45, -0.25, -0.80], scale: 38, elong: [0.0, 0.8, 0.6], ellip: 0.45 },
  { file: 'm82.png',     center: [0.40, -0.35, -0.75], scale: 45, elong: [0.5, 0.7, 0.0], ellip: 0.45 },
  { file: 'ngc1300.png', center: [-0.55, -0.60, 0.40], scale: 35, elong: [0.9, 0.0, 0.3], ellip: 0.50 },
  { file: 'm87.png',     center: [-0.25, 0.60, 0.68], scale: 55, elong: [0.1, 0.0, 0.9], ellip: 0.35 },
  { file: 'ngc4565.png', center: [0.20, -0.75, 0.55], scale: 42, elong: [0.3, 0.9, 0.0], ellip: 0.50 },
];

let galaxyTex: WebGLTexture | null = null;
let galaxyCount = 0;

function normalize3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

async function loadGalaxyTextures(): Promise<void> {
  const TEX_SIZE = 256;
  const images: HTMLImageElement[] = [];
  const loaded: boolean[] = [];

  for (let i = 0; i < galaxyList.length; i++) {
    loaded.push(false);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { loaded[i] = true; };
    img.onerror = () => { loaded[i] = false; };
    img.src = `${import.meta.env.BASE_URL}galaxies/${galaxyList[i].file}`;
    images.push(img);
  }

  await Promise.all(images.map(img => {
    if (img.complete) return Promise.resolve();
    return new Promise<void>(resolve => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    });
  }));

  const validIndices: number[] = [];
  for (let i = 0; i < images.length; i++) {
    if (loaded[i] && images[i].naturalWidth > 0) validIndices.push(i);
  }
  if (validIndices.length === 0) return;

  galaxyCount = validIndices.length;
  const tex = gl.createTexture();
  if (!tex) return;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, TEX_SIZE, TEX_SIZE, galaxyCount);

  const canvas2d = document.createElement('canvas');
  canvas2d.width = TEX_SIZE;
  canvas2d.height = TEX_SIZE;
  const ctx2d = canvas2d.getContext('2d');
  if (!ctx2d) return;

  for (let layer = 0; layer < validIndices.length; layer++) {
    const idx = validIndices[layer];
    ctx2d.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
    // Cover-fit the image into the square.
    const img = images[idx];
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const scale = Math.max(TEX_SIZE / iw, TEX_SIZE / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    ctx2d.drawImage(img, (TEX_SIZE - dw) / 2, (TEX_SIZE - dh) / 2, dw, dh);
    const pixels = ctx2d.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer,
      TEX_SIZE, TEX_SIZE, 1,
      gl.RGBA, gl.UNSIGNED_BYTE, pixels.data,
    );

    // Update galaxy data to match the valid (loaded) set.
    const g = galaxyList[idx];
    const c = normalize3(g.center);
    const e = normalize3(g.elong);
    gl.uniform3f(U[`u_galaxyCenter[${layer}]` as keyof typeof U], c[0], c[1], c[2]);
    gl.uniform1f(U[`u_galaxyScale[${layer}]` as keyof typeof U], g.scale);
    gl.uniform3f(U[`u_galaxyElong[${layer}]` as keyof typeof U], e[0], e[1], e[2]);
    gl.uniform1f(U[`u_galaxyEllip[${layer}]` as keyof typeof U], g.ellip);
  }

  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  galaxyTex = tex;
  gl.useProgram(sceneProgram);
  gl.uniform1i(U.u_galaxyCount, galaxyCount);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, galaxyTex);
  gl.uniform1i(U.u_galaxyTex, 2);
}

// Create a dummy 1x1 2D array texture so the sampler2DArray always has
// a valid binding, even before real galaxy images are loaded. Without
// this, some drivers produce GL errors when the shader references an
// unbound sampler, even if the code path is never reached.
function createDummyArrayTexture(): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, 1, 1, 1);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([0, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

gl.useProgram(sceneProgram);
gl.uniform1i(U.u_galaxyCount, 0);
gl.activeTexture(gl.TEXTURE2);
gl.bindTexture(gl.TEXTURE_2D_ARRAY, createDummyArrayTexture());
gl.uniform1i(U.u_galaxyTex, 2);

// Kick off async loading; galaxyCount stays 0 until loaded.
loadGalaxyTextures().catch(() => { /* ignore load errors */ });

const DPR_CAP = 1.5;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const w = Math.max(1, Math.floor(canvas!.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas!.clientHeight * dpr));
  if (canvas!.width !== w || canvas!.height !== h) {
    canvas!.width = w;
    canvas!.height = h;
  }

  // Resize render targets to match.
  resizeRenderTarget(gl, sceneRT, w, h);
  let mw = w;
  let mh = h;
  for (let i = 0; i < BLOOM_MIPS; i++) {
    mw = Math.max(1, Math.floor(mw / 2));
    mh = Math.max(1, Math.floor(mh / 2));
    resizeRenderTarget(gl, bloomMips[i], mw, mh);
  }
}

window.addEventListener('resize', resize);
resize();

// --- input: orbit + zoom -------------------------------------------------

let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  cam.yaw   -= dx * 0.005;
  cam.pitch += dy * 0.005;
  const lim = Math.PI * 0.49;
  if (cam.pitch >  lim) cam.pitch =  lim;
  if (cam.pitch < -lim) cam.pitch = -lim;
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const k = Math.exp(e.deltaY * 0.001);
    cam.distance = Math.min(80, Math.max(physics.rs * 2.5, cam.distance * k));
  },
  { passive: false },
);

// --- one-time uniforms / VAO --------------------------------------------

const t0 = performance.now();
gl.bindVertexArray(vao);

// Static scene uniforms (set once).
gl.useProgram(sceneProgram);
gl.uniform1f(U.u_rs, physics.rs);
gl.uniform1f(U.u_diskInner, physics.diskInner);
gl.uniform1f(U.u_diskOuter, physics.diskOuter);
gl.uniform1i(U.u_maxSteps, physics.maxSteps);
gl.uniform1f(U.u_dPhi, physics.dPhi);

// --- render loop ---------------------------------------------------------

function renderScene(t: number): void {
  const basis = computeCameraBasis(cam);

  bindRenderTarget(gl, sceneRT);
  gl.useProgram(sceneProgram);

  gl.uniform2f(U.u_resolution, sceneRT.width, sceneRT.height);
  gl.uniform1f(U.u_time, t);
  gl.uniform3f(U.u_camPos, basis.pos[0], basis.pos[1], basis.pos[2]);
  gl.uniform3f(U.u_camForward, basis.forward[0], basis.forward[1], basis.forward[2]);
  gl.uniform3f(U.u_camRight, basis.right[0], basis.right[1], basis.right[2]);
  gl.uniform3f(U.u_camUp, basis.up[0], basis.up[1], basis.up[2]);
  gl.uniform1f(U.u_fovTan, basis.fovTan);
  gl.uniform1i(U.u_showDisk, features.disk ? 1 : 0);
  gl.uniform1i(U.u_showPhotonRing, features.photonRing ? 1 : 0);
  gl.uniform1i(U.u_showJets, features.jets ? 1 : 0);
  gl.uniform1i(U.u_showNebulae, features.nebulae ? 1 : 0);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

const BLOOM_THRESHOLD = 1.0; // values above this get bloomed
const BLOOM_RADIUS = 1.0;
const BLOOM_STRENGTH = 0.08;
const EXPOSURE = 1.0;

interface FeatureToggles {
  bloom: boolean;
  disk: boolean;
  photonRing: boolean;
  jets: boolean;
  nebulae: boolean;
}

const features: FeatureToggles = {
  bloom: true,
  disk: true,
  photonRing: true,
  jets: true,
  nebulae: true,
};

function bindToggle(id: string, key: keyof FeatureToggles): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  el.checked = features[key];
  el.addEventListener('change', () => {
    features[key] = el.checked;
  });
}

bindToggle('toggle-bloom', 'bloom');
bindToggle('toggle-disk', 'disk');
bindToggle('toggle-photon-ring', 'photonRing');
bindToggle('toggle-jets', 'jets');
bindToggle('toggle-nebulae', 'nebulae');

function renderBloom(): void {
  gl.useProgram(downsampleProgram);
  gl.uniform1i(Udown.u_src, 0);

  // Downsample chain. First mip applies bright-pass, others pass-through.
  let srcTex = sceneRT.tex;
  let srcW = sceneRT.width;
  let srcH = sceneRT.height;
  for (let i = 0; i < BLOOM_MIPS; i++) {
    bindRenderTarget(gl, bloomMips[i]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform2f(Udown.u_srcTexel, 1.0 / srcW, 1.0 / srcH);
    gl.uniform1f(Udown.u_threshold, i === 0 ? BLOOM_THRESHOLD : -1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    srcTex = bloomMips[i].tex;
    srcW = bloomMips[i].width;
    srcH = bloomMips[i].height;
  }

  // Upsample chain (additive blending into the larger mip).
  gl.useProgram(upsampleProgram);
  gl.uniform1i(Uup.u_src, 0);
  gl.uniform1f(Uup.u_radius, BLOOM_RADIUS);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  for (let i = BLOOM_MIPS - 1; i > 0; i--) {
    const src = bloomMips[i];
    const dst = bloomMips[i - 1];
    bindRenderTarget(gl, dst);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform2f(Uup.u_srcTexel, 1.0 / src.width, 1.0 / src.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.disable(gl.BLEND);
}

function renderComposite(): void {
  bindRenderTarget(gl, null, canvas!.width, canvas!.height);
  gl.useProgram(compositeProgram);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, sceneRT.tex);
  gl.uniform1i(Ucomp.u_scene, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, bloomMips[0].tex);
  gl.uniform1i(Ucomp.u_bloom, 1);
  gl.uniform1f(Ucomp.u_bloomStrength, features.bloom ? BLOOM_STRENGTH : 0.0);
  gl.uniform1f(Ucomp.u_exposure, EXPOSURE);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// --- FPS HUD --------------------------------------------------------------

const fpsEl = document.getElementById('fps');
let lastFrameTime = performance.now();
let emaFrameMs = 16.7;
let lastFpsRefresh = 0;

function updateFps(now: number): void {
  const dt = now - lastFrameTime;
  lastFrameTime = now;
  if (dt > 0 && dt < 1000) {
    emaFrameMs += (dt - emaFrameMs) * 0.1;
  }
  if (fpsEl && now - lastFpsRefresh > 250) {
    const fps = 1000 / Math.max(emaFrameMs, 0.01);
    fpsEl.textContent = `${fps.toFixed(0).padStart(3, ' ')} fps  ${emaFrameMs.toFixed(1).padStart(4, ' ')} ms`;
    lastFpsRefresh = now;
  }
}

// --- render loop ----------------------------------------------------------

let capturing = false;

function frame(): void {
  if (!capturing) {
    resize();
    const now = performance.now();
    const t = (now - t0) * 0.001 + 42.0;
    renderScene(t);
    if (features.bloom) renderBloom();
    renderComposite();
    updateFps(now);
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// --- 4K capture -----------------------------------------------------------

const capture4kBtn = document.getElementById('capture-4k') as HTMLButtonElement | null;

function capture4K(): void {
  if (capturing || !capture4kBtn) return;
  capturing = true;
  capture4kBtn.disabled = true;
  capture4kBtn.textContent = 'Rendering 4K...';

  setTimeout(() => {
    const W = 3840;
    const H = 2160;

    resizeRenderTarget(gl, sceneRT, W, H);
    let mw = W;
    let mh = H;
    for (let i = 0; i < BLOOM_MIPS; i++) {
      mw = Math.max(1, Math.floor(mw / 2));
      mh = Math.max(1, Math.floor(mh / 2));
      resizeRenderTarget(gl, bloomMips[i], mw, mh);
    }

    canvas!.width = W;
    canvas!.height = H;
    gl.viewport(0, 0, W, H);

    const t = (performance.now() - t0) * 0.001 + 42.0;
    renderScene(t);
    if (features.bloom) renderBloom();
    renderComposite();

    const pixels = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const ctx2d = off.getContext('2d');
    if (!ctx2d) {
      capturing = false;
      capture4kBtn.disabled = false;
      capture4kBtn.textContent = 'Capture 4K PNG';
      return;
    }
    const imgData = ctx2d.createImageData(W, H);
    const dst = imgData.data;
    for (let y = 0; y < H; y++) {
      const srcRow = (H - 1 - y) * W * 4;
      const dstRow = y * W * 4;
      dst.set(pixels.subarray(srcRow, srcRow + W * 4), dstRow);
    }
    ctx2d.putImageData(imgData, 0, 0);

    off.toBlob((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `blackhole_4k_${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
      capturing = false;
      capture4kBtn.disabled = false;
      capture4kBtn.textContent = 'Capture 4K PNG';
      resize();
    }, 'image/png');
  }, 50);
}

capture4kBtn?.addEventListener('click', capture4K);
