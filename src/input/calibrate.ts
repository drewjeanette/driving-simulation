import { Action } from './types';
import { AxisBinding, DeviceProfile } from './gamepad';

/** A snapshot of one controller's raw state. Plain data, so it is easy to test. */
export interface PadSnapshot {
  axes: readonly number[];
  buttons: readonly number[];
}

export function snapshot(pad: Gamepad): PadSnapshot {
  return { axes: [...pad.axes], buttons: pad.buttons.map((b) => b.value) };
}

interface Channel {
  kind: 'axis' | 'button';
  index: number;
}

/**
 * Tracks the min/max of every axis and button while the user moves one
 * control, then picks the channel that moved the most. Works for any wheel or
 * pedal set, whatever axis order or direction its driver reports.
 */
export class ControlDetector {
  private min: number[] = [];
  private max: number[] = [];
  private last: number[] = [];
  private first: number[] | null = null;

  constructor(private readonly exclude: Channel[] = []) {}

  sample(s: PadSnapshot): void {
    const values = [...s.axes, ...s.buttons];
    if (!this.first) {
      this.first = values;
      this.min = [...values];
      this.max = [...values];
    }
    values.forEach((v, i) => {
      this.min[i] = Math.min(this.min[i] ?? v, v);
      this.max[i] = Math.max(this.max[i] ?? v, v);
    });
    this.last = values;
    this.axisCount = s.axes.length;
  }

  private axisCount = 0;

  /**
   * The channel that moved most, with `rest` taken from where it ended up (the
   * user has let go) and `full` from the extreme it reached.
   */
  detectPedal(minTravel = 0.3): AxisBinding | null {
    const best = this.mostMoved(minTravel);
    if (!best) return null;
    const { i, channel } = best;
    const rest = this.last[i];
    const full =
      Math.abs(this.max[i] - rest) > Math.abs(this.min[i] - rest) ? this.max[i] : this.min[i];
    return { ...channel, rest, full };
  }

  /** Steering: rest is the centred value from `center`, full is full right. */
  detectSteer(center: PadSnapshot, minTravel = 0.3): AxisBinding | null {
    const best = this.mostMoved(minTravel, true);
    if (!best) return null;
    const { i, channel } = best;
    const rest = center.axes[channel.index] ?? 0;
    return { ...channel, rest, full: this.last[i] };
  }

  private mostMoved(minTravel: number, axesOnly = false): { i: number; channel: Channel } | null {
    let bestI = -1;
    let bestTravel = minTravel;
    for (let i = 0; i < this.min.length; i++) {
      const channel = this.channelAt(i);
      if (axesOnly && channel.kind !== 'axis') continue;
      if (this.exclude.some((e) => e.kind === channel.kind && e.index === channel.index)) continue;
      const travel = this.max[i] - this.min[i];
      if (travel > bestTravel) {
        bestTravel = travel;
        bestI = i;
      }
    }
    return bestI < 0 ? null : { i: bestI, channel: this.channelAt(bestI) };
  }

  private channelAt(i: number): Channel {
    return i < this.axisCount
      ? { kind: 'axis', index: i }
      : { kind: 'button', index: i - this.axisCount };
  }
}

/** Index of a button that became pressed between two snapshots, if any. */
export function newlyPressed(prev: PadSnapshot, next: PadSnapshot): number | null {
  for (let i = 0; i < next.buttons.length; i++) {
    if (next.buttons[i] > 0.5 && (prev.buttons[i] ?? 0) <= 0.5) return i;
  }
  return null;
}

export const BUTTON_STEPS: Action[] = [
  'shiftUp',
  'shiftDown',
  'signalLeft',
  'signalRight',
  'horn',
  'camera',
  'pause',
];

export function buildProfile(
  id: string,
  steer: AxisBinding,
  throttle: AxisBinding,
  brake: AxisBinding,
  buttons: Partial<Record<Action, number>>,
  rotationDeg = 900,
): DeviceProfile {
  return {
    id,
    type: 'wheel',
    steer,
    throttle,
    brake,
    rotationDeg,
    deadzone: 0.01,
    steerCurve: 1,
    buttons,
  };
}
