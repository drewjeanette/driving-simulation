import { describe, expect, it } from 'vitest';
import { DrivePath, chaikin, resample } from './path';
import { lRoute } from '../test/fixtures';

describe('resample', () => {
  it('spaces points evenly along the line', () => {
    const pts = resample(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ],
      1,
    );
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      expect(d).toBeLessThanOrEqual(1.26);
    }
    expect(pts.at(-1)).toEqual({ x: 10, y: 10 });
  });

  it('chaikin keeps the endpoints', () => {
    const pts = chaikin(
      [
        { x: 0, y: 0 },
        { x: 0, y: 10 },
        { x: 10, y: 10 },
      ],
      3,
    );
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts.at(-1)).toEqual({ x: 10, y: 10 });
  });
});

describe('DrivePath', () => {
  const path = new DrivePath(lRoute());

  it('is about as long as the route, minus the rounded corner', () => {
    expect(path.length).toBeGreaterThan(480);
    expect(path.length).toBeLessThan(501);
  });

  it('heads north first and east at the end', () => {
    expect(path.sample(50).heading).toBeCloseTo(0, 2);
    expect(path.sample(path.length - 20).heading).toBeCloseTo(Math.PI / 2, 2);
  });

  it('rounds the corner into a right-hand curve of drivable radius', () => {
    let maxK = 0;
    for (let s = 250; s < 350; s += 1) maxK = Math.max(maxK, path.sample(s).curvature);
    expect(maxK).toBeGreaterThan(0);
    expect(1 / maxK).toBeGreaterThan(7); // tightest radius over 7 m
  });

  it('places offsets to the right of travel', () => {
    const w = path.toWorld(50, 2);
    expect(w.x).toBeCloseTo(2, 3); // east of a northbound centre line
  });

  it('maps steps and speed limits onto the path', () => {
    const turn = path.steps.find((s) => s.maneuver === 'turn-right')!;
    expect(turn.s).toBeGreaterThan(280);
    expect(turn.s).toBeLessThan(310);
    expect(turn.signal).toBe('right');
    expect(path.speedLimitAt(100)).toBeCloseTo(13.4);
    expect(path.nextStep(100)?.maneuver).toBe('turn-right');
  });
});
