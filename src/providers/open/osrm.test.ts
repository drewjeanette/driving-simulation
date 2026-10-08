import { describe, expect, it } from 'vitest';
import { osrmInstruction, osrmManeuver, parseOsrm, speedSpans } from './osrm';

describe('OSRM parsing', () => {
  it('maps manoeuvre types and modifiers', () => {
    expect(osrmManeuver('turn', 'left')).toBe('turn-left');
    expect(osrmManeuver('turn', 'sharp right')).toBe('sharp-right');
    expect(osrmManeuver('fork', 'slight left')).toBe('fork-left');
    expect(osrmManeuver('roundabout')).toBe('roundabout');
    expect(osrmManeuver('arrive')).toBe('arrive');
  });

  it('writes readable instructions', () => {
    const step = {
      name: 'Main St',
      distance: 10,
      maneuver: { type: 'turn', modifier: 'right', location: [0, 0] as [number, number] },
    };
    expect(osrmInstruction(step)).toBe('Turn right onto Main St');
    expect(
      osrmInstruction({ ...step, maneuver: { type: 'roundabout', exit: 2, location: [0, 0] } }),
    ).toBe('At the roundabout, take exit 2 onto Main St');
  });

  it('collapses per-segment speed limits and converts units', () => {
    const spans = speedSpans([
      { speed: 30, unit: 'mph' },
      { speed: 30, unit: 'mph' },
      { unknown: true },
      { speed: 50, unit: 'km/h' },
    ]);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ from: 0, to: 2 });
    expect(spans[0].metersPerSecond).toBeCloseTo(13.41, 2);
    expect(spans[1].metersPerSecond).toBeCloseTo(13.89, 2);
  });

  it('rejects responses without a route', () => {
    expect(() => parseOsrm({ code: 'NoRoute', message: 'Impossible route', routes: [] })).toThrow(
      'Impossible route',
    );
  });
});
