import { describe, expect, it } from 'vitest';
import { SIGNAL_CYCLE, signalState } from './traffic';
import { Coach, CoachFrame } from './coach';
import { DrivePath } from '../geo/path';
import { Vehicle } from './vehicle';
import { straightRoute } from '../test/fixtures';

describe('traffic signals', () => {
  it('cycles green, yellow, red', () => {
    const states = new Set<string>();
    for (let t = 0; t < SIGNAL_CYCLE; t += 0.5) states.add(signalState(7, t));
    expect([...states].sort()).toEqual(['green', 'red', 'yellow']);
    expect(signalState(0, 10)).toBe('green');
    expect(signalState(0, 27)).toBe('yellow');
    expect(signalState(0, 40)).toBe('red');
  });
});

describe('examiner: stop signs and red lights', () => {
  const path = new DrivePath(straightRoute(500));
  const frame = (
    s: number,
    speed: number,
    time: number,
    kind: 'stop' | 'traffic_signals',
    id = 0,
  ): CoachFrame => ({
    time,
    state: { ...Vehicle.initialState(new Vehicle(path).params), s, speed },
    gear: 'D',
    signal: null,
    laneCenter: 1.8,
    controls: [{ id, kind, s: 200 }],
  });

  it('penalises rolling through a stop sign', () => {
    const coach = new Coach(path);
    for (let s = 150; s < 220; s += 1) coach.update(frame(s, 6, s / 10, 'stop'), 0.1);
    expect(coach.events.map((e) => e.kind)).toContain('ran-stop');
  });

  it('accepts a full stop before the line', () => {
    const coach = new Coach(path);
    for (let s = 150; s < 220; s += 1)
      coach.update(frame(s, s > 190 && s < 194 ? 0 : 6, s / 10, 'stop'), 0.1);
    expect(coach.events.map((e) => e.kind)).not.toContain('ran-stop');
  });

  it('penalises entering on red but not on green', () => {
    const red = new Coach(path);
    const green = new Coach(path);
    for (let s = 150; s < 220; s += 1) {
      red.update(frame(s, 10, 40, 'traffic_signals'), 0.1); // t = 40 s: red for id 0
      green.update(frame(s, 10, 5, 'traffic_signals'), 0.1); // t = 5 s: green
    }
    expect(red.events.map((e) => e.kind)).toContain('ran-red');
    expect(green.events.map((e) => e.kind)).not.toContain('ran-red');
  });
});
