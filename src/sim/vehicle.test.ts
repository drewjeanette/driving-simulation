import { describe, expect, it } from 'vitest';
import { DrivePath } from '../geo/path';
import { Vehicle, VehicleControls } from './vehicle';
import { lRoute, straightRoute } from '../test/fixtures';

const idle: VehicleControls = { throttle: 0, brake: 0, steer: 0, steerIsAbsolute: false };

function run(v: Vehicle, c: Partial<VehicleControls>, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) v.update({ ...idle, ...c }, 1 / 60);
}

describe('Vehicle', () => {
  it('stays put in Park even with the gas pressed', () => {
    const v = new Vehicle(new DrivePath(straightRoute()));
    run(v, { throttle: 1 }, 2);
    expect(v.state.speed).toBe(0);
    expect(v.state.rpm).toBeGreaterThan(3000); // revs freely
  });

  it('creeps forward in Drive with no pedals, and the brake holds it', () => {
    const v = new Vehicle(new DrivePath(straightRoute()));
    v.transmission.select('D', { speed: 0, brake: 1 });
    run(v, { brake: 1 }, 2);
    expect(v.state.speed).toBe(0);
    run(v, {}, 6);
    expect(v.state.speed).toBeGreaterThan(1);
    expect(v.state.speed).toBeLessThan(3);
  });

  it('accelerates like a family car and brakes to a stop without reversing', () => {
    const v = new Vehicle(new DrivePath(straightRoute(3000)));
    v.transmission.select('D', { speed: 0, brake: 1 });
    run(v, { throttle: 1 }, 9);
    // 0-60 mph (26.8 m/s) in roughly 8-10 s
    expect(v.state.speed).toBeGreaterThan(22);
    expect(v.state.speed).toBeLessThan(30);
    expect(v.state.autoGear).toBeGreaterThan(2);
    run(v, { brake: 1 }, 6);
    expect(v.state.speed).toBe(0);
  });

  it('reverses in R', () => {
    const v = new Vehicle(new DrivePath(straightRoute()));
    v.state.s = 100;
    v.transmission.select('R', { speed: 0, brake: 1 });
    run(v, { throttle: 0.5 }, 3);
    expect(v.state.speed).toBeLessThan(-1);
    expect(v.state.s).toBeLessThan(100);
  });

  it('drifts wide through a bend without steering when assist is off', () => {
    const v = new Vehicle(new DrivePath(lRoute()));
    v.assist = 'off';
    v.state.s = 220;
    v.state.speed = 8;
    v.transmission.select('N', { speed: 0, brake: 1 });
    run(v, {}, 12);
    expect(v.state.offRoad || v.state.d < -3).toBe(true);
  });

  it('follows the bend with curve assist', () => {
    const v = new Vehicle(new DrivePath(lRoute()));
    v.assist = 'curves';
    v.state.s = 220;
    v.state.speed = 8;
    v.transmission.select('N', { speed: 0, brake: 1 });
    let worst = 0;
    for (let t = 0; t < 20 && v.state.s < 400; t += 1 / 60) {
      v.update(idle, 1 / 60);
      worst = Math.max(worst, Math.abs(v.state.d - 1.8));
    }
    expect(v.state.s).toBeGreaterThan(330);
    expect(worst).toBeLessThan(1.5);
  });
});
