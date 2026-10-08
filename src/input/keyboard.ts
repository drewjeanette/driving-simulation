import { clamp } from '../geo/geo';
import { Action, InputFrame } from './types';

const ACTION_KEYS: Record<string, Action> = {
  KeyR: 'shiftUp',
  KeyF: 'shiftDown',
  PageUp: 'shiftUp',
  PageDown: 'shiftDown',
  Digit1: 'gearP',
  Digit2: 'gearR',
  Digit3: 'gearN',
  Digit4: 'gearD',
  KeyQ: 'signalLeft',
  KeyE: 'signalRight',
  KeyX: 'hazards',
  KeyC: 'camera',
  Escape: 'pause',
  KeyP: 'pause',
  KeyZ: 'recenter',
};

const THROTTLE_KEYS = ['KeyW', 'ArrowUp'];
const BRAKE_KEYS = ['KeyS', 'ArrowDown'];
const LEFT_KEYS = ['KeyA', 'ArrowLeft'];
const RIGHT_KEYS = ['KeyD', 'ArrowRight'];
const CAPTURED = new Set([
  ...THROTTLE_KEYS,
  ...BRAKE_KEYS,
  ...LEFT_KEYS,
  ...RIGHT_KEYS,
  'Space',
  'KeyH',
  ...Object.keys(ACTION_KEYS),
]);

/**
 * Keyboard driving. Keys are digital, so pedals and steering ramp toward their
 * targets over a fraction of a second; that makes smooth, test-friendly
 * driving possible without a controller. Hold Shift for gentle inputs.
 */
export class KeyboardInput {
  private down = new Set<string>();
  private pressed: Action[] = [];
  private throttle = 0;
  private brake = 0;
  private steer = 0;
  private enabled = true;
  lastUsed = 0;

  constructor(private readonly target: Window = window) {
    target.addEventListener('keydown', this.onDown);
    target.addEventListener('keyup', this.onUp);
    target.addEventListener('blur', this.onBlur);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.onBlur();
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onDown);
    this.target.removeEventListener('keyup', this.onUp);
    this.target.removeEventListener('blur', this.onBlur);
  }

  private onDown = (e: KeyboardEvent) => {
    if (!this.enabled || isTyping(e)) return;
    if (CAPTURED.has(e.code)) e.preventDefault();
    if (!e.repeat) {
      const action = ACTION_KEYS[e.code];
      if (action) this.pressed.push(action);
    }
    this.down.add(e.code);
    this.lastUsed = performance.now();
  };

  private onUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private onBlur = () => {
    this.down.clear();
  };

  private any(codes: string[]): boolean {
    return codes.some((c) => this.down.has(c));
  }

  /** Writes this frame's keyboard contribution into `frame`. */
  poll(frame: InputFrame, dt: number): void {
    const gentle = this.down.has('ShiftLeft') || this.down.has('ShiftRight');
    const maxPedal = gentle ? 0.4 : 1;
    const throttleTarget = this.any(THROTTLE_KEYS) ? maxPedal : 0;
    const brakeTarget = this.down.has('Space') ? 1 : this.any(BRAKE_KEYS) ? maxPedal : 0;
    // A pressed pedal starts with some travel, as when a foot first lands on it.
    if (brakeTarget > 0 && this.brake < 0.35) this.brake = Math.min(0.35, brakeTarget);
    this.throttle = ramp(this.throttle, throttleTarget, 1.6, 4, dt);
    this.brake = ramp(this.brake, brakeTarget, 2.2, 5, dt);

    const dir = (this.any(RIGHT_KEYS) ? 1 : 0) - (this.any(LEFT_KEYS) ? 1 : 0);
    const steerTarget = dir * (gentle ? 0.45 : 1);
    // Steer in quickly, return to centre a little faster, like letting go of a wheel.
    this.steer = ramp(this.steer, steerTarget, 2.2, 3.2, dt);

    if (this.throttle > 0.001 || this.brake > 0.001 || Math.abs(this.steer) > 0.001) {
      frame.throttle = Math.max(frame.throttle, this.throttle);
      frame.brake = Math.max(frame.brake, this.brake);
      if (Math.abs(this.steer) > Math.abs(frame.steer)) frame.steer = this.steer;
    }
    if (this.down.has('KeyH')) frame.horn = true;
    frame.actions.push(...this.pressed);
    this.pressed = [];
  }
}

function ramp(value: number, target: number, up: number, down: number, dt: number): number {
  if (Math.abs(target) > Math.abs(value) && Math.sign(target || 1) === Math.sign(value || target)) {
    return clamp(value + Math.sign(target) * up * dt, -Math.abs(target), Math.abs(target));
  }
  const next = value - Math.sign(value - target) * down * dt;
  return Math.sign(next - target) !== Math.sign(value - target) ? target : next;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
