import { describe, expect, it } from 'vitest';
import { LocalProjection, decodePolyline, haversine, headingOf, wrapPi } from './geo';

describe('geo', () => {
  it('measures great-circle distance', () => {
    // Nashville to Knoxville is roughly 255 km as the crow flies.
    const d = haversine({ lat: 36.1627, lng: -86.7816 }, { lat: 35.9606, lng: -83.9207 });
    expect(d / 1000).toBeGreaterThan(250);
    expect(d / 1000).toBeLessThan(262);
  });

  it('round-trips the local projection', () => {
    const proj = new LocalProjection({ lat: 51.5, lng: -0.12 });
    const p = { lat: 51.51, lng: -0.1 };
    const back = proj.toLatLng(proj.toLocal(p));
    expect(back.lat).toBeCloseTo(p.lat, 9);
    expect(back.lng).toBeCloseTo(p.lng, 9);
    expect(Math.hypot(proj.toLocal(p).x, proj.toLocal(p).y)).toBeCloseTo(
      haversine(proj.origin, p),
      -1,
    );
  });

  it('decodes Google encoded polylines', () => {
    // Example from Google's polyline algorithm documentation.
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toHaveLength(3);
    expect(pts[0]).toEqual({ lat: 38.5, lng: -120.2 });
    expect(pts[1]).toEqual({ lat: 40.7, lng: -120.95 });
    expect(pts[2]).toEqual({ lat: 43.252, lng: -126.453 });
  });

  it('computes compass headings and wraps angles', () => {
    expect(headingOf(0, 1)).toBe(0);
    expect(headingOf(1, 0)).toBe(90);
    expect(headingOf(-1, 0)).toBe(270);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapPi((-3 * Math.PI) / 2)).toBeCloseTo(Math.PI / 2);
  });
});
