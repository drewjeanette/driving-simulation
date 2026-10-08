import { describe, expect, it } from 'vitest';
import { DrivePath } from '../geo/path';
import { Coach, CoachFrame } from './coach';
import { Vehicle } from './vehicle';
import { lRoute } from '../test/fixtures';

function frame(
  path: DrivePath,
  s: number,
  speed: number,
  extra: Partial<CoachFrame> = {},
): CoachFrame {
  const state = { ...Vehicle.initialState(new Vehicle(path).params), s, speed };
  return { time: 0, state, gear: 'D', signal: null, laneCenter: 1.8, ...extra };
}

describe('Coach', () => {
  it('flags sustained speeding once per cooldown', () => {
    const path = new DrivePath(lRoute());
    const coach = new Coach(path);
    for (let t = 0; t < 5; t += 0.1) coach.update({ ...frame(path, 50, 20), time: t }, 0.1);
    expect(coach.events.filter((e) => e.kind === 'speeding')).toHaveLength(1);
    expect(coach.score).toBeLessThan(100);
  });

  it('penalises a turn without a signal', () => {
    const path = new DrivePath(lRoute());
    const coach = new Coach(path);
    for (let s = 200; s < 320; s += 1) coach.update(frame(path, s, 5), 0.1);
    expect(coach.events.map((e) => e.kind)).toContain('no-signal');
  });

  it('accepts the correct signal and rejects the wrong one', () => {
    const path = new DrivePath(lRoute());
    const good = new Coach(path);
    const bad = new Coach(path);
    for (let s = 200; s < 320; s += 1) {
      good.update(frame(path, s, 5, { signal: 'right' }), 0.1);
      bad.update(frame(path, s, 5, { signal: 'left' }), 0.1);
    }
    expect(good.events).toHaveLength(0);
    expect(bad.events.map((e) => e.kind)).toContain('wrong-signal');
  });
});
