import { describe, expect, it } from 'vitest';
import { Mat3, apply, fromAxisAngle, fromHeading, fromWorldToCamera, multiply } from './rotation';

/** Where in the equirect image (u 0..1 left to right, v 0..1 bottom to top) a world direction lands. */
function uv(m: Mat3, dir: [number, number, number]) {
  const c = apply(m, dir);
  const u = (((0.5 + Math.atan2(c[0], c[2]) / (2 * Math.PI)) % 1) + 1) % 1;
  const v = 0.5 + Math.asin(-c[1] / Math.hypot(...c)) / Math.PI;
  return { u, v };
}

const NORTH: [number, number, number] = [0, 0, -1];
const EAST: [number, number, number] = [1, 0, 0];
const UP: [number, number, number] = [0, 1, 0];

describe('panorama orientation', () => {
  it('Rodrigues of zero is identity', () => {
    expect(fromAxisAngle([0, 0, 0])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('puts the heading at the image centre and the sky at the top', () => {
    const m = fromHeading(90); // camera faces east
    expect(uv(m, EAST).u).toBeCloseTo(0.5);
    expect(uv(m, EAST).v).toBeCloseTo(0.5);
    expect(uv(m, NORTH).u).toBeCloseTo(0.25); // north is 90° to the left
    expect(uv(m, UP).v).toBeCloseTo(1);
  });

  it('a level north-facing OpenSfM rotation matches heading 0', () => {
    // Camera axes in ENU: right = east, down = -up, forward = north, i.e. Rx(+90°).
    const fromSfm = fromWorldToCamera([Math.PI / 2, 0, 0]);
    const fromCompass = fromHeading(0);
    fromSfm.forEach((v, i) => expect(v).toBeCloseTo(fromCompass[i], 10));
  });

  it('straightens a camera that was mounted upside down', () => {
    // Same north-facing camera, additionally rolled 180° about its forward axis.
    const level = fromAxisAngle([Math.PI / 2, 0, 0]);
    const roll: Mat3 = [-1, 0, 0, 0, -1, 0, 0, 0, 1];
    const threeToEnu: Mat3 = [1, 0, 0, 0, 0, -1, 0, 1, 0];
    const m = multiply(multiply(roll, level), threeToEnu);
    // This photo recorded the sky at the bottom of the image, so looking up
    // must sample the bottom row; that is what renders the sky upright.
    expect(uv(m, UP).v).toBeCloseTo(0);
    expect(uv(m, NORTH).u).toBeCloseTo(0.5);
  });
});
