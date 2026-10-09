import { DrivePath, PathStep } from '../geo/path';
import { Gear } from './transmission';
import { VehicleState } from './vehicle';
import { TrafficControl, signalState } from './traffic';

export type Severity = 'tip' | 'minor' | 'major';

export interface CoachEvent {
  id: string;
  kind: string;
  severity: Severity;
  message: string;
  points: number;
  /** Simulation time, seconds. */
  at: number;
}

export interface CoachFrame {
  time: number;
  state: VehicleState;
  gear: Gear;
  signal: 'left' | 'right' | null;
  laneCenter: number;
  /** Stop signs and traffic signals along the route, sorted by s. */
  controls?: readonly TrafficControl[];
}

interface Rule {
  kind: string;
  severity: Severity;
  points: number;
  /** Minimum seconds between two reports of the same rule. */
  cooldown: number;
}

const RULES = {
  speeding: { kind: 'speeding', severity: 'major', points: 6, cooldown: 12 },
  curveSpeed: { kind: 'curve-speed', severity: 'major', points: 5, cooldown: 8 },
  harshBrake: { kind: 'harsh-brake', severity: 'minor', points: 3, cooldown: 6 },
  harshAccel: { kind: 'harsh-accel', severity: 'minor', points: 2, cooldown: 8 },
  centerLine: { kind: 'center-line', severity: 'major', points: 5, cooldown: 8 },
  offRoad: { kind: 'off-road', severity: 'major', points: 8, cooldown: 6 },
  noSignal: { kind: 'no-signal', severity: 'minor', points: 4, cooldown: 0 },
  ranStop: { kind: 'ran-stop', severity: 'major', points: 10, cooldown: 0 },
  ranRed: { kind: 'ran-red', severity: 'major', points: 15, cooldown: 0 },
  amberLight: { kind: 'amber', severity: 'tip', points: 0, cooldown: 0 },
  wrongSignal: { kind: 'wrong-signal', severity: 'minor', points: 4, cooldown: 0 },
  coastNeutral: { kind: 'coast-neutral', severity: 'tip', points: 1, cooldown: 20 },
  shiftBlocked: { kind: 'shift-blocked', severity: 'tip', points: 0, cooldown: 2 },
} satisfies Record<string, Rule>;

const SPEED_TOLERANCE = 2.24; // m/s (5 mph)
const SIGNAL_WINDOW_START = 70; // m before a turn where signalling counts
const SIGNAL_DEADLINE = 12; // m before the turn by which the signal must be on

/**
 * Watches the drive and scores it the way a road-test examiner would. Every
 * check works on plain numbers, so the whole examiner is unit-testable.
 */
export class Coach {
  readonly events: CoachEvent[] = [];
  private lastFired = new Map<string, number>();
  private sustained = new Map<string, number>();
  private signalledFor = new Map<PathStep, 'left' | 'right'>();
  private judgedSteps = new Set<PathStep>();
  private nextId = 0;
  private listeners: ((e: CoachEvent) => void)[] = [];
  distanceDriven = 0;
  maxSpeed = 0;
  private lastS: number | null = null;
  private readonly judgedControls = new Set<number>();
  private readonly minSpeedAt = new Map<number, number>();

  constructor(private readonly path: DrivePath) {}

  onEvent(fn: (e: CoachEvent) => void): void {
    this.listeners.push(fn);
  }

  get score(): number {
    return Math.max(0, 100 - this.events.reduce((sum, e) => sum + e.points, 0));
  }

  /** Reports an event that came from outside the frame loop (e.g. a refused shift). */
  report(kind: keyof typeof RULES, message: string, time: number): void {
    this.fire(RULES[kind], message, time);
  }

  update(f: CoachFrame, dt: number): void {
    const { state, time } = f;
    const speed = Math.abs(state.speed);
    const prevS = this.lastS ?? state.s;
    if (this.lastS !== null) this.distanceDriven += Math.abs(state.s - this.lastS);
    this.lastS = state.s;
    this.maxSpeed = Math.max(this.maxSpeed, speed);

    const limit = this.path.speedLimitAt(state.s);
    if (limit !== null && this.hold('speeding', speed > limit + SPEED_TOLERANCE, dt, 2)) {
      this.fire(RULES.speeding, 'Over the speed limit. Ease off the gas.', time);
    }
    if (this.hold('curve', Math.abs(state.lateralAccel) > 4.2, dt, 0.4)) {
      this.fire(RULES.curveSpeed, 'Too fast for that turn. Slow down before the curve.', time);
    }
    if (this.hold('brake', state.accel < -5.5 && speed > 1, dt, 0.25)) {
      this.fire(
        RULES.harshBrake,
        'Harsh braking. Look ahead and brake earlier and smoother.',
        time,
      );
    }
    if (this.hold('accel', state.accel > 3.6, dt, 0.5)) {
      this.fire(RULES.harshAccel, 'Accelerate more gently.', time);
    }
    // laneCenter's sign says which side of the centre line is ours (+ = right-hand traffic).
    const side = Math.sign(f.laneCenter) || 1;
    if (this.hold('center', state.d * side < -0.4 && speed > 2, dt, 0.8)) {
      this.fire(RULES.centerLine, 'You crossed the center line. Stay in your lane.', time);
    }
    if (state.offRoad && speed > 1) {
      this.fire(RULES.offRoad, 'You hit the curb. Keep the car on the road.', time);
    }
    if (this.hold('neutral', f.gear === 'N' && speed > 4, dt, 3)) {
      this.fire(RULES.coastNeutral, 'Avoid coasting in Neutral: you lose engine control.', time);
    }
    this.checkSignals(f);
    this.checkControls(f, prevS);
  }

  private checkSignals(f: CoachFrame): void {
    const s = f.state.s;
    for (const step of this.path.steps) {
      if (!step.signal || this.judgedSteps.has(step)) continue;
      const toTurn = step.s - s;
      if (toTurn > SIGNAL_WINDOW_START) break;
      if (toTurn < -20) {
        this.judgedSteps.add(step);
        continue;
      }
      if (f.signal && toTurn > 0) this.signalledFor.set(step, f.signal);
      if (toTurn < SIGNAL_DEADLINE) {
        this.judgedSteps.add(step);
        const used = this.signalledFor.get(step);
        if (!used) {
          this.fire(RULES.noSignal, `Use your ${step.signal} turn signal before turning.`, f.time);
        } else if (used !== step.signal) {
          this.fire(RULES.wrongSignal, `Wrong signal: this turn is to the ${step.signal}.`, f.time);
        }
      }
    }
  }

  /**
   * Stop signs need a full stop behind the line; traffic signals mustn't be
   * entered on red. The slowest speed in the 25 m before each stop line is
   * remembered so a stop a little early still counts.
   */
  private checkControls(f: CoachFrame, prevS: number): void {
    const s = f.state.s;
    const speed = Math.abs(f.state.speed);
    for (const c of f.controls ?? []) {
      if (c.s - s > 30) break;
      if (this.judgedControls.has(c.id)) continue;
      if (s > c.s - 25 && s < c.s + 2) {
        this.minSpeedAt.set(c.id, Math.min(this.minSpeedAt.get(c.id) ?? Infinity, speed));
      }
      const crossed = prevS <= c.s && s > c.s && f.state.speed > 0;
      if (!crossed) continue;
      this.judgedControls.add(c.id);
      if (c.kind === 'stop') {
        if ((this.minSpeedAt.get(c.id) ?? speed) > 0.45) {
          this.fire(
            RULES.ranStop,
            'You rolled through a stop sign. Come to a complete stop at the line.',
            f.time,
          );
        }
      } else {
        const light = signalState(c.id, f.time);
        if (light === 'red') this.fire(RULES.ranRed, 'You ran a red light.', f.time);
        else if (light === 'yellow' && speed < 9) {
          this.fire(RULES.amberLight, 'Yellow means stop if you safely can.', f.time);
        }
      }
    }
  }

  /** True once `condition` has held continuously for `seconds`. */
  private hold(key: string, condition: boolean, dt: number, seconds: number): boolean {
    const t = condition ? (this.sustained.get(key) ?? 0) + dt : 0;
    this.sustained.set(key, t);
    return t >= seconds;
  }

  private fire(rule: Rule, message: string, time: number): void {
    const last = this.lastFired.get(rule.kind);
    if (last !== undefined && time - last < rule.cooldown) return;
    this.lastFired.set(rule.kind, time);
    const e: CoachEvent = {
      id: `e${this.nextId++}`,
      kind: rule.kind,
      severity: rule.severity,
      message,
      points: rule.points,
      at: time,
    };
    this.events.push(e);
    for (const fn of this.listeners) fn(e);
  }
}

export function grade(score: number): { letter: string; verdict: string } {
  if (score >= 95) return { letter: 'A+', verdict: 'Road-test ready. Excellent control.' };
  if (score >= 88)
    return { letter: 'A', verdict: 'Great drive. Just a few small habits to polish.' };
  if (score >= 80)
    return { letter: 'B', verdict: 'Solid. You would likely pass, but review the notes below.' };
  if (score >= 70)
    return { letter: 'C', verdict: 'Passable, but practise the areas below before test day.' };
  return { letter: 'D', verdict: 'Keep practising. Focus on the mistakes listed below.' };
}
