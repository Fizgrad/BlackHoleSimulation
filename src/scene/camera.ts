export interface OrbitCamera {
  target: [number, number, number];
  yaw: number;     // radians, around world +Y
  pitch: number;   // radians, clamped (-pi/2, pi/2)
  distance: number;
  fovY: number;    // radians
}

export function createOrbitCamera(): OrbitCamera {
  return {
    target: [0, 0, 0],
    yaw: 0.5,
    pitch: 0.1,
    distance: 30,
    fovY: (60 * Math.PI) / 180,
  };
}

export interface CameraBasis {
  pos: [number, number, number];
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  fovTan: number;
}

export function computeCameraBasis(cam: OrbitCamera): CameraBasis {
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);

  // camera-to-target offset in spherical coords
  const ox = cam.distance * cp * sy;
  const oy = cam.distance * sp;
  const oz = cam.distance * cp * cy;

  const pos: [number, number, number] = [
    cam.target[0] + ox,
    cam.target[1] + oy,
    cam.target[2] + oz,
  ];

  // forward = target - pos (normalized)
  const fx = -ox, fy = -oy, fz = -oz;
  const fl = Math.hypot(fx, fy, fz);
  const forward: [number, number, number] = [fx / fl, fy / fl, fz / fl];

  // right = normalize(cross(forward, world up))
  const wux = 0, wuy = 1, wuz = 0;
  let rx = forward[1] * wuz - forward[2] * wuy;
  let ry = forward[2] * wux - forward[0] * wuz;
  let rz = forward[0] * wuy - forward[1] * wux;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;

  // up = cross(right, forward)
  const ux = ry * forward[2] - rz * forward[1];
  const uy = rz * forward[0] - rx * forward[2];
  const uz = rx * forward[1] - ry * forward[0];

  return {
    pos,
    forward,
    right: [rx, ry, rz],
    up: [ux, uy, uz],
    fovTan: Math.tan(cam.fovY * 0.5),
  };
}
