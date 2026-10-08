import { describe, expect, it } from 'vitest';
import { Candidate, bboxAround, isPlausibleMapillaryToken, selectPanos } from './mapillary';
import { haversine } from '../geo/geo';

const now = Date.UTC(2026, 9, 1);
const yearsAgo = (y: number) => now - y * 365.25 * 24 * 3600 * 1000;
const c = (id: string, s: number, sequence: string, offset = 1, age = 1): Candidate => ({
  id,
  s,
  offset,
  sequence,
  capturedAt: yearsAgo(age),
});

describe('Mapillary', () => {
  it('validates client tokens', () => {
    expect(isPlausibleMapillaryToken('MLY|123456789|' + 'a1'.repeat(16))).toBe(true);
    expect(isPlausibleMapillaryToken('MLY|abc|123')).toBe(false);
    expect(isPlausibleMapillaryToken('AIza' + 'x'.repeat(35))).toBe(false);
  });

  it('keeps one photo per spacing bin, in route order', () => {
    const picked = selectPanos(
      [c('a', 1, 'A'), c('b', 3, 'A'), c('c', 7, 'A'), c('d', 13, 'A')],
      6,
      null,
      now,
    );
    expect(picked.map((p) => p.id)).toEqual(['a', 'c', 'd']);
  });

  it('sticks to one sequence instead of flickering between overlapping ones', () => {
    const cands = [
      c('a1', 1, 'A'),
      c('b1', 2, 'B', 0.5),
      c('a2', 7, 'A'),
      c('b2', 8, 'B', 0.5),
      c('a3', 13, 'A'),
      c('b3', 14, 'B', 0.5),
    ];
    const picked = selectPanos(cands, 6, 'A', now);
    expect(new Set(picked.map((p) => p.sequence))).toEqual(new Set(['A']));
  });

  it('prefers much newer imagery when it is close to the road', () => {
    const picked = selectPanos([c('old', 1, 'A', 1, 12), c('new', 2, 'B', 1, 0.5)], 6, null, now);
    expect(picked[0].id).toBe('new');
  });

  it('pads bounding boxes by metres', () => {
    const p = { lat: 35.925, lng: -86.868 };
    const [w, sth, e, n] = bboxAround([p], 30);
    expect(haversine({ lat: sth, lng: p.lng }, { lat: n, lng: p.lng })).toBeCloseTo(60, 0);
    expect(haversine({ lat: p.lat, lng: w }, { lat: p.lat, lng: e })).toBeCloseTo(60, 0);
  });
});
