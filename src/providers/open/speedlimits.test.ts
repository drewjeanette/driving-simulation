import { describe, expect, it } from 'vitest';
import { assignLimits, parseMaxspeed } from './speedlimits';

describe('OSM speed limits', () => {
  it('parses maxspeed tags', () => {
    expect(parseMaxspeed('30 mph')).toBeCloseTo(13.41, 2);
    expect(parseMaxspeed('50')).toBeCloseTo(13.89, 2);
    expect(parseMaxspeed('50 km/h')).toBeCloseTo(13.89, 2);
    expect(parseMaxspeed('none')).toBeNull();
    expect(parseMaxspeed('DE:urban')).toBeNull();
    expect(parseMaxspeed(undefined)).toBeNull();
  });

  it('matches route segments to the nearest tagged road and merges runs', () => {
    const o = { lat: 35.9, lng: -86.8 };
    const north = (m: number) => ({ lat: o.lat + m / 111320, lng: o.lng });
    const route = [north(0), north(50), north(100), north(150), north(200)];
    const ways = [
      {
        type: 'way' as const,
        tags: { maxspeed: '25 mph' },
        geometry: [north(0), north(110)].map((p) => ({ lat: p.lat, lon: p.lng })),
      },
      {
        type: 'way' as const,
        tags: { maxspeed: '45 mph' },
        geometry: [north(110), north(300)].map((p) => ({ lat: p.lat, lon: p.lng })),
      },
      // A parallel street 40 m away must not be picked up.
      {
        type: 'way' as const,
        tags: { maxspeed: '70 mph' },
        geometry: [0, 300].map((m) => ({ lat: north(m).lat, lon: o.lng + 40 / 90000 })),
      },
    ];
    const spans = assignLimits(route, ways);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ from: 0, to: 2 });
    expect(spans[1]).toMatchObject({ from: 2, to: 4 });
    expect(spans[1].metersPerSecond).toBeCloseTo(20.12, 2);
  });
});
