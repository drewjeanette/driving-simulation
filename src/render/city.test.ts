import { describe, expect, it } from 'vitest';
import { normaliseRing, orientedBox, pointInPolygon, signedArea } from './city';

describe('city geometry helpers', () => {
  const cw = [
    { x: 0, y: 0 },
    { x: 0, y: 10 },
    { x: 20, y: 10 },
    { x: 20, y: 0 },
    { x: 0, y: 0 },
  ];

  it('normalises rings to counter-clockwise without the closing point', () => {
    const ring = normaliseRing(cw);
    expect(ring).toHaveLength(4);
    expect(signedArea(ring)).toBeCloseTo(200);
  });

  it('finds the oriented bounding box of a rotated rectangle', () => {
    const a = Math.PI / 6;
    const rot = normaliseRing(cw).map((p) => ({
      x: p.x * Math.cos(a) - p.y * Math.sin(a),
      y: p.x * Math.sin(a) + p.y * Math.cos(a),
    }));
    const box = orientedBox(rot);
    expect(box.area).toBeCloseTo(200, 3);
  });

  it('tests points inside polygons', () => {
    const ring = normaliseRing(cw);
    expect(pointInPolygon({ x: 5, y: 5 }, ring)).toBe(true);
    expect(pointInPolygon({ x: 25, y: 5 }, ring)).toBe(false);
  });
});
