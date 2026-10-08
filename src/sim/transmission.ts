/**
 * Automatic gear selector with the safety interlocks a real car enforces.
 * Lever order matches a standard automatic: P R N D (top to bottom).
 */
export type Gear = 'P' | 'R' | 'N' | 'D';

export const GEAR_ORDER: readonly Gear[] = ['P', 'R', 'N', 'D'];

/** Speeds (m/s) under which the car counts as stopped for shifting purposes. */
const STOPPED = 0.6;

export interface ShiftContext {
  /** Signed speed in m/s; negative when rolling backwards. */
  speed: number;
  /** Brake pedal position, 0..1. */
  brake: number;
}

export type ShiftResult =
  { ok: true; gear: Gear } | { ok: false; gear: Gear; reason: string; lesson: string };

export class Transmission {
  private current: Gear = 'P';

  get gear(): Gear {
    return this.current;
  }

  /** Moves the lever one notch toward P. */
  up(ctx: ShiftContext): ShiftResult {
    const i = GEAR_ORDER.indexOf(this.current);
    return i === 0 ? { ok: true, gear: this.current } : this.select(GEAR_ORDER[i - 1], ctx);
  }

  /** Moves the lever one notch toward D. */
  down(ctx: ShiftContext): ShiftResult {
    const i = GEAR_ORDER.indexOf(this.current);
    return i === GEAR_ORDER.length - 1
      ? { ok: true, gear: this.current }
      : this.select(GEAR_ORDER[i + 1], ctx);
  }

  /**
   * Selects a gear directly. The lever passes through the gears in between,
   * so every notch on the way must be allowed or the shift is refused as a
   * whole and the lever stays where it was.
   */
  select(target: Gear, ctx: ShiftContext): ShiftResult {
    const from = GEAR_ORDER.indexOf(this.current);
    const to = GEAR_ORDER.indexOf(target);
    if (from === to) return { ok: true, gear: this.current };
    const dir = Math.sign(to - from);
    for (let i = from; i !== to; i += dir) {
      const blocked = this.check(GEAR_ORDER[i], GEAR_ORDER[i + dir], ctx);
      if (blocked) return { ok: false, gear: this.current, ...blocked };
    }
    this.current = target;
    return { ok: true, gear: this.current };
  }

  reset(): void {
    this.current = 'P';
  }

  private check(from: Gear, to: Gear, { speed, brake }: ShiftContext) {
    if (from === 'P' && brake < 0.25) {
      return {
        reason: 'Press the brake to shift out of Park',
        lesson:
          'Automatic cars have a brake-shift interlock: hold the brake pedal before leaving P.',
      };
    }
    if (to === 'P' && Math.abs(speed) > STOPPED) {
      return {
        reason: 'Come to a complete stop before shifting into Park',
        lesson: 'Shifting into Park while moving can damage the transmission.',
      };
    }
    if (to === 'R' && speed > STOPPED) {
      return {
        reason: 'Stop before shifting into Reverse',
        lesson: 'Always stop fully before changing direction.',
      };
    }
    if (to === 'D' && speed < -STOPPED) {
      return {
        reason: 'Stop before shifting into Drive',
        lesson: 'Always stop fully before changing direction.',
      };
    }
    return null;
  }
}
