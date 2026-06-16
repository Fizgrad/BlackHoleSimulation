import vertSrc from './shaders/fullscreen.vert?raw';
import fragSrc from './shaders/blackhole.frag?raw';
import { createGL, createProgram, getUniformLocations } from './gl/program';
import { createFullscreenTriangle } from './gl/quad';
import { createOrbitCamera, computeCameraBasis } from './scene/camera';

const canvas = document.getElementById('gl') as HTMLCanvasElement | null;
if (!canvas) throw new Error('canvas#gl not found');

const gl = createGL(canvas);
const program = createProgram(gl, vertSrc, fragSrc);
const vao = createFullscreenTriangle(gl);

const U = getUniformLocations(gl, program, [
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
  'u_starCount',
  'u_starPos[0]',
  'u_starPos[1]',
  'u_starPos[2]',
  'u_starPos[3]',
  'u_starPos[4]',
  'u_starPos[5]',
  'u_starPos[6]',
  'u_starPos[7]',
  'u_starCol[0]',
  'u_starCol[1]',
  'u_starCol[2]',
  'u_starCol[3]',
  'u_starCol[4]',
  'u_starCol[5]',
  'u_starCol[6]',
  'u_starCol[7]',
  'u_starRadius',
] as const);

const cam = createOrbitCamera();

const physics = {
  rs: 1.0,
  diskInner: 3.0,
  diskOuter: 14.0,
  maxSteps: 320,
  dPhi: 0.04,
};

// Orbiting stars: each has an orbital radius, angular speed, and color.
// Radii are in units of rs; orbital speed scales as 1/r^1.5 (Keplerian).
const STAR_COUNT = 12;
const stars = [
  { r: 4.2,  speed: 0.85, col: [1.00, 0.92, 0.78], tilt: 0.02 },
  { r: 5.5,  speed: 0.62, col: [0.72, 0.78, 1.00], tilt:-0.03 },
  { r: 7.0,  speed: 0.45, col: [1.00, 0.85, 0.60], tilt: 0.05 },
  { r: 8.5,  speed: 0.33, col: [0.90, 0.95, 1.00], tilt:-0.01 },
  { r: 10.0, speed: 0.26, col: [1.00, 0.72, 0.50], tilt: 0.04 },
  { r: 11.5, speed: 0.21, col: [0.78, 0.85, 1.00], tilt:-0.02 },
  { r: 13.0, speed: 0.17, col: [1.00, 0.90, 0.70], tilt: 0.03 },
  { r: 15.0, speed: 0.14, col: [0.70, 0.80, 1.00], tilt:-0.04 },
  { r: 6.2,  speed: 0.52, col: [1.00, 0.65, 0.40], tilt: 0.06 },
  { r: 9.0,  speed: 0.31, col: [0.85, 0.90, 1.00], tilt:-0.03 },
  { r: 12.0, speed: 0.19, col: [1.00, 0.80, 0.55], tilt: 0.01 },
  { r: 17.0, speed: 0.12, col: [0.75, 0.82, 1.00], tilt:-0.05 },
];

const DPR_CAP = 1.5;

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
  const w = Math.max(1, Math.floor(canvas!.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas!.clientHeight * dpr));
  if (canvas!.width !== w || canvas!.height !== h) {
    canvas!.width = w;
    canvas!.height = h;
  }
  gl.viewport(0, 0, canvas!.width, canvas!.height);
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

// --- render loop ---------------------------------------------------------

const t0 = performance.now();
gl.useProgram(program);
gl.bindVertexArray(vao);

// static uniforms
gl.uniform1f(U.u_rs, physics.rs);
gl.uniform1f(U.u_diskInner, physics.diskInner);
gl.uniform1f(U.u_diskOuter, physics.diskOuter);
gl.uniform1i(U.u_maxSteps, physics.maxSteps);
gl.uniform1f(U.u_dPhi, physics.dPhi);
gl.uniform1i(U.u_starCount, STAR_COUNT);
gl.uniform1f(U.u_starRadius, 0.12);

// Pre-allocate Float32Array for star position/color uploads.
const starPosBuf = new Float32Array(3 * STAR_COUNT);
const starColBuf = new Float32Array(3 * STAR_COUNT);
// Pre-fill color buffer (static).
for (let i = 0; i < STAR_COUNT; i++) {
  const c = stars[i];
  starColBuf[i * 3 + 0] = c.col[0];
  starColBuf[i * 3 + 1] = c.col[1];
  starColBuf[i * 3 + 2] = c.col[2];
}

function frame(): void {
  resize();

  const t = (performance.now() - t0) * 0.001 + 42.0; // jump forward so disk looks evolved
  const basis = computeCameraBasis(cam);

  // Update orbiting star positions.
  for (let i = 0; i < STAR_COUNT; i++) {
    const s = stars[i];
    const ang = s.speed * t + i * 1.8;
    const x = s.r * Math.cos(ang);
    const y = s.r * s.tilt * Math.sin(ang * 3.0); // slight off-plane wiggle
    const z = s.r * Math.sin(ang);
    starPosBuf[i * 3 + 0] = x;
    starPosBuf[i * 3 + 1] = y;
    starPosBuf[i * 3 + 2] = z;
  }

  gl.uniform2f(U.u_resolution, canvas!.width, canvas!.height);
  gl.uniform1f(U.u_time, t);
  gl.uniform3f(U.u_camPos, basis.pos[0], basis.pos[1], basis.pos[2]);
  gl.uniform3f(U.u_camForward, basis.forward[0], basis.forward[1], basis.forward[2]);
  gl.uniform3f(U.u_camRight, basis.right[0], basis.right[1], basis.right[2]);
  gl.uniform3f(U.u_camUp, basis.up[0], basis.up[1], basis.up[2]);
  gl.uniform1f(U.u_fovTan, basis.fovTan);

  // Upload star arrays.
  for (let i = 0; i < STAR_COUNT; i++) {
    const locP = U[`u_starPos[${i}]` as keyof typeof U];
    const locC = U[`u_starCol[${i}]` as keyof typeof U];
    if (locP) gl.uniform3f(locP, starPosBuf[i * 3], starPosBuf[i * 3 + 1], starPosBuf[i * 3 + 2]);
    if (locC) gl.uniform3f(locC, starColBuf[i * 3], starColBuf[i * 3 + 1], starColBuf[i * 3 + 2]);
  }

  gl.drawArrays(gl.TRIANGLES, 0, 3);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
