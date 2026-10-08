import { describe, expect, it } from 'vitest';
import { tileGrid } from './google/streetview';
import { googleManeuver } from './google/routes';
import { isPlausibleKey } from '../config';
import { drivesOnLeft } from '../geo/traffic';

describe('Street View tile grid', () => {
  it('covers a 16384 px panorama with 8x4 tiles at zoom 3', () => {
    expect(
      tileGrid({ imageWidth: 16384, imageHeight: 8192, tileWidth: 512, tileHeight: 512 }, 3),
    ).toMatchObject({
      cols: 8,
      rows: 4,
      width: 4096,
      height: 2048,
    });
  });

  it('handles older 13312 px panoramas with padded edge tiles', () => {
    const g = tileGrid(
      { imageWidth: 13312, imageHeight: 6656, tileWidth: 512, tileHeight: 512 },
      2,
    );
    expect(g.width).toBe(1664);
    expect(g.cols).toBe(4);
  });
});

describe('misc providers', () => {
  it('maps Google manoeuvres', () => {
    expect(googleManeuver('TURN_LEFT')).toBe('turn-left');
    expect(googleManeuver('ROUNDABOUT_RIGHT')).toBe('roundabout');
    expect(googleManeuver(undefined)).toBe('other');
  });

  it('validates API key shape before use', () => {
    expect(isPlausibleKey('AIza' + 'a'.repeat(35))).toBe(true);
    expect(isPlausibleKey('AIza<script>')).toBe(false);
    expect(isPlausibleKey('')).toBe(false);
  });

  it('knows which side of the road to drive on', () => {
    expect(drivesOnLeft({ lat: 51.5, lng: -0.12 })).toBe(true); // London
    expect(drivesOnLeft({ lat: -33.87, lng: 151.21 })).toBe(true); // Sydney
    expect(drivesOnLeft({ lat: 36.16, lng: -86.78 })).toBe(false); // Nashville
    expect(drivesOnLeft({ lat: 48.86, lng: 2.35 })).toBe(false); // Paris
  });
});
