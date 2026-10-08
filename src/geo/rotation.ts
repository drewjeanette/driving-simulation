/**
 * Camera orientation maths for 360° panoramas.
 *
 * Panoramas are sampled in the OpenSfM spherical camera convention, which
 * Mapillary uses: camera axes x = right, y = down, z = forward, and the
 * centre of the equirectangular image looks along +z. A 3x3 matrix (row-major)
 * maps a direction in three.js world space (x = east, y = up, z = south) into
 * those camera axes.
 */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** three.js world (x east, y up, z south) -> ENU (east, north, up). */
const THREE_TO_ENU: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

export function apply(m: Mat3, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Rodrigues' formula: axis-angle vector -> rotation matrix. */
export function fromAxisAngle(r: readonly number[]): Mat3 {
  const theta = Math.hypot(r[0], r[1], r[2]);
  if (theta < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = [r[0] / theta, r[1] / theta, r[2] / theta];
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const t = 1 - c;
  return [
    c + x * x * t,
    x * y * t - z * s,
    x * z * t + y * s,
    y * x * t + z * s,
    c + y * y * t,
    y * z * t - x * s,
    z * x * t - y * s,
    z * y * t + x * s,
    c + z * z * t,
  ];
}

/**
 * A level camera facing compass heading `deg` (Google Street View, or
 * Mapillary photos without a computed orientation). Rows are the camera's
 * right, down and forward axes expressed in ENU.
 */
export function fromHeading(deg: number): Mat3 {
  const h = (deg * Math.PI) / 180;
  const enu: Mat3 = [Math.cos(h), -Math.sin(h), 0, 0, 0, -1, Math.sin(h), Math.cos(h), 0];
  return multiply(enu, THREE_TO_ENU);
}

/**
 * Mapillary's `computed_rotation` is an axis-angle rotation from the local
 * ENU frame into the camera frame (world-to-camera, as in OpenSfM). It
 * captures pitch and roll too, which matters: many 360° cameras are mounted
 * tilted, sideways or upside down.
 */
export function fromWorldToCamera(axisAngle: readonly number[]): Mat3 {
  return multiply(fromAxisAngle(axisAngle), THREE_TO_ENU);
}
