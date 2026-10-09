import { describe, expect, it } from 'vitest';
import { buildingHeight, cityQuery, parseLength, parseOverpass, roadWidth } from './osm';

describe('OpenStreetMap city data', () => {
  it('parses lengths in metres and feet', () => {
    expect(parseLength('12')).toBe(12);
    expect(parseLength('12.5 m')).toBe(12.5);
    expect(parseLength("40'")).toBeCloseTo(12.19, 2);
    expect(parseLength('tall')).toBeNull();
  });

  it('derives building heights from tags, levels or type', () => {
    expect(buildingHeight({ building: 'yes', height: '30' }).height).toBe(30);
    expect(buildingHeight({ building: 'apartments', 'building:levels': '5' }).height).toBeCloseTo(
      16.1,
      1,
    );
    expect(buildingHeight({ building: 'house' }).height).toBeCloseTo(6.8, 1);
    expect(buildingHeight({ building: 'garage' }).height).toBeLessThan(4);
    expect(buildingHeight({ building: 'yes', height: '20', min_height: '8' }).minHeight).toBe(8);
  });

  it('sizes drivable roads and ignores footpaths', () => {
    expect(roadWidth({ highway: 'residential' })).toBe(7);
    expect(roadWidth({ highway: 'primary', lanes: '4' })).toBeCloseTo(13.6);
    expect(roadWidth({ highway: 'tertiary', width: '10 m' })).toBe(10);
    expect(roadWidth({ highway: 'footway' })).toBeNull();
  });

  it('splits Overpass elements into buildings, roads, areas and points', () => {
    const square = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.0001 },
      { lat: 0.0001, lon: 0.0001 },
      { lat: 0.0001, lon: 0 },
      { lat: 0, lon: 0 },
    ];
    const f = parseOverpass([
      { type: 'way', id: 1, tags: { building: 'house', 'roof:shape': 'gabled' }, geometry: square },
      { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: square.slice(0, 2) },
      { type: 'way', id: 3, tags: { leisure: 'park' }, geometry: square },
      { type: 'node', id: 4, lat: 0, lon: 0, tags: { highway: 'stop' } },
      { type: 'node', id: 5, lat: 0, lon: 0, tags: { highway: 'traffic_signals' } },
      { type: 'node', id: 6, lat: 0, lon: 0, tags: { natural: 'tree' } },
      { type: 'way', id: 7, tags: { highway: 'footway' }, geometry: square.slice(0, 2) },
      {
        type: 'relation',
        id: 8,
        tags: { building: 'yes', type: 'multipolygon' },
        members: [{ type: 'way', role: 'outer', geometry: square }],
      },
    ]);
    expect(f.buildings.map((b) => b.id)).toEqual([1, 8]);
    expect(f.buildings[0].roofShape).toBe('gabled');
    expect(f.roads).toHaveLength(1);
    expect(f.areas[0].kind).toBe('park');
    expect(f.points.map((p) => p.kind).sort()).toEqual(['stop', 'traffic_signals', 'tree']);
  });

  it('queries a corridor around the route', () => {
    const q = cityQuery(
      [
        { lat: 1, lng: 2 },
        { lat: 1.001, lng: 2 },
      ],
      140,
    );
    expect(q).toContain('around:140,1.000000,2.000000,1.001000,2.000000');
    expect(q).toContain('"building"');
    expect(q).toContain('traffic_signals|stop|give_way');
  });
});
