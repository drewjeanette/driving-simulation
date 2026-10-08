import { describe, expect, it } from 'vitest';
import { ControlDetector, newlyPressed } from './calibrate';
import { readPedal, readSteer, standardProfile } from './gamepad';

const pad = (axes: number[], buttons: number[] = []) =>
  ({
    axes,
    buttons: buttons.map((v) => ({ value: v, pressed: v > 0.5, touched: v > 0 })),
  }) as unknown as Gamepad;

describe('controller reading', () => {
  it('normalises inverted wheel pedals (1 at rest, -1 pressed)', () => {
    const b = { kind: 'axis' as const, index: 2, rest: 1, full: -1 };
    expect(readPedal(pad([0, 0, 1]), b, 0.02)).toBe(0);
    expect(readPedal(pad([0, 0, -1]), b, 0.02)).toBe(1);
    expect(readPedal(pad([0, 0, 0]), b, 0)).toBeCloseTo(0.5);
  });

  it('applies dead zone and curve to stick steering', () => {
    const p = standardProfile('x');
    expect(readSteer(pad([0.05, 0]), p)).toBe(0);
    expect(readSteer(pad([1, 0]), p)).toBeCloseTo(1);
    expect(readSteer(pad([-0.5, 0]), p)).toBeLessThan(0);
    expect(Math.abs(readSteer(pad([-0.5, 0]), p))).toBeLessThan(0.5); // finer near centre
  });
});

describe('calibration', () => {
  it('finds the steering axis and its direction', () => {
    const center = { axes: [0.02, 1, 1], buttons: [0] };
    const d = new ControlDetector();
    for (let v = 0; v <= 1; v += 0.1) d.sample({ axes: [-v * 0.9, 1, 1], buttons: [0] });
    const steer = d.detectSteer(center)!;
    expect(steer).toMatchObject({ kind: 'axis', index: 0, rest: 0.02 });
    expect(steer.full).toBeLessThan(-0.8); // this wheel reports right turns as negative
  });

  it('finds a pedal, ignoring channels already assigned', () => {
    const d = new ControlDetector([{ kind: 'axis', index: 0 }]);
    const frames = [1, 0.2, -1, -0.4, 1];
    for (const v of frames) d.sample({ axes: [Math.random(), 1, v], buttons: [0] });
    expect(d.detectPedal()).toEqual({ kind: 'axis', index: 2, rest: 1, full: -1 });
  });

  it('detects a pedal that is reported as a button (gamepad triggers)', () => {
    const d = new ControlDetector();
    for (const v of [0, 0.5, 1, 0.3, 0])
      d.sample({ axes: [0, 0], buttons: [0, 0, 0, 0, 0, 0, 0, v] });
    expect(d.detectPedal()).toEqual({ kind: 'button', index: 7, rest: 0, full: 1 });
  });

  it('reports newly pressed buttons only once', () => {
    expect(newlyPressed({ axes: [], buttons: [0, 0] }, { axes: [], buttons: [0, 1] })).toBe(1);
    expect(newlyPressed({ axes: [], buttons: [0, 1] }, { axes: [], buttons: [0, 1] })).toBeNull();
  });
});
